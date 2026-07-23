import { TextEncoder } from 'node:util';

import type {
  ApplyFailure,
  ApplyReport,
  ChangeSetProposal,
  ExpectedContent,
  FileChangeProposal,
  OperationProblem,
} from '../../core/model/index.js';
import { matchesSha256 } from './contentHash.js';
import {
  captureWorkspaceDirectoryChain,
  captureWorkspaceResourceParentChain,
  verifyWorkspaceDirectoryChain,
  type WorkspaceDirectoryChainSnapshot,
} from './directorySafety.js';
import { relativeParentPaths } from './pathSafety.js';
import {
  assertExpectedByteLength,
  assertSafeActualByteLength,
  assertSafeReportedByteLength,
  BUNDLE_READ_LIMITS,
} from './readSafety.js';
import type { WorkspacePort, WorkspaceWriteReadBoundary } from './types.js';
import { WorkspaceAccessError, WorkspaceWriteAuthorizationError } from './types.js';
import type { WorkspaceUriCodec } from './uriCodec.js';

const encoder = new TextEncoder();

export interface ProposalPreflightReport {
  readonly ready: boolean;
  readonly failed: readonly ApplyFailure[];
}

interface CompletedProposalApplyResult {
  readonly kind: 'completed';
  readonly report: ApplyReport;
}

export type GuardedProposalApplyResult =
  CompletedProposalApplyResult | { readonly kind: 'refused'; readonly problem: OperationProblem };

interface ResolvedChange<TUri> {
  readonly proposal: FileChangeProposal;
  readonly uri: TUri;
  readonly ancestors: readonly ResolvedAncestor<TUri>[];
  /** Existing-or-creatable proposal-relative directories, nearest root first. */
  readonly targetParents: readonly TUri[];
}

interface ResolvedAncestor<TUri> {
  readonly uri: TUri;
  /** Workspace-to-write-root segments must exist; proposal-created parents may be absent. */
  readonly required: boolean;
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
  if (error instanceof WorkspaceWriteAuthorizationError) {
    return failure(
      change,
      error.problem.code === 'preview-unavailable'
        ? 'preview-unavailable'
        : error.problem.code === 'workspace-folder-unavailable'
          ? 'workspace-folder-unavailable'
          : 'unknown',
      error.problem.correctiveAction === undefined
        ? error.problem.message
        : `${error.problem.message} ${error.problem.correctiveAction}`,
      false,
    );
  }
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
  subject: string,
  parentChain: WorkspaceDirectoryChainSnapshot<TUri>,
  uris: WorkspaceUriCodec<TUri>,
): Promise<boolean> {
  const stat = await port.stat(uri);
  const changedBeforeRead = await verifyWorkspaceDirectoryChain(parentChain, port, uris);
  if (changedBeforeRead !== undefined) {
    throw new WorkspaceAccessError('unavailable', changedBeforeRead.message);
  }
  if (expected.kind === 'absent') {
    return stat === undefined;
  }
  if (stat?.type !== 'file') {
    return false;
  }
  assertSafeReportedByteLength(stat, BUNDLE_READ_LIMITS.maxDocumentBytes, subject);
  assertExpectedByteLength(stat.size, expected.byteLength, subject);
  const content = await port.read(uri, { expectedIdentity: stat.readIdentity });
  const changedAfterRead = await verifyWorkspaceDirectoryChain(parentChain, port, uris);
  if (changedAfterRead !== undefined) {
    throw new WorkspaceAccessError('unavailable', changedAfterRead.message);
  }
  assertSafeActualByteLength(content, BUNDLE_READ_LIMITS.maxDocumentBytes, subject);
  assertExpectedByteLength(content.byteLength, expected.byteLength, subject);
  return matchesSha256(content, expected.value);
}

