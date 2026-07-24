'use strict';

/* global clearTimeout, module, process, require, setTimeout */
/* eslint-disable @typescript-eslint/no-require-imports -- VS Code's extension-test bootstrap loads a CommonJS runner. */

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const vscode = require('vscode');
const {
  EXPECTED_COMMAND_CATALOG,
  EXPECTED_COMMAND_IDS,
  EXPECTED_WRITE_COMMAND_IDS,
} = require('./command-catalog.cjs');
const {
  activeNetworkObservation,
  installNetworkGuard,
  postUninstallNetworkObservation,
} = require('./network-guard.cjs');

const defaultCompletionTimeoutMs = 20_000;
const guardedQuiescenceMs = 500;
const recoveryCommand = Object.freeze({
  id: 'okfWorkbench.reviewPendingChanges',
  title: 'Review Pending Changes',
});

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
  for (const method of [
    'getCompletionState',
    'getCommandCatalog',
    'waitForRuntimePublication',
    'waitForGraphRender',
    'waitForValidationCompletion',
    'waitForGraphOpenCompletion',
  ]) {
    assert.equal(typeof value[method], 'function', `Acceptance API method ${method} is missing.`);
  }
  return value;
}

function assertCommandCatalog(value) {
  assert.ok(Array.isArray(value), 'The packaged acceptance command catalog is missing.');
  const catalog = value.map((command) => {
    assert.ok(command && typeof command === 'object', 'A command catalog entry is invalid.');
    assert.deepEqual(
      Object.keys(command).sort(),
      ['id', 'title', 'workspaceAccess'],
      `Command catalog entry ${String(command.id)} has an unexpected shape.`,
    );
    assert.ok(
      command.workspaceAccess === 'read' || command.workspaceAccess === 'write',
      `Command catalog entry ${String(command.id)} has invalid workspace access.`,
    );
    return {
      id: command.id,
      title: command.title,
      workspaceAccess: command.workspaceAccess,
    };
  });
  assert.deepEqual(
    catalog,
    EXPECTED_COMMAND_CATALOG,
    'The packaged command catalog drifted from the compatibility contract.',
  );
  return catalog;
}

function assertInstalledCommands(extension, catalog, registeredCommands) {
  const contributed = extension.packageJSON?.contributes?.commands;
  assert.ok(
    Array.isArray(contributed),
    'The installed manifest command contributions are missing.',
  );
  assert.deepEqual(
    contributed.map((command) => ({ id: command.command, title: command.title })),
    [...catalog.map(({ id, title }) => ({ id, title })), recoveryCommand],
    'The installed manifest command IDs or titles drifted from the acceptance catalog.',
  );

  const registeredOkfCommands = registeredCommands
    .filter((command) => command.startsWith('okfWorkbench.'))
    .sort();
  assert.deepEqual(
    registeredOkfCommands,
    [...EXPECTED_COMMAND_IDS, recoveryCommand.id].sort(),
    'The packaged extension did not register exactly the stable command IDs.',
  );
}

function assertCommandTicket(value, expectedCommand) {
  assert.ok(value && typeof value === 'object', `${expectedCommand} did not return a ticket.`);
  assert.equal(
    value.kind,
    'okf-acceptance-command',
    `${expectedCommand} was cancelled, refused, or failed before scheduling completion.`,
  );
  assert.equal(value.command, expectedCommand, `${expectedCommand} returned the wrong ticket.`);
  assert.ok(
    Number.isSafeInteger(value.requestId) && value.requestId > 0,
    `${expectedCommand} returned an invalid request ID.`,
  );
  return value;
}

function assertCompletionState(value) {
  assert.ok(value && typeof value === 'object', 'Acceptance completion state is missing.');
  if (value.runtimePublication !== null) {
    assert.ok(
      Number.isSafeInteger(value.runtimePublication?.revision) &&
        value.runtimePublication.revision >= 0,
      'Acceptance runtime revision is invalid.',
    );
  }
  return value;
}

function assertRuntimePublication(value, requestId, afterRevision) {
  assert.ok(value && typeof value === 'object', 'Runtime publication completion is missing.');
  assert.equal(value.requestId, requestId, 'Validate completed with the wrong request ID.');
  assert.ok(
    Number.isSafeInteger(value.revision) && value.revision > afterRevision,
    'Validate did not publish a newer runtime revision.',
  );
  assert.equal(
    value.diagnosticsPublished,
    true,
    'Validate completed without publishing diagnostics.',
  );
  for (const count of ['findingCount', 'conceptCount', 'edgeCount']) {
    assert.ok(
      Number.isSafeInteger(value[count]) && value[count] >= 0,
      `Runtime publication ${count} is invalid.`,
    );
  }
  return value;
}

