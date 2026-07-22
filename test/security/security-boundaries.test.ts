import { describe, expect, it, vi } from 'vitest';

import type { ChangeSetProposal, GraphPayload, SourceRange } from '../../src/core/model/index.js';
import type { NodeSourceLocation } from '../../src/extension/runtime/types.js';
import {
  GraphPanelController,
  type GraphWebviewPanelPort,
  type GraphWebviewPort,
} from '../../src/extension/webview/graphPanelController.js';
import { createGraphWebviewHtml, createWebviewNonce } from '../../src/extension/webview/html.js';
import {
  isUriContained,
  normalizeContainedRelativePath,
} from '../../src/extension/workspace/pathSafety.js';
import { ProposalApplicator } from '../../src/extension/workspace/proposalApplicator.js';
import {
  decodeExtensionToWebviewMessage,
  decodeWebviewToExtensionMessage,
  PROTOCOL_VERSION,
} from '../../src/shared/protocol/index.js';
import { FakeWorkspacePort, stringUriCodec } from '../unit/extension-workspace/fakes.js';

const sourceRange: SourceRange = {
  start: { offset: 0, line: 0, character: 0 },
  end: { offset: 5, line: 0, character: 5 },
};

function graph(revision = 7): GraphPayload {
  return {
    protocolVersion: PROTOCOL_VERSION,
    revision,
    nodes: [
      {
        id: 'alpha',
        type: 'note',
        title: '<script>not executable</script>',
        tags: [],
        orphan: true,
        brokenLinkCount: 0,
      },
    ],
    edges: [],
    backlinks: { alpha: [] },
    brokenLinks: [],
    statistics: {
      conceptCount: 1,
      edgeCount: 0,
      orphanCount: 1,
      brokenLinkCount: 0,
      typeCounts: { note: 1 },
      tagCounts: {},
    },
  };
}

class FakeWebview implements GraphWebviewPort {
  public html = '';
  public readonly posted: unknown[] = [];
  #listener: ((message: unknown) => void) | undefined;

  public async postMessage(message: unknown): Promise<boolean> {
    this.posted.push(message);
    return true;
  }

