# OperatorInterface

## Responsibility

Subscribe to execution events and present them on the terminal. Own display state, layout and colors.

The public entry point is `src/operator-interface/index.ts`.

## Interface

Consume [TaskEngine events](task-engine/architecture.md#provided-interface) and
[Supervisor events](supervisor.md#provided-interface) through their subscription contracts.
Construction supplies the event subscriptions and terminal output capabilities.

```ts
interface OperatorInterface {
  start(): void;
  stop(): void;
}
```

start subscribes to the supplied streams. stop unsubscribes, finalizes the visible pane and restores
terminal styling. Neither method starts or stops execution. Startup owns command parsing, execution
startup and process exit codes.

When Supervisor forwards worker events, subscribe to that combined stream once; do not also subscribe
to the same worker events separately. Agent invocation boundaries and activity arrive through these
streams, following the [agent activity contract](task-engine/architecture.md#agent-activity-events).
Read role and task identity from event data, never from model names or rendered log text.

## Progress presentation

Keep one chronological timeline of execution progress and agent turns. Show task, current operation,
agent role/profile when supplied, outcomes and failure reasons. Omit internal record IDs, launch
arguments and other configuration inventory from the live progress view.

Interpret event source, type and data for presentation only. Unknown events appear as plain diagnostic
lines. Do not infer task success from agent messages or tool exit codes; show the reported execution
outcome. Keep display state in memory, with no artifact reads or persistent display history.

Timestamp each entry once on receipt using local `HH:mm:ss`; keep that timestamp during redraws.
Labels identify the source or activity kind even when color is unavailable.

## Agent activity pane

Each invocation starts with a boundary line naming its role, task when supplied, and operation.
Open a fresh pane below it. Only the current invocation has an active pane; completed turns remain
above it in terminal scrollback.

- Keep at most 20 physical rows in the active pane, leaving four terminal rows for progress.
- Each agent message starts a group. Keep its text and the latest three work entries that follow it.
  Work before the first message forms its own group.
- Wrap message text to terminal display columns without cutting characters. Fit each tool call,
  result or file-change summary to one row, with an ellipsis when needed.
- When the pane fills, remove older work entries first. If message rows still exceed its height,
  let the oldest rows enter scrollback. Do not discard message text to fit the pane.
- Redraw only the pane's own rows. When a turn ends, leave the visible rows where they are;
  do not erase them or append a duplicate copy.
- If ordinary progress arrives during a turn, finalize the current pane segment and print the
  progress below it. Subsequent activity continues in a new segment, preserving arrival order.
- On resize, leave existing rows in place and use the new dimensions for subsequent activity.

The pane is a compact live view, not a complete tool-output log. Closing presentation finalizes any
active pane without declaring the invocation successful.

## Colors

| Content | Color |
| --- | --- |
| Tool calls, tool results and file-change summaries | Grey |
| Reviewer messages and invocation heading | Blue |
| Developer messages and invocation heading | Yellow |
| TaskEngine progress, including action and workflow events | White |
| Supervisor, recovery and other diagnostics | Terminal default |

Tool activity stays grey regardless of agent role. Agent message colors take precedence over the
stream carrying them: a reviewer message forwarded through TaskEngine remains blue. Reset styling
after each entry so it cannot affect later output.

## Terminal handling

Use the pane on interactive terminals with enough room. Below 20 columns or with no room after the
four reserved rows, print a plain timestamped stream instead. Redirected output and terminals with
color disabled also use plain lines, without color or cursor-control sequences.

Treat event text as text: remove embedded terminal control sequences before rendering. Restore
terminal styling when presentation stops. If the output stream closes, stop rendering to it;
presentation does not make execution or recovery decisions.
