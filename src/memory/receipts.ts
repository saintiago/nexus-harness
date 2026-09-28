import { createHash } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { messageOf } from '../result.js';
import { readJsonFile, writeJsonFile } from './files.js';
import { jsonObjectSchema } from './json.js';

/**
 * Ingestion receipts and writer coordination of one collection. A receipt is the immutable source
 * observation plus the state of its insertion: pending, in-flight, stored or uncertain. Receipts
 * live outside issue workspaces, so recovery cleanup cannot erase them, and a repeated observation
 * of the same source key reads the existing receipt instead of replacing its snapshot.
 */

export const receiptStates = ['pending', 'in-flight', 'stored', 'uncertain'] as const;

export type ReceiptState = (typeof receiptStates)[number];

/** One source observation and the state of its insertion. */
export const receiptSchema = z.object({
  sourceKey: z.string().min(1),
  content: z.string().min(1),
  timestamp: z.string().min(1),
  provenance: jsonObjectSchema,
  state: z.enum(receiptStates),
  /** The stage of a known failure, when one was recorded. */
  stage: z.string().min(1).optional(),
  /** The safe reason of a failure or uncertainty. */
  reason: z.string().min(1).optional(),
  /** The library note identity once a write is stored or reported it. */
  noteId: z.string().min(1).optional(),
  /** The affected note identities of an uncertain write attempt, when the library supplied them. */
  affectedNoteIds: z.array(z.string()).optional(),
  updatedAt: z.string().min(1),
});

export type Receipt = z.infer<typeof receiptSchema>;

/** The collection binding a storeId must keep: a storeId names one Qdrant endpoint/collection. */
const bindingSchema = z.object({
  storeId: z.string().min(1),
  url: z.string().min(1),
  collection: z.string().min(1),
});

/** The unresolved uncertain insertion that defers further writes of one collection. */
const uncertaintySchema = z.object({
  sourceKey: z.string().min(1),
  receipt: z.string().min(1),
  reason: z.string().min(1),
});

export type CollectionUncertainty = z.infer<typeof uncertaintySchema>;

/** The receipt store and lock files of one configured collection. */
export type ReceiptStore = {
  /** The collection's coordination directory: `<storage root>/memory/<storeId>/`. */
  readonly directory: string;
  /** The file the OS advisory writer lock is taken on. */
  readonly lockFile: string;
  /** Persist and verify the endpoint/collection binding of the store identity. */
  ensureBinding(binding: { readonly url: string; readonly collection: string }): Promise<void>;
  /** Read one observation's receipt, or null when this collection never observed it. */
  read(sourceKey: string): Promise<Receipt | null>;
  /** The receipt file one observation's source key resolves to. */
  fileOf(sourceKey: string): string;
  /** Capture a pending receipt, or return the existing receipt of that source key unchanged. */
  createIfAbsent(receipt: Receipt): Promise<Receipt>;
  /** Replace a receipt's state with a complete document. */
  write(receipt: Receipt): Promise<void>;
  /**
   * The collection's unresolved uncertain insertion, or null. Further writes stay deferred until
   * the operator reconciles it; reads remain available.
   */
  readUncertainty(): Promise<CollectionUncertainty | null>;
  /** Record one uncertain insertion as the collection's unresolved write. */
  recordUncertainty(entry: CollectionUncertainty): Promise<void>;
};

/** The receipt file of one source key; the key itself may hold characters a filename cannot. */
function receiptFile(directory: string, sourceKey: string): string {
  const digest = createHash('sha256').update(sourceKey, 'utf8').digest('hex');
  return path.join(directory, 'receipts', `${digest}.json`);
}

/** True when the error reports an already existing file. */
function isAlreadyPresent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}

/** Create the receipt store over one configured store identity and storage root. */
export function createReceiptStore(settings: {
  readonly root: string;
  readonly storeId: string;
}): ReceiptStore {
  const directory = path.join(settings.root, 'memory', settings.storeId);
  const bindingFile = path.join(directory, 'binding.json');
  const uncertaintyFile = path.join(directory, 'uncertain.json');

  async function read(sourceKey: string): Promise<Receipt | null> {
    const file = receiptFile(directory, sourceKey);
    const value = await readJsonFile(file);
    if (value === null) {
      return null;
    }
    const parsed = receiptSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(`Memory found an unreadable receipt at "${file}".`, {
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  return {
    directory,
    lockFile: path.join(directory, 'writer.lock'),

    async ensureBinding(binding) {
      const existing = await readJsonFile(bindingFile);
      if (existing === null) {
        await writeJsonFile(bindingFile, {
          storeId: settings.storeId,
          url: binding.url,
          collection: binding.collection,
        });
        return;
      }
      const parsed = bindingSchema.safeParse(existing);
      if (!parsed.success) {
        throw new Error(
          `The memory store identity "${settings.storeId}" has no readable binding at ` +
            `"${bindingFile}".`,
          { cause: parsed.error },
        );
      }
      if (parsed.data.url !== binding.url || parsed.data.collection !== binding.collection) {
        throw new Error(
          `The memory store identity "${settings.storeId}" is bound to Qdrant collection ` +
            `"${parsed.data.collection}" at "${parsed.data.url}", not the configured ` +
            `"${binding.collection}" at "${binding.url}".`,
        );
      }
    },

    read,

    fileOf(sourceKey) {
      return receiptFile(directory, sourceKey);
    },

    async createIfAbsent(receipt) {
      const file = receiptFile(directory, receipt.sourceKey);
      await mkdir(path.dirname(file), { recursive: true });
      let handle;
      try {
        handle = await open(file, 'wx');
      } catch (error) {
        if (isAlreadyPresent(error)) {
          const existing = await read(receipt.sourceKey);
          if (existing === null) {
            throw new Error(
              `Memory could not read the receipt at "${file}" it found present: ` +
                `${messageOf(error)}`,
              { cause: error },
            );
          }
          return existing;
        }
        throw new Error(`Memory could not create the receipt at "${file}": ${messageOf(error)}`, {
          cause: error,
        });
      }
      try {
        await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return receipt;
    },

    async write(receipt) {
      await writeJsonFile(receiptFile(directory, receipt.sourceKey), receipt);
    },

    async readUncertainty() {
      const value = await readJsonFile(uncertaintyFile);
      if (value === null) {
        return null;
      }
      const parsed = uncertaintySchema.safeParse(value);
      if (!parsed.success) {
        throw new Error(
          `Memory found an unreadable writer-deferral record at "${uncertaintyFile}".`,
          { cause: parsed.error },
        );
      }
      return parsed.data;
    },

    async recordUncertainty(entry) {
      await writeJsonFile(uncertaintyFile, entry);
    },
  };
}
