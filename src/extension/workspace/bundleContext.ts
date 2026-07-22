import { TextDecoder } from 'node:util';

import type { WorkspacePort } from './types.js';
import type { WorkspaceUriCodec } from './uriCodec.js';

const decoder = new TextDecoder('utf-8', { fatal: true });

/** VCS, dependency, and tool-internal trees that cannot be workspace-owned bundle candidates. */
export const BUNDLE_DISCOVERY_EXCLUDED_DIRECTORY_NAMES = [
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.pnpm-store',
  '.turbo',
  '.vscode-test',
  '.yarn',
  'bower_components',
  'coverage',
  'node_modules',
] as const;

export interface BundleCandidate<TUri> {
  readonly rootUri: TUri;
  readonly rootUriString: string;
  readonly indexUri: TUri;
  readonly indexUriString: string;
  readonly label?: string;
}

export interface BundleIndexInspection<TUri> {
  readonly rootUri: TUri;
  readonly indexUri: TUri;
  readonly text: string;
}

export interface BundleIndexDecision {
  readonly isBundleRoot: boolean;
  readonly label?: string;
}

export type InspectBundleIndex<TUri> = (
  inspection: BundleIndexInspection<TUri>,
) => BundleIndexDecision | Promise<BundleIndexDecision>;

export interface BundleDiscoveryFailure {
  readonly uri: string;
  readonly message: string;
}

export interface BundleDiscovery<TUri> {
  readonly candidates: readonly BundleCandidate<TUri>[];
  readonly failures: readonly BundleDiscoveryFailure[];
}

export type BundleSelectionReason = 'current' | 'explicit' | 'single' | 'none' | 'ambiguous';

export interface BundleSelection<TUri> {
  readonly reason: BundleSelectionReason;
  readonly candidate?: BundleCandidate<TUri>;
  readonly candidates: readonly BundleCandidate<TUri>[];
}

/** In-memory only; deliberately has no Memento or persistence dependency. */
export class BundleContextService<TUri> {
  readonly #port: WorkspacePort<TUri>;
  readonly #uris: WorkspaceUriCodec<TUri>;
  readonly #inspectIndex: InspectBundleIndex<TUri>;
  #current: BundleCandidate<TUri> | undefined;

  constructor(
    port: WorkspacePort<TUri>,
    uris: WorkspaceUriCodec<TUri>,
    inspectIndex: InspectBundleIndex<TUri>,
  ) {
    this.#port = port;
    this.#uris = uris;
    this.#inspectIndex = inspectIndex;
  }

  get current(): BundleCandidate<TUri> | undefined {
    return this.#current;
  }

  clear(): void {
    this.#current = undefined;
  }

  select(candidate: BundleCandidate<TUri>): BundleCandidate<TUri> {
    this.#current = candidate;
    return candidate;
  }

  /**
   * Finds index documents using only the workspace port. Whether an index is a
   * valid OKF root is delegated to the parser/validator callback.
   */
  async discover(workspaceRoots: readonly TUri[]): Promise<BundleDiscovery<TUri>> {
    const candidates: BundleCandidate<TUri>[] = [];
    const failures: BundleDiscoveryFailure[] = [];
    const seenRoots = new Set<string>();

    for (const workspaceRoot of workspaceRoots) {
      try {
        const traversal = this.#port.traverse(workspaceRoot, {
          excludeDirectoryNames: BUNDLE_DISCOVERY_EXCLUDED_DIRECTORY_NAMES,
          includeFileNames: ['index.md'],
          includeDirectories: false,
        });
        for await (const event of traversal) {
          if (event.kind === 'failure') {
            failures.push({
              uri: this.#uris.serialize(event.uri),
              message: event.message,
            });
            continue;
          }

          const entry = event.entry;
          if (entry.type !== 'file') {
            continue;
          }
          try {
            const segments = entry.relativePath.split('/');
            if (segments.at(-1) !== 'index.md') {
              continue;
            }
            const rootRelative = segments.slice(0, -1).join('/');
            const rootUri =
              rootRelative.length === 0
                ? workspaceRoot
                : this.#uris.joinProviderPath(workspaceRoot, rootRelative);
            const rootUriString = this.#uris.serialize(rootUri);
            if (seenRoots.has(rootUriString)) {
              continue;
            }

            const text = decoder.decode(await this.#port.read(entry.uri));
            const decision = await this.#inspectIndex({
              rootUri,
              indexUri: entry.uri,
              text,
            });
            if (decision.isBundleRoot) {
              const candidate: BundleCandidate<TUri> = {
                rootUri,
                rootUriString,
                indexUri: entry.uri,
                indexUriString: this.#uris.serialize(entry.uri),
                ...(decision.label === undefined ? {} : { label: decision.label }),
              };
              candidates.push(candidate);
              seenRoots.add(rootUriString);
            }
          } catch (error) {
            failures.push({
              uri: this.#uris.serialize(entry.uri),
              message: error instanceof Error ? error.message : 'Unable to inspect bundle index.',
            });
          }
        }
      } catch (error) {
        failures.push({
          uri: this.#uris.serialize(workspaceRoot),
          message: error instanceof Error ? error.message : 'Unable to enumerate workspace root.',
        });
        continue;
      }
    }

    candidates.sort((left, right) => left.rootUriString.localeCompare(right.rootUriString));
    return { candidates, failures };
  }

  resolve(
    discovery: BundleDiscovery<TUri>,
    explicit?: BundleCandidate<TUri>,
  ): BundleSelection<TUri> {
    if (explicit !== undefined) {
      this.#current = explicit;
      return { reason: 'explicit', candidate: explicit, candidates: discovery.candidates };
    }
    if (
      this.#current !== undefined &&
      discovery.candidates.some(
        (candidate) => candidate.rootUriString === this.#current?.rootUriString,
      )
    ) {
      return {
        reason: 'current',
        candidate: this.#current,
        candidates: discovery.candidates,
      };
    }
    if (discovery.candidates.length === 1) {
      const candidate = discovery.candidates[0];
      if (candidate === undefined) {
        return { reason: 'none', candidates: discovery.candidates };
      }
      this.#current = candidate;
      return { reason: 'single', candidate, candidates: discovery.candidates };
    }
    this.#current = undefined;
    return {
      reason: discovery.candidates.length === 0 ? 'none' : 'ambiguous',
      candidates: discovery.candidates,
    };
  }
}
