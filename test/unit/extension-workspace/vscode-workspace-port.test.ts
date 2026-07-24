import {
  lstat as nodeLstat,
  mkdir,
  mkdtemp,
  open as nodeOpen,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextDecoder, TextEncoder } from 'node:util';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  entryTypes: new Map<string, number>(),
  directories: new Map<string, [string, number][]>(),
  directoryFailures: new Set<string>(),
  statFailures: new Map<string, { readonly code: string; readonly message: string }>(),
  statCounts: new Map<string, number>(),
  beforeStat: undefined as ((uri: string, occurrence: number) => void | Promise<void>) | undefined,
  calls: [] as string[],
  applySupported: true,
  beforeApply: undefined as (() => void) | undefined,
  afterMkdir: undefined as (() => void) | undefined,
  afterRead: undefined as (() => void) | undefined,
  afterReadDirectory: undefined as ((uri: string) => void | Promise<void>) | undefined,
  afterWrite: undefined as ((uri: string) => void) | undefined,
}));

vi.mock('vscode', () => {
  class MockFileSystemError extends Error {
    readonly code: string;

    constructor(code: string, message = code) {
      super(message);
      this.code = code;
      this.name = 'FileSystemError';
    }
  }

  class MockUri {
    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
    readonly query: string;
    readonly fragment: string;

    constructor(scheme: string, authority: string, path: string, query = '', fragment = '') {
      this.scheme = scheme;
      this.authority = authority;
      this.path = path;
      this.query = query;
      this.fragment = fragment;
    }

    static parse(value: string): MockUri {
      const parsed = new URL(value);
      return new MockUri(
        parsed.protocol.slice(0, -1),
        parsed.host,
        decodeURIComponent(parsed.pathname),
        parsed.search.slice(1),
        parsed.hash.slice(1),
      );
    }

    static joinPath(base: MockUri, ...segments: readonly string[]): MockUri {
      const parts = base.path.split('/');
      for (const segment of segments) {
        if (segment === '..') {
          parts.pop();
        } else if (segment !== '.') {
          parts.push(segment);
        }
      }
      return new MockUri(base.scheme, base.authority, parts.join('/'), base.query, base.fragment);
    }

    with(change: {
      readonly scheme?: string;
      readonly authority?: string;
      readonly path?: string;
      readonly query?: string;
      readonly fragment?: string;
    }): MockUri {
      return new MockUri(
        change.scheme ?? this.scheme,
        change.authority ?? this.authority,
        change.path ?? this.path,
        change.query ?? this.query,
        change.fragment ?? this.fragment,
      );
    }

    toString(): string {
      const query = this.query.length > 0 ? `?${this.query}` : '';
      const fragment = this.fragment.length > 0 ? `#${this.fragment}` : '';
      const encodedPath = this.path.split('/').map(encodeURIComponent).join('/');
      return `${this.scheme}://${this.authority}${encodedPath}${query}${fragment}`;
    }
  }

  interface CreateEntry {
    readonly uri: MockUri;
    readonly options: {
      readonly overwrite?: boolean;
      readonly ignoreIfExists?: boolean;
      readonly contents?: Uint8Array;
    };
  }

  class MockWorkspaceEdit {
    readonly creates: CreateEntry[] = [];

    createFile(uri: MockUri, options: CreateEntry['options']): void {
      this.creates.push({ uri, options });
    }
  }

  const key = (uri: MockUri): string => uri.toString();
  const notFound = (): MockFileSystemError =>
    new MockFileSystemError('FileNotFound', 'Test resource does not exist.');

  return {
    FileSystemError: MockFileSystemError,
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    Uri: MockUri,
    WorkspaceEdit: MockWorkspaceEdit,
    workspace: {
      fs: {
        async stat(uri: MockUri) {
          const uriKey = key(uri);
          mockState.calls.push(`stat:${uriKey}`);
          const occurrence = (mockState.statCounts.get(uriKey) ?? 0) + 1;
          mockState.statCounts.set(uriKey, occurrence);
          await mockState.beforeStat?.(uriKey, occurrence);
          const statFailure = mockState.statFailures.get(uriKey);
          if (statFailure !== undefined) {
            throw new MockFileSystemError(statFailure.code, statFailure.message);
          }
          const content = mockState.files.get(uriKey);
          const type =
            mockState.entryTypes.get(uriKey) ??
            (mockState.directories.has(uriKey) ? 2 : content === undefined ? undefined : 1);
          if (type === undefined) {
            throw notFound();
          }
          return { type, size: content?.byteLength ?? 0, ctime: 0, mtime: 0 };
        },
        async readFile(uri: MockUri) {
          const uriKey = key(uri);
          mockState.calls.push(`read:${uriKey}`);
          const content = mockState.files.get(uriKey);
          if (content === undefined) {
            throw notFound();
          }
          mockState.afterRead?.();
          return content.slice();
        },
        async readDirectory(uri: MockUri) {
          const uriKey = key(uri);
          mockState.calls.push(`directory:${uriKey}`);
          if (mockState.directoryFailures.has(uriKey)) {
            throw new MockFileSystemError('NoPermissions', 'Test directory is unreadable.');
          }
          const children = mockState.directories.get(uriKey) ?? [];
          await mockState.afterReadDirectory?.(uriKey);
          return children;
        },
        async createDirectory(uri: MockUri) {
          const uriKey = key(uri);
          mockState.calls.push(`mkdir:${uriKey}`);
          mockState.entryTypes.set(uriKey, 2);
          mockState.afterMkdir?.();
        },
        async writeFile(uri: MockUri, content: Uint8Array) {
          const uriKey = key(uri);
          mockState.calls.push(`write:${uriKey}`);
          mockState.files.set(uriKey, content.slice());
          mockState.entryTypes.set(uriKey, 1);
          mockState.afterWrite?.(uriKey);
        },
      },
      async applyEdit(edit: MockWorkspaceEdit) {
        mockState.calls.push('applyEdit');
        mockState.beforeApply?.();
        if (!mockState.applySupported) {
          return false;
        }
        for (const entry of edit.creates) {
          const uriKey = key(entry.uri);
          if (mockState.files.has(uriKey)) {
            return false;
          }
          if (
            entry.options.overwrite !== false ||
            entry.options.ignoreIfExists !== false ||
            entry.options.contents === undefined
          ) {
            throw new Error('The adapter did not request a guarded create with initial content.');
          }
          mockState.files.set(uriKey, entry.options.contents.slice());
          mockState.entryTypes.set(uriKey, 1);
        }
        return true;
      },
    },
  };
});

