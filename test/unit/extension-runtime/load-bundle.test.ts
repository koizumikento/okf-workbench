import { describe, expect, it } from 'vitest';

import { OKF_SEMANTIC_LIMITS } from '../../../src/core/model/index.js';
import { loadBundle } from '../../../src/extension/runtime/loadBundle.js';
import { BUNDLE_READ_LIMITS } from '../../../src/extension/workspace/readSafety.js';
import {
  WorkspaceAccessError,
  type WorkspaceEntry,
  type WorkspacePort,
  type WorkspaceStat,
  type WorkspaceTraversalEvent,
  type WorkspaceTraversalOptions,
} from '../../../src/extension/workspace/types.js';
import {
  deferred,
  FakeWorkspacePort,
  stringUriCodec,
  type Deferred,
} from '../extension-workspace/fakes.js';

const root = 'memfs://workspace/bundle';

class ControlledWorkspacePort implements WorkspacePort<string> {
  readonly entries: WorkspaceEntry<string>[];
  readonly traversalFailures: WorkspaceTraversalEvent<string>[] = [];
  readonly statSizes = new Map<string, number>();
  readonly contents = new Map<string, Uint8Array>();
  statCalls = 0;
  readCalls = 0;
  activeStats = 0;
  activeReads = 0;
  maxActiveStats = 0;
  maxActiveReads = 0;
  statImpl: ((uri: string) => Promise<WorkspaceStat | undefined>) | undefined;
  readImpl: ((uri: string) => Promise<Uint8Array>) | undefined;

  constructor(count: number) {
    this.entries = Array.from({ length: count }, (_, index) => {
      const relativePath = `${String(index).padStart(5, '0')}.md`;
      const uri = `${root}/${relativePath}`;
      this.contents.set(uri, new Uint8Array());
      return { uri, relativePath, type: 'file' as const };
    });
  }

  async *traverse(): AsyncIterable<WorkspaceTraversalEvent<string>> {
    for (const event of this.traversalFailures) {
      yield event;
    }
    for (const entry of this.entries) {
      yield { kind: 'entry', entry };
    }
  }

  async enumerate(): Promise<readonly WorkspaceEntry<string>[]> {
    return this.entries;
  }

  async stat(uri: string): Promise<WorkspaceStat | undefined> {
    this.statCalls += 1;
    if (uri === root) {
      return { type: 'directory', size: 0, ctime: 0, mtime: 0 };
    }
    this.activeStats += 1;
    this.maxActiveStats = Math.max(this.maxActiveStats, this.activeStats);
    try {
      if (this.statImpl !== undefined) {
        return await this.statImpl(uri);
      }
      const content = this.contents.get(uri);
      return content === undefined
        ? undefined
        : {
            type: 'file',
            size: this.statSizes.get(uri) ?? content.byteLength,
            ctime: 0,
            mtime: 0,
          };
    } finally {
      this.activeStats -= 1;
    }
  }

  async read(uri: string): Promise<Uint8Array> {
    this.readCalls += 1;
    this.activeReads += 1;
    this.maxActiveReads = Math.max(this.maxActiveReads, this.activeReads);
    try {
      if (this.readImpl !== undefined) {
        return await this.readImpl(uri);
      }
      return this.contents.get(uri) ?? new Uint8Array();
    } finally {
      this.activeReads -= 1;
    }
  }

  async write(): Promise<void> {
    throw new Error('Controlled read-only test port does not implement writes.');
  }
}

class ChainRecordingWorkspacePort extends FakeWorkspacePort {
  readonly statUris: string[] = [];
  readonly statFailures = new Map<string, Error>();
  readonly reportedSizes = new Map<string, number>();
  traversalCalls = 0;
  afterStat: ((uri: string) => void) | undefined;
  afterFirstRead: (() => void) | undefined;
  afterRead: ((uri: string) => void) | undefined;
  afterTraversal: (() => void) | undefined;

