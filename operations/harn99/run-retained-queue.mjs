#!/usr/bin/env node
/** Operational entry for KAN-76: carry its allowance before the first worker can run. */
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function readRecoveryRecord(file) {
  const bytes = await readFile(file);
  const record = JSON.parse(bytes.toString('utf8'));
  if (
    typeof record !== 'object' ||
    record === null ||
    typeof record.request?.projectConfigPath !== 'string' ||
    !Number.isInteger(record.invocations) ||
    record.invocations < 0
  ) {
    throw new Error(`The recovery execution record at ${file} is unusable.`);
  }
  return { file, bytes, sha256: createHash('sha256').update(bytes).digest('hex'), record };
}

/**
 * Application awaits this launcher after recovery.begin() and before it can call recover().
 * A carry failure throws (never a WorkerCompletion), so Application exits without recovery.
 * Subsequent worker restarts use the consumed count normally; they never repeat the carry.
 */
export function carryBeforeWorkerLaunch({
  launchWorker,
  recordFile,
  retained,
  request,
  evidenceFile,
}) {
  let carried = false;
  return async (...args) => {
    if (!carried) {
      const startedAt = new Date().toISOString();
      const temporary = `${recordFile}.${randomUUID()}.tmp`;
      try {
        const observed = await readRecoveryRecord(recordFile);
        if (
          observed.record.invocations !== 0 ||
          path.resolve(observed.record.request.projectConfigPath) !== path.resolve(request) ||
          path.resolve(args[0].projectConfigPath) !== path.resolve(request)
        ) {
          throw new Error(
            'Refusing continuation: the first worker did not follow the expected startup reset.',
          );
        }
        const value = {
          request: { projectConfigPath: request },
          invocations: retained.record.invocations,
        };
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
        await rename(temporary, recordFile);
        const after = await readRecoveryRecord(recordFile);
        if (
          after.record.invocations !== retained.record.invocations ||
          after.record.request.projectConfigPath !== request
        ) {
          throw new Error('Refusing continuation: the retained allowance could not be verified.');
        }
        await writeFile(
          evidenceFile,
          `${JSON.stringify(
            {
              carried: true,
              startedAt,
              carriedAt: new Date().toISOString(),
              retained: { record: retained.record, sha256: retained.sha256 },
              observed: observed.record,
              observedSha256: observed.sha256,
              carriedRecord: after.record,
              carriedSha256: after.sha256,
            },
            null,
            2,
          )}\n`,
        );
        carried = true;
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        await writeFile(
          evidenceFile,
          `${JSON.stringify(
            {
              carried: false,
              startedAt,
              reason: String(error),
            },
            null,
            2,
          )}\n`,
        ).catch(() => undefined);
        throw error;
      }
    }
    return launchWorker(...args);
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [dist, projectConfig, recordFile, retainedFile, evidenceFile] = process.argv.slice(2);
  if (!dist || !projectConfig || !recordFile || !retainedFile || !evidenceFile) {
    throw new Error(
      'Expected build, project config, recovery record, retained backup and carry evidence paths.',
    );
  }
  const { runOperatorCommand } = await import(
    pathToFileURL(path.join(dist, 'src/application/command.js')).href
  );
  const { createApplication } = await import(
    pathToFileURL(path.join(dist, 'src/application/index.js')).href
  );
  const retained = await readRecoveryRecord(retainedFile);
  process.exitCode = await runOperatorCommand({
    args: ['queue', 'run', '--project-config', projectConfig],
    workingDirectory: process.cwd(),
    environment: process.env,
    output: process.stdout,
    diagnostics: process.stderr,
    application: (settings) =>
      createApplication({
        ...settings,
        launchWorker: carryBeforeWorkerLaunch({
          launchWorker: settings.launchWorker,
          recordFile,
          retained,
          request: projectConfig,
          evidenceFile,
        }),
      }),
  });
}
