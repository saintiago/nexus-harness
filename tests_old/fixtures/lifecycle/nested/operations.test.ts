/** Real entry points used by checks and local-run: pending when Vitest times out. */
import { existsSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { it } from 'vitest';
import { createTempDir } from '../../../support.js';
import { runCommand, runCheckRound, runTask } from '../../operations.js';
import { useFixtureLifecycle } from '../../lifecycle.js';
import {
  beginRunnerFixtureEnvironment,
  configuration,
  createFixture,
  dependencies,
  request,
} from '../../runner.js';
import { waitFor } from '../../local-target.js';

useFixtureLifecycle();
const report = process.env['NEXUS_LIFECYCLE_REPORT'] ?? '';
const pids = process.env['NEXUS_LIFECYCLE_PIDS'] ?? '';

for (const entry of ['command', 'round', 'task'] as const) {
  it(
    `times out with the production ${entry} still running`,
    async () => {
      const fixture =
        entry === 'task'
          ? await (async () => {
              await beginRunnerFixtureEnvironment();
              return await createFixture();
            })()
          : undefined;
      const directory = fixture?.parent ?? (await createTempDir());
      const pidFile = path.join(pids, `${entry}-pending.json`);
      const program = path.join(directory, 'pending.mjs');
      await writeFile(
        program,
        [
          "import { spawn } from 'node:child_process';",
          "import { writeFileSync } from 'node:fs';",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
          'writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, grandchild: child.pid }));',
          'setInterval(() => {}, 1000);',
        ].join('\n'),
      );
      const command = [process.execPath, program, pidFile] as const;
      const running =
        entry === 'command'
          ? runCommand({
              command,
              cwd: directory,
              logsDir: directory,
              label: 'pending',
              timeoutMs: 600_000,
            })
          : entry === 'round'
            ? runCheckRound({
                setup: [],
                checks: [command],
                cwd: directory,
                logsDir: directory,
                name: 'pending',
                commandTimeoutMs: 600_000,
                deadlineMs: Date.now() + 600_000,
                now: () => new Date(),
              })
            : runTask(
                request(fixture!, configuration(fixture!, { setup: [], checks: [command] })),
                dependencies(async () => {
                  throw new Error('the baseline must still be running');
                }),
              );
      // No process is registered after an awaited result. Ownership must already
      // exist inside the same wrappers imported by the affected suites.
      const recorded = running.then(async () => {
        await appendFile(
          report,
          `${JSON.stringify({
            case: `operation-${entry}-settled`,
            directory,
            pid: null,
            token: null,
            grandchild: null,
            outcome: `directory exists at settlement: ${String(existsSync(directory))}`,
          })}\n`,
        );
      });
      void recorded.catch(() => undefined);
      await waitFor(async () => existsSync(pidFile), `${entry} to start its real tree`);
      const tree = JSON.parse(await readFile(pidFile, 'utf8')) as {
        pid: number;
        grandchild: number;
      };
      await appendFile(
        report,
        `${JSON.stringify({ case: `operation-${entry}`, directory, token: null, ...tree })}\n`,
      );
      await recorded;
    },
    entry === 'task' ? 4_000 : 1_500,
  );
}
