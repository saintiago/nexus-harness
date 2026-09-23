import path from 'node:path';
import type { CodingRuntime } from '../adapters/coding-runtime.js';
import type { Result } from '../result.js';

/**
 * AgentRuntime resolves the caller-selected profile, assembles one prompt from the supplied
 * instructions, context and workspace, and runs one coding-provider invocation through the
 * coding runtime adapter. It keeps no storage and adds no turns of its own.
 */

/** The profile identity the caller selects. */
export type ProfileId = string;

/** A configured profile: model, effort, its instructions and its native tool configuration. */
export type AgentProfile = {
  readonly id: ProfileId;
  readonly model: string;
  readonly effort: string | null;
  readonly instructions: readonly string[];
  readonly toolSettings: Readonly<Record<string, unknown>>;
};

/** One activity entry the invocation reported while it ran. */
export type AgentEvent = {
  readonly type: 'message' | 'command' | 'result' | 'change';
  readonly text: string;
};

/** The invocation's final output. */
export type AgentResult = Result<{ readonly output: string }>;

/** The workspace reference from the Workspace design: one workspace root directory. */
type WorkspaceRef = { readonly root: string };

/** The runtime capability: one invocation of the selected profile with the supplied context. */
export type AgentRuntime = {
  run(
    profile: ProfileId,
    workspaceRef: WorkspaceRef,
    additionalContext: string,
  ): Promise<AgentResult>;
};

/** Construction settings: caller instructions, the profile catalogue, provider, limit and observer. */
export type AgentRuntimeSettings = {
  readonly codingRuntime: CodingRuntime;
  readonly baseInstructions: readonly string[];
  readonly profiles: readonly AgentProfile[];
  readonly invocationLimitMinutes: number;
  readonly onActivity: (activity: AgentEvent) => void;
};

/** The target repository working copy within a workspace root (Workspace design). */
const worktreeDirectory = 'worktree';

/**
 * The complete prompt for one invocation: runtime base instructions, the selected profile's
 * instructions, the caller-supplied context as given and the workspace location. The caller's
 * context is passed through whole.
 */
function assemblePrompt(
  baseInstructions: readonly string[],
  profileInstructions: readonly string[],
  additionalContext: string,
  worktree: string,
): string {
  return [
    ...baseInstructions,
    ...profileInstructions,
    additionalContext,
    `Workspace: ${worktree}`,
  ].join('\n\n');
}

/** Create the agent runtime over the supplied configuration. */
export function createAgentRuntime(settings: AgentRuntimeSettings): AgentRuntime {
  return {
    async run(profileId, workspaceRef, additionalContext) {
      const profile = settings.profiles.find((candidate) => candidate.id === profileId);
      if (profile === undefined) {
        return { ok: false, fault: { message: `Unknown agent profile "${profileId}".` } };
      }
      const worktree = path.join(workspaceRef.root, worktreeDirectory);
      return settings.codingRuntime.execute(
        {
          prompt: assemblePrompt(
            settings.baseInstructions,
            profile.instructions,
            additionalContext,
            worktree,
          ),
          model: profile.model,
          effort: profile.effort,
          toolSettings: profile.toolSettings,
          directory: worktree,
          timeLimitMs: settings.invocationLimitMinutes * 60_000,
        },
        (activity) => {
          try {
            settings.onActivity(activity);
          } catch {
            // Observer failures do not affect the invocation or its result.
          }
        },
      );
    },
  };
}

export {
  developmentRoleInstructions,
  recoveryRoleInstructions,
  reviewerRoleInstructions,
} from './roles.js';
