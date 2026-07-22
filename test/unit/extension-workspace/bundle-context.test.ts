import { describe, expect, it } from 'vitest';

import { BundleContextService } from '../../../src/extension/workspace/bundleContext.js';
import { FakeWorkspacePort, stringUriCodec } from './fakes.js';

describe('BundleContextService', () => {
  it('discovers candidates through an injected index inspector', async () => {
    const port = new FakeWorkspacePort();
    const workspaceRoot = 'memfs://workspace/project';
    port.putText(`${workspaceRoot}/index.md`, '# ordinary directory index\n');
    port.putText(
      `${workspaceRoot}/knowledge/index.md`,
      '---\nokf_version: "0.1"\n---\n# Knowledge\n',
    );
    port.putText(`${workspaceRoot}/knowledge/nested/index.md`, '# nested index\n');
    port.putText(`${workspaceRoot}/資料/index.md`, '---\nokf_version: "0.1"\n---\n# 資料\n');
    const inspected: string[] = [];
    const service = new BundleContextService(port, stringUriCodec, ({ indexUri, text }) => {
      inspected.push(indexUri);
      return {
        isBundleRoot: text.includes('okf_version: "0.1"'),
        ...(text.includes('資料') ? { label: '資料' } : {}),
      };
    });

    const discovery = await service.discover([workspaceRoot]);

    expect(inspected).toHaveLength(4);
    expect(discovery.failures).toEqual([]);
    expect(discovery.candidates.map((candidate) => candidate.rootUriString)).toEqual([
      `${workspaceRoot}/knowledge`,
      `${workspaceRoot}/資料`,
    ]);
    expect(discovery.candidates[1]?.label).toBe('資料');
  });

  it('selects one candidate automatically and keeps explicit context only in memory', async () => {
    const port = new FakeWorkspacePort();
    const workspaceRoot = 'vscode-remote://ssh-remote+host/workspace';
    port.putText(`${workspaceRoot}/one/index.md`, 'valid');
    const service = new BundleContextService(port, stringUriCodec, () => ({
      isBundleRoot: true,
    }));
    const discovery = await service.discover([workspaceRoot]);

    const selected = service.resolve(discovery);

    expect(selected.reason).toBe('single');
    expect(service.current?.rootUriString).toBe(`${workspaceRoot}/one`);
    expect(service.resolve(discovery).reason).toBe('current');
    service.clear();
    expect(service.current).toBeUndefined();
  });

  it('requires caller selection when discovery is ambiguous', async () => {
    const port = new FakeWorkspacePort();
    const workspaceRoot = 'memfs://workspace/project';
    port.putText(`${workspaceRoot}/a/index.md`, 'valid');
    port.putText(`${workspaceRoot}/b/index.md`, 'valid');
    const service = new BundleContextService(port, stringUriCodec, () => ({
      isBundleRoot: true,
    }));
    const discovery = await service.discover([workspaceRoot]);

    expect(service.resolve(discovery)).toEqual({
      reason: 'ambiguous',
      candidates: discovery.candidates,
    });
    const explicit = discovery.candidates[1];
    if (explicit === undefined) {
      throw new Error('Expected a second candidate.');
    }
    expect(service.resolve(discovery, explicit)).toEqual({
      reason: 'explicit',
      candidate: explicit,
      candidates: discovery.candidates,
    });
    expect(service.current?.rootUriString).toBe(`${workspaceRoot}/b`);
    const replacement = discovery.candidates[0];
    if (replacement === undefined) {
      throw new Error('Expected a first candidate.');
    }
    service.select(replacement);
    expect(service.current?.rootUriString).toBe(`${workspaceRoot}/a`);
  });

  it('reports an unreadable index without preventing unrelated discovery', async () => {
    const port = new FakeWorkspacePort();
    const workspaceRoot = 'memfs://workspace/project';
    port.files.set(`${workspaceRoot}/broken/index.md`, new Uint8Array([0xff]));
    port.putText(`${workspaceRoot}/valid/index.md`, 'valid');
    const service = new BundleContextService(port, stringUriCodec, () => ({
      isBundleRoot: true,
    }));

    const discovery = await service.discover([workspaceRoot]);

    expect(discovery.candidates.map((candidate) => candidate.rootUriString)).toEqual([
      `${workspaceRoot}/valid`,
    ]);
    expect(discovery.failures).toEqual([
      expect.objectContaining({ uri: `${workspaceRoot}/broken/index.md` }),
    ]);
  });

  it('preserves literal provider folder identities without percent-decoded sibling collisions', async () => {
    const port = new FakeWorkspacePort();
    const workspaceRoot = 'memfs://workspace/project';
    const providerFolders = [
      'literal%',
      'encoded%2Fsegment',
      'encoded%252Fsegment',
      'encoded/segment',
      'team knowledge',
      'team%20knowledge',
      '資料',
    ];
    for (const folder of providerFolders) {
      port.putText(`${workspaceRoot}/${folder}/index.md`, 'valid');
    }
    const service = new BundleContextService(port, stringUriCodec, () => ({
      isBundleRoot: true,
    }));

    const discovery = await service.discover([workspaceRoot]);

    expect(discovery.failures).toEqual([]);
    expect(discovery.candidates).toHaveLength(providerFolders.length);
    expect(new Set(discovery.candidates.map(({ rootUriString }) => rootUriString))).toEqual(
      new Set(providerFolders.map((folder) => `${workspaceRoot}/${folder}`)),
    );
    expect(
      discovery.candidates.find(({ rootUriString }) => rootUriString.endsWith('/encoded%2Fsegment'))
        ?.indexUriString,
    ).toBe(`${workspaceRoot}/encoded%2Fsegment/index.md`);
  });

  it('discovers a sole bundle candidate beneath a generic dist directory', async () => {
    const port = new FakeWorkspacePort();
    const workspaceRoot = 'memfs://workspace/project';
    port.putText(`${workspaceRoot}/dist/knowledge/index.md`, 'valid');
    const service = new BundleContextService(port, stringUriCodec, () => ({
      isBundleRoot: true,
    }));

    const discovery = await service.discover([workspaceRoot]);

    expect(discovery.failures).toEqual([]);
    expect(discovery.candidates.map(({ rootUriString }) => rootUriString)).toEqual([
      `${workspaceRoot}/dist/knowledge`,
    ]);
    expect(service.resolve(discovery).reason).toBe('single');
  });

  it('streams a narrow candidate search, skips internal trees, and continues after subtree failure', async () => {
    const port = new FakeWorkspacePort();
    const workspaceRoot = 'memfs://workspace/large-project';
    for (let index = 0; index < 2_000; index += 1) {
      port.putText(`${workspaceRoot}/node_modules/package-${String(index)}/index.md`, 'ignored');
      port.putText(`${workspaceRoot}/src/file-${String(index)}.ts`, 'not a candidate');
    }
    port.putText(`${workspaceRoot}/.git/objects/index.md`, 'ignored VCS data');
    port.putText(`${workspaceRoot}/.vscode-test/editor/index.md`, 'ignored test tooling data');
    port.putText(`${workspaceRoot}/packages/domain/deep/knowledge/index.md`, 'valid');
    port.traversalFailures.set(
      `${workspaceRoot}/unreadable-subtree`,
      new Error('Provider refused this subtree.'),
    );
    const inspected: string[] = [];
    const service = new BundleContextService(port, stringUriCodec, ({ indexUri }) => {
      inspected.push(indexUri);
      return { isBundleRoot: true };
    });

    const discovery = await service.discover([workspaceRoot]);

    expect(inspected).toEqual([`${workspaceRoot}/packages/domain/deep/knowledge/index.md`]);
    expect(discovery.candidates.map(({ rootUriString }) => rootUriString)).toEqual([
      `${workspaceRoot}/packages/domain/deep/knowledge`,
    ]);
    expect(discovery.failures).toEqual([
      {
        uri: `${workspaceRoot}/unreadable-subtree`,
        message: 'Provider refused this subtree.',
      },
    ]);
    expect(port.traversalEventCount).toBe(2);
  });
});
