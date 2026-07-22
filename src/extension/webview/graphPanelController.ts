import type { GraphPayload } from '../../core/model/index.js';
import {
  decodeWebviewToExtensionMessage,
  PROTOCOL_VERSION,
  type GraphRenderFailureReason,
  type ProtocolDecodeError,
  type ReplaceGraphMessage,
} from '../../shared/protocol/index.js';
import type { DisposableLike } from '../workspace/refreshCoordinator.js';
import type { NodeSourceLocation } from '../runtime/types.js';
import { createGraphWebviewHtml, createWebviewNonce, type GraphWebviewAssets } from './html.js';

export interface GraphWebviewPort {
  html: string;
  postMessage(message: unknown): PromiseLike<boolean>;
  onDidReceiveMessage(listener: (message: unknown) => void): DisposableLike;
}

export interface GraphWebviewPanelPort {
  readonly webview: GraphWebviewPort;
  reveal(): void;
  onDidDispose(listener: () => void): DisposableLike;
  dispose(): void;
}

export interface SourceNavigator<TUri> {
  openSource(location: NodeSourceLocation<TUri>): Promise<void>;
}

export type GraphPanelInboundResult =
  'ready' | 'graph-rendered' | 'graph-render-failed' | 'opened-source' | 'rejected' | 'disposed';

export interface GraphPanelControllerOptions<TUri> {
  readonly panel: GraphWebviewPanelPort;
  readonly assets: GraphWebviewAssets;
  readonly navigator: SourceNavigator<TUri>;
  readonly onDispose?: () => void;
  readonly onRejectedMessage?: (error: ProtocolDecodeError | 'unknown-node') => void;
  readonly onPostError?: (error: unknown) => void;
  readonly onGraphRendered?: (revision: number) => void;
  readonly onGraphRenderFailed?: (revision: number, reason: GraphRenderFailureReason) => void;
  readonly createNonce?: () => string;
}

/** Owns one graph panel and the privileged source mapping for its current revision. */
export class GraphPanelController<TUri> implements DisposableLike {
  readonly #panel: GraphWebviewPanelPort;
  readonly #navigator: SourceNavigator<TUri>;
  readonly #onDispose: (() => void) | undefined;
  readonly #onRejectedMessage: ((error: ProtocolDecodeError | 'unknown-node') => void) | undefined;
  readonly #onPostError: ((error: unknown) => void) | undefined;
  readonly #onGraphRendered: ((revision: number) => void) | undefined;
  readonly #onGraphRenderFailed:
    ((revision: number, reason: GraphRenderFailureReason) => void) | undefined;
  readonly #subscriptions: DisposableLike[];

  #graph: GraphPayload | undefined;
  #nodeSources = new Map<string, NodeSourceLocation<TUri>>();
  #ready = false;
  #disposed = false;

  public constructor(options: GraphPanelControllerOptions<TUri>) {
    this.#panel = options.panel;
    this.#navigator = options.navigator;
    this.#onDispose = options.onDispose;
    this.#onRejectedMessage = options.onRejectedMessage;
    this.#onPostError = options.onPostError;
    this.#onGraphRendered = options.onGraphRendered;
    this.#onGraphRenderFailed = options.onGraphRenderFailed;
    const nonce = (options.createNonce ?? createWebviewNonce)();
    this.#panel.webview.html = createGraphWebviewHtml(options.assets, nonce);
    this.#subscriptions = [
      this.#panel.webview.onDidReceiveMessage((message) => {
        void this.handleWebviewMessage(message).catch((error: unknown) => {
          this.#reportPostError(error);
        });
      }),
      this.#panel.onDidDispose(() => {
        this.dispose();
      }),
    ];
  }

  public get disposed(): boolean {
    return this.#disposed;
  }

  public reveal(): void {
    if (!this.#disposed) {
      this.#panel.reveal();
    }
  }

  public replaceGraph(
    graph: GraphPayload,
    nodeSources: ReadonlyMap<string, NodeSourceLocation<TUri>>,
  ): void {
    if (this.#disposed || (this.#graph !== undefined && graph.revision < this.#graph.revision)) {
      return;
    }
    const validNodeIds = new Set(graph.nodes.map((node) => node.id));
    this.#nodeSources = new Map([...nodeSources].filter(([nodeId]) => validNodeIds.has(nodeId)));
    this.#graph = graph;
    if (this.#ready) {
      this.#postGraph();
    }
  }

  public async handleWebviewMessage(message: unknown): Promise<GraphPanelInboundResult> {
    if (this.#disposed) {
      return 'disposed';
    }
    const decoded = decodeWebviewToExtensionMessage(message, this.#graph?.revision ?? 0);
    if (!decoded.ok) {
      this.#onRejectedMessage?.(decoded.error);
      return 'rejected';
    }
    if (decoded.value.type === 'ready') {
      this.#ready = true;
      this.#postGraph();
      return 'ready';
    }
    if (decoded.value.type === 'graphRendered') {
      this.#onGraphRendered?.(decoded.value.revision);
      return 'graph-rendered';
    }
    if (decoded.value.type === 'graphRenderFailed') {
      this.#onGraphRenderFailed?.(decoded.value.revision, decoded.value.reason);
      return 'graph-render-failed';
    }

    const location = this.#nodeSources.get(decoded.value.nodeId);
    if (location === undefined) {
      this.#onRejectedMessage?.('unknown-node');
      return 'rejected';
    }
    try {
      await this.#navigator.openSource(location);
      return 'opened-source';
    } catch (error: unknown) {
      this.#reportPostError(error);
      return 'rejected';
    }
  }

  /** Closes the visible panel; panel disposal then releases all listeners and mappings. */
  public close(): void {
    if (!this.#disposed) {
      this.#panel.dispose();
    }
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const subscription of this.#subscriptions) {
      subscription.dispose();
    }
    this.#nodeSources.clear();
    this.#graph = undefined;
    this.#onDispose?.();
  }

  #postGraph(): void {
    if (this.#graph === undefined || this.#disposed) {
      return;
    }
    const message: ReplaceGraphMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'replaceGraph',
      revision: this.#graph.revision,
      payload: this.#graph,
    };
    void Promise.resolve(this.#panel.webview.postMessage(message)).catch((error: unknown) => {
      this.#reportPostError(error);
    });
  }

  #reportPostError(error: unknown): void {
    try {
      this.#onPostError?.(error);
    } catch {
      // Error reporters are observational and must not create a second unhandled failure.
    }
  }
}
