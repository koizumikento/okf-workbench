import {
  hasUnpairedUtf16Surrogate,
  OKF_SEMANTIC_LIMITS,
  utf8ByteLength,
  type OperationProblem,
  type OperationResult,
} from '../model/index.js';
import { inspectFrontmatterPreparse } from '../parser/frontmatter.js';
import { extractMarkdownLinks, inspectMarkdownComplexity } from '../parser/markdown.js';
import { SourceRangeIndex } from '../parser/source-range.js';
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

function problemResult<T>(problem: OperationProblem): OperationResult<T> {
  return { ok: false, problems: [problem] };
}

function metadataProblem(
  code: string,
  message: string,
  correctiveAction: string,
): OperationProblem {
  return { code, message, correctiveAction };
}

function boundedMetadataProblem(
  value: string,
  options: {
    readonly subject: string;
    readonly field: string;
    readonly maxCodeUnits: number;
    readonly maxBytes?: number;
  },
): OperationProblem | undefined {
  if (value.length > options.maxCodeUnits) {
    return metadataProblem(
      `concept-${options.field}-code-unit-limit`,
      `${options.subject} exceeds the ${String(options.maxCodeUnits)}-code-unit safety limit.`,
      `Shorten ${options.subject.toLowerCase()} to at most ${String(options.maxCodeUnits)} UTF-16 code units, then retry.`,
    );
  }
  if (
    options.maxBytes !== undefined &&
    utf8ByteLength(value, options.maxBytes) > options.maxBytes
  ) {
    return metadataProblem(
      `concept-${options.field}-utf8-limit`,
      `${options.subject} exceeds the ${String(options.maxBytes)}-byte UTF-8 safety limit.`,
      `Shorten ${options.subject.toLowerCase()} to at most ${String(options.maxBytes)} UTF-8 bytes, then retry.`,
    );
  }
  if (hasUnpairedUtf16Surrogate(value)) {
    return metadataProblem(
      `concept-${options.field}-unicode-scalar`,
      `${options.subject} contains an unpaired UTF-16 surrogate and cannot be encoded as the submitted Unicode text.`,
      `Remove or replace the malformed Unicode code unit in ${options.subject.toLowerCase()}, then retry.`,
    );
  }
  return undefined;
}

function containsGraphControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

export function normalizeConceptTitleInput(value: string): string {
  return value
    .replace(/\r\n?|\n/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function normalizeConceptDescriptionInput(value: string): string;
export function normalizeConceptDescriptionInput(value: undefined): undefined;
export function normalizeConceptDescriptionInput(value: string | undefined): string | undefined;
export function normalizeConceptDescriptionInput(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return value.replace(/\r\n?|\r/gu, '\n');
}

export function conceptTypeInputProblem(value: unknown): OperationProblem | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return metadataProblem(
      'empty-concept-type',
      'A concept type must contain at least one non-whitespace character.',
      'Enter a built-in or custom OKF concept type.',
    );
  }
  const bounded = boundedMetadataProblem(value, {
    subject: 'Concept type',
    field: 'type',
    maxCodeUnits: OKF_SEMANTIC_LIMITS.maxTypeCodeUnits,
    maxBytes: OKF_SEMANTIC_LIMITS.maxTypeBytes,
  });
  if (bounded !== undefined) {
    return bounded;
  }
  if (containsGraphControl(value)) {
    return metadataProblem(
      'unsafe-concept-type-control',
      'Concept type contains a control character that cannot be used safely by graph filters.',
      'Remove line breaks and control characters from the concept type, then retry.',
    );
  }
  return undefined;
}

export function conceptTitleInputProblem(value: unknown): OperationProblem | undefined {
  if (typeof value !== 'string') {
    return metadataProblem(
      'empty-concept-title',
      'A concept title must be text.',
      'Enter a concise title for the concept.',
    );
  }
  const normalized = normalizeConceptTitleInput(value);
  if (normalized.length === 0) {
    return metadataProblem(
      'empty-concept-title',
      'A concept title must contain at least one non-whitespace character.',
      'Enter a concise title for the concept.',
    );
  }
  return boundedMetadataProblem(normalized, {
    subject: 'Concept title',
    field: 'title',
    maxCodeUnits: OKF_SEMANTIC_LIMITS.maxTitleCodeUnits,
  });
}

