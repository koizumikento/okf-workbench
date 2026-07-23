'use strict';

/* global exports, process, require, setTimeout, clearTimeout */
/* eslint-disable @typescript-eslint/no-require-imports -- VS Code loads benchmark observer extensions as CommonJS. */

const fs = require('node:fs/promises');

const vscode = require('vscode');

const TRACE_ENVIRONMENT_VARIABLE = 'OKF_QR002_DIAGNOSTICS_TRACE';
const OKF_SOURCES = new Set(['OKF Compatibility', 'OKF Conformance', 'OKF Curation']);
const OKF_EXTENSION_ID = 'straydog.okf-workbench';
const CORRELATION_AUTHORITY = 'okf-acceptance-runtime-publication';

exports.activate = function activate(context) {
  const tracePath = process.env[TRACE_ENVIRONMENT_VARIABLE];
  if (typeof tracePath !== 'string' || tracePath.length === 0) {
    return;
  }

  let captureSequence = 0;
  let captureTimer;
  let pendingWrites = Promise.resolve();

  const capture = async () => {
    captureTimer = undefined;
    const okfExtension = vscode.extensions.getExtension(OKF_EXTENSION_ID);
    const api = okfExtension === undefined ? undefined : await okfExtension.activate();
    const publicationBefore = readRuntimePublication(api);
    const diagnostics = vscode.languages
      .getDiagnostics()
      .flatMap(([uri, values]) =>
        values
          .filter((diagnostic) => OKF_SOURCES.has(diagnostic.source))
          .map((diagnostic) => ({
            uri: uri.toString(),
            code:
              typeof diagnostic.code === 'object' && diagnostic.code !== null
                ? String(diagnostic.code.value)
                : String(diagnostic.code ?? ''),
            source: diagnostic.source,
          })),
      )
      .sort(
        (left, right) =>
          left.uri.localeCompare(right.uri) ||
          left.code.localeCompare(right.code) ||
          left.source.localeCompare(right.source),
      );
    const publicationAfter = readRuntimePublication(api);
    const correlatedPublication =
      sameRuntimePublication(publicationBefore, publicationAfter) &&
      publicationAfter.findingCount === diagnostics.length
        ? publicationAfter
        : undefined;
    const record = {
      schemaVersion: 2,
      sequence: (captureSequence += 1),
      observedAtEpochMs: Date.now(),
      diagnostics,
      diagnosticsCorrelation:
        correlatedPublication === undefined
          ? null
          : {
              authority: CORRELATION_AUTHORITY,
              revision: correlatedPublication.revision,
              diagnosticsPublished: true,
              findingCount: correlatedPublication.findingCount,
              conceptCount: correlatedPublication.conceptCount,
              edgeCount: correlatedPublication.edgeCount,
            },
    };
    pendingWrites = pendingWrites
      .then(() => fs.appendFile(tracePath, `${JSON.stringify(record)}\n`, 'utf8'))
      .catch(() => undefined);
  };

  const scheduleCapture = () => {
    if (captureTimer !== undefined) {
      clearTimeout(captureTimer);
    }
    // FindingDiagnosticsPublisher clears then repopulates its collection synchronously.
    // Coalesce that event burst and observe the final Problems state.
    captureTimer = setTimeout(() => {
      void capture().catch(() => undefined);
    }, 10);
  };

  context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(scheduleCapture), {
    dispose() {
      if (captureTimer !== undefined) clearTimeout(captureTimer);
    },
  });
  scheduleCapture();
};

exports.deactivate = function deactivate() {};

function readRuntimePublication(api) {
  if (
    api === undefined ||
    api === null ||
    typeof api !== 'object' ||
    api.schemaVersion !== 1 ||
    typeof api.getCompletionState !== 'function'
  ) {
    return undefined;
  }
  const publication = api.getCompletionState()?.runtimePublication;
  return publication !== null &&
    typeof publication === 'object' &&
    Number.isSafeInteger(publication.revision) &&
    publication.revision >= 0 &&
    publication.diagnosticsPublished === true &&
    Number.isSafeInteger(publication.findingCount) &&
    publication.findingCount >= 0 &&
    Number.isSafeInteger(publication.conceptCount) &&
    publication.conceptCount >= 0 &&
    Number.isSafeInteger(publication.edgeCount) &&
    publication.edgeCount >= 0
    ? publication
    : undefined;
}

function sameRuntimePublication(left, right) {
  return (
    left !== undefined &&
    right !== undefined &&
    left.revision === right.revision &&
    left.diagnosticsPublished === right.diagnosticsPublished &&
    left.findingCount === right.findingCount &&
    left.conceptCount === right.conceptCount &&
    left.edgeCount === right.edgeCount
  );
}
