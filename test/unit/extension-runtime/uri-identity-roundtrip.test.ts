import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class MockUri {
    public constructor(
      readonly scheme: string,
      readonly authority: string,
      readonly path: string,
      readonly query = '',
      readonly fragment = '',
    ) {}

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
      return new MockUri(
        base.scheme,
        base.authority,
        [...base.path.split('/'), ...segments].join('/'),
        base.query,
        base.fragment,
      );
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
      const query = this.query.length === 0 ? '' : `?${this.query}`;
      const fragment = this.fragment.length === 0 ? '' : `#${this.fragment}`;
      return `${this.scheme}://${this.authority}${this.path
        .split('/')
        .map(encodeURIComponent)
        .join('/')}${query}${fragment}`;
    }
  }

  return { Uri: MockUri };
});

import { Uri } from 'vscode';

import { buildGraphPayload } from '../../../src/core/graph/index.js';
import { OKF_SEMANTIC_LIMITS } from '../../../src/core/model/index.js';
import { parseBundle } from '../../../src/core/parser/index.js';
import { loadBundle } from '../../../src/extension/runtime/loadBundle.js';
import type {
  WorkspaceEntry,
  WorkspacePort,
  WorkspaceTraversalEvent,
} from '../../../src/extension/workspace/types.js';
import { vscodeUriCodec } from '../../../src/extension/workspace/uriCodec.js';

const encoder = new TextEncoder();

class OneDocumentPort implements WorkspacePort<Uri> {
  readCalls = 0;

  public constructor(
    private readonly entry: WorkspaceEntry<Uri>,
    private readonly content: Uint8Array,
  ) {}

  async *traverse(): AsyncIterable<WorkspaceTraversalEvent<Uri>> {
    yield { kind: 'entry', entry: this.entry };
  }

  async enumerate(): Promise<readonly WorkspaceEntry<Uri>[]> {
    return [this.entry];
  }

  async stat(uri: Uri) {
    return uri.toString() === this.entry.uri.toString()
      ? { type: 'file' as const, size: this.content.byteLength, ctime: 0, mtime: 0 }
      : { type: 'directory' as const, size: 0, ctime: 0, mtime: 0 };
  }

  async read(): Promise<Uint8Array> {
    this.readCalls += 1;
    return this.content;
  }

  async write(): Promise<void> {
    throw new Error('This round-trip port is read-only.');
  }
}

describe('percent-expanded source URI envelope', () => {
  it('loads and graphs a 4 KiB multibyte path while rejecting +1 before provider I/O', async () => {
    const root = Uri.parse('memfs://workspace/knowledge');
    const exactPath = `${'😀'.repeat(1_023)}a.md`;
    const exceededPath = `${'😀'.repeat(1_023)}aa.md`;
    expect(encoder.encode(exactPath)).toHaveLength(OKF_SEMANTIC_LIMITS.maxProviderPathBytes);
    expect(encoder.encode(exceededPath)).toHaveLength(OKF_SEMANTIC_LIMITS.maxProviderPathBytes + 1);

    const providerUri = vscodeUriCodec.joinProviderPath(root, exactPath);
    const generatedUri = vscodeUriCodec.joinContained(root, exactPath);
    expect(providerUri.toString()).toBe(generatedUri.toString());
    expect(providerUri.toString().length).toBeGreaterThan(
      OKF_SEMANTIC_LIMITS.maxProviderPathCodeUnits,
    );
    expect(providerUri.toString().length).toBeLessThanOrEqual(
      OKF_SEMANTIC_LIMITS.maxSourceUriCodeUnits,
    );
    expect(encoder.encode(providerUri.toString()).byteLength).toBeLessThanOrEqual(
      OKF_SEMANTIC_LIMITS.maxSourceUriBytes,
    );

    const content = encoder.encode(
      '---\ntype: concept\ntitle: Percent-expanded boundary\n---\n# Boundary\n',
    );
    const port = new OneDocumentPort(
      { uri: providerUri, relativePath: exactPath, type: 'file' },
      content,
    );
    const loaded = await loadBundle(port, vscodeUriCodec, root, root);
    const parsed = parseBundle({ ...loaded, revision: 1 });
    const graph = buildGraphPayload(parsed);

    expect(port.readCalls).toBe(1);
    expect(parsed.failures).toEqual([]);
    expect(parsed.concepts).toHaveLength(1);
    expect(parsed.concepts[0]?.source).toMatchObject({
      uri: providerUri.toString(),
      bundlePath: exactPath,
    });
    expect(graph.nodes).toEqual([
      expect.objectContaining({
        id: exactPath.slice(0, -'.md'.length),
        type: 'concept',
      }),
    ]);

    expect(() => vscodeUriCodec.joinProviderPath(root, exceededPath)).toThrow(/4096 UTF-8 bytes/u);
    expect(() => vscodeUriCodec.joinContained(root, exceededPath)).toThrow(/4096 UTF-8 bytes/u);
    expect(port.readCalls).toBe(1);
  });
});
