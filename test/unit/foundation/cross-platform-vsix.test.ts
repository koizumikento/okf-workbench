import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { verifyCrossPlatformVsix } from '../../../scripts/check-cross-platform-vsix.mjs';

const temporaryDirectories = new Set<string>();

async function fixture(contents: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'okf-cross-platform-vsix-'));
  temporaryDirectories.add(root);
  await Promise.all(
    contents.map(async (content, index) => {
      const directory = join(root, `runner-${String(index + 1)}`);
      await mkdir(directory);
      await writeFile(join(directory, 'okf-workbench.vsix'), content);
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
  test('accepts the required number of byte-identical artifacts', async () => {
    const root = await fixture(['candidate', 'candidate', 'candidate']);
    const result = await verifyCrossPlatformVsix(root, 3);

    expect(result.candidates).toHaveLength(3);
    expect(result.size).toBe(9);
    expect(result.sha256).toMatch(/^[a-f\d]{64}$/u);
  });

  test('rejects a digest mismatch and an incomplete artifact set', async () => {
    const mismatched = await fixture(['candidate', 'different', 'candidate']);
    await expect(verifyCrossPlatformVsix(mismatched, 3)).rejects.toThrow(
      /Cross-platform VSIX bytes differ/u,
    );

    const incomplete = await fixture(['candidate', 'candidate']);
    await expect(verifyCrossPlatformVsix(incomplete, 3)).rejects.toThrow(
      /Expected 3 cross-platform VSIX files/u,
    );
  });
});
