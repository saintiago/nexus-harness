/**
 * The command line entry point: what it prints and which exit code it returns
 * for a command line that is not one of its commands, before anything is read,
 * created or started.
 *
 * `runCli` is the one module that owns the terminal — the help, the usage
 * errors, and the exit codes — so those decisions are decided here with a
 * recorded terminal and explicit arguments. `check-config` is the one command
 * that is static by design: it validates the composed configuration and
 * creates, starts and resolves nothing, which is why it is the command a
 * misconfigured checkout meets first.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { colorAllowed, runCli } from '../../src/cli.js';
import { EXIT_INPUT_ERROR, EXIT_OK, EXIT_USAGE } from '../../src/cli/context.js';
import { HELP } from '../../src/cli/help.js';
import { createTempDir, writeJsonFile } from '../support.js';

/** The documented harness and project configuration, as the loader reads them. */
const HARNESS = {
  workDir: 'runs',
  maxRepairs: 2,
  taskTimeoutMinutes: 60,
  commandTimeoutMinutes: 10,
};
const PROJECT = { setup: [], checks: [['node', 'check.mjs']] };

/** One command line's own terminal: what it printed, and where it ran. */
interface Invocation {
  readonly code: number;
  readonly out: readonly string[];
  readonly err: readonly string[];
  text(): string;
}

/** Runs one invocation with a recorded terminal, in `cwd` unless one is given. */
async function invoke(
  argv: readonly string[],
  options: { readonly cwd?: string } = {},
): Promise<Invocation> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd: options.cwd ?? process.cwd(),
    io: {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    },
  });
  return { code, out, err, text: () => [...out, ...err].join('\n') };
}

/** One connected-project directory with a validated pair of configuration files. */
async function configuredProject(): Promise<{
  readonly cwd: string;
  readonly harnessPath: string;
  readonly projectDir: string;
}> {
  const root = await createTempDir();
  const cwd = path.join(root, 'invocation');
  const projectDir = path.join(root, 'target');
  await mkdir(cwd, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  const harnessPath = await writeJsonFile(root, 'nexus.config.json', HARNESS);
  await writeJsonFile(projectDir, 'nexus.project.json', PROJECT);
  return { cwd, harnessPath, projectDir };
}

describe('the command line’s own surface', () => {
  it('prints the help and succeeds for no arguments and for a help flag', async () => {
    for (const argv of [[], ['--help'], ['-h'], ['run', '--help'], ['source', '-h']]) {
      const invocation = await invoke(argv);
      expect(invocation.code, argv.join(' ')).toBe(EXIT_OK);
      expect(invocation.out.join('\n'), argv.join(' ')).toBe(HELP);
      expect(invocation.err, argv.join(' ')).toEqual([]);
    }
    // The help names every command the entry point dispatches.
    for (const command of ['check-config', 'run', 'source', 'review', 'queue', 'supervise']) {
      expect(HELP).toContain(command);
    }
  }, 45_000);

  it('refuses an unknown command or option, and says what would have been accepted', async () => {
    const unknownCommand = await invoke(['frobnicate']);
    expect(unknownCommand.code).toBe(EXIT_USAGE);
    expect(unknownCommand.err.join('\n')).toContain('unknown command "frobnicate"');
    expect(unknownCommand.err.join('\n')).toContain('--help');

    const unknownOption = await invoke(['--nope']);
    expect(unknownOption.code).toBe(EXIT_USAGE);
    expect(unknownOption.err.join('\n')).toContain('unknown option "--nope"');
    expect(unknownOption.out).toEqual([]);
  }, 45_000);

  it('refuses a command line whose options are wrong, before reading anything', async () => {
    const cases: ReadonlyArray<readonly [readonly string[], string]> = [
      // A required option is missing: the command says which ones it needs.
      [['run'], 'requires'],
      // An option another command takes is unknown here.
      [['check-config', '--repo', 'target'], 'unknown option "--repo"'],
      // A value is missing when the next argument is another option.
      [['run', '--repo', '--config', 'x'], 'requires a path value'],
      // A value is missing when the option is written with an empty `=`.
      [['check-config', '--config=', '--project', 'target'], 'requires a path value'],
      // One option is given twice.
      [
        ['check-config', '--config', 'a', '--config', 'b', '--project', 'c'],
        'given more than once',
      ],
      // The help flag takes no value.
      [['check-config', '--help=x'], 'does not take a value'],
    ];

    for (const [argv, expected] of cases) {
      const invocation = await invoke(argv);
      expect(invocation.code, argv.join(' ')).toBe(EXIT_USAGE);
      expect(invocation.err.join('\n'), argv.join(' ')).toContain(expected);
      expect(invocation.err.join('\n'), argv.join(' ')).toContain('--help');
      expect(invocation.out, argv.join(' ')).toEqual([]);
    }
  }, 45_000);

  it('validates a composed configuration, resolving paths from the invocation directory', async () => {
    const { cwd, harnessPath, projectDir } = await configuredProject();

    const invocation = await invoke(
      // The CLI resolves its own paths from the invocation directory; the
      // workDir the harness configuration names resolves from its own file.
      [
        'check-config',
        '--config',
        path.relative(cwd, harnessPath),
        '--project',
        path.relative(cwd, projectDir),
      ],
      { cwd },
    );

    expect(invocation.code).toBe(EXIT_OK);
    expect(invocation.text()).toContain(`${harnessPath} is valid`);
    expect(invocation.text()).toContain(`${path.join(projectDir, 'nexus.project.json')} is valid`);
    expect(invocation.text()).toContain(path.join(path.dirname(harnessPath), 'runs'));
    expect(invocation.err).toEqual([]);
  }, 45_000);

  it('reports a configuration it cannot read as an input error, naming the file', async () => {
    const { cwd } = await configuredProject();

    const missing = await invoke(
      ['check-config', '--config', 'no-such-config.json', '--project', '.'],
      { cwd },
    );

    expect(missing.code).toBe(EXIT_INPUT_ERROR);
    expect(missing.err.join('\n')).toContain('no-such-config.json');
    expect(missing.out).toEqual([]);

    const missingProject = await invoke(['check-config', '--config', 'x.json'], { cwd });
    expect(missingProject.code).toBe(EXIT_USAGE);
    expect(missingProject.err.join('\n')).toContain('requires --project');
  }, 45_000);

  it('reads only a set, non-empty NO_COLOR as a request for no color', () => {
    expect(colorAllowed({})).toBe(true);
    expect(colorAllowed({ NO_COLOR: '' })).toBe(true);
    expect(colorAllowed({ NO_COLOR: '1' })).toBe(false);
  });
});
