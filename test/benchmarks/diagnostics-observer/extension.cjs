'use strict';

/* global exports, process, require, setTimeout, clearTimeout */
/* eslint-disable @typescript-eslint/no-require-imports -- VS Code loads benchmark observer extensions as CommonJS. */

const fs = require('node:fs/promises');

const vscode = require('vscode');

const TRACE_ENVIRONMENT_VARIABLE = 'OKF_QR002_DIAGNOSTICS_TRACE';
const OKF_SOURCES = new Set(['OKF Compatibility', 'OKF Conformance', 'OKF Curation']);

exports.activate = function activate(context) {
  const tracePath = process.env[TRACE_ENVIRONMENT_VARIABLE];
  if (typeof tracePath !== 'string' || tracePath.length === 0) {
    return;
  }

  let captureSequence = 0;
  let captureTimer;
  let pendingWrites = Promise.resolve();

  const capture = () => {
    captureTimer = undefined;
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
    const record = {
      schemaVersion: 1,
      sequence: (captureSequence += 1),
      observedAtEpochMs: Date.now(),
      diagnostics,
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
    captureTimer = setTimeout(capture, 10);
  };

  context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(scheduleCapture), {
    dispose() {
      if (captureTimer !== undefined) clearTimeout(captureTimer);
    },
  });
  scheduleCapture();
};

exports.deactivate = function deactivate() {};
