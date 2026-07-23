import { constants as fsConstants, type BigIntStats } from 'node:fs';
import { lstat as nodeLstat, open as nodeOpen, type FileHandle } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { FileSystemError, FileType, Uri, WorkspaceEdit, workspace } from 'vscode';

import type { ExpectedContent } from '../../core/model/index.js';
import { OKF_SEMANTIC_LIMITS } from '../../core/model/index.js';
import { matchesSha256, sha256Content } from './contentHash.js';
import {
  captureWorkspaceDirectoryChain,
  verifyWorkspaceDirectoryChain,
  type WorkspaceDirectoryChainSnapshot,
} from './directorySafety.js';
import { isUriContained } from './pathSafety.js';
import {
  addBytesWithinLimit,
  assertExpectedByteLength,
  assertSafeActualByteLength,
  assertSafeReportedByteLength,
  BUNDLE_READ_LIMITS,
} from './readSafety.js';
import {
  WorkspaceAccessError,
  WorkspaceWriteAuthorizationError,
  sameWorkspaceReadIdentity,
  type WorkspaceEntry,
  type WorkspaceEntryType,
  type WorkspaceEnumerationOptions,
  type WorkspacePort,
  type WorkspaceReadIdentity,
  type WorkspaceReadOptions,
  type WorkspaceStat,
  type WorkspaceTraversalEvent,
  type WorkspaceTraversalOptions,
  type WorkspaceWriteReadBoundary,
  type WorkspaceWriteOptions,
} from './types.js';
import { vscodeUriCodec } from './uriCodec.js';

export interface NativeWorkspaceFileSystem {
  lstat(path: string): Promise<BigIntStats>;
  open(path: string, flags: number): Promise<FileHandle>;
}

const defaultNativeFileSystem: NativeWorkspaceFileSystem = {
  lstat: async (path) => nodeLstat(path, { bigint: true }),
  open: (path, flags) => nodeOpen(path, flags),
};

function entryType(type: FileType): WorkspaceEntryType {
  if ((type & FileType.SymbolicLink) !== 0) {
    return 'symbolic-link';
  }
  if ((type & FileType.Directory) !== 0) {
    return 'directory';
  }
  if ((type & FileType.File) !== 0) {
    return 'file';
  }
  return 'unknown';
}

function boundedDiagnosticText(message: string): string {
  const limit = OKF_SEMANTIC_LIMITS.maxFailureDetailCodeUnits;
  if (message.length <= limit) {
    return message;
  }
  let end = limit - 1;
  const finalCodeUnit = message.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    end -= 1;
  }
  return `${message.slice(0, end)}…`;
}

function accessError(error: unknown, action: string): WorkspaceAccessError {
  if (error instanceof WorkspaceAccessError) {
    return error;
  }
  if (error instanceof FileSystemError) {
    const code =
      error.code === 'FileExists'
        ? 'content-mismatch'
        : error.code === 'FileNotFound'
          ? 'not-found'
          : error.code === 'NoPermissions'
            ? 'permission'
            : error.code === 'Unavailable'
              ? 'unavailable'
              : 'unknown';
    return new WorkspaceAccessError(code, boundedDiagnosticText(`${action}: ${error.message}`), {
      cause: error,
    });
  }
  const nativeCode = nativeErrorCode(error);
  const code =
    nativeCode === 'ENOENT' || nativeCode === 'ENOTDIR'
      ? 'not-found'
      : nativeCode === 'EACCES' || nativeCode === 'EPERM'
        ? 'permission'
        : nativeCode === 'EBUSY' || nativeCode === 'EIO'
          ? 'unavailable'
          : 'unknown';
  return new WorkspaceAccessError(
    code,
    boundedDiagnosticText(`${action}: workspace access failed.`),
    { cause: error },
  );
}

function nativeErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

function nativeEntryType(stat: BigIntStats): WorkspaceEntryType {
  if (stat.isSymbolicLink()) {
    return 'symbolic-link';
  }
  if (stat.isDirectory()) {
    return 'directory';
  }
  if (stat.isFile()) {
    return 'file';
  }
  return 'unknown';
}

