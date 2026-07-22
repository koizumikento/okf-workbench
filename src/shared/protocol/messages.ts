import type { GraphPayload } from '../../core/model/types.js';

export const PROTOCOL_VERSION = 1 as const;

export type WebviewStatus = 'loading' | 'ready' | 'error';

export interface ReplaceGraphMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: 'replaceGraph';
  readonly revision: number;
  readonly payload: GraphPayload;
}

export interface StatusMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: 'status';
  readonly revision: number;
  readonly status: WebviewStatus;
  readonly message?: string;
}

export type ExtensionToWebviewMessage = ReplaceGraphMessage | StatusMessage;

export interface ReadyMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: 'ready';
}

/** Confirms that a replacement payload reached the Webview state, DOM, and renderer boundary. */
export interface GraphRenderedMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: 'graphRendered';
  readonly revision: number;
}

export type GraphRenderFailureReason = 'renderer-construction-failed' | 'renderer-update-failed';

/** Reports a renderer boundary failure without exposing exception text or user-controlled data. */
export interface GraphRenderFailedMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: 'graphRenderFailed';
  readonly revision: number;
  readonly reason: GraphRenderFailureReason;
}

export interface OpenSourceMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: 'openSource';
  readonly revision: number;
  readonly nodeId: string;
}

export type WebviewToExtensionMessage =
  GraphRenderFailedMessage | GraphRenderedMessage | OpenSourceMessage | ReadyMessage;

export interface ProtocolDecodeError {
  readonly code:
    | 'invalid-envelope'
    | 'unsupported-version'
    | 'unknown-message'
    | 'invalid-payload'
    | 'stale-revision';
  readonly message: string;
}

export type ProtocolDecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProtocolDecodeError };
