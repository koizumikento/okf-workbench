import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const endSignature = 0x06054b50;
const centralSignature = 0x02014b50;
const localSignature = 0x04034b50;

export const REQUIRED_VSIX_ENTRIES = Object.freeze([
  '[Content_Types].xml',
  'extension.vsixmanifest',
  'extension/THIRD_PARTY_NOTICES.md',
  'extension/assets/icon.png',
  'extension/changelog.md',
  'extension/readme.md',
  'extension/dist/extension.cjs',
  'extension/dist/webview/main.css',
  'extension/dist/webview/main.js',
  'extension/package.json',
]);

// A future license decision may choose one of these conventional root names.
// The packaged security gate separately requires exactly one non-empty project license.
export const OPTIONAL_VSIX_ENTRIES = Object.freeze([
  'extension/LICENSE',
  'extension/LICENSE.md',
  'extension/LICENSE.txt',
]);

const allowedEntries = new Set([...REQUIRED_VSIX_ENTRIES, ...OPTIONAL_VSIX_ENTRIES]);

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

export function validateVsixArchive(input) {
  if (!(input instanceof Uint8Array)) {
    throw new TypeError('validateVsixArchive expects a Uint8Array.');
  }

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
    manifest.icon !== 'assets/icon.png' ||
    manifest.main !== './dist/extension.cjs' ||
    manifest.engines?.vscode !== '^1.121.0'
  ) {
    throw new Error(
      'The packaged manifest does not preserve the accepted identity, icon, entry point, and API floor.',
    );
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

export async function validateVsixFile(filePath) {
  return validateVsixArchive(await readFile(resolve(filePath)));
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
