/** Bounded rendering smoke: npm run build, then node tests/manual/activity-display.mjs. */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import stringWidth from 'string-width';
import { createActivityDisplay } from '../../dist/cli/activity.js';

assert(process.stdout.isTTY, 'Run this synthetic check in a terminal. No model is called.');
const columns = Math.min(process.stdout.columns, 40);
assert(columns >= 20 && process.stdout.rows >= 14, 'Use a terminal at least 20 by 14.');
const text = '界😀👩🏽‍💻🇪🇸e\u0301'.repeat(30);
const write = (text) => process.stdout.write(text);
const out = (text) => write(`${text}\n`);

out(`Synthetic display: ${process.platform}, ${String(columns)} pane columns`);
for (const outcome of ['passed', 'failed', 'cancelled']) {
  const pane = createActivityDisplay({
    out,
    err: out,
    terminal: {
      columns,
      rows: process.stdout.rows,
      write: (chunk) => {
        if (!chunk.startsWith('\u001b')) {
          assert(stringWidth(chunk.trimEnd()) < columns, 'A draw would overflow its row');
        }
        write(chunk);
      },
    },
  });
  try {
    pane.line('HARN-11: implementation');
    for (let index = 1; index <= 24; index += 1) {
      pane.activity({ kind: 'message', text: `${String(index)} ${text}` });
      if (index === 12) pane.line('HARN-11: repair 1');
      await delay(50);
    }
    await delay(300);
  } finally {
    pane.close();
  }
  // These are synthetic labels, not run outcomes or an OS interrupt test.
  out(`Synthetic outcome: ${outcome}`);
  out('Example paths: logs/agent.log, result.json');
}
out('Display check finished; activity should be gone.');