function assertGraphRender(value, requestId, minimumRevision) {
  assert.ok(value && typeof value === 'object', 'Graph render completion is missing.');
  assert.equal(value.requestId, requestId, 'Open Graph completed with the wrong request ID.');
  assert.ok(
    Number.isSafeInteger(value.revision) && value.revision > minimumRevision,
    'Open Graph did not apply a fresh post-command runtime revision in the Webview.',
  );
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
  const observesNetwork = mode !== 'post-uninstall';
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
    networkAttempts: observesNetwork ? [] : null,
    networkObservation: observesNetwork ? null : postUninstallNetworkObservation(),
    commands: [],
    commandCatalog: [],
    workspaceTrust: {
      expected: mode === 'untrusted' ? false : null,
      actual: vscode.workspace.isTrusted,
    },
    completion: {
      runtimePublication: null,
      graphRender: null,
      guardedQuiescenceMs: observesNetwork ? guardedQuiescenceMs : null,
    },
  };
  if (observesNetwork) {
    const networkGuard = installNetworkGuard(report.networkAttempts);
    report.networkObservation = activeNetworkObservation(
      networkGuard.interceptedMethods,
      guardedQuiescenceMs,
    );
  }

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
    const commandCatalog = assertCommandCatalog(acceptanceApi.getCommandCatalog());
    const commands = await vscode.commands.getCommands(true);
    assertInstalledCommands(extension, commandCatalog, commands);
    report.commands = [...EXPECTED_COMMAND_IDS];
    report.commandCatalog = commandCatalog;

    if (process.env.OKF_ACCEPTANCE_RUN_READ_ONLY_COMMANDS !== '0') {
      const timeoutMs = completionTimeout();
      const initialCompletion = assertCompletionState(acceptanceApi.getCompletionState());
      const previousRevision = initialCompletion.runtimePublication?.revision ?? 0;
      const validationTicket = assertCommandTicket(
        await withTimeout(
          vscode.commands.executeCommand('okfWorkbench.validateBundle'),
          timeoutMs,
          'the Validate command dispatch',
        ),
        'validateBundle',
      );
      report.completion.runtimePublication = assertRuntimePublication(
        await withTimeout(
          acceptanceApi.waitForValidationCompletion(validationTicket.requestId, timeoutMs),
          timeoutMs + 1_000,
          'Validate diagnostics and runtime publication',
        ),
        validationTicket.requestId,
        previousRevision,
      );

      const graphTicket = assertCommandTicket(
        await withTimeout(
          vscode.commands.executeCommand('okfWorkbench.openGraph'),
          timeoutMs,
          'the Open Graph command dispatch',
        ),
        'openGraph',
      );
      report.completion.graphRender = assertGraphRender(
        await withTimeout(
          acceptanceApi.waitForGraphOpenCompletion(graphTicket.requestId, timeoutMs),
          timeoutMs + 1_000,
          'the Open Graph Webview data-application acknowledgement',
        ),
        graphTicket.requestId,
        report.completion.runtimePublication.revision,
      );
      report.readOnlyCommands = ['okfWorkbench.validateBundle', 'okfWorkbench.openGraph'];
      report.workspaceTrust.readOnlyAvailable = true;
    }
    if (mode === 'untrusted') {
      report.untrustedWrites = [];
      for (const command of EXPECTED_WRITE_COMMAND_IDS) {
        const startedAt = Date.now();
        const outcome = await withTimeout(
          vscode.commands.executeCommand(command),
          5_000,
          `the untrusted refusal for ${command}`,
        );
        assert.equal(outcome?.kind, 'refused', `${command} was not refused when untrusted.`);
        const problemCodes = Array.isArray(outcome.problems)
          ? outcome.problems
              .map((problem) => problem?.code)
              .filter((code) => typeof code === 'string')
          : [];
        assert.ok(
          problemCodes.includes('workspace-untrusted'),
          `${command} refusal did not include workspace-untrusted.`,
        );
        report.untrustedWrites.push({
          command,
          outcome: outcome.kind,
          problemCodes,
          completedWithoutInputAutomation: true,
          durationMs: Date.now() - startedAt,
        });
      }
    }
    await delay(guardedQuiescenceMs);
    assert.deepEqual(
      report.networkAttempts,
      [],
      'The packaged extension attempted outbound access.',
    );
    report.networkObservation.result = 'zero-attempts-observed';
    report.extensionVersion = extension.packageJSON.version;
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await writeReport(reportPath, report);
    // Active phases intentionally retain the hooks after the report is written. The Extension Host
    // process exit is the boundary; restoring them earlier would leave an unobserved tail window.
  }
}

module.exports = { run };
