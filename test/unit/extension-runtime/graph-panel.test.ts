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
  public postMessageImplementation: (message: unknown) => PromiseLike<boolean> = async () => true;
  #listener: ((message: unknown) => void) | undefined;

  public postMessage(message: unknown): PromiseLike<boolean> {
    this.posted.push(message);
    return this.postMessageImplementation(message);
  }

  public onDidReceiveMessage(listener: (message: unknown) => void): { dispose(): void } {
    this.#listener = listener;
    return { dispose: () => (this.#listener = undefined) };
  }

  public emit(message: unknown): void {
    this.#listener?.(message);
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

function postedDelivery(panel: FakePanel, index = -1): { revision: number; deliveryId: number } {
  const message = panel.webview.posted.at(index);
  if (
    typeof message !== 'object' ||
    message === null ||
    !('revision' in message) ||
    !('deliveryId' in message) ||
    typeof message.revision !== 'number' ||
    typeof message.deliveryId !== 'number'
  ) {
    throw new Error('Expected a posted graph delivery.');
  }
  return { revision: message.revision, deliveryId: message.deliveryId };
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
    await controller.handleWebviewMessage({ protocolVersion: PROTOCOL_VERSION, type: 'ready' });
    const delivery = postedDelivery(panel);

    expect(
      await controller.handleWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: 'openSource',
        revision: 6,
        deliveryId: delivery.deliveryId,
        nodeId: 'alpha',
      }),
    ).toBe('rejected');
    expect(
      await controller.handleWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: 'openSource',
        revision: 7,
        deliveryId: delivery.deliveryId,
        nodeId: 'forged',
      }),
    ).toBe('rejected');
    expect(openSource).not.toHaveBeenCalled();

    expect(
      await controller.handleWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: 'openSource',
        ...delivery,
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
    await controller.handleWebviewMessage({ protocolVersion: PROTOCOL_VERSION, type: 'ready' });
    const delivery = postedDelivery(panel);

    await expect(
      controller.handleWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: 'openSource',
        ...delivery,
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
        ...postedDelivery(panel),
      }),
    ).resolves.toBe('graph-rendered');
    expect(rendered).toEqual([3]);

    await expect(
      controller.handleWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: 'graphRendered',
        revision: 2,
        deliveryId: postedDelivery(panel).deliveryId,
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
    await controller.handleWebviewMessage({ protocolVersion: PROTOCOL_VERSION, type: 'ready' });
    const delivery = postedDelivery(panel);

    await expect(
      controller.handleWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: 'graphRenderFailed',
        ...delivery,
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
        deliveryId: delivery.deliveryId,
        reason: 'renderer-construction-failed',
      }),
    ).resolves.toBe('rejected');
    expect(failures).toHaveLength(1);
  });

  it('fails revision-scoped delivery when it is superseded or closed', async () => {
    const panel = new FakePanel();
    const failures: { readonly request: string; readonly reason: string }[] = [];
    const controller = new GraphPanelController<string>({
      panel,
      assets: {
        cspSource: 'vscode-resource://okf-workbench',
        scriptUri: 'vscode-resource://okf-workbench/main.js',
        styleUri: 'vscode-resource://okf-workbench/main.css',
      },
      navigator: { openSource: async () => undefined },
      createNonce: () => 'fixed_nonce',
    });

    controller.replaceGraph(graph(1), new Map(), (reason) =>
      failures.push({ request: 'one', reason }),
    );
    controller.replaceGraph(graph(2), new Map(), (reason) =>
      failures.push({ request: 'two', reason }),
    );
    expect(failures).toEqual([{ request: 'one', reason: 'superseded' }]);

    await controller.handleWebviewMessage({ protocolVersion: PROTOCOL_VERSION, type: 'ready' });
    await controller.handleWebviewMessage({ protocolVersion: PROTOCOL_VERSION, type: 'ready' });
    expect(failures).toEqual([{ request: 'one', reason: 'superseded' }]);
    await controller.handleWebviewMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: 'graphRendered',
      ...postedDelivery(panel),
    });

    controller.replaceGraph(graph(3), new Map(), (reason) =>
      failures.push({ request: 'three', reason }),
    );
    controller.close();
    expect(failures.at(-1)).toEqual({ request: 'three', reason: 'panel-closed' });
  });

  it('keeps delivery alive when repeated ready invalidates a stale dropped post', async () => {
    const panel = new FakePanel();
    const stalePost = deferred<boolean>();
    const currentPost = deferred<boolean>();
    const posts = [stalePost, currentPost];
    panel.webview.postMessageImplementation = () => {
      const next = posts.shift();
      if (next === undefined) throw new Error('unexpected post');
      return next.promise;
    };
    const failures: string[] = [];
    const rendered: number[] = [];
    const postErrors: unknown[] = [];
    const controller = new GraphPanelController<string>({
      panel,
      assets: {
        cspSource: 'vscode-resource://okf-workbench',
        scriptUri: 'vscode-resource://okf-workbench/main.js',
        styleUri: 'vscode-resource://okf-workbench/main.css',
      },
      navigator: { openSource: async () => undefined },
      createNonce: () => 'fixed_nonce',
      onPostError: (error) => postErrors.push(error),
      onGraphRendered: (revision) => rendered.push(revision),
    });
    controller.replaceGraph(graph(12), new Map(), (reason) => failures.push(reason));

    await controller.handleWebviewMessage({ protocolVersion: PROTOCOL_VERSION, type: 'ready' });
    await controller.handleWebviewMessage({ protocolVersion: PROTOCOL_VERSION, type: 'ready' });
    expect(panel.webview.posted).toEqual([
      expect.objectContaining({ type: 'replaceGraph', revision: 12 }),
      expect.objectContaining({ type: 'replaceGraph', revision: 12 }),
    ]);

    stalePost.resolve(false);
    await Promise.resolve();
    expect(failures).toEqual([]);
    expect(postErrors).toEqual([]);

    currentPost.resolve(true);
    await Promise.resolve();
    await controller.handleWebviewMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: 'graphRendered',
      ...postedDelivery(panel),
    });
    controller.close();

    expect(rendered).toEqual([12]);
    expect(failures).toEqual([]);
  });

  it('rejects an old-context ACK and still fails a dropped post to the recreated context', async () => {
    const panel = new FakePanel();
    const oldContextPost = deferred<boolean>();
    const recreatedContextPost = deferred<boolean>();
    const posts = [oldContextPost, recreatedContextPost];
    panel.webview.postMessageImplementation = () => {
      const next = posts.shift();
      if (next === undefined) throw new Error('unexpected post');
      return next.promise;
    };
    const failures: string[] = [];
    const rendered: number[] = [];
    const rejected: unknown[] = [];
    const postErrors: unknown[] = [];
    const controller = new GraphPanelController<string>({
      panel,
      assets: {
        cspSource: 'vscode-resource://okf-workbench',
        scriptUri: 'vscode-resource://okf-workbench/main.js',
        styleUri: 'vscode-resource://okf-workbench/main.css',
      },
      navigator: { openSource: async () => undefined },
      createNonce: () => 'fixed_nonce',
      onRejectedMessage: (reason) => rejected.push(reason),
      onPostError: (error) => postErrors.push(error),
      onGraphRendered: (revision) => rendered.push(revision),
    });
    controller.replaceGraph(graph(13), new Map(), (reason) => failures.push(reason));

    await controller.handleWebviewMessage({ protocolVersion: PROTOCOL_VERSION, type: 'ready' });
    const oldDelivery = postedDelivery(panel);
    oldContextPost.resolve(true);
    await Promise.resolve();

    await controller.handleWebviewMessage({ protocolVersion: PROTOCOL_VERSION, type: 'ready' });
    const recreatedDelivery = postedDelivery(panel);
    expect(recreatedDelivery.deliveryId).not.toBe(oldDelivery.deliveryId);

    await expect(
      controller.handleWebviewMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: 'graphRendered',
        ...oldDelivery,
      }),
    ).resolves.toBe('rejected');
    expect(rendered).toEqual([]);
    expect(failures).toEqual([]);
    expect(rejected).toEqual([expect.objectContaining({ code: 'stale-revision' })]);

    recreatedContextPost.resolve(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(rendered).toEqual([]);
    expect(failures).toEqual(['message-dropped']);
    expect(postErrors).toHaveLength(1);
  });

  it('reposts a pre-reveal replacement after context recreation and ignores its stale rejection', async () => {
    const panel = new FakePanel();
    const controllerPost = deferred<boolean>();
    panel.webview.postMessageImplementation = () => controllerPost.promise;
    const failures: string[] = [];
    const rendered: number[] = [];
    const postErrors: unknown[] = [];
    const controller = new GraphPanelController<string>({
      panel,
      assets: {
        cspSource: 'vscode-resource://okf-workbench',
        scriptUri: 'vscode-resource://okf-workbench/main.js',
        styleUri: 'vscode-resource://okf-workbench/main.css',
      },
      navigator: { openSource: async () => undefined },
      createNonce: () => 'fixed_nonce',
      onPostError: (error) => postErrors.push(error),
      onGraphRendered: (revision) => rendered.push(revision),
    });
    controller.replaceGraph(graph(20), new Map());
    await controller.handleWebviewMessage({ protocolVersion: PROTOCOL_VERSION, type: 'ready' });
    controllerPost.resolve(true);
    await Promise.resolve();

    const stalePreRevealPost = deferred<boolean>();
    const recreatedContextPost = deferred<boolean>();
    const replacementPosts = [stalePreRevealPost, recreatedContextPost];
    panel.webview.postMessageImplementation = () => {
      const next = replacementPosts.shift();
      if (next === undefined) throw new Error('unexpected replacement post');
      return next.promise;
    };

    // The retained controller still considers the hidden Webview ready, so replacement starts a
    // post before reveal. A recreated context then announces ready and receives a fresh post.
    controller.replaceGraph(graph(21), new Map(), (reason) => failures.push(reason));
    await controller.handleWebviewMessage({ protocolVersion: PROTOCOL_VERSION, type: 'ready' });
    expect(panel.webview.posted.slice(-2)).toEqual([
      expect.objectContaining({ type: 'replaceGraph', revision: 21 }),
      expect.objectContaining({ type: 'replaceGraph', revision: 21 }),
    ]);

    stalePreRevealPost.reject(new Error('destroyed hidden context'));
    await Promise.resolve();
    expect(failures).toEqual([]);
    expect(postErrors).toEqual([]);

    recreatedContextPost.resolve(true);
    await Promise.resolve();
    await controller.handleWebviewMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: 'graphRendered',
      ...postedDelivery(panel),
    });
    controller.close();

    expect(rendered).toEqual([21]);
    expect(failures).toEqual([]);
  });

  it.each([
    {
      label: 'false result',
      install: (webview: FakeWebview) => {
        webview.postMessageImplementation = async () => false;
      },
      expected: 'message-dropped',
    },
    {
      label: 'rejected result',
      install: (webview: FakeWebview) => {
        webview.postMessageImplementation = async () =>
          Promise.reject(new Error('panel unavailable'));
      },
      expected: 'message-rejected',
    },
    {
      label: 'synchronous exception',
      install: (webview: FakeWebview) => {
        webview.postMessageImplementation = () => {
          throw new Error('panel disposed');
        };
      },
      expected: 'message-rejected',
    },
  ])('fails delivery promptly on postMessage $label', async ({ install, expected }) => {
    const panel = new FakePanel();
    const failures: string[] = [];
    const postErrors: unknown[] = [];
    install(panel.webview);
    const controller = new GraphPanelController<string>({
      panel,
      assets: {
        cspSource: 'vscode-resource://okf-workbench',
        scriptUri: 'vscode-resource://okf-workbench/main.js',
        styleUri: 'vscode-resource://okf-workbench/main.css',
      },
      navigator: { openSource: async () => undefined },
      createNonce: () => 'fixed_nonce',
      onPostError: (error) => postErrors.push(error),
    });
    controller.replaceGraph(graph(4), new Map(), (reason) => failures.push(reason));

    await controller.handleWebviewMessage({ protocolVersion: PROTOCOL_VERSION, type: 'ready' });
    await Promise.resolve();
    await Promise.resolve();

    expect(failures).toEqual([expected]);
    expect(postErrors).toHaveLength(1);
  });

  it('clears the delivery on exact ACK and ignores a late rejection from an older post', async () => {
    const panel = new FakePanel();
    const firstPost = deferred<boolean>();
    const secondPost = deferred<boolean>();
    const posts = [firstPost, secondPost];
    panel.webview.postMessageImplementation = () => {
      const next = posts.shift();
      if (next === undefined) throw new Error('unexpected post');
      return next.promise;
    };
    const firstFailures: string[] = [];
    const secondFailures: string[] = [];
    const postErrors: unknown[] = [];
    const controller = new GraphPanelController<string>({
      panel,
      assets: {
        cspSource: 'vscode-resource://okf-workbench',
        scriptUri: 'vscode-resource://okf-workbench/main.js',
        styleUri: 'vscode-resource://okf-workbench/main.css',
      },
      navigator: { openSource: async () => undefined },
      createNonce: () => 'fixed_nonce',
      onPostError: (error) => postErrors.push(error),
    });
    controller.replaceGraph(graph(10), new Map(), (reason) => firstFailures.push(reason));
    await controller.handleWebviewMessage({ protocolVersion: PROTOCOL_VERSION, type: 'ready' });
    controller.replaceGraph(graph(11), new Map(), (reason) => secondFailures.push(reason));
    expect(firstFailures).toEqual(['superseded']);

    firstPost.reject(new Error('late old post failure'));
    await Promise.resolve();
    expect(secondFailures).toEqual([]);
    expect(postErrors).toEqual([]);

    secondPost.resolve(true);
    await Promise.resolve();
    await controller.handleWebviewMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: 'graphRendered',
      ...postedDelivery(panel),
    });
    controller.close();
    expect(secondFailures).toEqual([]);
  });
});
