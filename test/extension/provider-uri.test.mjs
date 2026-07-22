import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers';
import { TextEncoder } from 'node:util';

import * as vscode from 'vscode';

const extensionId = process.env.OKF_WORKBENCH_EXTENSION_ID ?? 'straydog.okf-workbench';
const providerScheme = 'okfmem';
const providerAuthority = 'straydev-test';
const providerRoot = vscode.Uri.parse(`${providerScheme}://${providerAuthority}/workspace`, true);
const bundleRoot = vscode.Uri.joinPath(providerRoot, 'knowledge');
const conceptName = 'provider %2F 日本語.md';
const conceptUri = vscode.Uri.joinPath(bundleRoot, conceptName);
const completionTimeoutMs = 20_000;
const encoder = new TextEncoder();

const indexSource = `---
okf_version: "0.1"
title: Provider URI boundary
---

# Provider URI boundary
`;

const conceptSource = `---
type: provider-note
title: Provider-backed concept
---

# Provider-backed concept

[Missing provider target](missing.md)
`;

function fileStat(type, size = 0) {
  return { type, ctime: 0, mtime: 0, size };
}

class ReadOnlyMemoryFileSystemProvider {
  constructor() {
    this.requests = [];
    this.mutations = [];
    this.changeEmitter = new vscode.EventEmitter();
    this.onDidChangeFile = this.changeEmitter.event;
    this.directories = new Map([
      [providerRoot.path, [['knowledge', vscode.FileType.Directory]]],
      [
        bundleRoot.path,
        [
          ['index.md', vscode.FileType.File],
          [conceptName, vscode.FileType.File],
        ],
      ],
    ]);
    this.files = new Map([
      [vscode.Uri.joinPath(bundleRoot, 'index.md').path, encoder.encode(indexSource)],
      [conceptUri.path, encoder.encode(conceptSource)],
    ]);
  }

  record(operation, uri) {
    assert.equal(uri.scheme, providerScheme, `${operation} changed the provider scheme.`);
    assert.equal(uri.authority, providerAuthority, `${operation} changed the provider authority.`);
    this.requests.push({ operation, uri: uri.toString() });
  }

  watch(uri) {
    this.record('watch', uri);
    return new vscode.Disposable(() => undefined);
  }

  stat(uri) {
    this.record('stat', uri);
    const file = this.files.get(uri.path);
    if (file !== undefined) return fileStat(vscode.FileType.File, file.byteLength);
    if (this.directories.has(uri.path)) return fileStat(vscode.FileType.Directory);
    throw vscode.FileSystemError.FileNotFound(uri);
  }

  readDirectory(uri) {
    this.record('readDirectory', uri);
    const entries = this.directories.get(uri.path);
    if (entries === undefined) throw vscode.FileSystemError.FileNotFound(uri);
    return entries;
  }

  readFile(uri) {
    this.record('readFile', uri);
    const content = this.files.get(uri.path);
    if (content === undefined) throw vscode.FileSystemError.FileNotFound(uri);
    return content.slice();
  }

  createDirectory(uri) {
    this.recordMutation('createDirectory', uri);
  }

  writeFile(uri) {
    this.recordMutation('writeFile', uri);
  }

  delete(uri) {
    this.recordMutation('delete', uri);
  }

  rename(oldUri, newUri) {
    this.recordMutation('rename', oldUri);
    this.recordMutation('rename-target', newUri);
  }

  recordMutation(operation, uri) {
    this.record(operation, uri);
    this.mutations.push({ operation, uri: uri.toString() });
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  dispose() {
    this.changeEmitter.dispose();
  }
}

function acceptanceApi(value) {
  assert.ok(value && typeof value === 'object', 'The integration acceptance API was not exposed.');
  assert.equal(value.schemaVersion, 1);
  assert.equal(typeof value.getCompletionState, 'function');
  assert.equal(typeof value.waitForRuntimePublication, 'function');
  assert.equal(typeof value.waitForGraphRender, 'function');
  return value;
}

async function waitForWorkspaceFolder(uri) {
  const existing = vscode.workspace.getWorkspaceFolder(uri);
  if (existing !== undefined) return existing;

  let subscription;
  const changed = new Promise((resolve) => {
    subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (folder !== undefined) resolve(folder);
    });
  });
  const index = vscode.workspace.workspaceFolders?.length ?? 0;
  assert.equal(
    vscode.workspace.updateWorkspaceFolders(index, 0, {
      uri,
      name: 'OKF provider boundary',
    }),
    true,
    'VS Code refused to add the provider-backed workspace folder.',
  );
  try {
    return await Promise.race([
      changed,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Timed out adding the provider workspace folder.')),
          5000,
        ),
      ),
    ]);
  } finally {
    subscription?.dispose();
  }
}

