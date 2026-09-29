import { createMemoryServiceClient } from '../memory/index.js';

// AgentRuntime transports explicit MCP settings; it never imports the Memory component.
export const runtimeMemory = createMemoryServiceClient;
