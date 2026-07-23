import { TextDecoder } from 'node:util';

import { OKF_SEMANTIC_LIMITS } from '../../core/model/index.js';
import {
  captureWorkspaceDirectoryChain,
  verifyWorkspaceDirectoryChain,
} from './directorySafety.js';
import type { WorkspacePort } from './types.js';
import type { WorkspaceUriCodec } from './uriCodec.js';

// Preserve a leading BOM so the core parser, rather than this adapter, enforces the one-BOM policy.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

function identityFailure(value: string, kind: 'path' | 'uri'): string | undefined {
  const maxCodeUnits =
    kind === 'path'
      ? OKF_SEMANTIC_LIMITS.maxProviderPathCodeUnits
      : OKF_SEMANTIC_LIMITS.maxSourceUriCodeUnits;
  const maxBytes =
    kind === 'path'
      ? OKF_SEMANTIC_LIMITS.maxProviderPathBytes
      : OKF_SEMANTIC_LIMITS.maxSourceUriBytes;
  if (value.length > maxCodeUnits || encoder.encode(value).byteLength > maxBytes) {
    return `Automatic bundle discovery refused an oversized provider ${kind} identity.`;
  }
  if (kind === 'path') {
    let segments = value.length === 0 ? 0 : 1;
    for (let index = 0; index < value.length; index += 1) {
      if (value.charCodeAt(index) === 0x2f) {
        segments += 1;
      }
    }
    if (segments > OKF_SEMANTIC_LIMITS.maxProviderPathSegments) {
      return `Automatic bundle discovery refused a provider path deeper than ${String(OKF_SEMANTIC_LIMITS.maxProviderPathSegments)} segments.`;
    }
  }
  return undefined;
}

function boundedFailureText(value: string): string {
  const limit = OKF_SEMANTIC_LIMITS.maxFailureDetailCodeUnits;
  if (value.length <= limit) {
    return value;
  }
  let end = limit - 1;
  const finalCodeUnit = value.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    end -= 1;
  }
  return `${value.slice(0, end)}…`;
}

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

/**
 * Automatic discovery is a convenience path, not an exhaustive workspace
 * indexer. These limits keep a large or adversarial workspace from turning a
 * command invocation into an unbounded traversal or an unbounded result set.
 * A directory can always be selected explicitly when it falls outside them.
 */
export const BUNDLE_DISCOVERY_DEFAULT_LIMITS = {
  maxWorkspaceRoots: 32,
  maxDepth: 16,
  maxIndexFiles: 512,
  maxIndexBytes: 1_048_576,
  maxTotalIndexBytes: 8_388_608,
  maxFailures: 64,
} as const;

export interface BundleDiscoveryLimits {
  readonly maxWorkspaceRoots: number;
  readonly maxDepth: number;
  readonly maxIndexFiles: number;
  readonly maxIndexBytes: number;
  readonly maxTotalIndexBytes: number;
  readonly maxFailures: number;
}

export type BundleDiscoveryLimitOverrides = Partial<BundleDiscoveryLimits>;

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
  /** True when a safety limit or access failure left part of the search space uninspected. */
  readonly truncated: boolean;
}

