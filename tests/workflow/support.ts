/**
 * What every workflow case assembles: one real target project in a temporary
 * directory, the two documents and the task that describe a run over it, and
 * the small pieces that let a case control the two responses a workflow would
 * otherwise get from outside — the coding runtime's turn and the service
 * answers of the configured integrations.
 *
 * Everything here is a real repository and a real directory tree that the
 * harness's own code prepares, clones, checks and reports; only the agent turn
 * and the service answers are supplied by the case, which is what
 * `docs/testing.md` asks of this layer. Nothing here is a second copy of Nexus,
 * and no case starts a live provider.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CliIo } from '../../src/cli/context.js';
import type { HarnessConfig } from '../../src/shared/types.js';
import { createRepository, gitOrFail } from '../boundary/integration-support.js';

/**
 * The target project's own configured check, as a file the repository commits.
 *
 * It passes for the baseline and for finished work, and fails for work that was
 * left half-done — the shape a repair round is for. Its own output names what it
 * read, so a case can prove the repair turn was handed the observed failure.
 */
export const TARGET_CHECK_SCRIPT = [
  "import { readFileSync } from 'node:fs';",
  '',
  "let text = '';",
  'try {',
  "  text = readFileSync('result.txt', 'utf8').trim();",
  '} catch {',
  "  text = '';",
  '}',
  "if (text === '' || text === 'implemented') {",
  '  process.exit(0);',
  '}',
  'process.stdout.write(`the work is not finished: result.txt says ${JSON.stringify(text)}\\n`);',
  'process.exit(1);',
  '',
].join('\n');

/** The file the target's work lands in, and what finished work says. */
export const TARGET_RESULT_FILE = 'result.txt';
export const TARGET_RESULT_DONE = 'implemented\n';

/** A recorder for what one CLI invocation printed, and the io it was given. */
export interface RecordedOutput {
  readonly out: readonly string[];
  readonly err: readonly string[];
  readonly io: CliIo;
  /** The recorded lines as one text, for a containment assertion. */
  text(): string;
}

export function recordingIo(): RecordedOutput {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    },
    text: () => [...out, ...err].join('\n'),
  };
}

/** One target project, and the files that describe a run over it. */
export interface WorkflowProject {
  /** The temporary directory everything of this case lives under. */
  readonly parent: string;
  /** The source checkout a run clones from, committed and clean. */
  readonly repo: string;
  /** The output directory `workDir` resolves to. */
  readonly workDir: string;
  /** The Nexus-wide harness configuration. */
  readonly configPath: string;
  /** The task file one `run` command is given. */
  readonly taskPath: string;
}

/** The task every workflow case runs, unless it names its own. */
export const WORKFLOW_TASK = {
  id: 'HARN-77',
  title: 'Finish the greeting',
  description: 'Implement the greeting the ticket describes.',
  acceptanceCriteria: ['The greeting is implemented.'],
} as const;

/**
 * Creates one target project: a committed source repository whose configured
 * check reads `result.txt`, the project configuration that points at it, the
 * harness configuration beside both, and a task file.
 */
export async function createTargetProject(
  parts: {
    readonly config?: Partial<HarnessConfig>;
    readonly task?: Record<string, unknown>;
    readonly commits?: readonly { readonly path: string; readonly text: string }[];
  } = {},
): Promise<WorkflowProject> {
  const fixture = await createRepository();
  await writeFile(path.join(fixture.repo, 'check.mjs'), TARGET_CHECK_SCRIPT, 'utf8');
  await writeFile(
    path.join(fixture.repo, 'nexus.project.json'),
    `${JSON.stringify(
      {
        setup: [],
        checks: [[process.execPath, 'check.mjs']],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  for (const commit of parts.commits ?? []) {
    await mkdir(path.dirname(path.join(fixture.repo, commit.path)), { recursive: true });
    await writeFile(path.join(fixture.repo, commit.path), commit.text, 'utf8');
  }
  await commitEverything(fixture.repo, 'the target project');

  const configPath = path.join(fixture.parent, 'nexus.config.json');
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        workDir: 'runs',
        maxRepairs: 2,
        taskTimeoutMinutes: 10,
        commandTimeoutMinutes: 5,
        ...parts.config,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const taskPath = path.join(fixture.parent, 'task.json');
  await writeFile(
    taskPath,
    `${JSON.stringify({ ...WORKFLOW_TASK, ...parts.task }, null, 2)}\n`,
    'utf8',
  );
  return { ...fixture, configPath, taskPath };
}

/** Commits everything the working copy holds, as a coding turn leaves it. */
export async function commitEverything(workspacePath: string, message: string): Promise<void> {
  await gitOrFail(['add', '--all'], workspacePath);
  await gitOrFail(['commit', '--quiet', '--message', message], workspacePath);
}

/** The commit a branch holds in one working copy, as Git reports it. */
export async function branchHead(workspacePath: string, branch: string): Promise<string> {
  return (await gitOrFail(['rev-parse', '--verify', `refs/heads/${branch}`], workspacePath)).trim();
}

/** The one run directory under `workDir/runs`, and the report it wrote. */
export async function readRunReport(
  workDir: string,
): Promise<{ readonly runDir: string; readonly report: Record<string, unknown> }> {
  const runsRoot = path.join(workDir, 'runs');
  const [runId] = await readdirEntries(runsRoot);
  if (runId === undefined) {
    throw new Error(`no run directory was allocated under ${runsRoot}`);
  }
  const runDir = path.join(runsRoot, runId);
  const report = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  return { runDir, report };
}

/** The entries of one directory, sorted, or an empty list when it is absent. */
export async function readdirEntries(directory: string): Promise<readonly string[]> {
  try {
    return (await readdir(directory, { withFileTypes: false })).sort();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw cause;
  }
}
