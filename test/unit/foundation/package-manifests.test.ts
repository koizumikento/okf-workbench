import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  renderPackageManifests,
  writePackageManifests,
} from '../../../scripts/generate-package-manifests.mjs';

const temporaryDirectories = new Set<string>();
const hashes = {
  macosArm64Sha256: 'a'.repeat(64),
  macosX64Sha256: 'b'.repeat(64),
  windowsX64Sha256: 'c'.repeat(64),
};

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true })),
  );
  temporaryDirectories.clear();
});

describe('package repository manifest generation', () => {
  test('renders Homebrew and Scoop manifests for the retained CLI archive names', () => {
    const result = renderPackageManifests({
      tag: 'v0.1.0',
      repository: 'koizumikento/okf-workbench',
      ...hashes,
    });

    expect(result.homebrew).toContain('class Okf < Formula');
    expect(result.homebrew).toContain('releases/download/v0.1.0/okf-cli-macos-aarch64.tar.gz');
    expect(result.homebrew).toContain('releases/download/v0.1.0/okf-cli-macos-x86_64.tar.gz');
    expect(result.homebrew).toContain(`sha256 "${hashes.macosArm64Sha256}"`);
    expect(result.homebrew).toContain(`sha256 "${hashes.macosX64Sha256}"`);
    expect(result.homebrew).toContain('shell_output("#{bin}/okf version")');

    const scoop = JSON.parse(result.scoop) as {
      readonly version: string;
      readonly architecture: {
        readonly '64bit': {
          readonly url: string;
          readonly hash: string;
          readonly extract_dir: string;
        };
      };
      readonly bin: string;
      readonly autoupdate: {
        readonly architecture: { readonly '64bit': { readonly url: string } };
      };
    };
    expect(scoop).toMatchObject({
      version: '0.1.0',
      architecture: {
        '64bit': {
          url: 'https://github.com/koizumikento/okf-workbench/releases/download/v0.1.0/okf-cli-windows-x86_64.tar.gz',
          hash: hashes.windowsX64Sha256,
          extract_dir: 'okf-cli-windows-x86_64',
        },
      },
      bin: 'okf.exe',
    });
    expect(scoop.autoupdate.architecture['64bit'].url).toContain('/releases/download/v$version/');
  });

  test('writes the two expected manifest files deterministically', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'okf-package-manifests-'));
    temporaryDirectories.add(directory);
    const options = {
      tag: 'v1.2.3-rc.1',
      repository: 'owner/repository',
      outputDirectory: directory,
      ...hashes,
    };

    const first = await writePackageManifests(options);
    const firstContents = await Promise.all([
      readFile(first.homebrewPath, 'utf8'),
      readFile(first.scoopPath, 'utf8'),
    ]);
    const second = await writePackageManifests(options);
    const secondContents = await Promise.all([
      readFile(second.homebrewPath, 'utf8'),
      readFile(second.scoopPath, 'utf8'),
    ]);

    expect(firstContents).toEqual(secondContents);
    expect(first.homebrewPath).toBe(join(directory, 'okf.rb'));
    expect(first.scoopPath).toBe(join(directory, 'okf.json'));
  });

  test.each([
    { tag: '0.1.0', repository: 'owner/repository', ...hashes },
    { tag: 'v01.0.0', repository: 'owner/repository', ...hashes },
    { tag: 'v0.1.0', repository: 'https://github.com/owner/repository', ...hashes },
    { tag: 'v0.1.0', repository: 'owner/repo/extra', ...hashes },
    {
      tag: 'v0.1.0',
      repository: 'owner/repository',
      ...hashes,
      windowsX64Sha256: 'A'.repeat(64),
    },
  ])('rejects unsafe or malformed inputs: %o', (options) => {
    expect(() => renderPackageManifests(options)).toThrow();
  });
});
