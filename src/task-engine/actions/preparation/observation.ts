import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { messageOf } from '../../../result.js';
import { describeIssues, parseDocument, readDocumentText } from '../documents.js';
import type { RetainedStageAuthorOutput, RetainedStageEvaluationOutput } from './artifacts.js';
import { renderedImageProblem } from './rendered-image.js';

/**
 * The prototype roles' observation contract: one producer-owned record each role saves under its
 * round artifact area and references from its report. The record keeps each role's browser
 * assessment and rendered-image evidence readable; Nexus observes task, role/profile, revision and
 * report attribution separately. An image path or a claimed successful build alone is never
 * sufficient evidence.
 */

/** One saved prototype observation record, as both prototype roles declare it. */
export const prototypeObservationSchema = z.strictObject({
  /** Which prototype role performed the observation; it must match the declaring report. */
  role: z
    .enum(['author', 'evaluator'])
    .describe('The role that performed the observation; it must match the declaring report.'),
  /** The preview the role actually used: the exact start command and the URL it reached. */
  preview: z
    .strictObject({
      command: z.string().trim().min(1).describe('The exact preview start command used.'),
      url: z.string().trim().min(1).describe('The URL the preview reached.'),
    })
    .describe('The preview the role actually used.'),
  /** One exercised journey or state with its actions, result and rendered-image evidence. */
  journeys: z
    .array(
      z.strictObject({
        example: z.string().trim().min(1).describe('The acceptance example or journey exercised.'),
        state: z.string().trim().min(1).describe('The state the prototype was in.'),
        actions: z
          .array(z.string().trim().min(1))
          .min(1)
          .describe('The actions the role performed, in order.'),
        observed: z.string().trim().min(1).describe('What the prototype did in response.'),
        screenshots: z
          .array(
            z.strictObject({
              path: z
                .string()
                .trim()
                .min(1)
                .describe('The saved rendered image under the round artifact area.'),
            }),
          )
          .min(1)
          .describe('The rendered-image evidence a reader can open, saved under the round area.'),
        visualConclusion: z.string().trim().min(1).describe('What the rendered images show.'),
      }),
    )
    .min(1)
    .describe('The journeys or states actually exercised and observed.'),
});

export type PrototypeObservation = z.infer<typeof prototypeObservationSchema>;

/**
 * The retained observation reader: a former record's per-file `content` stays readable as opaque
 * historical data in its recorded position, whether it is present, absent or no longer valid under
 * its removed schema. Retained readers validate the remaining fields without supplying an empty
 * inventory, coercing old entries or rewriting saved files.
 */
const retainedPrototypeObservationSchema = z.strictObject({
  role: prototypeObservationSchema.shape.role,
  content: z.unknown().optional(),
  preview: prototypeObservationSchema.shape.preview,
  journeys: prototypeObservationSchema.shape.journeys,
});

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
    '- Assess the current worktree and running preview against the ticket and acceptance examples;',
    '  the paths you declare only commit your authored work and never bound what you inspect.',
    '- Save your screenshots under the round artifact area; each journey needs rendered-image',
    '  evidence a reader can open, not a build log or an image path alone.',
    '- Record the preview start command and URL you used, and the actions you performed.',
    '- A skip carries no observation. Applicable work you accept needs your own observation; a',
    '  change request or upstream return keeps the observation of the preview you performed, so the',
    '  defect evidence reaches the repair handoff.',
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
  const parsed = parseDocument(text, retainedPrototypeObservationSchema);
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
      const problem = await renderedImageProblem(bytes);
      if (problem !== null) {
        throw new Error(
          `The screenshot "${image}" of journey "${journey.example}" is not readable rendered ` +
            `image evidence: ${problem}.`,
        );
      }
    }
  }
  return { role: observation.role, preview: observation.preview, journeys: observation.journeys };
}

/** One saved prototype observation record a stage result retains: its role and saved path. */
export type RetainedPrototypeObservation = {
  readonly role: PrototypeObservationRole;
  readonly path: string;
};

/** The round artifact directory one absolute retained evidence path lives under, or null. */
function retainedRoundDirectory(artifactsRoot: string, file: string): string | null {
  const relative = path.relative(artifactsRoot, file);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  const [round] = relative.split(path.sep);
  return round === undefined ? null : path.join(artifactsRoot, round);
}

