import { TextDecoder, TextEncoder } from 'node:util';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  entryTypes: new Map<string, number>(),
  directories: new Map<string, [string, number][]>(),
  directoryFailures: new Set<string>(),
  calls: [] as string[],
  applySupported: true,
  beforeApply: undefined as (() => void) | undefined,
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
          const content = mockState.files.get(uriKey);
          const type = mockState.entryTypes.get(uriKey) ?? (content === undefined ? undefined : 1);
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
          return content.slice();
        },
        async readDirectory(uri: MockUri) {
          const uriKey = key(uri);
          mockState.calls.push(`directory:${uriKey}`);
          if (mockState.directoryFailures.has(uriKey)) {
            throw new MockFileSystemError('NoPermissions', 'Test directory is unreadable.');
          }
          return mockState.directories.get(uriKey) ?? [];
        },
        async createDirectory(uri: MockUri) {
          const uriKey = key(uri);
          mockState.calls.push(`mkdir:${uriKey}`);
          mockState.entryTypes.set(uriKey, 2);
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

import { sha256Content } from '../../../src/extension/workspace/contentHash.js';
import { WorkspaceAccessError } from '../../../src/extension/workspace/types.js';
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
  mockState.calls.length = 0;
  mockState.applySupported = true;
  mockState.beforeApply = undefined;
  mockState.afterWrite = undefined;
});

describe('VscodeWorkspacePort guarded writes', () => {
  it('reports symlink bitmasks before their file or directory component', async () => {
    const port = new VscodeWorkspacePort();
    const linkedDirectory = Uri.parse('file:///workspace/linked-directory');
    const linkedFile = Uri.parse('file:///workspace/linked-file.md');
    mockState.entryTypes.set(linkedDirectory.toString(), 2 | 64);
    mockState.entryTypes.set(linkedFile.toString(), 1 | 64);

    await expect(port.stat(linkedDirectory)).resolves.toMatchObject({ type: 'symbolic-link' });
    await expect(port.stat(linkedFile)).resolves.toMatchObject({ type: 'symbolic-link' });
  });

  it('joins a contained provider URI without dropping its identity query or fragment', () => {
    const root = Uri.parse('memfs://workspace/knowledge?session=alpha#provider-scope');

    const joined = vscodeUriCodec.joinContained(root, 'concepts/a.md');

    expect(joined.toString()).toBe(
      'memfs://workspace/knowledge/concepts/a.md?session=alpha#provider-scope',
    );
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

  it('streams matching files and reports one unreadable subtree without aborting siblings', async () => {
    const root = Uri.parse('memfs://workspace/project');
    mockState.directories.set(root.toString(), [
      ['blocked', 2],
      ['node_modules', 2],
      ['ordinary.txt', 1],
      ['packages', 2],
    ]);
    mockState.directoryFailures.add(Uri.joinPath(root, 'blocked').toString());
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
        uri: Uri.joinPath(root, 'blocked'),
        relativePath: 'blocked',
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

  it('makes the exact-byte update check the last awaited provider operation before writeFile', async () => {
    const port = new VscodeWorkspacePort();
    const current = encoder.encode('previewed');
    mockState.files.set(targetKey, current);

    await port.write(target, encoder.encode('updated'), {
      expected: { kind: 'sha256', value: sha256Content(current) },
    });

    expect(textAt()).toBe('updated');
    const writeIndex = mockState.calls.indexOf(`write:${targetKey}`);
    expect(mockState.calls.slice(writeIndex - 2, writeIndex + 2)).toEqual([
      `stat:${targetKey}`,
      `read:${targetKey}`,
      `write:${targetKey}`,
      `read:${targetKey}`,
    ]);
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
        expected: { kind: 'sha256', value: sha256Content(current) },
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(WorkspaceAccessError);
    expect((error as WorkspaceAccessError).code).toBe('content-mismatch');
    expect(textAt()).toBe('changed after provider write');
  });
});