import { Uri } from 'vscode';

import { planProviderIndexes } from '../../../src/core/indexes/index.js';
import { collectWorkspaceIndexSource } from '../../../src/extension/commands/regenerate-indexes.js';
import { typescriptOkfCore } from '../../../src/core/wasm/index.js';
import { providerIndexChangesToProposal } from '../../../src/extension/commands/proposals.js';
import { loadBundle } from '../../../src/extension/runtime/loadBundle.js';
import { BundleContextService } from '../../../src/extension/workspace/bundleContext.js';
import { sha256Content } from '../../../src/extension/workspace/contentHash.js';
import { ProposalApplicator } from '../../../src/extension/workspace/proposalApplicator.js';
import {
  WorkspaceAccessError,
  WorkspaceWriteAuthorizationError,
} from '../../../src/extension/workspace/types.js';
import { vscodeUriCodec } from '../../../src/extension/workspace/uriCodec.js';
import { VscodeWorkspacePort } from '../../../src/extension/workspace/vscodeWorkspacePort.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const target = Uri.parse('memfs://workspace/knowledge/concepts/a.md');
const targetKey = target.toString();

function textAt(uri = targetKey): string | undefined {
  const content = mockState.files.get(uri);
  return content === undefined ? undefined : decoder.decode(content);
}

beforeEach(() => {
  mockState.files.clear();
  mockState.entryTypes.clear();
  mockState.directories.clear();
  mockState.directoryFailures.clear();
  mockState.statFailures.clear();
  mockState.statCounts.clear();
  mockState.beforeStat = undefined;
  mockState.calls.length = 0;
  mockState.applySupported = true;
  mockState.beforeApply = undefined;
  mockState.afterMkdir = undefined;
  mockState.afterRead = undefined;
  mockState.afterReadDirectory = undefined;
  mockState.afterWrite = undefined;
});

