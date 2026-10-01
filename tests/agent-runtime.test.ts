/**
 * Component tests: AgentRuntime resolves the caller-selected profile, whose instructions are a
 * constant role prompt, and assembles the complete prompt over a supplied coding-provider response.
 * The coding provider is substituted, so no provider process, network access or paid turn is
 * involved.
 */

import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAgentRuntime,
  developmentRoleInstructions,
  recoveryRoleInstructions,
  reviewerRoleInstructions,
  type AgentEvent,
  type AgentProfile,
  type AgentRuntime,
} from '../src/agent-runtime/index.js';
import type {
  CodingRuntime,
  CodingRuntimeActivity,
  CodingRuntimeRequest,
  CodingRuntimeResult,
} from '../src/adapters/coding-runtime.js';

const workspaceRoot = '/srv/nexus/workspaces/NEX-7';
const worktree = path.join(workspaceRoot, 'worktree');
const providerOutput = '{"status":"completed","summary":"changed the parser"}';

/** Caller-prepared invocation text: line breaks and significant spacing must survive assembly. */
const additionalContext = 'Task NEX-7\n\nRun the supplied checks.\n  indented line  ';

/** The catalogue fixture runtimes resolve profiles from, assembled from the role constants. */
const profiles: readonly AgentProfile[] = [
  {
    id: 'nexus-flash',
    model: 'deepseek-flash',
    effort: 'max',
    instructions: developmentRoleInstructions,
    toolSettings: { profile: 'nexus-flash' },
  },
  {
    id: 'nexus-astra',
    model: 'gpt-6-astra',
    effort: null,
    instructions: reviewerRoleInstructions,
    toolSettings: { profile: 'nexus-astra' },
  },
  {
    id: 'nexus-recovery',
    model: 'gpt-6-astra',
    effort: 'high',
    instructions: recoveryRoleInstructions,
    toolSettings: { profile: 'nexus-recovery' },
  },
];

type Harness = {
  readonly runtime: AgentRuntime;
  readonly requests: CodingRuntimeRequest[];
  readonly events: AgentEvent[];
};

/** One runtime over a recording coding provider that replies with the supplied outcome. */
function harness(
  options: {
    readonly result?: CodingRuntimeResult;
    readonly activity?: readonly CodingRuntimeActivity[];
  } = {},
): Harness {
  const requests: CodingRuntimeRequest[] = [];
  const events: AgentEvent[] = [];
  const codingRuntime: CodingRuntime = {
    execute(request, onActivity) {
      requests.push(request);
      for (const activity of options.activity ?? []) {
        onActivity(activity);
      }
      return Promise.resolve(options.result ?? { ok: true, value: { output: providerOutput } });
    },
  };
  const runtime = createAgentRuntime({
    codingRuntime,
    baseInstructions: ['Base instructions for every profile.'],
    profiles,
    invocationLimitMinutes: 45,
  });
  return { runtime, requests, events };
}

/** How often the text contains the part. */
function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

