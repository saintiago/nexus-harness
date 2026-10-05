#!/usr/bin/env node
/**
 * HARN-99: activate the checked merged Nexus installation and resume KAN-76's retained
 * requirements checkpoint in a separate visible WSL terminal.
 *
 * Run this script only after HARN-99's reviewed delivery merged, its required checks passed, and
 * every active Nexus execution finished or reached a normal retained stop. It refuses to touch the
 * installation while another Nexus runtime user is active, preserves KAN-76's retained recovery
 * execution record, rehearses the carry against the rebuilt installation and then starts the
 * scoped KAN-76 queue.
 *
 * Application.execute records a fresh recovery allowance (invocations: 0) before the first worker
 * starts. The operational queue entry restores the retained count inside the queue parent before
 * its first worker launch. A failed carry throws out of execute() without work or recovery running.
 *
 * Usage:
 *   node operations/harn99/activate-and-resume.mjs <merged-revision> [kan-project-config]
 *   node operations/harn99/activate-and-resume.mjs --rehearse [--dist <build>]
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecoveryRecord } from './run-retained-queue.mjs';

const argv = process.argv.slice(2);
const options = new Map();
const positional = [];
for (let index = 0; index < argv.length; index += 1) {
  const value = argv[index];
  if (!value.startsWith('--')) {
    positional.push(value);
    continue;
  }
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('--')) {
    options.set(value, true);
  } else {
    options.set(value, next);
    index += 1;
  }
}
const option = (name, fallback) => (options.has(name) ? options.get(name) : fallback);
const rehearse = options.has('--rehearse');
const [revision, kanConfigArgument] = positional;
const settings = {
  revision,
  kanConfig: path.resolve(
    kanConfigArgument ??
      option('--kan-config', undefined) ??
      '/home/aiur/projects/magic-collection-keeper-component-ci/nexus.project.json',
  ),
  installation: path.resolve(process.env['INSTALLATION'] ?? '/home/aiur/projects/nexus'),
  evidence: path.resolve(
    process.env['EVIDENCE_DIR'] ??
      option('--evidence-dir', undefined) ??
      '/home/aiur/.local/share/nexus/harn99-activation',
  ),
  nexusConfig: path.resolve(
    option('--nexus-config', undefined) ??
      path.join(os.homedir(), '.config/nexus/nexus.config.json'),
  ),
  codexHome: path.join(os.homedir(), '.codex'),
  kanWorkspace: '/home/aiur/.local/share/nexus/workspaces/KAN/KAN-76',
  executionDir: '/home/aiur/.local/share/nexus/executions/KAN',
};
settings.dist = path.resolve(option('--dist', path.join(settings.installation, 'dist')));
settings.recoveryRecord = path.join(settings.executionDir, 'recovery/execution.json');
const scopedConfig = path.join(settings.evidence, 'kan76-scoped.project.json');
const retainedQueueEntry = fileURLToPath(new URL('./run-retained-queue.mjs', import.meta.url));
if (!rehearse && (revision === undefined || revision.trim() === '')) {
  process.stderr.write(
    'usage: node operations/harn99/activate-and-resume.mjs <merged-revision> [kan-project-config]\n' +
      '       node operations/harn99/activate-and-resume.mjs --rehearse [--dist <build>]\n',
  );
  process.exit(2);
}

const exists = async (file) => {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const git = (...args) =>
  execFileSync('git', args, { cwd: settings.installation, encoding: 'utf8' }).trim();

/** Every running Nexus process, which keeps the installation in use. */
async function runtimeUsers() {
  const users = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    let command;
    try {
      command = (await readFile(`/proc/${entry}/cmdline`, 'utf8')).split('\0').join(' ').trim();
    } catch {
      continue;
    }
    if (
      command.includes('/application/cli.js') ||
      command.includes('/application/worker.js') ||
      command.includes('/harn99/run-retained-queue.mjs')
    ) {
      users.push({ pid: Number(entry), command });
    }
  }
  return users;
}

