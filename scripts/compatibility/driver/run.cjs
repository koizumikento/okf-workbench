'use strict';

/* global clearTimeout, module, process, require, setTimeout */
/* eslint-disable @typescript-eslint/no-require-imports -- VS Code's extension-test bootstrap loads a CommonJS runner. */

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const vscode = require('vscode');

const expectedCommands = [
  'okfWorkbench.initializeBundle',
  'okfWorkbench.newConcept',
  'okfWorkbench.validateBundle',
  'okfWorkbench.regenerateIndexes',
  'okfWorkbench.openGraph',
  'okfWorkbench.setupAgentIntegration',
];

const defaultCompletionTimeoutMs = 20_000;
const guardedQuiescenceMs = 500;
const untrustedWriteCommand = 'okfWorkbench.initializeBundle';

function completionTimeout() {
  const raw = process.env.OKF_ACCEPTANCE_COMPLETION_TIMEOUT_MS;
  if (raw === undefined) return defaultCompletionTimeoutMs;
  const value = Number(raw);
  assert.ok(
    Number.isSafeInteger(value) && value >= 100 && value <= 60_000,
    'OKF_ACCEPTANCE_COMPLETION_TIMEOUT_MS must be an integer between 100 and 60000.',
  );
  return value;
}

function assertAcceptanceApi(value) {
  assert.ok(value && typeof value === 'object', 'The packaged acceptance API was not exposed.');
  assert.equal(value.schemaVersion, 1, 'The packaged acceptance API version is unsupported.');
  for (const method of ['getCompletionState', 'waitForRuntimePublication', 'waitForGraphRender']) {
    assert.equal(typeof value[method], 'function', `Acceptance API method ${method} is missing.`);
  }
  return value;
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout(operation, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label} after ${timeoutMs} ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function installNetworkGuard(attempts) {
  const restorations = [];
  const guarded = [
    ['node:http', ['get', 'request']],
    ['node:https', ['get', 'request']],
    ['node:http2', ['connect']],
    ['node:net', ['connect', 'createConnection']],
    ['node:tls', ['connect']],
    ['node:dns', ['lookup', 'resolve', 'resolve4', 'resolve6']],
    ['node:dgram', ['createSocket']],
  ];
  for (const [moduleName, methods] of guarded) {
    const owner = require(moduleName);
    for (const method of methods) {
      const original = owner[method];
      owner[method] = () => {
        attempts.push(`${moduleName}.${method}`);
        throw new Error(
          `Outbound network access is denied by the acceptance driver: ${moduleName}.${method}`,
        );
      };
      restorations.push(() => {
        owner[method] = original;
      });
    }
  }

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === 'function') {
    globalThis.fetch = () => {
      attempts.push('globalThis.fetch');
      return Promise.reject(
        new Error('Outbound network access is denied by the acceptance driver: fetch'),
      );
    };
    restorations.push(() => {
      globalThis.fetch = originalFetch;
    });
  }
  const OriginalWebSocket = globalThis.WebSocket;
  if (typeof OriginalWebSocket === 'function') {
    globalThis.WebSocket = function DeniedWebSocket() {
      attempts.push('globalThis.WebSocket');
      throw new Error('Outbound network access is denied by the acceptance driver: WebSocket');
    };
    restorations.push(() => {
      globalThis.WebSocket = OriginalWebSocket;
    });
  }
  return () => {
    for (const restore of restorations.reverse()) restore();
  };
}

