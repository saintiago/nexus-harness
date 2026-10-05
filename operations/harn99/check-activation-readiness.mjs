#!/usr/bin/env node
/**
 * HARN-99: activation-readiness evidence for the checked merged Nexus installation and the scoped
 * KAN-76 resumption. The script reports facts; it never switches the installation, never starts a
 * queue and never invokes KAN-76.
 *
 * It checks:
 *   1. the merged revision's required CI checks on GitHub;
 *   2. the currently resolved launch target and the active runtime users of the installation;
 *   3. the installed agent profiles against the checked revision's templates;
 *   4. the installation configuration's workflow paths;
 *   5. the scoped KAN-76 project configuration derived from the active KAN configuration;
 *   6. actual native-provider schema compliance for the profiles that will serve the resumption
 *      (a real provider turn per profile, never a historical replay).
 *
 * Evidence is written under --evidence-dir, outside product documentation.
 *
 * Usage:
 *   node operations/harn99/check-activation-readiness.mjs
 *     [--installation /home/aiur/projects/nexus] [--expected-merge <revision>]
 *     [--schema-dist <dist>] [--kan-config <nexus.project.json>] [--evidence-dir <dir>]
 *     [--profiles nexus-sol,nexus-flash] [--skip-provider-probe] [--probe-timeout-ms 600000]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const defaults = {
  installation: '/home/aiur/projects/nexus',
  expectedMerge: '84f273c54bf1013203e454cd28e5e4fb4585792b',
  kanConfig: '/home/aiur/projects/magic-collection-keeper-component-ci/nexus.project.json',
  kanWorktree: '/home/aiur/.local/share/nexus/workspaces/KAN/KAN-76/worktree',
  evidenceDir: '/home/aiur/.local/share/nexus/harn99-activation',
  environmentFile: '/home/aiur/.config/nexus/env',
  nexusConfig: '/home/aiur/.config/nexus/nexus.config.json',
  profiles: 'nexus-sol,nexus-flash',
  probeTimeoutMs: 600_000,
};

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} needs a value.`);
  }
  return value;
};
const settings = {
  installation: path.resolve(option('--installation', defaults.installation)),
  schemaDist: path.resolve(option('--schema-dist', path.join(defaults.installation, 'dist'))),
  kanWorktree: path.resolve(option('--kan-worktree', defaults.kanWorktree)),
  expectedMerge: option('--expected-merge', defaults.expectedMerge),
  kanConfig: path.resolve(option('--kan-config', defaults.kanConfig)),
  evidenceDir: path.resolve(option('--evidence-dir', defaults.evidenceDir)),
  environmentFile: path.resolve(option('--environment-file', defaults.environmentFile)),
  nexusConfig: path.resolve(option('--nexus-config', defaults.nexusConfig)),
  profiles: option('--profiles', defaults.profiles)
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== ''),
  probeTimeoutMs: Number(option('--probe-timeout-ms', String(defaults.probeTimeoutMs))),
  providerProbe: !argv.includes('--skip-provider-probe'),
};

const evidence = {};
const record = (name, value) => {
  evidence[name] = value;
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
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
const installationGit = (...args) =>
  execFileSync('git', args, { cwd: settings.installation, encoding: 'utf8' }).trim();

/** Every running Nexus process with its served project configuration and terminal environment. */
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
    if (!(
      command.includes('/application/cli.js') ||
      command.includes('/application/worker.js') ||
      command.includes('/harn99/run-retained-queue.mjs')
    )) {
      continue;
    }
    let environment = '';
    try {
      environment = await readFile(`/proc/${entry}/environ`, 'utf8');
    } catch {
      continue;
    }
    const variable = (name) => {
      const match = environment.split('\0').find((item) => item.startsWith(`${name}=`));
      return match === undefined ? null : match.slice(name.length + 1);
    };
    const startedAt = (() => {
      try {
        return execFileSync('ps', ['-o', 'lstart=', '-p', entry], { encoding: 'utf8' }).trim();
      } catch {
        return null;
      }
    })();
    users.push({
      pid: Number(entry),
      command,
      startedAt,
      TERM: variable('TERM'),
      COLORTERM: variable('COLORTERM'),
    });
  }
  return users;
}