async function removeWorkspaceFolder(uri) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const index = folders.findIndex((folder) => folder.uri.toString() === uri.toString());
    if (index < 0) return;
    let subscription;
    const changed = new Promise((resolve) => {
      subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
        if (vscode.workspace.getWorkspaceFolder(uri) === undefined) resolve();
      });
    });
    if (vscode.workspace.updateWorkspaceFolders(index, 1)) {
      try {
        await Promise.race([
          changed,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('Timed out removing the provider workspace folder.')),
              5000,
            ),
          ),
        ]);
      } finally {
        subscription?.dispose();
      }
      return;
    }
    subscription?.dispose();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('VS Code refused to remove the provider-backed workspace folder.');
}

suite('OKF Workbench provider URI boundary', () => {
  test('validates and renders a real non-file workspace without changing URI identity', async () => {
    const provider = new ReadOnlyMemoryFileSystemProvider();
    const registration = vscode.workspace.registerFileSystemProvider(providerScheme, provider, {
      isCaseSensitive: true,
      isReadonly: true,
    });

    try {
      // Let the Extension Host registration reach the workbench file service before the
      // provider-backed URI becomes a workspace folder. Newer editors eagerly probe a new folder.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const workspaceFolder = await waitForWorkspaceFolder(providerRoot);
      assert.equal(workspaceFolder.uri.toString(), providerRoot.toString());

      const extension = vscode.extensions.getExtension(extensionId);
      assert.ok(extension, `Extension ${extensionId} was not found.`);
      const api = acceptanceApi(await extension.activate());
      const previousRevision = api.getCompletionState().runtimePublication?.revision ?? 0;

      await vscode.commands.executeCommand('okfWorkbench.validateBundle', bundleRoot);
      const publication = await api.waitForRuntimePublication(
        previousRevision,
        completionTimeoutMs,
      );
      assert.equal(publication.diagnosticsPublished, true);
      assert.equal(publication.conceptCount, 1);
      assert.ok(publication.findingCount >= 1, 'The broken provider link was not diagnosed.');

      const diagnostics = vscode.languages.getDiagnostics(conceptUri);
      assert.ok(
        diagnostics.some(
          (diagnostic) =>
            diagnostic.code === 'okf.curation.broken-link' && diagnostic.source === 'OKF Curation',
        ),
        `Expected a broken-link diagnostic at ${conceptUri.toString()}.`,
      );
      const okfDiagnosticUris = vscode.languages
        .getDiagnostics()
        .filter(([, values]) => values.some((diagnostic) => diagnostic.source?.startsWith('OKF')))
        .map(([uri]) => uri);
      assert.ok(okfDiagnosticUris.length >= 1);
      assert.ok(
        okfDiagnosticUris.every(
          (uri) => uri.scheme === providerScheme && uri.authority === providerAuthority,
        ),
        `OKF diagnostics escaped the provider URI: ${okfDiagnosticUris.map((uri) => uri.toString()).join(', ')}`,
      );

      await vscode.commands.executeCommand('okfWorkbench.openGraph', bundleRoot);
      const rendered = await api.waitForGraphRender(publication.revision, completionTimeoutMs);
      assert.ok(rendered.revision >= publication.revision);

      assert.ok(
        conceptUri.toString().includes('provider%20%252F%20%E6%97%A5%E6%9C%AC%E8%AA%9E.md'),
        'The literal provider %2F segment was not retained in the URI identity.',
      );
      assert.ok(
        provider.requests.some(
          ({ operation, uri }) => operation === 'readFile' && uri === conceptUri.toString(),
        ),
        'The concept was not read through the registered workspace provider.',
      );
      assert.ok(
        provider.requests.some(
          ({ operation, uri }) => operation === 'readDirectory' && uri === bundleRoot.toString(),
        ),
        'The bundle root was not traversed through the registered workspace provider.',
      );
      assert.deepEqual(provider.mutations, [], 'Read-only commands attempted provider writes.');
    } finally {
      await removeWorkspaceFolder(providerRoot);
      registration.dispose();
      provider.dispose();
    }
  });
});
