import { z } from 'zod';
import { jsonObjectSchema } from './json.js';

/**
 * The documented AMEM service API this client consumes: the request and response shapes of
 * `/v1/observations`, `/v1/receipts/:id` and `/v1/search`. The schemas mirror the provider's
 * published contract so a response outside it is an explicit protocol failure instead of a
 * partial success, and every request this client sends passes the service's own validation.
 *
 * See docs/memory/architecture.md and the AMEM service API this contract is taken from.
 */

/** One complete attributed note: original content, generated attributes and provenance. */
export const noteSchema = z.strictObject({
  id: z.uuid(),
  content: z.string().refine((value) => /\S/.test(value), 'Content must be nonempty.'),
  timestamp: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }).optional(),
  context: z.string().refine((value) => /\S/.test(value), 'Context must be nonempty.'),
  keywords: z.array(z.string().min(1)),
  tags: z.array(z.string().min(1)),
  links: z.array(z.uuid()),
  metadata: jsonObjectSchema.optional(),
});

export type MemoryNote = z.infer<typeof noteSchema>;

/** One ranked direct match or bounded linked addition, with the note it returned. */
export const searchResultSchema = z.union([
  z.strictObject({ note: noteSchema, via: z.literal('match'), score: z.number() }),
  z.strictObject({ note: noteSchema, via: z.literal('link') }),
]);

export type MemorySearchMatch = z.infer<typeof searchResultSchema>;

/** The query text and public retrieval limits one search request carries. */
export const searchRequestSchema = z.strictObject({
  query: z.string(),
  limit: z.number().int().positive().optional(),
  linkedLimit: z.number().int().nonnegative().optional(),
});

/** The service's complete answer to one search: its time and ordered results. */
export const searchResponseSchema = z.strictObject({
  searchedAt: z.iso.datetime({ offset: true }),
  results: z.array(searchResultSchema),
});

/** One caller-owned observation: its stable source key, content, time and provenance. */
export const observationSchema = z.strictObject({
  sourceKey: z.string().min(1),
  content: z.string().refine((value) => /\S/.test(value), 'Content must be nonempty.'),
  timestamp: z.iso.datetime({ offset: true }).optional(),
  provenance: jsonObjectSchema.optional(),
});

export type MemoryObservation = z.infer<typeof observationSchema>;

/** The receipt statuses: `queued`, `processing` and `retrying` are work still in progress. */
export const receiptStatuses = [
  'queued',
  'processing',
  'retrying',
  'stored',
  'failed',
  'blocked',
] as const;

/**
 * One accepted observation's state. `noteId` appears once the note is stored, because durable
 * acceptance means queued, not searchable.
 */
export const receiptSchema = z.strictObject({
  id: z.uuid(),
  sourceKey: z.string().min(1),
  status: z.enum(receiptStatuses),
  acceptedAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  attemptCount: z.number().int().nonnegative(),
  nextRetryAt: z.iso.datetime({ offset: true }).optional(),
  lastError: z.string().min(1).optional(),
  noteId: z.uuid().optional(),
});

export type MemoryReceipt = z.infer<typeof receiptSchema>;

/** The service's sanitized failure body: its code, message and retryability. */
export const serviceErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
  }),
});

export type ServiceErrorBody = z.infer<typeof serviceErrorSchema>;
