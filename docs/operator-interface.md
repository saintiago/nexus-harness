# OperatorInterface

## Responsibility

Subscribe to execution events and attributable agent activity and present them on the terminal.
Own display state, layout and colors.

The public entry point is `src/operator-interface/index.ts`.

## Interface

Consume [TaskEngine and Application events](application.md#provided-interface) through
Application's combined event subscription and agent activity through its separate live
subscription. Construction supplies these subscriptions and terminal output capabilities.

```ts
interface OperatorInterface {
  start(): void;
  stop(): void;
}
```

start subscribes to both inputs. stop unsubscribes, finalizes visible panes and restores terminal
styling. Neither method starts or stops execution. [Application](application.md#interface) owns
command parsing, execution startup and process exit codes. Do not subscribe directly to worker
events that Application already forwards.

Agent invocation boundaries follow the
[agent activity contract](task-engine/architecture.md#agent-activity-events). Match live activity
to panes by invocation ID. Read role and task identity from event data, never from model names or
rendered log text.

## Progress presentation

Keep one chronological timeline of execution progress and agent turns. Show task, operation,
agent role/profile when supplied, outcomes and failure reasons. Omit internal record IDs,
launch arguments and configuration inventory from the live progress view.

Interpret event source, type and data for presentation only. Unknown events appear as plain
diagnostic lines. Do not infer task success from agent messages or tool exit codes; show the
reported execution outcome. Keep display state in memory, with no artifact reads or persistent
display history.

Action outcome events render as one milestone line naming the task or idea, round or cycle when
supplied, returned outcome and short detail. Do not show artifact paths, raw schemas, internal IDs
or full command output. Show a saved recovery report by decision and saved status, without its
path. Outcome lines keep the TaskEngine progress color; recovery lines use terminal default.

Timestamp each entry once on receipt using local `HH:mm:ss`; keep that timestamp during redraws.
Labels identify the source or activity kind even when color is unavailable.

## Agent activity panes

Each invocation starts with a boundary line naming its agent, task or idea when supplied, and
operation. Show one named rolling 10-line pane per active invocation, stacked in start order.
One active invocation uses the same layout and activity contract as several. Update panes
independently by invocation ID.

- Each agent message starts a group. Keep its text and the latest three work entries following it.
  Work before the first message forms its own group.
- Wrap message text to terminal display columns without cutting characters. Fit each tool call,
  result or file-change summary to one row, with an ellipsis when needed.
- When a pane fills, remove older work entries first, then let older message rows enter scrollback.
  Do not discard message text solely to fit the pane.
- Redraw only the affected pane. When an invocation ends, leave its final visible rows in
  scrollback; do not erase or duplicate them.
- Show ordinary progress outside the panes, preserving arrival order. Refresh active panes below
  it without mixing one agent's activity into another's pane.
- On resize, leave existing scrollback in place and use new dimensions for subsequent activity.

Panes are compact live views. Complete activity belongs to each invocation's durable log.
Closing presentation finalizes panes without declaring invocations successful or stopping logging.

## Colors

| Content | Color |
| --- | --- |
| Tool calls, tool results and file-change summaries | Grey |
| Council and delivery reviewer messages and headings | Blue |
| Purpose, research, brief writer and developer messages and headings | Yellow |
| TaskEngine progress, including action and workflow events | White |
| Application, recovery and other diagnostics | Terminal default |

Tool activity stays grey regardless of role. Agent message colors take precedence over the
stream carrying them. Reset styling after each entry.

## Terminal handling

Use panes on interactive terminals with enough room. Below 20 columns or without room for
active panes and four reserved progress rows, print plain timestamped, attributable lines
instead. Redirected output and terminals with color disabled also use plain lines, without color
or cursor-control sequences.

Treat event text as text: remove embedded terminal control sequences before rendering. Restore
terminal styling when presentation stops. If the output stream closes, stop rendering to it;
presentation does not make execution or recovery decisions.
