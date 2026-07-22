import type { ExpectedContent } from '../../../src/core/model/index.js';
import { matchesSha256 } from '../../../src/extension/workspace/contentHash.js';
import {
  normalizeContainedRelativePath,
  preserveProviderRelativePath,
} from '../../../src/extension/workspace/pathSafety.js';
import type {
  DisposableLike,
  WorkspaceChange,
  WorkspaceChangeSource,
} from '../../../src/extension/workspace/refreshCoordinator.js';
import {
  WorkspaceAccessError,
  type WorkspaceEntry,
  type WorkspaceEnumerationOptions,
  type WorkspacePort,
  type WorkspaceStat,
  type WorkspaceTraversalEvent,
  type WorkspaceTraversalOptions,
  type WorkspaceWriteOptions,
} from '../../../src/extension/workspace/types.js';
import type { WorkspaceUriCodec } from '../../../src/extension/workspace/uriCodec.js';

const encoder = new TextEncoder();

export const stringUriCodec: WorkspaceUriCodec<string> = {
  parse(value) {
    if (!value.includes('://')) {
      throw new Error('Invalid test URI.');
    }
    return value.replace(/\/$/u, '');
  },
  serialize(uri) {
    return uri;
  },
  joinContained(root, relativePath) {
    return `${root.replace(/\/$/u, '')}/${normalizeContainedRelativePath(relativePath)}`;
  },
  joinProviderPath(root, relativePath) {
    return `${root.replace(/\/$/u, '')}/${preserveProviderRelativePath(relativePath)}`;
  },
  equals(left, right) {
    return left === right;
  },
};

export class FakeWorkspacePort implements WorkspacePort<string> {
  readonly files = new Map<string, Uint8Array>();
  readonly entryTypes = new Map<string, WorkspaceStat['type']>();
  readonly writes: string[] = [];
  readonly readFailures = new Map<string, Error>();
  readonly traversalFailures = new Map<string, Error>();
  traversalEventCount = 0;
  beforeWrite: ((uri: string) => void) | undefined;
  failWrites = new Map<string, WorkspaceAccessError>();

  putText(uri: string, text: string): void {
    this.files.set(uri, encoder.encode(text));
    this.entryTypes.delete(uri);
  }

  putDirectory(uri: string): void {
    this.files.delete(uri);
    this.entryTypes.set(uri, 'directory');
  }

  putSymbolicLink(uri: string): void {
    this.files.delete(uri);
    this.entryTypes.set(uri, 'symbolic-link');
  }

  text(uri: string): string | undefined {
    const content = this.files.get(uri);
    return content === undefined ? undefined : new TextDecoder().decode(content);
  }

  async read(uri: string): Promise<Uint8Array> {
    const configuredFailure = this.readFailures.get(uri);
    if (configuredFailure !== undefined) {
      throw configuredFailure;
    }
    const content = this.files.get(uri);
    if (content === undefined) {
      throw new WorkspaceAccessError('not-found', `Missing test resource ${uri}.`);
    }
    return content.slice();
  }

  async *traverse(
    root: string,
    options: WorkspaceTraversalOptions = {},
  ): AsyncIterable<WorkspaceTraversalEvent<string>> {
    const prefix = `${root.replace(/\/$/u, '')}/`;
    const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
    const excluded = new Set(
      (options.excludeDirectoryNames ?? []).map((name) => name.toLocaleLowerCase('en-US')),
    );
    const includedFiles =
      options.includeFileNames === undefined ? undefined : new Set(options.includeFileNames);
    const failures = [...this.traversalFailures.entries()]
      .filter(([uri]) => uri === root || uri.startsWith(prefix))
      .sort(([left], [right]) => left.localeCompare(right));

    for (const [uri, error] of failures) {
      const relativePath = uri === root ? '' : uri.slice(prefix.length);
      const segments = relativePath.length === 0 ? [] : relativePath.split('/');
      if (
        segments.length > maxDepth ||
        segments.some((segment) => excluded.has(segment.toLocaleLowerCase('en-US')))
      ) {
        continue;
      }
      this.traversalEventCount += 1;
      yield { kind: 'failure', uri, relativePath, message: error.message };
    }

    const failedRoots = failures.map(([uri]) => uri.replace(/\/$/u, ''));
    for (const uri of [...this.files.keys()].sort((left, right) => left.localeCompare(right))) {
      if (!uri.startsWith(prefix)) {
        continue;
      }
      const relativePath = uri.slice(prefix.length);
      const segments = relativePath.split('/');
      const filename = segments.at(-1) ?? '';
      const directories = segments.slice(0, -1);
      if (
        segments.length > maxDepth ||
        directories.some((segment) => excluded.has(segment.toLocaleLowerCase('en-US'))) ||
        (includedFiles !== undefined && !includedFiles.has(filename)) ||
        failedRoots.some((failedRoot) => uri === failedRoot || uri.startsWith(`${failedRoot}/`))
      ) {
        continue;
      }
      this.traversalEventCount += 1;
      yield { kind: 'entry', entry: { uri, relativePath, type: 'file' } };
    }
  }

  async enumerate(
    root: string,
    options: WorkspaceEnumerationOptions = {},
  ): Promise<readonly WorkspaceEntry<string>[]> {
    const prefix = `${root.replace(/\/$/u, '')}/`;
    const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
    return [...this.files.keys()]
      .filter((uri) => uri.startsWith(prefix))
      .map((uri): WorkspaceEntry<string> => {
        const relativePath = uri.slice(prefix.length);
        return { uri, relativePath, type: 'file' };
      })
      .filter((entry) => entry.relativePath.split('/').length <= maxDepth)
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  async stat(uri: string): Promise<WorkspaceStat | undefined> {
    const configuredType = this.entryTypes.get(uri);
    if (configuredType !== undefined) {
      return { type: configuredType, size: 0, ctime: 0, mtime: 0 };
    }
    const content = this.files.get(uri);
    return content === undefined
      ? undefined
      : { type: 'file', size: content.byteLength, ctime: 0, mtime: 0 };
  }

  async write(uri: string, content: Uint8Array, options: WorkspaceWriteOptions): Promise<void> {
    this.beforeWrite?.(uri);
    const configuredFailure = this.failWrites.get(uri);
    if (configuredFailure !== undefined) {
      throw configuredFailure;
    }
    this.#assertExpected(uri, options.expected);
    this.files.set(uri, content.slice());
    this.writes.push(uri);
  }

  #assertExpected(uri: string, expected: ExpectedContent): void {
    const current = this.files.get(uri);
    if (expected.kind === 'absent') {
      if (current !== undefined) {
        throw new WorkspaceAccessError('content-mismatch', 'Test target already exists.');
      }
      return;
    }
    if (current === undefined || !matchesSha256(current, expected.value)) {
      throw new WorkspaceAccessError('content-mismatch', 'Test target content changed.');
    }
  }
}

export class FakeChangeSource<TUri> implements WorkspaceChangeSource<TUri> {
  disposed = false;
  #listener: ((change: WorkspaceChange<TUri>) => void) | undefined;

  subscribe(listener: (change: WorkspaceChange<TUri>) => void): DisposableLike {
    this.#listener = listener;
    return {
      dispose: () => {
        this.disposed = true;
        this.#listener = undefined;
      },
    };
  }

  emit(change: WorkspaceChange<TUri>): void {
    this.#listener?.(change);
  }
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
    reject(error) {
      rejectPromise?.(error);
    },
  };
}
