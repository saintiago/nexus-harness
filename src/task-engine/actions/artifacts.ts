import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';
import { messageOf } from '../../result.js';
import { currentRoundFile, currentRoundSchema } from './start-round/artifacts.js';

/**
 * The artifact helpers bound to one workspace. Each call reads state/current-round.json again, so
 * the round is never cached, a missing current input never falls back to an earlier round, and
 * history is read explicitly through readArtifactHistory.
 */

/** One producer's artifact contract: its path within the round directory and its content schema. */
export type ArtifactDeclaration<Schema extends z.ZodType = z.ZodType> = {
  readonly pathFromArtifactsRoot: string;
  readonly schema: Schema;
};

/** The declared content of one artifact declaration. */
export type ArtifactContent<Declaration extends ArtifactDeclaration> = z.output<
  Declaration['schema']
>;

/** One earlier round's value of an artifact. */
export type ArtifactHistoryValue<Value> = {
  readonly number: number;
  readonly value: Value;
};

/** The artifact helpers bound to the current workspace. */
export type ArtifactHelpers = {
  /** The declared contents of the current round's artifacts, in argument order. */
  readInputArtifacts<Declarations extends readonly ArtifactDeclaration[]>(
    ...declarations: Declarations
  ): Promise<{ -readonly [Key in keyof Declarations]: ArtifactContent<Declarations[Key]> }>;
  /**
   * The declared contents of the current round's optional artifacts, in argument order. An absent
   * artifact is null; an unreadable existing artifact is an error.
   */
  readOptionalInputArtifacts<Declarations extends readonly ArtifactDeclaration[]>(
    ...declarations: Declarations
  ): Promise<{
    -readonly [Key in keyof Declarations]: ArtifactContent<Declarations[Key]> | null;
  }>;
  /** Write content to the current round at the declaration's path. */
  writeOutputArtifact<Declaration extends ArtifactDeclaration>(
    declaration: Declaration,
    content: ArtifactContent<Declaration>,
  ): Promise<void>;
  /** The earlier rounds that produced the declared artifact, in round order. */
  readArtifactHistory<Declaration extends ArtifactDeclaration>(
    declaration: Declaration,
  ): Promise<ArtifactHistoryValue<ArtifactContent<Declaration>>[]>;
};

/** The round directories' name under the workspace root. */
const artifactsDirectory = 'artifacts';

/** Create the artifact helpers over the workspace whose rounds they resolve. */
export function createArtifactHelpers(workspace: { readonly root: string }): ArtifactHelpers {
  const artifactFile = (round: number, pathFromArtifactsRoot: string): string =>
    path.join(workspace.root, artifactsDirectory, String(round), pathFromArtifactsRoot);

  /** The current round number, read from the workspace on every call. */
  async function currentRoundNumber(): Promise<number> {
    const file = path.join(workspace.root, currentRoundFile);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      const message =
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? `Current round at "${file}" does not exist.`
          : `Current round at "${file}" could not be read: ${messageOf(error)}`;
      throw new Error(message, { cause: error });
    }

    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(`Current round at "${file}" is not valid JSON: ${messageOf(error)}`, {
        cause: error,
      });
    }

    const record = currentRoundSchema.safeParse(value);
    if (!record.success) {
      throw new Error(`Current round at "${file}" is not a current-round record.`, {
        cause: record.error,
      });
    }
    return record.data.number;
  }

  /** Read one artifact document, or null when that round produced no file at that path. */
  async function readArtifactText(file: string): Promise<string | null> {
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw new Error(`Artifact at "${file}" could not be read: ${messageOf(error)}`, {
        cause: error,
      });
    }
  }

  /** Validate one stored artifact document against its declaration. */
  function parseArtifact<Declaration extends ArtifactDeclaration>(
    file: string,
    declaration: Declaration,
    text: string,
  ): ArtifactContent<Declaration> {
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(`Artifact at "${file}" is not valid JSON: ${messageOf(error)}`, {
        cause: error,
      });
    }

    const content = declaration.schema.safeParse(value);
    if (!content.success) {
      const issues = content.error.issues
        .map((issue) => {
          const location = issue.path.length > 0 ? issue.path.join('.') : '<artifact>';
          return `${location}: ${issue.message}`;
        })
        .join('; ');
      throw new Error(`Artifact at "${file}" does not match its declared content type: ${issues}`, {
        cause: content.error,
      });
    }
    // safeParse erases the generic schema's output type.
    return content.data as ArtifactContent<Declaration>;
  }

  async function readInputArtifacts<Declarations extends readonly ArtifactDeclaration[]>(
    ...declarations: Declarations
  ): Promise<{ -readonly [Key in keyof Declarations]: ArtifactContent<Declarations[Key]> }> {
    const round = await currentRoundNumber();
    const contents: unknown[] = [];
    for (const declaration of declarations) {
      const file = artifactFile(round, declaration.pathFromArtifactsRoot);
      const text = await readArtifactText(file);
      if (text === null) {
        throw new Error(`Required artifact at "${file}" does not exist.`);
      }
      contents.push(parseArtifact(file, declaration, text));
    }
    return contents as {
      -readonly [Key in keyof Declarations]: ArtifactContent<Declarations[Key]>;
    };
  }

  async function readOptionalInputArtifacts<Declarations extends readonly ArtifactDeclaration[]>(
    ...declarations: Declarations
  ): Promise<{
    -readonly [Key in keyof Declarations]: ArtifactContent<Declarations[Key]> | null;
  }> {
    const round = await currentRoundNumber();
    const contents: unknown[] = [];
    for (const declaration of declarations) {
      const file = artifactFile(round, declaration.pathFromArtifactsRoot);
      const text = await readArtifactText(file);
      contents.push(text === null ? null : parseArtifact(file, declaration, text));
    }
    return contents as {
      -readonly [Key in keyof Declarations]: ArtifactContent<Declarations[Key]> | null;
    };
  }

  async function writeOutputArtifact<Declaration extends ArtifactDeclaration>(
    declaration: Declaration,
    content: ArtifactContent<Declaration>,
  ): Promise<void> {
    const round = await currentRoundNumber();
    const file = artifactFile(round, declaration.pathFromArtifactsRoot);
    try {
      await writeFile(file, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
    } catch (error) {
      throw new Error(`Artifact at "${file}" could not be written: ${messageOf(error)}`, {
        cause: error,
      });
    }
  }

  async function readArtifactHistory<Declaration extends ArtifactDeclaration>(
    declaration: Declaration,
  ): Promise<ArtifactHistoryValue<ArtifactContent<Declaration>>[]> {
    const round = await currentRoundNumber();
    const history: ArtifactHistoryValue<ArtifactContent<Declaration>>[] = [];
    for (let number = 1; number < round; number += 1) {
      const file = artifactFile(number, declaration.pathFromArtifactsRoot);
      const text = await readArtifactText(file);
      if (text === null) {
        continue;
      }
      history.push({ number, value: parseArtifact(file, declaration, text) });
    }
    return history;
  }

  return {
    readInputArtifacts,
    readOptionalInputArtifacts,
    writeOutputArtifact,
    readArtifactHistory,
  };
}
