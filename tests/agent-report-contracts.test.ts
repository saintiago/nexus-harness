/**
 * Focused integration tests: every agent response contract derives a provider-compatible JSON
 * Schema, describes each field it supplies, and omits the metadata its owning action adds to the
 * saved record. The check walks the derived schemas itself instead of trusting the caller's
 * conversion, so an unsupported or under-described contract fails here rather than at a live
 * invocation.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseAgentReport } from '../src/task-engine/actions/agent-reports.js';
import { recoveryReportSchema } from '../src/application/recovery.js';
import { experienceAnalysisResponseSchema } from '../src/task-engine/actions/analyze-experience/artifacts.js';
import { challengerResponseSchema } from '../src/task-engine/actions/challenger/artifacts.js';
import { developmentResponseSchema } from '../src/task-engine/actions/develop/artifacts.js';
import {
  editorTurnResponseSchema,
  framingResponseSchema,
} from '../src/task-engine/actions/idea-editor/artifacts.js';
import { prototypeObservationSchema } from '../src/task-engine/actions/preparation/observation.js';
import {
  stageAuthorResponseSchema,
  stageEvaluationResponseSchema,
} from '../src/task-engine/actions/preparation/artifacts.js';
import { projectGuideResponseSchema } from '../src/task-engine/actions/project-guide/artifacts.js';
import { researchResponseSchema } from '../src/task-engine/actions/researcher/artifacts.js';
import { reviewResponseSchema } from '../src/task-engine/actions/review/artifacts.js';

/** One agent report declaration: its role/variant and the metadata the owning action adds. */
type ReportContract = {
  readonly label: string;
  readonly schema: z.ZodType;
  /**
   * Fields the owning action binds into its saved record. The response contract must not carry
   * them: the caller supplies the observed identity, revision and acceptance basis itself.
   */
  readonly actionAdded: readonly string[];
};

/** Every audited response contract and the action metadata its saved artifact adds. */
const reportContracts: readonly ReportContract[] = [
  { label: 'Idea editor framing', schema: framingResponseSchema, actionAdded: [] },
  {
    label: 'Idea editor edit/respond/after-help',
    schema: editorTurnResponseSchema,
    actionAdded: [],
  },
  { label: 'Researcher initial/focused', schema: researchResponseSchema, actionAdded: [] },
  { label: 'Project guide initial/focused', schema: projectGuideResponseSchema, actionAdded: [] },
  {
    label: 'Challenger',
    schema: challengerResponseSchema,
    actionAdded: ['refinedIdea', 'editorResponse', 'revision'],
  },
  {
    label: 'Preparation author',
    schema: stageAuthorResponseSchema,
    actionAdded: ['stage', 'revision'],
  },
  {
    label: 'Preparation evaluator',
    schema: stageEvaluationResponseSchema,
    actionAdded: ['basis'],
  },
  {
    label: 'Developer',
    schema: developmentResponseSchema,
    actionAdded: [
      'taskKey',
      'profile',
      'baseRevision',
      'headRevision',
      'role',
      'report',
      'reportIdentity',
      'invocationId',
      'readinessFailure',
    ],
  },
  {
    label: 'Reviewer',
    schema: reviewResponseSchema,
    actionAdded: [
      'taskKey',
      'profile',
      'headRevision',
      'role',
      'report',
      'reportIdentity',
      'invocationId',
    ],
  },
  { label: 'Recovery', schema: recoveryReportSchema, actionAdded: [] },
  {
    label: 'Experience analyst',
    schema: experienceAnalysisResponseSchema,
    actionAdded: [
      'identity',
      'workId',
      'project',
      'workflow',
      'attemptId',
      'terminalId',
      'profile',
      'analyzedAt',
    ],
  },
  { label: 'Prototype observation record', schema: prototypeObservationSchema, actionAdded: [] },
];

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Walk one derived schema and collect every place it would not meet the provider's structured
 * output requirements or does not describe a field the agent supplies.
 */
function schemaProblems(node: unknown, at: string, problems: string[]): void {
  if (!isObject(node)) {
    return;
  }
  if (node['type'] === 'object' && node['properties'] !== undefined) {
    const properties = isObject(node['properties']) ? node['properties'] : {};
    const names = Object.keys(properties);
    const required = Array.isArray(node['required']) ? (node['required'] as unknown[]) : [];
    for (const name of names) {
      if (!required.includes(name)) {
        problems.push(`${at}.${name} is not required`);
      }
    }
    if (node['additionalProperties'] !== false) {
      problems.push(`${at} does not forbid additional properties`);
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'required' || key === 'type') {
      continue;
    }
    if (key === 'properties') {
      for (const [name, property] of Object.entries(value as JsonObject)) {
        if (
          !isObject(property) ||
          typeof property['description'] !== 'string' ||
          property['description'].trim() === ''
        ) {
          problems.push(`${at}.${name} has no field description`);
        }
        schemaProblems(property, `${at}.${name}`, problems);
      }
      continue;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => schemaProblems(item, `${at}.${key}[${index}]`, problems));
      continue;
    }
    schemaProblems(value, `${at}.${key}`, problems);
  }
}

describe('agent report contracts', () => {
  it('derives a provider-compatible schema for every response contract', () => {
    for (const { label, schema } of reportContracts) {
      const derived = z.toJSONSchema(schema) as JsonObject;
      expect(derived['type'], `${label} root type`).toBe('object');
      const problems: string[] = [];
      schemaProblems(derived, label, problems);
      expect(problems, label).toEqual([]);
    }
  });

  it('omits the metadata its owning action adds to the saved record', () => {
    for (const { label, schema, actionAdded } of reportContracts) {
      const properties = (z.toJSONSchema(schema) as JsonObject)['properties'] as JsonObject;
      for (const field of actionAdded) {
        expect(properties[field], `${label} must not declare the action-added ${field}`).toBe(
          undefined,
        );
      }
    }
  });
});

/** One current finding, as the reviewer and evaluation contracts report it. */
const reportedFindingSample = {
  title: 'The contract accepts a stray field',
  severity: 'blocking',
  basis: 'The response contract forbids unknown fields.',
  evidence: 'A report with an unexpected field was accepted.',
  impact: 'Invalid reports become usable artifacts.',
  repairGuidance: 'Reject unknown fields.',
  locations: [{ path: 'src/task-engine/actions/agent-reports.ts', line: null }],
};

/** One minimal response that satisfies each audited contract and exercises its nested objects. */
const reportSamples: readonly {
  readonly label: string;
  readonly schema: z.ZodType;
  readonly sample: unknown;
}[] = [
  {
    label: 'Idea editor framing',
    schema: framingResponseSchema,
    sample: {
      framing: 'The proposal.',
      questions: ['Which scope?'],
      authorDecision: { question: 'Which scope?' },
    },
  },
  {
    label: 'Idea editor edit/respond/after-help',
    schema: editorTurnResponseSchema,
    sample: {
      disposition: 'help-requested',
      response: 'I need one focused answer before I can revise.',
      reason: null,
      help: { researcher: 'What evidence supports the scope?', projectGuide: null },
      refinedIdea: null,
    },
  },
  {
    label: 'Researcher initial/focused',
    schema: researchResponseSchema,
    sample: {
      contribution: 'The contribution.',
      findings: ['A finding.'],
      options: ['An option.'],
      sources: [{ title: 'Source', link: 'https://example.com', accessed: null }],
    },
  },
  {
    label: 'Project guide initial/focused',
    schema: projectGuideResponseSchema,
    sample: {
      contribution: 'The contribution.',
      fit: 'The fit.',
      steering: ['Steer.'],
      constraints: ['A constraint.'],
      evidence: ['docs/purpose.md'],
      provisional: false,
      uncertainty: [],
    },
  },
  {
    label: 'Challenger',
    schema: challengerResponseSchema,
    sample: {
      verdict: 'discuss',
      assessment: 'One concern still changes the decision.',
      obstacle: 'The scope is not yet bounded.',
      concerns: [
        {
          concern: 'The scope is broad.',
          consequence: 'The change would take longer than needed.',
          resolution: 'Bound the first increment.',
        },
      ],
      suggestions: [],
    },
  },
  {
    label: 'Preparation author',
    schema: stageAuthorResponseSchema,
    sample: {
      outcome: 'skip-proposed',
      summary: 'Existing inputs suffice.',
      documents: [],
      sourcePaths: [],
      observation: null,
      plan: [],
      skip: { reason: 'Existing inputs suffice.', references: ['docs/existing.md'] },
      question: null,
      upstream: null,
    },
  },
  {
    label: 'Preparation evaluator',
    schema: stageEvaluationResponseSchema,
    sample: {
      assessedRevision: 1,
      verdict: 'changes-requested',
      reason: 'One finding remains.',
      observation: null,
      findings: [reportedFindingSample],
      upstream: null,
    },
  },
  {
    label: 'Developer',
    schema: developmentResponseSchema,
    sample: {
      status: 'completed',
    },
  },
  {
    label: 'Reviewer',
    schema: reviewResponseSchema,
    sample: {
      verdict: 'changesRequested',
    },
  },
  {
    label: 'Recovery',
    schema: recoveryReportSchema,
    sample: { summary: 'Resumed.', decision: { kind: 'resume' } },
  },
  {
    label: 'Experience analyst',
    schema: experienceAnalysisResponseSchema,
    sample: {
      observations: [{ content: 'One reusable lesson.', evidence: [], relatedMemories: [] }],
    },
  },
  {
    label: 'Prototype observation record',
    schema: prototypeObservationSchema,
    sample: {
      role: 'author',
      content: [{ path: 'stories/journey.ts', revision: 'a'.repeat(40), exists: true }],
      preview: { command: 'npm run storybook', url: 'http://localhost:6006' },
      journeys: [
        {
          example: 'The journey.',
          state: 'Loaded.',
          actions: ['Open the page.'],
          observed: 'The page loaded.',
          screenshots: [{ path: 'shot.png' }],
          visualConclusion: 'The layout is intact.',
        },
      ],
    },
  },
];

