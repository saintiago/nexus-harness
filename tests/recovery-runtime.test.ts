/**
 * Focused integration test: the parent-side recovery runtime drives the real coding-provider
 * adapter with a controlled provider process, establishing the configured recovery profile, the
 * complete context supplied and the environment the recovery agent runs with — the current
 * project's Jira credential, the provider's settings and the operator's CLI configuration, without
 * the Nexus Lens private key or the notification credentials. No live provider, credential or
 * notification service is involved.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/agent-runtime/index.js';
import { recoveryRoleInstructions } from '../src/agent-runtime/index.js';
import { createRecoveryRuntime } from '../src/application/recovery-runtime.js';
import { parseNexusConfiguration } from '../src/configuration/index.js';
import { nexusConfiguration } from './support/configuration.js';

const installationDirectory = '/srv/nexus/installation';

/** The native profile the configured recovery profile selects. */
const recoveryProfile = 'nexus-recovery';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-recovery-runtime-'));
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
  readonly environment: Record<string, string | undefined>;
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
const prompt = readFileSync(0, 'utf8');
writeFileSync(
  process.env.NEXUS_FIXTURE_RECORD,
  JSON.stringify({
    args: process.argv.slice(2),
    directory: process.cwd(),
    prompt,
    environment: process.env,
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
  await writeFile(path.join(codexHome, `${recoveryProfile}.config.toml`), '# recovery profile\n');
  return {
    executable,
    environment: {
      CODEX_HOME: codexHome,
      NEXUS_FIXTURE_RECORD: recordPath,
      NEXUS_FIXTURE_OUTPUT: outputPath,
      PATH: '/usr/bin:/bin',
      HOME: directory,
      JIRA_API_TOKEN: 'controlled-jira-token',
      NEXUS_LENS_PRIVATE_KEY: 'controlled-lens-key',
      AWS_ACCESS_KEY_ID: 'controlled-access-key',
      AWS_SECRET_ACCESS_KEY: 'controlled-secret-key',
      DEEPSEEK_API_KEY: 'controlled-provider-key',
    },
    async invocation() {
      return JSON.parse(await readFile(recordPath, 'utf8')) as RecordedInvocation;
    },
  };
}

describe('recovery runtime', () => {
  it('runs the configured recovery profile with the context and the recovery agent environment', async () => {
    const agentOutput = '{"summary":"Reconciled.","decision":{"kind":"resume"}}';
    const fixture = await providerFixture(agentOutput);
    const nexus = nexusConfiguration();
    nexus.agentRuntime.provider.executable = fixture.executable;
    const configuration = parseNexusConfiguration(nexus, installationDirectory);
    const workspace = { root: await temporaryDirectory() };
    await mkdir(path.join(workspace.root, 'worktree'));
    const activities: AgentEvent[] = [];

    const result = await createRecoveryRuntime({
      nexus: configuration,
      environment: fixture.environment,
    }).invoke({
      context: 'Nexus recovery context\n\nThis is recovery invocation 1 of 1.',
      workspace,
      onActivity: (activity) => activities.push(activity),
    });

    expect(result).toEqual({ ok: true, value: { output: agentOutput } });
    expect(activities).toEqual([{ type: 'message', text: agentOutput }]);
    const invocation = await fixture.invocation();
    expect(invocation.args).toEqual([
      'exec',
      '--json',
      '--profile',
      recoveryProfile,
      '--model',
      'gpt-6-astra',
      '-c',
      'model_reasoning_effort="high"',
      '-',
    ]);
    expect(invocation.directory).toBe(path.join(workspace.root, 'worktree'));
    // The prompt carries the RecoveryRole constant once and the complete supplied context.
    expect(invocation.prompt).toContain(recoveryRoleInstructions[0]);
    expect(invocation.prompt).toContain('Nexus recovery context');
    // The agent runs with the project credential and provider settings, without Lens or SNS keys.
    expect(invocation.environment['JIRA_API_TOKEN']).toBe('controlled-jira-token');
    expect(invocation.environment['DEEPSEEK_API_KEY']).toBe('controlled-provider-key');
    expect(invocation.environment['PATH']).toBe('/usr/bin:/bin');
    expect(invocation.environment['NEXUS_LENS_PRIVATE_KEY']).toBeUndefined();
    expect(invocation.environment['AWS_ACCESS_KEY_ID']).toBeUndefined();
    expect(invocation.environment['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
  });
});
