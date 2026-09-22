# Long-Term Vision

## Purpose

This document is the north star for the harness. It is **not** an implementation plan and it defines
no behaviour of its own.

- Current specs and explicit tasks take precedence: `docs/spec.md` remains authoritative for what
  the harness does today.
- A change in behaviour still needs a task, implemented on a `task/...` branch with tests
  ([docs/GIT-WORKFLOW.md](GIT-WORKFLOW.md)), with the spec updated where the behaviour it describes
  changes.
- Where this document and the spec disagree about current behaviour, the spec wins and this
  document is amended.

The harness should evolve from an autonomous coding executor into an **autonomous engineering system** while remaining simple, efficient, observable, and human-governed.

## End State

A human should increasingly provide **intent, goals, problems, or evidence**, rather than prepared engineering tasks.

Example:

> Here is a reel about another autonomous system. Investigate it and improve this harness if there is anything worth adopting.

The mature harness should be able to:

```text
signal / goal / idea
        ↓
understand intent
        ↓
investigate
        ↓
generate hypotheses
        ↓
challenge them
        ↓
reject / defer / experiment / accept
        ↓
prioritize against other work
        ↓
plan and decompose
        ↓
execute
        ↓
verify
        ↓
deploy / observe
        ↓
evaluate actual outcome
        ↓
keep / improve / revert / investigate again
```

It should escalate when human judgment is genuinely useful.

## Core Principles

**Simple.** Prefer the smallest design that solves a real problem. Do not build future infrastructure speculatively.

**Deterministic where simple and reliable.** Keep clear rules in ordinary software. Use AI for investigation and judgment when deterministic handling would become brittle or require an expanding collection of special cases. Keep execution and verification reliable.

**Evidence-driven.** An interesting idea is not an improvement. Prefer hypotheses, experiments, baselines, and measurable outcomes.

**Critical.** The system must challenge its own proposals. “No change justified” is a successful result.

**Prioritized.** Once the harness can create work, possible work is infinite. It must compare opportunities rather than automatically acting on the latest idea.

**Reversible.** Prefer changes that can be evaluated, changed, or reverted. Previous decisions may become wrong as evidence changes.

**Observable.** Preserve enough evidence to understand what happened, why a decision was made, what changed, and whether it helped.

**Human-governed.** Autonomy means avoiding unnecessary human intervention, not avoiding humans at all costs.

## Intent Before Implementation

Do not blindly turn proposed solutions into tasks.

> “Add persistent memory”

may actually represent:

> “Agents repeatedly rediscover knowledge and make the same mistakes.”

Memory is only one possible intervention. Documentation, retrieval, better context, or doing nothing may be better.

Reason from **goal → problem → hypothesis → evidence → intervention** when the task permits it. Explicit human instructions still win.

## Experiment Before Infrastructure

When uncertainty is meaningful, seek the cheapest evidence that could change the decision. Match the investigation to the task: this principle does not require every implementation to include a benchmark campaign or new measurement tooling.

Possible methods include historical replay, benchmarks, prototypes, temporary branches, simulations, shadow runs, or controlled rollout.

Implementation success proves correctness, not value.

Eventually distinguish:

- **Correctness:** did the change work?
- **Outcome:** did it achieve the intended improvement?
- **Side effects:** what became worse?
- **Persistence:** does the improvement survive realistic use?

Production behavior should become evidence, not merely a deployment target.

## Learning

The harness should eventually learn from:

- previous decisions and their rationale;
- experiments and outcomes;
- failed approaches;
- incidents;
- human corrections;
- rejected hypotheses;
- repository-specific knowledge.

Memory exists to improve future decisions, not merely to accumulate information.

The system must be capable of reconsidering earlier conclusions and modifying or reverting its own changes when later evidence contradicts them.

## Inputs Are Signals, Not Necessarily Tasks

Long-term inputs may include:

```text
human request / idea
Jira or GitHub
CI failure
production incident
metric anomaly
user feedback
repository change
dependency release
article / paper / repository
video / reel
scheduled observation
```

An input may produce work, investigation, deferred action, escalation, or no action.

## Capability Progression

1. **Execution** — human chooses the task; harness implements, verifies, repairs.
2. **Acquisition** — harness discovers human-created work from Jira, GitHub, CI, etc.
3. **Decomposition** — human specifies an outcome; harness determines and executes the tasks.
4. **Investigation** — input can be information; harness researches relevance and opportunities.
5. **Proposals** — harness identifies problems/opportunities and generates scrutinized hypotheses.
6. **Experimentation** — harness designs cheap ways to validate hypotheses before committing.
7. **Prioritization** — harness chooses among competing useful initiatives.
8. **Production ownership** — detect → investigate → change → deploy → observe → repair/revert.
9. **Self-improvement** — external or internal signals can lead autonomously from investigation to a verified improvement and subsequent learning.

Progress through these levels incrementally. Do not introduce architecture merely because a later level may need it.

## Preserve the Reliable Core

Higher-level autonomy should sit above reliable execution:

```text
goals / evidence / investigation / hypotheses / prioritization
                            ↓
                     executable work
                            ↓
working copy → coding agent → checks → repair → result
```

Keep fuzzy judgment out of components that can remain deterministic.

As coding agents improve, implementation becomes increasingly commoditized. The harness's long-term value is the intelligence around implementation:

```text
What matters?
What do we know?
What should we investigate?
What evidence would change our mind?
What deserves to be done now?
Did the intervention actually help?
What should happen next?
```

## Decision Test for Agents

Before adding complexity, ask:

1. Does this solve a concrete problem now?
2. Is there a simpler solution?
3. Are we adding capability or only abstraction?
4. Could deterministic code do this reliably?
5. How will we know it helped?
6. Can it be reversed?
7. Should we validate the hypothesis before implementing it?
8. Could doing nothing be the correct outcome?

## North Star

The goal is not maximum autonomy or maximum activity.

The goal is a system that can take increasing ownership of engineering:

**observe → reason → investigate → experiment → prioritize → execute → verify → learn → escalate when appropriate**

Success means increasing the amount of **useful, correct, evidence-backed engineering responsibility** the harness can carry without unnecessary human intervention.
