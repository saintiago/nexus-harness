/**
 * The operating document, verified against the thing it documents.
 *
 * README.md is what a user follows, so it is checked the way a user finds out it
 * is wrong: the disposable example is read out of the README itself — its files,
 * its commands, its printed outcome block — then written, committed, and run
 * through the built CLI. This suite holds no second copy of the example, so a
 * documented file that stops working, a documented command whose options the CLI
 * no longer accepts, or a documented outcome block that no longer matches fails
 * here rather than in someone's terminal.
 *
 * The run in this suite is an **offline** verification: the runtime boundary is
 * the stand-in `codex` the end-to-end suite uses (tests/fixtures/fake-codex.mjs
 * behind a `codex` shim first on the CLI's `PATH`), not a live account. What it
 * proves is that the documented example, its options, and its printed paths are
 * the layout the CLI really produces. Nothing here needs credentials, and nothing
 * here contacts a provider.
 *
 * Also checked, because each is a claim the README makes about this repository:
 * every command it names exists, the help and usage behaviour it describes is
 * what the CLI does, every local link and in-page anchor resolves, the checked-in
 * example inputs still load and are what the shown `check-config` block reports,
 * and CI still installs reproducibly and runs the full gate.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadHarnessConfig, loadTask, resolveWorkDir } from '../src/config/load.js';
import type { RunReport } from '../src/shared/types.js';
import {
  BUILT_CLI,
  FEATURE_IMPLEMENTED,
  FEATURE_MISSING,
  GREET_ALL_SOURCE,
  ensureBuiltCli,
  fakeTurns,
  git,
  installFakeRuntime,
} from './fixtures/local-target.js';
import type { FakePlan, FakeState } from './fixtures/local-target.js';
import { cleanupTempDirectories, createTempDir, repoRoot } from './support.js';

const README = path.join(repoRoot, 'README.md');

/** The disposable example's own root, as the document writes it. */
const DOCUMENTED_ROOT = '/tmp/nexus-demo';

/** The section the disposable example lives in. */
const DEMO_SECTION = 'Try it on a disposable project';

/** How long the documented example may take to run. */
const RUN_TIMEOUT_MS = 120_000;

/** The README, read once: every test below reads the same document. */
let readme = '';

beforeAll(async () => {
  ensureBuiltCli();
  readme = await readFile(README, 'utf8');
});

afterAll(async () => {
  await cleanupTempDirectories();
});

// ---------------------------------------------------------------------------
// Reading the document
// ---------------------------------------------------------------------------

/** The part of the README under its `## <heading>` line, up to the next `## `. */
function section(heading: string): string {
  const lines = readme.split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === `## ${heading}`);
  expect(start, `README.md has no "## ${heading}" section`).toBeGreaterThanOrEqual(0);

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').startsWith('## ')) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** The bodies of every fenced code block in `text`. */
function fencedBlocks(text: string): readonly string[] {
  return [...text.matchAll(/^```[a-z]*\n([\s\S]*?)^```$/gm)].map((match) => match[1] ?? '');
}

/** Replaces the document's own `/tmp/nexus-demo` root with this test's. */
function withRoots(value: string, root: string): string {
  return value.replaceAll(DOCUMENTED_ROOT, root.split(path.sep).join('/'));
}

/** One file the document's shell writes, with its `cd` already applied to it. */
interface DocumentedFile {
  /** The absolute path this test writes it to. */
  readonly name: string;
  readonly text: string;
}

/**
 * Every file the document's shell writes, in order, with its own `cd` commands
 * applied — a relative `cat > …` belongs in the directory the document just
 * changed to, and getting that wrong is exactly what this suite exists to catch.
 * The content is the document's own: a test with a copy of it could not notice
 * the document going stale.
 */
