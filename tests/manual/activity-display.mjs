/**
 * Bounded synthetic display check: `npm run build`, then
 * `node tests/manual/activity-display.mjs` in a terminal of at least 30 by 24.
 *
 * No model, run, repository, or network is involved. The events below are the
 * shapes a coding runtime reports, read by the same reader the adapter uses and
 * drawn by the same pane the CLI uses; the progress lines are the shapes the
 * runner and the source coordinator write. The first block is what the reported
 * screenshot showed for the same operations before HARN-16, printed here for
 * comparison; the second is what the terminal shows now, with every entry and
 * every ordinary line carrying the local time the viewer received or emitted
 * it, each agent message highlighted in yellow and reset again, and every agent
 * invocation — a developer turn, a repair turn, a Nexus Lens review, the next
 * ticket's developer turn — opening its own bounded pane behind its own role and
 * ticket boundary, finalized into one timeline as it ends (HARN-18, HARN-26).
 */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import stringWidth from 'string-width';
import { itemActivities } from '../../dist/agents/codex/events.js';
import { createActivityDisplay } from '../../dist/cli/activity.js';

assert(process.stdout.isTTY, 'Run this synthetic check in a terminal. No model is called.');
const columns = Math.min(process.stdout.columns ?? 80, 100);
const rows = process.stdout.rows ?? 24;
assert(columns >= 30 && rows >= 24, 'Use a terminal at least 30 columns by 24 rows.');

const write = (text) => process.stdout.write(text);
const out = (text) => write(`${text}\n`);
const width = columns - 1;

/** Fits one line to the pane's width the way the pane does, for the "before" half. */
function fit(text) {
  if (stringWidth(text) <= width) {
    return text;
  }
  let fitted = '';
  let cells = 0;
  for (const { segment } of new Intl.Segmenter().segment(text)) {
    const size = stringWidth(segment);
    if (cells + size > width - 1) {
      break;
    }
    fitted += segment;
    cells += size;
  }
  return `${fitted}…`;
}

// The launcher a Windows runtime really reports a command through.
const launcher =
  '"C:\\Users\\User\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies' +
  '\\native\\powershell\\pwsh.exe"';
const validate = `${launcher} -Command 'npm run validate'`;
const typecheck = `${launcher} -NoProfile -Command 'npm run typecheck'`;
const unknown = 'nerdctl.exe run --rm -v "C:\\tools\\workspace" --entrypoint node image';

out(
  `Synthetic display check: ${process.platform}, ${String(columns)} columns by ${String(rows)} rows.`,
);
out('Nothing here is a live run or a model call; every line is a synthetic shape.');

// ---------------------------------------------------------------------------
// Before: what the reported screenshot showed for these same operations.
// ---------------------------------------------------------------------------

out('\nBefore — the reported screenshot, reproduced from its own shapes:');
out(fit(`run: ${validate}`));
out('result: exit 0');
out(fit(`run: ${typecheck}`));
out('result: exit 1');
out(fit(`run: ${unknown}`));
out('result: exit 0');
out('The launcher path consumed the width; every result said only "exit N".');

// ---------------------------------------------------------------------------
// After: the same shapes through the reader and the pane.
// ---------------------------------------------------------------------------

await delay(1200);
out('\nAfter — the same shapes through the reader and the pane:');
out('Each entry now carries its receive time, and an agent message is highlighted.');
await delay(600);

/**
 * Progress lines are ordinary output and may wrap; only the pane's own activity
 * draws must each fit one row: a line that fits, says when the viewer received
 * it, and — for a message — is highlighted and reset inside its own line, which
 * is what this flags. Wrapped message continuations carry the same yellow and
 * reset but no repeated timestamp or label (HARN-34).
 */
