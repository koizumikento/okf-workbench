import { describe, expect, it } from 'vitest';

import { OKF_SEMANTIC_LIMITS } from '../../../src/core/model/index.js';
import { BundleContextService } from '../../../src/extension/workspace/bundleContext.js';
import type { WorkspaceTraversalEvent } from '../../../src/extension/workspace/types.js';
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
    expect(discovery.truncated).toBe(false);
    expect(discovery.candidates.map((candidate) => candidate.rootUriString)).toEqual([
      `${workspaceRoot}/knowledge`,
      `${workspaceRoot}/資料`,
    ]);
    expect(discovery.candidates[1]?.label).toBe('資料');
  });

  it('revalidates a candidate parent after an asynchronous index inspector returns', async () => {
    const workspaceRoot = 'memfs://workspace/project';
    const candidateRoot = `${workspaceRoot}/knowledge`;
    const indexUri = `${candidateRoot}/index.md`;
    const port = new (class extends FakeWorkspacePort {
      candidateGeneration = 1;

      override async stat(uri: string) {
        const stat = await super.stat(uri);
        if (stat?.type !== 'directory') {
          return stat;
        }
        const generation = uri === candidateRoot ? this.candidateGeneration : 1;
        return {
          ...stat,
          readIdentity: {
            kind: 'trusted-provider' as const,
            type: stat.type,
            size: stat.size,
            ctime: generation,
            mtime: generation,
          },
        };
      }
    })();
    port.putText(indexUri, 'valid');
    const service = new BundleContextService(port, stringUriCodec, async () => {
      await Promise.resolve();
      port.candidateGeneration += 1;
      return { isBundleRoot: true, label: 'MUST NOT BE RETAINED' };
    });

    const discovery = await service.discover([workspaceRoot]);

    expect(discovery.candidates).toEqual([]);
    expect(discovery.failures).toEqual([
      expect.objectContaining({
        uri: indexUri,
        message: expect.stringContaining('generation changed'),
      }),
    ]);
    expect(JSON.stringify(discovery)).not.toContain('MUST NOT BE RETAINED');
  });

  it('keeps inspector rejection non-fatal only when the candidate parent stays stable', async () => {
    const workspaceRoot = 'memfs://workspace/project';
    const changedRoot = `${workspaceRoot}/a`;
    const safeRoot = `${workspaceRoot}/b`;
    const changedIndex = `${changedRoot}/index.md`;
    const port = new (class extends FakeWorkspacePort {
      changedGeneration = 1;

      override async stat(uri: string) {
        const stat = await super.stat(uri);
        if (stat?.type !== 'directory') {
          return stat;
        }
        const generation = uri === changedRoot ? this.changedGeneration : 1;
        return {
          ...stat,
          readIdentity: {
            kind: 'trusted-provider' as const,
            type: stat.type,
            size: stat.size,
            ctime: generation,
            mtime: generation,
          },
        };
      }
    })();
    port.putText(changedIndex, 'changed');
    port.putText(`${safeRoot}/index.md`, 'safe');
    const service = new BundleContextService(port, stringUriCodec, async ({ rootUri }) => {
      if (rootUri === changedRoot) {
        await Promise.resolve();
        port.changedGeneration += 1;
        throw new Error('Inspector rejected after the parent changed.');
      }
      return { isBundleRoot: true, label: 'Safe sibling' };
    });

    const discovery = await service.discover([workspaceRoot]);

    expect(discovery.candidates.map(({ rootUriString }) => rootUriString)).toEqual([safeRoot]);
    expect(discovery.failures).toEqual([
      expect.objectContaining({
        uri: changedIndex,
        message: expect.stringContaining('generation changed'),
      }),
    ]);
    expect(discovery.truncated).toBe(true);
    expect(service.resolve(discovery)).toEqual({
      reason: 'incomplete',
      candidates: discovery.candidates,
    });
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

  it('treats invalid UTF-8 as a known non-candidate and selects a valid sibling', async () => {
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
    expect(discovery.truncated).toBe(false);
    expect(service.resolve(discovery)).toMatchObject({
      reason: 'single',
      candidate: { rootUriString: `${workspaceRoot}/valid` },
    });
  });

  it('keeps an index read failure incomplete even when a valid sibling is visible', async () => {
    const port = new FakeWorkspacePort();
    const workspaceRoot = 'memfs://workspace/project';
    port.putText(`${workspaceRoot}/blocked/index.md`, 'unreadable');
    port.putText(`${workspaceRoot}/valid/index.md`, 'valid');
    port.readFailures.set(
      `${workspaceRoot}/blocked/index.md`,
      new Error('The provider refused the read.'),
    );
    const service = new BundleContextService(port, stringUriCodec, () => ({
      isBundleRoot: true,
    }));

    const discovery = await service.discover([workspaceRoot]);

    expect(discovery.candidates.map(({ rootUriString }) => rootUriString)).toEqual([
      `${workspaceRoot}/valid`,
    ]);
    expect(discovery.failures).toEqual([
      {
        uri: `${workspaceRoot}/blocked/index.md`,
        message: 'The provider refused the read.',
      },
    ]);
    expect(discovery.truncated).toBe(true);
    expect(service.resolve(discovery).reason).toBe('incomplete');
  });

  it('treats index-content parse rejection as a known non-candidate', async () => {
    const port = new FakeWorkspacePort();
    const workspaceRoot = 'memfs://workspace/project';
    port.putText(`${workspaceRoot}/rejected/index.md`, 'reject this content');
    port.putText(`${workspaceRoot}/valid/index.md`, 'valid');
    const service = new BundleContextService(port, stringUriCodec, ({ text }) => {
      if (text.startsWith('reject')) {
        throw new Error('The index declaration is malformed.');
      }
      return { isBundleRoot: true };
    });

    const discovery = await service.discover([workspaceRoot]);

    expect(discovery.failures).toEqual([
      {
        uri: `${workspaceRoot}/rejected/index.md`,
        message: 'The index declaration is malformed.',
      },
    ]);
    expect(discovery.truncated).toBe(false);
    expect(service.resolve(discovery)).toMatchObject({
      reason: 'single',
      candidate: { rootUriString: `${workspaceRoot}/valid` },
    });
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
    expect(discovery.truncated).toBe(true);
    const readableCandidate = discovery.candidates[0];
    if (readableCandidate === undefined) {
      throw new Error('Expected the readable sibling candidate.');
    }
    service.select(readableCandidate);
    expect(service.resolve(discovery).reason).toBe('incomplete');
    expect(service.current).toBeUndefined();
    expect(port.traversalEventCount).toBe(2);
  });

  it('bounds the number of indexes inspected automatically', async () => {
    const port = new FakeWorkspacePort();
    const workspaceRoot = 'memfs://workspace/bounded-project';
    port.putText(`${workspaceRoot}/a/index.md`, 'valid');
    port.putText(`${workspaceRoot}/b/index.md`, 'valid');
    port.putText(`${workspaceRoot}/c/index.md`, 'not inspected');
    const inspected: string[] = [];
    const service = new BundleContextService(
      port,
      stringUriCodec,
      ({ indexUri }) => {
        inspected.push(indexUri);
        return { isBundleRoot: true };
      },
      { maxIndexFiles: 2 },
    );

    const discovery = await service.discover([workspaceRoot]);

    expect(inspected).toEqual([`${workspaceRoot}/a/index.md`, `${workspaceRoot}/b/index.md`]);
    expect(discovery.candidates.map(({ rootUriString }) => rootUriString)).toEqual([
      `${workspaceRoot}/a`,
      `${workspaceRoot}/b`,
    ]);
    expect(discovery.failures).toEqual([
      {
        uri: workspaceRoot,
        message: expect.stringContaining('stopped after 2 index.md files'),
      },
    ]);
    expect(discovery.truncated).toBe(true);
    expect(service.resolve(discovery).reason).toBe('incomplete');
  });

  it('marks a depth-limited search incomplete instead of selecting its sole visible candidate', async () => {
    const port = new FakeWorkspacePort();
    const workspaceRoot = 'memfs://workspace/deep-project';
    port.putText(`${workspaceRoot}/visible/index.md`, 'valid');
    port.putText(`${workspaceRoot}/too/deep/index.md`, 'hidden candidate');
    const inspected: string[] = [];
    const service = new BundleContextService(
      port,
      stringUriCodec,
      ({ indexUri }) => {
        inspected.push(indexUri);
        return { isBundleRoot: true };
      },
      { maxDepth: 2 },
    );

    const discovery = await service.discover([workspaceRoot]);

    expect(inspected).toEqual([`${workspaceRoot}/visible/index.md`]);
    expect(discovery.candidates.map(({ rootUriString }) => rootUriString)).toEqual([
      `${workspaceRoot}/visible`,
    ]);
    expect(discovery.failures).toEqual([
      {
        uri: `${workspaceRoot}/too/deep`,
        message: expect.stringContaining('maximum depth of 2 path segments'),
      },
    ]);
    expect(discovery.truncated).toBe(true);
    expect(service.resolve(discovery).reason).toBe('incomplete');
  });

  it('bounds retained discovery failures and reports omitted details', async () => {
    const port = new FakeWorkspacePort();
    const workspaceRoot = 'memfs://workspace/failing-project';
    for (const name of ['a', 'b', 'c', 'd']) {
      port.traversalFailures.set(`${workspaceRoot}/${name}`, new Error(`failure ${name}`));
    }
    const service = new BundleContextService(port, stringUriCodec, () => ({ isBundleRoot: true }), {
      maxFailures: 2,
    });

    const discovery = await service.discover([workspaceRoot]);

    expect(discovery.failures).toHaveLength(2);
    expect(discovery.failures[0]).toEqual({
      uri: `${workspaceRoot}/a`,
      message: 'failure a',
    });
    expect(discovery.failures[1]).toEqual({
      uri: workspaceRoot,
      message: expect.stringContaining('3 additional bundle discovery failures were omitted'),
    });
    expect(discovery.truncated).toBe(true);
  });

  it('bounds provider failure text before retaining discovery diagnostics', async () => {
    const port = new FakeWorkspacePort();
    const workspaceRoot = 'memfs://workspace/failing-project';
    const indexUri = `${workspaceRoot}/blocked/index.md`;
    port.putText(indexUri, 'unreadable');
    port.readFailures.set(
      indexUri,
      new Error('x'.repeat(OKF_SEMANTIC_LIMITS.maxFailureDetailCodeUnits + 1_000)),
    );
    const service = new BundleContextService(port, stringUriCodec, () => ({
      isBundleRoot: true,
    }));

    const discovery = await service.discover([workspaceRoot]);

    expect(discovery.failures).toHaveLength(1);
    expect(discovery.failures[0]?.message).toHaveLength(
      OKF_SEMANTIC_LIMITS.maxFailureDetailCodeUnits,
    );
    expect(discovery.failures[0]?.message.endsWith('…')).toBe(true);
  });

  it('rejects oversized roots and over-deep provider paths before stat or read', async () => {
    const oversizedRoot = `memfs://workspace/${'r'.repeat(
      OKF_SEMANTIC_LIMITS.maxSourceUriCodeUnits,
    )}`;
    const rootPort = new FakeWorkspacePort();
    const rootService = new BundleContextService(rootPort, stringUriCodec, () => ({
      isBundleRoot: true,
    }));
    const rootDiscovery = await rootService.discover([oversizedRoot]);
    expect(rootDiscovery.failures).toEqual([
      expect.objectContaining({ uri: '<provider-uri-exceeds-limit>' }),
    ]);
    expect(rootPort.traversalEventCount).toBe(0);

    class CraftedPathPort extends FakeWorkspacePort {
      override async *traverse(root: string): AsyncIterable<WorkspaceTraversalEvent<string>> {
        const relativePath = `${'a/'.repeat(OKF_SEMANTIC_LIMITS.maxProviderPathSegments)}index.md`;
        yield {
          kind: 'entry',
          entry: { uri: `${root}/${relativePath}`, relativePath, type: 'file' },
        };
      }
    }
    const pathPort = new CraftedPathPort();
    const workspaceRoot = 'memfs://workspace/project';
    const pathService = new BundleContextService(pathPort, stringUriCodec, () => ({
      isBundleRoot: true,
    }));
    const pathDiscovery = await pathService.discover([workspaceRoot]);
    expect(pathDiscovery.failures).toEqual([
      expect.objectContaining({ message: expect.stringContaining('deeper than 64 segments') }),
    ]);
    expect(pathPort.reads).toEqual([]);
  });

  it('skips an oversized index without preventing a readable sibling candidate', async () => {
    const port = new FakeWorkspacePort();
    const workspaceRoot = 'memfs://workspace/large-index-project';
    port.putText(`${workspaceRoot}/a/index.md`, 'too large');
    port.putText(`${workspaceRoot}/b/index.md`, 'ok');
    const inspected: string[] = [];
    const service = new BundleContextService(
      port,
      stringUriCodec,
      ({ indexUri }) => {
        inspected.push(indexUri);
        return { isBundleRoot: true };
      },
      { maxIndexBytes: 4 },
    );

    const discovery = await service.discover([workspaceRoot]);

    expect(inspected).toEqual([`${workspaceRoot}/b/index.md`]);
    expect(discovery.candidates.map(({ rootUriString }) => rootUriString)).toEqual([
      `${workspaceRoot}/b`,
    ]);
    expect(discovery.failures).toEqual([
      {
        uri: `${workspaceRoot}/a/index.md`,
        message: expect.stringContaining('larger than 4 bytes'),
      },
    ]);
    expect(service.resolve(discovery).reason).toBe('incomplete');
  });

  it('stops before retaining index content beyond the total byte budget', async () => {
    const port = new FakeWorkspacePort();
    const workspaceRoot = 'memfs://workspace/total-index-project';
    port.putText(`${workspaceRoot}/a/index.md`, 'ok');
    port.putText(`${workspaceRoot}/b/index.md`, 'ok');
    const inspected: string[] = [];
    const service = new BundleContextService(
      port,
      stringUriCodec,
      ({ indexUri }) => {
        inspected.push(indexUri);
        return { isBundleRoot: true };
      },
      { maxIndexBytes: 4, maxTotalIndexBytes: 3 },
    );

    const discovery = await service.discover([workspaceRoot]);

    expect(inspected).toEqual([`${workspaceRoot}/a/index.md`]);
    expect(discovery.candidates.map(({ rootUriString }) => rootUriString)).toEqual([
      `${workspaceRoot}/a`,
    ]);
    expect(discovery.failures).toEqual([
      {
        uri: workspaceRoot,
        message: expect.stringContaining('3-byte total limit would be exceeded'),
      },
    ]);
    expect(port.reads).toEqual([`${workspaceRoot}/a/index.md`]);
    expect(service.resolve(discovery).reason).toBe('incomplete');
  });

  it('stops after a provider returns more index bytes than its stat advertised', async () => {
    class UnderreportingWorkspacePort extends FakeWorkspacePort {
      override async stat(uri: string) {
        const actual = await super.stat(uri);
        return actual === undefined ? undefined : { ...actual, size: 1 };
      }
    }

    const port = new UnderreportingWorkspacePort();
    const workspaceRoot = 'memfs://workspace/underreported-index-project';
    port.putText(`${workspaceRoot}/a/index.md`, 'too large');
    port.putText(`${workspaceRoot}/b/index.md`, 'ok');
    const service = new BundleContextService(port, stringUriCodec, () => ({ isBundleRoot: true }), {
      maxIndexBytes: 4,
    });

    const discovery = await service.discover([workspaceRoot]);

    expect(port.reads).toEqual([`${workspaceRoot}/a/index.md`]);
    expect(discovery.candidates).toEqual([]);
    expect(discovery.failures).toEqual([
      {
        uri: `${workspaceRoot}/a/index.md`,
        message: expect.stringContaining('returned more than the 4-byte file limit'),
      },
    ]);
    expect(service.resolve(discovery).reason).toBe('incomplete');
  });

  it('rejects invalid discovery limits at construction time', () => {
    const port = new FakeWorkspacePort();

    expect(
      () =>
        new BundleContextService(port, stringUriCodec, () => ({ isBundleRoot: true }), {
          maxIndexFiles: 0,
        }),
    ).toThrow(/maxIndexFiles must be a positive integer/u);
  });

  it('bounds the number of workspace roots searched automatically', async () => {
    const port = new FakeWorkspacePort();
    const roots = [
      'memfs://workspace/first',
      'memfs://workspace/second',
      'memfs://workspace/third',
    ];
    for (const root of roots) {
      port.putText(`${root}/index.md`, 'valid');
    }
    const service = new BundleContextService(port, stringUriCodec, () => ({ isBundleRoot: true }), {
      maxWorkspaceRoots: 2,
    });

    const discovery = await service.discover(roots);

    expect(discovery.candidates.map(({ rootUriString }) => rootUriString)).toEqual(
      roots.slice(0, 2),
    );
    expect(discovery.failures).toEqual([
      {
        uri: roots[2],
        message: expect.stringContaining('stopped after 2 workspace roots'),
      },
    ]);
    expect(discovery.truncated).toBe(true);
    expect(service.resolve(discovery).reason).toBe('incomplete');
  });
});
