/**
 * The shared interface vocabulary from the high-level architecture. Boundary
 * failures return a fault with a useful message that excludes secrets.
 */

/** One boundary failure's message. */
export type Fault = {
  readonly message: string;
};

/** An operation's outcome: the value it observed, or the fault that explains failure. */
export type Result<Value> =
  { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly fault: Fault };