function boundedNativeNumber(value: bigint): number {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

function nativeReadIdentity(stat: BigIntStats): WorkspaceReadIdentity {
  return {
    kind: 'native-file',
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    mode: stat.mode.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    birthtimeNs: stat.birthtimeNs.toString(),
  };
}

function providerReadIdentity(stat: {
  readonly type: WorkspaceEntryType;
  readonly size: number;
  readonly ctime: number;
  readonly mtime: number;
}): WorkspaceReadIdentity {
  return { kind: 'trusted-provider', ...stat };
}

function nativePath(uri: Uri): string {
  return fileURLToPath(uri.toString());
}

async function statOrUndefined(
  uri: Uri,
  nativeFileSystem: NativeWorkspaceFileSystem,
): Promise<WorkspaceStat | undefined> {
  if (uri.scheme === 'file') {
    try {
      const stat = await nativeFileSystem.lstat(nativePath(uri));
      const type = nativeEntryType(stat);
      return {
        type,
        size: boundedNativeNumber(stat.size),
        ctime: boundedNativeNumber(stat.ctimeNs / 1_000_000n),
        mtime: boundedNativeNumber(stat.mtimeNs / 1_000_000n),
        readIdentity: nativeReadIdentity(stat),
      };
    } catch (error) {
      const code = nativeErrorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return undefined;
      }
      throw accessError(error, `Unable to inspect ${uri.toString()}`);
    }
  }
  try {
    const stat = await workspace.fs.stat(uri);
    const result = {
      type: entryType(stat.type),
      size: stat.size,
      ctime: stat.ctime,
      mtime: stat.mtime,
    };
    return { ...result, readIdentity: providerReadIdentity(result) };
  } catch (error) {
    if (error instanceof FileSystemError && error.code === 'FileNotFound') {
      return undefined;
    }
    throw accessError(error, `Unable to inspect ${uri.toString()}`);
  }
}

async function readNativeIdentityBound(
  uri: Uri,
  expectedIdentity: WorkspaceReadIdentity | undefined,
  nativeFileSystem: NativeWorkspaceFileSystem,
): Promise<Uint8Array> {
  if (expectedIdentity?.kind !== 'native-file') {
    throw new WorkspaceAccessError(
      'unavailable',
      `OKF Workbench refused to read ${uri.toString()} without a native file-generation identity.`,
    );
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  let handle: FileHandle | undefined;
  let content: Uint8Array | undefined;
  let primaryFailure: WorkspaceAccessError | undefined;
  try {
    handle = await nativeFileSystem.open(nativePath(uri), fsConstants.O_RDONLY | noFollow);
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      !sameWorkspaceReadIdentity(nativeReadIdentity(before), expectedIdentity)
    ) {
      throw new WorkspaceAccessError(
        'content-mismatch',
        `OKF Workbench refused to read ${uri.toString()} because its native file identity changed.`,
      );
    }
    const readContent = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      !after.isFile() ||
      !sameWorkspaceReadIdentity(nativeReadIdentity(after), expectedIdentity)
    ) {
      throw new WorkspaceAccessError(
        'content-mismatch',
        `OKF Workbench discarded ${uri.toString()} because its native file identity changed during the read.`,
      );
    }
    const current = await nativeFileSystem.lstat(nativePath(uri));
    if (
      !current.isFile() ||
      !sameWorkspaceReadIdentity(nativeReadIdentity(current), expectedIdentity)
    ) {
      throw new WorkspaceAccessError(
        'content-mismatch',
        `OKF Workbench discarded ${uri.toString()} because its workspace path changed during the read.`,
      );
    }
    content = new Uint8Array(readContent);
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      primaryFailure = error;
    } else {
      const code = nativeErrorCode(error);
      const errorCode =
        code === 'ENOENT' || code === 'ENOTDIR'
          ? 'not-found'
          : code === 'EACCES' || code === 'EPERM'
            ? 'permission'
            : 'unavailable';
      primaryFailure = new WorkspaceAccessError(
        errorCode,
        boundedDiagnosticText(`Unable to read ${uri.toString()} through a stable file handle.`),
        { cause: error },
      );
    }
  }

  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (closeFailure) {
      if (primaryFailure === undefined) {
        primaryFailure = new WorkspaceAccessError(
          'unavailable',
          boundedDiagnosticText(
            `OKF Workbench could not confirm closure of the stable file handle for ${uri.toString()}.`,
          ),
          { cause: closeFailure },
        );
      } else {
        Object.defineProperty(primaryFailure, 'closeFailure', {
          configurable: true,
          value: closeFailure,
        });
      }
    }
  }
  if (primaryFailure !== undefined) {
    throw primaryFailure;
  }
  if (content === undefined) {
    throw new WorkspaceAccessError(
      'unavailable',
      boundedDiagnosticText(
        `OKF Workbench did not receive content through the stable file handle for ${uri.toString()}.`,
      ),
    );
  }
  return content;
}

