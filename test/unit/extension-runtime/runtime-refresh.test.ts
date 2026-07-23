import { afterEach, describe, expect, it, vi } from 'vitest';

import { OKF_SEMANTIC_LIMITS, type Finding } from '../../../src/core/model/index.js';
import type { RuntimeDiagnosticsSink } from '../../../src/extension/diagnostics/publisher.js';
import { BundleRuntime } from '../../../src/extension/runtime/bundleRuntime.js';
import type { BundleRuntimeSnapshot } from '../../../src/extension/runtime/types.js';
import { BUNDLE_READ_LIMITS } from '../../../src/extension/workspace/readSafety.js';
import {
  FakeChangeSource,
  FakeWorkspacePort,
  stringUriCodec,
} from '../extension-workspace/fakes.js';

const root = 'memfs://workspace/bundle';

class FakeDiagnostics implements RuntimeDiagnosticsSink {
  public clearCount = 0;
  public readonly replacements: Finding[][] = [];

  public replace(findings: readonly Finding[]): void {
    this.replacements.push([...findings]);
  }

  public clear(): void {
    this.clearCount += 1;
  }
}

class DishonestOversizedWorkspacePort extends FakeWorkspacePort {
  public oversizedUri: string | undefined;

  public override async read(uri: string): Promise<Uint8Array> {
    if (uri !== this.oversizedUri) {
      return super.read(uri);
    }
    this.reads.push(uri);
    return new Uint8Array(BUNDLE_READ_LIMITS.maxDocumentBytes + 1);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('BundleRuntime', () => {
  it('fully refreshes bytes, diagnostics, graph, and the private source map after a rename', async () => {
    vi.useFakeTimers();
    const port = new FakeWorkspacePort();
    port.putDirectory(root);
    port.putText(`${root}/index.md`, '---\nokf_version: 0.1\n---\n# Bundle\n');
    port.putText(
      `${root}/alpha.md`,
      '---\ntype: note\ntitle: Alpha\ndescription: First concept\n---\nAlpha body\n',
    );
    const source = new FakeChangeSource<string>();
    const diagnostics = new FakeDiagnostics();
    const published: BundleRuntimeSnapshot<string>[] = [];
    const runtime = new BundleRuntime({
      port,
      uris: stringUriCodec,
      diagnostics,
      createChangeSource: () => source,
      now: () => '2026-07-22T00:00:00Z',
      onPublish: (snapshot) => published.push(snapshot),
    });

    runtime.select(root, root);
    await vi.advanceTimersByTimeAsync(250);

    expect(runtime.revision).toBe(1);
    expect(runtime.current?.graph.nodes.map((node) => node.id)).toEqual(['alpha']);
    expect(runtime.current?.nodeSources.get('alpha')).toMatchObject({
      uri: `${root}/alpha.md`,
    });
    expect(runtime.current?.nodeSources.get('alpha')?.range).toBeDefined();
    expect(JSON.stringify(runtime.current?.graph)).not.toContain('memfs://');
    expect(diagnostics.replacements).toHaveLength(1);

    port.files.delete(`${root}/alpha.md`);
    port.putText(
      `${root}/beta.md`,
      '---\ntype: note\ntitle: Beta\ndescription: Renamed concept\n---\nBeta body\n',
    );
    source.emit({
      kind: 'rename',
      previousUri: `${root}/alpha.md`,
      uri: `${root}/beta.md`,
    });
    await vi.advanceTimersByTimeAsync(250);

    expect(runtime.revision).toBe(2);
    expect(runtime.current?.graph.revision).toBe(2);
    expect(runtime.current?.bundle.revision).toBe(2);
    expect(runtime.current?.graph.nodes.map((node) => node.id)).toEqual(['beta']);
    expect(runtime.current?.nodeSources.has('alpha')).toBe(false);
    expect(runtime.current?.nodeSources.get('beta')?.uri).toBe(`${root}/beta.md`);
    expect(published).toHaveLength(2);
    expect(diagnostics.replacements).toHaveLength(2);

    runtime.dispose();
    expect(source.disposed).toBe(true);
  });

  it('disposes the previous bundle watcher and clears stale derived state on selection change', async () => {
    vi.useFakeTimers();
    const port = new FakeWorkspacePort();
    const firstRoot = 'memfs://workspace/first';
    const secondRoot = 'memfs://workspace/second';
    port.putDirectory(firstRoot);
    port.putDirectory(secondRoot);
    port.putText(`${firstRoot}/index.md`, '---\nokf_version: 0.1\n---\n');
    port.putText(`${secondRoot}/index.md`, '---\nokf_version: 0.1\n---\n');
    const sources = [new FakeChangeSource<string>(), new FakeChangeSource<string>()];
    const diagnostics = new FakeDiagnostics();
    const runtime = new BundleRuntime({
      port,
      uris: stringUriCodec,
      diagnostics,
      createChangeSource: () => {
        const source = sources.shift();
        if (source === undefined) throw new Error('Unexpected watcher request.');
        return source;
      },
    });

    const firstSource = sources[0];
    const secondSource = sources[1];
    runtime.select(firstRoot, firstRoot);
    await vi.advanceTimersByTimeAsync(250);
    expect(runtime.current?.context.rootUriString).toBe(firstRoot);

    runtime.select(secondRoot, secondRoot);
    expect(firstSource?.disposed).toBe(true);
    expect(runtime.current).toBeUndefined();
    await vi.advanceTimersByTimeAsync(250);
    expect(runtime.current?.context.rootUriString).toBe(secondRoot);
    expect(diagnostics.clearCount).toBe(2);

    runtime.dispose();
    expect(secondSource?.disposed).toBe(true);
  });

  it('starts a new generation when the host rebinds the same root and safety-root URI', async () => {
    vi.useFakeTimers();
    const port = new FakeWorkspacePort();
    port.putDirectory(root);
    port.putText(`${root}/index.md`, '---\nokf_version: 0.1\n---\n');
    port.putText(`${root}/alpha.md`, '---\ntype: note\ntitle: Alpha\n---\n');
    const firstSource = new FakeChangeSource<string>();
    const secondSource = new FakeChangeSource<string>();
    const sources = [firstSource, secondSource];
    const diagnostics = new FakeDiagnostics();
    const published: BundleRuntimeSnapshot<string>[] = [];
    const runtime = new BundleRuntime({
      port,
      uris: stringUriCodec,
      diagnostics,
      createChangeSource: () => {
        const source = sources.shift();
        if (source === undefined) {
          throw new Error('Unexpected watcher request.');
        }
        return source;
      },
      onPublish: (snapshot) => published.push(snapshot),
    });

    runtime.select(root, root);
    await vi.advanceTimersByTimeAsync(250);
    expect(runtime.current?.revision).toBe(1);

    runtime.select(root, root);
    expect(firstSource.disposed).toBe(true);
    expect(runtime.current).toBeUndefined();
    await vi.advanceTimersByTimeAsync(250);

    expect(runtime.current?.revision).toBe(2);
    expect(runtime.current?.context).toMatchObject({
      rootUriString: root,
      workspaceSafetyRootUri: root,
    });
    expect(published).toHaveLength(2);

    runtime.dispose();
    expect(secondSource.disposed).toBe(true);
  });

  it('publishes readable concepts and a diagnostic after one subtree traversal failure', async () => {
    vi.useFakeTimers();
    const port = new FakeWorkspacePort();
    port.putDirectory(root);
    const blockedSubtree = `${root}/blocked%2Fsubtree`;
    port.putText(`${root}/index.md`, '---\nokf_version: 0.1\n---\n# Bundle\n');
    port.putText(
      `${root}/alpha.md`,
      '---\ntype: note\ntitle: Alpha\ndescription: Readable concept\n---\n# Alpha\n',
    );
    port.putText(
      `${blockedSubtree}/beta.md`,
      '---\ntype: note\ntitle: Beta\ndescription: Blocked concept\n---\n# Beta\n',
    );
    port.traversalFailures.set(blockedSubtree, new Error('Provider refused this subtree.'));
    const diagnostics = new FakeDiagnostics();
    const published: BundleRuntimeSnapshot<string>[] = [];
    const errors: unknown[] = [];
    const runtime = new BundleRuntime({
      port,
      uris: stringUriCodec,
      diagnostics,
      createChangeSource: () => new FakeChangeSource<string>(),
      now: () => '2026-07-22T00:00:00Z',
      onPublish: (snapshot) => published.push(snapshot),
      onError: (error) => errors.push(error),
    });

    runtime.select(root, root);
    await vi.advanceTimersByTimeAsync(250);

    expect(errors).toEqual([]);
    expect(published).toHaveLength(1);
    expect(runtime.current?.graph.nodes.map(({ id }) => id)).toEqual(['alpha']);
    expect(runtime.current?.bundle.failures).toEqual([
      expect.objectContaining({
        uri: blockedSubtree,
        bundlePath: 'blocked%2Fsubtree',
        reason: 'read',
      }),
    ]);
    expect(runtime.current?.findings).toContainEqual(
      expect.objectContaining({
        code: 'okf.conformance.read',
        severity: 'error',
        uri: blockedSubtree,
        correctiveAction: expect.stringContaining('readable'),
      }),
    );
    expect(diagnostics.replacements.at(-1)).toContainEqual(
      expect.objectContaining({
        code: 'okf.conformance.read',
        uri: blockedSubtree,
      }),
    );

    runtime.dispose();
  });

  it('isolates a document resource failure as an identity-only node beside valid siblings', async () => {
    vi.useFakeTimers();
    const port = new FakeWorkspacePort();
    port.putDirectory(root);
    port.putText(`${root}/index.md`, '---\nokf_version: 0.1\n---\n# Bundle\n');
    port.putText(
      `${root}/a-large.md`,
      `---\ntype: must-not-leak\ntags: [must-not-leak]\n---\n${'x'.repeat(
        OKF_SEMANTIC_LIMITS.maxMarkdownBodyCodeUnits + 1,
      )}`,
    );
    port.putText(
      `${root}/z-valid.md`,
      '---\ntype: note\ntitle: Valid\ndescription: Readable sibling\n---\n# Valid\n',
    );
    const diagnostics = new FakeDiagnostics();
    const errors: unknown[] = [];
    const runtime = new BundleRuntime({
      port,
      uris: stringUriCodec,
      diagnostics,
      createChangeSource: () => new FakeChangeSource<string>(),
      now: () => '2026-07-22T00:00:00Z',
      onError: (error) => errors.push(error),
    });

    runtime.select(root, root);
    await vi.advanceTimersByTimeAsync(250);

    expect(errors).toEqual([]);
    expect(runtime.current?.graph.nodes).toEqual([
      {
        id: 'a-large',
        sourceFailed: true,
        type: '',
        tags: [],
        orphan: false,
        brokenLinkCount: 0,
      },
      expect.objectContaining({ id: 'z-valid', type: 'note', orphan: true }),
    ]);
    expect(runtime.current?.graph.statistics).toMatchObject({
      conceptCount: 2,
      orphanCount: 1,
      typeCounts: { note: 1 },
      tagCounts: {},
    });
    expect(runtime.current?.findings).toContainEqual(
      expect.objectContaining({
        code: 'okf.conformance.resource-limit',
        uri: `${root}/a-large.md`,
      }),
    );
    expect(
      runtime.current?.findings.some(
        (finding) =>
          finding.uri === `${root}/a-large.md` &&
          (finding.code === 'okf.curation.orphan-concept' ||
            finding.code === 'okf.curation.missing-title' ||
            finding.code === 'okf.curation.missing-description'),
      ),
    ).toBe(false);

    runtime.dispose();
  });

  it('projects an oversized provider read as one identity-only node beside valid siblings', async () => {
    vi.useFakeTimers();
    const port = new DishonestOversizedWorkspacePort();
    port.putDirectory(root);
    const oversizedUri = `${root}/a-provider-oversized.md`;
    port.putText(`${root}/index.md`, '---\nokf_version: 0.1\n---\n# Bundle\n');
    port.putText(oversizedUri, '# Provider claims this document is small.\n');
    port.putText(
      `${root}/z-valid.md`,
      '---\ntype: note\ntitle: Valid\ndescription: Readable sibling\n---\n# Valid\n',
    );
    port.oversizedUri = oversizedUri;
    const diagnostics = new FakeDiagnostics();
    const errors: unknown[] = [];
    const runtime = new BundleRuntime({
      port,
      uris: stringUriCodec,
      diagnostics,
      createChangeSource: () => new FakeChangeSource<string>(),
      now: () => '2026-07-22T00:00:00Z',
      onError: (error) => errors.push(error),
    });

    runtime.select(root, root);
    await vi.advanceTimersByTimeAsync(250);

    expect(errors).toEqual([]);
    expect(port.reads).toContain(oversizedUri);
    expect(runtime.current?.bundle.failures).toEqual([
      expect.objectContaining({
        uri: oversizedUri,
        bundlePath: 'a-provider-oversized.md',
        reason: 'resource-limit',
        scope: 'document',
      }),
    ]);
    expect(runtime.current?.graph.nodes).toEqual([
      {
        id: 'a-provider-oversized',
        sourceFailed: true,
        type: '',
        tags: [],
        orphan: false,
        brokenLinkCount: 0,
      },
      expect.objectContaining({ id: 'z-valid', type: 'note', orphan: true }),
    ]);
    expect(runtime.current?.graph.statistics).toMatchObject({
      conceptCount: 2,
      orphanCount: 1,
      typeCounts: { note: 1 },
      tagCounts: {},
    });
    expect(runtime.current?.findings.filter(({ uri }) => uri === oversizedUri)).toEqual([
      expect.objectContaining({
        code: 'okf.conformance.resource-limit',
        correctiveAction: expect.stringContaining('Reduce'),
      }),
    ]);

    runtime.dispose();
  });

  it('publishes valid siblings when provider paths contain empty Markdown filename stems', async () => {
    vi.useFakeTimers();
    const port = new FakeWorkspacePort();
    port.putDirectory(root);
    port.putText(`${root}/index.md`, '---\nokf_version: 0.1\n---\n# Bundle\n');
    port.putText(`${root}/.md`, '---\ntype: invalid-root-name\n---\n# Invalid\n');
    port.putText(`${root}/nested/.md`, '---\ntype: invalid-nested-name\n---\n# Invalid\n');
    port.putText(
      `${root}/.notes.md`,
      '---\ntype: note\ntitle: Dot notes\ndescription: Valid dot-prefixed concept\n---\n# Notes\n',
    );
    port.putText(
      `${root}/sibling.md`,
      '---\ntype: note\ntitle: Sibling\ndescription: Valid sibling\n---\n# Sibling\n',
    );
    const diagnostics = new FakeDiagnostics();
    const published: BundleRuntimeSnapshot<string>[] = [];
    const errors: unknown[] = [];
    const runtime = new BundleRuntime({
      port,
      uris: stringUriCodec,
      diagnostics,
      createChangeSource: () => new FakeChangeSource<string>(),
      now: () => '2026-07-22T00:00:00Z',
      onPublish: (snapshot) => published.push(snapshot),
      onError: (error) => errors.push(error),
    });

    runtime.select(root, root);
    await vi.advanceTimersByTimeAsync(250);

    expect(errors).toEqual([]);
    expect(published).toHaveLength(1);
    expect(runtime.current?.graph.nodes.map(({ id }) => id)).toEqual(['.notes', 'sibling']);
    expect(
      runtime.current?.bundle.failures.map(({ bundlePath, reason }) => [bundlePath, reason]),
    ).toEqual([
      ['.md', 'read'],
      ['nested/.md', 'read'],
    ]);
    expect(
      diagnostics.replacements
        .at(-1)
        ?.filter(({ code }) => code === 'okf.conformance.read')
        .map(({ uri }) => uri),
    ).toEqual([`${root}/.md`, `${root}/nested/.md`]);

    runtime.dispose();
  });

  it('clears stale diagnostics and graph state when a current refresh cannot enumerate the bundle', async () => {
    vi.useFakeTimers();
    const port = new FakeWorkspacePort();
    port.putDirectory(root);
    port.putText(`${root}/index.md`, '---\nokf_version: 0.1\n---\n# Bundle\n');
    port.putText(`${root}/alpha.md`, '---\ntype: note\ntitle: Alpha\n---\n# Alpha\n');
    const source = new FakeChangeSource<string>();
    const diagnostics = new FakeDiagnostics();
    const errors: unknown[] = [];
    let clearCount = 0;
    const runtime = new BundleRuntime({
      port,
      uris: stringUriCodec,
      diagnostics,
      createChangeSource: () => source,
      now: () => '2026-07-22T00:00:00Z',
      onClear: () => {
        clearCount += 1;
      },
      onError: (error) => errors.push(error),
    });

    runtime.select(root, root);
    await vi.advanceTimersByTimeAsync(250);
    expect(runtime.current?.graph.nodes.map((node) => node.id)).toEqual(['alpha']);
    expect(diagnostics.replacements).toHaveLength(1);

    port.traversalFailures.set(root, new Error('Provider unavailable.'));
    runtime.requestFullRefresh();
    await vi.advanceTimersByTimeAsync(250);

    expect(errors).toHaveLength(1);
    expect(runtime.current).toBeUndefined();
    expect(diagnostics.clearCount).toBe(2);
    expect(clearCount).toBe(2);

    runtime.requestFullRefresh();
    await vi.advanceTimersByTimeAsync(250);
    expect(errors).toHaveLength(2);
    expect(runtime.current).toBeUndefined();
    expect(diagnostics.clearCount).toBe(3);
    expect(clearCount).toBe(3);

    port.traversalFailures.delete(root);
    runtime.requestFullRefresh();
    await vi.advanceTimersByTimeAsync(250);
    expect(runtime.current?.graph.nodes.map((node) => node.id)).toEqual(['alpha']);
    expect(runtime.revision).toBe(2);
    expect(diagnostics.replacements).toHaveLength(2);

    runtime.dispose();
  });

  it('clears derived state when a watcher refresh finds a swapped workspace ancestor', async () => {
    vi.useFakeTimers();
    const workspaceRoot = 'memfs://workspace';
    const ancestor = `${workspaceRoot}/container`;
    const nestedRoot = `${ancestor}/bundle`;
    const port = new FakeWorkspacePort();
    port.putDirectory(workspaceRoot);
    port.putDirectory(ancestor);
    port.putDirectory(nestedRoot);
    port.putText(`${nestedRoot}/index.md`, '---\nokf_version: 0.1\n---\n# Bundle\n');
    port.putText(`${nestedRoot}/alpha.md`, '---\ntype: note\ntitle: Alpha\n---\n# Alpha\n');
    const source = new FakeChangeSource<string>();
    const diagnostics = new FakeDiagnostics();
    const errors: unknown[] = [];
    const published: BundleRuntimeSnapshot<string>[] = [];
    const runtime = new BundleRuntime({
      port,
      uris: stringUriCodec,
      diagnostics,
      createChangeSource: () => source,
      now: () => '2026-07-22T00:00:00Z',
      onError: (error) => errors.push(error),
      onPublish: (snapshot) => published.push(snapshot),
    });

    runtime.select(nestedRoot, workspaceRoot);
    await vi.advanceTimersByTimeAsync(250);
    expect(runtime.current?.graph.nodes.map((node) => node.id)).toEqual(['alpha']);
    expect(runtime.current?.context.workspaceSafetyRootUri).toBe(workspaceRoot);
    expect(published).toHaveLength(1);
    expect(diagnostics.replacements).toHaveLength(1);
    const readsBeforeSwap = [...port.reads];

    port.putSymbolicLink(ancestor);
    source.emit({ kind: 'change', uri: `${nestedRoot}/alpha.md` });
    await vi.advanceTimersByTimeAsync(250);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('symbolic-link'),
    });
    expect(runtime.current).toBeUndefined();
    expect(diagnostics.clearCount).toBe(2);
    expect(diagnostics.replacements).toHaveLength(1);
    expect(published).toHaveLength(1);
    expect(port.reads).toEqual(readsBeforeSwap);

    port.putDirectory(ancestor);
    runtime.requestFullRefresh();
    await vi.advanceTimersByTimeAsync(250);
    expect(runtime.current?.graph.nodes.map((node) => node.id)).toEqual(['alpha']);

    runtime.dispose();
  });
});
