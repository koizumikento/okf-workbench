import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, test } from 'vitest';

import { verifyCliParity } from '../../../scripts/check-cli-parity.mjs';
import {
  BUNDLED_CLI_MANIFEST_ENTRY,
  CANONICAL_PROJECT_LICENSE_TEXT,
  PROJECT_LICENSE_ENTRY,
  REQUIRED_VSIX_ENTRIES,
  validateProjectLicense,
  validateVsixArchive,
} from '../../../scripts/package-check.mjs';
import { NORMALIZED_EXECUTABLE_FILE_ATTRIBUTES } from '../../../scripts/normalize-vsix.mjs';

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

interface ZipEntry {
  readonly content: string | Uint8Array;
  readonly externalAttributes?: number;
  readonly name: string;
}

const PROJECT_LICENSE = CANONICAL_PROJECT_LICENSE_TEXT;
const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const securityCheckPath = fileURLToPath(
  new URL('../../../scripts/security-check.mjs', import.meta.url),
);
const PUNCTUATION_DRIFT = PROJECT_LICENSE.replace(
  'CLAIM, DAMAGES OR OTHER',
  'CLAIM, DAMAGES, OR OTHER',
)
  .replace('TORT OR OTHERWISE', 'TORT, OR OTHERWISE')
  .replace('OUT OF OR IN CONNECTION', 'OUT OF, OR IN CONNECTION');
