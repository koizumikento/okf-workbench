import type { Uri } from 'vscode';

import type { ExpectedContent } from '../../core/model/index.js';

export type WorkspaceEntryType = 'directory' | 'file' | 'symbolic-link' | 'unknown';

export interface WorkspaceStat {
  readonly type: WorkspaceEntryType;
  readonly size: number;
  readonly ctime: number;
  readonly mtime: number;
}

export interface WorkspaceEntry<TUri = Uri> {
  readonly uri: TUri;
  /** POSIX path relative to the enumerated root. */
  readonly relativePath: string;
  readonly type: WorkspaceEntryType;
}

export interface WorkspaceEnumerationOptions {
  /** Do not recurse more deeply than this number of path segments. */
  readonly maxDepth?: number;
}

export interface WorkspaceTraversalOptions extends WorkspaceEnumerationOptions {
  /** Directory basenames that are reported at most once but never entered. */
  readonly excludeDirectoryNames?: readonly string[];
  /** When present, emit file entries only for these exact basenames. */
  readonly includeFileNames?: readonly string[];
  /** Defaults to true; callers doing a file search can avoid directory entry materialization. */
  readonly includeDirectories?: boolean;
}

export type WorkspaceTraversalEvent<TUri = Uri> =
  | { readonly kind: 'entry'; readonly entry: WorkspaceEntry<TUri> }
  | {
      readonly kind: 'failure';
      readonly uri: TUri;
      /** POSIX provider path relative to the traversal root; empty for the root itself. */
      readonly relativePath: string;
      readonly message: string;
    };

export interface WorkspaceWriteOptions {
  /**
   * The state that must still be true immediately before writing. Callers may
   * not opt out of this guard. Implementations must use an atomic
   * no-overwrite primitive for `absent` when their platform exposes one. A
   * content hash guard is a best-effort compare-before-write unless the
   * provider exposes a conditional write API.
   */
  readonly expected: ExpectedContent;
}

/**
 * URI-first access to bundle content. Implementations must not assume `file:`
 * resources and must enforce `WorkspaceWriteOptions.expected`.
 */
export interface WorkspacePort<TUri = Uri> {
  read(uri: TUri): Promise<Uint8Array>;
  /** Streams traversal results and reports unreadable subtrees without aborting siblings. */
  traverse(
    root: TUri,
    options?: WorkspaceTraversalOptions,
  ): AsyncIterable<WorkspaceTraversalEvent<TUri>>;
  enumerate(
    root: TUri,
    options?: WorkspaceEnumerationOptions,
  ): Promise<readonly WorkspaceEntry<TUri>[]>;
  stat(uri: TUri): Promise<WorkspaceStat | undefined>;
  write(uri: TUri, content: Uint8Array, options: WorkspaceWriteOptions): Promise<void>;
}

export type WorkspaceAccessErrorCode =
  'content-mismatch' | 'not-found' | 'permission' | 'unavailable' | 'unknown';

export class WorkspaceAccessError extends Error {
  readonly code: WorkspaceAccessErrorCode;

  constructor(code: WorkspaceAccessErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkspaceAccessError';
    this.code = code;
  }
}
