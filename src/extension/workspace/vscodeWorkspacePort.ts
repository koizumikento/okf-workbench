import { FileSystemError, FileType, Uri, WorkspaceEdit, workspace } from 'vscode';

import type { ExpectedContent } from '../../core/model/index.js';
import { matchesSha256, sha256Content } from './contentHash.js';
import { isUriContained } from './pathSafety.js';
import {
  WorkspaceAccessError,
  type WorkspaceEntry,
  type WorkspaceEntryType,
  type WorkspaceEnumerationOptions,
  type WorkspacePort,
  type WorkspaceStat,
  type WorkspaceTraversalEvent,
  type WorkspaceTraversalOptions,
  type WorkspaceWriteOptions,
} from './types.js';

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
    return new WorkspaceAccessError(code, `${action}: ${error.message}`, { cause: error });
  }
  return new WorkspaceAccessError('unknown', `${action}: workspace access failed.`, {
    cause: error,
  });
}

async function statOrUndefined(uri: Uri): Promise<WorkspaceStat | undefined> {
  try {
    const stat = await workspace.fs.stat(uri);
    return {
      type: entryType(stat.type),
      size: stat.size,
      ctime: stat.ctime,
      mtime: stat.mtime,
    };
  } catch (error) {
    if (error instanceof FileSystemError && error.code === 'FileNotFound') {
      return undefined;
    }
    throw accessError(error, `Unable to inspect ${uri.toString()}`);
  }
}

async function assertExpected(uri: Uri, expected: ExpectedContent): Promise<void> {
  const stat = await statOrUndefined(uri);
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

  let current: Uint8Array;
  try {
    current = await workspace.fs.readFile(uri);
  } catch (error) {
    throw accessError(error, `Unable to verify ${uri.toString()}`);
  }
  if (!matchesSha256(current, expected.value)) {
    throw new WorkspaceAccessError(
      'content-mismatch',
      `The workspace file changed after preview: ${uri.toString()}.`,
    );
  }
}

async function verifyWrittenContent(uri: Uri, expected: Uint8Array): Promise<void> {
  let actual: Uint8Array;
  try {
    actual = await workspace.fs.readFile(uri);
  } catch (error) {
    throw accessError(error, `Unable to verify the write to ${uri.toString()}`);
  }

  if (!matchesSha256(actual, sha256Content(expected))) {
    throw new WorkspaceAccessError(
      'content-mismatch',
      `The workspace provider did not retain the proposed content at ${uri.toString()}.`,
    );
  }
}

export class VscodeWorkspacePort implements WorkspacePort<Uri> {
  async read(uri: Uri): Promise<Uint8Array> {
    try {
      return await workspace.fs.readFile(uri);
    } catch (error) {
      throw accessError(error, `Unable to read ${uri.toString()}`);
    }
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

    const excluded = new Set(
      (options.excludeDirectoryNames ?? []).map((name) => name.toLocaleLowerCase('en-US')),
    );
    const includedFiles =
      options.includeFileNames === undefined ? undefined : new Set(options.includeFileNames);
    const includeDirectories = options.includeDirectories ?? true;
    const visit = async function* (
      directory: Uri,
      segments: readonly string[],
    ): AsyncIterable<WorkspaceTraversalEvent<Uri>> {
      let children: [string, FileType][];
      try {
        children = await workspace.fs.readDirectory(directory);
      } catch (error) {
        const failure = accessError(error, `Unable to enumerate ${directory.toString()}`);
        yield {
          kind: 'failure',
          uri: directory,
          relativePath: segments.join('/'),
          message: failure.message,
        };
        return;
      }
      children.sort(([left], [right]) => left.localeCompare(right));

      for (const [name, type] of children) {
        const uri = Uri.joinPath(directory, name);
        if (!isUriContained(root, uri)) {
          throw new WorkspaceAccessError(
            'unknown',
            `A workspace provider returned a child outside ${root.toString()}.`,
          );
        }
        const relativeSegments = [...segments, name];
        const mappedType = entryType(type);
        const entry: WorkspaceEntry<Uri> = {
          uri,
          relativePath: relativeSegments.join('/'),
          type: mappedType,
        };
        if (
          (mappedType === 'directory' && includeDirectories) ||
          (mappedType !== 'directory' && (includedFiles === undefined || includedFiles.has(name)))
        ) {
          yield { kind: 'entry', entry };
        }
        if (
          mappedType === 'directory' &&
          relativeSegments.length < maxDepth &&
          !excluded.has(name.toLocaleLowerCase('en-US'))
        ) {
          yield* visit(uri, relativeSegments);
        }
      }
    };

    yield* visit(root, []);
  }

  stat(uri: Uri): Promise<WorkspaceStat | undefined> {
    return statOrUndefined(uri);
  }

  async write(uri: Uri, content: Uint8Array, options: WorkspaceWriteOptions): Promise<void> {
    const proposedContent = content.slice();
    try {
      if (options.expected.kind === 'absent') {
        await workspace.fs.createDirectory(Uri.joinPath(uri, '..'));
        await assertExpected(uri, options.expected);

        const edit = new WorkspaceEdit();
        edit.createFile(uri, {
          overwrite: false,
          ignoreIfExists: false,
          contents: proposedContent,
        });
        const applied = await workspace.applyEdit(edit);
        if (!applied) {
          const current = await statOrUndefined(uri);
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
        await assertExpected(uri, options.expected);
        await workspace.fs.writeFile(uri, proposedContent);
      }

      await verifyWrittenContent(uri, proposedContent);
    } catch (error) {
      throw accessError(error, `Unable to write ${uri.toString()}`);
    }
  }
}
