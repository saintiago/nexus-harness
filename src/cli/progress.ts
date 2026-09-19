/**
 * The run's own progress lines on an interactive terminal.
 *
 * The timeline is written once: the runner appends a line to the run log and
 * the CLI echoes it. Several of the lines a run writes when it starts are
 * inventory — a receipt path, an immutable ID, a revision, a commit hash, a
 * launch prefix — that belongs in the log and the report, not in the handful of
 * lines above the activity pane, where it would hide the task, the phase, and
 * the model a person watching the work is following.
 *
 * This module condenses exactly the lines it recognizes into the short forms
 * below; every other line is returned unchanged, so an unfamiliar shape is
 * shown as the run wrote it rather than guessed at. A line may also be dropped
 * when it says nothing a reader of the live view needs (the working copy's own
 * Git identity). Nothing here changes what is written to the log or the report,
 * and a redirected terminal — where these lines are the only record a reader
 * has — keeps every one of them exactly as written (`activity.ts` applies this
 * only to its pane, which exists only on an interactive terminal).
 */

/** How many milliseconds the configuration's own minutes are. */
const MS_PER_MINUTE = 60_000;

/** `task deadline set for <when>: <total> ms of total task time, <command> ms per configured command`. */
const TASK_DEADLINE =
  /^task deadline set for \S+: (\d+) ms of total task time, (\d+) ms per configured command$/;

/** `agent selected: runtime <runtime>, launch prefix <arguments>`. */
const AGENT_SELECTION = /^agent selected: runtime (\S+), launch prefix (.*)$/;

/** `source task: <type> <key> <url> (immutable id <id>, revision <when>)`. */
const SOURCE_TASK = /^source task: (\S+) (\S+) \S+ \(immutable id .*, revision .*\)$/;

/**
 * `<key>: reserved (<receipt file>); claiming <immutable id>`, with the
 * continuation variant naming the workspace between the two.
 */
const RESERVED = /^(\S+): reserved \((.*?)\); (.*)$/;

/** `<key>: another reservation already existed, so it was not attempted (<receipt file>)`. */
const ALREADY_RESERVED =
  /^(\S+): another reservation already existed, so it was not attempted \(.*\)$/;

/**
 * `workspace prepared at <path> on branch <branch> at <commit>` and
 * `continuing workspace <id> (attempt <n>) at <path> on branch <branch> at
 * <commit>`: the path is what a reader follows, the branch and the commit are
 * inventory.
 */
const WORKSPACE = /^(workspace prepared at|continuing workspace) (.*) on branch \S+ at \S+$/;

/** `workspace Git identity configured: user.name=…, user.email=…, …`. */
const GIT_IDENTITY = /^workspace Git identity configured: /;

/** How the Codex CLI's launch prefix spells the model it was pointed at. */
const MODEL_FLAGS = ['--model', '-m'];

/**
 * What one progress line reads as on an interactive terminal: its condensed
 * form, the line itself when its shape is not one this module knows, or `null`
 * when it has no place in the live view.
 */
export function interactiveProgress(text: string): string | null {
  const deadline = TASK_DEADLINE.exec(text);
  if (deadline !== null) {
    return `time limit: ${minutes(deadline[1])} min total, ${minutes(deadline[2])} min per command`;
  }
  const agent = AGENT_SELECTION.exec(text);
  if (agent !== null) {
    const model = selectedModel(agent[2] ?? '');
    return `agent: runtime ${agent[1] ?? ''}${model === null ? '' : `, model ${model}`}`;
  }
  const source = SOURCE_TASK.exec(text);
  if (source !== null) {
    return `source task: ${source[1] ?? ''} ${source[2] ?? ''}`;
  }
  const reserved = RESERVED.exec(text);
  if (reserved !== null) {
    const rest = (reserved[3] ?? '').replace(/claiming \S+$/, 'claiming');
    return `${reserved[1] ?? ''}: reserved; ${rest}`;
  }
  const already = ALREADY_RESERVED.exec(text);
  if (already !== null) {
    return `${already[1] ?? ''}: another reservation already existed, so it was not attempted`;
  }
  const workspace = WORKSPACE.exec(text);
  if (workspace !== null) {
    return `${workspace[1] ?? ''} ${workspace[2] ?? ''}`;
  }
  if (GIT_IDENTITY.test(text)) {
    return null;
  }
  return text;
}

/** Milliseconds as the whole minutes the configuration is written in. */
function minutes(ms: string | undefined): string {
  return String(Number(ms ?? '0') / MS_PER_MINUTE);
}

/**
 * The model a launch prefix names, or `null` when it names none.
 *
 * Only the prefix's own arguments are read — a `--model`/`-m` followed by its
 * value, or the `--model=value` spelling — and a prefix that cannot be read as
 * an argument array yields no model rather than a guess. Everything else about
 * the launch stays in the run log.
 */
function selectedModel(prefix: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(prefix);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const parts = parsed.map((part) => (typeof part === 'string' ? part : null));
  for (const [index, part] of parts.entries()) {
    if (part === null) {
      continue;
    }
    for (const flag of MODEL_FLAGS) {
      if (part === flag) {
        const value = parts[index + 1];
        return value === null || value === undefined || value.trim() === '' ? null : value.trim();
      }
      if (part.startsWith(`${flag}=`)) {
        const value = part.slice(flag.length + 1);
        return value.trim() === '' ? null : value.trim();
      }
    }
  }
  return null;
}
