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

  it('auto-detects semantic version strings but leaves invalid values to explicit selection', () => {
    expect(inspect('---\nokf_version: 1\n---\n# Index\n')).toEqual({
      isBundleRoot: false,
      reason: 'invalid-version',
      declared: '1',
    });
    expect(inspect('---\nokf_version: "0.2"\n---\n# Index\n')).toEqual({
      isBundleRoot: true,
      version: { declared: '"0.2"', compatibility: 'future-minor' },
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

  it('keeps unsupported major versions selectable for reads but fails closed for writes', async () => {
    const root = 'memfs://workspace/knowledge';
    const futureMinorRoot = 'memfs://workspace/future-minor';
    const port = new FakeWorkspacePort();
    port.putText(`${root}/index.md`, '---\nokf_version: "1.0"\n---\n# Future bundle\n');
    port.putText(
      `${futureMinorRoot}/index.md`,
      '---\nokf_version: "0.2"\n---\n# Future minor bundle\n',
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
          'The selected bundle declares unsupported OKF version "1.0"; OKF Workbench writes only OKF 0.1-compatible bundles.',
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
    port.putText(`${root}/index.md`, '---\nokf_version: "2.0"\n---\n# Future bundle\n');
    const refused: string[] = [];

    const selection = await guardBundleWriteSelection(
      { bundleRootUri: root, label: 'future' },
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

  it('distinguishes a missing root index from an invalid declaration', async () => {
    const root = 'memfs://workspace/not-a-bundle';
    const port = new FakeWorkspacePort();

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

  it('accepts versionless and malformed roots only through explicit best-effort selection', async () => {
    const port = new FakeWorkspacePort();
    const versionless = 'memfs://workspace/versionless';
    const malformed = 'memfs://workspace/malformed';
    const nonString = 'memfs://workspace/non-string';
    const unreadable = 'memfs://workspace/unreadable';
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

  it('keeps invalid declarations out of automatic discovery', async () => {
    const workspace = 'memfs://workspace';
    const port = new FakeWorkspacePort();
    port.putText(`${workspace}/valid/index.md`, '---\nokf_version: "0.1"\n---\n# Valid\n');
    port.putText(`${workspace}/versionless/index.md`, '# Versionless\n');
    port.putText(`${workspace}/non-string/index.md`, '---\nokf_version: 1\n---\n# Invalid\n');
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
