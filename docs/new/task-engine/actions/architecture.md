# Actions

Status: proposed general action design.

## Responsibility

An action performs one workflow operation. It reads declared input artifacts, carries out its work,
writes declared output artifacts and returns a named outcome. Its output declarations are its data
interface to other actions.

## Interface

Actions follow the [TaskEngine action contract](../../task-engine.md#actions). They are bound functions;
configuration, capabilities, event publishing and the [workspace reference](../../workspace.md#layout-and-reference)
are supplied before execution. An action receives only the dependencies it needs.

An action design specifies:

- The operation it performs.
- Input artifact declarations it imports, including which inputs are optional.
- Output artifact declarations it owns: paths, content types and meanings.
- Returned outcomes and which outputs each outcome produces.
- Required configuration and capabilities.

Actions invoke capabilities through their public interfaces. Agent-backed actions use
[AgentRuntime.run](../../agent-runtime.md#provided-interface), supplying context assembled from their inputs
and interpreting the returned output themselves.

### Artifact declarations

An artifact declaration has two properties:

```text
{
  pathFromArtifactsRoot,
  type
}
```

pathFromArtifactsRoot is a fixed relative path within the workspace's artifacts directory.
type describes the stored content's shape. The declaration identifies a data contract; the current
workspace determines the concrete file. Store the content in the file, not the declaration.

Each producer exports its output declarations separately from its executable implementation.
Consumers import those declarations rather than redefining paths or content shapes. Each output
path has one producer. Content types contain the information consumers need.

For example, the development result is declared as:

```text
devArtifact = {
  pathFromArtifactsRoot: "development.json",
  type: DevelopmentOutput
}
```

This is pseudocode: DevelopmentOutput denotes the content type, not a runtime type registry.
The producing action's design defines its fields and their meaning.

### Reading and writing

Artifact helpers are bound to the current workspace. readInputArtifacts accepts imported declarations
and returns their typed contents in argument order. writeOutputArtifact accepts an owned declaration
and content of its declared type. Structured contents are stored as JSON.

The interaction is:

```text
// Develop writes its declared output.
writeOutputArtifact(devArtifact, developmentOutput)
return "completed"

// Review imports the declaration, not the Develop implementation.
import { devArtifact } from "../develop/artifacts"

[development] = readInputArtifacts(devArtifact)
// Perform review using development and other declared inputs.
writeOutputArtifact(reviewArtifact, reviewOutput)
return reviewOutcome
```

Reads and writes finish before execution continues. Required inputs must exist and conform to their
declared content type; a missing or invalid required input is an action failure. An optional input's
absence and meaning are defined by the consuming action. No input is silently replaced with guessed data.

Imports expose producer–consumer data dependencies. They do not make actions call one another or
restrict the workflow to immediate producer–consumer transitions: intervening actions may run, and
an action may consume several producers' outputs.

## Execution

Read inputs, perform the operation, finish writing the outputs required by the outcome, then return
that outcome. Workflow transitions choose the next action. Events report activity without selecting
the next state.

Actions own their business decisions, agent output interpretation and external effects. They may
execute again after interruption and decide whether existing work can be reused. Detailed results
are artifacts; the returned outcome is only the workflow's transition key.

## Repeated rounds

Each completed invocation replaces its current output at the declared fixed path. Thus Review reads
development.json from the preceding completed Develop invocation; Develop reads review.json for the
latest review findings. The consuming action defines whether an input is needed on its initial round.

Sequential execution and writing outputs before returning establish this handoff. Consumers use the
declared path, not a filename search, round counter or latest-artifact index. A transition that consumes
an output requires that output to have been produced for that round; an old file is not a new result.

Current output files carry the latest results. Previous exchanges remain in separate conversation
history artifacts. Workflow YAML contains states and transitions, not artifact paths or mappings.
