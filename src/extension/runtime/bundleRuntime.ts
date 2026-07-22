import { buildGraphPayload } from '../../core/graph/index.js';
import type { GraphPayload, ParseFailure, ParsedBundle } from '../../core/model/index.js';
import { parseBundle } from '../../core/parser/index.js';
import { validateBundle } from '../../core/validation/index.js';
import type { RuntimeDiagnosticsSink } from '../diagnostics/index.js';
import {
  RefreshCoordinator,
  type DisposableLike,
  type WorkspaceChangeSource,
} from '../workspace/refreshCoordinator.js';
import type { WorkspacePort } from '../workspace/types.js';
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
}

/** Owns the selected bundle's complete derived state and scoped watcher lifecycle. */
export class BundleRuntime<TUri> implements DisposableLike {
  readonly #uris: WorkspaceUriCodec<TUri>;
  readonly #diagnostics: RuntimeDiagnosticsSink;
  readonly #createChangeSource: (root: TUri) => WorkspaceChangeSource<TUri>;
  readonly #onPublish: ((snapshot: BundleRuntimeSnapshot<TUri>) => void) | undefined;
  readonly #onClear: (() => void) | undefined;
  readonly #now: () => Date | string;
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
    this.#coordinator = new RefreshCoordinator({
      refresh: async ({ context, signal }) =>
        loadBundle(options.port, options.uris, context.rootUri, signal),
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

  public select(rootUri: TUri): void {
    this.#assertActive();
    const context: BundleRuntimeContext<TUri> = {
      rootUri,
      rootUriString: this.#uris.serialize(rootUri),
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
    const parsed = parseBundle({
      rootUri: loaded.rootUri,
      revision,
      documents: loaded.documents,
    });
    const withReadFailures: ParsedBundle = {
      ...parsed,
      failures: sortFailures([...parsed.failures, ...loaded.failures]),
    };
    const findings = validateBundle(withReadFailures, { now: this.#now() });
    const bundle: ParsedBundle = { ...withReadFailures, findings };
    const graph = buildGraphPayload(bundle);
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

function sortFailures(failures: readonly ParseFailure[]): readonly ParseFailure[] {
  return [...failures].sort(
    (left, right) =>
      left.bundlePath.localeCompare(right.bundlePath) ||
      left.uri.localeCompare(right.uri) ||
      left.reason.localeCompare(right.reason),
  );
}
