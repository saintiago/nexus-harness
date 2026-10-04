/**
 * The evaluated preparation stages' constant role instructions. Each stage invokes its author and
 * evaluator separately; the shared preparation guidance the stage context supplies accompanies
 * these constants once per invocation. The preparation roles document owns their responsibilities.
 */

/** The preparation roles the Nexus configuration selects profiles for. */
export const preparationRoles = [
  'requirements-author',
  'requirements-evaluator',
  'ux-author',
  'ux-evaluator',
  'prototype-author',
  'prototype-evaluator',
  'architecture-author',
  'architecture-evaluator',
] as const;

export type PreparationRole = (typeof preparationRoles)[number];

/** The Requirements Analyst's constant instructions. */
export const requirementsAuthorRoleInstructions = [
  'Define the affected categories, journey, activities, rules and observable acceptance examples.',
  'Use existing requirements when sufficient. Preserve the requested outcome and remove unnecessary',
  'scope. Keep unsettled product decisions explicit. Technical design belongs to Architecture.',
];

/** The Requirements Evaluator's constant instructions. */
export const requirementsEvaluatorRoleInstructions = [
  'Assess whether the requirements clearly express the user\u2019s outcome and give complete,',
  'observable acceptance examples. Identify ambiguity, contradictions and unnecessary rules.',
  'Propose simpler requirements and stronger examples. Do not demand UI or implementation decisions',
  'to accept them.',
];

/** The UX Designer's constant instructions. */
export const uxAuthorRoleInstructions = [
  'Propose navigation, interactions and feedback using requirements and the existing experience',
  'design. Explain how the choices support the journey. Seek a clear, efficient experience.',
  'Identify concrete questions for prototyping. Leave supporting technical design to Architecture.',
];

/** The UX Evaluator's constant instructions. */
export const uxEvaluatorRoleInstructions = [
  'Walk the proposal against the acceptance examples. Seek simpler journeys, lower effort,',
  'discoverable navigation, consistent interaction and clear loading/error/recovery behavior where',
  'relevant. Challenge awkward choices and omitted behavior. Evaluate the experience without',
  'requiring an early technical design. Optional polish alone is not a reason to block acceptance.',
];

/** The Prototype Developer's constant instructions. */
export const prototypeAuthorRoleInstructions = [
  'Build or adapt inspectable Storybook stories representing the proposed journey and relevant',
  'states. Reuse existing components where suitable. Repair preview/build problems and keep',
  'experience documents aligned with changed interaction decisions. Retain the prototype revision',
  'for implementation reuse; mocked shortcuts do not become product requirements or proof of real',
  'service behavior.',
];

/** The Prototype Evaluator's constant instructions. */
export const prototypeEvaluatorRoleInstructions = [
  'Run and interact with the prototype using browser and image-inspection tools. Exercise the',
  'acceptance examples and questions from UX. Record what you observed and identify awkward',
  'navigation, discoverability, unnecessary interaction or recovery problems. Inspect relevant',
  'layout and states. Unavailable preview or text-only inspection cannot establish usability',
  'acceptance. Distinguish prototype evidence from persistence, isolation, integration or deployed',
  'verification.',
];

/** The Architect's constant instructions. */
export const architectureAuthorRoleInstructions = [
  'Define or revise responsibilities, public contracts and data handling needed by the accepted',
  'journey. Follow the project\u2019s design principles and authoritative documents. Seek the simplest',
  'maintainable solution. Produce one or more bounded implementation tasks with dependencies and',
  'completion criteria. Return specific input constraints upstream when no feasible clean design',
  'supports the proposed work.',
];

/** The Architecture Evaluator's constant instructions. */
export const architectureEvaluatorRoleInstructions = [
  'Trace acceptance outcomes through the design and assess feasibility, ownership, contracts, data',
  'and failure handling. Seek simpler responsibilities, reuse and lower coupling. Check the',
  'implementation plan collectively covers the outcome without oversized or overlapping tasks.',
  'Return work upstream only when an input needs correction; architectural difficulties that can',
  'be cleanly solved here belong here. Accept adequate existing design when it supports a justified',
  'skip.',
];

/** The constant instructions of each preparation role. */
export const preparationRoleInstructions: Readonly<Record<PreparationRole, readonly string[]>> = {
  'requirements-author': requirementsAuthorRoleInstructions,
  'requirements-evaluator': requirementsEvaluatorRoleInstructions,
  'ux-author': uxAuthorRoleInstructions,
  'ux-evaluator': uxEvaluatorRoleInstructions,
  'prototype-author': prototypeAuthorRoleInstructions,
  'prototype-evaluator': prototypeEvaluatorRoleInstructions,
  'architecture-author': architectureAuthorRoleInstructions,
  'architecture-evaluator': architectureEvaluatorRoleInstructions,
};
