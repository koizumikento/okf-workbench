import { TextEncoder } from 'node:util';

import type {
  ApplyFailure,
  ApplyReport,
  ChangeSetProposal,
  ExpectedContent,
  FileChangeProposal,
} from '../../core/model/index.js';
import { matchesSha256 } from './contentHash.js';
import { relativeParentPaths } from './pathSafety.js';
import type { WorkspacePort } from './types.js';
import { WorkspaceAccessError } from './types.js';
import type { WorkspaceUriCodec } from './uriCodec.js';

const encoder = new TextEncoder();

export interface ProposalPreflightReport {
  readonly ready: boolean;
  readonly failed: readonly ApplyFailure[];
}

interface ResolvedChange<TUri> {
  readonly proposal: FileChangeProposal;
  readonly uri: TUri;
  readonly ancestors: readonly TUri[];
}

function failure(
  change: FileChangeProposal,
  code: ApplyFailure['code'],
  message: string,
  retryable: boolean,
): ApplyFailure {
  return {
    targetUri: change.targetUri,
    code,
    message,
    retryable,
  };
}

function failureFromError(change: FileChangeProposal, error: unknown): ApplyFailure {
  if (error instanceof WorkspaceAccessError) {
    if (error.code === 'content-mismatch') {
      return failure(
        change,
        change.expected.kind === 'absent' ? 'collision' : 'content-changed',
        error.message,
        true,
      );
    }
    if (error.code === 'permission') {
      return failure(change, 'permission', error.message, false);
    }
    if (error.code === 'not-found' && change.expected.kind === 'sha256') {
      return failure(change, 'content-changed', error.message, true);
    }
    return failure(change, 'write', error.message, error.code === 'unavailable');
  }
  const message = error instanceof Error ? error.message : 'Unknown workspace failure.';
  return failure(change, 'unknown', message, false);
}

async function expectedStateMatches<TUri>(
  port: WorkspacePort<TUri>,
  uri: TUri,
  expected: ExpectedContent,
): Promise<boolean> {
  const stat = await port.stat(uri);
  if (expected.kind === 'absent') {
    return stat === undefined;
  }
  if (stat?.type !== 'file') {
    return false;
  }
  return matchesSha256(await port.read(uri), expected.value);
}

/**
 * Applies immutable proposals while retaining explicit evidence of partial
 * completion. It cannot provide a cross-file transaction on virtual file
 * systems, so the first failed write stops every remaining change.
 */
export class ProposalApplicator<TUri> {
  readonly #port: WorkspacePort<TUri>;
  readonly #uris: WorkspaceUriCodec<TUri>;

  constructor(port: WorkspacePort<TUri>, uris: WorkspaceUriCodec<TUri>) {
    this.#port = port;
    this.#uris = uris;
  }

