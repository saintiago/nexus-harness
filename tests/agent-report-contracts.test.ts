/**
 * Focused integration tests: every agent response contract derives a provider-compatible JSON
 * Schema, describes each field it supplies, and omits the metadata its owning action adds to the
 * saved record. The check walks the derived schemas itself instead of trusting the caller's
 * conversion, so an unsupported or under-described contract fails here rather than at a live
 * invocation.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
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
    actionAdded: ['taskKey', 'profile', 'baseRevision', 'headRevision'],
  },
  {
    label: 'Reviewer',
    schema: reviewResponseSchema,
    actionAdded: ['profile', 'headRevision'],
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
