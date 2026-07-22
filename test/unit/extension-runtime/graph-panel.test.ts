import { describe, expect, it, vi } from 'vitest';

import type { GraphPayload, SourceRange } from '../../../src/core/model/index.js';
import { PROTOCOL_VERSION } from '../../../src/shared/protocol/index.js';
import type { NodeSourceLocation } from '../../../src/extension/runtime/types.js';
import {
  GraphPanelController,
  type GraphWebviewPanelPort,
  type GraphWebviewPort,
} from '../../../src/extension/webview/graphPanelController.js';
import { createGraphWebviewHtml, createWebviewNonce } from '../../../src/extension/webview/html.js';

const sourceRange: SourceRange = {
  start: { offset: 4, line: 1, character: 0 },
  end: { offset: 9, line: 1, character: 5 },
};

function graph(revision: number): GraphPayload {
  return {
    protocolVersion: PROTOCOL_VERSION,
    revision,
    nodes: [
      {
        id: 'alpha',
        type: 'note',
        title: '<script>not html</script>',
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
  public revealCount = 0;
  public disposeCount = 0;
  #listener: (() => void) | undefined;

  public reveal(): void {
    this.revealCount += 1;
  }

  public onDidDispose(listener: () => void): { dispose(): void } {
    this.#listener = listener;
    return { dispose: () => (this.#listener = undefined) };
  }

  public dispose(): void {
    this.disposeCount += 1;
    this.#listener?.();
  }
}

describe('graph Webview host', () => {
  it('renders only local assets under the exact restrictive CSP with one nonce', () => {
    const nonce = 'test_nonce-123';
    const html = createGraphWebviewHtml(
      {
        cspSource: 'vscode-resource://okf-workbench',
        scriptUri: 'vscode-resource://okf-workbench/main.js',
        styleUri: 'vscode-resource://okf-workbench/main.css',
      },
      nonce,
    );

    expect(html).toContain(
      "default-src 'none'; img-src vscode-resource://okf-workbench data:; style-src vscode-resource://okf-workbench; script-src 'nonce-test_nonce-123'; font-src vscode-resource://okf-workbench; connect-src 'none';",
    );
    expect(html).toContain('nonce="test_nonce-123"');
    expect(html.match(/<script\b/gu)).toHaveLength(1);
    expect(html.match(/<link\b/gu)).toHaveLength(1);
    expect(html).not.toMatch(/(?:cdn|unpkg|jsdelivr|googleapis)/iu);
    expect(html).not.toContain('unsafe-inline');
    expect(html).not.toContain('unsafe-eval');

    const first = createWebviewNonce();
    const second = createWebviewNonce();
    expect(first).toMatch(/^[\w-]{43}$/u);
    expect(second).not.toBe(first);
  });

  it('rejects stale and forged navigation while opening a valid host-side mapping', async () => {
    const panel = new FakePanel();
    const openSource = vi
      .fn<(location: NodeSourceLocation<string>) => Promise<void>>()
      .mockResolvedValue(undefined);
    const rejected: unknown[] = [];
    const controller = new GraphPanelController<string>({
      panel,
      assets: {
        cspSource: 'vscode-resource://okf-workbench',
        scriptUri: 'vscode-resource://okf-workbench/main.js',
        styleUri: 'vscode-resource://okf-workbench/main.css',
      },
      navigator: { openSource },
      createNonce: () => 'fixed_nonce',
      onRejectedMessage: (reason) => rejected.push(reason),
    });
    const sources = new Map<string, NodeSourceLocation<string>>([
      ['alpha', { uri: 'memfs://bundle/alpha.md', range: sourceRange }],
    ]);
    controller.replaceGraph(graph(7), sources);

    expect(
      await controller.handleWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: 'openSource',
        revision: 6,
        nodeId: 'alpha',
      }),
    ).toBe('rejected');
    expect(
      await controller.handleWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: 'openSource',
        revision: 7,
        nodeId: 'forged',
      }),
    ).toBe('rejected');
    expect(openSource).not.toHaveBeenCalled();

    expect(
      await controller.handleWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: 'openSource',
        revision: 7,
        nodeId: 'alpha',
      }),
    ).toBe('opened-source');
    expect(openSource).toHaveBeenCalledExactlyOnceWith({
      uri: 'memfs://bundle/alpha.md',
      range: sourceRange,
    });
    expect(rejected).toHaveLength(2);
  });

  it('turns source navigation failure into a deterministic rejection without escaping', async () => {
    const panel = new FakePanel();
    const navigationFailure = new Error('source moved');
    const postedErrors: unknown[] = [];
    const controller = new GraphPanelController<string>({
      panel,
      assets: {
        cspSource: 'vscode-resource://okf-workbench',
        scriptUri: 'vscode-resource://okf-workbench/main.js',
        styleUri: 'vscode-resource://okf-workbench/main.css',
      },
      navigator: { openSource: async () => Promise.reject(navigationFailure) },
      onPostError: (error) => postedErrors.push(error),
      createNonce: () => 'fixed_nonce',
    });
    controller.replaceGraph(
      graph(8),
      new Map([['alpha', { uri: 'memfs://bundle/moved.md', range: sourceRange }]]),
    );

    await expect(
      controller.handleWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: 'openSource',
        revision: 8,
        nodeId: 'alpha',
      }),
    ).resolves.toBe('rejected');
    expect(postedErrors).toEqual([navigationFailure]);
  });

  it('posts the current graph on ready without putting source URIs or user data in HTML', async () => {
    const panel = new FakePanel();
    const rendered: number[] = [];
    const controller = new GraphPanelController<string>({
      panel,
      assets: {
        cspSource: 'vscode-resource://okf-workbench',
        scriptUri: 'vscode-resource://okf-workbench/main.js',
        styleUri: 'vscode-resource://okf-workbench/main.css',
      },
      navigator: { openSource: async () => undefined },
      createNonce: () => 'fixed_nonce',
      onGraphRendered: (revision) => rendered.push(revision),
    });
    controller.replaceGraph(
      graph(3),
      new Map([['alpha', { uri: 'memfs://secret/source.md', range: sourceRange }]]),
    );

    await controller.handleWebviewMessage({ protocolVersion: PROTOCOL_VERSION, type: 'ready' });
    expect(panel.webview.posted).toEqual([
      expect.objectContaining({ type: 'replaceGraph', revision: 3, payload: graph(3) }),
    ]);
    expect(JSON.stringify(panel.webview.posted)).not.toContain('memfs://secret');
    expect(panel.webview.html).not.toContain('<script>not html</script>');

    await expect(
      controller.handleWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: 'graphRendered',
        revision: 3,
      }),
    ).resolves.toBe('graph-rendered');
    expect(rendered).toEqual([3]);

    await expect(
      controller.handleWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: 'graphRendered',
        revision: 2,
      }),
    ).resolves.toBe('rejected');
    expect(rendered).toEqual([3]);

    controller.close();
    expect(controller.disposed).toBe(true);
    expect(panel.disposeCount).toBe(1);
  });

  it('routes a validated renderer failure without treating it as graph readiness', async () => {
    const panel = new FakePanel();
    const rendered: number[] = [];
    const failures: { readonly revision: number; readonly reason: string }[] = [];
    const controller = new GraphPanelController<string>({
      panel,
      assets: {
        cspSource: 'vscode-resource://okf-workbench',
        scriptUri: 'vscode-resource://okf-workbench/main.js',
        styleUri: 'vscode-resource://okf-workbench/main.css',
      },
      navigator: { openSource: async () => undefined },
      createNonce: () => 'fixed_nonce',
      onGraphRendered: (revision) => rendered.push(revision),
      onGraphRenderFailed: (revision, reason) => failures.push({ revision, reason }),
    });
    controller.replaceGraph(graph(5), new Map());

    await expect(
      controller.handleWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: 'graphRenderFailed',
        revision: 5,
        reason: 'renderer-construction-failed',
      }),
    ).resolves.toBe('graph-render-failed');
    expect(rendered).toEqual([]);
    expect(failures).toEqual([{ revision: 5, reason: 'renderer-construction-failed' }]);

    await expect(
      controller.handleWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: 'graphRenderFailed',
        revision: 4,
        reason: 'renderer-construction-failed',
      }),
    ).resolves.toBe('rejected');
    expect(failures).toHaveLength(1);
  });
});