async function readProviderIdentityBound(
  uri: Uri,
  expectedIdentity: WorkspaceReadIdentity | undefined,
  nativeFileSystem: NativeWorkspaceFileSystem,
): Promise<Uint8Array> {
  if (expectedIdentity?.kind !== 'trusted-provider') {
    throw new WorkspaceAccessError(
      'unavailable',
      `OKF Workbench refused to read ${uri.toString()} without a trusted provider generation.`,
    );
  }
  const before = await statOrUndefined(uri, nativeFileSystem);
  if (!sameWorkspaceReadIdentity(before?.readIdentity, expectedIdentity)) {
    throw new WorkspaceAccessError(
      'content-mismatch',
      `The workspace provider resource changed before it could be read: ${uri.toString()}.`,
    );
  }
  let content: Uint8Array;
  try {
    content = await workspace.fs.readFile(uri);
  } catch (error) {
    throw accessError(error, `Unable to read ${uri.toString()}`);
  }
  const after = await statOrUndefined(uri, nativeFileSystem);
  if (!sameWorkspaceReadIdentity(after?.readIdentity, expectedIdentity)) {
    throw new WorkspaceAccessError(
      'content-mismatch',
      `The workspace provider resource changed while it was being read: ${uri.toString()}.`,
    );
  }
  return content;
}

async function readIdentityBound(
  uri: Uri,
  expectedIdentity: WorkspaceReadIdentity | undefined,
  nativeFileSystem: NativeWorkspaceFileSystem,
): Promise<Uint8Array> {
  return uri.scheme === 'file'
    ? readNativeIdentityBound(uri, expectedIdentity, nativeFileSystem)
    : readProviderIdentityBound(uri, expectedIdentity, nativeFileSystem);
}

async function assertExpected(
  uri: Uri,
  expected: ExpectedContent,
  nativeFileSystem: NativeWorkspaceFileSystem,
  readBoundary?: WorkspaceWriteReadBoundary,
): Promise<void> {
  await readBoundary?.prepareExpectedRead();
  await readBoundary?.assertExpectedRead();
  const stat = await statOrUndefined(uri, nativeFileSystem);
  await readBoundary?.assertExpectedRead();
  if (expected.kind === 'absent') {
    if (stat !== undefined) {
      throw new WorkspaceAccessError(
        'content-mismatch',
        `Refusing to overwrite existing workspace resource ${uri.toString()}.`,
      );
    }
    return;
  }

  if (stat?.type !== 'file') {
    throw new WorkspaceAccessError(
      'content-mismatch',
      `The expected workspace file no longer exists at ${uri.toString()}.`,
    );
  }
  const subject = uri.toString();
  assertSafeReportedByteLength(stat, BUNDLE_READ_LIMITS.maxDocumentBytes, subject);
  assertExpectedByteLength(stat.size, expected.byteLength, subject);

  let current: Uint8Array;
  try {
    current = await readIdentityBound(uri, stat.readIdentity, nativeFileSystem);
  } catch (error) {
    throw accessError(error, `Unable to verify ${uri.toString()}`);
  }
  await readBoundary?.assertExpectedRead();
  assertSafeActualByteLength(current, BUNDLE_READ_LIMITS.maxDocumentBytes, subject);
  assertExpectedByteLength(current.byteLength, expected.byteLength, subject);
  if (!matchesSha256(current, expected.value)) {
    throw new WorkspaceAccessError(
      'content-mismatch',
      `The workspace file changed after preview: ${uri.toString()}.`,
    );
  }
}

