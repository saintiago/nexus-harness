/**
 * The narrow readers every Jira answer goes through: an answer this connector
 * does not recognise is refused by name, never guessed at.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringField(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];
  return typeof value === 'string' ? value : null;
}

export function nested(
  source: Record<string, unknown>,
  field: string,
): Record<string, unknown> | null {
  const value = source[field];
  return isRecord(value) ? value : null;
}