  public onDidReceiveMessage(listener: (message: unknown) => void): { dispose(): void } {
    this.#listener = listener;
    return { dispose: () => (this.#listener = undefined) };
  }

  public emit(message: unknown): void {
    this.#listener?.(message);
  }
}

class FakePanel implements GraphWebviewPanelPort {
  public readonly webview = new FakeWebview();
  #listener: (() => void) | undefined;

  public reveal(): void {}

  public onDidDispose(listener: () => void): { dispose(): void } {
    this.#listener = listener;
    return { dispose: () => (this.#listener = undefined) };
  }

  public dispose(): void {
    this.#listener?.();
  }
}

describe('Webview CSP and asset boundary', () => {
  it('emits the minimal local policy and a unique cryptographic nonce per render', () => {
    const nonces = new Set(Array.from({ length: 128 }, () => createWebviewNonce()));
    expect(nonces.size).toBe(128);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[\w-]{43}$/u);
    }

    const nonce = [...nonces][0] as string;
    const html = createGraphWebviewHtml(
      {
        cspSource: 'vscode-webview://trusted-source',
        scriptUri: 'vscode-webview://trusted-source/main.js',
        styleUri: 'vscode-webview://trusted-source/main.css',
      },
      nonce,
    );
    const policy = html.match(/Content-Security-Policy" content="([^"]+)"/u)?.[1];
    expect(policy).toBe(
      `default-src 'none'; img-src vscode-webview://trusted-source data:; style-src vscode-webview://trusted-source; script-src 'nonce-${nonce}'; font-src vscode-webview://trusted-source; connect-src 'none';`,
    );
    expect(html.match(/<script\b/gu)).toHaveLength(1);
    expect(html.match(/nonce=/gu)).toHaveLength(1);
    expect(html).not.toContain('unsafe-inline');
    expect(html).not.toContain('unsafe-eval');
    expect(html).not.toMatch(/(?:cdn|unpkg|jsdelivr|googleapis)/iu);
  });

  it('keeps trusted asset URI punctuation inside quoted attributes', () => {
    const html = createGraphWebviewHtml(
      {
        cspSource: 'vscode-webview://trusted-source',
        scriptUri: 'vscode-webview://trusted/main.js" onerror="globalThis.pwned=true',
        styleUri: 'vscode-webview://trusted/main.css" onload="globalThis.pwned=true',
      },
      'base64url_nonce',
    );
    expect(html).not.toContain('" onerror="');
    expect(html).not.toContain('" onload="');
    expect(html).toContain('&quot; onerror=&quot;');
    expect(html).toContain('&quot; onload=&quot;');
  });
});

describe('strict protocol and authoritative source mapping', () => {
  it('rejects stale, oversized, unknown-field, forged-URI, and malformed graph messages', () => {
    expect(
      decodeWebviewToExtensionMessage(
        { protocolVersion: 1, type: 'openSource', revision: 6, nodeId: 'alpha' },
        7,
      ),
    ).toMatchObject({ ok: false, error: { code: 'stale-revision' } });
    expect(
      decodeWebviewToExtensionMessage(
        {
          protocolVersion: 1,
          type: 'openSource',
          revision: 7,
          nodeId: 'alpha',
          sourceUri: 'file:///forged.md',
        },
        7,
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
    expect(
      decodeWebviewToExtensionMessage(
        { protocolVersion: 1, type: 'openSource', revision: 7, nodeId: 'a'.repeat(4_097) },
        7,
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });

    const payload = graph();
    expect(
      decodeExtensionToWebviewMessage(
        {
          protocolVersion: 1,
          type: 'replaceGraph',
          revision: 7,
          payload: {
            ...payload,
            nodes: [{ ...payload.nodes[0], sourceUri: 'file:///secret.md' }],
          },
        },
        0,
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
    expect(
      decodeExtensionToWebviewMessage(
        {
          protocolVersion: 1,
          type: 'replaceGraph',
          revision: 7,
          payload: {
            ...payload,
            edges: [{ id: 'forged', source: 'alpha', target: 'missing', sourceRange }],
          },
        },
        0,
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
  });

  it('opens only the current host-side node mapping and never posts its URI', async () => {
    const panel = new FakePanel();
    const openSource = vi
      .fn<(location: NodeSourceLocation<string>) => Promise<void>>()
      .mockResolvedValue(undefined);
    const controller = new GraphPanelController<string>({
      panel,
      assets: {
        cspSource: 'vscode-webview://trusted-source',
        scriptUri: 'vscode-webview://trusted-source/main.js',
        styleUri: 'vscode-webview://trusted-source/main.css',
      },
      navigator: { openSource },
      createNonce: () => 'test_nonce',
    });
    controller.replaceGraph(
      graph(),
      new Map([['alpha', { uri: 'memfs://private/bundle/alpha.md', range: sourceRange }]]),
    );

    await expect(
      controller.handleWebviewMessage({
        protocolVersion: 1,
        type: 'openSource',
        revision: 7,
        nodeId: 'forged',
      }),
    ).resolves.toBe('rejected');
    await expect(
      controller.handleWebviewMessage({
        protocolVersion: 1,
        type: 'openSource',
        revision: 7,
        nodeId: 'alpha',
      }),
    ).resolves.toBe('opened-source');
    expect(openSource).toHaveBeenCalledExactlyOnceWith({
      uri: 'memfs://private/bundle/alpha.md',
      range: sourceRange,
    });

    await controller.handleWebviewMessage({ protocolVersion: 1, type: 'ready' });
    expect(JSON.stringify(panel.webview.posted)).not.toContain('memfs://private');
    expect(panel.webview.html).not.toContain('<script>not executable</script>');
  });

  it('contains source-navigation rejection without an unhandled listener promise', async () => {
    const panel = new FakePanel();
    const navigationFailure = new Error('local provider refused the document');
    const onPostError = vi.fn<(error: unknown) => void>();
    const controller = new GraphPanelController<string>({
      panel,
      assets: {
        cspSource: 'vscode-webview://trusted-source',
        scriptUri: 'vscode-webview://trusted-source/main.js',
        styleUri: 'vscode-webview://trusted-source/main.css',
      },
      navigator: { openSource: vi.fn().mockRejectedValue(navigationFailure) },
      createNonce: () => 'test_nonce',
      onPostError,
    });
    controller.replaceGraph(
      graph(),
      new Map([['alpha', { uri: 'memfs://private/bundle/alpha.md', range: sourceRange }]]),
    );
    const message = {
      protocolVersion: 1,
      type: 'openSource',
      revision: 7,
      nodeId: 'alpha',
    };

    await expect(controller.handleWebviewMessage(message)).resolves.toBe('rejected');
    expect(onPostError).toHaveBeenCalledExactlyOnceWith(navigationFailure);

    panel.webview.emit(message);
    await vi.waitFor(() => expect(onPostError).toHaveBeenCalledTimes(2));
  });
});

describe('workspace containment before writes', () => {
  it.each([
    '../outside.md',
    '..\\outside.md',
    '%2e%2e/outside.md',
    '%252e%252e/outside.md',
    '/absolute.md',
    'C:\\absolute.md',
    'C%3a/absolute.md',
    '\\\\server\\share.md',
    'safe/%2foutside.md',
    'safe/%5coutside.md',
    'safe//empty.md',
    'safe/./same.md',
    'safe/..%2foutside.md',
    'safe\0name.md',
  ])('rejects traversal or ambiguous generated path %s', (path) => {
    expect(() => normalizeContainedRelativePath(path)).toThrow();
  });

  it('requires exact URI scheme, authority, and path-segment containment', () => {
    const root = {
      scheme: 'vscode-remote',
      authority: 'ssh-remote+host',
      path: '/workspace/bundle',
    };
    expect(isUriContained(root, { ...root, path: '/workspace/bundle/nested/a.md' })).toBe(true);
    expect(isUriContained(root, { ...root, path: '/workspace/bundle-other/a.md' })).toBe(false);
    expect(isUriContained(root, { ...root, authority: 'ssh-remote+forged' })).toBe(false);
    expect(isUriContained(root, { ...root, path: root.path, query: 'redirect=outside' })).toBe(
      false,
    );
  });

  it('performs no write when a proposal path escapes or disagrees with its declared URI', async () => {
    const root = 'memfs://workspace/bundle';
    const proposal: ChangeSetProposal = {
      operation: 'security-test',
      writeRootUri: root,
      changes: [
        {
          targetUri: `${root}/safe.md`,
          relativePath: '%2e%2e/outside.md',
          operation: 'create',
          expected: { kind: 'absent' },
          encoding: 'utf8',
          proposedText: 'must not be written',
        },
        {
          targetUri: `${root}/forged.md`,
          relativePath: 'different.md',
          operation: 'create',
          expected: { kind: 'absent' },
          encoding: 'utf8',
          proposedText: 'must not be written',
        },
      ],
    };
    const port = new FakeWorkspacePort();
    const applicator = new ProposalApplicator(port, stringUriCodec);

    const result = await applicator.apply(proposal);
    expect(result.completed).toEqual([]);
    expect(result.failed).toHaveLength(2);
    expect(port.writes).toEqual([]);
  });
});
