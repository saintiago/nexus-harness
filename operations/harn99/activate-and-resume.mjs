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
 * starts. The carry supervisor waits for that rewrite, pauses the queue parent, restores KAN-76's
 * retained count and resumes it, so no recovery invocation can read a reset count.
 *
 * Usage:
 *   node operations/harn99/activate-and-resume.mjs <merged-revision> [kan-project-config]
 *   node operations/harn99/activate-and-resume.mjs --rehearse [--dist <build>]
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
const messageOf = (error) => (error instanceof Error ? error.message : String(error));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const git = (...args) =>
  execFileSync('git', args, { cwd: settings.installation, encoding: 'utf8' }).trim();

/** What one execution's retained recovery record holds: its request and consumed invocations. */
function recoveryRecordProblem(value) {
  if (typeof value !== 'object' || value === null) {
    return 'it is not an object';
  }
  const { request, invocations } = value;
  if (
    typeof request !== 'object' ||
    request === null ||
    typeof request.projectConfigPath !== 'string'
  ) {
    return 'it names no request project configuration';
  }
  if (!Number.isInteger(invocations) || invocations < 0) {
    return 'its invocation count is not a non-negative integer';
  }
  return null;
}

/** One execution's retained recovery record with the bytes and hash that evidence it. */
async function readRecoveryRecord(file) {
  const bytes = await readFile(file);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(
      `The recovery execution record at ${file} is not valid JSON: ${messageOf(error)}`,
      { cause: error },
    );
  }
  const problem = recoveryRecordProblem(value);
  if (problem !== null) {
    throw new Error(`The recovery execution record at ${file} is unusable: ${problem}.`);
  }
  return { file, bytes, sha256: sha256(bytes), record: value };
}

/** The retained recovery record's readable content, or null while it is absent or mid-write. */
async function peekRecoveryRecord(file) {
  try {
    return await readRecoveryRecord(file);
  } catch {
    return null;
  }
}

/** Replace one recovery record the way the merged writer publishes it. */
async function writeRecoveryRecord(file, record) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** One process's scheduler state from /proc, or null once it has exited. */
function processState(pid) {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
  } catch {
    return null;
  }
}

/** Pause one process; true only once it reports the stopped state before it exits. */
async function stopProcess(pid) {
  try {
    process.kill(pid, 'SIGSTOP');
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = processState(pid);
    if (state === null) {
      return false;
    }
    if (state === 'T' || state === 't') {
      return true;
    }
    await delay(1);
  }
  return false;
}

/** Resume one paused process; a process that already exited is left alone. */
function continueProcess(pid) {
  try {
    process.kill(pid, 'SIGCONT');
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error;
    }
  }
}

/**
 * Carry a retained recovery invocation count through one queue startup. The queue parent rewrites
 * its execution record with invocations: 0 before the first worker starts; the supervisor waits
 * for that rewrite, pauses the parent while it restores the retained count (so no recovery
 * invocation can read the reset count), resumes it and reports the exact before/after records.
 * `carry: false` observes the startup rewrite without touching it, for the rehearsal's control run.
 */
function superviseRecoveryCarry({
  recordFile,
  retained,
  request,
  pid = null,
  alive = () => true,
  carry = true,
  timeoutMs = 120_000,
}) {
  const startedAt = new Date().toISOString();
  const result = (async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!alive()) {
        return {
          carried: false,
          reason: 'the queue exited before its startup record was observed',
          startedAt,
        };
      }
      const current = await peekRecoveryRecord(recordFile);
      if (current !== null && !current.bytes.equals(retained.bytes)) {
        const isStartupReset =
          current.record.invocations === 0 &&
          path.resolve(current.record.request.projectConfigPath) === path.resolve(request);
        if (!isStartupReset) {
          return {
            carried: false,
            reason:
              'the execution record changed to a value other than the startup reset; the ' +
              'retained count was not carried',
            observed: current.record,
            startedAt,
          };
        }
        if (!carry) {
          return { carried: false, observed: current.record, observedReset: true, startedAt };
        }
        const carriedRecord = {
          request: { projectConfigPath: request },
          invocations: retained.record.invocations,
        };
        const paused = pid === null ? false : await stopProcess(pid);
        try {
          await writeRecoveryRecord(recordFile, carriedRecord);
        } finally {
          if (paused) {
            continueProcess(pid);
          }
        }
        const after = await readRecoveryRecord(recordFile);
        const carried = after.record.invocations === retained.record.invocations;
        return {
          carried,
          ...(carried
            ? {}
            : { reason: 'the recorded count changed while the retained count was carried' }),
          observedReset: true,
          observed: current.record,
          carriedRecord: after.record,
          paused,
          startedAt,
          carriedAt: new Date().toISOString(),
          observedSha256: current.sha256,
          carriedSha256: after.sha256,
        };
      }
      await delay(2);
    }
    return {
      carried: false,
      reason: 'the queue startup record was not observed before the timeout',
      startedAt,
    };
  })();
  return { result };
}

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
    if (command.includes('/application/cli.js') || command.includes('/application/worker.js')) {
      users.push({ pid: Number(entry), command });
    }
  }
  return users;
}

