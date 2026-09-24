/**
 * The shared interface vocabulary from the high-level architecture and the
 * helpers that build it. Boundary failures return a fault with a useful message
 * that excludes secrets.
 */

/** One boundary failure's message. */
export type Fault = {
  readonly message: string;
};

/** A persisted artifact's location. Content format belongs to the artifact's owning contract. */
export type ArtifactRef = {
  readonly path: string;
};

/** One observer of a stream of values. */
export type Observer<Value> = (value: Value) => void;

/** An operation's outcome: the value it observed, or the fault that explains failure. */
export type Result<Value> =
  { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly fault: Fault };

/** An operation's successful outcome. */
export function ok<Value>(value: Value): Result<Value> {
  return { ok: true, value };
}

/** An operation's failed outcome, carrying the fault that explains it. */
export function fault(message: string): Result<never> {
  return { ok: false, fault: { message } };
}

/** Render a thrown value as a fault message. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