export function conceptDescriptionInputProblem(value: unknown): OperationProblem | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    return metadataProblem(
      'invalid-concept-description',
      'Concept description must be text when provided.',
      'Enter a text description or leave the description empty.',
    );
  }
  const normalized = normalizeConceptDescriptionInput(value);
  return boundedMetadataProblem(normalized, {
    subject: 'Concept description',
    field: 'description',
    maxCodeUnits: OKF_SEMANTIC_LIMITS.maxDescriptionCodeUnits,
  });
}

export function conceptTagsInputProblem(value: unknown): OperationProblem | undefined {
  if (!Array.isArray(value)) {
    return metadataProblem(
      'invalid-concept-tags',
      'Concept tags must be a list of text values.',
      'Provide a list of non-empty text tags, or omit tags.',
    );
  }
  if (value.length > OKF_SEMANTIC_LIMITS.maxTagsPerConcept) {
    return metadataProblem(
      'concept-tag-count-limit',
      `Concept metadata contains more than ${String(OKF_SEMANTIC_LIMITS.maxTagsPerConcept)} tags.`,
      `Reduce the tag list to at most ${String(OKF_SEMANTIC_LIMITS.maxTagsPerConcept)} tags, then retry.`,
    );
  }
  for (const tag of value) {
    if (typeof tag !== 'string' || tag.trim().length === 0) {
      return metadataProblem(
        'empty-concept-tag',
        'Concept tags cannot be empty or whitespace-only.',
        'Remove empty tags or replace them with non-empty values.',
      );
    }
    const bounded = boundedMetadataProblem(tag, {
      subject: 'Concept tag',
      field: 'tag',
      maxCodeUnits: OKF_SEMANTIC_LIMITS.maxTagCodeUnits,
      maxBytes: OKF_SEMANTIC_LIMITS.maxTagBytes,
    });
    if (bounded !== undefined) {
      return bounded;
    }
    if (containsGraphControl(tag)) {
      return metadataProblem(
        'unsafe-concept-tag-control',
        'Concept tag contains a control character that cannot be used safely by graph filters.',
        'Remove line breaks and control characters from concept tags, then retry.',
      );
    }
  }
  return undefined;
}

export function conceptTimestampInputProblem(value: unknown): OperationProblem | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return metadataProblem(
      'empty-concept-timestamp',
      'An injected timestamp must be non-empty text.',
      'Provide an ISO 8601 date-time with an explicit offset, or omit the timestamp.',
    );
  }
  const bounded = boundedMetadataProblem(value, {
    subject: 'Concept timestamp',
    field: 'timestamp',
    maxCodeUnits: OKF_SEMANTIC_LIMITS.maxTimestampCodeUnits,
  });
  if (bounded !== undefined) {
    return bounded;
  }
  if (containsGraphControl(value)) {
    return metadataProblem(
      'unsafe-concept-timestamp-control',
      'Concept timestamp contains a control character that cannot be retained safely.',
      'Enter the timestamp on one line without control characters, or omit it.',
    );
  }
  return undefined;
}

/**
 * Normalizes the comma-separated command input without allocating an unbounded split array.
 * Empty comma segments retain the existing command behavior and are omitted.
 */
