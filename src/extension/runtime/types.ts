import type { Finding, GraphPayload, ParsedBundle, SourceRange } from '../../core/model/index.js';

export interface BundleRuntimeContext<TUri> {
  readonly rootUri: TUri;
  readonly rootUriString: string;
  /** Open workspace folder whose complete descendant chain bounds every bundle read. */
  readonly workspaceSafetyRootUri: TUri;
}

/** Privileged source data. This object must never cross the Webview message boundary. */
export interface NodeSourceLocation<TUri> {
  readonly uri: TUri;
  readonly range: SourceRange | undefined;
}

export interface BundleRuntimeSnapshot<TUri> {
  readonly context: BundleRuntimeContext<TUri>;
  readonly revision: number;
  readonly bundle: ParsedBundle;
  readonly findings: readonly Finding[];
  readonly graph: GraphPayload;
  readonly nodeSources: ReadonlyMap<string, NodeSourceLocation<TUri>>;
}