/** The required GitHub check runs recorded for one revision. */
function checkRuns(repository, revision) {
  const output = execFileSync(
    'gh',
    [
      'run',
      'list',
      '--repo',
      repository,
      '--commit',
      revision,
      '--limit',
      '20',
      '--json',
      'databaseId,workflowName,status,conclusion,headSha,createdAt,event',
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(output);
}

/** The installed profile file of one profile, or null. */
async function installedProfile(profile) {
  const file = path.join(process.env.HOME ?? '', '.codex', `${profile}.config.toml`);
  return (await exists(file))
    ? { file, sha256: sha256(await readFile(file)) }
    : { file, sha256: null };
}

/** Derive the scoped KAN-76 configuration from the active KAN configuration. */
async function scopedKanConfiguration() {
  const base = await readJson(settings.kanConfig);
  const narrow = (query) => `(${query}) AND key = KAN-76`;
  const scoped = {
    ...base,
    taskSource: {
      ...base.taskSource,
      selection: { ...base.taskSource.selection, query: narrow(base.taskSource.selection.query) },
      ideas:
        base.taskSource.ideas === undefined
          ? undefined
          : {
              ...base.taskSource.ideas,
              selection: {
                ...base.taskSource.ideas.selection,
                query: narrow(base.taskSource.ideas.selection.query),
              },
            },
    },
  };
  if (base.taskSource.ideas === undefined) {
    delete scoped.taskSource.ideas;
  }
  const baseWithoutQueries = {
    ...base,
    taskSource: {
      ...base.taskSource,
      selection: { ...base.taskSource.selection, query: null },
      ideas:
        base.taskSource.ideas === undefined
          ? undefined
          : {
              ...base.taskSource.ideas,
              selection: { ...base.taskSource.ideas.selection, query: null },
            },
    },
  };
  const scopedWithoutQueries = {
    ...scoped,
    taskSource: {
      ...scoped.taskSource,
      selection: { ...scoped.taskSource.selection, query: null },
      ideas:
        scoped.taskSource.ideas === undefined
          ? undefined
          : {
              ...scoped.taskSource.ideas,
              selection: { ...scoped.taskSource.ideas.selection, query: null },
            },
    },
  };
  if (JSON.stringify(baseWithoutQueries) !== JSON.stringify(scopedWithoutQueries)) {
    throw new Error('The scoped KAN-76 configuration changed more than the selection queries.');
  }
  return { base, scoped };
}

/**
 * One real provider turn with the stage-author response schema, in a disposable clone of the
 * KAN-76 checkout. Mirrors the adapter's invocation vector: exec --json --profile <p> --model
 * <m> -c model_reasoning_effort="<e>" --output-schema <file> - with the prompt on stdin.
 */
async function providerProbe(profile, model, effort, schemaFile, worktree, outputDir) {
  const prompt = [
    'You are the Nexus requirements author for task KAN-76. Inspect the retained requirements',
    'documents in this checkout, then return one skip-proposed stage-author report for the',
    'requirements stage when the existing documents satisfy it. Do not modify the checkout.',
    'Return only one JSON object, without Markdown fences and without other text, matching:',
    await readFile(schemaFile, 'utf8'),
    `Workspace: ${worktree}`,
  ].join('\n\n');
  const codexArguments = [
    'exec',
    '--json',
    '--profile',
    profile,
    '--model',
    model,
    ...(effort === null ? [] : ['-c', `model_reasoning_effort="${effort}"`]),
    '--output-schema',
    schemaFile,
    '-',
  ];
  const startedAt = Date.now();
  const result = spawnSync(
    'bash',
    [
      '-c',
      'set -a; . "$1" >/dev/null 2>&1 || true; shift; exec "$@"',
      'bash',
      settings.environmentFile,
      'codex',
      ...codexArguments,
    ],
    {
      cwd: worktree,
      input: prompt,
      encoding: 'utf8',
      timeout: settings.probeTimeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const events = (result.stdout ?? '')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { unparsed: line };
      }
    });
  const messages = events
    .map((event) => event.item)
    .filter((item) => item?.type === 'agent_message' && typeof item.text === 'string');
  const output = messages.length === 0 ? null : messages.at(-1).text;
  let parsed = null;
  let problem = null;
  if (output === null) {
    problem = 'The provider returned no final agent message.';
  } else {
    try {
      parsed = JSON.parse(output);
    } catch (error) {
      problem = `The final agent message is not one JSON object: ${error.message}`;
    }
  }
  let schemaValid = false;
  if (parsed !== null) {
    try {
      const { stageAuthorResponseSchema } = await import(
        pathToFileURL(
          path.join(settings.schemaDist, 'src/task-engine/actions/preparation/artifacts.js'),
        ).href
      );
      stageAuthorResponseSchema.parse(parsed);
      schemaValid = true;
    } catch (error) {
      problem = `The final agent message does not match the response schema: ${error.message}`;
    }
  }
  const stdoutFile = path.join(outputDir, `${profile}.jsonl`);
  const stderrFile = path.join(outputDir, `${profile}.stderr.log`);
  await writeFile(stdoutFile, result.stdout ?? '');
  await writeFile(stderrFile, result.stderr ?? '');
  return {
    profile,
    model,
    effort,
    exitCode: result.status,
    signal: result.signal,
    durationMs: Date.now() - startedAt,
    outputIsJsonObject: parsed !== null,
    schemaValid,
    problem,
    finalMessage: output,
    events: events.length,
    stdoutFile,
    stdoutSha256: sha256(result.stdout ?? ''),
    stderrFile,
    command: ['codex', ...codexArguments].join(' '),
  };
}

async function main() {
  record('startedAt', new Date().toISOString());
  record('expectedMerge', settings.expectedMerge);
  record('installation', settings.installation);
  record('kanConfig', settings.kanConfig);

  // --- Required checks ------------------------------------------------------------------------
  const remote = installationGit('remote', 'get-url', 'origin');
  const repository = remote.replace(/^.*github\.com[:/]/, '').replace(/\.git$/, '');
  const runs = checkRuns(repository, settings.expectedMerge);
  const successful = runs.filter((run) => run.conclusion === 'success');
  if (successful.length === 0) {
    throw new Error(`No successful required check is recorded for ${settings.expectedMerge}.`);
  }
  record('requiredChecks', { repository, runs });

  // --- Installation and launch target ---------------------------------------------------------
  const head = installationGit('rev-parse', 'HEAD');
  const originMain = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], {
    cwd: settings.installation,
    encoding: 'utf8',
  })
    .trim()
    .split(/\s+/)[0];
  const status = installationGit('status', '--porcelain=v1');
  const containsMerge = (() => {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', settings.expectedMerge, head], {
        cwd: settings.installation,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return true;
    } catch {
      return false;
    }
  })();
  const cli = path.join(settings.installation, 'dist/src/application/cli.js');
  const nexusConfig = await readJson(settings.nexusConfig);
  const workflowPaths = [];
  for (const [name, file] of Object.entries({
    project: nexusConfig.workflow.project,
    ...nexusConfig.workflow.children,
  })) {
    workflowPaths.push({
      name,
      file,
      resolved: path.relative(path.join(settings.installation, 'dist'), file),
      exists: await exists(file),
    });
  }
  record('installationState', {
    head,
    originMain,
    branch: installationGit('branch', '--show-current'),
    clean: status === '',
    containsMerge,
    cliExists: await exists(cli),
    cliBuiltAt: (await stat(cli).catch(() => null))?.mtime?.toISOString() ?? null,
    workflowPaths,
  });

  // --- Active runtime users (the safe switching boundary) -------------------------------------
  const users = await runtimeUsers();
  record('activeRuntimeUsers', users);

  // --- Installed profiles ---------------------------------------------------------------------
  const profiles = [];
  for (const profile of settings.profiles) {
    const file = path.join(settings.installation, 'profiles/codex', `${profile}.config.toml`);
    const checked = (await exists(file))
      ? { file, sha256: sha256(await readFile(file)) }
      : { file, sha256: null };
    const installed = await installedProfile(profile);
    profiles.push({
      profile,
      checkedRevisionTemplate: checked,
      installed,
      identical: checked.sha256 !== null && checked.sha256 === installed.sha256,
    });
  }
  record('installedProfiles', profiles);

  // --- Scoped KAN-76 configuration ------------------------------------------------------------
  const { scoped } = await scopedKanConfiguration();
  const scopedFile = path.join(settings.evidenceDir, 'kan76-scoped.project.json');
  await mkdir(settings.evidenceDir, { recursive: true });
  await writeFile(scopedFile, `${JSON.stringify(scoped, null, 2)}\n`);
  record('scopedKanConfiguration', {
    file: scopedFile,
    selectionQuery: scoped.taskSource.selection.query,
  });

  // --- Provider probes ------------------------------------------------------------------------
  const probes = [];
  if (settings.providerProbe) {
    await mkdir(settings.evidenceDir, { recursive: true });
    const probeRoot = await mkdtemp(path.join(settings.evidenceDir, 'provider-probe-'));
    const probeWorktree = path.join(probeRoot, 'worktree');
    execFileSync(
      'git',
      ['clone', '--quiet', '--no-hardlinks', settings.kanWorktree, probeWorktree],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const schemaFile = path.join(probeRoot, 'stage-author.schema.json');
    const { stageAuthorResponseSchema } = await import(
      pathToFileURL(
        path.join(settings.schemaDist, 'src/task-engine/actions/preparation/artifacts.js'),
      ).href
    );
    const { z } = await import('zod');
    await writeFile(
      schemaFile,
      `${JSON.stringify(z.toJSONSchema(stageAuthorResponseSchema), null, 2)}\n`,
    );
    for (const profile of settings.profiles) {
      const configured = nexusConfig.agentRuntime.profiles.find((entry) => entry.id === profile);
      if (configured === undefined) {
        probes.push({ profile, problem: 'The installation configuration names no such profile.' });
        continue;
      }
      probes.push(
        await providerProbe(
          configured.id,
          configured.model,
          configured.effort ?? null,
          schemaFile,
          probeWorktree,
          probeRoot,
        ),
      );
    }
    await rm(probeWorktree, { recursive: true, force: true });
    record('providerProbes', {
      probeRoot,
      schema: {
        dist: settings.schemaDist,
        file: schemaFile,
        sha256: sha256(await readFile(schemaFile)),
      },
      probes,
      note:
        'Each probe was a real provider turn with the stage-author response schema in a disposable ' +
        'clone of the KAN-76 checkout; it is not a historical replay. The probe prompt is ' +
        'representative but shorter than a full workflow invocation.',
    });
  } else {
    record('providerProbes', { skipped: true });
  }

  record('finishedAt', new Date().toISOString());
  await mkdir(settings.evidenceDir, { recursive: true });
  const evidenceFile = path.join(settings.evidenceDir, 'activation-readiness.json');
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  const summary = {
    evidence: evidenceFile,
    expectedMerge: settings.expectedMerge,
    requiredChecks: successful.map((run) => ({
      workflow: run.workflowName,
      id: run.databaseId,
      conclusion: run.conclusion,
    })),
    installationHead: head,
    installationContainsMerge: containsMerge,
    activeRuntimeUsers: users.map((user) => user.pid),
    profileParity: profiles.map((entry) => ({
      profile: entry.profile,
      identical: entry.identical,
    })),
    scopedKanConfiguration: scopedFile,
    providerProbesSkipped: !settings.providerProbe,
    providerProbes: probes.map((probe) => ({
      profile: probe.profile,
      exitCode: probe.exitCode,
      outputIsJsonObject: probe.outputIsJsonObject,
      schemaValid: probe.schemaValid,
      problem: probe.problem ?? null,
    })),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

await main();