function documentedFiles(text: string, root: string): readonly DocumentedFile[] {
  // `cd <dir>`, alone or after `&&`, and `cat > <file> <<'EOF' … EOF`.
  const item =
    /(?:(?:^|&& )cd (?<cd>\S+))|(?:^cat > (?<file>\S+) <<'EOF'\n(?<body>[\s\S]*?)^EOF$)/gm;
  const files: DocumentedFile[] = [];
  let directory = withRoots(DOCUMENTED_ROOT, root);

  for (const match of text.matchAll(item)) {
    const changed = match.groups?.['cd'];
    const name = match.groups?.['file'];
    if (changed !== undefined) {
      directory = withRoots(changed, root);
      continue;
    }
    if (name !== undefined) {
      files.push({
        name: path.resolve(directory, name),
        text: `${match.groups?.['body'] ?? ''}\n`,
      });
    }
  }
  return files;
}

/** The fenced block showing what a run prints: the one holding the run's header. */
function documentedOutcomeBlock(text: string): string {
  const block = fencedBlocks(text).find((candidate) => /^run run-\S+: \S+$/m.test(candidate));
  expect(block, 'README.md shows no run outcome block').toBeDefined();
  return block ?? '';
}

/** One labelled line of an outcome block, wherever it was printed. */
function outcomeLine(text: string, label: string): string | null {
  const match = new RegExp(`^\\s+${label}\\s+(\\S.*)$`, 'm').exec(text);
  return match?.[1]?.trim() ?? null;
}

/** The labels the shown outcome block carries, in the order it carries them. */
function documentedOutcomeLabels(text: string): readonly string[] {
  return documentedOutcomeBlock(text)
    .split('\n')
    .map((line) => /^ {2}([a-z][a-z ]*?) {2,}\S/.exec(line)?.[1])
    .filter((label): label is string => label !== undefined);
}

/** The `npm start -- <command>` line of a section, as the arguments after `--`. */
function documentedArguments(text: string, command: string): readonly string[] {
  const line = text
    .split('\n')
    .find((candidate) => candidate.startsWith(`npm start -- ${command}`));
  expect(line, `README.md documents no \`npm start -- ${command}\` command`).toBeDefined();
  return (line ?? '')
    .replace(/^npm start -- /, '')
    .trim()
    .split(/\s+/);
}

/**
 * The placeholder the document uses for a checkout, so that its recorded output
 * can be compared with this checkout's real output on any platform:
 * `/home/you/project`.
 */
const CHECKOUT_PLACEHOLDER = '/home/you/project';

/** Replaces this checkout's own path, however it is spelled, with the placeholder. */
function asPlaceholder(text: string): string {
  const root = repoRoot.replace(/[\\/]+$/, '');
  return text
    .replaceAll(root.split(path.sep).join('/'), CHECKOUT_PLACEHOLDER)
    .replaceAll(`${root}${path.sep}`, `${CHECKOUT_PLACEHOLDER}/`)
    .replaceAll(root, CHECKOUT_PLACEHOLDER);
}

/**
 * A real output or path, as the document would show it: this checkout read as the
 * placeholder, and separators as the document writes them. A recorded block
 * cannot carry this host's own separators, and the comparison must hold wherever
 * the suite runs. Only check-config output goes through this, and the only
 * separators in it are path separators.
 */
