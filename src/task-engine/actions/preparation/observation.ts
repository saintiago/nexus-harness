import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { GitAdapter } from '../../../adapters/git.js';
import { messageOf } from '../../../result.js';
import { describeIssues, parseDocument, readDocumentText } from '../documents.js';
import { assessedContentSchema, type AssessedContent } from './artifacts.js';
import { checkoutRelative } from './evaluation-content.js';

/**
 * The prototype roles' observation contract: one producer-owned record each role saves under its
 * round artifact area and references from its report. The record binds what the role inspected to
 * the evaluated prototype revision; the stage actions validate it before any acceptance relies on
 * it. An image path or a claimed successful build alone is never sufficient evidence.
 */

/** One rendered-image bytes signature a saved screenshot must carry to count as evidence. */
const imageSignatures: readonly ((bytes: Buffer) => boolean)[] = [
  (bytes) =>
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  (bytes) => bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  (bytes) => bytes.subarray(0, 6).toString('latin1') === 'GIF87a',
  (bytes) => bytes.subarray(0, 6).toString('latin1') === 'GIF89a',
  (bytes) =>
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP',
];

/** One saved prototype observation record, as both prototype roles declare it. */
export const prototypeObservationSchema = z.object({
  /** Which prototype role performed the observation; it must match the declaring report. */
  role: z.enum(['author', 'evaluator']),
  /** The inspected prototype content, bound to the revision the role observed it at. */
  content: z.array(assessedContentSchema).min(1),
  /** The preview the role actually used: the exact start command and the URL it reached. */
  preview: z.object({
    command: z.string().trim().min(1),
    url: z.string().trim().min(1),
  }),
  /** One exercised journey or state with its actions, result and rendered-image evidence. */
  journeys: z
    .array(
      z.object({
        example: z.string().trim().min(1),
        state: z.string().trim().min(1),
        actions: z.array(z.string().trim().min(1)).min(1),
        observed: z.string().trim().min(1),
        screenshots: z.array(z.object({ path: z.string().trim().min(1) })).min(1),
        visualConclusion: z.string().trim().min(1),
      }),
    )
    .min(1),
});

export type PrototypeObservation = z.infer<typeof prototypeObservationSchema>;

/** The role one prototype observation record must state. */
export type PrototypeObservationRole = PrototypeObservation['role'];

/**
 * The observation contract the prototype roles receive with their invocation context: the runtime
 * schema they write their record against and how the evidence is retained and bound.
 */
export function prototypeObservationContract(roundDirectory: string): string {
  return [
    'Prototype observation contract (save your own record under the round artifact area and',
    'return its path as the response field "observation"):',
    JSON.stringify(z.toJSONSchema(prototypeObservationSchema), null, 2),
    `Round artifact area: ${roundDirectory}`,
    '- Start the project\u2019s Storybook preview from the shared checkout with the project\u2019s own',
    '  command, in your own browser session, and release the preview and browser processes after',
    '  the observation.',
    '- Commit the stage-owned prototype paths you inspected first, then name that commit revision',
    '  in every content entry; content at the named revision must still match the evaluated',
    '  revision, so edit, commit and observe in that order.',
    '- Save your screenshots under the round artifact area; each journey needs rendered-image',
    '  evidence a reader can open, not a build log or an image path alone.',
    '- Record the preview start command and URL you used, and the actions you performed.',
    '- A skip or a change request carries no observation; only applicable work you accept needs it.',
  ].join('\n');
}

/**
 * One declared evidence path resolved inside its round artifact area, or null when it lies outside
 * it. A relative path resolves against the round artifact area; an absolute path must already name
 * a file inside it.
 */
export function evidenceFilePath(roundDirectory: string, declared: string): string | null {
  const resolved = path.isAbsolute(declared)
    ? path.resolve(declared)
    : path.resolve(roundDirectory, declared);
  const relative = path.relative(roundDirectory, resolved);
  return relative === '' || relative.startsWith('..') || path.isAbsolute(relative)
    ? null
    : resolved;
}

