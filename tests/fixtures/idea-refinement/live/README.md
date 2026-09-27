# Live idea refinement exchanges

Inspected actual role exchanges for the idea-stage behavior [testing](../../../docs/testing.md#idea-refinement-coverage)
asks for. Controlled workflow and journey tests establish routing and publication; they cannot
establish role judgment, so these transcripts record real invocations of the four roles for two
representative scenarios.

## What was run

Each scenario ran the real role actions (`IdeaEditor` frame/edit, `Researcher`, `ProjectGuide`,
`Challenger`) over the real `AgentRuntime`, the real installed Codex profiles and a temporary
refinement area whose `worktree/` is a clone of this repository. The captured idea, the project
conversation and (for the first scenario) a completed earlier submission retained by the six-role
implementation were supplied as the running Nexus would supply them. No Jira service ran; the
actions published their outcome events into a recording sink.

| File                                           | Scenario                                                                                                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `architectural-change-with-clarification.json` | The author resubmits an architectural proposal — the model in force becomes a per-run choice — after the previous submission narrowed it, with a human clarification stating the intent. |
| `exploratory-uncertainty.json`                 | The author asks to explore whether caching Jira transition reads is worth it, without knowing the answer.                                                                                |

Each file records the scenario, the profiles and models, the captured input, and every invocation's
role, operation, parsed output and working messages.

## What the inspection established

Architectural change and clarification:

- The editor's framing named the current design rule that invocation instructions never change the
  configured model, and marked it as a choice the idea may legitimately revise; the author's
  clarification replaced the earlier submission's reading, and the written revision stated the
  per-run choice while keeping profile identity.
- The Project guide found no purpose document, inferred direction provisionally from code, docs and
  commits with citations, and separated the enduring direction from the changeable design choice.
- The Researcher enriched the idea with provider conventions (the Codex CLI's own per-run
  `--model` override) and asked for no proof first.
- The Challenger approved the clarified proposal, withdrew the earlier reading, and kept three
  optional suggestions that were not required to proceed.

Exploratory uncertainty:

- The editor framed the request as an experiment rather than a settled optimization and kept the
  author's expected null result first-class.
- The Project guide found the project's evidence-before-optimization rule and the specification's
  explicit allowance for exploring a performance idea before measurement, and treated "the reads do
  not justify a cache" as a successful result.
- The Researcher offered a read-composition alternative without demanding a benchmark plan.
- The Challenger approved with the uncertainty carried as open questions and named its objections to
  the cache itself as withdrawn, not blocking.

Neither run required a benchmark or a settled design to approve. Both publications would have
carried the approved revision, the refinement summary and the cycle count; the first scenario's
approval also shows that an optional suggestion never blocks approval.

## Reproducing

The transcripts are evidence, not test inputs; no test reads them. To repeat an exchange, build the
repository, construct the four role actions with the AgentRuntime settings from
`src/application/composition.ts` and the configured profiles, prepare a refinement area holding the
scenario's captured input (`artifacts/submissions/<n>/input.json`) and plan
(`state/current-round.json`), and invoke `frame`, the concurrent `Researcher`/`ProjectGuide`
contributions, `edit` and the `Challenger`.
