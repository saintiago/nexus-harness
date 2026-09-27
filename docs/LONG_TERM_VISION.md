# Nexus long-term vision

Nexus is an autonomous engineering system that works for any connected project. A human supplies
intent, goals, problems or evidence; Nexus turns them into refinement, requirements and design,
finite delivery and evaluated outcomes, and involves humans where human judgment decides the
result.

This document states enduring purpose and long-term direction for making project decisions.
Detailed behavior belongs in the architecture and workflow specifications, such as the
[high-level architecture](high-level-architecture.md) and the
[idea refinement specification](idea-refinement/spec.md).

## Purpose

Carry increasing, useful and evidence-backed engineering responsibility while remaining simple,
observable and human-governed.

The long-term direction spans, for any connected project:

- **Idea refinement:** decide whether a submitted idea is worth pursuing, and say why.
- **Requirements and design:** define the problem, constraints and intended solution for an
  accepted idea.
- **Finite delivery:** implement, verify, review and complete bounded work.
- **Outcome evaluation:** judge whether a delivered change achieved its intent, what else it
  changed, and whether to keep, improve or revert it.
- **Human judgment:** escalate the questions a human can actually resolve, and no others.

The system owns the work between these stages as far as evidence and reliability allow. It does
not own decisions that depend on knowledge, authority or preference held only by people.

## Enduring principles

**Simple.** Prefer the smallest design that solves a demonstrated problem. Later direction does
not justify speculative infrastructure, extra configuration or unused extension points.

**Deterministic where reliable.** Keep clear rules in ordinary software, especially for execution
and verification. Use agent judgment where deterministic handling would become brittle or need a
growing collection of special cases.

**Evidence-driven.** An interesting idea is not an improvement until evidence supports it. When
uncertainty affects a decision, seek the cheapest evidence that could change it, such as replay,
a prototype, a benchmark or a shadow run, scaled to the decision. Prefer hypotheses, baselines and
measurable outcomes. A working implementation proves correctness, not value.

**Critical.** Challenge Nexus's own proposals and drafts as harshly as external input. "No change
is justified" and "this idea should be rejected" are successful results.

**Prioritized.** Possible work is infinite. An accepted idea still competes with other worthwhile
opportunities, so the system compares and chooses rather than acting on the latest idea.

**Reversible.** Prefer changes that can be evaluated, improved or reverted. Earlier decisions may
become wrong as evidence changes, and reconsidering them is expected.

**Observable.** Retain enough evidence to explain what happened, why a decision was made, what
changed and whether it helped.

**Human-governed.** Autonomy means removing unnecessary human work, not removing humans. Nexus
escalates when a question needs human judgment, and does not hand humans work the system can
complete itself.

## Idea decisions

An idea is a possible project improvement, normally expressed as a need, an opportunity or an
outcome; an architectural improvement may name its proposed direction. Treat a submitted idea as
a proposal to examine, not as the task itself. Reason from the goal and problem behind it: a
request for persistent memory may really mean that agents repeatedly rediscover knowledge, and
documentation, retrieval, better context or no change may serve the problem better. Explicit human
instructions still win.

An idea may be rejected, and delivering no change can be the best outcome for the project.
Rejection is a decision about the idea and its evidence, not a failure of the system.

The system's own difficulty is not evidence about an idea's worth. Refinement effort is bounded:
when its attempts are exhausted, escalation to the human is the correct outcome, not a verdict on
the idea. The human-facing report states how many refinement attempts were used, the last concise
idea brief, what changed during refinement, and the remaining objections that prevented approval.
Exhaustion says that Nexus did not resolve those objections within its limits; it does not itself
mean the idea is unworthy.

Escalation is reserved for questions a human can actually resolve: purpose, priority, risk,
authority or context the project has not recorded. Exhausted refinement is one such question: the
remaining objections are presented for human judgment. A question the system could resolve with
available evidence and time does not become a human task by being hard.

## Long-term direction

Inputs to Nexus include goals, incidents, failures, observations, feedback, ideas and prepared
requests or tasks. An input may lead to work, investigation, deferral, escalation or no action;
evidence and relevance decide which.

The long-term direction seeks ownership of outcomes, not only of changes:

```text
signal / goal / idea
        ↓
understand intent → investigate → refine or reject the idea
        ↓
prioritize against other opportunities
        ↓
requirements and design
        ↓
plan, execute, verify, complete
        ↓
observe the delivered outcome
        ↓
keep / improve / revert
        ↓
learn for the next decision
```

Outcome evaluation distinguishes correctness (did the change work?), outcome (did it produce the
intended improvement?), side effects (what became worse?) and persistence (does the improvement
survive realistic use?). Production behavior becomes evidence, not only a deployment target.

Learning uses prior decisions and their reasons, experiments and outcomes, failed approaches,
incidents, human corrections and rejected ideas. Retained knowledge exists to improve future
decisions, not to accumulate information, and later evidence may justify changing or reverting
earlier conclusions.

## Decision test

Before adding capability or complexity, ask:

1. Does this solve a concrete problem now?
2. Is there a simpler solution?
3. How will we know it helped, and could doing nothing be better?
4. What is the cheapest evidence that would change this decision?
5. Can it be evaluated and reversed?
6. Does a human need to decide this, or can the system resolve it?

## North star

The goal is not maximum autonomy or maximum activity. It is a system that takes increasing
ownership of engineering for connected projects:

```text
observe → reason → investigate → refine or reject → design → deliver
        → verify → evaluate → learn → escalate when a human decision is required
```

Success means carrying more useful, correct, evidence-backed engineering responsibility without
unnecessary human intervention, while knowing when to stop, decline and ask.
