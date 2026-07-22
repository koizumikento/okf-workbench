import type { Finding, SourceRange } from '../../core/model/index.js';

export type FindingDiagnosticSeverity = 'error' | 'warning' | 'information';

/** Editor-neutral diagnostic data used to keep conversion logic unit testable. */
export interface FindingDiagnostic {
  readonly uri: string;
  readonly range: SourceRange | undefined;
  readonly severity: FindingDiagnosticSeverity;
  readonly source: 'OKF Conformance' | 'OKF Curation' | 'OKF Compatibility';
  readonly code: string;
  readonly message: string;
}

export function findingToDiagnostic(finding: Finding): FindingDiagnostic {
  const source =
    finding.category === 'conformance'
      ? 'OKF Conformance'
      : finding.category === 'curation'
        ? 'OKF Curation'
        : 'OKF Compatibility';

  return {
    uri: finding.uri,
    range: finding.range,
    severity: finding.severity,
    source,
    code: finding.code,
    message:
      finding.correctiveAction === undefined
        ? finding.message
        : `${finding.message} Next step: ${finding.correctiveAction}`,
  };
}
