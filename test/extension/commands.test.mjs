import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import * as vscode from 'vscode';

const require = createRequire(import.meta.url);
const extensionId = process.env.OKF_WORKBENCH_EXTENSION_ID ?? 'straydog.okf-workbench';
const expectedCommandIds = [
  'okfWorkbench.initializeBundle',
  'okfWorkbench.newConcept',
  'okfWorkbench.validateBundle',
  'okfWorkbench.regenerateIndexes',
  'okfWorkbench.openGraph',
  'okfWorkbench.setupAgentIntegration',
];
const recoveryCommandId = 'okfWorkbench.reviewPendingChanges';

async function withExtensionHostNetworkDenied(action) {
  const attempts = [];
  const restorations = [];
  const guardedMethods = [
    ['node:http', ['get', 'request']],
    ['node:https', ['get', 'request']],
    ['node:net', ['connect', 'createConnection']],
    ['node:tls', ['connect']],
  ];

  for (const [moduleName, methodNames] of guardedMethods) {
    const owner = require(moduleName);
    for (const methodName of methodNames) {
      const original = owner[methodName];
      owner[methodName] = () => {
        attempts.push(`${moduleName}.${methodName}`);
        throw new Error(
          `Outbound network access is disabled during activation: ${moduleName}.${methodName}`,
        );
      };
      restorations.push(() => {
        owner[methodName] = original;
      });
    }
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    attempts.push('globalThis.fetch');
    return Promise.reject(
      new Error('Outbound network access is disabled during activation: fetch'),
    );
  };
  restorations.push(() => {
    globalThis.fetch = originalFetch;
  });

  try {
    await action();
  } finally {
    for (const restore of restorations.reverse()) {
      restore();
    }
  }

  assert.deepEqual(attempts, [], `Activation attempted outbound access: ${attempts.join(', ')}`);
}

suite('OKF Workbench foundation', () => {
  test('activates offline and registers the six stable IDs plus pending-review recovery', async () => {
    const extension = vscode.extensions.getExtension(extensionId);
    assert.ok(extension, `Extension ${extensionId} was not found.`);
    await withExtensionHostNetworkDenied(async () => extension.activate());

    const registeredCommands = await vscode.commands.getCommands(true);
    for (const commandId of expectedCommandIds) {
      assert.ok(registeredCommands.includes(commandId), `${commandId} was not registered.`);
    }
    assert.ok(
      registeredCommands.includes(recoveryCommandId),
      `${recoveryCommandId} was not registered.`,
    );
  });
});
