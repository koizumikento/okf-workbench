import type { OperationProblem, OperationResult } from '../model/index.js';
import { normalizeConceptPath } from './path.js';
import {
  CONCEPT_TEMPLATES,
  type ConceptTemplate,
  type ConceptTemplateDefinition,
  type ConceptTemplateInput,
  type RenderedTemplateFile,
} from './types.js';
import { renderTemplateFrontmatter } from './yaml.js';

export const CONCEPT_TEMPLATE_DEFINITIONS: readonly ConceptTemplateDefinition[] = [
  { id: 'generic-concept', title: 'Generic Concept', suggestedType: 'concept' },
  { id: 'decision', title: 'Decision', suggestedType: 'decision' },
  { id: 'metric', title: 'Metric', suggestedType: 'metric' },
  { id: 'api-endpoint', title: 'API Endpoint', suggestedType: 'api-endpoint' },
  { id: 'data-table', title: 'Data Table', suggestedType: 'data-table' },
  { id: 'playbook', title: 'Playbook', suggestedType: 'playbook' },
  { id: 'reference', title: 'Reference', suggestedType: 'reference' },
];

const BODY_SECTIONS: Readonly<Record<ConceptTemplate, readonly string[]>> = {
  'generic-concept': [
    '## Summary',
    '',
    'Describe the durable knowledge captured by this concept.',
    '',
    '## Details',
    '',
    'Add relevant context, constraints, and links.',
  ],
  decision: [
    '## Status',
    '',
    'Proposed',
    '',
    '## Context',
    '',
    'Describe the forces that require a decision.',
    '',
    '## Decision',
    '',
    'Record the chosen direction.',
    '',
    '## Consequences',
    '',
    'Record the important trade-offs and follow-up work.',
  ],
  metric: [
    '## Definition',
    '',
    'Define what the metric measures and why it matters.',
    '',
    '## Calculation',
    '',
    'Describe the formula, dimensions, and source data.',
    '',
    '## Interpretation',
    '',
    'Explain expected ranges and important caveats.',
  ],
  'api-endpoint': [
    '## Contract',
    '',
    'Document the method, path, request, and response.',
    '',
    '## Authentication',
    '',
    'Describe access requirements without recording secrets.',
    '',
    '## Failure modes',
    '',
    'List actionable error behavior and retry expectations.',
  ],
  'data-table': [
    '## Purpose',
    '',
    "Describe the table's business or analytical purpose.",
    '',
    '## Grain and keys',
    '',
    'Record row grain, primary keys, and important relationships.',
    '',
    '## Columns',
    '',
    'Document important columns and quality constraints.',
  ],
  playbook: [
    '## When to use',
    '',
    'Describe the trigger and prerequisites.',
    '',
    '## Steps',
    '',
    '1. Add the first repeatable step.',
    '',
    '## Verification',
    '',
    'Describe how to confirm the procedure succeeded.',
  ],
  reference: [
    '## Reference',
    '',
    'Summarize the durable information supplied by the referenced resource.',
    '',
    '## Relevance',
    '',
    'Explain when and why maintainers should consult it.',
  ],
};

function renderFailure(
  code: string,
  message: string,
  correctiveAction: string,
): OperationResult<never> {
  const problem: OperationProblem = { code, message, correctiveAction };
  return { ok: false, problems: [problem] };
}

function normalizeOneLine(value: string): string {
  return value
    .replace(/\r\n?|\n/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeDescription(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return value.replace(/\r\n?|\r/gu, '\n');
}

function renderBody(
  template: ConceptTemplate,
  title: string,
  description: string | undefined,
): string {
  const lines = [`# ${title}`, ''];
  if (description !== undefined && description.trim().length > 0) {
    lines.push(description, '');
  }

  lines.push(...BODY_SECTIONS[template]);
  return `${lines.join('\n')}\n`;
}

export function renderConceptTemplate(
  input: ConceptTemplateInput,
): OperationResult<RenderedTemplateFile> {
  if (!CONCEPT_TEMPLATES.includes(input.template)) {
    return renderFailure(
      'unknown-concept-template',
      `Unknown concept template: ${JSON.stringify(input.template)}.`,
      'Choose one of the built-in concept templates.',
    );
  }

  const path = normalizeConceptPath(input.relativePath);
  if (!path.ok) {
    return path;
  }

  if (typeof input.type !== 'string' || input.type.trim().length === 0) {
    return renderFailure(
      'empty-concept-type',
      'A concept type must contain at least one non-whitespace character.',
      'Enter a built-in or custom OKF concept type.',
    );
  }

  const title = normalizeOneLine(input.title);
  if (title.length === 0) {
    return renderFailure(
      'empty-concept-title',
      'A concept title must contain at least one non-whitespace character.',
      'Enter a concise title for the concept.',
    );
  }

  const tags = input.tags ?? [];
  if (tags.some((tag) => typeof tag !== 'string' || tag.trim().length === 0)) {
    return renderFailure(
      'empty-concept-tag',
      'Concept tags cannot be empty or whitespace-only.',
      'Remove empty tags or replace them with non-empty values.',
    );
  }

  if (input.timestamp !== undefined && input.timestamp.trim().length === 0) {
    return renderFailure(
      'empty-concept-timestamp',
      'An injected timestamp cannot be empty.',
      'Provide an ISO 8601 date-time with an explicit offset, or omit the timestamp.',
    );
  }

  const description = normalizeDescription(input.description);
  const frontmatter = renderTemplateFrontmatter({
    type: input.type,
    title,
    tags,
    ...(description === undefined ? {} : { description }),
    ...(input.timestamp === undefined ? {} : { timestamp: input.timestamp }),
  });
  const content = `${frontmatter}${renderBody(input.template, title, description)}`;

  return {
    ok: true,
    value: {
      relativePath: path.value,
      encoding: 'utf8',
      content,
    },
    warnings: [],
  };
}
