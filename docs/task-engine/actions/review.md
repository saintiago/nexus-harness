# Review

## Responsibility

Evaluate task correctness at the delivered revision and produce an actionable review,
including preparation content carried by its implementation branch.
Completed assessments proceed to publication and either repair or gated completion;
unfinished assessments proceed to recovery.

## Interface

Follow the [action contract](architecture.md). Import [devArtifact](develop.md#output),
[verificationArtifact](verify.md#output) and [deliveryArtifact](deliver.md#output).
Use [Selection](select-task.md#output), [PreparedWorkspace](prepare-workspace.md#output),
earlier-round review/development history, configured reviewer profile,
[AgentRuntime](../../agent-runtime/architecture.md#provided-interface), the
[Git adapter](../../adapters/git.md#interface), [GitHub adapter](../../adapters/github.md#interface)
and parent-supplied source input/publication acknowledgements.

Use [ReviewerRole](../../agent-runtime/reviewer-role.md#interface). Supply the response format below
and previous reports as context using the [findings contract](findings.md). The profile includes
the complete reviewer instructions.

### Output

```text
reviewArtifact = { pathFromArtifactsRoot: "review.json", type: ReviewOutput }
```

```ts
type ReviewOutput = {
  taskSubject?: string;
  profile: string;
  headRevision: string;
  verdict: 'approved' | 'changesRequested';
  taskKey: string;
  role: 'reviewer';
  report: ArtifactRef;
  invocationId: string;
};

type ReviewResponse = { verdict: 'approved' | 'changesRequested' };
```

The action captures the refreshed task subject in taskSubject when saving a new report, retaining
the subject for later artifact interpretation even if task selection is refreshed.

Request one JSON object conforming to ReviewResponse as the agent's final output. Include that
shape, its assigned Markdown path and narrative assessment/verdict obligations in context. Parse and
validate the response, then add the configured profile and observed reviewed head to create
ReviewOutput. They are not agent claims.

Review owns separate response and saved-outcome schemas and derives their provider format and types.
Both permit only the two declared verdicts; there is no report-shaped failure result.

### Outcomes

Return the recorded verdict: approved or changesRequested.
Each outcome writes reviewArtifact before publication and publishes the
[action outcome event](../architecture.md#action-outcome-events) referencing it with the profile used.
An invocation that reuses the saved report for the delivered head publishes the same reference.
Unusable agent output is an execution error.
An assessment that cannot finish supplies no usable verdict and follows the existing
[execution-error and recovery path](../../application.md#execution-and-recovery). Do not add a
review-specific retry mechanism or open a repair round merely because review could not finish.

## Behavior

Use PreparedWorkspace.repositoryWorkspace for repository inspection and the reviewer working
directory. Assess all code relevant to task correctness, including pre-existing code when correction
is necessary and preparation content carried by the first implementation. The comparison base and
diff help orient inspection; neither that range nor changes since a preceding review limit scope.
Stage acceptance is context, not delivery approval.
Keep review artifacts under the implementation issue; earlier stage or PR approval cannot approve
a changed head.

### Prompt context requirements

The affected categories are task and human direction, current reports and verification evidence,
active correction/validation feedback, historical conversations and reports, and comparison evidence.
The reviewer must see its active obligations directly while retaining access to complete supporting
history. The journey is: receive current requirements and feedback -> inspect labeled evidence
references and the task-relevant implementation -> assess the delivered revision -> report through
the existing review and repair/publication paths.

1. Confirm that the delivered head, development result, verification result and retained worktree
   describe the same revision. A parent-owned input actor supplies refreshed task conversation;
   retain that input and refreshed GitHub PR conversations locally as complete readable evidence.
2. Keep current task requirements, relevant human instructions, the current development report and
   verification result directly visible in the invocation. Preserve scope, qualifications, exclusions
   and acceptance conditions. Relevant human instructions include clarifications or corrections
   that govern the current task even when they occur in older conversation entries. Preserve their
   original meaning and attribution; conflicting or uncertain direction remains explicit rather
   than being silently resolved. Agent assessments and Nexus publications are not human decisions.
3. Keep active correction and validation feedback directly visible, including the preceding review
   assessment when its concerns require judgment against the current revision. Include the original
   narrative, not a lossy summary or an extracted finding set. Supporting reports may be referenced,
   but a reference alone cannot hide an active obligation. Use the existing
   [report requirements](../../agent-runtime/report-requirements.md) for actionable rejection reasons,
   attributable rejected evidence and owner-validated clearing of pending feedback; changing prompt
   presentation does not introduce a correction ledger or Markdown-byte matching gate.
4. Supply supporting Jira/PR conversation history and earlier review/development reports through
   clearly labeled readable references instead of repeatedly embedding their complete bodies.
   Identify the source and task/PR, and preserve available author, chronology, round, role/profile,
   invocation, revision and outcome attribution in the references or referenced evidence. The
   reviewer can read the complete captured conversations and original reports, including legacy
   combined records and rejected evidence, without fetching them again from Jira or GitHub.
   Published summaries do not replace these originals. Previous reports remain context, not an
   eligible finding set, per-finding response or disposition input.
5. Supply the complete comparison diff through a labeled readable reference, identifying its recorded
   base/head in the invocation. Explicitly state that it orients inspection and does not bound scope:
   all code relevant to task correctness, including pre-existing code outside the range, remains in
   scope. Do not truncate, summarize or omit comparison evidence to shorten the prompt. Agent claims
   do not change the revision this action evaluates.
6. Verify assembled reviewer invocations on initial review and subsequent reviews, including retained
   continuation that needs a fresh assessment: active obligations remain directly visible,
   supporting historical bodies and the diff are referenced, and those references resolve to
   complete readable evidence from the reviewer workspace. Preserve existing evidence usability,
   attribution and revision checks. Unavailable
   required evidence follows existing execution-error/recovery handling; it is not approval, an
   invented finding or a new upstream product requirement.

This change is bounded to Review context and its owning documentation and verification. Reuse
preparation's existing reference-based approach where appropriate; it does not require a rewrite
of other role contexts, JEv or a new context-ranking service. There is no prompt-size target or
cutoff for active obligations. Reference layout and prompt assembly belong to technical design;
no material product decision is unsettled.

### Context assembly and evidence storage

Review owns the division between directly visible obligations and referenced evidence. Its existing
task, outcome and invocation contracts remain unchanged; evidence files are supporting input,
not new workflow outcomes. Assemble context from the same captured values that are saved for the
invocation. Do not rank relevance, summarize bodies or ask another agent to select context.

Before a fresh assessment, retain these files beside the assigned Markdown report, under
`artifacts/<round>/reports/<invocationId>/` in the reviewing issue's artifact area:

| File | Complete content | Inline reference label |
| --- | --- | --- |
| `captured-source.json` | The captured `{ issue, conversation }`, in native structures | Jira issue/task identity and complete captured task conversation |
| `pr-conversation.json` | All captured PR comments, submitted reviews and inline review comments, including provider metadata and thread references | Repository, PR number and complete captured PR conversation |
| `comparison.diff` | The complete diff for the observed comparison base and reviewed head | Comparison base/head and orientation-only scope warning |

Use absolute paths readable from the recorded repository workspace, which may belong to a different
issue than the artifact area. The mutable selection record is an input, not a historical evidence
reference: later refresh or selection must not change what an earlier invocation can inspect.
Fresh invocations get distinct evidence paths, including repeated assessments within one round.
Keep earlier round-level conversation files readable where already retained; new references use
the invocation-local files. Store the diff as returned, including a valid empty diff, without
truncation or an extra size threshold. Do not copy supporting reports or rewrite legacy evidence.

Build the directly visible human-direction section conservatively from both captured conversations.
Include every entry not positively identified as automation, with its complete original body and
available identity, author, creation/edit chronology, source location, thread and reviewed-revision
metadata. This includes all potentially governing human entries regardless of age; the reviewer
judges relevance and conflicts against current requirements. Native JSON is an adequate lossless
rendering, including rich-text bodies and unusual retained structures. A readable rendering must
preserve the same meaning and fall back to the original value for unsupported content.
Review uses native JSON inline for structured requirement values and complete Jira entries: the
preparation renderer's partial rich-text projection cannot establish this stronger guarantee.
Keep inline PR comment locations explicit, distinguishing current and original lines/ranges,
diff sides and positions when captured; do not substitute an original line for a current one.

Identify automation only through captured provider account/bot metadata, the configured publication
identity or an available source-owned publication acknowledgement. Do not classify a human account
as automation from a profile prefix, matching prose or lack of metadata. Entries with missing or
ambiguous origin remain directly visible, labeled uncertain rather than asserted human intent;
explain that agent claims and published summaries cannot override human direction. Confirmed
automated publications stay in the complete referenced conversation and are labeled as such where
their attribution is presented. There is no age cutoff, word budget, instruction extractor or new
publication-tracking store. A conversation consisting entirely of possible human direction can
therefore contribute all its entries inline; reduction must never hide potential obligations.

The remaining directly visible sections contain the current task requirements, current complete
development narrative with outcome/invocation/head attribution, verification result, preceding
review narrative and pending validation-error reasons. Select the preceding assessment from the
current round's saved review when it requires a fresh assessment at a different head; otherwise use
the latest earlier-round review. Include that assessment's complete original Markdown, or the
complete legacy combined record, with round, profile, invocation where available, reviewed head and
verdict. Include it even after approval so the reviewer can judge recurrence; no prose parsing or
finding-state mechanism decides which concerns remain active. Older reviews and development reports
remain attributed references in round order. Reference labels include available task, outcome,
profile, invocation and revision metadata; legacy records are explicitly labeled combined evidence.

Pending validation-error reasons and their responsibility/attempt attribution stay inline. Available
rejected output and reports retain their existing readable references, with unavailable evidence
explicitly identified. Only the responsible owner's validation and saved replacement clear pending
context; presentation does not change that lifecycle. Reading supporting reports must preserve the
existing producer-owned outcome/report usability checks, without hashes or prose consistency gates.

Save and establish readability of new evidence before invoking the reviewer. Storage/read failures
fail the fresh assessment through ordinary execution handling; do not substitute an empty
conversation, partial diff or approval. The assembled invocation instructs the reviewer to read
complete local evidence as needed to understand earlier concerns and conflicting direction, and
retains the explicit task-relevant inspection scope outside the comparison range. Replaying a usable
saved review for the delivered head completes publication without assembling fresh context or
requiring newly introduced evidence files in older completed reviews.

Verify this boundary through actual assembled provider prompts and readable temporary artifact
storage: initial assessment, repair, same-round changed-head assessment and retained fresh
continuation. Assert exact source values and diff bytes behind the references, preservation of older
invocation snapshots after source refresh, directly visible human/uncertain direction and active
narratives/errors, and absence of confirmed automated historical bodies and diff bodies from the
prompt. Include conflicting older human input, provider bot and publication identity, missing
attribution, legacy reports, large and empty diffs, storage failure and a repository/artifact area
split. Retain existing saved-review replay, revision, publication and feedback-clearing checks.
These checks establish evidence delivery, not model compliance or a prompt-size target.

### Assessment and publication

Use the existing worktree with the reviewer profile. Dependency installation, builds, focused checks
and temporary reproduction tests may write files. Verify that the reviewed revision and implementation
remain unchanged after the turn; new caches, logs or generated verification output alone do not
invalidate a review. Implementation fixes belong to a development turn.

The reviewer evaluates correctness and missing behavior and judges previous concerns and narrative
responses against current evidence. It writes assessment and actionable current findings in Markdown
and returns only verdict. Validate that control value, the assigned report and its binding under the
[shared report handling](architecture.md#markdown-reports-and-machine-outcomes). Do not parse or
validate findings or verdict consistency against prose. Bind the saved outcome/report to the
revision actually reviewed. Missing or invalid required output is unusable, never approval or an
invented finding.

An invocation fault or unusable response fails the action before saving a new reviewArtifact or
publishing a review/check. Retain the failure explanation through ordinary execution diagnostics;
do not manufacture a review report for an unfinished assessment.

Save the outcome/report binding. Publish the saved Markdown review and configured review check for
that exact head through the Nexus Lens publication capability. Only approved produces a successful
review check; changesRequested cannot authorize merge. The complete agent conversation stays in
local artifacts; the published review summarizes the result. Recognize an already-published review
by the configured Nexus Lens author, the reviewed commit, the verdict and retained publication body,
and the check by the configured name, the Nexus Lens producer identity, a completed status and the
verdict's conclusion. Publish only the missing part. Supply concise ticket feedback to the
parent-owned publication actor, which publishes a comment beginning with the profile and explaining
what was missed and what to improve. A requested repair stays in the current workflow; a Jira
comment is not the repair input.

On repetition, inspect the saved report and remote publication for that head before invoking the
reviewer or publishing again. Never apply approval to a later head.
Validate the current development outcome through its producer-owned usable-outcome reader before
both a fresh assessment and saved-review replay. Missing/unreadable reports, invalid outcomes,
foreign task evidence or mismatched repository revisions fail before publication and retain
validation-error context under the developer's responsibility. Readable Markdown wording changes
do not invalidate evidence. Approved and changesRequested saved replacements clear only the
reviewer's pending validation-error context under the shared continuation rules.
Developer context clears after validating the development basis: fresh assessment requires the
delivered worktree head with no tracked changes; saved-review publication replay uses the validated
assessment for the matching delivered and verified head without another worktree assessment.

New agent responses use the strict current response schema. The producer's saved-record reader also
accepts former finding IDs and disposition fields in retained reports without enforcing removed
lifecycle rules. Preserve the complete original reports as readable historical evidence. Required
verdict and revision fields and new report associations still receive validation; former structured
findings remain readable history without consistency validation. An invalid retained report is an
action failure, not an absent report or a verdict to translate. Reuse an otherwise valid completed
report only for its recorded head under the existing publication rules; history does not authorize a
changed revision. Do not rewrite history or add a compatibility verdict.

Review has no Jira capability. GitHub Nexus Lens review/check publication remains Review-owned.

## Acceptance examples

| Given | Observable result |
| --- | --- |
| Sufficient evidence and no current blocking findings, with or without non-blocking observations | The review is approved for the inspected head and its Lens review check succeeds. |
| At least one current blocking finding with concrete basis, evidence and impact | The review requests changes, its Lens review check does not authorize merge, and finite delivery returns to the existing repair flow. |
| Material evidence is unavailable and the assessment cannot finish | Execution fails through the existing recovery path; no usable review verdict, invented blocking finding or additional review retry mechanism is produced. |
| A reviewer returns the removed inconclusive verdict | The report is unusable output and is handled as an execution error. |
| Approval applies to a different head, a required pre-merge check fails, or merge and successful required post-merge checks are unconfirmed | The task cannot complete; the existing revision and pre/post-merge gates still apply. |
| A long Jira/PR conversation contains an older human scope clarification that still governs the task, a later conflicting human instruction and Nexus-published summaries | The assembled invocation directly shows the relevant human instructions with attribution and the unresolved conflict. Labeled references expose the complete captured conversations and distinguish publications from human direction; full historical conversation bodies are not embedded. |
| A repair review has a current developer report, verification result, preceding changes-requested assessment, pending reviewer validation error and several older rounds | The current report, verification evidence, original active assessment and actionable validation reason are directly visible. Older supporting reports and rejected evidence remain accessible through attributed references; no summary or reference replaces the active obligations. |
| A comparison diff is large and a task-relevant defect lies in pre-existing code outside its base/head range | The invocation states the base/head and provides a readable reference to the complete diff without embedding its body. It explicitly preserves inspection of task-relevant code outside the range; shortening context does not narrow review scope. |
| Review resumes for a fresh assessment after history has grown | The assembled invocation retains current requirements, relevant human instructions, current reports and pending feedback directly, with complete historical evidence accessible by reference. Historical age or context size does not hide an active correction. |
| A required evidence reference cannot be read and the reviewer cannot finish its assessment | Existing execution-error/recovery handling applies without a usable verdict, fabricated defect or extra retry route. Merely providing a path does not establish evidence availability. |
| A referenced report has readable wording changes, or a replacement outcome has cleared pending validation context under its owner's rules | Context follows the existing report requirements: no Markdown-byte matching or correction ledger is restored, cleared errors remain readable history, and task/invocation/revision attribution and review gates still apply. |