describe('VscodeWorkspacePort guarded writes', () => {
  it('reports symlink bitmasks before their file or directory component', async () => {
    const port = new VscodeWorkspacePort();
    const linkedDirectory = Uri.parse('memfs://workspace/linked-directory');
    const linkedFile = Uri.parse('memfs://workspace/linked-file.md');
    mockState.entryTypes.set(linkedDirectory.toString(), 2 | 64);
    mockState.entryTypes.set(linkedFile.toString(), 1 | 64);

    await expect(port.stat(linkedDirectory)).resolves.toMatchObject({ type: 'symbolic-link' });
    await expect(port.stat(linkedFile)).resolves.toMatchObject({ type: 'symbolic-link' });
  });

  it('rejects and closes a native handle opened through a transient external ancestor symlink', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'okf-workspace-port-'));
    const workspaceRoot = join(temporaryRoot, 'workspace');
    const safeAncestor = join(workspaceRoot, 'bundle');
    const parkedSafeAncestor = join(workspaceRoot, 'bundle.parked');
    const externalAncestor = join(temporaryRoot, 'external');
    const targetPath = join(safeAncestor, 'index.md');
    const externalTargetPath = join(externalAncestor, 'index.md');
    const safeSentinel = 'SAFE INTERNAL';
    const externalSentinel = 'EXTERNAL SENTINEL';
    let openedHandle: FileHandle | undefined;
    let returnedBytes: Uint8Array | undefined;

    try {
      await mkdir(safeAncestor, { recursive: true });
      await mkdir(externalAncestor, { recursive: true });
      await writeFile(targetPath, safeSentinel);
      await writeFile(externalTargetPath, externalSentinel);

      const targetUri = Uri.parse(pathToFileURL(targetPath).href);
      const port = new VscodeWorkspacePort({
        nativeFileSystem: {
          lstat: async (path) => nodeLstat(path, { bigint: true }),
          open: async (path, flags) => {
            expect(path).toBe(targetPath);
            await rename(safeAncestor, parkedSafeAncestor);
            await symlink(
              externalAncestor,
              safeAncestor,
              process.platform === 'win32' ? 'junction' : 'dir',
            );
            try {
              openedHandle = await nodeOpen(path, flags);
              return openedHandle;
            } finally {
              await unlink(safeAncestor);
              await rename(parkedSafeAncestor, safeAncestor);
            }
          },
        },
      });
      const initialStat = await port.stat(targetUri);
      expect(initialStat?.readIdentity).toMatchObject({ kind: 'native-file' });
      if (initialStat?.readIdentity === undefined) {
        throw new Error('The native file stat did not expose a read identity.');
      }

      const error = await port.read(targetUri, { expectedIdentity: initialStat.readIdentity }).then(
        (bytes) => {
          returnedBytes = bytes;
          return undefined;
        },
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(WorkspaceAccessError);
      expect((error as WorkspaceAccessError).code).toBe('content-mismatch');
      expect(returnedBytes).toBeUndefined();
      expect(openedHandle).toBeDefined();
      expect(openedHandle?.fd).toBe(-1);
      await expect(readFile(targetPath, 'utf8')).resolves.toBe(safeSentinel);
      await expect(readFile(externalTargetPath, 'utf8')).resolves.toBe(externalSentinel);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('does not return native bytes when stable-handle closure cannot be confirmed', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'okf-workspace-port-close-'));
    const targetPath = join(temporaryRoot, 'index.md');
    const closeFailure = new Error('Injected close failure.');
    let actualHandle: FileHandle | undefined;
    let closeAttempts = 0;

    try {
      await writeFile(targetPath, 'SAFE INTERNAL');
      const targetUri = Uri.parse(pathToFileURL(targetPath).href);
      const port = new VscodeWorkspacePort({
        nativeFileSystem: {
          lstat: async (path) => nodeLstat(path, { bigint: true }),
          open: async (path, flags) => {
            actualHandle = await nodeOpen(path, flags);
            return {
              stat: actualHandle.stat.bind(actualHandle),
              readFile: actualHandle.readFile.bind(actualHandle),
              close: async () => {
                closeAttempts += 1;
                throw closeFailure;
              },
            } as unknown as FileHandle;
          },
        },
      });
      const initialStat = await port.stat(targetUri);
      if (initialStat?.readIdentity === undefined) {
        throw new Error('The native file stat did not expose a read identity.');
      }

      const error = await port
        .read(targetUri, { expectedIdentity: initialStat.readIdentity })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(WorkspaceAccessError);
      expect((error as WorkspaceAccessError).code).toBe('unavailable');
      expect((error as Error).cause).toBe(closeFailure);
      expect(closeAttempts).toBe(1);
      expect(actualHandle?.fd).not.toBe(-1);
    } finally {
      await actualHandle?.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('preserves a native read failure and attaches a simultaneous close failure', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'okf-workspace-port-read-close-'));
    const targetPath = join(temporaryRoot, 'index.md');
    const readFailure = Object.assign(new Error('Injected read failure.'), { code: 'EIO' });
    const closeFailure = new Error('Injected close failure.');
    let actualHandle: FileHandle | undefined;
    let closeAttempts = 0;

    try {
      await writeFile(targetPath, 'SAFE INTERNAL');
      const targetUri = Uri.parse(pathToFileURL(targetPath).href);
      const port = new VscodeWorkspacePort({
        nativeFileSystem: {
          lstat: async (path) => nodeLstat(path, { bigint: true }),
          open: async (path, flags) => {
            actualHandle = await nodeOpen(path, flags);
            return {
              stat: actualHandle.stat.bind(actualHandle),
              readFile: async () => Promise.reject(readFailure),
              close: async () => {
                closeAttempts += 1;
                throw closeFailure;
              },
            } as unknown as FileHandle;
          },
        },
      });
      const initialStat = await port.stat(targetUri);
      if (initialStat?.readIdentity === undefined) {
        throw new Error('The native file stat did not expose a read identity.');
      }

      const error = await port
        .read(targetUri, { expectedIdentity: initialStat.readIdentity })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(WorkspaceAccessError);
      expect((error as WorkspaceAccessError).code).toBe('unavailable');
      expect((error as Error).cause).toBe(readFailure);
      expect((error as Error & { closeFailure?: unknown }).closeFailure).toBe(closeFailure);
      expect(closeAttempts).toBe(1);
    } finally {
      await actualHandle?.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('closes a native handle after rejecting an initial identity mismatch', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'okf-workspace-port-identity-close-'));
    const targetPath = join(temporaryRoot, 'index.md');
    let actualHandle: FileHandle | undefined;
    let closeAttempts = 0;

    try {
      await writeFile(targetPath, 'SAFE INTERNAL');
      const targetUri = Uri.parse(pathToFileURL(targetPath).href);
      const port = new VscodeWorkspacePort({
        nativeFileSystem: {
          lstat: async (path) => nodeLstat(path, { bigint: true }),
          open: async (path, flags) => {
            actualHandle = await nodeOpen(path, flags);
            return {
              stat: actualHandle.stat.bind(actualHandle),
              readFile: actualHandle.readFile.bind(actualHandle),
              close: async () => {
                closeAttempts += 1;
                await actualHandle?.close();
              },
            } as unknown as FileHandle;
          },
        },
      });
      const initialStat = await port.stat(targetUri);
      if (initialStat?.readIdentity?.kind !== 'native-file') {
        throw new Error('The native file stat did not expose a read identity.');
      }
      const mismatchedIdentity = {
        ...initialStat.readIdentity,
        inode: `${initialStat.readIdentity.inode}-mismatch`,
      };

      const error = await port
        .read(targetUri, { expectedIdentity: mismatchedIdentity })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(WorkspaceAccessError);
      expect((error as WorkspaceAccessError).code).toBe('content-mismatch');
      expect(closeAttempts).toBe(1);
      expect(actualHandle?.fd).toBe(-1);
    } finally {
      if (actualHandle?.fd !== -1) {
        await actualHandle?.close();
      }
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('classifies native stat permission failures as permission errors', async () => {
    const denied = Object.assign(new Error('Native access denied.'), { code: 'EACCES' });
    const port = new VscodeWorkspacePort({
      nativeFileSystem: {
        lstat: async () => Promise.reject(denied),
        open: nodeOpen,
      },
    });

    const error = await port
      .stat(Uri.parse('file:///workspace/denied.md'))
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(WorkspaceAccessError);
    expect((error as WorkspaceAccessError).code).toBe('permission');
  });

  it('joins a contained provider URI without dropping its identity query or fragment', () => {
    const root = Uri.parse('memfs://workspace/knowledge?session=alpha#provider-scope');

    const joined = vscodeUriCodec.joinContained(root, 'concepts/a.md');

    expect(joined.toString()).toBe(
      'memfs://workspace/knowledge/concepts/a.md?session=alpha#provider-scope',
    );
  });

  it('treats trailing-slash variants as the same safety root and builds descendant segments', () => {
    const safetyRoot = Uri.parse('memfs://workspace/project/');
    const sameRoot = Uri.parse('memfs://workspace/project');
    const descendant = Uri.parse('memfs://workspace/project/nested/bundle');

    expect(vscodeUriCodec.containedPathSegments(safetyRoot, sameRoot)).toEqual([
      safetyRoot,
      sameRoot,
    ]);
    expect(
      vscodeUriCodec
        .containedPathSegments(safetyRoot, descendant)
        .map((segment) => segment.toString()),
    ).toEqual([safetyRoot.toString(), 'memfs://workspace/project/nested', descendant.toString()]);
  });

  it('joins provider-reported segments verbatim without percent-decoded sibling collisions', () => {
    const root = Uri.parse('memfs://workspace/knowledge');

    expect(vscodeUriCodec.joinProviderPath(root, 'encoded%2Fsegment/index.md').toString()).toBe(
      'memfs://workspace/knowledge/encoded%252Fsegment/index.md',
    );
    expect(vscodeUriCodec.joinProviderPath(root, 'encoded/segment/index.md').toString()).toBe(
      'memfs://workspace/knowledge/encoded/segment/index.md',
    );
    expect(vscodeUriCodec.joinProviderPath(root, 'literal%/index.md').toString()).toBe(
      'memfs://workspace/knowledge/literal%25/index.md',
    );
    expect(vscodeUriCodec.joinProviderPath(root, 'team knowledge/資料.md').toString()).toBe(
      'memfs://workspace/knowledge/team%20knowledge/%E8%B3%87%E6%96%99.md',
    );
    expect(() => vscodeUriCodec.joinContained(root, 'encoded%2Fsegment/index.md')).toThrow();
  });

  it('discovers literal percent-bearing provider roots separately from decoded-looking siblings', async () => {
    const workspaceRoot = Uri.parse('memfs://workspace/project');
    const encodedSeparator = Uri.joinPath(workspaceRoot, 'encoded%2Fsegment');
    const actualNestedParent = Uri.joinPath(workspaceRoot, 'encoded');
    const actualNested = Uri.joinPath(actualNestedParent, 'segment');
    const encodedSpace = Uri.joinPath(workspaceRoot, 'team%20knowledge');
    const actualSpace = Uri.joinPath(workspaceRoot, 'team knowledge');
    const roots = [encodedSeparator, actualNested, encodedSpace, actualSpace] as const;

    mockState.entryTypes.set(workspaceRoot.toString(), 2);
    mockState.directories.set(workspaceRoot.toString(), [
      ['encoded', 2],
      ['encoded%2Fsegment', 2],
      ['team knowledge', 2],
      ['team%20knowledge', 2],
    ]);
    mockState.directories.set(actualNestedParent.toString(), [['segment', 2]]);
    for (const root of roots) {
      mockState.directories.set(root.toString(), [['index.md', 1]]);
      mockState.files.set(Uri.joinPath(root, 'index.md').toString(), encoder.encode('valid'));
    }

    const port = new VscodeWorkspacePort();
    const context = new BundleContextService(port, vscodeUriCodec, () => ({
      isBundleRoot: true,
    }));
    const discovery = await context.discover([workspaceRoot]);

    expect(discovery.failures).toEqual([]);
    expect(new Set(discovery.candidates.map(({ rootUriString }) => rootUriString))).toEqual(
      new Set(roots.map((root) => root.toString())),
    );
    expect(encodedSeparator.toString()).toContain('/encoded%252Fsegment');
    expect(actualNested.toString()).toContain('/encoded/segment');
    expect(encodedSpace.toString()).toContain('/team%2520knowledge');
    expect(actualSpace.toString()).toContain('/team%20knowledge');
  });

  it('regenerates provider indexes without aliasing percent names and guards a BOM by raw bytes', async () => {
    const bundleRoot = Uri.parse('memfs://workspace/knowledge');
    const encodedDirectory = Uri.joinPath(bundleRoot, 'encoded');
    const rootIndex = Uri.joinPath(bundleRoot, 'index.md');
    const originalIndex = Uint8Array.from([
      0xef,
      0xbb,
      0xbf,
      ...encoder.encode('---\nokf_version: "0.1"\n---\n# Knowledge\n'),
    ]);
    const conceptSources = new Map([
      [
        'encoded%2Fsegment.md',
        '---\ntype: concept\ntitle: Literal encoded separator\n---\n# Literal\n',
      ],
      ['encoded/segment.md', '---\ntype: concept\ntitle: Actual nested segment\n---\n# Nested\n'],
      [
        'team%20knowledge.md',
        '---\ntype: concept\ntitle: Literal encoded space\n---\n# Literal space\n',
      ],
      ['team knowledge.md', '---\ntype: concept\ntitle: Actual space\n---\n# Space\n'],
    ]);

    mockState.entryTypes.set(bundleRoot.toString(), 2);
    mockState.entryTypes.set(encodedDirectory.toString(), 2);
    mockState.directories.set(bundleRoot.toString(), [
      ['encoded', 2],
      ['encoded%2Fsegment.md', 1],
      ['index.md', 1],
      ['team knowledge.md', 1],
      ['team%20knowledge.md', 1],
    ]);
    mockState.directories.set(encodedDirectory.toString(), [['segment.md', 1]]);
    mockState.files.set(rootIndex.toString(), originalIndex);
    for (const [relativePath, source] of conceptSources) {
      mockState.files.set(
        vscodeUriCodec.joinProviderPath(bundleRoot, relativePath).toString(),
        encoder.encode(source),
      );
    }

    const port = new VscodeWorkspacePort();
    const source = await collectWorkspaceIndexSource(
      bundleRoot,
      bundleRoot,
      port,
      vscodeUriCodec,
      typescriptOkfCore,
    );
    expect(source.ok).toBe(true);
    if (!source.ok) {
      return;
    }
    expect(new Set(source.value.concepts.map(({ relativePath }) => relativePath))).toEqual(
      new Set(conceptSources.keys()),
    );

    const plan = planProviderIndexes({
      mode: 'update-all',
      concepts: source.value.concepts,
      existingIndexes: source.value.existingIndexes,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    const proposal = providerIndexChangesToProposal(
      bundleRoot,
      plan.value.changes,
      vscodeUriCodec,
      {
        expectedContentSnapshots: new Map(
          source.value.existingIndexes.map((index) => [
            index.relativePath,
            { sha256: index.contentHash, byteLength: index.contentByteLength },
          ]),
        ),
      },
    );
    const rootChange = proposal.changes.find(({ relativePath }) => relativePath === 'index.md');
    expect(rootChange?.expected).toEqual({
      kind: 'sha256',
      value: sha256Content(originalIndex),
      byteLength: originalIndex.byteLength,
    });
    expect(rootChange?.proposedText).toContain(
      '[Literal encoded separator](./encoded%252Fsegment.md)',
    );
    expect(rootChange?.proposedText).toContain('[encoded](./encoded/)');
    expect(rootChange?.proposedText).toContain('[Literal encoded space](./team%2520knowledge.md)');
    expect(rootChange?.proposedText).toContain('[Actual space](./team%20knowledge.md)');

    const applicator = new ProposalApplicator(port, vscodeUriCodec);
    await expect(applicator.apply(proposal)).resolves.toMatchObject({ failed: [] });
    const updatedIndex = mockState.files.get(rootIndex.toString());
    expect(updatedIndex?.slice(0, 3)).toEqual(Uint8Array.from([0xef, 0xbb, 0xbf]));
    expect(decoder.decode(updatedIndex)).toContain(
      '[Literal encoded separator](./encoded%252Fsegment.md)',
    );
    expect(
      textAt(vscodeUriCodec.joinProviderPath(bundleRoot, 'encoded/index.md').toString()),
    ).toContain('[Actual nested segment](./segment.md)');
  });

  it('streams matching files and reports one unreadable subtree without aborting siblings', async () => {
    const root = Uri.parse('memfs://workspace/project');
    mockState.directories.set(root.toString(), [
      ['blocked', 2],
      ['node_modules', 2],
      ['ordinary.txt', 1],
      ['packages', 2],
    ]);
    const blocked = Uri.joinPath(root, 'blocked');
    mockState.entryTypes.set(blocked.toString(), 2);
    mockState.directoryFailures.add(blocked.toString());
    mockState.directories.set(Uri.joinPath(root, 'node_modules').toString(), [['dependency', 2]]);
    const packages = Uri.joinPath(root, 'packages');
    const knowledge = Uri.joinPath(packages, 'knowledge');
    mockState.directories.set(packages.toString(), [['knowledge', 2]]);
    mockState.directories.set(knowledge.toString(), [['index.md', 1]]);
    const port = new VscodeWorkspacePort();
    const events = [];

    for await (const event of port.traverse(root, {
      excludeDirectoryNames: ['node_modules'],
      includeFileNames: ['index.md'],
      includeDirectories: false,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        kind: 'failure',
        uri: blocked,
        relativePath: 'blocked',
        reason: 'access',
        message: expect.stringContaining('Test directory is unreadable.'),
      },
      {
        kind: 'entry',
        entry: {
          uri: Uri.joinPath(knowledge, 'index.md'),
          relativePath: 'packages/knowledge/index.md',
          type: 'file',
        },
      },
    ]);
    expect(mockState.calls).not.toContain(
      `directory:${Uri.joinPath(root, 'node_modules').toString()}`,
    );
  });

  it('refuses a traversal root that became a symbolic-link directory after selection', async () => {
    const root = Uri.parse('memfs://workspace/selected-bundle');
    mockState.entryTypes.set(root.toString(), 2 | 64);
    mockState.directories.set(root.toString(), [['index.md', 1]]);
    const port = new VscodeWorkspacePort();
    const events = [];

    for await (const event of port.traverse(root, {
      includeFileNames: ['index.md'],
      includeDirectories: false,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        kind: 'failure',
        uri: root,
        relativePath: '',
        message: expect.stringContaining('symbolic-link root'),
      },
    ]);
    expect(mockState.calls).toContain(`stat:${root.toString()}`);
    expect(mockState.calls).not.toContain(`directory:${root.toString()}`);
  });

  it('does not descend into a child directory carrying the symbolic-link bit', async () => {
    const root = Uri.parse('memfs://workspace/project');
    const linked = Uri.joinPath(root, 'linked');
    mockState.directories.set(root.toString(), [
      ['index.md', 1],
      ['linked', 2 | 64],
    ]);
    mockState.directories.set(linked.toString(), [['index.md', 1]]);
    const port = new VscodeWorkspacePort();
    const events = [];

    for await (const event of port.traverse(root, {
      includeFileNames: ['index.md'],
      includeDirectories: false,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        kind: 'entry',
        entry: { uri: Uri.joinPath(root, 'index.md'), relativePath: 'index.md', type: 'file' },
      },
    ]);
    expect(mockState.calls).not.toContain(`directory:${linked.toString()}`);
  });

  it('re-stats a stale directory tuple before descent and continues with safe siblings', async () => {
    const root = Uri.parse('memfs://workspace/project');
    const stale = Uri.joinPath(root, 'a-stale');
    const safe = Uri.joinPath(root, 'b-safe');
    mockState.directories.set(root.toString(), [
      ['a-stale', 2],
      ['b-safe', 2],
    ]);
    // The parent listing claimed Directory, but the fresh stat observes the replacement.
    mockState.entryTypes.set(stale.toString(), 2 | 64);
    mockState.directories.set(stale.toString(), [['index.md', 1]]);
    mockState.directories.set(safe.toString(), [['index.md', 1]]);
    const port = new VscodeWorkspacePort();
    const events = [];

    for await (const event of port.traverse(root, {
      includeFileNames: ['index.md'],
      includeDirectories: false,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        kind: 'failure',
        uri: stale,
        relativePath: 'a-stale',
        reason: 'generation-changed',
        message: expect.stringContaining('symbolic-link'),
      },
      {
        kind: 'entry',
        entry: {
          uri: Uri.joinPath(safe, 'index.md'),
          relativePath: 'b-safe/index.md',
          type: 'file',
        },
      },
    ]);
    expect(mockState.calls).toContain(`stat:${stale.toString()}`);
    expect(mockState.calls).not.toContain(`directory:${stale.toString()}`);
    expect(mockState.calls).toContain(`directory:${safe.toString()}`);
  });

  it('keeps a nested stat access failure partial and loads a readable sibling', async () => {
    const root = Uri.parse('memfs://workspace/project');
    const blocked = Uri.joinPath(root, 'a-blocked');
    const safe = Uri.joinPath(root, 'safe.md');
    mockState.directories.set(root.toString(), [
      ['a-blocked', 2],
      ['safe.md', 1],
    ]);
    mockState.directories.set(blocked.toString(), [['secret.md', 1]]);
    mockState.statFailures.set(blocked.toString(), {
      code: 'NoPermissions',
      message: 'The nested directory is unreadable.',
    });
    mockState.files.set(safe.toString(), encoder.encode('# Safe sibling\n'));

    const loaded = await loadBundle(new VscodeWorkspacePort(), vscodeUriCodec, root, root);

    expect(loaded.documents.map(({ bundlePath }) => bundlePath)).toEqual(['safe.md']);
    expect(loaded.failures).toEqual([
      expect.objectContaining({
        bundlePath: 'a-blocked',
        reason: 'read',
        message: expect.stringContaining('unreadable'),
      }),
    ]);
    expect(mockState.calls).not.toContain(`directory:${blocked.toString()}`);
    expect(mockState.calls).toContain(`read:${safe.toString()}`);
  });

  it('keeps a nested post-enumeration access failure partial and loads a readable sibling', async () => {
    const root = Uri.parse('memfs://workspace/project');
    const blocked = Uri.joinPath(root, 'a-blocked');
    const safe = Uri.joinPath(root, 'safe.md');
    mockState.directories.set(root.toString(), [
      ['a-blocked', 2],
      ['safe.md', 1],
    ]);
    mockState.directories.set(blocked.toString(), [['secret.md', 1]]);
    mockState.files.set(safe.toString(), encoder.encode('# Safe sibling\n'));
    mockState.afterReadDirectory = (uri) => {
      if (uri === blocked.toString()) {
        mockState.statFailures.set(uri, {
          code: 'NoPermissions',
          message: 'The nested directory became unreadable.',
        });
      }
    };

    const loaded = await loadBundle(new VscodeWorkspacePort(), vscodeUriCodec, root, root);

    expect(loaded.documents.map(({ bundlePath }) => bundlePath)).toEqual(['safe.md']);
    expect(loaded.failures).toEqual([
      expect.objectContaining({
        bundlePath: 'a-blocked',
        reason: 'read',
        message: expect.stringContaining('became unreadable'),
      }),
    ]);
    expect(mockState.calls).toContain(`directory:${blocked.toString()}`);
    expect(mockState.calls).not.toContain(`read:${Uri.joinPath(blocked, 'secret.md').toString()}`);
    expect(mockState.calls).toContain(`read:${safe.toString()}`);
  });

  it('keeps a traversal-root access failure fatal even when it occurs during nested capture', async () => {
    const root = Uri.parse('memfs://workspace/project');
    const blocked = Uri.joinPath(root, 'a-blocked');
    const safe = Uri.joinPath(root, 'safe.md');
    mockState.directories.set(root.toString(), [
      ['a-blocked', 2],
      ['safe.md', 1],
    ]);
    mockState.directories.set(blocked.toString(), []);
    mockState.files.set(safe.toString(), encoder.encode('# Must not publish\n'));
    let rootEnumerationReturned = false;
    let rootStatsAfterEnumeration = 0;
    mockState.afterReadDirectory = (uri) => {
      if (uri === root.toString()) {
        rootEnumerationReturned = true;
      }
    };
    mockState.beforeStat = (uri) => {
      if (!rootEnumerationReturned || uri !== root.toString()) {
        return;
      }
      rootStatsAfterEnumeration += 1;
      if (rootStatsAfterEnumeration === 3) {
        mockState.statFailures.set(uri, {
          code: 'NoPermissions',
          message: 'The traversal root became unreadable.',
        });
      }
    };

    await expect(
      loadBundle(new VscodeWorkspacePort(), vscodeUriCodec, root, root),
    ).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('traversal root became unreadable'),
    });
    expect(rootStatsAfterEnumeration).toBe(3);
    expect(mockState.calls).not.toContain(`read:${safe.toString()}`);
  });

  it('discards external names from a transient directory-enumeration swap', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'okf-workspace-traversal-'));
    const rootPath = join(temporaryRoot, 'workspace');
    const safePath = join(rootPath, 'safe');
    const parkedPath = join(rootPath, 'safe.parked');
    const externalPath = join(temporaryRoot, 'external');
    try {
      await mkdir(safePath, { recursive: true });
      await mkdir(externalPath, { recursive: true });
      const root = Uri.parse(pathToFileURL(rootPath).href);
      const safe = Uri.parse(pathToFileURL(safePath).href);
      mockState.directories.set(root.toString(), [['safe', 2]]);
      mockState.directories.set(safe.toString(), [['EXTERNAL-NAME.md', 1]]);
      let swapped = false;
      mockState.afterReadDirectory = async (uri) => {
        if (uri !== safe.toString() || swapped) {
          return;
        }
        swapped = true;
        await rename(safePath, parkedPath);
        await symlink(externalPath, safePath, process.platform === 'win32' ? 'junction' : 'dir');
        try {
          // The mocked provider response above represents names returned while
          // the path is redirected.
        } finally {
          await unlink(safePath);
          await rename(parkedPath, safePath);
        }
      };
      const events = [];

      for await (const event of new VscodeWorkspacePort().traverse(root, {
        includeDirectories: false,
      })) {
        events.push(event);
      }

      expect(swapped).toBe(true);
      expect(events).toEqual([
        {
          kind: 'failure',
          uri: root,
          relativePath: 'safe',
          reason: 'generation-changed',
          message: expect.stringContaining('generation changed'),
        },
      ]);
      expect(JSON.stringify(events)).not.toContain('EXTERNAL-NAME');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('stops with one root-scoped failure when the directory traversal budget is exhausted', async () => {
    const root = Uri.parse('memfs://workspace/project');
    const first = Uri.joinPath(root, 'a');
    const second = Uri.joinPath(root, 'b');
    mockState.directories.set(root.toString(), [
      ['a', 2],
      ['b', 2],
    ]);
    mockState.directories.set(first.toString(), [['index.md', 1]]);
    mockState.directories.set(second.toString(), [['index.md', 1]]);
    const port = new VscodeWorkspacePort({ maxTraversalDirectories: 2 });
    const events = [];

    for await (const event of port.traverse(root, {
      includeFileNames: ['index.md'],
      includeDirectories: false,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        kind: 'entry',
        entry: {
          uri: Uri.joinPath(first, 'index.md'),
          relativePath: 'a/index.md',
          type: 'file',
        },
      },
      {
        kind: 'failure',
        uri: root,
        relativePath: '',
        reason: 'safety-limit',
        message: expect.stringContaining('safety limit of 2 directories'),
      },
    ]);
    expect(mockState.calls).not.toContain(`directory:${second.toString()}`);
  });

  it('fails closed before sorting or retaining an over-budget directory listing', async () => {
    const root = Uri.parse('memfs://workspace/project');
    mockState.directories.set(root.toString(), [
      ['c.md', 1],
      ['b.md', 1],
      ['a.md', 1],
    ]);
    const port = new VscodeWorkspacePort({ maxTraversalEntries: 2 });
    const events = [];

    for await (const event of port.traverse(root, { includeDirectories: false })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        kind: 'failure',
        uri: root,
        relativePath: '',
        reason: 'safety-limit',
        message: expect.stringContaining('safety limit of 2 entries'),
      },
    ]);
  });

  it('reserves every returned sibling tuple before descending into a nested listing', async () => {
    const root = Uri.parse('memfs://workspace/project');
    const nested = Uri.joinPath(root, 'a');
    mockState.directories.set(root.toString(), [
      ['a', 2],
      ['index.md', 1],
    ]);
    mockState.directories.set(nested.toString(), [
      ['index.md', 1],
      ['ordinary.txt', 1],
    ]);
    const port = new VscodeWorkspacePort({ maxTraversalEntries: 3 });
    const events = [];

    for await (const event of port.traverse(root, {
      includeFileNames: ['index.md'],
      includeDirectories: false,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        kind: 'failure',
        uri: root,
        relativePath: '',
        reason: 'safety-limit',
        message: expect.stringContaining('safety limit of 3 entries'),
      },
    ]);
    expect(mockState.calls.filter((call) => call.startsWith('directory:'))).toEqual([
      `directory:${root.toString()}`,
      `directory:${nested.toString()}`,
    ]);
  });

  it('reports a branch-local depth limit and continues with shallower siblings', async () => {
    const root = Uri.parse('memfs://workspace/project');
    const deep = Uri.joinPath(root, 'a-deep');
    mockState.directories.set(root.toString(), [
      ['a-deep', 2],
      ['index.md', 1],
    ]);
    mockState.directories.set(deep.toString(), [['nested', 2]]);
    const port = new VscodeWorkspacePort();
    const events = [];

    for await (const event of port.traverse(root, {
      maxDepth: 1,
      includeFileNames: ['index.md'],
      includeDirectories: false,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        kind: 'failure',
        uri: deep,
        relativePath: 'a-deep',
        reason: 'safety-limit',
        message: expect.stringContaining('maximum depth of 1 path segments'),
      },
      {
        kind: 'entry',
        entry: { uri: Uri.joinPath(root, 'index.md'), relativePath: 'index.md', type: 'file' },
      },
    ]);
    expect(mockState.calls).not.toContain(`directory:${deep.toString()}`);
  });

  it.each(['a/b.md', 'a\\b.md', '.', '..', '', `bad\u0000name.md`])(
    'rejects hostile provider child basename %j before URI joining or yielding',
    async (name) => {
      const root = Uri.parse('memfs://workspace/project');
      mockState.directories.set(root.toString(), [[name, 1]]);
      const port = new VscodeWorkspacePort();
      const events = [];

      for await (const event of port.traverse(root, { includeDirectories: false })) {
        events.push(event);
      }

      expect(events).toEqual([
        {
          kind: 'failure',
          uri: root,
          relativePath: '',
          reason: 'safety-limit',
          message: expect.stringContaining('one safe path segment'),
        },
      ]);
    },
  );

  it('rejects a provider child whose UTF-8 path exceeds the identity byte limit', async () => {
    const root = Uri.parse('memfs://workspace/project');
    mockState.directories.set(root.toString(), [[`${'😀'.repeat(1_025)}.md`, 1]]);
    const port = new VscodeWorkspacePort();
    const events = [];

    for await (const event of port.traverse(root, { includeDirectories: false })) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({
        kind: 'failure',
        reason: 'safety-limit',
        message: expect.stringContaining('4096-byte identity safety limit'),
      }),
    ]);
  });

  it('bounds and incrementally builds contained URI chains at 64 path segments', () => {
    const safetyRoot = Uri.parse('memfs://workspace/project');
    const exactPath = Array.from({ length: 64 }, (_, index) => `s${String(index)}`).join('/');
    const exact = Uri.joinPath(safetyRoot, ...exactPath.split('/'));
    expect(vscodeUriCodec.containedPathSegments(safetyRoot, exact)).toHaveLength(65);

    const exceededPath = `${exactPath}/overflow`;
    const exceeded = Uri.joinPath(safetyRoot, ...exceededPath.split('/'));
    expect(() => vscodeUriCodec.containedPathSegments(safetyRoot, exceeded)).toThrow(
      /deeper than the 64-segment/u,
    );
  });

  it('rejects non-positive traversal budgets', () => {
    expect(() => new VscodeWorkspacePort({ maxTraversalEntries: 0 })).toThrow(
      /maxTraversalEntries must be a positive integer/u,
    );
  });

  it('creates through a provider no-overwrite resource edit and never calls writeFile', async () => {
    const port = new VscodeWorkspacePort();

    await port.write(target, encoder.encode('created'), { expected: { kind: 'absent' } });

    expect(textAt()).toBe('created');
    expect(mockState.calls).toContain('applyEdit');
    expect(mockState.calls.some((call) => call.startsWith('write:'))).toBe(false);
  });

  it('does not overwrite a file created after the absence check', async () => {
    const port = new VscodeWorkspacePort();
    mockState.beforeApply = () => {
      mockState.files.set(targetKey, encoder.encode('racing writer'));
    };

    const error = await port
      .write(target, encoder.encode('proposed'), { expected: { kind: 'absent' } })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(WorkspaceAccessError);
    expect((error as WorkspaceAccessError).code).toBe('content-mismatch');
    expect(textAt()).toBe('racing writer');
    expect(mockState.calls.some((call) => call.startsWith('write:'))).toBe(false);
  });

  it('fails closed when the provider cannot apply a no-overwrite create', async () => {
    const port = new VscodeWorkspacePort();
    mockState.applySupported = false;

    const error = await port
      .write(target, encoder.encode('proposed'), { expected: { kind: 'absent' } })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(WorkspaceAccessError);
    expect((error as WorkspaceAccessError).code).toBe('unavailable');
    expect(textAt()).toBeUndefined();
    expect(mockState.calls.some((call) => call.startsWith('write:'))).toBe(false);
  });

  it('rechecks authorization after create preparation and before applyEdit', async () => {
    const port = new VscodeWorkspacePort();
    let authorized = true;
    mockState.afterMkdir = () => {
      authorized = false;
    };
    const problem = {
      code: 'workspace-folder-unavailable',
      message: 'The selected workspace folder was removed.',
    };

    const error = await port
      .write(target, encoder.encode('proposed'), {
        expected: { kind: 'absent' },
        assertAuthorized() {
          if (!authorized) {
            throw new WorkspaceWriteAuthorizationError(problem);
          }
        },
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(WorkspaceWriteAuthorizationError);
    expect((error as WorkspaceWriteAuthorizationError).problem).toEqual(problem);
    expect(textAt()).toBeUndefined();
    expect(mockState.calls).not.toContain('applyEdit');
  });

  it('makes the provider stat/read/stat check the last awaited operation before writeFile', async () => {
    const port = new VscodeWorkspacePort();
    const current = encoder.encode('previewed');
    mockState.files.set(targetKey, current);

    await port.write(target, encoder.encode('updated'), {
      expected: {
        kind: 'sha256',
        value: sha256Content(current),
        byteLength: current.byteLength,
      },
    });

    expect(textAt()).toBe('updated');
    expect(mockState.calls).toEqual([
      `stat:${targetKey}`,
      `stat:${targetKey}`,
      `read:${targetKey}`,
      `stat:${targetKey}`,
      `write:${targetKey}`,
      `stat:${targetKey}`,
      `stat:${targetKey}`,
      `read:${targetKey}`,
      `stat:${targetKey}`,
    ]);
  });

  it('rechecks authorization after update verification and before writeFile', async () => {
    const port = new VscodeWorkspacePort();
    const current = encoder.encode('previewed');
    mockState.files.set(targetKey, current);
    let authorized = true;
    mockState.afterRead = () => {
      authorized = false;
    };

    const error = await port
      .write(target, encoder.encode('updated'), {
        expected: {
          kind: 'sha256',
          value: sha256Content(current),
          byteLength: current.byteLength,
        },
        assertAuthorized() {
          if (!authorized) {
            throw new WorkspaceWriteAuthorizationError({
              code: 'workspace-folder-unavailable',
              message: 'The selected workspace folder was removed.',
            });
          }
        },
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(WorkspaceWriteAuthorizationError);
    expect(textAt()).toBe('previewed');
    expect(mockState.calls).not.toContain(`write:${targetKey}`);
  });

  it('reports when the provider does not retain the bytes it accepted', async () => {
    const port = new VscodeWorkspacePort();
    const current = encoder.encode('previewed');
    mockState.files.set(targetKey, current);
    mockState.afterWrite = (uri) => {
      mockState.files.set(uri, encoder.encode('changed after provider write'));
    };

    const error = await port
      .write(target, encoder.encode('updated'), {
        expected: {
          kind: 'sha256',
          value: sha256Content(current),
          byteLength: current.byteLength,
        },
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(WorkspaceAccessError);
    expect((error as WorkspaceAccessError).code).toBe('content-mismatch');
    expect(textAt()).toBe('changed after provider write');
  });
});
