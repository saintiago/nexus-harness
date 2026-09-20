/**
 * The command line: which value options each command accepts, and how one
 * argument list is parsed.
 *
 * A command's option table is what makes an option unknown for that command, so
 * `--repo` is refused by `check-config` and `--task` by every source command.
 */
export interface ParsedOptions {
  readonly repo: string | undefined;
  readonly config: string | undefined;
  readonly task: string | undefined;
  readonly limit: string | undefined;
}

export type OptionParse =
  | { readonly ok: true; readonly options: ParsedOptions }
  | { readonly ok: false; readonly message: string };
/**
 * The value options each command accepts, mapped to what a value is. `--repo` is
 * a `run`/`source` option and nothing else: `check-config` reads files and has no
 * source repository, so it reports `--repo` as the unknown option it is for that
 * command. `--limit` belongs to `source run` alone, and `--task` is refused on
 * every source command: a source task comes from the source, not from a file.
 */
export const CHECK_CONFIG_OPTIONS: ReadonlyMap<string, string> = new Map([
  ['--config', 'a path value'],
  ['--task', 'a path value'],
]);
export const RUN_OPTIONS: ReadonlyMap<string, string> = new Map([
  ['--repo', 'a path value'],
  ['--config', 'a path value'],
  ['--task', 'a path value'],
]);
export const SOURCE_LIST_OPTIONS: ReadonlyMap<string, string> = new Map([
  ['--config', 'a path value'],
]);
export const SOURCE_RUN_OPTIONS: ReadonlyMap<string, string> = new Map([
  ['--repo', 'a path value'],
  ['--config', 'a path value'],
  ['--limit', 'a positive integer value'],
]);
export const SOURCE_WATCH_OPTIONS: ReadonlyMap<string, string> = new Map([
  ['--repo', 'a path value'],
  ['--config', 'a path value'],
]);
export const REVIEW_SCAN_OPTIONS: ReadonlyMap<string, string> = new Map([
  ['--config', 'a path value'],
  ['--limit', 'a positive integer value'],
]);
export const REVIEW_WATCH_OPTIONS: ReadonlyMap<string, string> = new Map([
  ['--config', 'a path value'],
]);
export function parseOptions(
  args: readonly string[],
  allowed: ReadonlyMap<string, string>,
): OptionParse {
  const values = new Map<string, string>();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? '';
    const separator = argument.indexOf('=');
    const name = separator === -1 ? argument : argument.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1);

    if (name === '-h' || name === '--help') {
      // Bare help flags are handled before dispatch; reaching here means "--help=x".
      return { ok: false, message: `option "${name}" does not take a value` };
    }

    const wanted = allowed.get(name);
    if (wanted === undefined) {
      return { ok: false, message: `unknown option "${name}"` };
    }

    if (values.has(name)) {
      return { ok: false, message: `option "${name}" was given more than once` };
    }

    if (inlineValue !== undefined) {
      if (inlineValue === '') {
        return { ok: false, message: `option "${name}" requires ${wanted}` };
      }
      values.set(name, inlineValue);
      continue;
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith('-')) {
      return { ok: false, message: `option "${name}" requires ${wanted}` };
    }
    values.set(name, value);
    index += 1;
  }

  return {
    ok: true,
    options: {
      repo: values.get('--repo'),
      config: values.get('--config'),
      task: values.get('--task'),
      limit: values.get('--limit'),
    },
  };
}
/** `"--repo, --config and --task"`: the options one command was not given. */
export function listOptions(names: readonly string[]): string {
  const [only] = names;
  if (names.length === 1 && only !== undefined) {
    return only;
  }
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}
