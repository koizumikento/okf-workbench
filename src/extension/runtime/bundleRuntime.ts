import { OKF_SEMANTIC_LIMITS } from '../../core/model/index.js';
import type { GraphPayload, ParsedBundle } from '../../core/model/index.js';
import type { OkfCore } from '../../core/wasm/index.js';
import type { RuntimeDiagnosticsSink } from '../diagnostics/index.js';
import {
  RefreshCoordinator,
  type DisposableLike,
  type WorkspaceChangeSource,
} from '../workspace/refreshCoordinator.js';
import { WorkspaceAccessError, type WorkspacePort } from '../workspace/types.js';
import type { WorkspaceUriCodec } from '../workspace/uriCodec.js';
import { loadBundle, type LoadedBundleInput } from './loadBundle.js';
import type { BundleRuntimeContext, BundleRuntimeSnapshot, NodeSourceLocation } from './types.js';

export interface BundleRuntimeOptions<TUri> {
  readonly port: WorkspacePort<TUri>;
  readonly uris: WorkspaceUriCodec<TUri>;
  readonly diagnostics: RuntimeDiagnosticsSink;
  readonly createChangeSource: (root: TUri) => WorkspaceChangeSource<TUri>;
  readonly onPublish?: (snapshot: BundleRuntimeSnapshot<TUri>) => void;
  readonly onClear?: () => void;
  readonly onError?: (error: unknown, context: BundleRuntimeContext<TUri>) => void;
  readonly now?: () => Date | string;
  readonly core: OkfCore;
}

/** Owns the selected bundle's complete derived state and scoped watcher lifecycle. */
export class BundleRuntime<TUri> implements DisposableLike {
  readonly #uris: WorkspaceUriCodec<TUri>;
  readonly #diagnostics: RuntimeDiagnosticsSink;
  readonly #createChangeSource: (root: TUri) => WorkspaceChangeSource<TUri>;
  readonly #onPublish: ((snapshot: BundleRuntimeSnapshot<TUri>) => void) | undefined;
  readonly #onClear: (() => void) | undefined;
  readonly #now: () => Date | string;
  readonly #core: OkfCore;
  readonly #coordinator: RefreshCoordinator<BundleRuntimeContext<TUri>, LoadedBundleInput, TUri>;

  #current: BundleRuntimeSnapshot<TUri> | undefined;
  #disposed = false;

