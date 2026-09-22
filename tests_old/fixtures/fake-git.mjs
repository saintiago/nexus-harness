/**
 * The stand-in `git` of the bounded-Git suite.
 *
 * It is a real program that a real `git` name resolves to, on the `PATH` of the
 * harness under test, so everything above that boundary is real: the process
 * runner, the bound, the process-tree stop, and the result the harness reports.
 * Nothing in `src/` knows this file exists, and no flag reaches it.
 *
 * `FAKE_GIT` in the environment is `{ "stateDir": "...", "mode": "ok" | "hang",
 * "id": "...", "stdout": "...", "stderr": "...", "exitCode": 0, "holdMs": ... }`.
 * An `ok` invocation writes what it was told to and exits with its code. A `hang`
 * invocation never finishes by itself, and starts a child that does not either:
 * the two processes a stop has to reach are the one the harness started and the
 * one that process started. Both answer on a beacon of their own, so a recorded
 * PID is named again only while that process still holds it
 * (notes/windows-fixture-flakes.md), and the backstop (`holdMs`) ends an
 * invocation that outlives its test.
 *
 * Each invocation records `<stateDir>/<id>.json` — its arguments, working
 * directory, PID, beacon token, and its child — once every beacon in its tree
 * answers, so a record that exists always names a process that really runs.
 */

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beaconAnswers, randomToken, startBeacon } from './beacon.mjs';

const config = JSON.parse(process.env.FAKE_GIT ?? '{}');
const stateDir = config.stateDir;
const mode = config.mode ?? 'ok';
const id = config.id ?? `git-${String(process.pid)}`;
const holdMs = Number(config.holdMs ?? 20_000);
const argv = process.argv.slice(2);

mkdirSync(stateDir, { recursive: true });

// The child of a hanging invocation is named by the id it is given, so the tree
// has exactly two processes and neither of them starts another.
const isChild = id.endsWith('-child');
const ownToken = process.env.FAKE_BEACON_TOKEN ?? randomToken();
const childToken = isChild || mode !== 'hang' ? null : randomToken();
const child =
  childToken === null
    ? null
    : spawn(process.execPath, [process.argv[1]], {
        stdio: 'ignore',
        env: {
          ...process.env,
          FAKE_BEACON_TOKEN: childToken,
          FAKE_GIT: JSON.stringify({ ...config, id: `${id}-child` }),
        },
      });
// A child this host refuses to start (a loaded host can refuse a fork) must not
// take this process down: the fixture is here to keep running until it is
// stopped, and an unhandled error event would end it as an ordinary exit.
child?.on('error', () => undefined);

await startBeacon(stateDir, ownToken);
const childAnswers =
  childToken === null ? false : await beaconAnswers(stateDir, childToken, 10_000);
writeFileSync(
  path.join(stateDir, `${id}.json`),
  JSON.stringify({
    id,
    argv,
    cwd: process.cwd(),
    pid: process.pid,
    pidToken: ownToken,
    child: child?.pid ?? null,
    childToken: childAnswers ? childToken : null,
  }),
  'utf8',
);

if (mode === 'ok') {
  process.stdout.write(config.stdout ?? '');
  process.stderr.write(config.stderr ?? '');
  process.exitCode = Number(config.exitCode ?? 0);
} else {
  setInterval(() => {
    appendFileSync(path.join(stateDir, `${id}.beats`), 'beat\n');
  }, 100);

  // A backstop: a fixture that outlives its test still ends on its own.
  setTimeout(() => process.exit(0), holdMs);
}
