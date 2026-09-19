/** The one reporting failure: a log file or report that could not be written. */
/** A log file that could not be created, written, or appended to. */
export class ReportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReportError';
  }
}