function asDocumentedOutput(text: string): string {
  return asPlaceholder(text).split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// Following the document
// ---------------------------------------------------------------------------

interface Documented {
  /** This test's `/tmp/nexus-demo`. */
  readonly parent: string;
  /** Where the document's `/tmp/nexus-demo/tiny-project` is here. */
  readonly project: string;
  /** Where the document's `harness.config.json` is here. */
  readonly configPath: string;
  readonly taskPath: string;
  /** The output directory the document's `workDir` resolves to. */
  readonly workDir: string;
  /** The documented run command, with this test's own root. */
  readonly argv: readonly string[];
  readonly state: FakeState;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Follows the document: writes the files its blocks write, commits the project's
 * baseline as it says to, and puts the stand-in runtime on the CLI's `PATH`. The
 * document stays the source of the project's content.
 */
async function followTheDocument(plans: readonly FakePlan[] = []): Promise<Documented> {
  const demo = section(DEMO_SECTION);
  const parent = await createTempDir();
  const files = documentedFiles(demo, parent);
  expect(files.length).toBeGreaterThanOrEqual(5);

  for (const file of files) {
    await mkdir(path.dirname(file.name), { recursive: true });
    await writeFile(file.name, file.text, 'utf8');
  }

  const project = path.join(parent, 'tiny-project');
  git(project, 'init', '--quiet', '--initial-branch=main');
  git(project, 'add', '--all');
  git(project, 'commit', '--quiet', '--message', 'tiny-project: baseline');

  const { bin, state } = await installFakeRuntime(parent);

  return {
    parent,
    project,
    configPath: path.join(parent, 'harness', 'harness.config.json'),
    taskPath: path.join(parent, 'harness', 'task.json'),
    workDir: path.join(parent, 'harness'),
    argv: documentedArguments(demo, 'run').map((argument) => withRoots(argument, parent)),
    state,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_CODEX: JSON.stringify({ stateDir: state.dir, plans }),
    },
  };
}

/** Runs the built CLI with a documented argument list and collects its output. */
function startCli(
  document: Documented,
  env: NodeJS.ProcessEnv = document.env,
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  return spawnSync(process.execPath, [BUILT_CLI, ...document.argv], {
    cwd: document.parent,
    env,
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
    windowsHide: true,
  });
}

/** The final report of the run in `runDir`, as a reader of `result.json` sees it. */
async function readReport(runDir: string): Promise<RunReport> {
  const file = path.join(runDir, 'result.json');
  expect(existsSync(file), file).toBe(true);
  return JSON.parse(await readFile(file, 'utf8')) as RunReport;
}

describe('the documented disposable example', () => {
  it('is a project whose committed baseline is green', async () => {
    const document = await followTheDocument();

    // The baseline the document tells the reader to run, run as it says.
    const checks = spawnSync(process.execPath, ['tools/run-checks.mjs'], {
      cwd: document.project,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
    expect(checks.status).toBe(0);
    expect(checks.stdout).toContain(FEATURE_MISSING);
    expect(checks.stdout).toContain('run-checks: 2 of 2 test files passed');

    // Green and clean, with the feature the task asks for still absent: the run
    // starts from a checkout with nothing in flight.
    expect(git(document.project, 'status', '--porcelain').trim()).toBe('');
    expect(existsSync(path.join(document.project, 'src', 'greet-all.mjs'))).toBe(false);

    // And the output directory the document chose is outside the source, which
    // is what makes the example safe to follow.
    expect(document.workDir).toBe(path.join(document.parent, 'harness'));
    expect(document.workDir.startsWith(`${document.project}${path.sep}`)).toBe(false);
    // The configuration lives there; the run's own directories do not exist yet.
    expect(existsSync(path.join(document.workDir, 'runs'))).toBe(false);
    expect(existsSync(path.join(document.workDir, 'workspaces'))).toBe(false);
  });

  it(
    'runs the documented command, and the paths it prints are the real layout',
    async () => {
      const demo = section(DEMO_SECTION);
      const document = await followTheDocument([
        {
          edits: [{ file: 'src/greet-all.mjs', text: GREET_ALL_SOURCE }],
          summary: 'added greetAll',
        },
      ]);
      expect(document.argv[0]).toBe('run');

      const run = startCli(document);
      expect(run.stderr).toBe('');
      expect(run.status).toBe(0);
      expect(run.stdout).toMatch(/^run \S+: passed$/m);

      // Everything the shown outcome block claims, the CLI really printed.
      const labels = documentedOutcomeLabels(demo);
      expect(labels).toContain('run dir');
      expect(labels).toContain('workspace');
      expect(labels).toContain('report');
      for (const label of labels) {
        expect(outcomeLine(run.stdout, label), `the run printed no "${label}" line`).not.toBeNull();
      }
      expect(outcomeLine(run.stdout, 'reason')).toContain(
        'every configured check passed after the implementation turn',
      );
      expect(outcomeLine(run.stdout, 'repairs')).toContain('0 of 2 repair turns used');

      // The shown block is internally the layout the document describes: a run ID
      // of the documented shape, the report inside that run's own directory, and
      // the working copy beside it. A hand-edited or stale block fails here.
      const shown = documentedOutcomeBlock(demo);
      const shownId = /^run (\S+): \S+$/m.exec(shown)?.[1] ?? '';
      expect(shownId).toMatch(/^run-\d{14}-[0-9a-f]{8}$/);
      const shownDir = `${DOCUMENTED_ROOT}/harness/runs/${shownId}`;
      const shownWorkspace = `${DOCUMENTED_ROOT}/harness/workspaces/${shownId}`;
      expect(outcomeLine(shown, 'run dir')).toBe(shownDir);
      expect(outcomeLine(shown, 'workspace')).toBe(`${shownWorkspace} (branch harness/${shownId})`);
      expect(outcomeLine(shown, 'report')).toBe(`${shownDir}/result.json`);
      expect(outcomeLine(shown, 'reason')).toBe(outcomeLine(run.stdout, 'reason'));
      expect(outcomeLine(shown, 'repairs')).toBe(outcomeLine(run.stdout, 'repairs'));

      // The layout: `<workDir>/runs/<runId>` for the logs and the report, and the
      // working copy beside them in `<workDir>/workspaces/<runId>`, on a branch of
      // its own.
      const runDir = outcomeLine(run.stdout, 'run dir') ?? '';
      const runId = path.basename(runDir);
      const workspace = path.join(document.workDir, 'workspaces', runId);
      expect(path.dirname(runDir)).toBe(path.join(document.workDir, 'runs'));
      expect(runId).toMatch(/^run-\d{14}-[0-9a-f]{8}$/);
      expect(outcomeLine(run.stdout, 'workspace')).toBe(`${workspace} (branch harness/${runId})`);
      expect(outcomeLine(run.stdout, 'report')).toBe(path.join(runDir, 'result.json'));

      for (const kept of [
        ['result.json'],
        ['logs', 'run.log'],
        ['logs', 'agent-implementation.log'],
        ['logs', 'baseline-check-1.stdout.log'],
        ['logs', 'baseline-check-1.stderr.log'],
        ['logs', 'attempt-1-check-1.stdout.log'],
      ]) {
        expect(existsSync(path.join(runDir, ...kept)), kept.join('/')).toBe(true);
      }
      expect(existsSync(workspace)).toBe(true);

      // The report agrees with what was printed, and with the document's inputs.
      const report = await readReport(runDir);
      expect(report.runId).toBe(runId);
      expect(report.status).toBe('passed');
      expect(report.repairsUsed).toBe(0);
      expect(report.timeout).toBeNull();
      expect(report.cancellation).toBeNull();
      expect(report.task.id).toBe('greet-all');
      expect(report.source.path).toBe(document.project);
      expect(report.source.baseCommit).toBe(git(document.project, 'rev-parse', 'HEAD').trim());
      expect(report.workspace.path).toBe(workspace);
      expect(report.workspace.branch).toBe(`harness/${runId}`);
      expect(report.workspace.prepared).toBe(true);
      expect(report.runLog).toBe(path.join(runDir, 'logs', 'run.log'));

      // The documented green baseline, and the round that decided the run.
      expect(report.baseline?.outcome).toBe('passed');
      expect(report.attempts).toHaveLength(1);
      expect(report.attempts[0]?.kind).toBe('implementation');
      expect(report.attempts[0]?.checks?.outcome).toBe('passed');

      // The work is in the retained working copy, the change summary is an
      // inspection of it, and the source repository was not touched.
      expect(existsSync(path.join(workspace, 'src', 'greet-all.mjs'))).toBe(true);
      expect(report.changes.inspected).toBe(true);
      expect(report.changes.paths.map((changed) => changed.path)).toEqual(['src/greet-all.mjs']);
      expect(git(document.project, 'status', '--porcelain').trim()).toBe('');

      // The turn really went through the production adapter, in the run's clone.
      const turns = await fakeTurns(document.state);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.argv).toEqual([
        '--ask-for-approval',
        'never',
        'exec',
        '--sandbox',
        'danger-full-access',
        '--json',
        '-',
      ]);
      expect(turns[0]?.cwd).toBe(workspace);

      // And the round after the turn is the one the document's own check command
      // takes from red to green: the retained logs hold what the check really said.
      const before = await readFile(
        path.join(runDir, 'logs', 'baseline-check-1.stdout.log'),
        'utf8',
      );
      expect(before).toContain(FEATURE_MISSING);
      const after = await readFile(
        path.join(runDir, 'logs', 'attempt-1-check-1.stdout.log'),
        'utf8',
      );
      expect(after).toContain(FEATURE_IMPLEMENTED);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'does not pass when the runtime cannot complete a turn',
    async () => {
      // The document says a run needs a usable Codex CLI. With a runtime that
      // cannot authenticate, the documented command fails and says so: the pass
      // above is not something the example reaches without a runtime.
      const document = await followTheDocument([{ mode: 'auth' }]);

      const run = startCli(document);
      expect(run.status).toBe(1);
      expect(run.stdout).toMatch(/^run \S+: failed$/m);

      const runDir = outcomeLine(run.stdout, 'run dir') ?? '';
      const timeline = await readFile(path.join(runDir, 'logs', 'run.log'), 'utf8');
      expect(timeline).toContain('baseline check-round result: passed');
      expect(timeline).toContain('implementation turn result: failed');
      expect(timeline).toContain('final status: failed');
      expect(timeline).not.toContain('post-agent check-round');

      const report = await readReport(runDir);
      expect(report.status).toBe('failed');
      expect(report.attempts[0]?.checks).toBeNull();
      expect(existsSync(path.join(runDir, 'workspace', 'src', 'greet-all.mjs'))).toBe(false);
      expect(git(document.project, 'status', '--porcelain').trim()).toBe('');
    },
    RUN_TIMEOUT_MS,
  );
});

describe('the claims the README makes about this repository', () => {
  it('names only commands that exist', async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    const named = new Set(
      [...readme.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)].map((match) => match[1] ?? ''),
    );
    expect(named.size).toBeGreaterThan(5);
    for (const script of named) {
      expect(Object.keys(pkg.scripts), `package.json has no "${script}" script`).toContain(script);
    }

    expect(pkg.scripts.start).toBeDefined();
    expect(pkg.scripts.test).toBeDefined();
    for (const command of ['npm start', 'npm test', 'npm ci']) {
      expect(readme).toContain(command);
    }
  });

  it('prints help and refuses a missing option exactly as it says', () => {
    // "`npm start -- --help` prints the full usage text, and `npm start -- run`
    // with a missing option prints a usage error and exits `2`."
    expect(readme).toContain('`npm start -- --help` prints the full usage text');

    const help = spawnSync(process.execPath, [BUILT_CLI, '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage');
    expect(help.stdout).toContain('check-config');
    expect(help.stdout).toContain('run');

    const missing = spawnSync(process.execPath, [BUILT_CLI, 'run'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
    expect(missing.status).toBe(2);
    expect(`${missing.stdout}${missing.stderr}`).toContain('--repo');
  });

  it('links only to files and headings that exist', () => {
    const links = [...readme.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1] ?? '');
    expect(links.length).toBeGreaterThan(5);

    const headings = new Set(
      readme
        .split('\n')
        .filter((line) => /^#{1,6} /.test(line))
        .map((line) =>
          line
            .replace(/^#{1,6} /, '')
            .toLowerCase()
            .replace(/[^a-z0-9 -]/g, '')
            .trim()
            .replace(/ +/g, '-'),
        ),
    );

    for (const link of links) {
      if (link.startsWith('#')) {
        expect(headings, `README.md has no heading for ${link}`).toContain(link.slice(1));
        continue;
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(link)) {
        continue; // An external URL: nothing local to check.
      }
      const [file = ''] = link.split('#');
      expect(existsSync(path.join(repoRoot, file)), `README.md links to a missing ${file}`).toBe(
        true,
      );
    }
  });

  it('shows the output the checked-in example inputs really produce', async () => {
    // The example inputs the document names still load through the harness's own
    // loader, and mean what the shown block says they mean.
    const configPath = path.join(repoRoot, 'harness.config.json');
    const taskPath = path.join(repoRoot, 'examples', 'task.json');
    const config = await loadHarnessConfig(configPath);
    const task = await loadTask(taskPath);
    const resolved = resolveWorkDir(config, configPath);

    // The documented `check-config` command, run as the document shows it.
    const run = spawnSync(process.execPath, [BUILT_CLI, ...documentedCheckConfig()], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);

    // The block is a real run's output from some checkout, so this checkout's own
    // path is read as the placeholder the document uses for it — the comparison
    // below must hold wherever the suite runs, on any platform.
    const printed = asDocumentedOutput(run.stdout);
    const shown = section('`check-config`: validate the two input files');

    // Every line the CLI prints is a line the document shows.
    for (const line of printed.split('\n')) {
      if (line.trim() !== '') {
        expect(shown, `the README does not show the CLI's line: ${line}`).toContain(line);
      }
    }

    // And every value the block shows is the value the inputs really carry.
    const shows = (label: string, value: string): void => {
      expect(outcomeLine(printed, label), `the CLI printed no "${label}" line`).toBe(value);
      expect(shown, `the README does not show ${label} as ${value}`).toContain(value);
    };
    shows('workDir', `${asDocumentedOutput(resolved)} (resolved from this file)`);
    shows('maxRepairs', String(config.maxRepairs));
    shows('taskTimeoutMinutes', String(config.taskTimeoutMinutes));
    shows('commandTimeoutMinutes', String(config.commandTimeoutMinutes));
    shows('setup', count(config.setup.length, 'command'));
    shows('checks', count(config.checks.length, 'command'));
    shows('id', task.id);
    shows('acceptanceCriteria', `${String(task.acceptanceCriteria.length)} item(s)`);
    expect(config.setup).toHaveLength(1);
    expect(config.checks).toHaveLength(2);
  });

  it('still describes CI as installing reproducibly and running the gate', async () => {
    const workflow = await readFile(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    const nvmrc = (await readFile(path.join(repoRoot, '.nvmrc'), 'utf8')).trim();

    expect(workflow).toContain('npm ci');
    expect(workflow).toContain('npm run validate');
    expect(workflow).toContain('node-version-file: .nvmrc');
    expect(readme).toContain('npm ci');
    expect(readme).toContain('npm run validate');
    expect(readme).toContain('.nvmrc');
    // The version the README says everything was run on is the one .nvmrc pins.
    expect(readme).toContain(nvmrc);
  });

  it('keeps offline evidence and live evidence apart', () => {
    const verified = section('What is verified, and what is not');
    expect(verified).toContain('Verified offline');
    expect(verified).toContain('Not verified anywhere yet');
    expect(verified).toContain('npm run test:live');

    const safety = section('Safety, limits, and what a run does to your machine');
    expect(safety).toContain('A `passed` run still needs human review');
    expect(safety).toContain('A clone is not a sandbox');
    expect(safety).toContain('There is no automatic resume');
    expect(safety).toContain('Do not use production or publishing credentials');
  });
});

/** A count and its noun, as the CLI prints them (`1 command`, `2 commands`). */
function count(value: number, noun: string): string {
  return `${String(value)} ${noun}${value === 1 ? '' : 's'}`;
}

/** The `check-config` command the document shows, as its arguments after `--`. */
function documentedCheckConfig(): readonly string[] {
  const line = readme
    .split('\n')
    .find((candidate) => candidate.startsWith('npm start -- check-config'));
  expect(line, 'README.md documents no `npm start -- check-config` command').toBeDefined();
  return (line ?? '')
    .replace(/^npm start -- /, '')
    .trim()
    .split(/\s+/);
}