/** True when the saved bytes are one of the rendered-image formats the contract accepts. */
function isRenderedImage(bytes: Buffer): boolean {
  return bytes.length > 0 && imageSignatures.some((matches) => matches(bytes));
}

/**
 * Read one role's saved prototype observation record and validate everything the producer-owned
 * contract can check without judging usability: the record lies inside the role's round artifact
 * area, matches the observation schema, states the declaring role and references readable
 * rendered-image screenshots from that same area. Throws a concrete reason otherwise.
 */
export async function readPrototypeObservation(settings: {
  readonly declared: string;
  readonly roundDirectory: string;
  readonly role: PrototypeObservationRole;
}): Promise<PrototypeObservation> {
  const file = evidenceFilePath(settings.roundDirectory, settings.declared);
  if (file === null) {
    throw new Error(
      `The ${settings.role}'s prototype observation "${settings.declared}" lies outside the ` +
        `round artifact area "${settings.roundDirectory}".`,
    );
  }
  const text = await readDocumentText(file, `${settings.role} prototype observation`);
  if (text === null) {
    throw new Error(`The ${settings.role}'s prototype observation "${file}" does not exist.`);
  }
  const parsed = parseDocument(text, prototypeObservationSchema);
  if (parsed.kind === 'invalid-json') {
    throw new Error(
      `The ${settings.role}'s prototype observation "${file}" is not valid JSON: ` +
        `${messageOf(parsed.error)}`,
      { cause: parsed.error },
    );
  }
  if (parsed.kind === 'invalid-content') {
    throw new Error(
      `The ${settings.role}'s prototype observation "${file}" does not match the observation ` +
        `contract: ${describeIssues(parsed.error, '<observation>')}`,
      { cause: parsed.error },
    );
  }
  const observation = parsed.content;
  if (observation.role !== settings.role) {
    throw new Error(
      `The prototype observation "${file}" records the ${observation.role} role while the ` +
        `${settings.role} declared it.`,
    );
  }
  for (const journey of observation.journeys) {
    for (const screenshot of journey.screenshots) {
      const image = evidenceFilePath(settings.roundDirectory, screenshot.path);
      if (image === null) {
        throw new Error(
          `The screenshot "${screenshot.path}" of journey "${journey.example}" lies outside the ` +
            `round artifact area "${settings.roundDirectory}".`,
        );
      }
      let bytes: Buffer;
      try {
        const entry = await stat(image);
        if (!entry.isFile()) {
          throw new Error('not a regular file');
        }
        bytes = await readFile(image);
      } catch (error) {
        throw new Error(
          `The screenshot "${image}" of journey "${journey.example}" is not readable: ` +
            messageOf(error),
          { cause: error },
        );
      }
      if (!isRenderedImage(bytes)) {
        throw new Error(
          `The screenshot "${image}" of journey "${journey.example}" is not readable rendered ` +
            'image evidence.',
        );
      }
    }
  }
  return observation;
}

/**
 * Why the observation does not bind the content the author is submitting, or null when it does:
 * every entry's named revision must retain exactly the content the shared checkout holds now, so
 * the author commits the inspected prototype before observing it. A later edit without fresh
 * observation is rejected instead of silently accepted.
 */
export async function observationSubmissionProblem(settings: {
  readonly git: GitAdapter;
  readonly worktree: string;
  readonly observation: PrototypeObservation;
}): Promise<string | null> {
  const { git, worktree, observation } = settings;
  for (const entry of observation.content) {
    const relative = checkoutRelative(worktree, entry.path);
    if (relative === null) {
      return `the observation names "${entry.path}", which lies outside the shared preparation checkout`;
    }
    const saved = await git.readFileAtRevision(worktree, entry.revision, relative);
    if (!entry.exists) {
      if (saved.ok) {
        return (
          `the observation reports "${relative}" as deleted while revision ${entry.revision} ` +
          'retains it'
        );
      }
      continue;
    }
    if (!saved.ok) {
      return (
        `the observation names revision ${entry.revision}, which does not retain "${relative}"; ` +
        'commit the inspected content and bind that revision'
      );
    }
    let current: string;
    try {
      const entry = await stat(path.join(worktree, relative));
      if (!entry.isFile()) {
        return `the observation names "${relative}", which is not a file in the shared checkout`;
      }
      current = await readFile(path.join(worktree, relative), 'utf8');
    } catch (error) {
      throw new Error(`The observed path "${relative}" could not be read: ${messageOf(error)}`, {
        cause: error,
      });
    }
    if (saved.value !== current) {
      return (
        `the observation of "${relative}" at revision ${entry.revision} differs from the ` +
        'content being submitted; commit the inspected content and bind that revision'
      );
    }
  }
  return null;
}

