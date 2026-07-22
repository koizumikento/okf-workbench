import { describe, expect, test } from 'vitest';

import { REQUIRED_VSIX_ENTRIES, validateVsixArchive } from '../../../scripts/package-check.mjs';

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

interface ZipEntry {
  readonly content: string;
  readonly name: string;
}

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
    const content = Buffer.from(entry.content, 'utf8');
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
    const content = Buffer.from(entry.content, 'utf8');
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
    header.writeUInt32LE(0, 38);
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

function contentFor(name: string): string {
  if (name === 'extension/package.json') {
    return `${JSON.stringify({
      name: 'okf-workbench',
      publisher: 'straydog',
      version: '0.1.0',
      icon: 'assets/icon.png',
      main: './dist/extension.cjs',
      engines: { vscode: '^1.121.0' },
    })}\n`;
  }
  if (name.endsWith('.js') || name.endsWith('.cjs')) return 'export {};\n';
  if (name.endsWith('.css')) return ':root {}\n';
  return `${name}\n`;
}

function packageEntries(): readonly ZipEntry[] {
  return REQUIRED_VSIX_ENTRIES.map((name) => ({ name, content: contentFor(name) }));
}

describe('VSIX package closed-set validation', () => {
  test('accepts the complete reviewed package file set', () => {
    const result = validateVsixArchive(createStoredZip(packageEntries()));

    expect(result).toEqual({ entryCount: REQUIRED_VSIX_ENTRIES.length });
  });

  test('rejects an injected file outside the reviewed package file set', () => {
    const archive = createStoredZip([
      ...packageEntries(),
      {
        name: 'extension/internal-release-notes.txt',
        content: 'must not be published\n',
      },
    ]);

    expect(() => validateVsixArchive(archive)).toThrow(
      'Unexpected files entered the VSIX: extension/internal-release-notes.txt',
    );
  });
});
