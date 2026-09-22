# OperatorInterface

Status: proposed component design.

## Responsibility

Translate operator input into an execution request and present the resulting execution view.
Own argument parsing, path normalization, terminal rendering and mapping final outcomes to exit
codes. Do not decide which task to select, which agent to invoke or whether recovery is needed.

The component is an in-process TypeScript module with public entry point
`src/operator-interface/index.ts`. Terminal capabilities are supplied at construction; the
component does not inspect or mutate a task workspace.

## Interface

### Required interface

Use only [Supervisor.execute](supervisor.md#provided-interface), including its request, event and
result types. This is the sole business-component dependency. No engine, agent, source-provider or
private execution-record dependency is permitted.

Use the [shared value types](high-level-architecture.md#shared-interface-vocabulary) at the boundary.
Terminal output and operating-system interrupt registration are host capabilities supplied at
construction. They do not make lifecycle decisions.

### Provided interface

```ts
interface OperatorInterface {
  parse(argv: readonly string[], cwd: string): Result<OperatorCommand>;
  showHelp(): OperatorResult;
  run(
    command: Extract<OperatorCommand, { kind: 'execute' }>,
    execution: Supervisor,
    stop: AbortSignal,
  ): Promise<OperatorResult>;
}

type OperatorCommand =
  | { kind: 'help' }
  | {
      kind: 'execute';
      configuration: {
        harnessPath: string;
        repositoryPath: string;
      };
      mode: ExecutionMode;
    };

type OperatorResult = {
  exitCode: 0 | 1 | 2 | 130;
  executionId: string | null;
  displayFault: string | null;
};
```

`Supervisor` and `ExecutionMode` are imported interface types, defined only in their provider's
document. `OperatorCommand.configuration` contains absolute paths resolved against `cwd`; no
environment expansion or shell interpretation is performed on task keys or other arguments.

`parse` is pure: no source access, directory creation or task mutation. Missing values, unknown
options, duplicate conflicting options and a ticket key on an incompatible mode are invalid input.
`showHelp` performs no execution and needs no configured execution provider. Paths may contain
spaces and are passed as individual arguments.

`run` generates one execution ID and calls `execute` once. The supplied execution provider is
already bound by application startup to the command's configuration. This component neither loads
domain configuration sections nor constructs internal engine phases. Configuration-loading failure
is presented as an input error before execution; credentials never enter OperatorCommand.

The target command grammar is:

```text
nexus queue run --config <file> --repo <directory>
nexus queue watch --config <file> --repo <directory>
nexus queue run --ticket <key> --config <file> --repo <directory>
nexus run --task <file> --config <file> --repo <directory>
nexus --help
```

`queue run` selects finite mode, `queue watch` selects watch mode, `queue run --ticket` selects
single-ticket mode, and `run --task` selects single-task mode for a local task file. The local file
path is resolved against the invocation directory. The explicit ticket selector is a proposed
addition; these docs do not change the existing executable.

### Outcomes

| Condition | Exit code |
| --- | --- |
| Help or completed execution | 0 |
| Execution requires attention, or presentation failed | 1 |
| Invalid command, invalid configuration or rejected execution admission | 2 |
| Intentional cancellation with confirmed shutdown | 130 |

A cancellation with unconfirmed shutdown is attention, not a clean cancellation. Display failure
is recorded separately from the execution outcome; it must not turn completed work into failed
work in the execution record. `executionId` is null when no execution was admitted.

## Internal design

Three units are sufficient:

- Command parser: produces the normalized command.
- Execution presenter: reduces execution-view events into the latest display model.
- Terminal renderer: renders that model according to terminal capabilities.

The display model holds execution ID, last sequence number, current lifecycle state, task key,
display stage, active role, recent activity and the final result. This is ephemeral presentation
state. It is not a second queue ledger and is not used to resume execution.

Ignore duplicate or older event sequence numbers and reject an event for another execution.
A gap does not mean execution failed: progress is observational. The final returned execution
result replaces any incomplete progress view.

Interactive output has an execution summary and activity pane. Render agent messages as text,
wrap by display columns and neutralize terminal control characters. Color and layout remain local
presentation choices. Redirected output is a timestamped linear stream with no cursor controls.
Changing terminal size or rendering mode does not change the execution request.

The interrupt signal is forwarded without being reinterpreted as an operational failure. A closed
or broken output stream disables that rendering channel and uses an available diagnostic channel;
it does not request cancellation. Output errors are retained in OperatorResult.

Launch shortcuts invoke the same command grammar. They provide mode and optional ticket key, use
configured paths, and keep their visible terminal open after the command exits. They contain no
credentials, model selection, task-state reconciliation or alternate execution loop.

## State ownership

Only the display model and terminal resources belong to this component. Terminal cleanup restores
cursor and style state. No persistent task, incident, claim, workspace or agent state is owned here.
