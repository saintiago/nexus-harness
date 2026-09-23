# OperatorInterface

Status: proposed component design.

## Responsibility

Translate operator input into an execution request and present progress and results.
Own argument parsing, path normalization, terminal rendering and exit codes.

The public entry point is `src/operator-interface/index.ts`.

## Interface

### Required interface

Use [Supervisor.execute](supervisor.md#provided-interface) and its request, event and result types.
Use the [shared value types](high-level-architecture.md#shared-interface-vocabulary) at the boundary.
Terminal output capabilities are supplied at construction.

### Provided interface

```ts
interface OperatorInterface {
  parse(argv: readonly string[], cwd: string): Result<OperatorCommand>;
  showHelp(): OperatorResult;
  run(
    command: Extract<OperatorCommand, { kind: 'execute' }>,
    execution: Supervisor,
  ): Promise<OperatorResult>;
}

type OperatorCommand =
  | { kind: 'help' }
  | {
      kind: 'execute';
      projectConfigPath: string;
      mode: ExecutionMode;
    };

type OperatorResult = {
  exitCode: 0 | 1 | 2;
  displayFault: string | null;
};
```

Supervisor and ExecutionMode are imported contract types. Resolve projectConfigPath against cwd
and pass it as an absolute filepath. Parsing performs no source access or task mutation. Reject
missing arguments, unknown options and conflicting mode/target options.

run calls execute once with the filepath and selected mode, renders events as they arrive and
presents the final result. It does not load project settings.

The target command grammar is:

```text
nexus queue run --project-config <file>
nexus queue watch --project-config <file>
nexus queue run --ticket <key> --project-config <file>
nexus run --task <file> --project-config <file>
nexus --help
```

queue run selects finite mode, queue watch selects watch mode, queue run --ticket selects single-ticket
mode, and run --task selects single-task mode for a local file. Resolve the local filepath against cwd.
Paths and keys are individual arguments, without shell interpretation.

Help and completed execution return exit code 0. Execution requiring attention or presentation failure
returns 1. Invalid command input returns 2. Record presentation errors separately from execution results.

## Presentation

The parser produces a normalized command. The presenter maintains current progress and recent activity;
the renderer draws it using the available terminal capabilities.

Render events according to their source, type and data. Producers own their event meanings.
Unrecognized events can appear as diagnostic activity; they do not change execution decisions.
The final result replaces an incomplete progress view.

Interactive output has a summary and activity pane. Render agent messages as text, wrap by display
columns and neutralize terminal control characters. Redirected output is a timestamped linear stream
without cursor controls. Terminal size and color choices affect presentation only.

A broken output stream disables that rendering channel and records a display fault. Terminal cleanup
restores cursor and style state. Display state is ephemeral; it is not persisted for execution recovery.

Launch shortcuts invoke the same command grammar with configured paths, a mode and an optional ticket
key. They keep the visible terminal open after exit and contain no separate execution logic.
