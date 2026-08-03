import { describe, expect, it } from 'vitest';

import { buildGraphPayload } from '../../../src/core/graph/index.js';
import { parseBundle } from '../../../src/core/parser/index.js';
import { VALIDATION_CODES, validateBundle } from '../../../src/core/validation/index.js';
import {
  guardBundleWriteSelection,
  inspectBundleWriteAccess,
  inspectBundleRootIndex,
  inspectExplicitBundleRoot,
  inspectSelectedBundleRoot,
} from '../../../src/extension/composition/bundle-inspection.js';
import { BundleContextService } from '../../../src/extension/workspace/bundleContext.js';
import { BUNDLE_READ_LIMITS } from '../../../src/extension/workspace/readSafety.js';
import type { WorkspaceStat } from '../../../src/extension/workspace/types.js';
import { FakeWorkspacePort, stringUriCodec } from '../extension-workspace/fakes.js';

function inspect(text: string) {
  return inspectBundleRootIndex({
    rootUri: 'memfs://workspace/knowledge',
    indexUri: 'memfs://workspace/knowledge/index.md',
    text,
  });
}

describe('bundle root inspection', () => {
  it('uses parsed YAML fields and returns an optional human label', () => {
    expect(
      inspect(
        '---\n# producer comment\nokf_version: "0.1"\ntitle: "Team knowledge"\n---\n# Index\n',
      ),
    ).toEqual({
      isBundleRoot: true,
      label: 'Team knowledge',
      version: { declared: '"0.1"', compatibility: 'supported' },
    });
  });

  it('auto-detects semantic version strings but leaves invalid values to explicit selection', async () => {
    const taggedVersion = '---\nokf_version: !!str 0.1\n---\n# Index\n';
    expect(inspect(taggedVersion)).toEqual({
      isBundleRoot: true,
      version: { declared: '"0.1"', compatibility: 'supported' },
    });
    const parsedTaggedVersion = parseBundle({
      rootUri: 'memfs://workspace/tagged',
      revision: 1,
      documents: [
        {
          uri: 'memfs://workspace/tagged/index.md',
          bundlePath: 'index.md',
          content: taggedVersion,
        },
      ],
    });
    expect(
      validateBundle(parsedTaggedVersion, { now: '2026-07-22T00:00:00Z' }).filter(
        (finding) => finding.category === 'compatibility',
      ),
    ).toEqual([]);
    const taggedPort = new FakeWorkspacePort();
    taggedPort.putDirectory('memfs://workspace/tagged');
    taggedPort.putText('memfs://workspace/tagged/index.md', taggedVersion);
    await expect(
      inspectBundleWriteAccess('memfs://workspace/tagged', taggedPort, stringUriCodec),
    ).resolves.toEqual({ ok: true, compatibility: 'supported' });
    const aliasedVersion = [
      '---',
      'version_source: &supported-version !!str 0.1',
      'okf_version: *supported-version',
      '---',
      '# Index',
      '',
    ].join('\n');
    expect(inspect(aliasedVersion)).toEqual({
      isBundleRoot: true,
      version: { declared: '"0.1"', compatibility: 'supported' },
    });
    const structuralSpoof = [
      '---',
      'okf_version:',
      '  $okf-workbench:yaml-tag:',
      '    tag: "tag:yaml.org,2002:str"',
      '    value: "0.1"',
      '    source: "0.1"',
      '---',
      '# Index',
      '',
    ].join('\n');
    expect(inspect(structuralSpoof)).toMatchObject({
      isBundleRoot: false,
      reason: 'invalid-version',
    });
    const spoofPort = new FakeWorkspacePort();
    spoofPort.putDirectory('memfs://workspace/spoofed');
    spoofPort.putText('memfs://workspace/spoofed/index.md', structuralSpoof);
    await expect(
      inspectBundleWriteAccess('memfs://workspace/spoofed', spoofPort, stringUriCodec),
    ).resolves.toMatchObject({
      ok: false,
      problem: { code: 'invalid-okf-version-write' },
    });
    expect(inspect('---\nokf_version: 1\n---\n# Index\n')).toEqual({
      isBundleRoot: false,
      reason: 'invalid-version',
      declared: '1',
    });
    expect(inspect('---\nokf_version: "0.2"\n---\n# Index\n')).toEqual({
      isBundleRoot: true,
      version: { declared: '"0.2"', compatibility: 'supported' },
    });
    expect(inspect('---\nokf_version: "1.0"\n---\n# Index\n')).toEqual({
      isBundleRoot: true,
      version: { declared: '"1.0"', compatibility: 'unsupported' },
    });
  });

  it('does not mistake Markdown text or malformed YAML for a bundle declaration', () => {
    expect(inspect('# Notes\n\nExample: `okf_version: "0.1"`\n')).toEqual({
      isBundleRoot: false,
      reason: 'missing-version',
    });
    expect(inspect('---\nokf_version: [\n---\n')).toEqual({
      isBundleRoot: false,
      reason: 'invalid-index',
    });
  });

  it('does not treat an unrelated root frontmatter mapping as a declaration', () => {
    expect(inspect('---\ntitle: Ordinary directory index\n---\n# Index\n')).toEqual({
      isBundleRoot: false,
      reason: 'missing-version',
    });
  });

  it('verifies an explicitly selected directory before returning its parsed root', async () => {
    const root = 'memfs://workspace/knowledge';
    const port = new FakeWorkspacePort();
    port.putDirectory(root);
    port.putText(
      `${root}/index.md`,
      '---\nokf_version: "0.1"\ntitle: Verified bundle\n---\n# Index\n',
    );

    await expect(inspectSelectedBundleRoot(root, port, stringUriCodec)).resolves.toEqual({
      ok: true,
      indexUri: `${root}/index.md`,
      decision: {
        isBundleRoot: true,
        label: 'Verified bundle',
        version: { declared: '"0.1"', compatibility: 'supported' },
      },
    });
  });

  it('refuses an explicitly selected index whose reported size exceeds the read limit', async () => {
    const root = 'memfs://workspace/reported-oversized-index';
    const indexUri = `${root}/index.md`;
    const port = new (class extends FakeWorkspacePort {
      override async stat(uri: string) {
        if (uri === indexUri) {
          return {
            type: 'file' as const,
            size: BUNDLE_READ_LIMITS.maxDocumentBytes + 1,
            ctime: 0,
            mtime: 0,
          };
        }
        return super.stat(uri);
      }
    })();
    port.putDirectory(root);
    port.putText(indexUri, '---\nokf_version: "0.1"\n---\n# Index\n');

    await expect(inspectExplicitBundleRoot(root, port, stringUriCodec)).resolves.toEqual({
      ok: true,
      indexUri,
      decision: { isBundleRoot: false, reason: 'unreadable-index' },
    });
    expect(port.reads).toEqual([]);
  });

  it('refuses an explicitly selected index when the provider returns more bytes than reported', async () => {
    const root = 'memfs://workspace/actual-oversized-index';
    const indexUri = `${root}/index.md`;
    const port = new (class extends FakeWorkspacePort {
      override async stat(uri: string) {
        if (uri === indexUri) {
          return { type: 'file' as const, size: 1, ctime: 0, mtime: 0 };
        }
        return super.stat(uri);
      }
    })();
    port.putDirectory(root);
    port.files.set(indexUri, new Uint8Array(BUNDLE_READ_LIMITS.maxDocumentBytes + 1));

    await expect(inspectExplicitBundleRoot(root, port, stringUriCodec)).resolves.toEqual({
      ok: true,
      indexUri,
      decision: { isBundleRoot: false, reason: 'unreadable-index' },
    });
    expect(port.reads).toEqual([indexUri]);
  });

  it('preserves BOM count across selected-root reads and rejects a double BOM', async () => {
    const singleRoot = 'memfs://workspace/single-bom';
    const doubleRoot = 'memfs://workspace/double-bom';
    const port = new FakeWorkspacePort();
    port.putDirectory(singleRoot);
    port.putDirectory(doubleRoot);
    const index = '---\nokf_version: "0.1"\n---\n# Index\n';
    port.putText(`${singleRoot}/index.md`, `\uFEFF${index}`);
    port.putText(`${doubleRoot}/index.md`, `\uFEFF\uFEFF${index}`);

    await expect(
      inspectSelectedBundleRoot(singleRoot, port, stringUriCodec),
    ).resolves.toMatchObject({
      ok: true,
      decision: { isBundleRoot: true, version: { compatibility: 'supported' } },
    });
    await expect(inspectExplicitBundleRoot(doubleRoot, port, stringUriCodec)).resolves.toEqual({
      ok: true,
      indexUri: `${doubleRoot}/index.md`,
      decision: { isBundleRoot: false, reason: 'invalid-index' },
    });
  });

  it('keeps unsupported major versions selectable for reads but fails closed for writes', async () => {
    const root = 'memfs://workspace/knowledge';
    const futureMinorRoot = 'memfs://workspace/future-minor';
    const port = new FakeWorkspacePort();
    port.putDirectory(root);
    port.putDirectory(futureMinorRoot);
    port.putText(`${root}/index.md`, '---\nokf_version: "1.0"\n---\n# Future bundle\n');
    port.putText(
      `${futureMinorRoot}/index.md`,
      '---\nokf_version: "0.3"\n---\n# Future minor bundle\n',
    );

    expect(inspect(port.text(`${root}/index.md`) ?? '')).toEqual({
      isBundleRoot: true,
      version: { declared: '"1.0"', compatibility: 'unsupported' },
    });
    await expect(inspectBundleWriteAccess(root, port, stringUriCodec)).resolves.toEqual({
      ok: false,
      problem: {
        code: 'unsupported-okf-version-write',
        message:
          'The selected bundle declares unsupported OKF version "1.0"; OKF Workbench writes only OKF 0.1- and 0.2-compatible bundles.',
        correctiveAction:
          'No files were written. Validate or graph the bundle read-only, then migrate it or review support before editing.',
      },
    });
    await expect(inspectBundleWriteAccess(futureMinorRoot, port, stringUriCodec)).resolves.toEqual({
      ok: true,
      compatibility: 'future-minor',
    });
    expect(port.writes).toEqual([]);
  });

  it('revalidates a selection and reports a refusal before returning it to a write command', async () => {
    const root = 'memfs://workspace/knowledge';
    const port = new FakeWorkspacePort();
    port.putDirectory(root);
    port.putText(`${root}/index.md`, '---\nokf_version: "2.0"\n---\n# Future bundle\n');
    const refused: string[] = [];

    const selection = await guardBundleWriteSelection(
      { bundleRootUri: root, workspaceSafetyRootUri: root, label: 'future' },
      port,
      stringUriCodec,
      async (problem) => {
        refused.push(problem.code);
      },
    );

    expect(selection).toBeUndefined();
    expect(refused).toEqual(['unsupported-okf-version-write']);
    expect(port.writes).toEqual([]);
  });

  it('retains the workspace safety root across the version-inspection await', async () => {
    const workspaceRoot = 'memfs://workspace';
    const ancestor = `${workspaceRoot}/container`;
    const root = `${ancestor}/knowledge`;
    class SwapAfterInitialChainPort extends FakeWorkspacePort {
      rootStats = 0;

      override async stat(uri: string) {
        const stat = await super.stat(uri);
        if (uri === root) {
          this.rootStats += 1;
          if (this.rootStats === 1) {
            this.putSymbolicLink(ancestor);
          }
        }
        return stat;
      }
    }
    const port = new SwapAfterInitialChainPort();
    port.putDirectory(workspaceRoot);
    port.putDirectory(ancestor);
    port.putDirectory(root);
    port.putText(`${root}/index.md`, '---\nokf_version: "0.1"\n---\n# Bundle\n');
    const refused: string[] = [];

    const selection = await guardBundleWriteSelection(
      { bundleRootUri: root, workspaceSafetyRootUri: workspaceRoot },
      port,
      stringUriCodec,
      async (problem) => {
        refused.push(problem.code);
      },
    );

    expect(selection).toBeUndefined();
    expect(refused).toEqual(['unsafe-workspace-path']);
    expect(port.reads).toEqual([]);
  });

  it('distinguishes a missing root index from an invalid declaration', async () => {
    const root = 'memfs://workspace/not-a-bundle';
    const port = new FakeWorkspacePort();
    port.putDirectory(root);

    await expect(inspectExplicitBundleRoot(root, port, stringUriCodec)).resolves.toEqual({
      ok: true,
      indexUri: `${root}/index.md`,
      decision: { isBundleRoot: false, reason: 'missing-index' },
    });
    await expect(inspectBundleWriteAccess(root, port, stringUriCodec)).resolves.toEqual({
      ok: true,
      compatibility: 'undeclared',
    });
    await expect(inspectSelectedBundleRoot(root, port, stringUriCodec)).resolves.toEqual({
      ok: false,
      reason: 'missing-index',
    });

    port.putText(`${root}/index.md`, '# Ordinary directory index\n');
    await expect(inspectSelectedBundleRoot(root, port, stringUriCodec)).resolves.toEqual({
      ok: false,
      reason: 'missing-version',
    });
  });

  it('fails closed when an ancestor generation changes after a missing index stat', async () => {
    const workspaceRoot = 'memfs://workspace';
    const ancestor = `${workspaceRoot}/container`;
    const root = `${ancestor}/missing-index`;
    const indexUri = `${root}/index.md`;
    class MissingIndexGenerationSwapPort extends FakeWorkspacePort {
      ancestorGeneration = 0;

      override async stat(uri: string): Promise<WorkspaceStat | undefined> {
        if (uri === indexUri) {
          this.ancestorGeneration += 1;
          return undefined;
        }
        const stat = await super.stat(uri);
        if (uri !== ancestor || stat?.type !== 'directory') {
          return stat;
        }
        return {
          ...stat,
          ctime: this.ancestorGeneration,
          mtime: this.ancestorGeneration,
          readIdentity: {
            kind: 'trusted-provider',
            type: 'directory',
            size: 0,
            ctime: this.ancestorGeneration,
            mtime: this.ancestorGeneration,
          },
        };
      }
    }
    const port = new MissingIndexGenerationSwapPort();
    for (const directory of [workspaceRoot, ancestor, root]) {
      port.putDirectory(directory);
    }

    await expect(
      inspectExplicitBundleRoot(root, port, stringUriCodec, workspaceRoot),
    ).resolves.toEqual({
      ok: false,
      reason: 'invalid-root',
    });
    await expect(
      inspectBundleWriteAccess(root, port, stringUriCodec, workspaceRoot),
    ).resolves.toMatchObject({
      ok: false,
      problem: { code: 'bundle-write-root-revalidation-failed' },
    });
    expect(port.reads).toEqual([]);
  });

  it.each(['throw', 'return'] as const)(
    'fails closed when a directory generation changes during an index read that will %s',
    async (readOutcome) => {
      const workspaceRoot = 'memfs://workspace';
      const ancestor = `${workspaceRoot}/container`;
      const root = `${ancestor}/read-race-${readOutcome}`;
      const indexUri = `${root}/index.md`;
      class ReadGenerationSwapPort extends FakeWorkspacePort {
        ancestorGeneration = 0;
        readAttempts = 0;

        override async stat(uri: string): Promise<WorkspaceStat | undefined> {
          const stat = await super.stat(uri);
          if (uri !== ancestor || stat?.type !== 'directory') {
            return stat;
          }
          return {
            ...stat,
            ctime: this.ancestorGeneration,
            mtime: this.ancestorGeneration,
            readIdentity: {
              kind: 'trusted-provider',
              type: 'directory',
              size: 0,
              ctime: this.ancestorGeneration,
              mtime: this.ancestorGeneration,
            },
          };
        }

        override async read(uri: string): Promise<Uint8Array> {
          this.readAttempts += 1;
          if (uri === indexUri) {
            this.ancestorGeneration += 1;
            if (readOutcome === 'throw') {
              throw new Error('The provider read failed after rebinding the ancestor.');
            }
          }
          return super.read(uri);
        }
      }
      const port = new ReadGenerationSwapPort();
      for (const directory of [workspaceRoot, ancestor, root]) {
        port.putDirectory(directory);
      }
      port.putText(indexUri, '---\nokf_version: "0.1"\n---\n# Bundle\n');

      await expect(
        inspectExplicitBundleRoot(root, port, stringUriCodec, workspaceRoot),
      ).resolves.toEqual({
        ok: false,
        reason: 'invalid-root',
      });
      expect(port.readAttempts).toBe(1);
    },
  );

  it('accepts versionless and malformed roots only through explicit best-effort selection', async () => {
    const port = new FakeWorkspacePort();
    const versionless = 'memfs://workspace/versionless';
    const malformed = 'memfs://workspace/malformed';
    const nonString = 'memfs://workspace/non-string';
    const unreadable = 'memfs://workspace/unreadable';
    for (const root of [versionless, malformed, nonString, unreadable]) {
      port.putDirectory(root);
    }
    port.putText(`${versionless}/index.md`, '# Versionless knowledge\n');
    port.putText(`${malformed}/index.md`, '---\nokf_version: [\n---\n# Broken declaration\n');
    port.putText(`${nonString}/index.md`, '---\nokf_version: 1\n---\n# Invalid declaration\n');
    port.files.set(`${unreadable}/index.md`, Uint8Array.from([0xc3, 0x28]));

    expect(inspect(port.text(`${versionless}/index.md`) ?? '')).toEqual({
      isBundleRoot: false,
      reason: 'missing-version',
    });
    expect(inspect(port.text(`${malformed}/index.md`) ?? '')).toEqual({
      isBundleRoot: false,
      reason: 'invalid-index',
    });
    expect(inspect(port.text(`${nonString}/index.md`) ?? '')).toEqual({
      isBundleRoot: false,
      reason: 'invalid-version',
      declared: '1',
    });
    await expect(inspectExplicitBundleRoot(versionless, port, stringUriCodec)).resolves.toEqual({
      ok: true,
      indexUri: `${versionless}/index.md`,
      decision: { isBundleRoot: false, reason: 'missing-version' },
    });
    await expect(inspectExplicitBundleRoot(malformed, port, stringUriCodec)).resolves.toEqual({
      ok: true,
      indexUri: `${malformed}/index.md`,
      decision: { isBundleRoot: false, reason: 'invalid-index' },
    });
    await expect(inspectExplicitBundleRoot(nonString, port, stringUriCodec)).resolves.toEqual({
      ok: true,
      indexUri: `${nonString}/index.md`,
      decision: { isBundleRoot: false, reason: 'invalid-version', declared: '1' },
    });
    await expect(inspectExplicitBundleRoot(unreadable, port, stringUriCodec)).resolves.toEqual({
      ok: true,
      indexUri: `${unreadable}/index.md`,
      decision: { isBundleRoot: false, reason: 'unreadable-index' },
    });
    await expect(
      inspectBundleWriteAccess(versionless, port, stringUriCodec),
    ).resolves.toMatchObject({
      ok: true,
      compatibility: 'undeclared',
    });
    await expect(inspectBundleWriteAccess(malformed, port, stringUriCodec)).resolves.toMatchObject({
      ok: false,
      problem: { code: 'invalid-okf-version-write' },
    });
    await expect(inspectBundleWriteAccess(nonString, port, stringUriCodec)).resolves.toMatchObject({
      ok: false,
      problem: {
        code: 'invalid-okf-version-write',
        message: 'The selected bundle declares invalid OKF version 1.',
      },
    });
    await expect(inspectBundleWriteAccess(unreadable, port, stringUriCodec)).resolves.toMatchObject(
      {
        ok: false,
        problem: { code: 'bundle-write-root-revalidation-failed' },
      },
    );

    const parsed = parseBundle({
      rootUri: malformed,
      revision: 1,
      documents: [
        {
          uri: `${malformed}/index.md`,
          bundlePath: 'index.md',
          content: port.text(`${malformed}/index.md`) ?? '',
        },
        {
          uri: `${malformed}/readable-concept.md`,
          bundlePath: 'readable-concept.md',
          content:
            '---\ntype: reference\ntitle: Readable\ndescription: Still graphable\n---\n# Readable\n',
        },
      ],
    });
    const findings = validateBundle(parsed, { now: '2026-07-22T00:00:00Z' });
    expect(findings.map((finding) => finding.code)).toContain(VALIDATION_CODES.frontmatter);
    expect(buildGraphPayload({ ...parsed, findings }).nodes.map((node) => node.id)).toEqual([
      'readable-concept',
    ]);
    expect(port.writes).toEqual([]);
  });

  it('rejects a missing or non-directory explicit root without recreating it', async () => {
    const port = new FakeWorkspacePort();
    const missing = 'memfs://workspace/missing';
    const file = 'memfs://workspace/ordinary.md';
    const symlink = 'memfs://workspace/linked';
    port.putText(file, '# Not a directory\n');
    port.putSymbolicLink(symlink);

    for (const root of [missing, file, symlink]) {
      await expect(inspectExplicitBundleRoot(root, port, stringUriCodec)).resolves.toEqual({
        ok: false,
        reason: 'invalid-root',
      });
      await expect(inspectSelectedBundleRoot(root, port, stringUriCodec)).resolves.toEqual({
        ok: false,
        reason: 'invalid-root',
      });
      await expect(inspectBundleWriteAccess(root, port, stringUriCodec)).resolves.toMatchObject({
        ok: false,
        problem: { code: 'bundle-write-root-revalidation-failed' },
      });
    }
    expect(port.writes).toEqual([]);
  });

  it('keeps invalid declarations out of automatic discovery', async () => {
    const workspace = 'memfs://workspace';
    const port = new FakeWorkspacePort();
    port.putText(`${workspace}/valid/index.md`, '---\nokf_version: "0.1"\n---\n# Valid\n');
    port.putText(`${workspace}/versionless/index.md`, '# Versionless\n');
    port.putText(`${workspace}/non-string/index.md`, '---\nokf_version: 1\n---\n# Invalid\n');
    port.putText(
      `${workspace}/double-bom/index.md`,
      '\uFEFF\uFEFF---\nokf_version: "0.1"\n---\n# Invalid BOM\n',
    );
    const context = new BundleContextService(port, stringUriCodec, (inspection) =>
      inspectBundleRootIndex({
        rootUri: inspection.rootUri,
        indexUri: inspection.indexUri,
        text: inspection.text,
      }),
    );

    const discovery = await context.discover([workspace]);

    expect(discovery.candidates.map((candidate) => candidate.rootUriString)).toEqual([
      `${workspace}/valid`,
    ]);
  });
});