  public constructor(options: BundleRuntimeOptions<TUri>) {
    this.#uris = options.uris;
    this.#diagnostics = options.diagnostics;
    this.#createChangeSource = options.createChangeSource;
    this.#onPublish = options.onPublish;
    this.#onClear = options.onClear;
    this.#now = options.now ?? (() => new Date());
    this.#core = options.core;
    this.#coordinator = new RefreshCoordinator({
      refresh: async ({ context, signal }) =>
        loadBundle(
          options.port,
          options.uris,
          context.rootUri,
          context.workspaceSafetyRootUri,
          signal,
        ),
      publish: ({ context, result, revision }) => {
        this.#publish(context, result, revision);
      },
      onError: (error, context) => {
        // A root-enumeration or other unhandled current-generation failure
        // invalidates every derived view. Per-document and child-subtree access
        // failures arrive in LoadedBundleInput instead. Keep the selected context
        // so a later watcher event can recover, but never present stale output.
        this.#clearPublishedState();
        options.onError?.(error, context);
      },
    });
  }

  public get current(): BundleRuntimeSnapshot<TUri> | undefined {
    return this.#current;
  }

  public get revision(): number {
    return this.#coordinator.revision;
  }

  public select(rootUri: TUri, workspaceSafetyRootUri: TUri): void {
    this.#assertActive();
    const context: BundleRuntimeContext<TUri> = {
      rootUri,
      rootUriString: this.#uris.serialize(rootUri),
      workspaceSafetyRootUri,
    };
    this.#clearPublishedState();
    this.#coordinator.switchContext(context, this.#createChangeSource(rootUri));
  }

  /** Schedules a complete re-enumeration, used by explicit validation as well as watcher recovery. */
  public requestFullRefresh(): void {
    this.#assertActive();
    this.#coordinator.request({ kind: 'rescan' });
  }

  public clear(): void {
    this.#assertActive();
    this.#coordinator.clearContext();
    this.#clearPublishedState();
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#coordinator.dispose();
    this.#current = undefined;
    this.#diagnostics.dispose?.();
    this.#onClear?.();
    this.#disposed = true;
  }

  #publish(context: BundleRuntimeContext<TUri>, loaded: LoadedBundleInput, revision: number): void {
    if (loaded.documents.length > OKF_SEMANTIC_LIMITS.maxRuntimeDocuments) {
      throw semanticLimitError(
        `the selected bundle contains more than ${String(OKF_SEMANTIC_LIMITS.maxRuntimeDocuments)} readable Markdown documents`,
      );
    }
    const inspection = this.#core.inspect(
      {
        rootUri: loaded.rootUri,
        revision,
        documents: loaded.documents,
      },
      this.#now(),
      loaded.failures,
    );
    const semanticFailure = inspection.bundle.failures.find(
      (failure) => failure.reason === 'resource-limit' && failure.scope === 'bundle',
    );
    if (semanticFailure !== undefined) {
      throw semanticLimitError(
        `bundle parsing exceeded a semantic-output limit (${semanticFailure.message})`,
      );
    }
    if (inspection.bundle.concepts.length > OKF_SEMANTIC_LIMITS.maxGraphNodes) {
      throw semanticLimitError(
        `the selected bundle contains more than ${String(OKF_SEMANTIC_LIMITS.maxGraphNodes)} graph concepts`,
      );
    }
    let linkCount = 0;
    for (const concept of inspection.bundle.concepts) {
      linkCount += concept.links.length;
      if (linkCount > OKF_SEMANTIC_LIMITS.maxBundleLinks) {
        throw semanticLimitError(
          `the selected bundle contains more than ${String(OKF_SEMANTIC_LIMITS.maxBundleLinks)} Markdown relationships`,
        );
      }
    }
    const findings = inspection.findings;
    if (findings.length > OKF_SEMANTIC_LIMITS.maxFindings) {
      throw semanticLimitError(
        `validation produced more than ${String(OKF_SEMANTIC_LIMITS.maxFindings)} findings`,
      );
    }
    const bundle = inspection.bundle;
    const graph = inspection.graph;
    if (
      graph.nodes.length > OKF_SEMANTIC_LIMITS.maxGraphNodes ||
      graph.edges.length > OKF_SEMANTIC_LIMITS.maxGraphEdges ||
      graph.brokenLinks.length > OKF_SEMANTIC_LIMITS.maxGraphEdges
    ) {
      throw semanticLimitError(
        `the derived graph exceeds the ${String(OKF_SEMANTIC_LIMITS.maxGraphNodes)}-node or ${String(OKF_SEMANTIC_LIMITS.maxGraphEdges)}-relationship payload limit`,
      );
    }
    const nodeSources = buildNodeSources(bundle, graph, this.#uris);
    const snapshot: BundleRuntimeSnapshot<TUri> = {
      context,
      revision,
      bundle,
      findings,
      graph,
      nodeSources,
    };

    this.#diagnostics.replace(findings);
    this.#current = snapshot;
    this.#onPublish?.(snapshot);
  }

  #clearPublishedState(): void {
    this.#current = undefined;
    this.#diagnostics.clear();
    this.#onClear?.();
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error('The bundle runtime has been disposed.');
    }
  }
}

function semanticLimitError(detail: string): WorkspaceAccessError {
  return new WorkspaceAccessError(
    'unavailable',
    `OKF Workbench refused to publish diagnostics or graph state because ${detail}. Reduce or split the knowledge bundle, then retry.`,
  );
}

function buildNodeSources<TUri>(
  bundle: ParsedBundle,
  graph: GraphPayload,
  uris: WorkspaceUriCodec<TUri>,
): ReadonlyMap<string, NodeSourceLocation<TUri>> {
  const graphNodeIds = new Set(graph.nodes.map((node) => node.id));
  const sources = new Map<string, NodeSourceLocation<TUri>>();
  const concepts = [...bundle.concepts].sort(
    (left, right) =>
      left.id.localeCompare(right.id) || left.source.uri.localeCompare(right.source.uri),
  );

  for (const concept of concepts) {
    if (!graphNodeIds.has(concept.id) || sources.has(concept.id)) {
      continue;
    }
    sources.set(concept.id, {
      uri: uris.parse(concept.source.uri),
      range:
        concept.frontmatter.fields.title ??
        concept.frontmatter.fields.type ??
        concept.frontmatter.range,
    });
  }
  return sources;
}