async function captureRequiredResourceParentChain<TUri>(
  workspaceSafetyRoot: TUri,
  resource: TUri,
  port: WorkspacePort<TUri>,
  uris: WorkspaceUriCodec<TUri>,
): Promise<WorkspaceDirectoryChainSnapshot<TUri>> {
  const capture = await captureWorkspaceResourceParentChain(
    workspaceSafetyRoot,
    resource,
    port,
    uris,
  );
  if (!capture.ok) {
    throw new WorkspaceAccessError('unavailable', capture.failure.message);
  }
  return capture.snapshot;
}

async function assertRequiredResourceParentChain<TUri>(
  snapshot: WorkspaceDirectoryChainSnapshot<TUri> | undefined,
  port: WorkspacePort<TUri>,
  uris: WorkspaceUriCodec<TUri>,
): Promise<void> {
  if (snapshot === undefined) {
    throw new WorkspaceAccessError(
      'unavailable',
      'The workspace resource does not have a captured parent directory generation.',
    );
  }
  const changed = await verifyWorkspaceDirectoryChain(snapshot, port, uris);
  if (changed !== undefined) {
    throw new WorkspaceAccessError('unavailable', changed.message);
  }
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
    let directoryChain: WorkspaceDirectoryChainSnapshot<TUri>;
    let workspaceSafetyRoot: TUri;
    let writeRoot: TUri;
    try {
      workspaceSafetyRoot = this.#uris.parse(proposal.workspaceSafetyRootUri);
      writeRoot = this.#uris.parse(proposal.writeRootUri);
      const capture = await captureWorkspaceDirectoryChain(
        workspaceSafetyRoot,
        writeRoot,
        this.#port,
        this.#uris,
      );
      if (!capture.ok) {
        for (const change of changes) {
          failures.push(failure(change.proposal, 'unsafe-path', capture.failure.message, false));
        }
        return { ready: false, failed: failures };
      }
      directoryChain = capture.snapshot;
    } catch (error) {
      for (const change of changes) {
        failures.push(failureFromError(change.proposal, error));
      }
      return { ready: false, failed: failures };
    }
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
    const parentChainCache = new Map<string, WorkspaceDirectoryChainSnapshot<TUri>>();

    for (const change of changes) {
      let safeAncestors = true;
      let deepestExistingParent = writeRoot;
      const missingOptionalAncestors: TUri[] = [];
      for (const ancestor of change.ancestors) {
        try {
          const ancestorStat = await stat(ancestor.uri);
          if (ancestorStat?.type === 'directory') {
            deepestExistingParent = ancestor.uri;
            continue;
          }
          if (ancestorStat === undefined && !ancestor.required) {
            missingOptionalAncestors.push(ancestor.uri);
            continue;
          }
          const ancestorUri = this.#uris.serialize(ancestor.uri);
          failures.push(
            failure(
              change.proposal,
              'unsafe-path',
              ancestorStat === undefined
                ? `Refusing to write because the required workspace path segment ${ancestorUri} no longer exists.`
                : ancestorStat.type === 'symbolic-link'
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
        const parentKey = this.#uris.serialize(deepestExistingParent);
        let parentChain = parentChainCache.get(parentKey);
        if (parentChain === undefined) {
          const capture = await captureWorkspaceDirectoryChain(
            workspaceSafetyRoot,
            deepestExistingParent,
            this.#port,
            this.#uris,
          );
          if (!capture.ok) {
            failures.push(failure(change.proposal, 'unsafe-path', capture.failure.message, false));
            continue;
          }
          parentChain = capture.snapshot;
          parentChainCache.set(parentKey, parentChain);
        }
        let appearedAncestor: TUri | undefined;
        for (const missingAncestor of missingOptionalAncestors) {
          if ((await this.#port.stat(missingAncestor)) !== undefined) {
            appearedAncestor = missingAncestor;
            break;
          }
        }
        if (appearedAncestor !== undefined) {
          failures.push(
            failure(
              change.proposal,
              'unsafe-path',
              `Refusing to use the workspace path segment ${this.#uris.serialize(appearedAncestor)} because it appeared during proposal preflight.`,
              false,
            ),
          );
          continue;
        }
        const changedParent = await verifyWorkspaceDirectoryChain(
          parentChain,
          this.#port,
          this.#uris,
        );
        if (changedParent !== undefined) {
          failures.push(failure(change.proposal, 'unsafe-path', changedParent.message, false));
          continue;
        }
        const changedWriteRoot = await verifyWorkspaceDirectoryChain(
          directoryChain,
          this.#port,
          this.#uris,
        );
        if (changedWriteRoot !== undefined) {
          failures.push(failure(change.proposal, 'unsafe-path', changedWriteRoot.message, false));
          continue;
        }
        if (
          !(await expectedStateMatches(
            this.#port,
            change.uri,
            change.proposal.expected,
            change.proposal.targetUri,
            parentChain,
            this.#uris,
          ))
        ) {
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
        const changedDirectory = await verifyWorkspaceDirectoryChain(
          directoryChain,
          this.#port,
          this.#uris,
        );
        if (changedDirectory !== undefined) {
          failures.push(failure(change.proposal, 'unsafe-path', changedDirectory.message, false));
        }
      } catch (error) {
        failures.push(failureFromError(change.proposal, error));
      }
    }
    return { ready: failures.length === 0, failed: failures };
  }

  async apply(proposal: ChangeSetProposal): Promise<ApplyReport> {
    return (await this.#apply(proposal)).report;
  }

  /** Runs the supplied compatibility check after the final preflight and before the first write. */
  async applyGuarded(
    proposal: ChangeSetProposal,
    beforeFirstWrite: () => Promise<OperationProblem | undefined>,
    beforeEachWrite?: () => OperationProblem | undefined,
  ): Promise<GuardedProposalApplyResult> {
    return this.#apply(proposal, beforeFirstWrite, beforeEachWrite);
  }

  #apply(proposal: ChangeSetProposal): Promise<CompletedProposalApplyResult>;
  #apply(
    proposal: ChangeSetProposal,
    beforeFirstWrite: () => Promise<OperationProblem | undefined>,
    beforeEachWrite?: () => OperationProblem | undefined,
  ): Promise<GuardedProposalApplyResult>;
  async #apply(
    proposal: ChangeSetProposal,
    beforeFirstWrite?: () => Promise<OperationProblem | undefined>,
    beforeEachWrite?: () => OperationProblem | undefined,
  ): Promise<GuardedProposalApplyResult> {
    const { changes, failures: resolutionFailures } = this.#resolve(proposal);
    const preflight = await this.preflight(proposal);
    if (!preflight.ready) {
      const failedUris = new Set(preflight.failed.map((item) => item.targetUri));
      return {
        kind: 'completed',
        report: {
          completed: [],
          failed: preflight.failed,
          untouched: proposal.changes
            .map((change) => change.targetUri)
            .filter((targetUri) => !failedUris.has(targetUri)),
        },
      };
    }
    if (resolutionFailures.length > 0) {
      // Defensive: preflight resolves independently and should already return.
      return {
        kind: 'completed',
        report: {
          completed: [],
          failed: resolutionFailures,
          untouched: changes.map((change) => change.proposal.targetUri),
        },
      };
    }

    const guardProblem = await beforeFirstWrite?.();
    if (guardProblem !== undefined) {
      return { kind: 'refused', problem: guardProblem };
    }

    if (beforeFirstWrite !== undefined) {
      // The compatibility guard performs provider I/O and can race with an ancestor becoming a
      // symlink or non-directory. Recheck the complete proposal after that await. VS Code workspace
      // providers expose no cross-resource transaction, so mutation after these final checks and
      // before the provider write remains a documented fail-detect race rather than an atomic lock.
      const postGuardPreflight = await this.preflight(proposal);
      if (!postGuardPreflight.ready) {
        const failedUris = new Set(postGuardPreflight.failed.map((item) => item.targetUri));
        return {
          kind: 'completed',
          report: {
            completed: [],
            failed: postGuardPreflight.failed,
            untouched: proposal.changes
              .map((change) => change.targetUri)
              .filter((targetUri) => !failedUris.has(targetUri)),
          },
        };
      }
    }

    const workspaceSafetyRoot = this.#uris.parse(proposal.workspaceSafetyRootUri);
    const completed: string[] = [];
    for (let index = 0; index < changes.length; index += 1) {
      const change = changes[index];
      if (change === undefined) {
        continue;
      }
      const ancestorFailure = await this.#freshAncestorFailure(change);
      if (ancestorFailure !== undefined) {
        return {
          kind: 'completed',
          report: {
            completed,
            failed: [ancestorFailure],
            untouched: changes.slice(index + 1).map((remaining) => remaining.proposal.targetUri),
          },
        };
      }
      const writeProblem = beforeEachWrite?.();
      if (writeProblem !== undefined) {
        if (completed.length === 0) {
          return { kind: 'refused', problem: writeProblem };
        }
        const correctiveAction =
          writeProblem.correctiveAction === undefined ? '' : ` ${writeProblem.correctiveAction}`;
        return {
          kind: 'completed',
          report: {
            completed,
            failed: [
              failure(
                change.proposal,
                writeProblem.code === 'preview-unavailable'
                  ? 'preview-unavailable'
                  : writeProblem.code === 'workspace-folder-unavailable'
                    ? 'workspace-folder-unavailable'
                    : 'unknown',
                `${writeProblem.message}${correctiveAction}`,
                false,
              ),
            ],
            untouched: changes.slice(index + 1).map((remaining) => remaining.proposal.targetUri),
          },
        };
      }
      try {
        let expectedParentChain =
          change.proposal.expected.kind === 'absent'
            ? undefined
            : await captureRequiredResourceParentChain(
                workspaceSafetyRoot,
                change.uri,
                this.#port,
                this.#uris,
              );
        let verificationParentChain: WorkspaceDirectoryChainSnapshot<TUri> | undefined;
        const readBoundary: WorkspaceWriteReadBoundary = {
          prepareExpectedRead: async () => {
            expectedParentChain ??= await captureRequiredResourceParentChain(
              workspaceSafetyRoot,
              change.uri,
              this.#port,
              this.#uris,
            );
          },
          assertExpectedRead: () =>
            assertRequiredResourceParentChain(expectedParentChain, this.#port, this.#uris),
          prepareVerificationRead: async () => {
            verificationParentChain = await captureRequiredResourceParentChain(
              workspaceSafetyRoot,
              change.uri,
              this.#port,
              this.#uris,
            );
          },
          assertVerificationRead: () =>
            assertRequiredResourceParentChain(verificationParentChain, this.#port, this.#uris),
        };
        const assertAuthorized =
          beforeEachWrite === undefined
            ? undefined
            : (): void => {
                const problem = beforeEachWrite();
                if (problem !== undefined) {
                  throw new WorkspaceWriteAuthorizationError(problem);
                }
              };
        await this.#port.write(change.uri, encoder.encode(change.proposal.proposedText), {
          expected: change.proposal.expected,
          readBoundary,
          ...(assertAuthorized === undefined ? {} : { assertAuthorized }),
        });
        if (verificationParentChain === undefined) {
          await readBoundary.prepareVerificationRead();
        }
        await readBoundary.assertVerificationRead();
        completed.push(change.proposal.targetUri);
      } catch (error) {
        return {
          kind: 'completed',
          report: {
            completed,
            failed: [failureFromError(change.proposal, error)],
            untouched: changes.slice(index + 1).map((remaining) => remaining.proposal.targetUri),
          },
        };
      }
    }

    return {
      kind: 'completed',
      report: { completed, failed: [], untouched: [] },
    };
  }

  async #freshAncestorFailure(change: ResolvedChange<TUri>): Promise<ApplyFailure | undefined> {
    for (const ancestor of change.ancestors) {
      try {
        const ancestorStat = await this.#port.stat(ancestor.uri);
        if (ancestorStat?.type === 'directory') {
          continue;
        }
        if (ancestorStat === undefined && !ancestor.required) {
          continue;
        }
        const ancestorUri = this.#uris.serialize(ancestor.uri);
        const message =
          ancestorStat === undefined
            ? `Refusing to write because the required workspace path segment ${ancestorUri} no longer exists.`
            : ancestorStat.type === 'symbolic-link'
              ? `Refusing to write through the symbolic-link path segment ${ancestorUri}.`
              : `Refusing to write because the parent path segment ${ancestorUri} is not a directory.`;
        return failure(change.proposal, 'unsafe-path', message, false);
      } catch (error) {
        return failureFromError(change.proposal, error);
      }
    }
    return undefined;
  }

  #resolve(proposal: ChangeSetProposal): {
    changes: ResolvedChange<TUri>[];
    failures: ApplyFailure[];
  } {
    const changes: ResolvedChange<TUri>[] = [];
    const failures: ApplyFailure[] = [];
    const seenTargets = new Set<string>();
    let root: TUri;
    let workspaceSafetyRoot: TUri;
    let requiredAncestors: readonly TUri[];
    try {
      root = this.#uris.parse(proposal.writeRootUri);
      workspaceSafetyRoot = this.#uris.parse(proposal.workspaceSafetyRootUri);
      requiredAncestors = this.#uris.containedPathSegments(workspaceSafetyRoot, root);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'The proposal write root or workspace safety root URI is invalid.';
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
        const seenAncestors = new Set<string>();
        const ancestors: ResolvedAncestor<TUri>[] = [];
        for (const ancestor of requiredAncestors) {
          const key = this.#uris.serialize(ancestor);
          if (!seenAncestors.has(key)) {
            seenAncestors.add(key);
            ancestors.push({ uri: ancestor, required: true });
          }
        }
        for (const ancestor of parentUris) {
          const key = this.#uris.serialize(ancestor);
          if (!seenAncestors.has(key)) {
            seenAncestors.add(key);
            ancestors.push({ uri: ancestor, required: false });
          }
        }
        changes.push({ proposal: change, uri: resolved, ancestors, targetParents: parentUris });
      } catch (error) {
        failures.push(failureFromError(change, error));
      }
    }

    const conflictingChanges = new Map<ResolvedChange<TUri>, Set<string>>();
    const recordConflict = (
      ancestor: ResolvedChange<TUri>,
      descendant: ResolvedChange<TUri>,
    ): void => {
      const description = `${ancestor.proposal.targetUri} is an ancestor of ${descendant.proposal.targetUri}`;
      for (const change of [ancestor, descendant]) {
        const descriptions = conflictingChanges.get(change) ?? new Set<string>();
        descriptions.add(description);
        conflictingChanges.set(change, descriptions);
      }
    };
    const changesByResolvedTarget = new Map<string, ResolvedChange<TUri>>();
    for (const change of changes) {
      const key = this.#uris.serialize(change.uri);
      const duplicate = changesByResolvedTarget.get(key);
      if (duplicate !== undefined) {
        recordConflict(duplicate, change);
      } else {
        changesByResolvedTarget.set(key, change);
      }
    }
    // Every strict target ancestor must be one of the descendant's already-resolved
    // proposal-relative parents. This is O(total path segments), not O(targets²).
    for (const descendant of changes) {
      for (const parent of descendant.targetParents) {
        const ancestor = changesByResolvedTarget.get(this.#uris.serialize(parent));
        if (ancestor !== undefined && ancestor !== descendant) {
          recordConflict(ancestor, descendant);
        }
      }
    }
    for (const [change, descriptions] of conflictingChanges) {
      failures.push(
        failure(
          change.proposal,
          'collision',
          `The proposal contains overlapping file targets (${[...descriptions].join('; ')}).`,
          false,
        ),
      );
    }

    return { changes, failures };
  }
}