/** One value with `unexpectedClaim` added at the root, or in the first nested object. */
function withUnexpectedField(sample: unknown, where: 'root' | 'nested'): unknown {
  const cloned = JSON.parse(JSON.stringify(sample)) as Record<string, unknown>;
  const target = where === 'root' ? cloned : firstNestedObject(cloned);
  if (target === null) {
    throw new Error('the sample declares no nested object');
  }
  target['unexpectedClaim'] = 'not part of the contract';
  return cloned;
}

/** The first object nested below the sample's root, found in declaration order. */
function firstNestedObject(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        return item as Record<string, unknown>;
      }
      const found = firstNestedObject(item);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const children = Object.values(value);
  for (const child of children) {
    if (typeof child === 'object' && child !== null && !Array.isArray(child)) {
      return child as Record<string, unknown>;
    }
  }
  for (const child of children) {
    const found = firstNestedObject(child);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/** True when the derived schema declares an object below its root. */
function declaresNestedObject(node: unknown, atRoot: boolean): boolean {
  if (!isObject(node)) {
    return false;
  }
  if (!atRoot && node['type'] === 'object' && node['properties'] !== undefined) {
    return true;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'required' || key === 'type') {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.some((item) => declaresNestedObject(item, false))) {
        return true;
      }
      continue;
    }
    if (declaresNestedObject(value, false)) {
      return true;
    }
  }
  return false;
}

describe('producer-boundary report parsing', () => {
  it('accepts every minimal contract sample and rejects an unexpected root field', () => {
    for (const { label, schema, sample } of reportSamples) {
      expect(() => parseAgentReport(JSON.stringify(sample), schema, label), label).not.toThrow();
      expect(
        () => parseAgentReport(JSON.stringify(withUnexpectedField(sample, 'root')), schema, label),
        label,
      ).toThrow(/Unrecognized key.*unexpectedClaim/);
    }
  });

  it('rejects an unexpected field inside every nested object a contract declares', () => {
    for (const { label, schema, sample } of reportSamples) {
      const derived = z.toJSONSchema(schema) as JsonObject;
      if (!declaresNestedObject(derived, true)) {
        // The contract declares no nested object a stray field could be planted in.
        continue;
      }
      expect(
        () =>
          parseAgentReport(JSON.stringify(withUnexpectedField(sample, 'nested')), schema, label),
        label,
      ).toThrow(/Unrecognized key.*unexpectedClaim/);
    }
  });
});