/**
 * Rehearse one queue startup against a temporary storage root with the real operator command, the
 * real Application and the real recovery lifecycle: a retained nonzero count, a faulting worker
 * launch and a recording recovery runtime. The control run observes the startup reset and the
 * invocation it grants; the carried run proves the retained count reaches recover() with no
 * invocation spent. Neither run touches KAN-76's real execution or workspace state.
 */
async function rehearseRecoveryCarry(dist = settings.dist) {
  const { runOperatorCommand } = await import(
    pathToFileURL(path.join(dist, 'src/application/command.js')).href
  );
  const { createApplication } = await import(
    pathToFileURL(path.join(dist, 'src/application/index.js')).href
  );
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
    throw new Error(
      `The scoped KAN-76 configuration ${scopedConfig} names no task-source project.`,
    );
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-harn99-carry-'));
  const nexusConfigFile = path.join(root, 'nexus.config.json');
  await writeFile(
    nexusConfigFile,
    `${JSON.stringify({ ...base, workflow, storage: { ...base.storage, root } }, null, 2)}\n`,
  );
  const recordFile = path.join(root, 'executions', projectName, 'recovery', 'execution.json');
  const workerProblem = 'HARN-99 rehearsal: the worker never starts.';

  /** One startup with the real command and Application over the temporary execution directory. */
  const runStartup = async (carry) => {
    await mkdir(path.dirname(recordFile), { recursive: true });
    await writeFile(recordFile, retained.bytes);
    const invocations = [];
    const runtime = {
      async invoke() {
        invocations.push(new Date().toISOString());
        return { ok: false, fault: { message: 'the rehearsal recovery runtime was consulted' } };
      },
      async notify() {
        return { ok: true, value: { messageId: 'harn99-rehearsal' } };
      },
    };
    const output = {
      text: '',
      isTTY: false,
      write(chunk) {
        this.text += chunk;
      },
    };
    const diagnostics = {
      text: '',
      write(chunk) {
        this.text += chunk;
      },
    };
    const supervisor = superviseRecoveryCarry({
      recordFile,
      retained,
      request: scopedConfig,
      carry,
      timeoutMs: 10_000,
    });
    const exitCode = await runOperatorCommand({
      args: ['queue', 'run', '--project-config', scopedConfig],
      workingDirectory: process.cwd(),
      environment: { ...process.env, NEXUS_CONFIG: nexusConfigFile },
      output,
      diagnostics,
      application: (applicationSettings) =>
        createApplication({
          ...applicationSettings,
          launchWorker: async () => {
            // A real worker is a separate process; its launch and failure take longer than this.
            await delay(250);
            return { result: null, exitCode: null, problem: workerProblem, diagnostics: '' };
          },
          recovery: () => runtime,
        }),
    });
    const carryEvidence = await supervisor.result;
    const final = await readRecoveryRecord(recordFile);
    return {
      exitCode,
      recoveryInvocations: invocations,
      carryEvidence,
      final: final.record,
      finalSha256: final.sha256,
      diagnostics: diagnostics.text.trim(),
      output: output.text.length,
    };
  };

  const control = await runStartup(false);
  if (control.carryEvidence.observedReset !== true || control.final.invocations !== 1) {
    throw new Error(
      'The rehearsal control run did not observe the startup reset granting a fresh invocation.',
    );
  }
  const carried = await runStartup(true);
  if (
    carried.carryEvidence.carried !== true ||
    carried.recoveryInvocations.length !== 0 ||
    carried.final.invocations !== retained.record.invocations
  ) {
    throw new Error(
      'The rehearsal did not carry the retained recovery count through startup: ' +
        JSON.stringify(carried.carryEvidence),
    );
  }
  // The supervisor's production path over a real child process: it pauses the queue parent while
  // restoring the retained count and resumes it, so no work can read the reset count.
  const pauseRecord = path.join(root, 'pause-check', 'recovery', 'execution.json');
  const pauseChildFile = path.join(root, 'pause-check-child.mjs');
  await mkdir(path.dirname(pauseRecord), { recursive: true });
  await writeFile(pauseRecord, retained.bytes);
  await writeFile(
    pauseChildFile,
    [
      "import { mkdir, writeFile } from 'node:fs/promises';",
      `await mkdir(${JSON.stringify(path.dirname(pauseRecord))}, { recursive: true });`,
      `await writeFile(`,
      `  ${JSON.stringify(pauseRecord)},`,
      `  JSON.stringify({ request: { projectConfigPath: ${JSON.stringify(scopedConfig)} }, invocations: 0 }) + '\\n',`,
      `);`,
      'await new Promise((resolve) => setTimeout(resolve, 30_000));',
      '',
    ].join('\n'),
  );
  const pauseChild = spawn(process.execPath, [pauseChildFile], { stdio: 'ignore' });
  const pauseCheck = await superviseRecoveryCarry({
    recordFile: pauseRecord,
    retained,
    request: scopedConfig,
    pid: pauseChild.pid ?? null,
    alive: () => pauseChild.exitCode === null && pauseChild.signalCode === null,
  }).result;
  pauseChild.kill('SIGKILL');
  await new Promise((resolve) => pauseChild.on('exit', resolve));
  if (
    pauseCheck.carried !== true ||
    pauseCheck.paused !== true ||
    pauseCheck.observedReset !== true
  ) {
    throw new Error(
      'The rehearsal did not pause a real queue parent while carrying the retained count: ' +
        JSON.stringify(pauseCheck),
    );
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
        control: { ...control, note: 'No carry: the startup reset grants a fresh invocation.' },
        carried: { ...carried, note: 'The retained count reaches recover() with no invocation.' },
        pauseCheck: {
          ...pauseCheck,
          note: 'A real child process was paused while the retained count was restored.',
        },
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
    pauseCheck,
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
            observedReset: rehearsal.control.carryEvidence.observedReset === true,
            recoveryInvocations: rehearsal.control.recoveryInvocations.length,
            finalInvocations: rehearsal.control.final.invocations,
          },
          carried: {
            exitCode: rehearsal.carried.exitCode,
            carried: rehearsal.carried.carryEvidence.carried === true,
            recoveryInvocations: rehearsal.carried.recoveryInvocations.length,
            finalInvocations: rehearsal.carried.final.invocations,
          },
          pausedChild: {
            carried: rehearsal.pauseCheck.carried === true,
            paused: rehearsal.pauseCheck.paused === true,
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
  const resume = spawn(
    'bash',
    [
      '-c',
      'source "$HOME/.config/nexus/runtime-env.sh"; exec node "$1" queue run --project-config "$2"',
      'bash',
      cli,
      scopedConfig,
    ],
    { cwd: settings.installation, stdio: 'inherit' },
  );
  const completion = new Promise((resolve) => {
    resume.on('exit', (code, signal) => resolve({ code, signal }));
  });
  const carry = await superviseRecoveryCarry({
    recordFile: settings.recoveryRecord,
    retained: retainedRecovery,
    request: scopedConfig,
    pid: resume.pid ?? null,
    alive: () => resume.exitCode === null && resume.signalCode === null,
  }).result;
  const finished = await completion;
  const exitCode = finished.code ?? 1;
  const finalRecovery = await readRecoveryRecord(settings.recoveryRecord);
  const carriedThroughStartup =
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
      'The recovery allowance was reset below the retained count; the retained record is ' +
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
