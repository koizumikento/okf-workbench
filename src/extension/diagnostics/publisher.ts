import type { Finding } from '../../core/model/index.js';
import { findingToDiagnostic, type FindingDiagnostic } from './findingDiagnostic.js';

const ORPHAN_CONCEPT_FINDING_CODE = 'okf.curation.orphan-concept';

export interface DiagnosticCollectionPort<TUri, TDiagnostic> {
  clear(): void;
  set(uri: TUri, diagnostics: readonly TDiagnostic[]): void;
  dispose?(): void;
}

export interface RuntimeDiagnosticsSink {
  replace(findings: readonly Finding[]): void;
  clear(): void;
  dispose?(): void;
}

/**
 * Keeps intentionally isolated concepts out of editor decorations. Orphan state remains available
 * in the complete runtime findings and graph, while Problems stays focused on actionable source
 * diagnostics.
 */
export function isEditorDiagnosticFinding(finding: Finding): boolean {
  return finding.code !== ORPHAN_CONCEPT_FINDING_CODE;
}

/** Replaces the complete contents of a dedicated diagnostic collection atomically by URI. */
export class FindingDiagnosticsPublisher<TUri, TDiagnostic> implements RuntimeDiagnosticsSink {
  readonly #collection: DiagnosticCollectionPort<TUri, TDiagnostic>;
  readonly #parseUri: (value: string) => TUri;
  readonly #createDiagnostic: (finding: FindingDiagnostic) => TDiagnostic;

  public constructor(
    collection: DiagnosticCollectionPort<TUri, TDiagnostic>,
    parseUri: (value: string) => TUri,
    createDiagnostic: (finding: FindingDiagnostic) => TDiagnostic,
  ) {
    this.#collection = collection;
    this.#parseUri = parseUri;
    this.#createDiagnostic = createDiagnostic;
  }

  public replace(findings: readonly Finding[]): void {
    const grouped = new Map<string, FindingDiagnostic[]>();
    for (const finding of findings) {
      if (!isEditorDiagnosticFinding(finding)) {
        continue;
      }
      const diagnostic = findingToDiagnostic(finding);
      const current = grouped.get(diagnostic.uri);
      if (current === undefined) {
        grouped.set(diagnostic.uri, [diagnostic]);
      } else {
        current.push(diagnostic);
      }
    }

    const replacements = [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([uri, diagnostics]) => ({
        uri: this.#parseUri(uri),
        diagnostics: diagnostics.map(this.#createDiagnostic),
      }));

    this.#collection.clear();
    for (const replacement of replacements) {
      this.#collection.set(replacement.uri, replacement.diagnostics);
    }
  }

  public clear(): void {
    this.#collection.clear();
  }

  public dispose(): void {
    this.#collection.dispose?.();
  }
}
