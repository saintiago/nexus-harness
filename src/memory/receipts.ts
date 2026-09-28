import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { messageOf } from '../result.js';
import { createJsonFileExclusive, readJsonFile, writeJsonFile } from './files.js';
import { jsonObjectSchema } from './json.js';

/**
 * Ingestion receipts and writer coordination of one collection. A receipt is the immutable source
 * observation plus the state of its insertion: pending, in-flight, stored or uncertain. Receipts
 * live outside issue workspaces, so recovery cleanup cannot erase them, and a repeated observation
 * of the same source key reads the existing receipt instead of replacing its snapshot. A receipt
 * left in flight or uncertain is itself the collection's unresolved insertion: it defers every
 * other source's write until the operator reconciles it, so no separate deferral record must be
 * written, kept in step or recovered after a crash.
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

/** One insertion of a collection that still has to be reconciled before another write. */
export type UnresolvedWrite = {
  readonly sourceKey: string;
  /** The receipt carrying the unresolved state; the operator reconciles it. */
  readonly receipt: string;
  readonly state: 'in-flight' | 'uncertain';
  readonly reason: string;
};

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
   * The collection's unresolved insertion — a receipt left in flight or uncertain — or null.
   * Further writes stay deferred until the operator reconciles that receipt; reads remain
   * available.
   */
  readUnresolved(): Promise<UnresolvedWrite | null>;
};

/** The receipt file of one source key; the key itself may hold characters a filename cannot. */
function receiptFile(directory: string, sourceKey: string): string {
  const digest = createHash('sha256').update(sourceKey, 'utf8').digest('hex');
  return path.join(directory, 'receipts', `${digest}.json`);
}

/** Why an unresolved receipt defers another source's insertion, when it recorded no reason. */
function unresolvedReason(state: 'in-flight' | 'uncertain'): string {
  return state === 'in-flight'
    ? 'an insertion was interrupted while in flight and its outcome is uncertain'
    : 'a previous attempt left an uncertain outcome';
}

/** Create the receipt store over one configured store identity and storage root. */
export function createReceiptStore(settings: {
  readonly root: string;
  readonly storeId: string;
}): ReceiptStore {
  const directory = path.join(settings.root, 'memory', settings.storeId);
  const bindingFile = path.join(directory, 'binding.json');
  const receiptsDirectory = path.join(directory, 'receipts');

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
      // Creating the binding atomically keeps two initializers from each observing no binding and
      // then overwriting one another: exactly one creates it, and every other call validates
      // that same document before any provider write.
      await createJsonFileExclusive(bindingFile, {
        storeId: settings.storeId,
        url: binding.url,
        collection: binding.collection,
      });
      const existing = await readJsonFile(bindingFile);
      if (existing === null) {
        throw new Error(
          `The memory store identity "${settings.storeId}" has no readable binding at ` +
            `"${bindingFile}".`,
        );
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
      if (await createJsonFileExclusive(file, receipt)) {
        return receipt;
      }
      const existing = await read(receipt.sourceKey);
      if (existing === null) {
        throw new Error(`Memory could not read the receipt at "${file}" it found present.`);
      }
      return existing;
    },

    async write(receipt) {
      await writeJsonFile(receiptFile(directory, receipt.sourceKey), receipt);
    },

    /**
     * The collection's unresolved insertion, read from the receipts themselves. A live writer
     * cannot be observed here: the writer lock is held from receipt inspection through receipt
     * persistence, so an in-flight or uncertain receipt found while holding it belongs to an
     * interrupted operation.
     */
    async readUnresolved() {
      let entries: string[];
      try {
        entries = await readdir(receiptsDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return null;
        }
        throw new Error(
          `Memory could not read the receipts of "${directory}": ${messageOf(error)}`,
          { cause: error },
        );
      }
      for (const entry of entries.sort()) {
        if (!entry.endsWith('.json')) {
          continue;
        }
        const file = path.join(receiptsDirectory, entry);
        const value = await readJsonFile(file);
        if (value === null) {
          continue;
        }
        const parsed = receiptSchema.safeParse(value);
        if (!parsed.success) {
          throw new Error(`Memory found an unreadable receipt at "${file}".`, {
            cause: parsed.error,
          });
        }
        if (parsed.data.state === 'in-flight' || parsed.data.state === 'uncertain') {
          return {
            sourceKey: parsed.data.sourceKey,
            receipt: file,
            state: parsed.data.state,
            reason: parsed.data.reason ?? unresolvedReason(parsed.data.state),
          };
        }
      }
      return null;
    },
  };
}