export type BundleSelectionReason =
  'current' | 'explicit' | 'single' | 'none' | 'ambiguous' | 'incomplete';

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
  readonly #limits: BundleDiscoveryLimits;
  #current: BundleCandidate<TUri> | undefined;

  constructor(
    port: WorkspacePort<TUri>,
    uris: WorkspaceUriCodec<TUri>,
    inspectIndex: InspectBundleIndex<TUri>,
    limitOverrides: BundleDiscoveryLimitOverrides = {},
  ) {
    this.#port = port;
    this.#uris = uris;
    this.#inspectIndex = inspectIndex;
    this.#limits = resolveDiscoveryLimits(limitOverrides);
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
   * valid OKF root is delegated to the parser/validator callback. The injected
   * traversal must emit a failure event whenever maxDepth prevents descent;
   * silent truncation would make automatic single-candidate selection unsafe.
   */
  async discover(workspaceRoots: readonly TUri[]): Promise<BundleDiscovery<TUri>> {
    const candidates: BundleCandidate<TUri>[] = [];
    const failures: BundleDiscoveryFailure[] = [];
    const seenRoots = new Set<string>();
    let omittedFailureCount = 0;
    let inspectedIndexCount = 0;
    let inspectedIndexBytes = 0;
    let truncated = false;

    const recordFailure = (failure: BundleDiscoveryFailure, searchSpaceIncomplete = true): void => {
      if (searchSpaceIncomplete) {
        truncated = true;
      }
      if (failures.length < this.#limits.maxFailures) {
        failures.push({
          uri:
            identityFailure(failure.uri, 'uri') === undefined
              ? failure.uri
              : '<provider-uri-exceeds-limit>',
          message: boundedFailureText(failure.message),
        });
      } else {
        omittedFailureCount += 1;
      }
    };

    const roots = workspaceRoots.slice(0, this.#limits.maxWorkspaceRoots);
    if (workspaceRoots.length > roots.length) {
      const firstOmittedRoot = workspaceRoots[roots.length];
      if (firstOmittedRoot !== undefined) {
        recordFailure({
          uri: this.#uris.serialize(firstOmittedRoot),
          message: `Automatic bundle discovery stopped after ${String(this.#limits.maxWorkspaceRoots)} workspace roots. Select a bundle directory explicitly to inspect an omitted root.`,
        });
      }
    }

    discovery: for (const workspaceRoot of roots) {
      const workspaceRootString = this.#uris.serialize(workspaceRoot);
      const workspaceRootFailure = identityFailure(workspaceRootString, 'uri');
      if (workspaceRootFailure !== undefined) {
        recordFailure({ uri: '<provider-uri-exceeds-limit>', message: workspaceRootFailure });
        continue;
      }
      try {
        const traversal = this.#port.traverse(workspaceRoot, {
          maxDepth: this.#limits.maxDepth,
          excludeDirectoryNames: BUNDLE_DISCOVERY_EXCLUDED_DIRECTORY_NAMES,
          includeFileNames: ['index.md'],
          includeDirectories: false,
        });
        for await (const event of traversal) {
          if (event.kind === 'failure') {
            recordFailure({
              uri: this.#uris.serialize(event.uri),
              message: event.message,
            });
            continue;
          }

          const entry = event.entry;
          if (entry.type !== 'file') {
            continue;
          }
          const entryUriString = this.#uris.serialize(entry.uri);
          const entryIdentityFailure =
            identityFailure(entry.relativePath, 'path') ?? identityFailure(entryUriString, 'uri');
          if (entryIdentityFailure !== undefined) {
            recordFailure({
              uri:
                identityFailure(entryUriString, 'uri') === undefined
                  ? entryUriString
                  : '<provider-uri-exceeds-limit>',
              message: entryIdentityFailure,
            });
            continue;
          }
          if (inspectedIndexCount >= this.#limits.maxIndexFiles) {
            recordFailure({
              uri: this.#uris.serialize(workspaceRoot),
              message: `Automatic bundle discovery stopped after ${String(this.#limits.maxIndexFiles)} index.md files. Select a bundle directory explicitly to inspect another candidate.`,
            });
            break discovery;
          }
          inspectedIndexCount += 1;
          try {
            const segments = entry.relativePath.split('/');
            if (segments.at(-1) !== 'index.md') {
              continue;
            }
            const expectedIndexUri = this.#uris.joinProviderPath(workspaceRoot, entry.relativePath);
            if (!this.#uris.equals(expectedIndexUri, entry.uri)) {
              throw new Error(
                'The workspace provider returned an index URI that does not match its relative path.',
              );
            }
            const rootRelative = segments.slice(0, -1).join('/');
            const rootUri =
              rootRelative.length === 0
                ? workspaceRoot
                : this.#uris.joinProviderPath(workspaceRoot, rootRelative);
            const rootUriString = this.#uris.serialize(rootUri);
            const rootIdentityFailure = identityFailure(rootUriString, 'uri');
            if (rootIdentityFailure !== undefined) {
              throw new Error(rootIdentityFailure);
            }
            if (seenRoots.has(rootUriString)) {
              continue;
            }

            const directoryChain = await captureWorkspaceDirectoryChain(
              workspaceRoot,
              rootUri,
              this.#port,
              this.#uris,
            );
            if (!directoryChain.ok) {
              throw new Error(directoryChain.failure.message);
            }
            const stat = await this.#port.stat(entry.uri);
            if (stat?.type !== 'file') {
              throw new Error('The discovered index is no longer a readable file.');
            }
            if (stat.size > this.#limits.maxIndexBytes) {
              throw new Error(
                `Automatic bundle discovery does not inspect index.md files larger than ${String(this.#limits.maxIndexBytes)} bytes.`,
              );
            }
            if (inspectedIndexBytes + stat.size > this.#limits.maxTotalIndexBytes) {
              recordFailure({
                uri: this.#uris.serialize(workspaceRoot),
                message: `Automatic bundle discovery stopped after reading ${String(inspectedIndexBytes)} index bytes because the ${String(this.#limits.maxTotalIndexBytes)}-byte total limit would be exceeded. Select a bundle directory explicitly to inspect another candidate.`,
              });
              break discovery;
            }
            const changedBeforeRead = await verifyWorkspaceDirectoryChain(
              directoryChain.snapshot,
              this.#port,
              this.#uris,
            );
            if (changedBeforeRead !== undefined) {
              throw new Error(changedBeforeRead.message);
            }
            // The WorkspacePort read contract returns one materialized byte
            // array. In VS Code, workspace.fs.readFile therefore cannot cap a
            // single dishonest provider response before it reaches memory.
            const bytes = await this.#port.read(entry.uri, {
              expectedIdentity: stat.readIdentity,
            });
            const changedDirectory = await verifyWorkspaceDirectoryChain(
              directoryChain.snapshot,
              this.#port,
              this.#uris,
            );
            if (changedDirectory !== undefined) {
              throw new Error(changedDirectory.message);
            }
            if (bytes.byteLength > this.#limits.maxIndexBytes) {
              recordFailure({
                uri: this.#uris.serialize(entry.uri),
                message: `Automatic bundle discovery stopped because an index.md read returned more than the ${String(this.#limits.maxIndexBytes)}-byte file limit. Select the bundle directory explicitly after reducing the index size.`,
              });
              break discovery;
            }
            if (inspectedIndexBytes + bytes.byteLength > this.#limits.maxTotalIndexBytes) {
              recordFailure({
                uri: this.#uris.serialize(workspaceRoot),
                message: `Automatic bundle discovery stopped after reading ${String(inspectedIndexBytes)} index bytes because the ${String(this.#limits.maxTotalIndexBytes)}-byte total limit would be exceeded. Select a bundle directory explicitly to inspect another candidate.`,
              });
              break discovery;
            }
            inspectedIndexBytes += bytes.byteLength;
            let text: string;
            try {
              text = decoder.decode(bytes);
            } catch (error) {
              recordFailure(
                {
                  uri: this.#uris.serialize(entry.uri),
                  message:
                    error instanceof Error ? error.message : 'The bundle index is not valid UTF-8.',
                },
                false,
              );
              continue;
            }
            let decision: BundleIndexDecision;
            try {
              decision = await this.#inspectIndex({
                rootUri,
                indexUri: entry.uri,
                text,
              });
            } catch (error) {
              const changedAfterInspectionFailure = await verifyWorkspaceDirectoryChain(
                directoryChain.snapshot,
                this.#port,
                this.#uris,
              );
              if (changedAfterInspectionFailure !== undefined) {
                throw new Error(changedAfterInspectionFailure.message);
              }
              recordFailure(
                {
                  uri: this.#uris.serialize(entry.uri),
                  message: error instanceof Error ? error.message : 'Unable to parse bundle index.',
                },
                false,
              );
              continue;
            }
            const changedAfterInspection = await verifyWorkspaceDirectoryChain(
              directoryChain.snapshot,
              this.#port,
              this.#uris,
            );
            if (changedAfterInspection !== undefined) {
              throw new Error(changedAfterInspection.message);
            }
            if (decision.isBundleRoot) {
              if (
                decision.label !== undefined &&
                decision.label.length > OKF_SEMANTIC_LIMITS.maxTitleCodeUnits
              ) {
                throw new Error('The discovered bundle label exceeds the metadata safety limit.');
              }
              const candidate: BundleCandidate<TUri> = {
                rootUri,
                rootUriString,
                indexUri: entry.uri,
                indexUriString: entryUriString,
                ...(decision.label === undefined ? {} : { label: decision.label }),
              };
              candidates.push(candidate);
              seenRoots.add(rootUriString);
            }
          } catch (error) {
            recordFailure({
              uri: this.#uris.serialize(entry.uri),
              message: error instanceof Error ? error.message : 'Unable to inspect bundle index.',
            });
          }
        }
      } catch (error) {
        recordFailure({
          uri: this.#uris.serialize(workspaceRoot),
          message: error instanceof Error ? error.message : 'Unable to enumerate workspace root.',
        });
        continue;
      }
    }

    if (omittedFailureCount > 0) {
      const summary: BundleDiscoveryFailure = {
        uri:
          roots[0] === undefined
            ? 'okf-workbench:bundle-discovery'
            : this.#uris.serialize(roots[0]),
        message: `${String(omittedFailureCount + 1)} additional bundle discovery failures were omitted after the ${String(this.#limits.maxFailures)}-failure reporting limit.`,
      };
      // Replace the last retained detail so the returned failure collection
      // remains strictly bounded while still making the omission visible.
      failures[this.#limits.maxFailures - 1] = summary;
    }

    candidates.sort((left, right) => left.rootUriString.localeCompare(right.rootUriString));
    return { candidates, failures, truncated };
  }

  resolve(
    discovery: BundleDiscovery<TUri>,
    explicit?: BundleCandidate<TUri>,
  ): BundleSelection<TUri> {
    if (explicit !== undefined) {
      this.#current = explicit;
      return { reason: 'explicit', candidate: explicit, candidates: discovery.candidates };
    }
    if (discovery.truncated) {
      this.#current = undefined;
      return { reason: 'incomplete', candidates: discovery.candidates };
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

function resolveDiscoveryLimits(overrides: BundleDiscoveryLimitOverrides): BundleDiscoveryLimits {
  const resolved: BundleDiscoveryLimits = {
    ...BUNDLE_DISCOVERY_DEFAULT_LIMITS,
    ...overrides,
  };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive integer.`);
    }
  }
  return resolved;
}