  public override async stat(uri: string): Promise<WorkspaceStat | undefined> {
    this.statUris.push(uri);
    const failure = this.statFailures.get(uri);
    if (failure !== undefined) {
      throw failure;
    }
    const stat = await super.stat(uri);
    this.afterStat?.(uri);
    const reportedSize = this.reportedSizes.get(uri);
    return stat?.type === 'file' && reportedSize !== undefined
      ? { ...stat, size: reportedSize }
      : stat;
  }

  public override async read(uri: string): Promise<Uint8Array> {
    const content = await super.read(uri);
    const afterFirstRead = this.afterFirstRead;
    this.afterFirstRead = undefined;
    afterFirstRead?.();
    this.afterRead?.(uri);
    return content;
  }

  public override async *traverse(
    rootUri: string,
    options: WorkspaceTraversalOptions = {},
  ): AsyncIterable<WorkspaceTraversalEvent<string>> {
    this.traversalCalls += 1;
    yield* super.traverse(rootUri, options);
    this.afterTraversal?.();
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  throw new Error('Timed out waiting for controlled provider activity.');
}

describe('loadBundle', () => {
  it('revalidates every workspace ancestor before traversal and refuses an ancestor swap', async () => {
    const workspaceRoot = 'memfs://workspace';
    const ancestor = `${workspaceRoot}/container`;
    const nestedRoot = `${ancestor}/bundle`;
    const port = new ChainRecordingWorkspacePort();
    port.putDirectory(workspaceRoot);
    port.putDirectory(ancestor);
    port.putDirectory(nestedRoot);
    port.putText(`${nestedRoot}/index.md`, '# Bundle\n');
    port.putText(`${nestedRoot}/alpha.md`, '# Alpha\n');

    const loaded = await loadBundle(port, stringUriCodec, nestedRoot, workspaceRoot);

    expect(loaded.documents.map(({ bundlePath }) => bundlePath)).toEqual(['alpha.md', 'index.md']);
    expect(port.statUris.slice(0, 3)).toEqual([workspaceRoot, ancestor, nestedRoot]);
    expect(port.traversalCalls).toBe(1);
    expect(port.reads).toHaveLength(2);

    port.statUris.splice(0);
    port.reads.splice(0);
    port.traversalCalls = 0;
    port.putSymbolicLink(ancestor);

    await expect(loadBundle(port, stringUriCodec, nestedRoot, workspaceRoot)).rejects.toMatchObject(
      {
        code: 'unavailable',
        message: expect.stringContaining('symbolic-link'),
      },
    );
    expect(port.statUris).toEqual([workspaceRoot, ancestor]);
    expect(port.traversalCalls).toBe(0);
    expect(port.reads).toEqual([]);
  });

  it('detects ancestor swaps after the precheck and after content reads', async () => {
    const workspaceRoot = 'memfs://workspace';
    const ancestor = `${workspaceRoot}/container`;
    const nestedRoot = `${ancestor}/bundle`;
    const port = new ChainRecordingWorkspacePort();
    port.putDirectory(workspaceRoot);
    port.putDirectory(ancestor);
    port.putDirectory(nestedRoot);
    port.putText(`${nestedRoot}/index.md`, '# Bundle\n');
    port.putText(`${nestedRoot}/alpha.md`, '# Alpha\n');

    let precheckCompleted = false;
    port.afterStat = (uri) => {
      if (!precheckCompleted && uri === nestedRoot) {
        precheckCompleted = true;
        port.putSymbolicLink(ancestor);
      }
    };
    await expect(loadBundle(port, stringUriCodec, nestedRoot, workspaceRoot)).rejects.toMatchObject(
      {
        code: 'unavailable',
        message: expect.stringContaining('generation changed'),
      },
    );
    expect(port.statUris).toEqual([workspaceRoot, ancestor, nestedRoot, workspaceRoot, ancestor]);
    expect(port.traversalCalls).toBe(0);
    expect(port.reads).toEqual([]);

    port.putDirectory(ancestor);
    port.statUris.splice(0);
    port.traversalCalls = 0;
    port.afterStat = undefined;
    port.afterFirstRead = () => port.putSymbolicLink(ancestor);

    await expect(loadBundle(port, stringUriCodec, nestedRoot, workspaceRoot)).rejects.toMatchObject(
      {
        code: 'unavailable',
        message: expect.stringContaining('generation changed'),
      },
    );
    expect(port.traversalCalls).toBe(1);
    expect(port.reads).toHaveLength(2);
    expect(port.statUris.slice(-2)).toEqual([workspaceRoot, ancestor]);
  });

  it('keeps readable siblings when one subtree and one Markdown file cannot be read', async () => {
    const port = new FakeWorkspacePort();
    port.putDirectory(root);
    const blockedSubtree = `${root}/blocked%2Fsubtree`;
    const unreadableFile = `${root}/unreadable.md`;
    port.putText(`${root}/index.md`, '# Bundle\n');
    port.putText(`${root}/alpha.md`, '# Alpha\n');
    port.putText(`${blockedSubtree}/beta.md`, '# Beta\n');
    port.putText(unreadableFile, '# Unreadable\n');
    port.traversalFailures.set(blockedSubtree, new Error('Provider refused this subtree.'));
    port.readFailures.set(unreadableFile, new Error('Provider refused this file.'));

    const loaded = await loadBundle(port, stringUriCodec, root, root);

    expect(loaded.rootUri).toBe(root);
    expect(loaded.documents.map(({ bundlePath }) => bundlePath)).toEqual(['alpha.md', 'index.md']);
    expect(loaded.failures).toEqual([
      {
        kind: 'parse-failure',
        uri: blockedSubtree,
        bundlePath: 'blocked%2Fsubtree',
        reason: 'read',
        message: expect.stringContaining('Provider refused this subtree.'),
      },
      {
        kind: 'parse-failure',
        uri: unreadableFile,
        bundlePath: 'unreadable.md',
        reason: 'read',
        message: expect.stringContaining('Provider refused this file.'),
      },
    ]);
  });

  it('isolates nested parent access failures before capture, after stat, and after read', async () => {
    for (const stage of ['capture', 'post-stat', 'post-read'] as const) {
      const port = new ChainRecordingWorkspacePort();
      const blockedParent = `${root}/blocked`;
      const blockedDocument = `${blockedParent}/a.md`;
      const safeDocument = `${root}/safe.md`;
      port.putDirectory(root);
      port.putDirectory(blockedParent);
      port.putText(blockedDocument, '# Must be discarded\n');
      port.putText(safeDocument, '# Safe sibling\n');
      const denyParent = (): void => {
        port.statFailures.set(
          blockedParent,
          new WorkspaceAccessError('permission', `Blocked parent at ${stage}.`),
        );
      };
      if (stage === 'capture') {
        port.afterTraversal = denyParent;
      } else if (stage === 'post-stat') {
        port.afterStat = (uri) => {
          if (uri === blockedDocument) {
            denyParent();
          }
        };
      } else {
        port.afterRead = (uri) => {
          if (uri === blockedDocument) {
            denyParent();
          }
        };
      }

      const loaded = await loadBundle(port, stringUriCodec, root, root);

      expect(
        loaded.documents.map(({ bundlePath }) => bundlePath),
        stage,
      ).toEqual(['safe.md']);
      expect(loaded.failures, stage).toEqual([
        expect.objectContaining({
          uri: blockedDocument,
          bundlePath: 'blocked/a.md',
          reason: 'read',
          message: expect.stringContaining(`Blocked parent at ${stage}.`),
        }),
      ]);
      expect(port.reads, stage).toContain(safeDocument);
      if (stage === 'post-read') {
        expect(port.reads).toContain(blockedDocument);
      } else {
        expect(port.reads).not.toContain(blockedDocument);
      }
    }
  });

  it('charges bytes discarded after parent access failure to the aggregate actual-byte limit', async () => {
    const port = new ChainRecordingWorkspacePort();
    const documentBytes = new Uint8Array(BUNDLE_READ_LIMITS.maxDocumentBytes);
    port.putDirectory(root);
    for (let index = 0; index < 17; index += 1) {
      const parent = `${root}/parent-${String(index).padStart(2, '0')}`;
      const document = `${parent}/a.md`;
      port.putDirectory(parent);
      port.files.set(document, documentBytes);
      port.reportedSizes.set(document, 0);
    }
    port.afterRead = (uri) => {
      const slash = uri.lastIndexOf('/');
      const parent = uri.slice(0, slash);
      port.statFailures.set(
        parent,
        new WorkspaceAccessError('permission', 'Parent became unreadable after materialization.'),
      );
    };

    await expect(loadBundle(port, stringUriCodec, root, root)).rejects.toThrow(
      /cumulative Markdown safety limit/u,
    );
    expect(port.reads).toHaveLength(17);
  });

  it('keeps a failure at the selected root fatal', async () => {
    const port = new FakeWorkspacePort();
    port.putDirectory(root);
    port.putText(`${root}/index.md`, '# Bundle\n');
    port.traversalFailures.set(root, new Error('Provider cannot enumerate the selected root.'));

    const error = await loadBundle(port, stringUriCodec, root, root).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(WorkspaceAccessError);
    expect(error).toMatchObject({
      code: 'unavailable',
      message: 'Provider cannot enumerate the selected root.',
    });
  });

  it('accepts exactly the document-count limit and refuses +1 before provider stats', async () => {
    const exactPort = new ControlledWorkspacePort(BUNDLE_READ_LIMITS.maxMarkdownDocuments);
    const exact = await loadBundle(exactPort, stringUriCodec, root, root);
    expect(exact.documents).toHaveLength(BUNDLE_READ_LIMITS.maxMarkdownDocuments);

    const exceededPort = new ControlledWorkspacePort(BUNDLE_READ_LIMITS.maxMarkdownDocuments + 1);
    await expect(loadBundle(exceededPort, stringUriCodec, root, root)).rejects.toThrow(
      /document-count safety limit/u,
    );
    expect(exceededPort.statCalls).toBe(2);
    expect(exceededPort.readCalls).toBe(0);
  });

  it('checks provider-reported per-file and aggregate bytes before any reads', async () => {
    const oversized = new ControlledWorkspacePort(1);
    const only = oversized.entries[0];
    if (only === undefined) {
      throw new Error('Expected one test entry.');
    }
    oversized.statSizes.set(only.uri, BUNDLE_READ_LIMITS.maxDocumentBytes + 1);
    const isolated = await loadBundle(oversized, stringUriCodec, root, root);
    expect(isolated.documents).toEqual([
      expect.objectContaining({
        uri: only.uri,
        bundlePath: only.relativePath,
        identityOnlyFailure: {
          reason: 'resource-limit',
          message: expect.stringMatching(/reported size/u),
        },
      }),
    ]);
    expect(isolated.failures).toEqual([]);
    expect(oversized.readCalls).toBe(0);

    const aggregate = new ControlledWorkspacePort(17);
    for (const entry of aggregate.entries.slice(0, 16)) {
      aggregate.statSizes.set(entry.uri, BUNDLE_READ_LIMITS.maxDocumentBytes);
    }
    const final = aggregate.entries[16];
    if (final === undefined) {
      throw new Error('Expected the aggregate overflow entry.');
    }
    aggregate.statSizes.set(final.uri, 1);
    await expect(loadBundle(aggregate, stringUriCodec, root, root)).rejects.toThrow(
      /cumulative safety limit/u,
    );
    expect(aggregate.readCalls).toBe(0);
  });

  it('checks actual per-file and cumulative bytes returned by a dishonest provider', async () => {
    const oversized = new ControlledWorkspacePort(1);
    oversized.readImpl = async () => new Uint8Array(BUNDLE_READ_LIMITS.maxDocumentBytes + 1);
    const isolated = await loadBundle(oversized, stringUriCodec, root, root);
    expect(isolated.documents).toEqual([
      expect.objectContaining({
        identityOnlyFailure: {
          reason: 'resource-limit',
          message: expect.stringMatching(/provider returned/u),
        },
      }),
    ]);
    expect(isolated.failures).toEqual([]);

    const aggregate = new ControlledWorkspacePort(17);
    const twoMiB = new Uint8Array(BUNDLE_READ_LIMITS.maxDocumentBytes);
    aggregate.readImpl = async (uri) =>
      uri === aggregate.entries[16]?.uri ? new Uint8Array(1) : twoMiB;
    await expect(loadBundle(aggregate, stringUriCodec, root, root)).rejects.toThrow(
      /cumulative Markdown safety limit/u,
    );
    expect(aggregate.maxActiveReads).toBeLessThanOrEqual(BUNDLE_READ_LIMITS.maxConcurrentReads);
  });

  it('never schedules more than eight provider operations at once', async () => {
    const port = new ControlledWorkspacePort(19);
    port.statImpl = async (uri) => {
      await Promise.resolve();
      return {
        type: 'file',
        size: port.contents.get(uri)?.byteLength ?? 0,
        ctime: 0,
        mtime: 0,
      };
    };
    port.readImpl = async (uri) => {
      await Promise.resolve();
      return port.contents.get(uri) ?? new Uint8Array();
    };

    const loaded = await loadBundle(port, stringUriCodec, root, root);

    expect(loaded.documents).toHaveLength(19);
    expect(port.maxActiveStats).toBe(BUNDLE_READ_LIMITS.maxConcurrentReads);
    expect(port.maxActiveReads).toBe(BUNDLE_READ_LIMITS.maxConcurrentReads);
  });

  it('waits for every physical provider call in an aborted batch before settling', async () => {
    const port = new ControlledWorkspacePort(9);
    const pendingStats: Deferred<WorkspaceStat | undefined>[] = [];
    port.statImpl = async () => {
      const pending = deferred<WorkspaceStat | undefined>();
      pendingStats.push(pending);
      return pending.promise;
    };
    const abort = new AbortController();
    let settled = false;
    const loading = loadBundle(port, stringUriCodec, root, root, abort.signal);
    void loading.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await waitFor(() => pendingStats.length === BUNDLE_READ_LIMITS.maxConcurrentReads);
    const issuedStatCalls = port.statCalls;

    abort.abort();
    pendingStats[0]?.resolve({ type: 'file', size: 0, ctime: 0, mtime: 0 });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(port.statCalls).toBe(issuedStatCalls);

    for (const pending of pendingStats.slice(1)) {
      pending.resolve({ type: 'file', size: 0, ctime: 0, mtime: 0 });
    }
    await expect(loading).rejects.toThrow(/aborted|canceled/iu);
    expect(port.statCalls).toBe(issuedStatCalls);
  });

  it('isolates an oversized read but still drains its unresolved batch peer', async () => {
    const port = new ControlledWorkspacePort(2);
    const slow = deferred<Uint8Array>();
    port.readImpl = async (uri) =>
      uri === port.entries[0]?.uri
        ? new Uint8Array(BUNDLE_READ_LIMITS.maxDocumentBytes + 1)
        : slow.promise;
    let settled = false;
    const loading = loadBundle(port, stringUriCodec, root, root);
    void loading.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await waitFor(() => port.readCalls === 2);
    await Promise.resolve();
    expect(settled).toBe(false);

    slow.resolve(new Uint8Array());
    const loaded = await loading;
    expect(loaded.documents.map(({ bundlePath }) => bundlePath)).toEqual(['00000.md', '00001.md']);
    expect(loaded.documents[0]).toEqual(
      expect.objectContaining({
        bundlePath: '00000.md',
        identityOnlyFailure: {
          reason: 'resource-limit',
          message: expect.stringMatching(/provider returned/u),
        },
      }),
    );
    expect(loaded.failures).toEqual([]);
  });

  it('bounds retained failures, depth signals, and provider path identities', async () => {
    const failures = new ControlledWorkspacePort(0);
    for (let index = 0; index <= BUNDLE_READ_LIMITS.maxRetainedFailures; index += 1) {
      failures.traversalFailures.push({
        kind: 'failure',
        uri: `${root}/blocked-${String(index)}`,
        relativePath: `blocked-${String(index)}`,
        message: 'blocked',
      });
    }
    await expect(loadBundle(failures, stringUriCodec, root, root)).rejects.toThrow(
      /retained-failure safety limit/u,
    );

    const depth = new ControlledWorkspacePort(0);
    depth.traversalFailures.push({
      kind: 'failure',
      uri: `${root}/deep`,
      relativePath: 'deep',
      reason: 'safety-limit',
      message: 'depth limit',
    });
    await expect(loadBundle(depth, stringUriCodec, root, root)).rejects.toThrow(/depth limit/u);

    const path = new ControlledWorkspacePort(1);
    const entry = path.entries[0];
    if (entry === undefined) {
      throw new Error('Expected a path test entry.');
    }
    path.entries[0] = {
      ...entry,
      relativePath: `${'a/'.repeat(OKF_SEMANTIC_LIMITS.maxProviderPathSegments)}x.md`,
    };
    await expect(loadBundle(path, stringUriCodec, root, root)).rejects.toThrow(
      /segment identity safety limit/u,
    );
    expect(path.statCalls).toBe(2);
  });

  it('invalidates the complete load when a nested traversal generation changes', async () => {
    const port = new ControlledWorkspacePort(1);
    port.traversalFailures.push({
      kind: 'failure',
      uri: `${root}/nested`,
      relativePath: 'nested',
      reason: 'generation-changed',
      message: 'The nested directory generation changed during enumeration.',
    });

    await expect(loadBundle(port, stringUriCodec, root, root)).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('generation changed'),
    });
    expect(port.readCalls).toBe(0);
  });

