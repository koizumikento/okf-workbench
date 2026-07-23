export interface WebviewNetworkObservation {
  readonly authority: 'headed-vscode-webview-cdp';
  readonly captureScope: string;
  readonly remoteRequestCount: number;
  readonly remoteOrigins: readonly string[];
  readonly localResourceRequestCount: number;
  readonly localOrigins: readonly string[];
  readonly webviewNavigationRequestCount: number;
  readonly webviewNavigationOrigins: readonly string[];
  readonly otherRequestCount: number;
  readonly otherSchemes: readonly string[];
}

export interface WebviewNetworkRecorder {
  waitForOkfTarget(): Promise<unknown>;
  snapshot(captureScope: string): Promise<WebviewNetworkObservation>;
  close(): void;
}

export interface WebviewNetworkRecorderOptions {
  readonly fetchImplementation?: typeof fetch;
  readonly createSocket?: (url: string) => WebSocket;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly commandTimeoutMs?: number;
  readonly finalQuietPeriodMs?: number;
  readonly targetTimeoutMs?: number;
}

export function createWebviewNetworkRecorder(
  port: number,
  options?: WebviewNetworkRecorderOptions,
): Promise<WebviewNetworkRecorder>;

export function classifyNetworkUrl(value: string): {
  readonly kind: 'local' | 'navigation' | 'remote' | 'other';
  readonly origin: string;
};
