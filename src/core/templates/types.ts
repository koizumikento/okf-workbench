export const BUNDLE_PRESETS = ['minimal', 'software-project', 'data-analytics'] as const;

export type BundlePreset = (typeof BUNDLE_PRESETS)[number];

export const CONCEPT_TEMPLATES = [
  'generic-concept',
  'decision',
  'metric',
  'api-endpoint',
  'data-table',
  'playbook',
  'reference',
  'attested-computation',
] as const;

export type ConceptTemplate = (typeof CONCEPT_TEMPLATES)[number];

export interface RenderedTemplateFile {
  readonly relativePath: string;
  readonly encoding: 'utf8';
  readonly content: string;
}

export interface BundlePresetInput {
  readonly preset: BundlePreset;
  /** Injected by the caller so rendering never reads the clock. */
  readonly timestamp: string;
}

export interface ConceptTemplateInput {
  readonly template: ConceptTemplate;
  /** Bundle-relative Markdown path. Backslashes are normalized to POSIX separators. */
  readonly relativePath: string;
  /** Any non-empty OKF concept type is accepted. */
  readonly type: string;
  readonly title: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  /** Optional injected generation time; rendering never reads the clock. */
  readonly timestamp?: string;
}

export interface ConceptTemplateDefinition {
  readonly id: ConceptTemplate;
  readonly title: string;
  readonly suggestedType: string;
}
