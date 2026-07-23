import type { GraphPayload } from '../../core/model/index.js';
import {
  decodeWebviewToExtensionMessage,
  PROTOCOL_VERSION,
  type GraphDeliveryIdentity,
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

export type GraphDeliveryFailureReason =
  'superseded' | 'panel-closed' | 'message-dropped' | 'message-rejected' | 'renderer-failed';

export type GraphDeliveryFailureHandler = (reason: GraphDeliveryFailureReason) => void;

interface PendingGraphDelivery {
  readonly revision: number;
  readonly onFailure: GraphDeliveryFailureHandler;
}

type GraphPostAttempt = GraphDeliveryIdentity;

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
  #pendingDelivery: PendingGraphDelivery | undefined;
  #postAttempt: GraphPostAttempt | undefined;
  #currentDelivery: GraphDeliveryIdentity | undefined;
  #settledDeliveryId: number | undefined;
  #nextDeliveryId = 0;

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
    onDeliveryFailure?: GraphDeliveryFailureHandler,
  ): void {
    if (this.#disposed) {
      callDeliveryFailure(onDeliveryFailure, 'panel-closed');
      return;
    }
    if (this.#graph !== undefined && graph.revision < this.#graph.revision) {
      callDeliveryFailure(onDeliveryFailure, 'superseded');
      return;
    }
    this.#failDelivery('superseded');
    this.#postAttempt = undefined;
    this.#currentDelivery = undefined;
    this.#settledDeliveryId = undefined;
    const validNodeIds = new Set(graph.nodes.map((node) => node.id));
    this.#nodeSources = new Map([...nodeSources].filter(([nodeId]) => validNodeIds.has(nodeId)));
    this.#graph = graph;
    this.#pendingDelivery =
      onDeliveryFailure === undefined
        ? undefined
        : { revision: graph.revision, onFailure: onDeliveryFailure };
    if (this.#ready) {
      this.#postGraph();
    }
  }

  public async handleWebviewMessage(message: unknown): Promise<GraphPanelInboundResult> {
    if (this.#disposed) {
      return 'disposed';
    }
    const decoded = decodeWebviewToExtensionMessage(message, this.#currentDelivery);
    if (!decoded.ok) {
      this.#onRejectedMessage?.(decoded.error);
      return 'rejected';
    }
    if (decoded.value.type === 'ready') {
      if (this.#ready) {
        // `retainContextWhenHidden: false` allows VS Code to recreate the Webview while this
        // controller and its revision-scoped delivery remain current. Invalidate only the post
        // made to the previous context; the replacement context gets the same graph below and
        // may still complete the pending delivery with an acknowledgement for its exact post.
        this.#postAttempt = undefined;
        this.#currentDelivery = undefined;
        this.#settledDeliveryId = undefined;
      }
      this.#ready = true;
      this.#postGraph();
      return 'ready';
    }
    if (decoded.value.type === 'graphRendered') {
      if (this.#settledDeliveryId !== decoded.value.deliveryId) {
        this.#settledDeliveryId = decoded.value.deliveryId;
        this.#clearDelivery(decoded.value.revision);
        this.#clearPostAttempt(decoded.value.revision, decoded.value.deliveryId);
        this.#onGraphRendered?.(decoded.value.revision);
      }
      return 'graph-rendered';
    }
    if (decoded.value.type === 'graphRenderFailed') {
      if (this.#settledDeliveryId !== decoded.value.deliveryId) {
        this.#settledDeliveryId = decoded.value.deliveryId;
        this.#onGraphRenderFailed?.(decoded.value.revision, decoded.value.reason);
        this.#failDelivery('renderer-failed', decoded.value.revision);
        this.#clearPostAttempt(decoded.value.revision, decoded.value.deliveryId);
      }
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
      this.#failDelivery('panel-closed');
      this.#postAttempt = undefined;
      this.#currentDelivery = undefined;
      this.#settledDeliveryId = undefined;
      this.#panel.dispose();
    }
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#failDelivery('panel-closed');
    this.#postAttempt = undefined;
    this.#currentDelivery = undefined;
    this.#settledDeliveryId = undefined;
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
    if (this.#nextDeliveryId >= Number.MAX_SAFE_INTEGER) {
      const error = new Error('The graph delivery sequence was exhausted.');
      this.#reportPostError(error);
      this.#failDelivery('message-rejected');
      this.#currentDelivery = undefined;
      return;
    }
    this.#nextDeliveryId += 1;
    const delivery: GraphDeliveryIdentity = {
      revision: this.#graph.revision,
      deliveryId: this.#nextDeliveryId,
    };
    this.#currentDelivery = delivery;
    this.#settledDeliveryId = undefined;
    const message: ReplaceGraphMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'replaceGraph',
      ...delivery,
      payload: this.#graph,
    };
    const pendingDelivery = this.#pendingDelivery;
    const attempt: GraphPostAttempt = delivery;
    this.#postAttempt = attempt;
    let posted: PromiseLike<boolean>;
    try {
      posted = this.#panel.webview.postMessage(message);
    } catch (error: unknown) {
      this.#failPostAttempt(attempt, pendingDelivery, 'message-rejected', error);
      return;
    }
    void Promise.resolve(posted).then(
      (accepted) => {
        if (!accepted) {
          this.#failPostAttempt(
            attempt,
            pendingDelivery,
            'message-dropped',
            new Error(`The Webview rejected graph revision ${message.revision}.`),
          );
        } else if (this.#postAttempt === attempt) {
          this.#postAttempt = undefined;
        }
      },
      (error: unknown) => {
        this.#failPostAttempt(attempt, pendingDelivery, 'message-rejected', error);
      },
    );
  }

  #clearDelivery(revision: number): void {
    if (this.#pendingDelivery?.revision === revision) {
      this.#pendingDelivery = undefined;
    }
  }

  #clearPostAttempt(revision: number, deliveryId: number): void {
    if (this.#postAttempt?.revision === revision && this.#postAttempt.deliveryId === deliveryId) {
      this.#postAttempt = undefined;
    }
  }

  #failPostAttempt(
    attempt: GraphPostAttempt,
    delivery: PendingGraphDelivery | undefined,
    reason: GraphDeliveryFailureReason,
    error: unknown,
  ): void {
    if (this.#postAttempt !== attempt) return;
    this.#postAttempt = undefined;
    if (
      this.#currentDelivery?.revision === attempt.revision &&
      this.#currentDelivery.deliveryId === attempt.deliveryId
    ) {
      this.#currentDelivery = undefined;
      this.#settledDeliveryId = undefined;
    }
    this.#reportPostError(error);
    this.#failDeliveryIfCurrent(delivery, reason);
  }

  #failDelivery(reason: GraphDeliveryFailureReason, revision?: number): void {
    const delivery = this.#pendingDelivery;
    if (delivery === undefined || (revision !== undefined && delivery.revision !== revision)) {
      return;
    }
    this.#pendingDelivery = undefined;
    callDeliveryFailure(delivery.onFailure, reason);
  }

  #failDeliveryIfCurrent(
    delivery: PendingGraphDelivery | undefined,
    reason: GraphDeliveryFailureReason,
  ): void {
    if (delivery === undefined || this.#pendingDelivery !== delivery) return;
    this.#pendingDelivery = undefined;
    callDeliveryFailure(delivery.onFailure, reason);
  }

  #reportPostError(error: unknown): void {
    try {
      this.#onPostError?.(error);
    } catch {
      // Error reporters are observational and must not create a second unhandled failure.
    }
  }
}

function callDeliveryFailure(
  handler: GraphDeliveryFailureHandler | undefined,
  reason: GraphDeliveryFailureReason,
): void {
  try {
    handler?.(reason);
  } catch {
    // Completion observers must never destabilize the panel lifecycle.
  }
}
