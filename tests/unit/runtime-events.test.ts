/**
 * Reading the runtime's JSON event stream: what one runtime process reported
 * about itself, and what the terminal is shown as it works.
 *
 * The adapter reads the stream for what the turn reported — a completion, a
 * failure, the agent's own last message — and counts every line that is not an
 * event at all, because an interface that is not the documented one is exactly
 * what an incomplete completion has to be reported as. The activity lines it
 * reads are a copy for the terminal, never a replacement for the stream: a
 * command's operation is taken from the launcher wrapper it was reported
 * through, an exit code is repeated rather than read as success, and an excerpt
 * is the runtime's own words (`docs/spec.md` §12).
 *
 * These are decisions over explicit inputs, so they are decided here without
 * starting a runtime.
 */
import { describe, expect, it } from 'vitest';
import {
  agentMessage,
  failureText,
  itemActivities,
  parseEvent,
} from '../../src/agents/codex/events.js';

describe('one line of the runtime stream', () => {
  it('is an event only when it is a JSON object with a type', () => {
    expect(parseEvent('{"type":"turn.completed"}')).toEqual({ type: 'turn.completed' });
    // Event types this adapter does not know are still events: the interface is
    // read for what the turn reported, not validated against a list.
    expect(parseEvent('{"type":"something.new","value":1}')).toEqual({
      type: 'something.new',
      value: 1,
    });
    for (const line of [
      'not json at all',
      '{}',
      '["turn.completed"]',
      '"turn.completed"',
      'null',
      '{"value":1}',
    ]) {
      expect(parseEvent(line), line).toBeNull();
    }
  });

  it('reads the agent’s own message and the failure it reported', () => {
    expect(agentMessage({ type: 'agent_message', text: ' I appended the line. ' })).toBe(
      ' I appended the line. ',
    );
    for (const item of [
      { type: 'reasoning', text: 'thinking' },
      { type: 'agent_message', text: '   ' },
      { type: 'agent_message' },
      'agent_message',
      null,
    ]) {
      expect(agentMessage(item), JSON.stringify(item)).toBeNull();
    }

    // The documented failure shapes carry their message where they carry it.
    expect(
      failureText({ type: 'turn.failed', error: { message: 'the request was refused' } }),
    ).toBe('the request was refused');
    expect(failureText({ type: 'error', message: 'stream error' })).toBe('stream error');
    expect(failureText({ type: 'turn.failed', error: { message: '  ' } })).toBeNull();
    expect(failureText({ type: 'turn.failed' })).toBeNull();
  });
});

describe('what the terminal is shown as the turn works', () => {
  it('announces a command when it starts and reports its result when it ends', () => {
    expect(
      itemActivities('item.started', { type: 'command_execution', command: 'npm test' }),
    ).toEqual([{ kind: 'command', text: 'npm test' }]);
    expect(
      itemActivities('item.completed', {
        type: 'command_execution',
        command: 'npm test',
        exit_code: 2,
      }),
    ).toEqual([{ kind: 'result', text: 'exit 2 — npm test' }]);
    // No exit code: the runtime's own status word is what is reported, and a
    // command with neither is still a finished command.
    expect(
      itemActivities('item.completed', { type: 'command_execution', status: 'failed' }),
    ).toEqual([{ kind: 'result', text: 'failed' }]);
    expect(
      itemActivities('item.completed', { type: 'command_execution', command: 'npm test' }),
    ).toEqual([{ kind: 'result', text: 'finished — npm test' }]);
  });

  it('reports what the command said, when it said anything', () => {
    expect(
      itemActivities('item.completed', {
        type: 'command_execution',
        command: 'npm test',
        exit_code: 1,
        aggregated_output: 'FAIL src/a.test.ts\n  expected 1 to be 2\n\nTests  1 failed\n',
      }),
    ).toEqual([{ kind: 'result', text: 'exit 1 — npm test — Tests 1 failed' }]);
    expect(
      itemActivities('item.completed', {
        type: 'command_execution',
        command: 'git status --short',
        exit_code: 0,
        aggregated_output: ' M src/greet.ts\n',
      }),
    ).toEqual([{ kind: 'result', text: 'exit 0 — git status --short — M src/greet.ts' }]);
    // Missing, empty and unreadable output is not an excerpt.
    for (const output of [undefined, '', '   \n\n', 7]) {
      expect(
        itemActivities('item.completed', {
          type: 'command_execution',
          command: 'npm test',
          exit_code: 0,
          aggregated_output: output,
        }),
      ).toEqual([{ kind: 'result', text: 'exit 0 — npm test' }]);
    }
  });

  it('shows the payload of a launcher it recognizes, quoting and all', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['pwsh -NoProfile -c "npm test"', '"npm test"'],
      ['pwsh.exe -Command "git commit -m \'x\'"', '"git commit -m \'x\'"'],
      ['cmd.exe /d /s /c "npm test"', '"npm test"'],
      ['/bin/zsh -lc "git status --short"', '"git status --short"'],
      ['bash -ec "npm run validate"', '"npm run validate"'],
      ['PowerShell.exe -NoLogo -NonInteractive -NoProfile -Command "npm test"', '"npm test"'],
    ];
    for (const [command, payload] of cases) {
      expect(
        itemActivities('item.started', { type: 'command_execution', command }),
        command,
      ).toEqual([{ kind: 'command', text: payload }]);
    }
    // The same launcher on a completion: the operation is named by its payload,
    // with the exit code and the excerpt beside it.
    expect(
      itemActivities('item.completed', {
        type: 'command_execution',
        command: "pwsh -NoProfile -Command 'npm run validate'",
        exit_code: 2,
        aggregated_output: 'src/a.ts(3,1): error TS2322: Type mismatch\n',
      }),
    ).toEqual([
      {
        kind: 'result',
        text: "exit 2 — 'npm run validate' — src/a.ts(3,1): error TS2322: Type mismatch",
      },
    ]);
  });

  it('retains the original command for a launch shape it does not recognize', () => {
    // A script operand, a file mode, an unfamiliar option or a missing flag
    // ends recognition: a later command-like token may belong to that script
    // instead, so the line is shown as it was reported.
    for (const command of [
      'pwsh -NoProfile -File build.ps1 -Command smoke',
      'pwsh build.ps1 -Command smoke',
      'bash build.sh -c smoke',
      'pwsh -ExecutionPolicy Bypass -Command smoke',
      'bash -o -c smoke',
      'cmd.exe /unknown /c smoke',
    ]) {
      expect(
        itemActivities('item.started', { type: 'command_execution', command }),
        command,
      ).toEqual([{ kind: 'command', text: command }]);
    }
  });

  it('reads a completed message, and the files a change touched', () => {
    expect(
      itemActivities('item.completed', { type: 'agent_message', text: 'the work is done' }),
    ).toEqual([{ kind: 'message', text: 'the work is done' }]);
    // A message is only read once it is complete: a started one says nothing
    // the display knows how to show.
    expect(itemActivities('item.started', { type: 'agent_message', text: 'the work' })).toEqual([]);
    expect(
      itemActivities('item.completed', {
        type: 'file_change',
        changes: [{ path: 'src/greet.ts', kind: 'update' }, { path: 'README.md' }],
      }),
    ).toEqual([
      { kind: 'change', text: 'update src/greet.ts' },
      { kind: 'change', text: 'README.md' },
    ]);
    // Everything else — reasoning, plans, unknown items — is deliberately not
    // an activity line.
    expect(itemActivities('item.completed', { type: 'reasoning', text: 'thinking' })).toEqual([]);
    expect(itemActivities('item.completed', 'not an item')).toEqual([]);
  });
});
