import { messageOf } from '../result.js';
import type { MemoryEngine, MemoryProviders } from './index.js';
import { createMemoryModelTransport } from './transport.js';

/**
 * The default Memory providers: the standalone agentic-memory package's pinned reference encoder
 * and Qdrant note store, its public Memory implementation, and the host model transport. The
 * package is imported when a provider is opened, so a disabled or unused integration loads no
 * library module, and no provider is constructed implicitly.
 */
export const defaultMemoryProviders: MemoryProviders = {
  async openEmbedder(settings) {
    const { openReferenceEmbedder } = await import('agentic-memory');
    return openReferenceEmbedder({
      cacheDir: settings.cacheDir,
      allowDownloads: settings.allowDownloads,
    });
  },

  async openNoteStore(settings) {
    const { openQdrantNoteStore } = await import('agentic-memory');
    return openQdrantNoteStore({
      url: settings.url,
      collection: settings.collection,
      ...(settings.apiKey === undefined ? {} : { apiKey: settings.apiKey }),
      space: settings.space,
      timeoutMs: settings.timeoutMs,
    });
  },

  createLanguageModel(settings) {
    return createMemoryModelTransport(settings);
  },

  async createEngine(settings): Promise<MemoryEngine> {
    const { AgenticMemory, MemoryError } = await import('agentic-memory');
    const memory = new AgenticMemory(settings.store, settings.embedder, settings.model, {
      neighbors: settings.neighbors,
    });
    return {
      async add(input) {
        try {
          const note = await memory.add(input);
          return { kind: 'stored', noteId: note.id };
        } catch (error) {
          if (error instanceof MemoryError) {
            if (error.persistence === 'uncertain') {
              return {
                kind: 'uncertain',
                stage: error.stage,
                reason: error.message,
                noteId: error.noteId ?? null,
                affectedNoteIds: error.affectedNoteIds ?? [],
              };
            }
            return { kind: 'unchanged-failure', stage: error.stage, reason: error.message };
          }
          // The library classifies every write-attempt failure as uncertain, so an unclassified
          // failure is not evidence that stored notes are unchanged. Never report it as success.
          return {
            kind: 'uncertain',
            stage: 'unknown',
            reason:
              'the insertion failed without a classified persistence result: ' + messageOf(error),
            noteId: null,
            affectedNoteIds: [],
          };
        }
      },
      search: (query, options) =>
        memory.search(query, { limit: options.limit, linkedLimit: options.linkedLimit }),
    };
  },
};
