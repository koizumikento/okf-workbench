import type { OperationProblem, OperationResult } from '../model/index.js';
import { planIndexes, type IndexConceptInput } from '../indexes/index.js';
import { renderConceptTemplate } from './concepts.js';
import {
  BUNDLE_PRESETS,
  type BundlePreset,
  type BundlePresetInput,
  type ConceptTemplate,
  type RenderedTemplateFile,
} from './types.js';

interface StarterConcept {
  readonly relativePath: string;
  readonly template: ConceptTemplate;
  readonly type: string;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
}

interface BundleDefinition {
  readonly filePaths: readonly string[];
  readonly concepts: readonly StarterConcept[];
}

const SOFTWARE_CONCEPTS: readonly StarterConcept[] = [
  {
    relativePath: 'project-overview.md',
    template: 'generic-concept',
    type: 'project-overview',
    title: 'Project overview',
    description: 'The product purpose, users, scope, and important constraints.',
    tags: ['project', 'overview'],
  },
  {
    relativePath: 'architecture/system-overview.md',
    template: 'generic-concept',
    type: 'architecture',
    title: 'System overview',
    description: 'The system boundaries, components, and important data flows.',
    tags: ['architecture'],
  },
  {
    relativePath: 'decisions/initial-context.md',
    template: 'decision',
    type: 'decision',
    title: 'Initial context',
    description: 'The initial constraints and decisions that shape this project.',
    tags: ['decision', 'context'],
  },
  {
    relativePath: 'playbooks/development.md',
    template: 'playbook',
    type: 'playbook',
    title: 'Development',
    description: 'The repeatable workflow for developing and verifying changes.',
    tags: ['development', 'playbook'],
  },
];

const DATA_CONCEPTS: readonly StarterConcept[] = [
  {
    relativePath: 'data-landscape.md',
    template: 'generic-concept',
    type: 'data-landscape',
    title: 'Data landscape',
    description: 'The important data domains, producers, consumers, and constraints.',
    tags: ['data', 'overview'],
  },
  {
    relativePath: 'datasets/example-dataset.md',
    template: 'data-table',
    type: 'dataset',
    title: 'Example dataset',
    description: 'Replace this starter with a durable description of a real dataset.',
    tags: ['dataset'],
  },
  {
    relativePath: 'metrics/example-metric.md',
    template: 'metric',
    type: 'metric',
    title: 'Example metric',
    description: 'Replace this starter with a precise definition of a real metric.',
    tags: ['metric'],
  },
  {
    relativePath: 'playbooks/data-quality.md',
    template: 'playbook',
    type: 'playbook',
    title: 'Data quality',
    description: 'The repeatable workflow for detecting and resolving data-quality problems.',
    tags: ['data-quality', 'playbook'],
  },
];

export const BUNDLE_PRESET_FILE_PATHS: Readonly<Record<BundlePreset, readonly string[]>> = {
  minimal: ['index.md'],
  'software-project': [
    'index.md',
    'project-overview.md',
    'architecture/index.md',
    'architecture/system-overview.md',
    'decisions/index.md',
    'decisions/initial-context.md',
    'playbooks/index.md',
    'playbooks/development.md',
  ],
  'data-analytics': [
    'index.md',
    'data-landscape.md',
    'datasets/index.md',
    'datasets/example-dataset.md',
    'metrics/index.md',
    'metrics/example-metric.md',
    'playbooks/index.md',
    'playbooks/data-quality.md',
  ],
};

const BUNDLE_DEFINITIONS: Readonly<Record<BundlePreset, BundleDefinition>> = {
  minimal: { filePaths: BUNDLE_PRESET_FILE_PATHS.minimal, concepts: [] },
  'software-project': {
    filePaths: BUNDLE_PRESET_FILE_PATHS['software-project'],
    concepts: SOFTWARE_CONCEPTS,
  },
  'data-analytics': {
    filePaths: BUNDLE_PRESET_FILE_PATHS['data-analytics'],
    concepts: DATA_CONCEPTS,
  },
};

function failure(code: string, message: string, correctiveAction: string): OperationResult<never> {
  const item: OperationProblem = { code, message, correctiveAction };
  return { ok: false, problems: [item] };
}

/** Renders the complete preset in ADR 0005 without reading or writing a workspace. */
export function renderBundlePreset(
  input: BundlePresetInput,
): OperationResult<readonly RenderedTemplateFile[]> {
  if (!BUNDLE_PRESETS.includes(input.preset)) {
    return failure(
      'unknown-bundle-preset',
      `Unknown bundle preset: ${JSON.stringify(input.preset)}.`,
      'Choose Minimal, Software Project, or Data & Analytics.',
    );
  }

  if (typeof input.timestamp !== 'string' || input.timestamp.trim().length === 0) {
    return failure(
      'empty-template-timestamp',
      'Bundle rendering requires a caller-supplied timestamp.',
      'Provide an ISO 8601 date-time with an explicit offset.',
    );
  }

  const definition = BUNDLE_DEFINITIONS[input.preset];
  const renderedConcepts = new Map<string, RenderedTemplateFile>();
  const indexConcepts: IndexConceptInput[] = [];
  for (const concept of definition.concepts) {
    const rendered = renderConceptTemplate({
      template: concept.template,
      relativePath: concept.relativePath,
      type: concept.type,
      title: concept.title,
      description: concept.description,
      tags: concept.tags,
      timestamp: input.timestamp,
    });
    if (!rendered.ok) {
      return rendered;
    }

    renderedConcepts.set(rendered.value.relativePath, rendered.value);
    indexConcepts.push({
      relativePath: rendered.value.relativePath,
      title: concept.title,
      description: concept.description,
    });
  }

  const indexes = planIndexes({
    mode: 'missing-indexes-only',
    concepts: indexConcepts,
    existingIndexes: [],
  });
  if (!indexes.ok) {
    return indexes;
  }

  const renderedIndexes = new Map<string, RenderedTemplateFile>();
  for (const change of indexes.value.changes) {
    renderedIndexes.set(change.relativePath, {
      relativePath: change.relativePath,
      encoding: 'utf8',
      content: change.proposedText,
    });
  }

  const files: RenderedTemplateFile[] = [];
  for (const path of definition.filePaths) {
    const file = renderedConcepts.get(path) ?? renderedIndexes.get(path);
    if (file === undefined) {
      return failure(
        'incomplete-bundle-preset',
        `The ${input.preset} preset did not render ${path}.`,
        'Report this built-in preset defect before applying any files.',
      );
    }
    files.push(file);
  }

  return { ok: true, value: files, warnings: [] };
}
