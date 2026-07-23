import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  CROSS_PLATFORM_VSIX_FILENAME,
  EXPECTED_CROSS_PLATFORM_ARTIFACT_LABELS,
  verifyCrossPlatformVsix,
} from '../../../scripts/check-cross-platform-vsix.mjs';

const temporaryDirectories = new Set<string>();

async function fixture(contents: readonly string[] = ['candidate', 'candidate', 'candidate']) {
  const root = await mkdtemp(join(tmpdir(), 'okf-cross-platform-vsix-'));
  temporaryDirectories.add(root);

  await Promise.all(
    EXPECTED_CROSS_PLATFORM_ARTIFACT_LABELS.map(async (artifactLabel, index) => {
      const directory = join(root, artifactLabel);
      await mkdir(directory);
      await Promise.all([
        writeFile(join(directory, 'build-metadata.json'), '{}'),
        writeFile(join(directory, CROSS_PLATFORM_VSIX_FILENAME), contents[index] ?? 'candidate'),
        writeFile(join(directory, 'runtime-licenses.json'), '[]'),
      ]);
    }),
  );
  return root;
}

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true })),
  );
  temporaryDirectories.clear();
});

describe('cross-platform VSIX byte identity', () => {
  test('accepts the real runner artifact layout with byte-identical packages', async () => {
    const root = await fixture();
    const result = await verifyCrossPlatformVsix(root);

    expect(result.candidates.map(({ artifactLabel }) => artifactLabel)).toEqual(
      EXPECTED_CROSS_PLATFORM_ARTIFACT_LABELS,
    );
    expect(result.candidates.map(({ path }) => [basename(dirname(path)), basename(path)])).toEqual(
      EXPECTED_CROSS_PLATFORM_ARTIFACT_LABELS.map((artifactLabel) => [
        artifactLabel,
        CROSS_PLATFORM_VSIX_FILENAME,
      ]),
    );
    expect(result.size).toBe(9);
    expect(result.sha256).toMatch(/^[a-f\d]{64}$/u);
  });

  test('rejects a digest mismatch with a labeled candidate inventory', async () => {
    const root = await fixture(['candidate', 'different', 'candidate']);

    await expect(verifyCrossPlatformVsix(root)).rejects.toThrow(
      new RegExp(
        `Cross-platform VSIX bytes differ:[\\s\\S]*${EXPECTED_CROSS_PLATFORM_ARTIFACT_LABELS[0]}:[\\s\\S]*${EXPECTED_CROSS_PLATFORM_ARTIFACT_LABELS[1]}:`,
        'u',
      ),
    );
  });

  test('rejects a missing runner artifact directory', async () => {
    const root = await fixture();
    const missingLabel = EXPECTED_CROSS_PLATFORM_ARTIFACT_LABELS[1];
    await rm(join(root, missingLabel), { recursive: true });

    await expect(verifyCrossPlatformVsix(root)).rejects.toThrow(
      new RegExp(`Missing artifact directories: ${missingLabel}`, 'u'),
    );
  });

  test('rejects an extra or unexpected runner artifact directory', async () => {
    const root = await fixture();
    const unexpectedLabel = 'okf-workbench-package-smoke-FreeBSD-X64';
    const unexpectedDirectory = join(root, unexpectedLabel);
    await mkdir(unexpectedDirectory);
    await writeFile(join(unexpectedDirectory, CROSS_PLATFORM_VSIX_FILENAME), 'candidate');

    await expect(verifyCrossPlatformVsix(root)).rejects.toThrow(
      new RegExp(`Unexpected root entries: [^\\n]*${unexpectedLabel}`, 'u'),
    );
  });

  test('rejects an unexpected regular file at the artifact root', async () => {
    const root = await fixture();
    const unexpectedFile = 'unexpected.txt';
    await writeFile(join(root, unexpectedFile), 'unexpected');

    await expect(verifyCrossPlatformVsix(root)).rejects.toThrow(
      new RegExp(`Unexpected root entries: [^\\n]*"${unexpectedFile}" \\[file\\]`, 'u'),
    );
  });

  test('rejects an expected runner label when it is a regular file', async () => {
    const root = await fixture();
    const artifactLabel = EXPECTED_CROSS_PLATFORM_ARTIFACT_LABELS[1];
    await rm(join(root, artifactLabel), { recursive: true });
    await writeFile(join(root, artifactLabel), 'not a directory');

    await expect(verifyCrossPlatformVsix(root)).rejects.toThrow(
      new RegExp(
        `Missing artifact directories: ${artifactLabel}[\\s\\S]*Unexpected root entries: [^\\n]*"${artifactLabel}" \\[file\\]`,
        'u',
      ),
    );
  });

  test('rejects an additional direct VSIX in a runner artifact directory', async () => {
    const root = await fixture();
    const artifactLabel = EXPECTED_CROSS_PLATFORM_ARTIFACT_LABELS[0];
    const additionalVsix = 'unexpected.vsix';
    await writeFile(join(root, artifactLabel, additionalVsix), 'candidate');

    await expect(verifyCrossPlatformVsix(root)).rejects.toThrow(
      new RegExp(
        `Artifact directory ${artifactLabel} is invalid[\\s\\S]*"${additionalVsix}" \\[file\\]`,
        'u',
      ),
    );
  });

  test('rejects a duplicate package hidden in a nested directory', async () => {
    const root = await fixture();
    const artifactLabel = EXPECTED_CROSS_PLATFORM_ARTIFACT_LABELS[0];
    const nestedDirectory = join(root, artifactLabel, 'duplicate');
    await mkdir(nestedDirectory);
    await writeFile(join(nestedDirectory, CROSS_PLATFORM_VSIX_FILENAME), 'candidate');

    await expect(verifyCrossPlatformVsix(root)).rejects.toThrow(
      new RegExp(
        `Artifact directory ${artifactLabel} is invalid[\\s\\S]*"duplicate" \\[directory\\]`,
        'u',
      ),
    );
  });

  test('rejects a nested-only spoof instead of treating it as the runner package', async () => {
    const root = await fixture();
    const artifactLabel = EXPECTED_CROSS_PLATFORM_ARTIFACT_LABELS[2];
    await rm(join(root, artifactLabel, CROSS_PLATFORM_VSIX_FILENAME));
    const nestedDirectory = join(root, artifactLabel, 'nested');
    await mkdir(nestedDirectory);
    await writeFile(join(nestedDirectory, CROSS_PLATFORM_VSIX_FILENAME), 'candidate');

    await expect(verifyCrossPlatformVsix(root)).rejects.toThrow(
      new RegExp(
        `Artifact directory ${artifactLabel} is invalid[\\s\\S]*Expected exactly one direct regular`,
        'u',
      ),
    );
  });
});
