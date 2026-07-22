import {
  Diagnostic,
  DiagnosticSeverity,
  Position,
  Range,
  Uri,
  type DiagnosticCollection,
} from 'vscode';

import type { FindingDiagnostic } from './findingDiagnostic.js';
import { FindingDiagnosticsPublisher } from './publisher.js';

function toVscodeDiagnostic(finding: FindingDiagnostic): Diagnostic {
  const range =
    finding.range === undefined
      ? new Range(0, 0, 0, 0)
      : new Range(
          new Position(finding.range.start.line, finding.range.start.character),
          new Position(finding.range.end.line, finding.range.end.character),
        );
  const severity =
    finding.severity === 'error'
      ? DiagnosticSeverity.Error
      : finding.severity === 'warning'
        ? DiagnosticSeverity.Warning
        : DiagnosticSeverity.Information;
  const diagnostic = new Diagnostic(range, finding.message, severity);
  diagnostic.code = finding.code;
  diagnostic.source = finding.source;
  return diagnostic;
}

export function createVscodeDiagnosticsPublisher(
  collection: DiagnosticCollection,
): FindingDiagnosticsPublisher<Uri, Diagnostic> {
  return new FindingDiagnosticsPublisher<Uri, Diagnostic>(
    {
      clear: () => collection.clear(),
      set: (uri, diagnostics) => collection.set(uri, diagnostics),
      dispose: () => collection.dispose(),
    },
    (value) => Uri.parse(value, true),
    toVscodeDiagnostic,
  );
}