export function parseConceptTagsInput(value: string): OperationResult<readonly string[]> {
  const tags: string[] = [];
  let start = 0;
  for (let cursor = 0; cursor <= value.length; cursor += 1) {
    if (cursor < value.length && value.charCodeAt(cursor) !== 0x2c) {
      continue;
    }
    const tag = value.slice(start, cursor).trim();
    start = cursor + 1;
    if (tag.length === 0) {
      continue;
    }
    tags.push(tag);
    const problem = conceptTagsInputProblem(tags);
    if (problem !== undefined) {
      return problemResult(problem);
    }
  }
  return { ok: true, value: tags, warnings: [] };
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

function generatedConceptProblem(frontmatter: string, body: string): OperationProblem | undefined {
  const content = `${frontmatter}${body}`;
  if (content.length > OKF_SEMANTIC_LIMITS.maxSemanticDocumentCodeUnits) {
    return metadataProblem(
      'generated-concept-code-unit-limit',
      `Generated concept exceeds the ${String(OKF_SEMANTIC_LIMITS.maxSemanticDocumentCodeUnits)}-code-unit document safety limit.`,
      'Shorten the title, description, or tags, then retry.',
    );
  }
  if (
    utf8ByteLength(content, OKF_SEMANTIC_LIMITS.maxSemanticDocumentBytes) >
    OKF_SEMANTIC_LIMITS.maxSemanticDocumentBytes
  ) {
    return metadataProblem(
      'generated-concept-utf8-limit',
      `Generated concept exceeds the ${String(OKF_SEMANTIC_LIMITS.maxSemanticDocumentBytes)}-byte UTF-8 document safety limit.`,
      'Shorten the title, description, or tags, then retry.',
    );
  }

  const frontmatterInspection = inspectFrontmatterPreparse(content);
  if (frontmatterInspection.kind !== 'success') {
    const detail =
      frontmatterInspection.kind === 'failure'
        ? frontmatterInspection.message
        : 'Generated concept is missing YAML frontmatter.';
    return metadataProblem(
      'generated-concept-frontmatter-limit',
      `Generated concept frontmatter is not consumable: ${detail}`,
      'Shorten or simplify the title, description, or tags, then retry.',
    );
  }

  const markdownInspection = inspectMarkdownComplexity(body);
  if (markdownInspection.failure !== undefined) {
    return metadataProblem(
      'generated-concept-markdown-limit',
      `Generated concept body is not consumable: ${markdownInspection.failure}`,
      'Shorten or simplify the title or description, then retry.',
    );
  }
  const links = extractMarkdownLinks(body, 0, new SourceRangeIndex(body), markdownInspection);
  if (!links.ok) {
    return metadataProblem(
      'generated-concept-markdown-limit',
      `Generated concept body is not consumable: ${links.message}`,
      'Shorten or simplify Markdown link labels and targets, then retry.',
    );
  }
  return undefined;
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

  const typeProblem = conceptTypeInputProblem(input.type);
  if (typeProblem !== undefined) {
    return problemResult(typeProblem);
  }

  const titleProblem = conceptTitleInputProblem(input.title);
  if (titleProblem !== undefined) {
    return problemResult(titleProblem);
  }
  const title = normalizeConceptTitleInput(input.title);

  const descriptionProblem = conceptDescriptionInputProblem(input.description);
  if (descriptionProblem !== undefined) {
    return problemResult(descriptionProblem);
  }
  const normalizedDescription = normalizeConceptDescriptionInput(input.description);
  const description =
    normalizedDescription === undefined || normalizedDescription.trim().length === 0
      ? undefined
      : normalizedDescription;

  const tags: readonly string[] = input.tags === undefined ? [] : input.tags;
  const tagsProblem = conceptTagsInputProblem(tags);
  if (tagsProblem !== undefined) {
    return problemResult(tagsProblem);
  }

  const timestampProblem = conceptTimestampInputProblem(input.timestamp);
  if (timestampProblem !== undefined) {
    return problemResult(timestampProblem);
  }

  const frontmatter = renderTemplateFrontmatter({
    type: input.type,
    title,
    tags,
    ...(description === undefined ? {} : { description }),
    ...(input.timestamp === undefined ? {} : { timestamp: input.timestamp }),
  });
  const body = renderBody(input.template, title, description);
  const consumabilityProblem = generatedConceptProblem(frontmatter, body);
  if (consumabilityProblem !== undefined) {
    return problemResult(consumabilityProblem);
  }
  const content = `${frontmatter}${body}`;

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