  it('bounds the final composed failure message for a long path and provider error', async () => {
    const port = new ControlledWorkspacePort(1);
    const original = port.entries[0];
    if (original === undefined) {
      throw new Error('Expected one failure-message test entry.');
    }
    const relativePath = `${'a'.repeat(
      OKF_SEMANTIC_LIMITS.maxProviderPathCodeUnits - '.md'.length,
    )}.md`;
    const uri = `${root}/${relativePath}`;
    port.entries[0] = { ...original, uri, relativePath };
    port.statImpl = async () => ({ type: 'file', size: 0, ctime: 0, mtime: 0 });
    port.readImpl = async () => {
      throw new Error('provider detail '.repeat(1_000));
    };

    const loaded = await loadBundle(port, stringUriCodec, root, root);

    expect(loaded.failures).toHaveLength(1);
    expect(loaded.failures[0]).toMatchObject({
      uri,
      bundlePath: relativePath,
      reason: 'read',
    });
    expect(loaded.failures[0]?.message).toHaveLength(OKF_SEMANTIC_LIMITS.maxFailureDetailCodeUnits);
    expect(loaded.failures[0]?.message.endsWith('…')).toBe(true);
  });

  it('never splits a surrogate pair while bounding a composed provider error', async () => {
    const port = new ControlledWorkspacePort(1);
    const relativePath = '00000.md';
    const prefix = `Unable to read bundle document ${JSON.stringify(relativePath)}: `;
    const padding = 'x'.repeat(OKF_SEMANTIC_LIMITS.maxFailureDetailCodeUnits - 2 - prefix.length);
    port.readImpl = async () => {
      throw new Error(`${padding}😀tail`);
    };

    const loaded = await loadBundle(port, stringUriCodec, root, root);
    const message = loaded.failures[0]?.message ?? '';

    expect(message.endsWith('…')).toBe(true);
    expect(message.length).toBeLessThanOrEqual(OKF_SEMANTIC_LIMITS.maxFailureDetailCodeUnits);
    const lastRetainedCodeUnit = message.charCodeAt(message.length - 2);
    expect(lastRetainedCodeUnit >= 0xd800 && lastRetainedCodeUnit <= 0xdbff).toBe(false);
  });
});
