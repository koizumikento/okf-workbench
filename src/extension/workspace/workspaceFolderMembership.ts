import type { OperationProblem } from '../../core/model/index.js';
import type { WorkspaceUriCodec } from './uriCodec.js';

export interface WorkspaceFolderMembershipDisposable {
  dispose(): void;
}

/**
 * One irreversible authorization snapshot for a write workflow.
 *
 * A removed folder never becomes valid again for this session, even when the
 * same URI is added back. The user must review a newly generated proposal.
 */
export interface WorkspaceFolderMembershipSession {
  currentProblem(): OperationProblem | undefined;
  onDidInvalidate(listener: () => void): WorkspaceFolderMembershipDisposable;
  dispose(): void;
}

export interface WorkspaceFolderChange<TUri> {
  readonly removed: readonly TUri[];
}

interface TrackedSession<TUri> {
  readonly root: TUri;
  readonly rootUri: string;
  readonly listeners: Set<() => void>;
  invalidated: boolean;
  disposed: boolean;
}

function unavailableProblem(rootUri: string): OperationProblem {
  return {
    code: 'workspace-folder-unavailable',
    message:
      'The selected workspace folder was removed, replaced, or is no longer an exact open workspace root.',
    correctiveAction:
      'Open the intended workspace folder and run the command again so a new proposal can be reviewed.',
    uri: rootUri,
  };
}

/**
 * Tracks exact workspace-folder identity without assuming a `file:` provider.
 *
 * The host owns change delivery. `currentProblem` also checks the live folder
 * set, so a missed or delayed change event still fails closed at write time.
 */
export class WorkspaceFolderMembershipTracker<TUri> implements WorkspaceFolderMembershipDisposable {
  readonly #uris: WorkspaceUriCodec<TUri>;
  readonly #currentFolders: () => readonly TUri[];
  readonly #sessions = new Set<TrackedSession<TUri>>();
  #disposed = false;

  constructor(uris: WorkspaceUriCodec<TUri>, currentFolders: () => readonly TUri[]) {
    this.#uris = uris;
    this.#currentFolders = currentFolders;
  }

  capture(root: TUri): WorkspaceFolderMembershipSession {
    const tracked: TrackedSession<TUri> = {
      root,
      rootUri: this.#uris.serialize(root),
      listeners: new Set(),
      invalidated: this.#disposed || !this.#isExactlyOpen(root),
      disposed: false,
    };
    if (!tracked.invalidated) {
      this.#sessions.add(tracked);
    }

    const invalidateIfClosed = (): void => {
      if (!tracked.invalidated && !this.#isExactlyOpen(tracked.root)) {
        this.#invalidate(tracked);
      }
    };
    return {
      currentProblem: () => {
        if (tracked.disposed) {
          return unavailableProblem(tracked.rootUri);
        }
        invalidateIfClosed();
        return tracked.invalidated ? unavailableProblem(tracked.rootUri) : undefined;
      },
      onDidInvalidate: (listener) => {
        if (tracked.disposed || tracked.invalidated) {
          try {
            listener();
          } catch {
            // A consumer cleanup failure cannot revive write authorization.
          }
          return { dispose() {} };
        }
        tracked.listeners.add(listener);
        return {
          dispose: () => {
            tracked.listeners.delete(listener);
          },
        };
      },
      dispose: () => {
        if (tracked.disposed) {
          return;
        }
        tracked.disposed = true;
        tracked.listeners.clear();
        this.#sessions.delete(tracked);
      },
    };
  }

  handleWorkspaceFoldersChanged(change: WorkspaceFolderChange<TUri>): void {
    for (const tracked of [...this.#sessions]) {
      if (
        change.removed.some((removed) => this.#uris.equals(removed, tracked.root)) ||
        !this.#isExactlyOpen(tracked.root)
      ) {
        this.#invalidate(tracked);
      }
    }
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const tracked of [...this.#sessions]) {
      this.#invalidate(tracked);
      tracked.disposed = true;
      tracked.listeners.clear();
    }
    this.#sessions.clear();
  }

  #isExactlyOpen(root: TUri): boolean {
    if (this.#disposed) {
      return false;
    }
    try {
      return this.#currentFolders().some((candidate) => this.#uris.equals(candidate, root));
    } catch {
      return false;
    }
  }

  #invalidate(tracked: TrackedSession<TUri>): void {
    if (tracked.invalidated) {
      return;
    }
    tracked.invalidated = true;
    this.#sessions.delete(tracked);
    const listeners = [...tracked.listeners];
    tracked.listeners.clear();
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Authorization remains revoked even when consumer cleanup fails.
      }
    }
  }
}
