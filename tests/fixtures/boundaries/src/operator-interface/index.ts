// Bypassing the public module for AgentRuntime internals must be reported.
import { providerInvocation } from '../agent-runtime/private.js';
import { createTaskEngine } from '../task-engine/index.js';

export const operatorInterface = { createTaskEngine, providerInvocation };
