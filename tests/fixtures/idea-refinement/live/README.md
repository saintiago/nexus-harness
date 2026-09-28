# Live idea refinement exchanges

Inspected actual role exchanges for the idea-stage behavior [testing](../../../docs/testing.md#idea-refinement-coverage)
asks for. Controlled workflow and journey tests establish routing and publication; they cannot
establish role judgment, so these transcripts record real invocations of the four roles for three
representative scenarios.

## What was run

Each scenario ran the real role actions (`IdeaEditor` frame/edit, `Researcher`, `ProjectGuide`,
`Challenger`) over the real `AgentRuntime`, the real installed Codex profiles and a temporary
refinement area whose `worktree/` is a clone of this repository. The captured idea, the project
conversation and (for the first scenario) a completed earlier submission retained by the six-role
implementation were supplied as the running Nexus would supply them. No Jira service ran; the
actions published their outcome events into a recording sink.

The first two transcripts record invocations from before the source-scope, attribution and
deliverable guidance this repository added for HARN-77, and they remain their scenarios' evidence;
the third records the current revision, including its one shared source-scope and attribution
instruction per invocation and the editor's deliverable instruction.

| File                                           | Scenario                                                                                                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `architectural-change-with-clarification.json` | The author resubmits an architectural proposal — the model in force becomes a per-run choice — after the previous submission narrowed it, with a human clarification stating the intent. |
| `exploratory-uncertainty.json`                 | The author asks to explore whether caching Jira transition reads is worth it, without knowing the answer.                                                                                |
| `derived-release-notes-with-attribution.json`  | The author wants release notes derived from the merged change record, has chosen no tool or format, and prefers adopting an existing convention.                                         |

Each file records the scenario, the profiles and models, the captured input, and every invocation's
role, operation, parsed output and working messages. The third transcript also records each
invocation's tool activity: its commands whole and its command results truncated at 400 characters
with a marker, so source scope can be inspected without carrying entire tool outputs.

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

Derived release notes:

- The Researcher's first search batch reported Tavily's keyless monthly cap. After observing the
  failure it made no further Tavily request, switched to direct retrieval of the primary sources,
  and recorded the limitation in its report: "Tavily search quota was exhausted and several search
  engines refused automated access, so this report rests on direct retrieval of the primary
  sources listed below." The unavailable service stayed a limitation, not proof that no solution
  exists.
- The Project guide read the supplied `worktree/` only: `AGENTS.md`, `docs/LONG_TERM_VISION.md`,
  `docs/high-level-architecture.md`, the action and adapter designs, the CI workflow and the
  project's Git history, and it named the vision's preference for existing tools. Its activity
  holds no home-directory, other-checkout or provider-session material, and the Researcher's
  project measurements came from the same worktree.
- Synthesis preserved source ownership: the refined idea names the external solutions it rests on
  (towncrier, Changesets, Changie, git-cliff, GitLab's Changelog trailer, GitHub's `release.yml`,
  Release Drafter) instead of presenting them as the author's proposal, attributes the
  adopt-an-existing-tool preference to the author, and keeps a measured project fact ("only 63 of
  233 commit subjects carry a HARN key") as a measurement. No vendor result was restated as a
  local result.
- The deliverable stayed a decision aid: the three required parts came to 179 words and three open
  questions followed. Counting the optional questions the four parts reached 247 words, above the
  150–200 word guidance — recorded here as observation, since the specification states the length
  guidance is not a validation gate and the substance itself stayed within it.
- The Challenger approved, keeping three optional suggestions separate from its concerns (none),
  which confirms again that suggestions do not block approval.

None of the runs required a benchmark or a settled design to approve. Every publication would have
carried the approved revision, the refinement summary and the cycle count; the first and third
scenarios' approvals also show that optional suggestions never block approval.

## Reproducing

The transcripts are evidence, not test inputs; no test reads them. To repeat an exchange, build the
repository, construct the four role actions with the AgentRuntime settings from
`src/application/composition.ts` and the configured profiles, prepare a refinement area holding the
scenario's captured input (`artifacts/submissions/<n>/input.json`) and plan
(`state/current-round.json`), and invoke `frame`, the concurrent `Researcher`/`ProjectGuide`
contributions, `edit` and the `Challenger`.
