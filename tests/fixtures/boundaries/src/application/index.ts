import { createGit } from '../adapters/git.js';
import { createAgentRuntime } from '../agent-runtime/index.js';
import type { Activity } from '../operator-interface/activity.js';
import { operatorInterface } from '../operator-interface/index.js';
import { develop } from '../task-engine/actions/develop/index.js';
import { createTaskEngine } from '../task-engine/index.js';

// Application wiring assembles TaskEngine, AgentRuntime, OperatorInterface and adapters.
export const wired = {
  createTaskEngine,
  createAgentRuntime,
  operatorInterface,
  develop,
  createGit,
};

export type WiredActivity = Activity;