async function verifyWrittenContent(
  uri: Uri,
  expected: Uint8Array,
  nativeFileSystem: NativeWorkspaceFileSystem,
  readBoundary?: WorkspaceWriteReadBoundary,
): Promise<void> {
  await readBoundary?.prepareVerificationRead();
  const stat = await statOrUndefined(uri, nativeFileSystem);
  await readBoundary?.assertVerificationRead();
  if (stat?.type !== 'file') {
    throw new WorkspaceAccessError(
      'content-mismatch',
      `The workspace provider did not retain a file at ${uri.toString()}.`,
    );
  }
  const subject = uri.toString();
  assertSafeReportedByteLength(stat, BUNDLE_READ_LIMITS.maxDocumentBytes, subject);
  assertExpectedByteLength(stat.size, expected.byteLength, subject);
  let actual: Uint8Array;
  try {
    actual = await readIdentityBound(uri, stat.readIdentity, nativeFileSystem);
  } catch (error) {
    throw accessError(error, `Unable to verify the write to ${uri.toString()}`);
  }
  await readBoundary?.assertVerificationRead();
  assertSafeActualByteLength(actual, BUNDLE_READ_LIMITS.maxDocumentBytes, subject);
  assertExpectedByteLength(actual.byteLength, expected.byteLength, subject);

  if (!matchesSha256(actual, sha256Content(expected))) {
    throw new WorkspaceAccessError(
      'content-mismatch',
      `The workspace provider did not retain the proposed content at ${uri.toString()}.`,
    );
  }
}

const DEFAULT_MAX_TRAVERSAL_DIRECTORIES = 10_000;
const DEFAULT_MAX_TRAVERSAL_ENTRIES = 100_000;
const utf8Encoder = new TextEncoder();

export interface VscodeWorkspacePortOptions {
  /** Hard provider-call budget for one traversal, including its root directory. */
  readonly maxTraversalDirectories?: number;
  /**
   * Cumulative provider-returned tuple budget for one traversal, before
   * caller-side filtering. VS Code materializes each readDirectory response
   * before this adapter can enforce the budget, so one response may be larger
   * in temporary memory than this value.
   */
  readonly maxTraversalEntries?: number;
  /** Injectable only so real-filesystem identity races can be tested deterministically. */
  readonly nativeFileSystem?: NativeWorkspaceFileSystem;
}

export class VscodeWorkspacePort implements WorkspacePort<Uri> {
  readonly #maxTraversalDirectories: number;
  readonly #maxTraversalEntries: number;
  readonly #nativeFileSystem: NativeWorkspaceFileSystem;

