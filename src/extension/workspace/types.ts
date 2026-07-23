import type { Uri } from 'vscode';

import type { ExpectedContent, OperationProblem } from '../../core/model/index.js';

export type WorkspaceEntryType = 'directory' | 'file' | 'symbolic-link' | 'unknown';

/**
 * Opaque resource generation captured by a WorkspacePort and consumed only by
 * the same port when it performs the corresponding read.
 */
export type WorkspaceReadIdentity =
  | {
      readonly kind: 'native-file';
      readonly device: string;
      readonly inode: string;
      readonly mode: string;
      readonly ctimeNs: string;
      readonly birthtimeNs: string;
    }
  | {
      /**
       * VS Code exposes no handle or conditional-read API for arbitrary
       * providers. The provider metadata is therefore an explicit trusted
       * boundary rather than an atomic filesystem identity.
       */
      readonly kind: 'trusted-provider';
      readonly type: WorkspaceEntryType;
      readonly size: number;
      readonly ctime: number;
      readonly mtime: number;
    };

export function sameWorkspaceReadIdentity(
  left: WorkspaceReadIdentity | undefined,
  right: WorkspaceReadIdentity | undefined,
): boolean {
  if (left === undefined || right === undefined || left.kind !== right.kind) {
    return left === right;
  }
  if (left.kind === 'native-file' && right.kind === 'native-file') {
    return (
      left.device === right.device &&
      left.inode === right.inode &&
      left.mode === right.mode &&
      left.ctimeNs === right.ctimeNs &&
      left.birthtimeNs === right.birthtimeNs
    );
  }
  if (left.kind === 'trusted-provider' && right.kind === 'trusted-provider') {
    return (
      left.type === right.type &&
      left.size === right.size &&
      left.ctime === right.ctime &&
      left.mtime === right.mtime
    );
  }
  return false;
}

export interface WorkspaceStat {
  readonly type: WorkspaceEntryType;
  readonly size: number;
  readonly ctime: number;
  readonly mtime: number;
  /** Present when this port can verify a later read against the captured generation. */
  readonly readIdentity?: WorkspaceReadIdentity;
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
      /** Safety and generation failures invalidate a complete current-bundle load. */
      readonly reason?: 'access' | 'generation-changed' | 'safety-limit';
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
  /**
   * Rechecks host-owned authorization immediately before a provider mutation.
   * Implementations must invoke it after any preparatory await and before each
   * create/write primitive when supplied.
   */
  readonly assertAuthorized?: () => void;
  /**
   * Anchors the adapter's internal compare-before-write and read-back reads to
   * caller-owned directory generations. The caller prepares a fresh
   * post-mutation snapshot because a create legitimately changes its parent.
   */
  readonly readBoundary?: WorkspaceWriteReadBoundary;
}

export interface WorkspaceWriteReadBoundary {
  prepareExpectedRead(): Promise<void>;
  assertExpectedRead(): Promise<void>;
  prepareVerificationRead(): Promise<void>;
  assertVerificationRead(): Promise<void>;
}

export interface WorkspaceReadOptions {
  /**
   * Generation returned by the immediately preceding stat. Native `file:`
   * implementations must fail closed when it is absent or no longer matches.
   */
  readonly expectedIdentity?: WorkspaceReadIdentity | undefined;
}

export class WorkspaceWriteAuthorizationError extends Error {
  readonly problem: OperationProblem;

  constructor(problem: OperationProblem) {
    super(problem.message);
    this.name = 'WorkspaceWriteAuthorizationError';
    this.problem = problem;
  }
}

/**
 * URI-first access to bundle content. Implementations must not assume `file:`
 * resources and must enforce `WorkspaceWriteOptions.expected`.
 */
export interface WorkspacePort<TUri = Uri> {
  read(uri: TUri, options?: WorkspaceReadOptions): Promise<Uint8Array>;
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