/* eslint-disable no-control-regex -- the pane's own escape sequences are what this reads */
const HIGHLIGHTED_MESSAGE = /^(?:\d{2}:\d{2}:\d{2} )?\u001b\[33m.*\u001b\[0m$/;
const STAMPED_WORK = /^\d{2}:\d{2}:\d{2} (run|result|change): /;
/* eslint-enable no-control-regex */
let drawingKind = null;
let highlighted = 0;
/** The invocation boundaries the timeline was given, in order. */
const boundaries = [];
const terminal = {
  columns,
  rows,
  write: (chunk) => {
    if (drawingKind !== null && chunk.endsWith('\r\n') && chunk !== '\r\n') {
      const line = chunk.replace(/\r?\n$/, '');
      assert(stringWidth(line) < columns, 'A draw would overflow its row');
      if (HIGHLIGHTED_MESSAGE.test(line)) {
        highlighted += 1;
      } else {
        assert(STAMPED_WORK.test(line), `A drawn pane line is a stamped entry: ${line}`);
        assert(!line.includes('\u001b'), 'Only an agent message is highlighted');
      }
    }
    for (const line of chunk.split(/\r?\n/)) {
      if (/^\d{2}:\d{2}:\d{2} ---- (developer|reviewer): HARN-\d+ — .* ----$/.test(line)) {
        boundaries.push(line);
      }
    }
    write(chunk);
  },
};
const pane = createActivityDisplay({ out, err: out, terminal });
/** How many activity lines the pane has been handed, for the closing summary. */
let work = 0;
const draw = async (type, item) => {
  for (const activity of itemActivities(type, item)) {
    drawingKind = activity.kind;
    pane.activity(activity);
    drawingKind = null;
    work += 1;
    await delay(90);
  }
};

try {
  // The run's own progress: the inventory a source run writes, as the CLI
  // reads it on an interactive terminal.
  for (const line of [
    'HARN-16: reserved (E:\\projects\\nexus-jira-runs\\.intake\\receipts\\4008ea04.json); claiming 10117',
    'run run-20260919204053-1e36ccde started: task "HARN-16" (Show meaningful commands and outcomes in the live terminal)',
    'task deadline set for 2026-09-19T20:18:43.109Z: 3600000 ms of total task time, 600000 ms per configured command',
    'agent selected: runtime codex, launch prefix ["C:/Users/User/.codex/packages/standalone/current/bin/codex.exe","--profile","nexus-flash","--model","deepseek-flash"]',
    'source task: jira HARN-16 https://example.atlassian.net/browse/HARN-16 (immutable id 10117, revision 2026-09-19T19:55:47.688+0200)',
    'workspace prepared at E:\\projects\\nexus-jira-runs\\workspaces\\run-20260919204053-1e36ccde on branch harness/run-20260919204053-1e36ccde at d817f1d60d442879a9f60cd78aada50357e77a92',
    'workspace Git identity configured: user.name=Nexus Agent, user.email=nexus@local, commit.gpgsign=false',
    'baseline check-round started: 1 setup command, 1 check',
    'baseline check-round result: passed',
    'implementation turn started',
  ]) {
    pane.line(line);
    await delay(120);
  }

  // One developer invocation: it opens with its own boundary, and everything it
  // reports belongs to this pane and no other.
  pane.beginInvocation({ role: 'developer', ticket: 'HARN-16', phase: 'implementation turn' });
  await delay(400);

  // One turn: a message, the commands that follow it, and their results.
  await draw('item.completed', {
    type: 'agent_message',
    text: 'I will run the checks before changing anything.',
  });
  await draw('item.started', { type: 'command_execution', command: validate });
  await draw('item.completed', {
    type: 'command_execution',
    command: validate,
    exit_code: 0,
    aggregated_output: 'checked README.md\nTests  214 passed (214)\n',
  });
  await draw('item.started', { type: 'command_execution', command: typecheck });
  await draw('item.completed', {
    type: 'command_execution',
    command: typecheck,
    exit_code: 2,
    aggregated_output:
      "src/cli/activity.ts(214,7): error TS2322: Type 'string' is not assignable to type 'number'.\n" +
      'Found 1 error.\n',
  });
  await draw('item.started', { type: 'command_execution', command: unknown });
  await draw('item.completed', {
    type: 'command_execution',
    command: unknown,
    exit_code: 0,
  });

  // Command-like arguments after a script must not hide the actual script.
  await draw('item.completed', {
    type: 'agent_message',
    text: 'Script arguments retain the script that receives them.',
  });
  for (const command of [
    'pwsh -NoProfile -File build.ps1 -Command smoke',
    'bash build.sh -c smoke',
  ]) {
    assert.deepEqual(itemActivities('item.started', { type: 'command_execution', command }), [
      { kind: 'command', text: command },
    ]);
    await draw('item.started', { type: 'command_execution', command });
    await draw('item.completed', {
      type: 'command_execution',
      command,
      exit_code: 0,
    });
  }

  // A second message: its own group gets its own work lines, and more than
  // three of them keep the latest three.
  await draw('item.completed', {
    type: 'agent_message',
    text: 'The type error is in the pane; I will fix it and re-run the check.',
  });
  await draw('item.completed', {
    type: 'file_change',
    changes: [
      { path: 'src/cli/activity.ts', kind: 'update' },
      { path: 'src/cli/progress.ts', kind: 'add' },
      { path: 'tests/activity.test.ts', kind: 'update' },
      { path: 'README.md', kind: 'update' },
    ],
  });
  await draw('item.started', { type: 'command_execution', command: typecheck });
  await draw('item.completed', {
    type: 'command_execution',
    command: typecheck,
    exit_code: 0,
    aggregated_output: 'tsc --noEmit\n',
  });

  // Further turns, so the history crosses its twenty lines and the oldest work
  // lines give way while the messages stay in order.
  for (let turn = 3; turn <= 6; turn += 1) {
    await draw('item.completed', {
      type: 'agent_message',
      text: `Repair turn ${String(turn - 1)}: narrowing the failure and re-running.`,
    });
    await draw('item.started', {
      type: 'command_execution',
      command: `${launcher} -Command 'node tools/check-${String(turn)}.mjs'`,
    });
    await draw('item.completed', {
      type: 'command_execution',
      command: `${launcher} -Command 'node tools/check-${String(turn)}.mjs'`,
      exit_code: turn === 6 ? 0 : 1,
      aggregated_output:
        turn === 6 ? 'all checks passed\n' : `check ${String(turn)} did not pass\n`,
    });
  }

  // The invocation ends: its pane becomes the timeline segment a reader keeps,
  // before the lifecycle lines that follow it.
  pane.endInvocation();
  pane.line('HARN-16: implementation turn result: completed');
  pane.line('HARN-16: post-agent check-round result: passed');
  await delay(400);

  // A Nexus Lens reviewer invocation of the same ticket: its own pane, its own
  // role, and no row inherited from the developer turn above it.
  pane.beginInvocation({ role: 'reviewer', ticket: 'HARN-16', phase: 'review' });
  await draw('item.completed', {
    type: 'agent_message',
    text:
      'Nexus Lens is reading the diff before writing a verdict. ' +
      'Complete graphemes: 界 😀 👩🏽‍💻 👨‍👩‍👧‍👦 🇪🇸 1️⃣ é. '.repeat(12) +
      'REVIEW-END',
  });
  await draw('item.started', { type: 'command_execution', command: 'git diff --stat' });
  await draw('item.completed', {
    type: 'command_execution',
    command: 'git diff --stat',
    exit_code: 0,
    aggregated_output: ' src/cli/activity.ts | 210 +++++++++++++++++++++++++-----------\n',
  });
  pane.endInvocation();
  pane.line('HARN-16: Nexus Lens approved it');
  await delay(400);

  // The next ticket, next in the queue: a fresh developer pane again.
  pane.beginInvocation({ role: 'developer', ticket: 'HARN-26', phase: 'implementation turn' });
  await draw('item.completed', {
    type: 'agent_message',
    text:
      'Committed locally as ba5dda8. ' +
      'The complete explanation must remain readable in terminal history. '.repeat(40) +
      'MESSAGE-END: all synthetic details were displayed.',
  });
  await draw('item.started', { type: 'command_execution', command: 'git status --short' });
  await draw('item.completed', {
    type: 'command_execution',
    command: 'git status --short',
    exit_code: 0,
  });
  pane.endInvocation();
  pane.line('HARN-26: implementation turn result: completed');
  await delay(800);
} finally {
  pane.close();
}

// These are synthetic labels and paths, not a run's outcome or an OS interrupt.
out('Outcome block would follow here, e.g. "run run-20260919204053-1e36ccde: passed".');
out(
  `Example paths: logs/agent-implementation.log, logs/run.log, result.json (${String(work)} synthetic activity lines, ` +
    `${String(highlighted)} highlighted message draws, ${String(boundaries.length)} invocation boundaries).`,
);
for (const line of boundaries) {
  out(`  boundary ${line}`);
}
out('Display check finished; the last pane is finalized above this line.');
