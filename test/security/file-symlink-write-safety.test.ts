import { constants as fsConstants, type BigIntStats } from 'node:fs';
import {
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  ChangeSetProposal,
  ExpectedContent,
  FileChangeProposal,
  Finding,
} from '../../src/core/model/index.js';
import { providerIndexChangesToProposal } from '../../src/extension/commands/proposals.js';
import type { RuntimeDiagnosticsSink } from '../../src/extension/diagnostics/publisher.js';
import { BundleRuntime } from '../../src/extension/runtime/bundleRuntime.js';
import type { BundleRuntimeSnapshot } from '../../src/extension/runtime/types.js';
import { BundleContextService } from '../../src/extension/workspace/bundleContext.js';
import { sha256Content } from '../../src/extension/workspace/contentHash.js';
import { inspectWorkspaceDirectoryChain } from '../../src/extension/workspace/directorySafety.js';
import {
  normalizeContainedRelativePath,
  preserveProviderRelativePath,
} from '../../src/extension/workspace/pathSafety.js';
import { ProposalApplicator } from '../../src/extension/workspace/proposalApplicator.js';
import type {
  WorkspaceEntry,
  WorkspaceEnumerationOptions,
  WorkspacePort,
  WorkspaceReadIdentity,
  WorkspaceReadOptions,
  WorkspaceStat,
  WorkspaceTraversalEvent,
  WorkspaceTraversalOptions,
  WorkspaceWriteOptions,
} from '../../src/extension/workspace/types.js';
import {
  sameWorkspaceReadIdentity,
  WorkspaceAccessError,
} from '../../src/extension/workspace/types.js';
import type { WorkspaceUriCodec } from '../../src/extension/workspace/uriCodec.js';
import type { WorkspaceChange } from '../../src/extension/workspace/refreshCoordinator.js';

const temporaryRoots: string[] = [];

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

const fileUriCodec: WorkspaceUriCodec<string> = {
  parse(value) {
    const parsed = new URL(value);
    if (parsed.protocol !== 'file:') {
      throw new Error('The security harness accepts file URIs only.');
    }
    return pathToFileURL(fileURLToPath(parsed)).toString();
  },
  serialize(uri) {
    return uri;
  },
  containedPathSegments(root, descendant) {
    const rootPath = fileURLToPath(root);
    const descendantPath = fileURLToPath(descendant);
    const relativePath = relative(rootPath, descendantPath);
    if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
      throw new Error('The file target is outside its workspace safety root.');
    }
    if (relativePath.length === 0) {
      return [root];
    }
    const segments = relativePath.split(sep);
    return [
      root,
      ...segments.map((_, index) =>
        pathToFileURL(join(rootPath, ...segments.slice(0, index + 1))).toString(),
      ),
    ];
  },
  joinContained(root, relativePath) {
    const normalized = normalizeContainedRelativePath(relativePath);
    return pathToFileURL(join(fileURLToPath(root), ...normalized.split('/'))).toString();
  },
  joinProviderPath(root, relativePath) {
    const preserved = preserveProviderRelativePath(relativePath);
    return pathToFileURL(join(fileURLToPath(root), ...preserved.split('/'))).toString();
  },
  equals(left, right) {
    return left === right;
  },
};

function nativeReadIdentity(value: BigIntStats): WorkspaceReadIdentity {
  return {
    kind: 'native-file',
    device: value.dev.toString(),
    inode: value.ino.toString(),
    mode: value.mode.toString(),
    ctimeNs: value.ctimeNs.toString(),
    birthtimeNs: value.birthtimeNs.toString(),
  };
}

type NativeOpen = (path: string, flags: number) => Promise<FileHandle>;
type NativeStatHook = (uri: string, occurrence: number) => Promise<void> | void;

class RealFileWorkspacePort implements WorkspacePort<string> {
  readonly writes: string[] = [];
  readonly reads: string[] = [];
  readonly traversals: string[] = [];
  readonly materializedReads: string[] = [];
  readonly statOccurrences = new Map<string, number>();
  openNativeFile: NativeOpen = open;
  beforeNativeStat: NativeStatHook | undefined;
  afterNativeStat: NativeStatHook | undefined;

  statCount(uri: string): number {
    return this.statOccurrences.get(uri) ?? 0;
  }