/**
 * Why one retained observation record no longer serves as evidence, or null when it does: the
 * record and its screenshots must remain readable inside the stage's artifact area, state the
 * declaring role and fully decode. A record deleted or edited after the fact invalidates the
 * decision instead of silently authorizing reuse. Former per-file content is never read, compared
 * or rewritten.
 */
export async function retainedObservationProblem(settings: {
  /** The stage's artifacts root; a retained record stays inside one of its round directories. */
  readonly artifactsRoot: string;
  readonly observation: RetainedPrototypeObservation;
}): Promise<string | null> {
  const { observation } = settings;
  const roundDirectory = retainedRoundDirectory(settings.artifactsRoot, observation.path);
  if (roundDirectory === null) {
    return (
      `the retained ${observation.role} observation "${observation.path}" lies outside the ` +
      `stage's artifact area "${settings.artifactsRoot}"`
    );
  }
  try {
    await readPrototypeObservation({
      declared: observation.path,
      roundDirectory,
      role: observation.role,
    });
  } catch (error) {
    return messageOf(error);
  }
  return null;
}

/**
 * Require an applicable prototype acceptance's retained evidence: both roles' observation records
 * must still be present and readable with decodable screenshots. A missing or unusable record
 * cannot keep authorizing resumed acceptance, reuse or downstream decisions.
 *
 * A retained result may omit or empty its saved references: each role's reference is then resolved
 * from its producing outcome for the same authored revision, relative to the producing round's
 * artifact area. A present reference must agree with its producing outcome, and a role whose
 * outcome declares no usable evidence requires normal recovery or reassessment instead of a
 * searched or guessed record.
 */
export async function requireRetainedPrototypeEvidence(settings: {
  readonly artifactsRoot: string;
  /** The producing round's artifact directory, whose role outcomes declare the evidence. */
  readonly roundDirectory: string;
  /** The references the result retained; former results may leave them empty or absent. */
  readonly observations: readonly RetainedPrototypeObservation[];
  readonly author: RetainedStageAuthorOutput;
  readonly evaluation: RetainedStageEvaluationOutput | null;
}): Promise<void> {
  const declared: readonly (readonly [PrototypeObservationRole, string | null])[] = [
    ['author', settings.author.observation?.path ?? null],
    ['evaluator', settings.evaluation?.observation?.path ?? null],
  ];
  const retained = new Map<PrototypeObservationRole, string[]>();
  for (const observation of settings.observations) {
    const paths = retained.get(observation.role) ?? [];
    paths.push(observation.path);
    retained.set(observation.role, paths);
  }
  const evidence: RetainedPrototypeObservation[] = [];
  let missing = false;
  for (const [role, declaredPath] of declared) {
    const produced =
      declaredPath === null ? null : evidenceFilePath(settings.roundDirectory, declaredPath);
    if (declaredPath !== null && produced === null) {
      throw new Error(
        `The retained ${role} prototype observation "${declaredPath}" lies outside its ` +
          `producing round artifact area "${settings.roundDirectory}".`,
      );
    }
    const saved = retained.get(role) ?? [];
    if (saved.length === 0) {
      if (produced === null) {
        missing = true;
        continue;
      }
      evidence.push({ role, path: produced });
      continue;
    }
    const unique = [...new Set(saved.map((file) => path.resolve(file)))];
    if (unique.length > 1 || produced === null || path.resolve(produced) !== unique[0]) {
      throw new Error(
        `The retained ${role} prototype observation does not agree with the producing ${role} ` +
          'outcome; normal recovery or reassessment is required.',
      );
    }
    evidence.push({ role, path: produced });
  }
  if (missing) {
    throw new Error(
      'The retained prototype acceptance is missing one role\u2019s saved observation record.',
    );
  }
  for (const observation of evidence) {
    const problem = await retainedObservationProblem({
      artifactsRoot: settings.artifactsRoot,
      observation,
    });
    if (problem !== null) {
      throw new Error(
        `The retained ${observation.role} prototype observation is unusable: ${problem}.`,
      );
    }
  }
}
