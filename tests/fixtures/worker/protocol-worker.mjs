/**
 * A controlled worker for the parent bridge test. It writes the protocol output named by
 * NEXUS_TEST_SCENARIO to its standard streams and exits with that scenario's code; it reads
 * nothing and contacts no service. Its argument is the project configuration filepath the bridge
 * passes, which the ok scenario echoes back in an event.
 */

const scenario = process.env['NEXUS_TEST_SCENARIO'] ?? 'ok';
const projectConfigPath = process.argv[2] ?? '';

/** Write one newline-delimited protocol message. */
const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const progress = {
  kind: 'event',
  event: { source: 'test', type: 'progress', data: { projectConfigPath } },
};
const drained = { kind: 'result', result: { ok: true, value: 'drained' } };

let exitCode = 0;
switch (scenario) {
  case 'ok':
    send(progress);
    send(drained);
    break;
  case 'fault':
    send({ kind: 'result', result: { ok: false, fault: { message: 'controlled fault' } } });
    exitCode = 1;
    break;
  case 'no-result':
    send(progress);
    break;
  case 'bad-event':
    send({ kind: 'event', event: { source: 'test' } });
    break;
  case 'not-json':
    process.stdout.write('this is not a protocol line\n');
    break;
  case 'truncated':
    process.stdout.write('{"kind":"result","result":{"ok":true,"value":"drained"}}');
    break;
  case 'two-results':
    send(drained);
    send({ kind: 'result', result: { ok: true, value: 'blocked' } });
    break;
  case 'late-event':
    send(drained);
    send(progress);
    break;
  case 'diagnostics':
    process.stderr.write('controlled diagnostic\n');
    send(drained);
    break;
  case 'failed-exit':
    send(drained);
    exitCode = 3;
    break;
  default:
    process.stderr.write(`Unknown scenario "${scenario}"\n`);
    exitCode = 1;
    break;
}
process.exitCode = exitCode;
