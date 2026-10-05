/** Disposable child for the separate-process carry rehearsal; no real agents or queue workers. */
import { readFile, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { carryBeforeWorkerLaunch, readRecoveryRecord } from './run-retained-queue.mjs';

const [dist, projectConfig, recordFile, resultFile, mode] = process.argv.slice(2);
const { runOperatorCommand } = await import(
  pathToFileURL(path.join(dist, 'src/application/command.js')).href
);
const { createApplication } = await import(
  pathToFileURL(path.join(dist, 'src/application/index.js')).href
);
const { createWorkerLaunch } = await import(
  pathToFileURL(path.join(dist, 'src/application/worker-launch.js')).href
);
const retained = await readRecoveryRecord(recordFile);
const evidenceFile = `${resultFile}.carry.json`;
const recoveryInvocations = [];
let workerLaunches = 0;
const launch = createWorkerLaunch({
  executable: path.join(path.dirname(resultFile), 'missing-node'),
  entry: 'unused',
});
const exitCode = await runOperatorCommand({
  args: ['queue', 'run', '--project-config', projectConfig],
  workingDirectory: process.cwd(),
  environment: process.env,
  output: process.stdout,
  diagnostics: process.stderr,
  application: (settings) => {
    const launchWorker = async (...args) => {
      workerLaunches += 1;
      return launch(...args); // Immediate ENOENT through the real worker/process adapters.
    };
    const gated = carryBeforeWorkerLaunch({
      launchWorker,
      recordFile,
      retained,
      request: projectConfig,
      evidenceFile,
    });
    const application = createApplication({
      ...settings,
      launchWorker: async (...args) => {
        process.send({ boundary: 'first-worker-launch' });
        return mode === 'control' ? launchWorker(...args) : gated(...args);
      },
      recovery: () => ({
        async invoke() {
          recoveryInvocations.push(new Date().toISOString());
          return { ok: false, fault: { message: 'the rehearsal recovery runtime was consulted' } };
        },
        async notify() {
          return { ok: true, value: { messageId: 'harn99-rehearsal' } };
        },
      }),
    });
    if (mode === 'invalid-reset') {
      application.subscribe((event) => {
        if (event.source === 'application' && event.type === 'running') {
          // Fault after begin() and before the gate: restoration must refuse without launching.
          writeFileSync(
            recordFile,
            JSON.stringify({ request: { projectConfigPath: projectConfig }, invocations: 1 }),
          );
        }
      });
    }
    return application;
  },
});
const carryEvidence = mode === 'control' ? null : JSON.parse(await readFile(evidenceFile, 'utf8'));
await writeFile(
  resultFile,
  `${JSON.stringify({ exitCode, workerLaunches, recoveryInvocations, carryEvidence }, null, 2)}\n`,
);
process.exitCode = exitCode;
process.disconnect();