/**
 * Why the observation's own content does not name usable repository content, or null when it does:
 * every entry must be a unique path inside the shared checkout, and the observation must cover
 * every stage-owned prototype path the author declared.
 */
export function observationScopeProblem(settings: {
  readonly worktree: string;
  readonly observation: PrototypeObservation;
  /** The stage-owned prototype paths the observation must cover, as the author declared them. */
  readonly observedPaths: readonly string[];
}): string | null {
  const { worktree, observation } = settings;
  const observed = new Set<string>();
  for (const entry of observation.content) {
    const relative = checkoutRelative(worktree, entry.path);
    if (relative === null) {
      return `the observation names "${entry.path}", which lies outside the shared preparation checkout`;
    }
    if (observed.has(relative)) {
      return `the observation names "${relative}" more than once`;
    }
    observed.add(relative);
  }
  for (const value of settings.observedPaths) {
    const relative = checkoutRelative(worktree, value);
    if (relative === null || !observed.has(relative)) {
      return `the observation does not cover the stage-owned prototype path "${value}"`;
    }
  }
  return null;
}

/**
 * Why one role's observation does not match the evaluated prototype content, or null when it does.
 * Every observed entry must name content this evaluation assessed and carry the same bytes at the
 * observation's revision, and the observation must cover every stage-owned prototype path. A
 * changed prototype therefore cannot reuse an earlier observation.
 */
export async function observationContentProblem(settings: {
  readonly git: GitAdapter;
  readonly worktree: string;
  readonly observation: PrototypeObservation;
  readonly assessed: readonly AssessedContent[];
  /** The stage-owned prototype paths the observation must cover, as the author declared them. */
  readonly observedPaths: readonly string[];
}): Promise<string | null> {
  const { git, worktree, observation } = settings;
  const scope = observationScopeProblem(settings);
  if (scope !== null) {
    return scope;
  }
  const assessedByPath = new Map(settings.assessed.map((entry) => [entry.path, entry]));
  for (const entry of observation.content) {
    const relative = checkoutRelative(worktree, entry.path) as string;
    const binding = assessedByPath.get(relative);
    if (binding === undefined) {
      return `the observation names "${relative}", which this evaluation did not assess`;
    }
    if (binding.exists !== entry.exists) {
      return (
        `the observation reports "${relative}" as ` +
        `${entry.exists ? 'present' : 'absent'} while the evaluation assessed it as ` +
        `${binding.exists ? 'present' : 'absent'}`
      );
    }
    const observedContent = await git.readFileAtRevision(worktree, entry.revision, relative);
    const assessedContent = await git.readFileAtRevision(worktree, binding.revision, relative);
    if (!entry.exists) {
      if (observedContent.ok || assessedContent.ok) {
        return `the observation reports "${relative}" as deleted while a named revision retains it`;
      }
      continue;
    }
    if (!observedContent.ok) {
      return (
        `the observation of "${relative}" names revision ${entry.revision}, which does not ` +
        'retain that file'
      );
    }
    if (!assessedContent.ok) {
      return `the evaluated revision ${binding.revision} does not retain "${relative}"`;
    }
    if (observedContent.value !== assessedContent.value) {
      return (
        `the observation of "${relative}" at revision ${entry.revision} differs from the ` +
        `evaluated revision ${binding.revision}; changed prototype content needs fresh observation`
      );
    }
  }
  return null;
}
