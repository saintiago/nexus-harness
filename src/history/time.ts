/** Compare instants without changing the source's timestamp spelling. Unknown
 * legacy times tie conservatively; synchronization reports them as gaps. */
export function compareHistoryTime(left: string, right: string): number {
  const difference = Date.parse(left) - Date.parse(right);
  return Number.isNaN(difference) ? 0 : difference;
}
