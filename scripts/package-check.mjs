import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const endSignature = 0x06054b50;
const centralSignature = 0x02014b50;
const localSignature = 0x04034b50;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const CANONICAL_PROJECT_LICENSE_TEXT = `MIT License

Copyright (c) 2026 straydog contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

export const PROJECT_LICENSE_ENTRY = 'extension/LICENSE.txt';

export const PUBLIC_MANIFEST_RESOURCES = Object.freeze({
  homepage: 'https://koizumikento.github.io/okf-workbench/',
  repository: Object.freeze({
    type: 'git',
    url: 'https://github.com/koizumikento/okf-workbench.git',
  }),
  bugs: Object.freeze({
    url: 'https://github.com/koizumikento/okf-workbench/issues',
  }),
});

export const VSIX_MARKETPLACE_LINKS = Object.freeze({
  Source: PUBLIC_MANIFEST_RESOURCES.repository.url,
  Getstarted: PUBLIC_MANIFEST_RESOURCES.repository.url,
  GitHub: PUBLIC_MANIFEST_RESOURCES.repository.url,
  Support: PUBLIC_MANIFEST_RESOURCES.bugs.url,
  Learn: PUBLIC_MANIFEST_RESOURCES.homepage,
});

export const REQUIRED_VSIX_ENTRIES = Object.freeze([
  '[Content_Types].xml',
  'extension.vsixmanifest',
  PROJECT_LICENSE_ENTRY,
  'extension/SECURITY.md',
  'extension/THIRD_PARTY_NOTICES.md',
  'extension/RUST_THIRD_PARTY_NOTICES.md',
  'extension/assets/icon.png',
  'extension/changelog.md',
  'extension/readme.md',
  'extension/dist/extension.cjs',
  'extension/dist/okf_core.wasm',
  'extension/dist/webview/main.css',
  'extension/dist/webview/main.js',
  'extension/package.json',
]);

const allowedEntries = new Set(REQUIRED_VSIX_ENTRIES);

export function validateProjectLicense(input) {
  if (!(input instanceof Uint8Array)) {
    throw new TypeError('validateProjectLicense expects the repository LICENSE bytes.');
  }
  if (!Buffer.from(input).equals(Buffer.from(CANONICAL_PROJECT_LICENSE_TEXT, 'utf8'))) {
    throw new Error(
      'The repository LICENSE must exactly match the canonical MIT License text and accepted copyright notice.',
    );
  }
}

export function validateVsixManifestProjectLicense(vsixManifest) {
  if (typeof vsixManifest !== 'string') {
    throw new TypeError('validateVsixManifestProjectLicense expects the VSIX manifest text.');
  }

  const projectLicenseDeclarations = [
    ...vsixManifest.matchAll(
      /<(?:[A-Za-z_][\w.-]*:)?License\b(?:[^>]*\/>|[^>]*>[^<]*<\/(?:[A-Za-z_][\w.-]*:)?License\s*>)/gu,
    ),
  ];
  if (
    projectLicenseDeclarations.length !== 1 ||
    projectLicenseDeclarations[0][0] !== '<License>extension/LICENSE.txt</License>'
  ) {
    throw new Error(
      'extension.vsixmanifest must contain exactly one canonical project-license declaration.',
    );
  }
}

export function validatePublicManifestResources(manifest) {
  if (typeof manifest !== 'object' || manifest === null) {
    throw new TypeError('validatePublicManifestResources expects a manifest object.');
  }
  const resources = {
    homepage: manifest.homepage,
    repository: manifest.repository,
    bugs: manifest.bugs,
  };
  if (JSON.stringify(resources) !== JSON.stringify(PUBLIC_MANIFEST_RESOURCES)) {
    throw new Error(
      'The extension manifest does not preserve the approved public homepage, repository, and issue-tracker URLs.',
    );
  }
}

export function validateVsixManifestMarketplaceLinks(vsixManifest) {
  if (typeof vsixManifest !== 'string') {
    throw new TypeError('validateVsixManifestMarketplaceLinks expects the VSIX manifest text.');
  }
  const marketplaceLinks = [
    ...vsixManifest.matchAll(
      /<Property\b[^>]*\bId="Microsoft\.VisualStudio\.Services\.Links\.([^"]+)"[^>]*\bValue="([^"]+)"[^>]*\/>/gu,
    ),
  ].map((match) => [match[1], match[2]]);
  const expected = Object.entries(VSIX_MARKETPLACE_LINKS);
  if (
    marketplaceLinks.length !== expected.length ||
    expected.some(
      ([expectedName, expectedValue]) =>
        marketplaceLinks.filter(
          ([actualName, actualValue]) =>
            actualName === expectedName && actualValue === expectedValue,
        ).length !== 1,
    )
  ) {
    throw new Error(
      'extension.vsixmanifest does not preserve the approved public marketplace resource links.',
    );
  }
}

function findEndRecord(archive) {
  if (archive.length < 22) {
    throw new Error('The VSIX is too short to contain a ZIP end record.');
  }
  const minimumEndOffset = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimumEndOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) !== endSignature) continue;
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === archive.length) return offset;
  }
  throw new Error('The VSIX does not contain a valid ZIP end record.');
}

export function validateVsixArchive(input, expectedProjectLicense) {
  if (!(input instanceof Uint8Array)) {
    throw new TypeError('validateVsixArchive expects a Uint8Array.');
  }
  if (!(expectedProjectLicense instanceof Uint8Array)) {
    throw new TypeError('validateVsixArchive expects the canonical project license bytes.');
  }
  validateProjectLicense(expectedProjectLicense);

  const archive = Buffer.from(input);
  const endOffset = findEndRecord(archive);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  let centralOffset = archive.readUInt32LE(endOffset + 16);
  const entries = new Map();

  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(centralOffset) !== centralSignature) {
      throw new Error(`Invalid central-directory entry at offset ${centralOffset}.`);
    }

    const compression = archive.readUInt16LE(centralOffset + 10);
    const compressedSize = archive.readUInt32LE(centralOffset + 20);
    const uncompressedSize = archive.readUInt32LE(centralOffset + 24);
    const fileNameLength = archive.readUInt16LE(centralOffset + 28);
    const extraLength = archive.readUInt16LE(centralOffset + 30);
    const commentLength = archive.readUInt16LE(centralOffset + 32);
    const localOffset = archive.readUInt32LE(centralOffset + 42);
    const name = archive
      .subarray(centralOffset + 46, centralOffset + 46 + fileNameLength)
      .toString('utf8');

    if (entries.has(name)) {
      throw new Error(`Duplicate VSIX entry is not allowed: ${name}`);
    }
    entries.set(name, { compression, compressedSize, localOffset, uncompressedSize });
    centralOffset += 46 + fileNameLength + extraLength + commentLength;
  }

  for (const file of REQUIRED_VSIX_ENTRIES) {
    if (!entries.has(file)) {
      throw new Error(`Required packaged file is missing: ${file}`);
    }
  }

  const unexpectedEntries = [...entries.keys()].filter((name) => !allowedEntries.has(name));
  if (unexpectedEntries.length > 0) {
    throw new Error(`Unexpected files entered the VSIX: ${unexpectedEntries.join(', ')}`);
  }

  function readEntry(name) {
    const entry = entries.get(name);
    if (entry === undefined) {
      throw new Error(`Unknown VSIX entry: ${name}`);
    }
    if (archive.readUInt32LE(entry.localOffset) !== localSignature) {
      throw new Error(`Invalid local ZIP entry for ${name}.`);
    }
    const fileNameLength = archive.readUInt16LE(entry.localOffset + 26);
    const extraLength = archive.readUInt16LE(entry.localOffset + 28);
    const dataOffset = entry.localOffset + 30 + fileNameLength + extraLength;
    const compressed = archive.subarray(dataOffset, dataOffset + entry.compressedSize);
    const content =
      entry.compression === 0
        ? compressed
        : entry.compression === 8
          ? inflateRawSync(compressed)
          : undefined;

    if (content === undefined) {
      throw new Error(`Unsupported ZIP compression method ${entry.compression} for ${name}.`);
    }
    if (content.length !== entry.uncompressedSize) {
      throw new Error(`Uncompressed size mismatch for ${name}.`);
    }
    return content;
  }

  const manifest = JSON.parse(readEntry('extension/package.json').toString('utf8'));
  if (
    manifest.name !== 'okf-workbench' ||
    manifest.publisher !== 'straydog' ||
    manifest.version !== '0.1.0' ||
    manifest.license !== 'MIT' ||
    manifest.icon !== 'assets/icon.png' ||
    manifest.main !== './dist/extension.cjs' ||
    manifest.engines?.vscode !== '^1.121.0'
  ) {
    throw new Error(
      'The packaged manifest does not preserve the accepted identity, MIT license, icon, entry point, and API floor.',
    );
  }
  validatePublicManifestResources(manifest);

  const wasm = readEntry('extension/dist/okf_core.wasm');
  if (
    wasm.length < 8 ||
    wasm[0] !== 0x00 ||
    wasm[1] !== 0x61 ||
    wasm[2] !== 0x73 ||
    wasm[3] !== 0x6d
  ) {
    throw new Error('The packaged OKF core is not a WebAssembly module.');
  }

  const packagedProjectLicense = readEntry(PROJECT_LICENSE_ENTRY);
  if (!packagedProjectLicense.equals(Buffer.from(expectedProjectLicense))) {
    throw new Error(
      `${PROJECT_LICENSE_ENTRY} does not exactly match the canonical repository LICENSE.`,
    );
  }

  const vsixManifest = readEntry('extension.vsixmanifest').toString('utf8');
  validateVsixManifestProjectLicense(vsixManifest);
  validateVsixManifestMarketplaceLinks(vsixManifest);
  const contentLicenseAssets = [
    ...vsixManifest.matchAll(
      /<Asset\b[^>]*\bType="Microsoft\.VisualStudio\.Services\.Content\.License"[^>]*\/>/gu,
    ),
  ];
  if (
    contentLicenseAssets.length !== 1 ||
    !/\bPath="extension\/LICENSE\.txt"/u.test(contentLicenseAssets[0][0]) ||
    !/\bAddressable="true"/u.test(contentLicenseAssets[0][0])
  ) {
    throw new Error(
      'extension.vsixmanifest must contain exactly one canonical addressable project-license asset.',
    );
  }
  for (const packagedDocument of ['extension/readme.md', 'extension/changelog.md']) {
    const content = readEntry(packagedDocument).toString('utf8');
    if (
      /\]\((?:\.\/)?docs\//iu.test(content) ||
      /github\.com\/koizumikento\/okf-workbench\/releases\/tag\/v0\.1\.0/iu.test(content)
    ) {
      throw new Error(
        `${packagedDocument} contains an excluded documentation or unpublished release link.`,
      );
    }
  }

  for (const webviewFile of ['extension/dist/webview/main.css', 'extension/dist/webview/main.js']) {
    const content = readEntry(webviewFile).toString('utf8');
    const remoteAssetPattern = webviewFile.endsWith('.css')
      ? /(?:@import\s+|url\(\s*)['"]?https?:\/\//u
      : /(?:fetch\s*\(|import\s*\(|\bfrom\s+|\bsrc\s*=\s*)['"]https?:\/\//u;
    if (remoteAssetPattern.test(content)) {
      throw new Error(`Remote runtime asset reference found in ${webviewFile}.`);
    }
  }

  return { entryCount: entries.size };
}

export async function validateVsixFile(
  filePath,
  projectLicensePath = resolve(repositoryRoot, 'LICENSE'),
) {
  const [archive, projectLicense] = await Promise.all([
    readFile(resolve(filePath)),
    readFile(resolve(projectLicensePath)),
  ]);
  return validateVsixArchive(archive, projectLicense);
}

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const vsixArgument = process.argv[2];
  if (vsixArgument === undefined || process.argv.length !== 3) {
    throw new Error('Usage: node scripts/package-check.mjs <path-to-vsix>');
  }
  const result = await validateVsixFile(vsixArgument);
  console.log(`Validated ${result.entryCount} VSIX entries in ${vsixArgument}.`);
}