  constructor(options: VscodeWorkspacePortOptions = {}) {
    this.#maxTraversalDirectories = positiveInteger(
      options.maxTraversalDirectories ?? DEFAULT_MAX_TRAVERSAL_DIRECTORIES,
      'maxTraversalDirectories',
    );
    this.#maxTraversalEntries = positiveInteger(
      options.maxTraversalEntries ?? DEFAULT_MAX_TRAVERSAL_ENTRIES,
      'maxTraversalEntries',
    );
    this.#nativeFileSystem = options.nativeFileSystem ?? defaultNativeFileSystem;
  }

  async read(uri: Uri, options: WorkspaceReadOptions = {}): Promise<Uint8Array> {
    return readIdentityBound(uri, options.expectedIdentity, this.#nativeFileSystem);
  }

  async enumerate(
    root: Uri,
    options: WorkspaceEnumerationOptions = {},
  ): Promise<readonly WorkspaceEntry<Uri>[]> {
    const entries: WorkspaceEntry<Uri>[] = [];
    for await (const event of this.traverse(root, options)) {
      if (event.kind === 'failure') {
        throw new WorkspaceAccessError('unavailable', event.message);
      }
      entries.push(event.entry);
    }
    return entries;
  }

  async *traverse(
    root: Uri,
    options: WorkspaceTraversalOptions = {},
  ): AsyncIterable<WorkspaceTraversalEvent<Uri>> {
    const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
    if (!Number.isInteger(maxDepth) && maxDepth !== Number.POSITIVE_INFINITY) {
      throw new RangeError('maxDepth must be a non-negative integer.');
    }
    if (maxDepth < 0) {
      throw new RangeError('maxDepth must be a non-negative integer.');
    }

    const rootCapture = await captureWorkspaceDirectoryChain(root, root, this, vscodeUriCodec);
    if (!rootCapture.ok) {
      yield {
        kind: 'failure',
        uri: root,
        relativePath: '',
        message: `Workspace traversal requires a stable real directory root and will not follow a missing, changed, non-directory, or symbolic-link root: ${rootCapture.failure.message}`,
      };
      return;
    }
    const traversalRootSnapshot = rootCapture.snapshot;

    const excluded = new Set(
      (options.excludeDirectoryNames ?? []).map((name) => name.toLocaleLowerCase('en-US')),
    );
    const includedFiles =
      options.includeFileNames === undefined ? undefined : new Set(options.includeFileNames);
    const includeDirectories = options.includeDirectories ?? true;
    const maxTraversalDirectories = this.#maxTraversalDirectories;
    const maxTraversalEntries = this.#maxTraversalEntries;
    const captureDirectoryChain = (directory: Uri) =>
      captureWorkspaceDirectoryChain(root, directory, this, vscodeUriCodec);
    const verifyDirectoryChain = (snapshot: WorkspaceDirectoryChainSnapshot<Uri>) =>
      verifyWorkspaceDirectoryChain(snapshot, this, vscodeUriCodec);
    let visitedDirectories = 0;
    let visitedEntries = 0;
    let visitedIdentityBytes = 0;
    let traversalStopped = false;
    const limitFailure = (resource: 'directories' | 'entries', limit: number) => ({
      kind: 'failure' as const,
      uri: root,
      relativePath: '',
      reason: 'safety-limit' as const,
      message: `Workspace traversal stopped after reaching the safety limit of ${String(limit)} ${resource} under ${root.toString()}.`,
    });
    const visit = async function* (
      directory: Uri,
      segments: readonly string[],
    ): AsyncIterable<WorkspaceTraversalEvent<Uri>> {
      if (traversalStopped) {
        return;
      }
      if (visitedDirectories >= maxTraversalDirectories) {
        traversalStopped = true;
        yield limitFailure('directories', maxTraversalDirectories);
        return;
      }
      visitedDirectories += 1;

      let directorySnapshot: WorkspaceDirectoryChainSnapshot<Uri>;
      if (segments.length === 0) {
        directorySnapshot = traversalRootSnapshot;
      } else {
        const capture = await captureDirectoryChain(directory);
        if (!capture.ok) {
          const fatalCaptureFailure =
            capture.failure.reason !== 'access' || vscodeUriCodec.equals(capture.failure.uri, root);
          yield {
            kind: 'failure',
            uri: capture.failure.uri,
            relativePath: segments.join('/'),
            reason: fatalCaptureFailure ? 'generation-changed' : 'access',
            message: capture.failure.message,
          };
          return;
        }
        directorySnapshot = capture.snapshot;
      }
      const changedRootBeforeRead = await verifyDirectoryChain(traversalRootSnapshot);
      if (changedRootBeforeRead !== undefined) {
        yield {
          kind: 'failure',
          uri: directory,
          relativePath: segments.join('/'),
          reason: 'generation-changed',
          message: changedRootBeforeRead.message,
        };
        return;
      }

      let children: [string, FileType][];
      try {
        children = await workspace.fs.readDirectory(directory);
      } catch (error) {
        const failure = accessError(error, `Unable to enumerate ${directory.toString()}`);
        const [changedDirectory, changedRoot] = await Promise.all([
          verifyDirectoryChain(directorySnapshot),
          verifyDirectoryChain(traversalRootSnapshot),
        ]);
        const verificationFailure = changedRoot ?? changedDirectory;
        const fatalVerificationFailure =
          changedRoot !== undefined ||
          (changedDirectory !== undefined &&
            (changedDirectory.reason !== 'access' ||
              vscodeUriCodec.equals(changedDirectory.uri, root)));
        yield {
          kind: 'failure',
          uri: verificationFailure?.uri ?? directory,
          relativePath: segments.join('/'),
          reason: fatalVerificationFailure ? 'generation-changed' : 'access',
          message: verificationFailure?.message ?? failure.message,
        };
        return;
      }
      const [changedDirectory, changedRoot] = await Promise.all([
        verifyDirectoryChain(directorySnapshot),
        verifyDirectoryChain(traversalRootSnapshot),
      ]);
      if (changedDirectory !== undefined || changedRoot !== undefined) {
        const verificationFailure = changedRoot ?? changedDirectory;
        const fatalVerificationFailure =
          changedRoot !== undefined ||
          (changedDirectory !== undefined &&
            (changedDirectory.reason !== 'access' ||
              vscodeUriCodec.equals(changedDirectory.uri, root)));
        yield {
          kind: 'failure',
          uri: verificationFailure?.uri ?? directory,
          relativePath: segments.join('/'),
          reason: fatalVerificationFailure ? 'generation-changed' : 'access',
          message:
            verificationFailure?.message ??
            'The traversed workspace directory changed during enumeration.',
        };
        return;
      }
      // Count every tuple in this materialized provider response before
      // sorting or descending. A depth-first traversal must not defer
      // reserving unprocessed siblings.
      visitedEntries += children.length;
      if (visitedEntries > maxTraversalEntries) {
        traversalStopped = true;
        yield limitFailure('entries', maxTraversalEntries);
        return;
      }
      const currentRelativePath = segments.join('/');
      for (const [name] of children) {
        if (unsafeProviderChildName(name)) {
          traversalStopped = true;
          yield {
            kind: 'failure',
            uri: directory,
            relativePath: currentRelativePath,
            reason: 'safety-limit',
            message:
              'Workspace traversal stopped because a provider returned a child name that is not one safe path segment.',
          };
          return;
        }
        const projectedCodeUnits =
          currentRelativePath.length + (currentRelativePath.length === 0 ? 0 : 1) + name.length;
        if (
          name.length > OKF_SEMANTIC_LIMITS.maxProviderPathCodeUnits ||
          projectedCodeUnits > OKF_SEMANTIC_LIMITS.maxProviderPathCodeUnits
        ) {
          traversalStopped = true;
          yield {
            kind: 'failure',
            uri: directory,
            relativePath: currentRelativePath,
            reason: 'safety-limit',
            message: `Workspace traversal stopped because a provider-relative path exceeds the ${String(OKF_SEMANTIC_LIMITS.maxProviderPathCodeUnits)}-code-unit identity safety limit.`,
          };
          return;
        }
        const projectedPath =
          currentRelativePath.length === 0 ? name : `${currentRelativePath}/${name}`;
        const projectedBytes = utf8Encoder.encode(projectedPath).byteLength;
        if (projectedBytes > OKF_SEMANTIC_LIMITS.maxProviderPathBytes) {
          traversalStopped = true;
          yield {
            kind: 'failure',
            uri: directory,
            relativePath: currentRelativePath,
            reason: 'safety-limit',
            message: `Workspace traversal stopped because a provider-relative path exceeds the ${String(OKF_SEMANTIC_LIMITS.maxProviderPathBytes)}-byte identity safety limit.`,
          };
          return;
        }
        const nextIdentityBytes = addBytesWithinLimit(
          visitedIdentityBytes,
          projectedBytes,
          BUNDLE_READ_LIMITS.maxTraversalIdentityBytes,
        );
        if (nextIdentityBytes === undefined) {
          traversalStopped = true;
          yield {
            kind: 'failure',
            uri: directory,
            relativePath: currentRelativePath,
            reason: 'safety-limit',
            message: `Workspace traversal stopped because provider-relative paths exceed the ${String(BUNDLE_READ_LIMITS.maxTraversalIdentityBytes)}-byte cumulative identity safety limit.`,
          };
          return;
        }
        visitedIdentityBytes = nextIdentityBytes;
      }
      children.sort(([left], [right]) => left.localeCompare(right));

      for (const [name, type] of children) {
        if (traversalStopped) {
          return;
        }

        const uri = Uri.joinPath(directory, name);
        if (!isUriContained(root, uri)) {
          throw new WorkspaceAccessError(
            'unknown',
            `A workspace provider returned a child outside ${root.toString()}.`,
          );
        }
        const relativeSegments = [...segments, name];
        const relativePath =
          currentRelativePath.length === 0 ? name : `${currentRelativePath}/${name}`;
        const mappedType = entryType(type);
        const entry: WorkspaceEntry<Uri> = {
          uri,
          relativePath,
          type: mappedType,
        };
        if (
          (mappedType === 'directory' && includeDirectories) ||
          (mappedType !== 'directory' && (includedFiles === undefined || includedFiles.has(name)))
        ) {
          yield { kind: 'entry', entry };
        }
        if (mappedType === 'directory' && !excluded.has(name.toLocaleLowerCase('en-US'))) {
          if (relativeSegments.length < maxDepth) {
            yield* visit(uri, relativeSegments);
          } else if (maxDepth !== Number.POSITIVE_INFINITY) {
            yield {
              kind: 'failure',
              uri,
              relativePath,
              reason: 'safety-limit',
              message: `Workspace traversal did not inspect ${uri.toString()} because it reached the maximum depth of ${String(maxDepth)} path segments.`,
            };
          }
        }
      }
    };

    yield* visit(root, []);
  }

  stat(uri: Uri): Promise<WorkspaceStat | undefined> {
    return statOrUndefined(uri, this.#nativeFileSystem);
  }

  async write(uri: Uri, content: Uint8Array, options: WorkspaceWriteOptions): Promise<void> {
    assertSafeActualByteLength(
      content,
      BUNDLE_READ_LIMITS.maxDocumentBytes,
      `proposed workspace file ${uri.toString()}`,
    );
    const proposedContent = content.slice();
    try {
      if (options.expected.kind === 'absent') {
        options.assertAuthorized?.();
        await workspace.fs.createDirectory(Uri.joinPath(uri, '..'));
        await assertExpected(uri, options.expected, this.#nativeFileSystem, options.readBoundary);

        const edit = new WorkspaceEdit();
        edit.createFile(uri, {
          overwrite: false,
          ignoreIfExists: false,
          contents: proposedContent,
        });
        options.assertAuthorized?.();
        const applied = await workspace.applyEdit(edit);
        if (!applied) {
          const current = await statOrUndefined(uri, this.#nativeFileSystem);
          if (current !== undefined) {
            throw new WorkspaceAccessError(
              'content-mismatch',
              `Refusing to overwrite existing workspace resource ${uri.toString()}.`,
            );
          }
          throw new WorkspaceAccessError(
            'unavailable',
            `The workspace provider could not atomically create ${uri.toString()} without overwrite.`,
          );
        }
      } else {
        // VS Code does not expose a conditional workspace-fs write. Keep the
        // exact-byte hash check as the final awaited operation before starting
        // the provider write; documentation records the residual race.
        await assertExpected(uri, options.expected, this.#nativeFileSystem, options.readBoundary);
        options.assertAuthorized?.();
        await workspace.fs.writeFile(uri, proposedContent);
      }

      await verifyWrittenContent(
        uri,
        proposedContent,
        this.#nativeFileSystem,
        options.readBoundary,
      );
    } catch (error) {
      if (error instanceof WorkspaceWriteAuthorizationError) {
        throw error;
      }
      throw accessError(error, `Unable to write ${uri.toString()}`);
    }
  }
}

function unsafeProviderChildName(name: string): boolean {
  if (name.length === 0 || name === '.' || name === '..') {
    return true;
  }
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (code === 0x2f || code === 0x5c || code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
  return value;
}
