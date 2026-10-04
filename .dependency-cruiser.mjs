/**
 * Component import boundaries, enforced by `npm run boundaries` and exercised
 * by tests/boundaries.test.ts. Paths are relative to the repository root.
 *
 * The design intent (docs/tech-stack.md, docs/high-level-architecture.md):
 * cross-component imports use the component's public module, actions may import
 * other actions' artifact declarations but not their implementations, and
 * ExecutionRunner and the adapters stay independent of concrete wiring.
 */

/** Action directories under src/task-engine/actions/, per docs/task-engine/actions/. */
const actionDirectories = [
  'select-work',
  'project/select-work',
  'project/route-selection',
  'project/publish-preparation',
  'project/implementation-handoff',
  'project/complete-delivery',
  'project/source-boundaries',
  'preparation/prepare-stage',
  'preparation/start-stage-round',
  'preparation/stage-author',
  'preparation/stage-evaluator',
  'preparation/record-stage-return',
  'preparation/stage-result',
  'select-task',
  'prepare-workspace',
  'start-round',
  'develop',
  'verify',
  'review',
  'deliver',
  'complete-task',
  'select-idea',
  'start-idea-round',
  'idea-editor',
  'researcher',
  'project-guide',
  'challenger',
  'publish-decision',
  'analyze-experience',
];

/**
 * Consumers import a producer's artifact declarations, never its
 * implementation. Application wires implementations itself.
 */
const actionDeclarationRules = actionDirectories.map((action) => ({
  name: `action-declarations-only-${action}`,
  severity: 'error',
  comment: `Import ${action}'s artifact declarations, not its implementation; Application assembles implementations.`,
  from: {
    path: '^src/',
    pathNot: [`^src/task-engine/actions/${action}/`, '^src/application/'],
  },
  to: {
    path: `^src/task-engine/actions/${action}/`,
    pathNot: `^src/task-engine/actions/${action}/artifacts`,
  },
}));

/** @type {import('dependency-cruiser').IConfiguration} */
const config = {
  forbidden: [
    {
      name: 'execution-runner-independent',
      severity: 'error',
      comment:
        'ExecutionRunner binds XState to Nexus state and progress; Application binds concrete actions and adapters.',
      from: { path: '^src/task-engine/execution-runner' },
      to: { path: ['^src/adapters/', '^src/task-engine/actions/'] },
    },
    {
      name: 'adapters-independent-of-orchestration',
      severity: 'error',
      comment:
        'Adapters perform requested external operations; orchestration depends on them, not the reverse.',
      from: { path: '^src/adapters/' },
      to: { path: ['^src/application/', '^src/operator-interface/', '^src/task-engine/'] },
    },
    {
      name: 'task-engine-public-interface',
      severity: 'error',
      comment:
        'src/task-engine/index.ts is the task engine public module; Application may also assemble action implementations.',
      from: { path: '^src/', pathNot: ['^src/task-engine/', '^src/application/'] },
      to: { path: '^src/task-engine/', pathNot: '^src/task-engine/index\\.ts$' },
    },
    {
      name: 'agent-runtime-public-interface',
      severity: 'error',
      comment: 'src/agent-runtime/index.ts is the agent runtime public module.',
      from: { path: '^src/', pathNot: '^src/agent-runtime/' },
      to: { path: '^src/agent-runtime/', pathNot: '^src/agent-runtime/index\\.ts$' },
    },
    {
      name: 'operator-interface-public-interface',
      severity: 'error',
      comment: 'src/operator-interface/index.ts is the operator interface public module.',
      from: { path: '^src/', pathNot: '^src/operator-interface/' },
      to: { path: '^src/operator-interface/', pathNot: '^src/operator-interface/index\\.ts$' },
    },
    {
      name: 'application-public-interface',
      severity: 'error',
      comment: 'src/application/index.ts is the application public module.',
      from: { path: '^src/', pathNot: '^src/application/' },
      to: { path: '^src/application/', pathNot: '^src/application/index\\.ts$' },
    },
    {
      name: 'memory-exclusive-consumer',
      severity: 'error',
      comment:
        'AnalyzeExperience is the sole automatic Memory caller; other implementations neither import nor invoke it, and agents reach AMEM through their explicit MCP tools.',
      from: {
        path: '^src/',
        pathNot: ['^src/memory/', '^src/task-engine/actions/analyze-experience/'],
      },
      to: { path: '^src/memory/' },
    },
    ...actionDeclarationRules,
  ],
  options: {
    // Validation covers the implementation sources; the fixtures under tests/
    // are cruised on their own by tests/boundaries.test.ts.
    includeOnly: '^(src|workflows)/',
    tsPreCompilationDeps: true,
  },
};

export default config;
