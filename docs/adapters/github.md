# GitHub adapter

## Responsibility

Perform explicitly requested GitHub operations and return observed repository and pull-request data.

## Interface

Follow the [adapter contract](architecture.md#interface).
Construction supplies access to the operator's authenticated gh CLI and the Nexus Lens GitHub App
installation credentials. Consumers supply target identities, revisions and requested changes.

Expose pull-request, review, check and workflow operations as required by consumers. Read metadata,
conversations and checks independently when requested.

The calling action decides whether to find, create or update a pull request. The adapter performs
that operation; it does not combine the decision into ensurePullRequest.

### Required capabilities

| Operation | Inputs and result | Consumers |
| --- | --- | --- |
| Find pull requests | Branch/base filters → matching PR identities | [Deliver](../task-engine/actions/deliver.md#interface) |
| Read pull request | PR identity → head, base, state, merge revision and auto-merge state | Deliver, Review, CompleteTask |
| Create or update pull request | Explicit branch/base or PR identity and requested fields → PR identity, URL and head | Deliver |
| Read conversation and reviews | PR identity → complete comments, review threads, review authors and reviewed revisions | [Review](../task-engine/actions/review.md#interface) |
| Publish review as Nexus Lens | PR, reviewed head, verdict and content → review identity | Review |
| Read checks | Revision → check names, producer identities, statuses and conclusions | Review, CompleteTask |
| Publish or update Nexus Lens review check | Reviewed revision, configured check and result → App-owned check identity | Review |
| Request auto-merge | PR and expected head → provider acceptance | Deliver |
| Read workflow runs and jobs | Merge revision and configured workflow identities → statuses, conclusions and revisions | CompleteTask |

Use the operator's CLI identity for PR creation, updates and auto-merge requests. Use the Nexus Lens
installation identity for review and review-check publication. Return the producing App identity when
reading checks. Report unsupported or unauthorized operations as errors.
Queries return observations; the caller decides whether the expected gate or publication is satisfied.

## Behavior

Preserve revision, review-author and check-producer identity, conversation structure and complete requested content.
Apply supported provider preconditions when requested.

Obtain and renew installation tokens within this adapter as needed. Keep App credentials and tokens
out of agent context, artifacts and logs. Token renewal does not change the operator's gh login.

Publish the supplied review result for the exact reviewed commit. The caller owns the approval
decision; the adapter supplies the Nexus Lens identity and GitHub publication.

Report actual merge state and merge revision. Acceptance of an auto-merge request is not a completed
merge. Required-gate decisions belong to the caller; provider branch rules remain in force.
