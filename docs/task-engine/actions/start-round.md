# StartRound

## Responsibility

Create the next round's artifact directory and persist its number as the current round.
Preserve earlier round directories in place.

## Interface

Follow the [general action design](architecture.md). Construction supplies the
[workspace reference](../../workspace.md#layout-and-reference) from the current
[Selection](select-task.md#output) and filesystem access. No agent or subsequent action's artifact
declarations are required.

### Input

Read state/current-round.json when present. Its absence means no round has started in this workspace.
A present but unreadable or invalid record is an error, not a new workspace.

### Output

The action owns state/current-round.json:

```ts
type CurrentRound = {
  number: number;
};
```

number is a positive integer, starting at 1. The corresponding directory is
artifacts/<number>/ within the same workspace.

This record selects the artifact root; it is outside that root so it can be read before resolving
round artifacts. StartRound declares no development, review or other business output shapes.

### Outcome

Return started after the directory exists and the current-round record has been saved.
Filesystem or input errors fail the action. The action does not select the next workflow state.

## Execution

1. Read the current number, using 0 when the record is absent.
2. Add 1 to obtain the next number.
3. Create artifacts/<number>/, retaining an existing directory and its contents if present.
4. Save { "number": <number> } to state/current-round.json.
5. Return started.

The action neither moves nor copies existing artifacts. Earlier directories remain available as
history. It has no knowledge of artifact contents, review outcomes or repair policy.

## Restart

Resuming a later action uses the saved current round. A new round begins only when this action runs.

If interrupted before saving the number, repeating the action uses the same next directory.
If interrupted after saving but before the workflow advances, repeating it can advance once more.
Unused round directories and gaps are allowed; a round number identifies storage, not an exact
count of implementation attempts. No previous round is deleted or overwritten by this action.