  async read(uri: string, options?: WorkspaceReadOptions): Promise<Uint8Array> {
    this.reads.push(uri);
    if (options?.expectedIdentity?.kind !== 'native-file') {
      throw new WorkspaceAccessError(
        'unavailable',
        'The real-file security harness requires a native read identity.',
      );
    }
    const path = fileURLToPath(uri);
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    let handle: FileHandle | undefined;
    try {
      handle = await this.openNativeFile(path, fsConstants.O_RDONLY | noFollow);
      const openedIdentity = nativeReadIdentity(await handle.stat({ bigint: true }));
      if (!sameWorkspaceReadIdentity(options.expectedIdentity, openedIdentity)) {
        throw new WorkspaceAccessError(
          'content-mismatch',
          'The real file changed between inspection and identity-bound open.',
        );
      }
      const content = new Uint8Array(await handle.readFile());
      this.materializedReads.push(uri);
      const finalHandleIdentity = nativeReadIdentity(await handle.stat({ bigint: true }));
      const finalPathIdentity = nativeReadIdentity(await lstat(path, { bigint: true }));
      if (
        !sameWorkspaceReadIdentity(options.expectedIdentity, finalHandleIdentity) ||
        !sameWorkspaceReadIdentity(options.expectedIdentity, finalPathIdentity)
      ) {
        throw new WorkspaceAccessError(
          'content-mismatch',
          'The real file changed during its identity-bound read.',
        );
      }
      return content;
    } finally {
      await handle?.close();
    }
  }

  async *traverse(
    root: string,
    options: WorkspaceTraversalOptions = {},
  ): AsyncIterable<WorkspaceTraversalEvent<string>> {
    this.traversals.push(root);
    const includedFiles =
      options.includeFileNames === undefined ? undefined : new Set(options.includeFileNames);
    const excluded = new Set(options.excludeDirectoryNames ?? []);
    const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
    const rootPath = fileURLToPath(root);
    const walk = async function* (
      directoryPath: string,
      parentSegments: readonly string[],
    ): AsyncIterable<WorkspaceTraversalEvent<string>> {
      let children;
      try {
        children = await readdir(directoryPath, { withFileTypes: true });
      } catch (error) {
        yield {
          kind: 'failure',
          uri: pathToFileURL(directoryPath).toString(),
          relativePath: parentSegments.join('/'),
          message: error instanceof Error ? error.message : 'Real filesystem traversal failed.',
        };
        return;
      }
      for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
        const segments = [...parentSegments, child.name];
        const relativePath = segments.join('/');
        const childPath = join(directoryPath, child.name);
        const uri = pathToFileURL(childPath).toString();
        const type = child.isSymbolicLink()
          ? 'symbolic-link'
          : child.isDirectory()
            ? 'directory'
            : child.isFile()
              ? 'file'
              : 'unknown';
        if (type === 'directory') {
          if (excluded.has(child.name)) {
            continue;
          }
          if (options.includeDirectories !== false) {
            yield { kind: 'entry', entry: { uri, relativePath, type } };
          }
          if (segments.length >= maxDepth) {
            yield {
              kind: 'failure',
              uri,
              relativePath,
              reason: 'safety-limit',
              message: 'Real filesystem traversal reached its depth limit.',
            };
            continue;
          }
          yield* walk(childPath, segments);
          continue;
        }
        if (includedFiles === undefined || includedFiles.has(child.name)) {
          yield { kind: 'entry', entry: { uri, relativePath, type } };
        }
      }
    };
    yield* walk(rootPath, []);
  }

  async enumerate(
    root: string,
    options: WorkspaceEnumerationOptions = {},
  ): Promise<readonly WorkspaceEntry<string>[]> {
    void root;
    void options;
    return [];
  }

  async stat(uri: string): Promise<WorkspaceStat | undefined> {
    const occurrence = this.statCount(uri) + 1;
    this.statOccurrences.set(uri, occurrence);
    await this.beforeNativeStat?.(uri, occurrence);
    let outcome:
      | { readonly ok: true; readonly value: BigIntStats }
      | { readonly ok: false; readonly error: unknown };
    try {
      outcome = {
        ok: true,
        value: await lstat(fileURLToPath(uri), { bigint: true }),
      };
    } catch (error) {
      outcome = { ok: false, error };
    }
    await this.afterNativeStat?.(uri, occurrence);
    if (!outcome.ok) {
      const code = errorCode(outcome.error);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return undefined;
      }
      throw new WorkspaceAccessError('unknown', 'Real filesystem stat failed.', {
        cause: outcome.error,
      });
    }
    const type = outcome.value.isSymbolicLink()
      ? 'symbolic-link'
      : outcome.value.isDirectory()
        ? 'directory'
        : outcome.value.isFile()
          ? 'file'
          : 'unknown';
    return {
      type,
      size: Number(outcome.value.size),
      ctime: Number(outcome.value.ctimeMs),
      mtime: Number(outcome.value.mtimeMs),
      readIdentity: nativeReadIdentity(outcome.value),
    };
  }

  async write(uri: string, content: Uint8Array, options: WorkspaceWriteOptions): Promise<void> {
    const path = fileURLToPath(uri);
    options.assertAuthorized?.();
    await mkdir(dirname(path), { recursive: true });
    options.assertAuthorized?.();
    this.writes.push(uri);
    await writeFile(path, content, {
      flag: options.expected.kind === 'absent' ? 'wx' : 'w',
    });
  }
}

