/** A source repository or output location that cannot be used for a run. */
/** A source repository or output location that cannot be used for a run. */
export class WorkspaceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WorkspaceError';
  }
}
