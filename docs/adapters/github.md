# GitHub adapter

## Responsibility

Perform explicitly requested GitHub operations and return observed repository and pull-request data.

## Interface

Follow the [adapter contract](architecture.md#interface).
Construction supplies access to the operator's authenticated gh CLI and the Nexus Lens GitHub App
installation credentials. Consumers supply target identities, revisions and requested changes.

Expose pull-request, review, check and workflow operations as required by consumers. Read metadata,
conversations and checks independently when requested.

The review-publication contract accepts `ReviewVerdict = 'approved' | 'changesRequested'`.
It receives a completed assessment, its exact reviewed head and publication content; it has no
verdict for an unfinished assessment.

The calling action decides whether to find, create or update a pull request. The adapter performs
that operation; it does not combine the decision into ensurePullRequest.

### Required capabilities

| Operation | Inputs and result | Consumers |
| --- | --- | --- |
| Find pull requests | Branch/base filters → matching PR identities | [Deliver](../task-engine/actions/deliver.md#interface) |
| Read pull request | PR identity → head revision and branch, base, state, merge revision and auto-merge state | Deliver, Review, CompleteTask |
| Create or update pull request | Explicit branch/base or PR identity and requested fields → PR identity, URL and head | Deliver |
| Read conversation and reviews | PR identity → complete comments, review threads, review authors and reviewed revisions | [Review](../task-engine/actions/review.md#interface) |
| Publish review as Nexus Lens | PR, reviewed head, verdict and content → review identity | Review |
| Read checks | Revision → check names, producer identities, statuses and conclusions | Review, CompleteTask |
| Read required checks | PR identity → observed revision and required pre-merge check names, states, conclusions and evidence links | CompleteTask |
| Publish or update Nexus Lens review check | Reviewed revision, configured check and result → App-owned check identity | Review |
| Request auto-merge | PR and expected head → provider acceptance | Deliver |
| Read workflow runs and jobs | Merge revision and configured workflow identities → statuses, conclusions and revisions | CompleteTask |

Use the operator's CLI identity for PR creation, updates, auto-merge requests and required-check
reads. Use the Nexus Lens installation identity for review and review-check publication. Return the
producing App identity when reading checks. Report unsupported or unauthorized operations as errors.
Required-check reads report the revision they observed together with the pre-merge checks the
repository's merge rules require for the pull request's base branch, each with its name, state,
conclusion and evidence link; a legacy commit status is reported in the check vocabulary. The
observed checks belong to that revision, and the read returns every page of the rollup or an error.
If the observed revision changes between pages, return an error without any accumulated checks.
Queries return observations; the caller decides whether the expected gate or publication is satisfied.

## Behavior

Preserve revision, review-author and check-producer identity, conversation structure and complete requested content.
Apply supported provider preconditions when requested.

Obtain and renew installation tokens within this adapter as needed. Keep App credentials and tokens
out of agent context, artifacts and logs. Token renewal does not change the operator's gh login.

Publish the supplied review result for the exact reviewed commit. The caller owns the approval
decision; the adapter supplies the Nexus Lens identity and GitHub publication.
Encode approved as GitHub APPROVE/APPROVED and changesRequested as
REQUEST_CHANGES/CHANGES_REQUESTED. Other observed GitHub review states remain provider observations,
not additional Nexus verdicts.

Report actual merge state and merge revision. Acceptance of an auto-merge request is not a completed
merge. Required-gate decisions belong to the caller; provider branch rules remain in force.

### Conversation reads

The affected categories are conversation-read latency, pagination, returned content and errors.
The caller's journey is: request one PR conversation → read issue comments, reviews and inline
review comments → receive the complete conversation or the existing error outcome.

- Start the three independent streams concurrently, so none waits for another stream's response
  before starting. Within each stream, read pages sequentially until the collection is complete.
- Return success only after all three streams have completed successfully. Preserve the existing
  separate collections, provider/page ordering within each collection, content and metadata,
  including review authors, reviewed revisions and inline-comment thread references. Stream
  completion order must not affect the returned content. An empty stream remains an empty collection.
- A failure on any page of any stream fails the conversation read; never return successful partial
  content. Preserve existing error diagnostics. If several streams fail, preserve the existing
  error priority: issue comments, then reviews, then inline review comments, regardless of which
  failure arrives first.

Keep this change within the existing adapter and focused tests. Do not introduce JEv, a new cache
or a concurrency framework.

#### Observable acceptance examples

| Situation | Observable result |
| --- | --- |
| The first response of each conversation stream is held pending | Requests for issue comments, reviews and inline review comments all start before any held response is released. |
| A stream has a full first page and a shorter second page | Its second request starts only after its first response; both pages appear in provider order. Other streams can progress independently. This applies to each of the three streams. |
| Reviews finish first, inline review comments next, and issue comments last | No successful conversation is returned before issue comments finish. The final separate collections have the same content, metadata and order as the existing read, including review author derivation and thread references. |
| One or all streams contain no entries | The successful conversation contains empty arrays for those streams and complete content for any populated streams. |
| A first or later page of any one stream fails, while the other streams succeed | The conversation read fails with the existing diagnostic for that failure; no successful partial conversation is returned. CLI failures, invalid JSON and unexpected response shapes retain their existing error behavior. |
| Reviews fail before issue comments, and both streams fail | The returned error is the issue-comments error. If only reviews and inline review comments fail, the reviews error wins even when the inline-comment failure arrives first. |