  async preflight(proposal: ChangeSetProposal): Promise<ProposalPreflightReport> {
    const { changes, failures } = this.#resolve(proposal);
    const statCache = new Map<string, ReturnType<WorkspacePort<TUri>['stat']>>();
    const stat = (uri: TUri): ReturnType<WorkspacePort<TUri>['stat']> => {
      const key = this.#uris.serialize(uri);
      const cached = statCache.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const pending = this.#port.stat(uri);
      statCache.set(key, pending);
      return pending;
    };

    for (const change of changes) {
      let safeAncestors = true;
      for (const ancestor of change.ancestors) {
        try {
          const ancestorStat = await stat(ancestor);
          if (ancestorStat === undefined || ancestorStat.type === 'directory') {
            continue;
          }
          const ancestorUri = this.#uris.serialize(ancestor);
          failures.push(
            failure(
              change.proposal,
              'unsafe-path',
              ancestorStat.type === 'symbolic-link'
                ? `Refusing to write through the symbolic-link path segment ${ancestorUri}.`
                : `Refusing to write because the parent path segment ${ancestorUri} is not a directory.`,
              false,
            ),
          );
          safeAncestors = false;
          break;
        } catch (error) {
          failures.push(failureFromError(change.proposal, error));
          safeAncestors = false;
          break;
        }
      }
      if (!safeAncestors) {
        continue;
      }
      try {
        if (!(await expectedStateMatches(this.#port, change.uri, change.proposal.expected))) {
          failures.push(
            failure(
              change.proposal,
              change.proposal.expected.kind === 'absent' ? 'collision' : 'content-changed',
              change.proposal.expected.kind === 'absent'
                ? 'The target already exists. Refresh the preview or choose another path.'
                : 'The target changed after preview. Refresh the preview before applying.',
              true,
            ),
          );
        }
      } catch (error) {
        failures.push(failureFromError(change.proposal, error));
      }
    }
    return { ready: failures.length === 0, failed: failures };
  }

  async apply(proposal: ChangeSetProposal): Promise<ApplyReport> {
    const { changes, failures: resolutionFailures } = this.#resolve(proposal);
    const preflight = await this.preflight(proposal);
    if (!preflight.ready) {
      const failedUris = new Set(preflight.failed.map((item) => item.targetUri));
      return {
        completed: [],
        failed: preflight.failed,
        untouched: proposal.changes
          .map((change) => change.targetUri)
          .filter((targetUri) => !failedUris.has(targetUri)),
      };
    }
    if (resolutionFailures.length > 0) {
      // Defensive: preflight resolves independently and should already return.
      return {
        completed: [],
        failed: resolutionFailures,
        untouched: changes.map((change) => change.proposal.targetUri),
      };
    }

    const completed: string[] = [];
    for (let index = 0; index < changes.length; index += 1) {
      const change = changes[index];
      if (change === undefined) {
        continue;
      }
      try {
        await this.#port.write(change.uri, encoder.encode(change.proposal.proposedText), {
          expected: change.proposal.expected,
        });
        completed.push(change.proposal.targetUri);
      } catch (error) {
        return {
          completed,
          failed: [failureFromError(change.proposal, error)],
          untouched: changes.slice(index + 1).map((remaining) => remaining.proposal.targetUri),
        };
      }
    }

    return { completed, failed: [], untouched: [] };
  }

  #resolve(proposal: ChangeSetProposal): {
    changes: ResolvedChange<TUri>[];
    failures: ApplyFailure[];
  } {
    const changes: ResolvedChange<TUri>[] = [];
    const failures: ApplyFailure[] = [];
    const seenTargets = new Set<string>();
    let root: TUri;
    try {
      root = this.#uris.parse(proposal.writeRootUri);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The bundle URI is invalid.';
      for (const change of proposal.changes) {
        failures.push(failure(change, 'unknown', message, false));
      }
      return { changes, failures };
    }

    for (const change of proposal.changes) {
      if (seenTargets.has(change.targetUri)) {
        failures.push(
          failure(change, 'collision', 'The proposal contains the target more than once.', false),
        );
        continue;
      }
      seenTargets.add(change.targetUri);

      try {
        const resolved =
          change.pathIdentity === 'provider'
            ? this.#uris.joinProviderPath(root, change.relativePath)
            : this.#uris.joinContained(root, change.relativePath);
        const declared = this.#uris.parse(change.targetUri);
        if (!this.#uris.equals(resolved, declared)) {
          failures.push(
            failure(
              change,
              'unknown',
              'The declared target URI does not match its bundle-relative path.',
              false,
            ),
          );
          continue;
        }
        const parentPaths = relativeParentPaths(change.relativePath, change.pathIdentity);
        const parentUris = parentPaths.map((relativePath) =>
          change.pathIdentity === 'provider'
            ? this.#uris.joinProviderPath(root, relativePath)
            : this.#uris.joinContained(root, relativePath),
        );
        changes.push({ proposal: change, uri: resolved, ancestors: [root, ...parentUris] });
      } catch (error) {
        failures.push(failureFromError(change, error));
      }
    }

    return { changes, failures };
  }
}