async function writeReport(reportPath, report) {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function run() {
  const extensionId = process.env.OKF_ACCEPTANCE_EXTENSION_ID ?? 'straydog.okf-workbench';
  const expectedVersion = process.env.OKF_ACCEPTANCE_EXTENSION_VERSION;
  const expectedEditorApiVersion = process.env.OKF_ACCEPTANCE_EDITOR_API_VERSION;
  const mode = process.env.OKF_ACCEPTANCE_MODE ?? 'read-only';
  const reportPath = process.env.OKF_ACCEPTANCE_REPORT_PATH;
  assert.ok(reportPath, 'OKF_ACCEPTANCE_REPORT_PATH is required.');
  assert.ok(
    mode === 'read-only' || mode === 'untrusted' || mode === 'post-uninstall',
    'OKF_ACCEPTANCE_MODE must be read-only, untrusted, or post-uninstall.',
  );
  const report = {
    schemaVersion: 1,
    kind: 'packaged-extension-activation',
    status: 'running',
    recordedAt: new Date().toISOString(),
    extensionId,
    mode,
    editor: {
      version: vscode.version,
      expectedVersion: expectedEditorApiVersion ?? null,
      appName: vscode.env.appName,
      appHost: vscode.env.appHost,
      remoteName: vscode.env.remoteName ?? null,
      uiKind: vscode.env.uiKind,
    },
    runtime: {
      platform: process.platform,
      architecture: process.arch,
      node: process.versions.node ?? null,
      electron: process.versions.electron ?? null,
      chrome: process.versions.chrome ?? null,
      v8: process.versions.v8 ?? null,
    },
    networkAttempts: [],
    commands: [],
    workspaceTrust: {
      expected: mode === 'untrusted' ? false : null,
      actual: vscode.workspace.isTrusted,
    },
    completion: {
      runtimePublication: null,
      graphRender: null,
      guardedQuiescenceMs,
    },
  };
  const restoreNetwork =
    mode === 'post-uninstall' ? () => undefined : installNetworkGuard(report.networkAttempts);

  try {
    if (expectedEditorApiVersion !== undefined) {
      assert.equal(
        vscode.version,
        expectedEditorApiVersion,
        'The Extension Host API version drifted from the compatibility pin.',
      );
    }
    if (mode === 'untrusted') {
      assert.equal(
        vscode.workspace.isTrusted,
        false,
        'The fresh trust-enabled profile unexpectedly trusted the test workspace.',
      );
    }
    if (mode === 'post-uninstall') {
      assert.equal(
        vscode.extensions.getExtension(extensionId),
        undefined,
        `Uninstalled extension ${extensionId} remained visible to the Extension Host.`,
      );
      report.uninstall = { extensionApiAbsent: true };
      report.status = 'passed';
      return;
    }
    const extension = vscode.extensions.getExtension(extensionId);
    assert.ok(extension, `Installed extension ${extensionId} was not found.`);
    if (expectedVersion !== undefined) {
      assert.equal(
        extension.packageJSON.version,
        expectedVersion,
        'Installed extension version drifted.',
      );
    }
    const acceptanceApi = assertAcceptanceApi(await extension.activate());
    const commands = await vscode.commands.getCommands(true);
    report.commands = expectedCommands.filter((command) => commands.includes(command));
    assert.deepEqual(
      report.commands,
      expectedCommands,
      'The packaged extension did not register every command.',
    );

    if (process.env.OKF_ACCEPTANCE_RUN_READ_ONLY_COMMANDS !== '0') {
      const initialCompletion = acceptanceApi.getCompletionState();
      const previousRevision = initialCompletion.runtimePublication?.revision ?? 0;
      await vscode.commands.executeCommand('okfWorkbench.validateBundle');
      report.completion.runtimePublication = await acceptanceApi.waitForRuntimePublication(
        previousRevision,
        completionTimeout(),
      );
      await vscode.commands.executeCommand('okfWorkbench.openGraph');
      report.completion.graphRender = await acceptanceApi.waitForGraphRender(
        report.completion.runtimePublication.revision,
        completionTimeout(),
      );
      await delay(guardedQuiescenceMs);
      report.readOnlyCommands = ['okfWorkbench.validateBundle', 'okfWorkbench.openGraph'];
      report.workspaceTrust.readOnlyAvailable = true;
    }
    if (mode === 'untrusted') {
      const startedAt = Date.now();
      const outcome = await withTimeout(
        vscode.commands.executeCommand(untrustedWriteCommand),
        5_000,
        'the untrusted write-command refusal',
      );
      assert.equal(outcome?.kind, 'refused', 'The untrusted write command was not refused.');
      const problemCodes = Array.isArray(outcome.problems)
        ? outcome.problems
            .map((problem) => problem?.code)
            .filter((code) => typeof code === 'string')
        : [];
      assert.ok(
        problemCodes.includes('workspace-untrusted'),
        'The untrusted write refusal did not include workspace-untrusted.',
      );
      report.untrustedWrite = {
        command: untrustedWriteCommand,
        outcome: outcome.kind,
        problemCodes,
        completedWithoutInputAutomation: true,
        durationMs: Date.now() - startedAt,
      };
    }
    assert.deepEqual(
      report.networkAttempts,
      [],
      'The packaged extension attempted outbound access.',
    );
    report.extensionVersion = extension.packageJSON.version;
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    restoreNetwork();
    await writeReport(reportPath, report);
  }
}

module.exports = { run };
