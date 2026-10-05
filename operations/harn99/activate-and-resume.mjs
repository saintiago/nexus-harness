#!/usr/bin/env node
/**
 * HARN-99: activate the checked merged Nexus installation and resume KAN-76's retained
 * requirements checkpoint in a separate visible WSL terminal.
 *
 * Run this script only after HARN-99's reviewed delivery merged, its required checks passed, and
 * every active Nexus execution finished or reached a normal retained stop. It refuses to touch the
 * installation while another Nexus runtime user is active, and it verifies the resolved launch
 * target before starting the scoped KAN-76 queue.
 *
 * Usage: node operations/harn99/activate-and-resume.mjs <merged-revision> [kan-project-config]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import os from 'node:os';
import path from 'node:path';

const [revision, kanConfigArgument] = process.argv.slice(2);
const settings = {
  revision,
  kanConfig: path.resolve(
    kanConfigArgument ??
      '/home/aiur/projects/magic-collection-keeper-component-ci/nexus.project.json',
  ),
  installation: path.resolve(process.env['INSTALLATION'] ?? '/home/aiur/projects/nexus'),
  evidence: path.resolve(
    process.env['EVIDENCE_DIR'] ?? '/home/aiur/.local/share/nexus/harn99-activation',
  ),
  nexusConfig: path.join(os.homedir(), '.config/nexus/nexus.config.json'),
  codexHome: path.join(os.homedir(), '.codex'),
  kanWorkspace: '/home/aiur/.local/share/nexus/workspaces/KAN/KAN-76',
  executionDir: '/home/aiur/.local/share/nexus/executions/KAN',
};
if (revision === undefined || revision.trim() === '') {
  process.stderr.write(
    'usage: node operations/harn99/activate-and-resume.mjs <merged-revision> [kan-project-config]\n',
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
    if (command.includes('/application/cli.js') || command.includes('/application/worker.js')) {
      users.push({ pid: Number(entry), command });
    }
  }
  return users;
}

async function main() {
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
  const scopedConfig = path.join(settings.evidence, 'kan76-scoped.project.json');
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
      },
      null,
      2,
    )}\n`,
  );

  // Resume KAN-76 through the normal queue, scoped to its retained checkpoint, in this terminal.
  process.stdout.write('\nResuming KAN-76 through the scoped queue; exit to stop.\n\n');
  const resume = spawnSync(
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
  const exitCode = resume.status ?? 1;
  await writeFile(
    path.join(settings.evidence, 'kan76-resumption.json'),
    `${JSON.stringify(
      {
        status: exitCode === 0 ? 'drained' : 'stopped',
        exitCode,
        finishedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`\nKAN-76 scoped queue finished with exit ${String(exitCode)}.\n`);
  if (process.stdin.isTTY === true) {
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    await reader.question('Press Enter to close this terminal.');
    reader.close();
  }
  process.exit(exitCode);
}

await main();