function vsixManifest(targetPlatform?: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest>
  <Metadata>
    <Identity Language="en-US" Id="okf-workbench" Version="0.1.1" Publisher="straydog"${targetPlatform === undefined ? '' : ` TargetPlatform="${targetPlatform}"`} />
    <License>extension/LICENSE.txt</License>
    <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="https://github.com/koizumikento/okf-workbench.git" />
    <Property Id="Microsoft.VisualStudio.Services.Links.Getstarted" Value="https://github.com/koizumikento/okf-workbench.git" />
    <Property Id="Microsoft.VisualStudio.Services.Links.GitHub" Value="https://github.com/koizumikento/okf-workbench.git" />
    <Property Id="Microsoft.VisualStudio.Services.Links.Support" Value="https://github.com/koizumikento/okf-workbench/issues" />
    <Property Id="Microsoft.VisualStudio.Services.Links.Learn" Value="https://koizumikento.github.io/okf-workbench/" />
  </Metadata>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
  </Assets>
</PackageManifest>
`;
}
const VSIX_MANIFEST = vsixManifest();

function crc32(content: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(entries: readonly ZipEntry[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  const localOffsets: number[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const content = Buffer.from(entry.content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0x0021, 12);
    header.writeUInt32LE(crc32(content), 14);
    header.writeUInt32LE(content.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);

    localOffsets.push(localOffset);
    localChunks.push(header, name, content);
    localOffset += header.length + name.length + content.length;
  }

  const centralDirectoryOffset = localOffset;
  let centralOffset = centralDirectoryOffset;
  entries.forEach((entry, index) => {
    const name = Buffer.from(entry.name, 'utf8');
    const content =
      typeof entry.content === 'string'
        ? Buffer.from(entry.content, 'utf8')
        : Buffer.from(entry.content);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
    header.writeUInt16LE(0x031e, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0x0021, 14);
    header.writeUInt32LE(crc32(content), 16);
    header.writeUInt32LE(content.length, 20);
    header.writeUInt32LE(content.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(entry.externalAttributes ?? 0, 38);
    header.writeUInt32LE(localOffsets[index] ?? 0xffffffff, 42);

    centralChunks.push(header, name);
    centralOffset += header.length + name.length;
  });

  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralOffset - centralDirectoryOffset, 12);
  end.writeUInt32LE(centralDirectoryOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, ...centralChunks, end]);
}

function contentFor(name: string): string | Uint8Array {
  if (name === 'extension/dist/okf_core.wasm') {
    return Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  }
  if (name === 'extension/package.json') {
    return `${JSON.stringify({
      name: 'okf-workbench',
      publisher: 'straydog',
      version: '0.1.1',
      license: 'MIT',
      homepage: 'https://koizumikento.github.io/okf-workbench/',
      repository: {
        type: 'git',
        url: 'https://github.com/koizumikento/okf-workbench.git',
      },
      bugs: {
        url: 'https://github.com/koizumikento/okf-workbench/issues',
      },
      icon: 'assets/icon.png',
      main: './dist/extension.cjs',
      engines: { vscode: '^1.121.0' },
    })}\n`;
  }
  if (name === 'extension.vsixmanifest') return VSIX_MANIFEST;
  if (name === PROJECT_LICENSE_ENTRY) return PROJECT_LICENSE;
  if (name.endsWith('.js') || name.endsWith('.cjs')) return 'export {};\n';
  if (name.endsWith('.css')) return ':root {}\n';
  return `${name}\n`;
}

function packageEntries(): readonly ZipEntry[] {
  return REQUIRED_VSIX_ENTRIES.map((name) => ({ name, content: contentFor(name) }));
}

describe('canonical project license source gate', () => {
  test('accepts the exact repository LICENSE', async () => {
    const projectLicense = await readFile(new URL('../../../LICENSE', import.meta.url));

    expect(() => validateProjectLicense(projectLicense)).not.toThrow();
  });

  test.each([
    ['punctuation drift', PUNCTUATION_DRIFT],
    [
      'copyright drift',
      PROJECT_LICENSE.replace(
        'Copyright (c) 2026 straydog contributors',
        'Copyright (c) 2026 unknown contributors',
      ),
    ],
    ['non-MIT replacement', 'canonical MIT project license\n'],
  ])('rejects %s', (_name, projectLicense) => {
    expect(() => validateProjectLicense(Buffer.from(projectLicense))).toThrow(
      'The repository LICENSE must exactly match the canonical MIT License text and accepted copyright notice.',
    );
  });
});

describe('VSIX package closed-set validation', () => {
  test('accepts the complete reviewed package file set', () => {
    const result = validateVsixArchive(
      createStoredZip(packageEntries()),
      Buffer.from(PROJECT_LICENSE),
    );

    expect(result).toEqual({
      entryCount: REQUIRED_VSIX_ENTRIES.length,
      targetPlatform: undefined,
      bundledCli: undefined,
      wasmSha256: createHash('sha256')
        .update(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))
        .digest('hex'),
    });
  });

  test('accepts one target-matched bundled CLI with an exact hash and executable mode', () => {
    const executable = Buffer.from('native-okf-fixture');
    const cliManifest = {
      schemaVersion: 1,
      targetPlatform: 'darwin-arm64',
      executable: 'okf',
      byteLength: executable.byteLength,
      sha256: createHash('sha256').update(executable).digest('hex'),
      cliVersion: '0.1.1',
      coreVersion: '0.1.1',
      abiVersion: 1,
    };
    const entries = packageEntries().map((entry) =>
      entry.name === 'extension.vsixmanifest'
        ? { ...entry, content: vsixManifest('darwin-arm64') }
        : entry,
    );
    entries.push(
      { name: BUNDLED_CLI_MANIFEST_ENTRY, content: `${JSON.stringify(cliManifest)}\n` },
      {
        name: 'extension/dist/bin/okf',
        content: executable,
        externalAttributes: NORMALIZED_EXECUTABLE_FILE_ATTRIBUTES,
      },
    );

    expect(validateVsixArchive(createStoredZip(entries), Buffer.from(PROJECT_LICENSE))).toEqual({
      entryCount: REQUIRED_VSIX_ENTRIES.length + 2,
      targetPlatform: 'darwin-arm64',
      bundledCli: {
        byteLength: executable.byteLength,
        executableEntry: 'extension/dist/bin/okf',
        sha256: cliManifest.sha256,
      },
      wasmSha256: createHash('sha256')
        .update(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))
        .digest('hex'),
    });
  });

  test('proves standalone and bundled CLI byte parity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'okf-workbench-cli-parity-'));
    const executable = Buffer.from('same-native-okf-fixture');
    const cliPath = join(directory, 'okf');
    const vsixPath = join(directory, 'candidate.vsix');
    const cliManifest = {
      schemaVersion: 1,
      targetPlatform: 'darwin-arm64',
      executable: 'okf',
      byteLength: executable.byteLength,
      sha256: createHash('sha256').update(executable).digest('hex'),
      cliVersion: '0.1.1',
      coreVersion: '0.1.1',
      abiVersion: 1,
    };
    const entries = packageEntries().map((entry) =>
      entry.name === 'extension.vsixmanifest'
        ? { ...entry, content: vsixManifest('darwin-arm64') }
        : entry,
    );
    entries.push(
      { name: BUNDLED_CLI_MANIFEST_ENTRY, content: `${JSON.stringify(cliManifest)}\n` },
      {
        name: 'extension/dist/bin/okf',
        content: executable,
        externalAttributes: NORMALIZED_EXECUTABLE_FILE_ATTRIBUTES,
      },
    );
    await Promise.all([
      writeFile(cliPath, executable),
      writeFile(vsixPath, createStoredZip(entries)),
    ]);

    try {
      await expect(verifyCliParity(cliPath, vsixPath)).resolves.toEqual({
        byteLength: executable.byteLength,
        sha256: cliManifest.sha256,
        targetPlatform: 'darwin-arm64',
      });
      await writeFile(cliPath, 'different');
      await expect(verifyCliParity(cliPath, vsixPath)).rejects.toThrow(
        'Standalone and bundled CLI bytes differ',
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('rejects a native CLI in the universal fallback VSIX', () => {
    const entries = [
      ...packageEntries(),
      { name: 'extension/dist/bin/okf', content: 'unexpected native executable' },
    ];

    expect(() =>
      validateVsixArchive(createStoredZip(entries), Buffer.from(PROJECT_LICENSE)),
    ).toThrow('The universal VSIX must not contain a native CLI payload.');
  });

  test('rejects a packaged TypeScript semantic oracle', () => {
    const entries = packageEntries().map((entry) =>
      entry.name === 'extension/dist/extension.cjs'
        ? { ...entry, content: 'const version = "typescript-migration-oracle";\n' }
        : entry,
    );
    expect(() =>
      validateVsixArchive(createStoredZip(entries), Buffer.from(PROJECT_LICENSE)),
    ).toThrow('contains the TypeScript migration oracle');
  });

  test('rejects matching packaged and repository bytes when the source license is not canonical', () => {
    const entries = packageEntries().map((entry) =>
      entry.name === PROJECT_LICENSE_ENTRY ? { ...entry, content: PUNCTUATION_DRIFT } : entry,
    );

    expect(() =>
      validateVsixArchive(createStoredZip(entries), Buffer.from(PUNCTUATION_DRIFT)),
    ).toThrow(
      'The repository LICENSE must exactly match the canonical MIT License text and accepted copyright notice.',
    );
  });

  test('rejects a missing canonical project license', () => {
    const entries = packageEntries().filter(({ name }) => name !== PROJECT_LICENSE_ENTRY);

    expect(() =>
      validateVsixArchive(createStoredZip(entries), Buffer.from(PROJECT_LICENSE)),
    ).toThrow(`Required packaged file is missing: ${PROJECT_LICENSE_ENTRY}`);
  });

  test.each(['extension/LICENSE', 'extension/LICENSE.md', 'extension/LICENCE'])(
    'rejects alternate project license entry %s',
    (name) => {
      expect(() =>
        validateVsixArchive(
          createStoredZip([...packageEntries(), { name, content: PROJECT_LICENSE }]),
          Buffer.from(PROJECT_LICENSE),
        ),
      ).toThrow(`Unexpected files entered the VSIX: ${name}`);
    },
  );

  test('rejects a packaged project license that differs from the repository license', () => {
    const entries = packageEntries().map((entry) =>
      entry.name === PROJECT_LICENSE_ENTRY
        ? { ...entry, content: 'different license text\n' }
        : entry,
    );

    expect(() =>
      validateVsixArchive(createStoredZip(entries), Buffer.from(PROJECT_LICENSE)),
    ).toThrow('extension/LICENSE.txt does not exactly match the canonical repository LICENSE.');
  });

  test.each([undefined, 'UNLICENSED', 'MIT-0'])(
    'rejects packaged manifest license %s instead of exact MIT',
    (license) => {
      const entries = packageEntries().map((entry) => {
        if (entry.name !== 'extension/package.json') return entry;
        if (typeof entry.content !== 'string') throw new Error('Expected manifest text.');
        const manifest = JSON.parse(entry.content) as Record<string, unknown>;
        if (license === undefined) delete manifest.license;
        else manifest.license = license;
        return { ...entry, content: `${JSON.stringify(manifest)}\n` };
      });

      expect(() =>
        validateVsixArchive(createStoredZip(entries), Buffer.from(PROJECT_LICENSE)),
      ).toThrow(
        'The packaged manifest does not preserve the accepted identity, MIT license, icon, entry point, and API floor.',
      );
    },
  );

  test.each([
    ['repository', { type: 'git', url: 'https://example.com/alternate.git' }],
    ['bugs', { url: 'https://example.com/issues' }],
    ['homepage', 'https://github.com/koizumikento/okf-workbench#readme'],
  ])('rejects alternate packaged public-resource field %s', (field, value) => {
    const entries = packageEntries().map((entry) => {
      if (entry.name !== 'extension/package.json') return entry;
      if (typeof entry.content !== 'string') throw new Error('Expected manifest text.');
      const manifest = JSON.parse(entry.content) as Record<string, unknown>;
      manifest[field] = value;
      return { ...entry, content: `${JSON.stringify(manifest)}\n` };
    });

    expect(() =>
      validateVsixArchive(createStoredZip(entries), Buffer.from(PROJECT_LICENSE)),
    ).toThrow(
      'The extension manifest does not preserve the approved public homepage, repository, and issue-tracker URLs.',
    );
  });

  test.each([
    ['extension/readme.md', '[Internal docs](docs/index.md)'],
    [
      'extension/changelog.md',
      '[release](https://github.com/koizumikento/okf-workbench/releases/tag/v0.1.0)',
    ],
  ])('rejects a private or excluded link in %s', (document, content) => {
    const entries = packageEntries().map((entry) =>
      entry.name === document ? { ...entry, content } : entry,
    );

    expect(() =>
      validateVsixArchive(createStoredZip(entries), Buffer.from(PROJECT_LICENSE)),
    ).toThrow(`${document} contains an excluded documentation or unpublished release link.`);
  });

  test.each([
    [
      'alternate license declaration',
      VSIX_MANIFEST.replace(
        '<License>extension/LICENSE.txt</License>',
        '<License>extension/LICENSE</License>',
      ),
      'extension.vsixmanifest must contain exactly one canonical project-license declaration.',
    ],
    [
      'missing license asset',
      VSIX_MANIFEST.replace(
        '<Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />',
        '',
      ),
      'extension.vsixmanifest must contain exactly one canonical addressable project-license asset.',
    ],
    [
      'alternate license asset path',
      VSIX_MANIFEST.replace('Path="extension/LICENSE.txt"', 'Path="extension/LICENSE.md"'),
      'extension.vsixmanifest must contain exactly one canonical addressable project-license asset.',
    ],
    [
      'duplicate license declaration',
      VSIX_MANIFEST.replace('</Metadata>', '<License>extension/LICENSE.txt</License></Metadata>'),
      'extension.vsixmanifest must contain exactly one canonical project-license declaration.',
    ],
    [
      'canonical and alternate license declarations',
      VSIX_MANIFEST.replace('</Metadata>', '<License>extension/LICENSE.md</License></Metadata>'),
      'extension.vsixmanifest must contain exactly one canonical project-license declaration.',
    ],
    [
      'canonical and namespace-prefixed alternate license declarations',
      VSIX_MANIFEST.replace(
        '</Metadata>',
        '<vsx:License>extension/LICENSE.md</vsx:License></Metadata>',
      ),
      'extension.vsixmanifest must contain exactly one canonical project-license declaration.',
    ],
    [
      'alternate marketplace link',
      VSIX_MANIFEST.replace(
        'Value="https://github.com/koizumikento/okf-workbench/issues"',
        'Value="https://example.com/issues"',
      ),
      'extension.vsixmanifest does not preserve the approved public marketplace resource links.',
    ],
  ])('rejects VSIX manifest mutation: %s', (_name, content, message) => {
    const entries = packageEntries().map((entry) =>
      entry.name === 'extension.vsixmanifest' ? { ...entry, content } : entry,
    );

    expect(() =>
      validateVsixArchive(createStoredZip(entries), Buffer.from(PROJECT_LICENSE)),
    ).toThrow(message);
  });

  test('makes the packaged security gate reject canonical and alternate license declarations together', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'okf-workbench-license-gate-'));
    const vsixPath = join(directory, 'canonical-plus-alternate.vsix');
    const entries = packageEntries().map((entry) =>
      entry.name === 'extension.vsixmanifest'
        ? {
            ...entry,
            content: VSIX_MANIFEST.replace(
              '</Metadata>',
              '<License>extension/LICENSE.md</License></Metadata>',
            ),
          }
        : entry,
    );
    await writeFile(vsixPath, createStoredZip(entries));

    try {
      await expect(
        execFileAsync(process.execPath, [securityCheckPath, '--vsix', vsixPath], {
          cwd: repositoryRoot,
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          'extension.vsixmanifest must contain exactly one canonical project-license declaration.',
        ),
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('rejects a duplicate canonical project license entry', () => {
    expect(() =>
      validateVsixArchive(
        createStoredZip([
          ...packageEntries(),
          { name: PROJECT_LICENSE_ENTRY, content: PROJECT_LICENSE },
        ]),
        Buffer.from(PROJECT_LICENSE),
      ),
    ).toThrow(`Duplicate VSIX entry is not allowed: ${PROJECT_LICENSE_ENTRY}`);
  });

  test('rejects an injected file outside the reviewed package file set', () => {
    const archive = createStoredZip([
      ...packageEntries(),
      {
        name: 'extension/internal-release-notes.txt',
        content: 'must not be published\n',
      },
    ]);

    expect(() => validateVsixArchive(archive, Buffer.from(PROJECT_LICENSE))).toThrow(
      'Unexpected files entered the VSIX: extension/internal-release-notes.txt',
    );
  });
});