class RecordingDiagnostics implements RuntimeDiagnosticsSink {
  clearCount = 0;
  readonly replacements: Finding[][] = [];

  replace(findings: readonly Finding[]): void {
    this.replacements.push([...findings]);
  }

  clear(): void {
    this.clearCount += 1;
  }
}

function createChange(root: string, relativePath: string): FileChangeProposal {
  return {
    targetUri: fileUriCodec.joinContained(root, relativePath),
    relativePath,
    operation: 'create',
    expected: { kind: 'absent' } satisfies ExpectedContent,
    encoding: 'utf8',
    proposedText: `generated ${relativePath}\n`,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function waitForObservation(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function openThroughTransientDirectorySwap(
  targetPath: string,
  flags: number,
  selectedDirectoryPath: string,
  parkedDirectoryPath: string,
  externalDirectoryPath: string,
): Promise<FileHandle> {
  await rename(selectedDirectoryPath, parkedDirectoryPath);
  try {
    await symlink(
      externalDirectoryPath,
      selectedDirectoryPath,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    return await open(targetPath, flags);
  } finally {
    await rm(selectedDirectoryPath, { recursive: true, force: true });
    await rename(parkedDirectoryPath, selectedDirectoryPath);
  }
}

function armTransientDirectorySwap(
  port: RealFileWorkspacePort,
  targetPath: string,
  selectedDirectoryPath: string,
  parkedDirectoryPath: string,
  externalDirectoryPath: string,
): FileHandle[] {
  const openedHandles: FileHandle[] = [];
  port.openNativeFile = async (path, flags) => {
    port.openNativeFile = open;
    if (path !== targetPath) {
      return open(path, flags);
    }
    const handle = await openThroughTransientDirectorySwap(
      path,
      flags,
      selectedDirectoryPath,
      parkedDirectoryPath,
      externalDirectoryPath,
    );
    openedHandles.push(handle);
    return handle;
  };
  return openedHandles;
}

function armTransientDirectorySwapDuringFreshTargetStat(
  port: RealFileWorkspacePort,
  targetUri: string,
  selectedDirectoryPath: string,
  parkedDirectoryPath: string,
  externalDirectoryPath: string,
): { readonly occurrence: number; readonly wasTriggered: () => boolean } {
  // Each load inspects the target once during planning, then once more in the
  // fixed read batch immediately before issuing its identity-bound read.
  const occurrence = port.statCount(targetUri) + 2;
  let swapped = false;
  let triggered = false;
  port.beforeNativeStat = async (uri, currentOccurrence) => {
    if (uri !== targetUri || currentOccurrence !== occurrence) {
      return;
    }
    await rename(selectedDirectoryPath, parkedDirectoryPath);
    try {
      await symlink(
        externalDirectoryPath,
        selectedDirectoryPath,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      swapped = true;
      triggered = true;
    } catch (error) {
      await rename(parkedDirectoryPath, selectedDirectoryPath);
      throw error;
    }
  };
  port.afterNativeStat = async (uri, currentOccurrence) => {
    if (uri !== targetUri || currentOccurrence !== occurrence) {
      return;
    }
    try {
      if (swapped) {
        await rm(selectedDirectoryPath, { recursive: true, force: true });
        await rename(parkedDirectoryPath, selectedDirectoryPath);
      }
    } finally {
      port.beforeNativeStat = undefined;
      port.afterNativeStat = undefined;
    }
  };
  return { occurrence, wasTriggered: () => triggered };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('real file-workspace containment', () => {
  it('rejects transient swap-and-restore reads from command and watcher refreshes', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'okf-workbench-transient-read-safety-'));
    temporaryRoots.push(temporaryRoot);
    const workspacePath = join(temporaryRoot, 'workspace');
    const selectedContainerPath = join(workspacePath, 'container');
    const selectedBundlePath = join(selectedContainerPath, 'bundle');
    const parkedContainerPath = join(workspacePath, 'container-before-transient-swap');
    const externalPath = join(temporaryRoot, 'external');
    const externalBundlePath = join(externalPath, 'bundle');
    const internalDocumentPath = join(selectedBundlePath, 'alpha.md');
    await mkdir(selectedBundlePath, { recursive: true });
    await mkdir(externalBundlePath, { recursive: true });
    await writeFile(
      internalDocumentPath,
      '---\ntype: note\ntitle: Internal Alpha\n---\n# Internal Alpha\n',
      'utf8',
    );
    await writeFile(
      join(externalBundlePath, 'alpha.md'),
      '---\ntype: secret\ntitle: EXTERNAL TRANSIENT SENTINEL\n---\n# Must not publish\n',
      'utf8',
    );

    const workspaceSafetyRootUri = pathToFileURL(workspacePath).toString();
    const bundleRootUri = pathToFileURL(selectedBundlePath).toString();
    const internalDocumentUri = pathToFileURL(internalDocumentPath).toString();
    const port = new RealFileWorkspacePort();
    const diagnostics = new RecordingDiagnostics();
    const errors: unknown[] = [];
    const published: BundleRuntimeSnapshot<string>[] = [];
    let emitWatcherChange: ((change: WorkspaceChange<string>) => void) | undefined;
    const runtime = new BundleRuntime({
      port,
      uris: fileUriCodec,
      diagnostics,
      createChangeSource: () => ({
        subscribe(listener) {
          emitWatcherChange = listener;
          return { dispose: () => undefined };
        },
      }),
      now: () => '2026-07-23T00:00:00Z',
      onError: (error) => errors.push(error),
      onPublish: (snapshot) => published.push(snapshot),
    });

    runtime.select(bundleRootUri, workspaceSafetyRootUri);
    await waitForObservation(() => published.length === 1, 'the initial internal publication');
    expect(runtime.current?.graph.nodes.map(({ title }) => title)).toEqual(['Internal Alpha']);
    const materializedBeforeCommand = port.materializedReads.length;

    const commandHandles = armTransientDirectorySwap(
      port,
      internalDocumentPath,
      selectedContainerPath,
      parkedContainerPath,
      externalPath,
    );
    runtime.requestFullRefresh();
    await waitForObservation(() => errors.length === 1, 'the rejected command refresh');

    expect(commandHandles).toHaveLength(1);
    expect(commandHandles[0]?.fd).toBe(-1);
    expect(port.materializedReads).toHaveLength(materializedBeforeCommand);
    expect(runtime.current).toBeUndefined();
    expect(published).toHaveLength(1);

    runtime.requestFullRefresh();
    await waitForObservation(() => published.length === 2, 'the internal recovery publication');
    expect(runtime.current?.graph.nodes.map(({ title }) => title)).toEqual(['Internal Alpha']);
    const materializedBeforeWatcher = port.materializedReads.length;

    const watcherHandles = armTransientDirectorySwap(
      port,
      internalDocumentPath,
      selectedContainerPath,
      parkedContainerPath,
      externalPath,
    );
    emitWatcherChange?.({ kind: 'change', uri: internalDocumentUri });
    await waitForObservation(() => errors.length === 2, 'the rejected watcher refresh');

    expect(watcherHandles).toHaveLength(1);
    expect(watcherHandles[0]?.fd).toBe(-1);
    expect(port.materializedReads).toHaveLength(materializedBeforeWatcher);
    expect(runtime.current).toBeUndefined();
    expect(published).toHaveLength(2);
    expect(JSON.stringify({ published, diagnostics: diagnostics.replacements })).not.toContain(
      'EXTERNAL TRANSIENT SENTINEL',
    );

    runtime.dispose();
  });

  it('rejects a transient deep document-parent swap during fresh command and watcher stats', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'okf-workbench-deep-stat-safety-'));
    temporaryRoots.push(temporaryRoot);
    const workspacePath = join(temporaryRoot, 'workspace');
    const bundlePath = join(workspacePath, 'bundle');
    const deepParentPath = join(bundlePath, 'notes', 'deep');
    const parkedDeepParentPath = join(bundlePath, 'notes', 'deep-before-transient-swap');
    const externalDeepParentPath = join(temporaryRoot, 'external-deep-parent');
    const internalDocumentPath = join(deepParentPath, 'alpha.md');
    const externalDocumentPath = join(externalDeepParentPath, 'alpha.md');
    await mkdir(deepParentPath, { recursive: true });
    await mkdir(externalDeepParentPath, { recursive: true });
    await writeFile(
      internalDocumentPath,
      '---\ntype: note\ntitle: Internal Deep Alpha\n---\n# Internal Deep Alpha\n',
      'utf8',
    );
    await writeFile(
      externalDocumentPath,
      '---\ntype: secret\ntitle: EXTERNAL DEEP STAT SENTINEL\n---\n# Must not publish\n',
      'utf8',
    );

    const workspaceSafetyRootUri = pathToFileURL(workspacePath).toString();
    const bundleRootUri = pathToFileURL(bundlePath).toString();
    const internalDocumentUri = pathToFileURL(internalDocumentPath).toString();
    const port = new RealFileWorkspacePort();
    const diagnostics = new RecordingDiagnostics();
    const errors: unknown[] = [];
    const published: BundleRuntimeSnapshot<string>[] = [];
    let emitWatcherChange: ((change: WorkspaceChange<string>) => void) | undefined;
    const runtime = new BundleRuntime({
      port,
      uris: fileUriCodec,
      diagnostics,
      createChangeSource: () => ({
        subscribe(listener) {
          emitWatcherChange = listener;
          return { dispose: () => undefined };
        },
      }),
      now: () => '2026-07-23T00:00:00Z',
      onError: (error) => errors.push(error),
      onPublish: (snapshot) => published.push(snapshot),
    });

    runtime.select(bundleRootUri, workspaceSafetyRootUri);
    await waitForObservation(() => published.length === 1, 'the initial deep bundle publication');
    expect(runtime.current?.graph.nodes.map(({ title }) => title)).toEqual(['Internal Deep Alpha']);

    const readsBeforeCommand = [...port.reads];
    const materializedBeforeCommand = port.materializedReads.length;
    const commandAttack = armTransientDirectorySwapDuringFreshTargetStat(
      port,
      internalDocumentUri,
      deepParentPath,
      parkedDeepParentPath,
      externalDeepParentPath,
    );
    runtime.requestFullRefresh();
    await waitForObservation(() => errors.length === 1, 'the rejected deep command refresh');

    expect(commandAttack.wasTriggered()).toBe(true);
    expect(port.statCount(internalDocumentUri)).toBe(commandAttack.occurrence);
    expect(port.reads).toEqual(readsBeforeCommand);
    expect(port.materializedReads).toHaveLength(materializedBeforeCommand);
    expect(runtime.current).toBeUndefined();
    expect(published).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('parent directory generation changed'),
    });

    runtime.requestFullRefresh();
    await waitForObservation(() => published.length === 2, 'the deep command recovery publication');
    expect(runtime.current?.graph.nodes.map(({ title }) => title)).toEqual(['Internal Deep Alpha']);

    const readsBeforeWatcher = [...port.reads];
    const materializedBeforeWatcher = port.materializedReads.length;
    const watcherAttack = armTransientDirectorySwapDuringFreshTargetStat(
      port,
      internalDocumentUri,
      deepParentPath,
      parkedDeepParentPath,
      externalDeepParentPath,
    );
    emitWatcherChange?.({ kind: 'change', uri: internalDocumentUri });
    await waitForObservation(() => errors.length === 2, 'the rejected deep watcher refresh');

    expect(watcherAttack.wasTriggered()).toBe(true);
    expect(port.statCount(internalDocumentUri)).toBe(watcherAttack.occurrence);
    expect(port.reads).toEqual(readsBeforeWatcher);
    expect(port.materializedReads).toHaveLength(materializedBeforeWatcher);
    expect(runtime.current).toBeUndefined();
    expect(published).toHaveLength(2);
    expect(errors[1]).toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('parent directory generation changed'),
    });

    emitWatcherChange?.({ kind: 'change', uri: internalDocumentUri });
    await waitForObservation(() => published.length === 3, 'the deep watcher recovery publication');
    expect(runtime.current?.graph.nodes.map(({ title }) => title)).toEqual(['Internal Deep Alpha']);
    expect(JSON.stringify({ published, diagnostics: diagnostics.replacements })).not.toContain(
      'EXTERNAL DEEP STAT SENTINEL',
    );

    runtime.dispose();
  });

  it('does not retain external index metadata after a transient discovery read swap', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'okf-workbench-transient-discovery-'));
    temporaryRoots.push(temporaryRoot);
    const workspacePath = join(temporaryRoot, 'workspace');
    const parkedWorkspacePath = join(temporaryRoot, 'workspace-before-transient-swap');
    const externalPath = join(temporaryRoot, 'external');
    const internalIndexPath = join(workspacePath, 'index.md');
    await mkdir(workspacePath);
    await mkdir(externalPath);
    await writeFile(internalIndexPath, '# Internal Index\n', 'utf8');
    await writeFile(join(externalPath, 'index.md'), '# EXTERNAL INDEX SENTINEL\n', 'utf8');

    const workspaceUri = pathToFileURL(workspacePath).toString();
    const inspectedTexts: string[] = [];
    const port = new RealFileWorkspacePort();
    const openedHandles = armTransientDirectorySwap(
      port,
      internalIndexPath,
      workspacePath,
      parkedWorkspacePath,
      externalPath,
    );
    const context = new BundleContextService(port, fileUriCodec, ({ text }) => {
      inspectedTexts.push(text);
      return { isBundleRoot: true, label: text.trim() };
    });

    const discovery = await context.discover([workspaceUri]);

    expect(openedHandles).toHaveLength(1);
    expect(openedHandles[0]?.fd).toBe(-1);
    expect(port.materializedReads).toEqual([]);
    expect(inspectedTexts).toEqual([]);
    expect(discovery.candidates).toEqual([]);
    expect(discovery.failures).toHaveLength(1);
    expect(JSON.stringify(discovery)).not.toContain('EXTERNAL INDEX SENTINEL');
  });

  it('clears runtime state without reading an external bundle after an ancestor swap', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'okf-workbench-read-safety-'));
    temporaryRoots.push(temporaryRoot);
    const workspacePath = join(temporaryRoot, 'workspace');
    const selectedContainerPath = join(workspacePath, 'container');
    const selectedBundlePath = join(selectedContainerPath, 'bundle');
    const parkedContainerPath = join(workspacePath, 'container-before-swap');
    const externalPath = join(temporaryRoot, 'external');
    const externalBundlePath = join(externalPath, 'bundle');
    await mkdir(selectedBundlePath, { recursive: true });
    await mkdir(externalBundlePath, { recursive: true });
    await writeFile(
      join(selectedBundlePath, 'alpha.md'),
      '---\ntype: note\ntitle: Internal Alpha\n---\n# Internal Alpha\n',
      'utf8',
    );
    await writeFile(
      join(externalBundlePath, 'external-sentinel.md'),
      '---\ntype: secret\ntitle: EXTERNAL READ SENTINEL\n---\n# Must not be read\n',
      'utf8',
    );

    const workspaceSafetyRootUri = pathToFileURL(workspacePath).toString();
    const bundleRootUri = pathToFileURL(selectedBundlePath).toString();
    const externalDocumentUri = pathToFileURL(
      join(externalBundlePath, 'external-sentinel.md'),
    ).toString();
    const port = new RealFileWorkspacePort();
    const diagnostics = new RecordingDiagnostics();
    const errors: unknown[] = [];
    const published: BundleRuntimeSnapshot<string>[] = [];
    const runtime = new BundleRuntime({
      port,
      uris: fileUriCodec,
      diagnostics,
      createChangeSource: () => ({
        subscribe: () => ({ dispose: () => undefined }),
      }),
      now: () => '2026-07-23T00:00:00Z',
      onError: (error) => errors.push(error),
      onPublish: (snapshot) => published.push(snapshot),
    });

    runtime.select(bundleRootUri, workspaceSafetyRootUri);
    await waitForObservation(() => published.length === 1, 'the initial bundle publication');
    expect(runtime.current?.graph.nodes.map(({ id }) => id)).toEqual(['alpha']);
    expect(diagnostics.replacements).toHaveLength(1);

    await rename(selectedContainerPath, parkedContainerPath);
    await symlink(
      externalPath,
      selectedContainerPath,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    // The final bundle URI follows through the replacement to a real external directory.
    expect((await lstat(fileURLToPath(bundleRootUri))).isDirectory()).toBe(true);
    const readsBeforeSwap = [...port.reads];
    const traversalsBeforeSwap = [...port.traversals];

    runtime.requestFullRefresh();
    await waitForObservation(() => errors.length === 1, 'the refused swapped-ancestor refresh');

    expect(errors[0]).toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('symbolic-link'),
    });
    expect(runtime.current).toBeUndefined();
    expect(port.reads).toEqual(readsBeforeSwap);
    expect(port.reads).not.toContain(externalDocumentUri);
    expect(port.traversals).toEqual(traversalsBeforeSwap);
    expect(published).toHaveLength(1);
    expect(diagnostics.replacements).toHaveLength(1);
    expect(diagnostics.clearCount).toBe(2);
    expect(JSON.stringify({ published, diagnostics: diagnostics.replacements })).not.toContain(
      'EXTERNAL READ SENTINEL',
    );

    runtime.dispose();
  });

  it('rejects a symlink above an explicitly selected write root at selection and apply', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'okf-workbench-selected-root-safety-'));
    temporaryRoots.push(temporaryRoot);
    const workspacePath = join(temporaryRoot, 'workspace');
    const externalPath = join(temporaryRoot, 'external');
    const externalBundlePath = join(externalPath, 'bundle');
    await mkdir(workspacePath);
    await mkdir(externalBundlePath, { recursive: true });
    await symlink(
      externalPath,
      join(workspacePath, 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const workspaceSafetyRootUri = pathToFileURL(workspacePath).toString();
    const writeRootUri = pathToFileURL(join(workspacePath, 'link', 'bundle')).toString();
    // The final selected path follows to a real directory; only the complete workspace-relative
    // ancestor chain exposes the redirect.
    expect((await lstat(fileURLToPath(writeRootUri))).isDirectory()).toBe(true);
    const port = new RealFileWorkspacePort();
    const selectionFailure = await inspectWorkspaceDirectoryChain(
      workspaceSafetyRootUri,
      writeRootUri,
      port,
      fileUriCodec,
    );
    expect(selectionFailure).toMatchObject({
      uri: pathToFileURL(join(workspacePath, 'link')).toString(),
      message: expect.stringContaining('symbolic-link'),
    });

    const proposal: ChangeSetProposal = {
      operation: 'selected-root-ancestor-symlink',
      workspaceSafetyRootUri,
      writeRootUri,
      changes: [createChange(writeRootUri, 'generated.md')],
    };
    await expect(new ProposalApplicator(port, fileUriCodec).apply(proposal)).resolves.toMatchObject(
      {
        completed: [],
        failed: [{ code: 'unsafe-path' }],
      },
    );
    expect(port.writes).toEqual([]);
    await expect(exists(join(externalBundlePath, 'generated.md'))).resolves.toBe(false);
  });

  it('rejects an external directory symlink and parent-file collision before every write', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'okf-workbench-write-safety-'));
    temporaryRoots.push(temporaryRoot);
    const workspacePath = join(temporaryRoot, 'workspace');
    const externalPath = join(temporaryRoot, 'external');
    await mkdir(workspacePath);
    await mkdir(externalPath);
    await symlink(
      externalPath,
      join(workspacePath, 'linked-outside'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await writeFile(join(workspacePath, 'occupied-parent'), 'ordinary file', 'utf8');

    const writeRootUri = pathToFileURL(workspacePath).toString();
    const proposal: ChangeSetProposal = {
      operation: 'real-file-write-safety',
      workspaceSafetyRootUri: writeRootUri,
      writeRootUri,
      changes: [
        createChange(writeRootUri, 'safe.md'),
        createChange(writeRootUri, 'linked-outside/escaped.md'),
        createChange(writeRootUri, 'occupied-parent/child.md'),
      ],
    };
    const port = new RealFileWorkspacePort();
    const applicator = new ProposalApplicator(port, fileUriCodec);

    const report = await applicator.apply(proposal);

    expect(report.completed).toEqual([]);
    expect(report.failed).toEqual([
      expect.objectContaining({
        targetUri: createChange(writeRootUri, 'linked-outside/escaped.md').targetUri,
        code: 'unsafe-path',
      }),
      expect.objectContaining({
        targetUri: createChange(writeRootUri, 'occupied-parent/child.md').targetUri,
        code: 'unsafe-path',
      }),
    ]);
    expect(report.untouched).toEqual([createChange(writeRootUri, 'safe.md').targetUri]);
    expect(port.writes).toEqual([]);
    await expect(exists(join(externalPath, 'escaped.md'))).resolves.toBe(false);
    await expect(exists(join(workspacePath, 'safe.md'))).resolves.toBe(false);
  });

  it('keeps percent-bearing provider siblings distinct and updates BOM content by its raw hash', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'okf-workbench-provider-identity-'));
    temporaryRoots.push(temporaryRoot);
    const workspacePath = join(temporaryRoot, 'workspace');
    const literalSpaceDirectory = join(workspacePath, 'team%20knowledge');
    const actualSpaceDirectory = join(workspacePath, 'team knowledge');
    const literalSeparatorDirectory = join(workspacePath, 'encoded%2Fsegment');
    const actualNestedDirectory = join(workspacePath, 'encoded', 'segment');
    await Promise.all(
      [
        literalSpaceDirectory,
        actualSpaceDirectory,
        literalSeparatorDirectory,
        actualNestedDirectory,
      ].map((path) => mkdir(path, { recursive: true })),
    );

    const originalBytes = Uint8Array.from([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode('# Literal percent directory\n'),
    ]);
    const literalIndexPath = join(literalSpaceDirectory, 'index.md');
    const siblingIndexPath = join(actualSpaceDirectory, 'index.md');
    await writeFile(literalIndexPath, originalBytes);
    await writeFile(siblingIndexPath, '# Actual space sibling\n', 'utf8');

    const writeRootUri = pathToFileURL(workspacePath).toString();
    const proposedText = '\uFEFF# Literal percent directory\n\nUpdated safely.\n';
    const proposal = providerIndexChangesToProposal(
      writeRootUri,
      [
        {
          relativePath: 'team%20knowledge/index.md',
          operation: 'update',
          encoding: 'utf8',
          previousText: '\uFEFF# Literal percent directory\n',
          proposedText,
        },
        {
          relativePath: 'encoded%2Fsegment/index.md',
          operation: 'create',
          encoding: 'utf8',
          proposedText: '# Literal encoded separator\n',
        },
        {
          relativePath: 'encoded/segment/index.md',
          operation: 'create',
          encoding: 'utf8',
          proposedText: '# Actual nested separator\n',
        },
      ],
      fileUriCodec,
      {
        expectedContentSnapshots: new Map([
          [
            'team%20knowledge/index.md',
            { sha256: sha256Content(originalBytes), byteLength: originalBytes.byteLength },
          ],
        ]),
      },
    );
    expect(proposal.changes[0]?.expected).toEqual({
      kind: 'sha256',
      value: sha256Content(originalBytes),
      byteLength: originalBytes.byteLength,
    });
    expect(proposal.changes.map(({ targetUri }) => targetUri)).toEqual([
      pathToFileURL(literalIndexPath).toString(),
      pathToFileURL(join(literalSeparatorDirectory, 'index.md')).toString(),
      pathToFileURL(join(actualNestedDirectory, 'index.md')).toString(),
    ]);

    const port = new RealFileWorkspacePort();
    const applicator = new ProposalApplicator(port, fileUriCodec);
    await expect(applicator.apply(proposal)).resolves.toEqual({
      completed: proposal.changes.map(({ targetUri }) => targetUri),
      failed: [],
      untouched: [],
    });

    const updatedBytes = new Uint8Array(await readFile(literalIndexPath));
    expect(updatedBytes.slice(0, 3)).toEqual(Uint8Array.from([0xef, 0xbb, 0xbf]));
    expect(new TextDecoder().decode(updatedBytes)).toBe(proposedText.slice(1));
    await expect(readFile(siblingIndexPath, 'utf8')).resolves.toBe('# Actual space sibling\n');
    await expect(readFile(join(literalSeparatorDirectory, 'index.md'), 'utf8')).resolves.toBe(
      '# Literal encoded separator\n',
    );
    await expect(readFile(join(actualNestedDirectory, 'index.md'), 'utf8')).resolves.toBe(
      '# Actual nested separator\n',
    );
  });
});