/** One runtime whose provider invocations stay pending until their tests settle them. */
function inactivityHarness(): {
  readonly runtime: AgentRuntime;
  readonly activity: Array<Parameters<CodingRuntime['execute']>[1]>;
  readonly settle: Array<(result: CodingRuntimeResult) => void>;
} {
  const activity: Array<Parameters<CodingRuntime['execute']>[1]> = [];
  const settle: Array<(result: CodingRuntimeResult) => void> = [];
  const codingRuntime: CodingRuntime = {
    execute(_request, onActivity) {
      activity.push(onActivity);
      return new Promise((resolve) => settle.push(resolve));
    },
  };
  return {
    runtime: createAgentRuntime({
      codingRuntime,
      baseInstructions: [],
      profiles,
      invocationLimitMinutes: 45,
    }),
    activity,
    settle,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentRuntime', () => {
  it('runs the selected profile with its model, effort, tool settings, worktree and time limit', async () => {
    const fixture = harness();

    const result = await fixture.runtime.run(
      'nexus-flash',
      { root: workspaceRoot },
      'Task.',
      (activity) => fixture.events.push(activity),
    );

    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toMatchObject({
      model: 'deepseek-flash',
      effort: 'max',
      toolSettings: { profile: 'nexus-flash' },
      directory: worktree,
      timeLimitMs: 45 * 60_000,
    });
    expect(result).toEqual({ ok: true, value: { output: providerOutput } });
  });

  it('uses only the selected profile and passes an absent effort through as null', async () => {
    const fixture = harness();

    await fixture.runtime.run('nexus-astra', { root: workspaceRoot }, 'Review.', (activity) =>
      fixture.events.push(activity),
    );

    const prompt = fixture.requests[0]?.prompt ?? '';
    expect(fixture.requests[0]).toMatchObject({ model: 'gpt-6-astra', effort: null });
    for (const instruction of reviewerRoleInstructions) {
      expect(prompt).toContain(instruction);
    }
    for (const other of profiles.filter((profile) => profile.id !== 'nexus-astra')) {
      for (const instruction of other.instructions) {
        expect(prompt).not.toContain(instruction);
      }
    }
  });

  it('assembles base instructions, the complete role constant, the context and the workspace in order', async () => {
    const fixture = harness();

    await fixture.runtime.run(
      'nexus-flash',
      { root: workspaceRoot },
      additionalContext,
      (activity) => fixture.events.push(activity),
    );

    const prompt = fixture.requests[0]?.prompt ?? '';
    const parts = [
      'Base instructions for every profile.',
      ...developmentRoleInstructions,
      additionalContext,
      worktree,
    ];
    for (const part of parts) {
      expect(prompt).toContain(part);
      expect(occurrences(prompt, part)).toBe(1);
    }
    const positions = parts.map((part) => prompt.indexOf(part));
    expect(positions).toStrictEqual([...positions].sort((left, right) => left - right));
  });

  it('includes every selected role constant once alongside the preserved context', async () => {
    for (const profile of profiles) {
      const fixture = harness();

      await fixture.runtime.run(
        profile.id,
        { root: workspaceRoot },
        additionalContext,
        (activity) => fixture.events.push(activity),
      );

      const prompt = fixture.requests[0]?.prompt ?? '';
      expect(profile.instructions, `${profile.id} has one complete prompt`).toHaveLength(1);
      for (const instruction of profile.instructions) {
        expect(prompt, `${profile.id} role constant`).toContain(instruction);
        expect(occurrences(prompt, instruction), `${profile.id} role constant count`).toBe(1);
      }
      for (const other of profiles) {
        if (other.id === profile.id) {
          continue;
        }
        for (const instruction of other.instructions) {
          expect(prompt, `${profile.id} excluding ${other.id}`).not.toContain(instruction);
        }
      }
      expect(occurrences(prompt, additionalContext), `${profile.id} complete context`).toBe(1);
    }
  });

  it('returns a fault for an unknown profile without invoking the provider', async () => {
    const fixture = harness();

    const result = await fixture.runtime.run(
      'nexus-missing',
      { root: workspaceRoot },
      'Task.',
      (activity) => fixture.events.push(activity),
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.fault.message).toContain('nexus-missing');
    expect(fixture.requests).toHaveLength(0);
  });

  it("transports the caller's output schema unchanged and omits it for plain-text calls", async () => {
    const fixture = harness();
    const outputSchema = {
      type: 'object',
      properties: { status: { type: 'string' } },
      required: ['status'],
    };

    await fixture.runtime.run(
      'nexus-flash',
      { root: workspaceRoot },
      'Task.',
      (activity) => fixture.events.push(activity),
      outputSchema,
    );
    await fixture.runtime.run('nexus-flash', { root: workspaceRoot }, 'Task.', (activity) =>
      fixture.events.push(activity),
    );

    expect(fixture.requests).toHaveLength(2);
    // The schema reaches the provider capability as the caller supplied it, not rewritten here.
    expect(fixture.requests[0]?.outputSchema).toBe(outputSchema);
    // A call that requires plain text supplies no schema and no empty placeholder.
    expect(fixture.requests[1]).not.toHaveProperty('outputSchema');
  });

  it('returns the provider fault when the invocation fails', async () => {
    const fixture = harness({
      result: { ok: false, fault: { message: 'The Codex provider reported a failed turn.' } },
    });

    const result = await fixture.runtime.run(
      'nexus-flash',
      { root: workspaceRoot },
      'Task.',
      (activity) => fixture.events.push(activity),
    );

    expect(result).toEqual({
      ok: false,
      fault: { message: 'The Codex provider reported a failed turn.' },
    });
  });

  it("streams provider activity to the invocation's own observer", async () => {
    const activity: readonly CodingRuntimeActivity[] = [
      { type: 'message', text: 'Working on the parser.' },
      { type: 'command', text: 'npm ci' },
      { type: 'result', text: 'exit 0' },
      { type: 'change', text: 'update src/parser.ts' },
    ];
    const fixture = harness({ activity });

    await fixture.runtime.run('nexus-flash', { root: workspaceRoot }, 'Task.', (activity) =>
      fixture.events.push(activity),
    );

    expect(fixture.events).toEqual(activity);
  });

  it('completes the invocation when the observer fails', async () => {
    const fixture = harness({
      activity: [{ type: 'message', text: 'First entry.' }],
    });

    const result = await fixture.runtime.run(
      'nexus-flash',
      { root: workspaceRoot },
      'Task.',
      () => {
        throw new Error('observer failed');
      },
    );

    expect(result).toEqual({ ok: true, value: { output: providerOutput } });
  });

  it('warns once per idle interval and reports provider activity resuming', async () => {
    vi.useFakeTimers();
    const fixture = inactivityHarness();
    const events: AgentEvent[] = [];
    const invocation = fixture.runtime.run(
      'nexus-flash',
      { root: workspaceRoot },
      'Task.',
      (event) => events.push(event),
    );

    vi.advanceTimersByTime(119_999);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual([
      {
        type: 'diagnostic',
        text: 'No agent activity for 2 minutes; the invocation is still running.',
      },
    ]);

    vi.advanceTimersByTime(4 * 60_000);
    expect(events).toHaveLength(1);
    fixture.activity[0]?.({ type: 'message', text: 'Work continues.' });
    expect(events.slice(1)).toEqual([
      { type: 'diagnostic', text: 'Agent activity resumed.' },
      { type: 'message', text: 'Work continues.' },
    ]);

    vi.advanceTimersByTime(2 * 60_000);
    expect(events.at(-1)).toEqual({
      type: 'diagnostic',
      text: 'No agent activity for 2 minutes; the invocation is still running.',
    });
    fixture.settle[0]?.({ ok: true, value: { output: providerOutput } });
    await invocation;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('observes concurrent invocations independently', async () => {
    vi.useFakeTimers();
    const fixture = inactivityHarness();
    const first: AgentEvent[] = [];
    const second: AgentEvent[] = [];
    const invocations = [
      fixture.runtime.run('nexus-flash', { root: workspaceRoot }, 'First.', (event) =>
        first.push(event),
      ),
      fixture.runtime.run('nexus-astra', { root: workspaceRoot }, 'Second.', (event) =>
        second.push(event),
      ),
    ];

    vi.advanceTimersByTime(60_000);
    fixture.activity[0]?.({ type: 'command', text: 'npm test' });
    vi.advanceTimersByTime(60_000);
    expect(first).toEqual([{ type: 'command', text: 'npm test' }]);
    expect(second).toEqual([
      {
        type: 'diagnostic',
        text: 'No agent activity for 2 minutes; the invocation is still running.',
      },
    ]);

    vi.advanceTimersByTime(60_000);
    expect(first.at(-1)).toEqual({
      type: 'diagnostic',
      text: 'No agent activity for 2 minutes; the invocation is still running.',
    });
    fixture.settle[0]?.({ ok: true, value: { output: providerOutput } });
    fixture.settle[1]?.({ ok: true, value: { output: providerOutput } });
    await Promise.all(invocations);
  });

  it.each([
    { label: 'completion', result: { ok: true, value: { output: providerOutput } } as const },
    {
      label: 'failure',
      result: { ok: false, fault: { message: 'provider failed' } } as const,
    },
  ])('releases inactivity observation on provider $label', async ({ result }) => {
    vi.useFakeTimers();
    const fixture = inactivityHarness();
    const events: AgentEvent[] = [];
    const invocation = fixture.runtime.run(
      'nexus-flash',
      { root: workspaceRoot },
      'Task.',
      (event) => events.push(event),
    );
    expect(vi.getTimerCount()).toBe(1);

    fixture.settle[0]?.(result);
    await invocation;
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(2 * 60_000);
    expect(events).toEqual([]);
  });
});