/**
 * Separate-process rehearsal using the real command/Application/recovery lifecycle and real worker
 * launcher with immediate ENOENT. The recording recovery runtime is the only agent substitute.
 * Supervision is deliberately delayed; preservation must hold without timely supervisor action.
 */
async function rehearseRecoveryCarry(dist = settings.dist) {
  const base = JSON.parse(await readFile(settings.nexusConfig, 'utf8'));
  const retained = await readRecoveryRecord(settings.recoveryRecord);
  if (!(await exists(scopedConfig))) {
    throw new Error(`The rehearsal needs the scoped KAN-76 configuration ${scopedConfig}.`);
  }
  const workflowModule = (file) => path.join(dist, 'workflows', path.basename(file));
  const workflow = {
    project: workflowModule(base.workflow.project),
    children: Object.fromEntries(
      Object.entries(base.workflow.children).map(([name, file]) => [name, workflowModule(file)]),
    ),
  };
  for (const file of [workflow.project, ...Object.values(workflow.children)]) {
    if (!(await exists(file))) {
      throw new Error(`The rehearsed build ${dist} has no workflow module ${file}.`);
    }
  }
  const project = JSON.parse(await readFile(scopedConfig, 'utf8'));
  const projectName = project.taskSource?.project;
  if (typeof projectName !== 'string' || projectName.trim() === '') {
    throw new Error(`The scoped configuration ${scopedConfig} names no task-source project.`);
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-harn99-carry-'));
  const nexusConfigFile = path.join(root, 'nexus.config.json');
  await writeFile(
    nexusConfigFile,
    `${JSON.stringify({ ...base, workflow, storage: { ...base.storage, root } }, null, 2)}\n`,
  );
  const recordFile = path.join(root, 'executions', projectName, 'recovery', 'execution.json');
  const fixture = fileURLToPath(new URL('./rehearse-retained-queue.mjs', import.meta.url));
  const runStartup = async (mode) => {
    await mkdir(path.dirname(recordFile), { recursive: true });
    await writeFile(recordFile, retained.bytes);
    const resultFile = path.join(root, `${mode}.json`);
    const child = spawn(
      process.execPath,
      [fixture, dist, scopedConfig, recordFile, resultFile, mode],
      {
        env: { ...process.env, NEXUS_CONFIG: nexusConfigFile },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    const completion = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    let diagnostics = '';
    child.stdout.resume();
    child.stderr.on('data', (chunk) => {
      diagnostics += chunk;
    });
    // Delay supervision at the first launch boundary, allowing an immediate launch failure and
    // recovery to finish before the parent reads anything. The child's barrier needs no release.
    const supervision = new Promise((resolve) => {
      let reachedBoundary = false;
      child.once('message', async () => {
        reachedBoundary = true;
        await delay(100);
        resolve({ reachedBoundary, delayMs: 100, observedAt: new Date().toISOString() });
      });
      child.once('exit', () => {
        if (!reachedBoundary) {
          resolve({ reachedBoundary: false });
        }
      });
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    let finished;
    try {
      finished = await completion;
    } finally {
      clearTimeout(timeout);
    }
    if (finished.signal !== null || !(await exists(resultFile))) {
      throw new Error(`Rehearsal ${mode} failed: ${JSON.stringify(finished)} ${diagnostics}`);
    }
    const supervisor = await supervision;
    if (!supervisor.reachedBoundary) {
      throw new Error(`Rehearsal ${mode} exited before the worker launch boundary: ${diagnostics}`);
    }
    const result = JSON.parse(await readFile(resultFile, 'utf8'));
    const final = await readRecoveryRecord(recordFile);
    return {
      ...result,
      processExit: finished.code,
      supervisor,
      final: final.record,
      finalSha256: final.sha256,
    };
  };
  const control = await runStartup('control');
  if (control.recoveryInvocations.length !== 1 || control.final.invocations !== 1) {
    throw new Error('The rehearsal control did not demonstrate the reset granting recovery.');
  }
  const carried = await runStartup('carried');
  if (
    carried.carryEvidence.carried !== true ||
    carried.workerLaunches !== 1 ||
    carried.recoveryInvocations.length !== 0 ||
    carried.final.invocations !== retained.record.invocations
  ) {
    throw new Error(`The separate-process carry failed: ${JSON.stringify(carried)}`);
  }
  const refused = await runStartup('invalid-reset');
  if (
    refused.processExit !== 1 ||
    refused.workerLaunches !== 0 ||
    refused.recoveryInvocations.length !== 0 ||
    refused.carryEvidence.carried !== false
  ) {
    throw new Error(`A failed carry did not prevent continuation: ${JSON.stringify(refused)}`);
  }
  const evidenceFile = path.join(settings.evidence, 'recovery-carry-rehearsal.json');
  await mkdir(settings.evidence, { recursive: true });
  await writeFile(
    evidenceFile,
    `${JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        root,
        dist,
        nexusConfig: nexusConfigFile,
        projectConfig: scopedConfig,
        recordFile,
        retained: { record: retained.record, sha256: retained.sha256 },
        control,
        carried,
        refused,
      },
      null,
      2,
    )}\n`,
  );
  return {
    evidence: evidenceFile,
    retainedInvocations: retained.record.invocations,
    control,
    carried,
    refused,
  };
}

async function main() {
  if (rehearse) {
    const rehearsal = await rehearseRecoveryCarry();
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: 'rehearse',
          evidence: rehearsal.evidence,
          retainedInvocations: rehearsal.retainedInvocations,
          control: {
            exitCode: rehearsal.control.exitCode,
            workerLaunches: rehearsal.control.workerLaunches,
            recoveryInvocations: rehearsal.control.recoveryInvocations.length,
            finalInvocations: rehearsal.control.final.invocations,
          },
          carried: {
            exitCode: rehearsal.carried.exitCode,
            carried: rehearsal.carried.carryEvidence.carried === true,
            recoveryInvocations: rehearsal.carried.recoveryInvocations.length,
            finalInvocations: rehearsal.carried.final.invocations,
          },
          refused: {
            exitCode: rehearsal.refused.exitCode,
            workerLaunches: rehearsal.refused.workerLaunches,
            recoveryInvocations: rehearsal.refused.recoveryInvocations.length,
          },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  await mkdir(settings.evidence, { recursive: true });
  process.env['TERM'] = 'xterm-256color';
  process.env['COLORTERM'] = 'truecolor';
  process.stdout.write(
    `Activation terminal: TERM=${process.env['TERM']} COLORTERM=${process.env['COLORTERM']} tty=${String(
      process.stdout.isTTY === true,
    )}\n`,
  );

  // The safe execution boundary: no other Nexus runtime user may still use the installation.
  const active = await runtimeUsers();
  if (active.length > 0) {
    throw new Error(
      `Refusing activation: active Nexus runtime users remain:\n${active
        .map((user) => `${String(user.pid)} ${user.command}`)
        .join('\n')}`,
    );
  }
  if (!(await exists(scopedConfig))) {
    throw new Error(
      `Refusing activation: the scoped KAN-76 configuration ${scopedConfig} is absent.`,
    );
  }
  const feedbackDirectory = path.join(settings.kanWorkspace, 'requirements/report-feedback');
  const feedback = (await exists(feedbackDirectory))
    ? (await readdir(feedbackDirectory)).filter((name) => name.endsWith('.json'))
    : [];
  if (feedback.length < 2) {
    throw new Error(
      'Refusing resumption: KAN-76 carries fewer than the two reconciled rejection records.',
    );
  }
  // The consumed recovery allowance Application would otherwise reset at startup. Its exact bytes
  // are preserved with the other pre-switch records and carried through the queue's startup below.
  const retainedRecovery = await readRecoveryRecord(settings.recoveryRecord);
  await writeFile(
    path.join(settings.evidence, 'activation-tty-proof.json'),
    `${JSON.stringify(
      {
        pid: process.pid,
        stdout: process.stdout.isTTY === true,
        stderr: process.stderr.isTTY === true,
        TERM: process.env['TERM'],
        COLORTERM: process.env['COLORTERM'],
      },
      null,
      2,
    )}\n`,
  );

  // Preserve host settings, records and checkpoints before the switch.
  const timestamp = new Date().toISOString().replaceAll(/[-:.]/g, '').replace('Z', 'Z');
  const backup = path.join(settings.evidence, 'activation-backups', timestamp);
  await mkdir(path.join(backup, 'terminal-records'), { recursive: true });
  await cp(settings.nexusConfig, path.join(backup, '0-nexus.config.json'));
  await cp(settings.kanConfig, path.join(backup, '1-kan.project.json'));
  await cp(path.join(settings.codexHome, 'config.toml'), path.join(backup, '2-config.toml'));
  await cp(settings.recoveryRecord, path.join(backup, '3-kan-recovery-execution.json'));
  for (const entry of await readdir(settings.codexHome)) {
    if (entry.startsWith('nexus-') && entry.endsWith('.config.toml')) {
      await cp(path.join(settings.codexHome, entry), path.join(backup, entry));
    }
  }
  for (const name of ['selection.json', 'workflow.json']) {
    const file = path.join(settings.executionDir, name);
    if (await exists(file)) {
      await cp(file, path.join(backup, 'terminal-records', name));
    }
  }

  // The checked merged revision, its required checks and the profile templates must agree.
  git('fetch', 'origin');
  git('merge', '--ff-only', settings.revision);
  const head = git('rev-parse', 'HEAD');
  if (head !== settings.revision) {
    throw new Error(`The installation resolved ${head}, not the requested ${settings.revision}.`);
  }
  for (const entry of await readdir(settings.codexHome)) {
    if (!entry.startsWith('nexus-') || !entry.endsWith('.config.toml')) {
      continue;
    }
    const template = path.join(settings.installation, 'profiles/codex', entry);
    const installed = await readFile(path.join(settings.codexHome, entry));
    const checked = await readFile(template);
    if (!installed.equals(checked)) {
      throw new Error(
        `Refusing activation: ${entry} differs from its checked template; install it deliberately.`,
      );
    }
  }

  // Build and verify the resolved launch target before anything is started.
  const build = spawnSync('bash', ['-c', 'npm ci && npm run build'], {
    cwd: settings.installation,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  await writeFile(
    path.join(backup, 'build.log'),
    `exit ${String(build.status)}\n\n${build.stdout}${build.stderr}`,
  );
  if (build.status !== 0) {
    throw new Error(
      `The installation build failed; see ${path.join(backup, 'build.log')}:\n${(
        build.stderr ?? ''
      ).slice(-2000)}`,
    );
  }
  const cli = path.join(settings.installation, 'dist/src/application/cli.js');
  const help = spawnSync('node', [cli, '--help'], { encoding: 'utf8' });
  if (help.status !== 0) {
    throw new Error(`The resolved launch target did not answer --help:\n${help.stderr}`);
  }
  const nexusConfig = JSON.parse(await readFile(settings.nexusConfig, 'utf8'));
  const workflowPaths = [
    nexusConfig.workflow.project,
    ...Object.values(nexusConfig.workflow.children),
  ];
  for (const workflow of workflowPaths) {
    if (!workflow.startsWith(path.join(settings.installation, 'dist') + path.sep)) {
      throw new Error(
        `Refusing activation: workflow ${workflow} does not resolve inside the installation dist.`,
      );
    }
    if (!(await exists(workflow))) {
      throw new Error(`Refusing activation: workflow ${workflow} is absent.`);
    }
  }
  // Rehearse the carried allowance on the freshly built installation before KAN-76 can resume.
  const rehearsal = await rehearseRecoveryCarry(path.join(settings.installation, 'dist'));
  await writeFile(
    path.join(settings.evidence, 'activation-current.json'),
    `${JSON.stringify(
      {
        status: 'ACTIVE',
        merge: settings.revision,
        resolvedHead: head,
        builtAt: new Date().toISOString(),
        backup,
        launchTarget: cli,
        resumptionEntry: retainedQueueEntry,
        workflowPaths,
        ttyProof: path.join(settings.evidence, 'activation-tty-proof.json'),
        kanConfig: scopedConfig,
        retainedRecoveryRecord: {
          file: settings.recoveryRecord,
          record: retainedRecovery.record,
          sha256: retainedRecovery.sha256,
          backup: path.join(backup, '3-kan-recovery-execution.json'),
        },
        carryRehearsal: {
          evidence: rehearsal.evidence,
          retainedInvocations: rehearsal.retainedInvocations,
          controlFinalInvocations: rehearsal.control.final.invocations,
          carriedFinalInvocations: rehearsal.carried.final.invocations,
        },
      },
      null,
      2,
    )}\n`,
  );

  // Resume KAN-76 through the normal queue, scoped to its retained checkpoint, in this terminal.
  process.stdout.write('\nResuming KAN-76 through the scoped queue; exit to stop.\n\n');
  await rm(path.join(settings.evidence, 'kan76-startup-carry.json'), { force: true });
  const resume = spawn(
    'bash',
    [
      '-c',
      'source "$HOME/.config/nexus/runtime-env.sh"; exec node "$1" "$2" "$3" "$4" "$5" "$6"',
      'bash',
      retainedQueueEntry,
      path.join(settings.installation, 'dist'),
      scopedConfig,
      settings.recoveryRecord,
      path.join(backup, '3-kan-recovery-execution.json'),
      path.join(settings.evidence, 'kan76-startup-carry.json'),
    ],
    { cwd: settings.installation, stdio: 'inherit' },
  );
  const finished = await new Promise((resolve, reject) => {
    resume.once('error', reject);
    resume.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const carryFile = path.join(settings.evidence, 'kan76-startup-carry.json');
  const carry = (await exists(carryFile))
    ? JSON.parse(await readFile(carryFile, 'utf8'))
    : { carried: false, reason: 'the queue did not publish startup carry evidence' };
  const exitCode = finished.code ?? 1;
  const finalRecovery = await readRecoveryRecord(settings.recoveryRecord);
  const carriedThroughStartup =
    carry.carried === true &&
    finalRecovery.record.invocations >= retainedRecovery.record.invocations;
  await writeFile(
    path.join(settings.evidence, 'kan76-resumption.json'),
    `${JSON.stringify(
      {
        status: exitCode === 0 ? 'drained' : 'stopped',
        exitCode,
        signal: finished.signal,
        finishedAt: new Date().toISOString(),
        recoveryAllowance: {
          recordFile: settings.recoveryRecord,
          retained: { record: retainedRecovery.record, sha256: retainedRecovery.sha256 },
          carry,
          final: { record: finalRecovery.record, sha256: finalRecovery.sha256 },
          carriedThroughStartup,
          invocationsConsumed:
            finalRecovery.record.invocations - retainedRecovery.record.invocations,
        },
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(
    `\nKAN-76 scoped queue finished with exit ${String(exitCode)}; recovery allowance ` +
      `${carriedThroughStartup ? 'preserved' : 'NOT preserved'} ` +
      `(${String(retainedRecovery.record.invocations)} consumed at the start, ` +
      `${String(finalRecovery.record.invocations)} at the end).\n`,
  );
  let finalExitCode = exitCode;
  if (!carriedThroughStartup) {
    process.stderr.write(
      'The startup carry failed or the final count is below the retained count; the record is ' +
        `preserved at ${path.join(backup, '3-kan-recovery-execution.json')} and the run evidence ` +
        'is in kan76-resumption.json.\n',
    );
    finalExitCode = 1;
  }
  if (process.stdin.isTTY === true) {
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    await reader.question('Press Enter to close this terminal.');
    reader.close();
  }
  process.exit(finalExitCode);
}

await main();
