import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Test support for the prototype observation contract: tests that handcraft an accepted prototype
 * round still save the evidence the real roles produce — one observation record per role and a
 * readable rendered screenshot under the round artifact area.
 */

/** A one-pixel PNG, the smallest screenshot the rendered-image validation accepts. */
const screenshotBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** One inspected prototype path and the revision it was observed at. */
export type ObservedPrototypePath = {
  readonly path: string;
  readonly revision: string;
  readonly exists?: boolean;
};

/**
 * Save one role's observation record and its screenshot under the round artifact area, returning
 * the record's path as a report declares it.
 */
export async function savePrototypeObservation(settings: {
  readonly roundDirectory: string;
  readonly role: 'author' | 'evaluator';
  /** The record's file name, for a test that keeps several records of the same role apart. */
  readonly name?: string;
  readonly content: readonly ObservedPrototypePath[];
}): Promise<string> {
  const directory = path.join(settings.roundDirectory, 'observations');
  const name = settings.name ?? settings.role;
  await mkdir(directory, { recursive: true });
  const screenshot = path.join(directory, `${name}-journey.png`);
  await writeFile(screenshot, screenshotBytes);
  const record = path.join(directory, `${name}.json`);
  await writeFile(
    record,
    JSON.stringify({
      role: settings.role,
      content: settings.content.map((entry) => ({
        path: entry.path,
        revision: entry.revision,
        exists: entry.exists ?? true,
      })),
      preview: { command: 'npm run storybook', url: 'http://localhost:6100' },
      journeys: [
        {
          example: 'The state-changing journey',
          state: 'the changed state',
          actions: ['opened the story', 'performed the state-changing interaction'],
          observed: 'The journey rendered and changed state as it should.',
          screenshots: [{ path: screenshot }],
          visualConclusion: 'The screenshot shows the rendered state and layout.',
        },
      ],
    }),
  );
  return record;
}
