/**
 * Where one ticket's conversation history lives: beside the retained workspace
 * it belongs to, so an agent that can read the workspace can read the history
 * with the same ordinary tools and without any connector call.
 */
import path from 'node:path';
import { workspacePathFor } from '../workspace/run-directory.js';

/**
 * `<workDir>/workspaces/<workspaceId>.history`: the history root of one
 * workspace. The workspace id is validated the same way the clone's own path
 * is, so a pointer label can never name a history directory somewhere else.
 */
export function workspaceHistoryRoot(workDir: string, workspaceId: string): string {
  return `${workspacePathFor(workDir, workspaceId)}.history`;
}

/** `<root>/reports`: where complete developer and reviewer reports are kept. */
export function historyReportsDir(root: string): string {
  return path.join(root, 'reports');
}

/** `<root>/snapshots`: the immutable snapshots themselves. */
export function historySnapshotsDir(root: string): string {
  return path.join(root, 'snapshots');
}

/** `<root>/current.json`: the pointer a new turn starts from. */
export function historyCurrentPath(root: string): string {
  return path.join(root, 'current.json');
}
