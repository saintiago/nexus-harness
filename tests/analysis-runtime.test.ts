/**
 * Focused integration test: Application's parent-side experience-analysis runtime drives the real
 * coding-provider adapter with a controlled provider process, establishing the configured analysis
 * profile, the search-only AMEM server, the memory-analysis guidance, the action's response schema,
 * the invocation boundaries and the retained-worktree working directory. No live provider or
 * memory service is involved.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryAnalysisGuidance, type AgentEvent } from '../src/agent-runtime/index.js';
import { createAnalysisRuntime } from '../src/application/analysis-runtime.js';
import { parseNexusConfiguration } from '../src/configuration/index.js';
import { experienceAnalysisResponseSchema } from '../src/task-engine/actions/analyze-experience/artifacts.js';
import type { EngineEvent } from '../src/task-engine/index.js';
import { nexusConfiguration } from './support/configuration.js';
import { strictSchemaProblems } from './support/provider-schema.js';

const installationDirectory = '/srv/nexus/installation';
const analysisProfile = 'nexus-astra';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-analysis-runtime-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** What the controlled provider process recorded about its own invocation. */
type RecordedInvocation = {
  readonly args: readonly string[];
  readonly directory: string;
  readonly prompt: string;
  readonly schemaPath: string | null;
  readonly schema: string | null;
};

/** Install the controlled provider and the native profile file the adapter requires. */
async function providerFixture(agentOutput: string): Promise<{
  readonly executable: string;
  readonly environment: Record<string, string>;
  invocation(): Promise<RecordedInvocation>;
}> {
  const directory = await temporaryDirectory();
  const executable = path.join(directory, 'codex-fixture');
  const outputPath = path.join(directory, 'agent-output.txt');
  const recordPath = path.join(directory, 'invocation.json');
  await writeFile(outputPath, agentOutput);
  await writeFile(
    executable,
    `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
// Enforce the real provider's working-directory prerequisite before accepting the invocation.
execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd() });
const prompt = readFileSync(0, 'utf8');
const schemaFlag = process.argv.indexOf('--output-schema');
const schemaPath = schemaFlag === -1 ? null : (process.argv[schemaFlag + 1] ?? null);
writeFileSync(
  process.env.NEXUS_FIXTURE_RECORD,
  JSON.stringify({
    args: process.argv.slice(2),
    directory: process.cwd(),
    prompt,
    schemaPath,
    schema: schemaPath === null ? null : readFileSync(schemaPath, 'utf8'),
  }),
);
const output = readFileSync(process.env.NEXUS_FIXTURE_OUTPUT, 'utf8');
process.stdout.write(
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: output } }) + '\\n',
);
process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');
`,
  );
  await chmod(executable, 0o755);
  const codexHome = path.join(directory, 'codex-home');
  await mkdir(codexHome);
  await writeFile(path.join(codexHome, `${analysisProfile}.config.toml`), '# analysis profile\n');
  return {
    executable,
    environment: {
      CODEX_HOME: codexHome,
      NEXUS_FIXTURE_RECORD: recordPath,
      NEXUS_FIXTURE_OUTPUT: outputPath,
      PATH: '/usr/bin:/bin',
      HOME: directory,
      DEEPSEEK_API_KEY: 'controlled-provider-key',
    },
    async invocation() {
      return JSON.parse(await readFile(recordPath, 'utf8')) as RecordedInvocation;
    },
  };
}

describe('analysis runtime', () => {
  it('runs the configured analysis profile with search-only memory tools and the response schema', async () => {
    const agentOutput = JSON.stringify({ observations: [] });
    const fixture = await providerFixture(agentOutput);
    const nexus = nexusConfiguration();
    nexus.agentRuntime.provider.executable = fixture.executable;
    nexus.memory = {
      enabled: true,
      serviceUrl: 'http://127.0.0.1:4748',
      mcp: { command: 'npm', args: ['run', '--silent', 'mcp'], directory: './agentic-memory' },
      analysisProfile,
    };
    const configuration = parseNexusConfiguration(nexus, installationDirectory);
    const workspace = { root: await temporaryDirectory() };
    const activities: AgentEvent[] = [];
    const events: EngineEvent[] = [];

    const analyze = createAnalysisRuntime({
      nexus: configuration,
      environment: fixture.environment,
      publish: (event) => events.push(event),
      publishActivity: () => undefined,
      activityDirectory: path.join(workspace.root, 'agents'),
    });
    const result = await analyze({
      context: 'Nexus terminal experience analysis\n\nWork item NEX-1 completed.',
      workspace,
      outputSchema: z.toJSONSchema(experienceAnalysisResponseSchema),
      onActivity: (activity) => activities.push(activity),
    });

    expect(result).toEqual({ ok: true, value: { output: agentOutput } });
    expect(activities).toEqual([{ type: 'message', text: agentOutput }]);
    // The invocation announces its own boundaries with its own activity-log reference.
    expect(events.map((event) => event.type)).toEqual(['agent-started', 'agent-finished']);
    expect(events[0]?.data).toMatchObject({ agentName: 'analysis', profile: analysisProfile });
    const invocation = await fixture.invocation();
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        '--profile',
        analysisProfile,
        '--model',
        'gpt-6-astra',
        'mcp_servers.amem.command="npm"',
        'mcp_servers.amem.args=["run", "--silent", "mcp"]',
        `mcp_servers.amem.cwd=${JSON.stringify(
          path.join(installationDirectory, 'agentic-memory'),
        )}`,
        'mcp_servers.amem.env={ AMEM_MCP_SERVICE_URL = "http://127.0.0.1:4748" }',
        'mcp_servers.amem.enabled=true',
        // The analyst searches shared memory but never saves directly: Nexus submits the output.
        'mcp_servers.amem.enabled_tools=["memory_search"]',
      ]),
    );
    // The action's response schema reaches the provider's structured-output capability.
    expect(invocation.schema).toBe(
      `${JSON.stringify(z.toJSONSchema(experienceAnalysisResponseSchema), null, 2)}\n`,
    );
    expect(strictSchemaProblems(JSON.parse(invocation.schema ?? '{}'))).toEqual([]);
    await expect(stat(invocation.schemaPath ?? '')).rejects.toThrow(/ENOENT/);
    expect(invocation.directory).toBe(path.join(workspace.root, 'worktree'));
    // The prompt carries the constant memory-analysis guidance and the complete supplied context.
    expect(invocation.prompt).toContain(memoryAnalysisGuidance);
    expect(invocation.prompt).toContain('Nexus terminal experience analysis');
  });
});
