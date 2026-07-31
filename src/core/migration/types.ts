import type { ParseBundleInput } from '../parser/index.js';
import type { RenderedTemplateFile } from '../templates/index.js';

export interface MigrationInput {
  readonly bundle: ParseBundleInput;
  readonly actor: string;
}

export interface MigrationDocumentResult {
  readonly relativePath: string;
  readonly changed: boolean;
  readonly manualFollowUp: boolean;
  readonly actions: readonly string[];
  readonly citationCandidates: readonly string[];
}

export interface MigrationPlan {
  readonly fromVersion: string;
  readonly toVersion: '0.2';
  readonly files: readonly RenderedTemplateFile[];
  readonly documents: readonly MigrationDocumentResult[];
}
