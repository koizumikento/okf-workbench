import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

import {
  NORMALIZED_DOS_DATE,
  NORMALIZED_DOS_TIME,
  NORMALIZED_EXTERNAL_FILE_ATTRIBUTES,
  normalizeVsixTimestamps,
} from '../../../scripts/normalize-vsix.mjs';

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

interface ZipEntry {
  readonly content: string;
  readonly name: string;
}

interface ZipFixture {
  readonly archive: Buffer;
  readonly centralOffsets: readonly number[];
  readonly localOffsets: readonly number[];
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

function createZipFixture(
  entries: readonly ZipEntry[],
  dosTime: number,
  dosDate: number,
  extraField = Buffer.alloc(0),
  externalAttributes = 0,
): ZipFixture {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  const localOffsets: number[] = [];
  const centralOffsets: number[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const content = Buffer.from(entry.content, 'utf8');
    const checksum = crc32(content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(dosTime, 10);
    header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(content.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(extraField.length, 28);

    localOffsets.push(localOffset);
    localChunks.push(header, name, extraField, content);
    localOffset += header.length + name.length + extraField.length + content.length;
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
    header.writeUInt16LE(dosTime, 12);
    header.writeUInt16LE(dosDate, 14);
    header.writeUInt32LE(crc32(content), 16);
    header.writeUInt32LE(content.length, 20);
    header.writeUInt32LE(content.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(extraField.length, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(externalAttributes, 38);
    header.writeUInt32LE(localOffsets[index] ?? 0xffffffff, 42);

    centralOffsets.push(centralOffset);
    centralChunks.push(header, name, extraField);
    centralOffset += header.length + name.length + extraField.length;
  });

  const centralDirectorySize = centralOffset - centralDirectoryOffset;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectorySize, 12);
  end.writeUInt32LE(centralDirectoryOffset, 16);
  end.writeUInt16LE(0, 20);

  return {
    archive: Buffer.concat([...localChunks, ...centralChunks, end]),
    centralOffsets,
    localOffsets,
  };
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('VSIX archive metadata normalization', () => {
  const entries = [
    { name: 'extension/package.json', content: '{"name":"okf-workbench"}\n' },
    { name: 'extension/dist/extension.cjs', content: 'module.exports = {};\n' },
  ] as const;

  test('makes archives that differ by ZIP timestamps and host file modes byte-identical', () => {
    const first = createZipFixture(entries, 0x6f25, 0x5cf6, Buffer.alloc(0), 0x81a40000);
    const second = createZipFixture(entries, 0x6fd2, 0x5cf6, Buffer.alloc(0), 0x81b60000);

    expect(sha256(first.archive)).not.toBe(sha256(second.archive));

    const normalizedFirst = normalizeVsixTimestamps(first.archive);
    const normalizedSecond = normalizeVsixTimestamps(second.archive);

    expect(normalizedFirst.entryCount).toBe(entries.length);
    expect(normalizedFirst.changedEntryCount).toBe(entries.length);
    expect(normalizedFirst.archive).toEqual(normalizedSecond.archive);
    expect(sha256(normalizedFirst.archive)).toBe(sha256(normalizedSecond.archive));

    for (const offset of first.localOffsets) {
      expect(normalizedFirst.archive.readUInt16LE(offset + 10)).toBe(NORMALIZED_DOS_TIME);
      expect(normalizedFirst.archive.readUInt16LE(offset + 12)).toBe(NORMALIZED_DOS_DATE);
    }
    for (const offset of first.centralOffsets) {
      expect(normalizedFirst.archive.readUInt16LE(offset + 12)).toBe(NORMALIZED_DOS_TIME);
      expect(normalizedFirst.archive.readUInt16LE(offset + 14)).toBe(NORMALIZED_DOS_DATE);
      expect(normalizedFirst.archive.readUInt32LE(offset + 38)).toBe(
        NORMALIZED_EXTERNAL_FILE_ATTRIBUTES,
      );
    }
  });

  test('changes no non-metadata byte and is idempotent', () => {
    const fixture = createZipFixture(entries, 0x6f25, 0x5cf6);
    const normalized = normalizeVsixTimestamps(fixture.archive);
    const metadataBytes = new Set<number>();

    for (const offset of fixture.localOffsets) {
      for (let byte = offset + 10; byte < offset + 14; byte += 1) metadataBytes.add(byte);
    }
    for (const offset of fixture.centralOffsets) {
      for (let byte = offset + 12; byte < offset + 16; byte += 1) metadataBytes.add(byte);
      for (let byte = offset + 38; byte < offset + 42; byte += 1) metadataBytes.add(byte);
    }
    fixture.archive.forEach((value, offset) => {
      if (!metadataBytes.has(offset)) {
        expect(normalized.archive[offset]).toBe(value);
      }
    });

    const normalizedAgain = normalizeVsixTimestamps(normalized.archive);
    expect(normalizedAgain.changedEntryCount).toBe(0);
    expect(normalizedAgain.archive).toEqual(normalized.archive);
  });

  test.each([0x000a, 0x000d, 0x5455, 0x5855])(
    'fails closed for timestamp-bearing ZIP extra field 0x%s',
    (fieldId) => {
      const timestampField = Buffer.alloc(8);
      timestampField.writeUInt16LE(fieldId, 0);
      timestampField.writeUInt16LE(4, 2);
      timestampField.writeUInt32LE(1_785_004_800, 4);
      const fixture = createZipFixture(entries, 0x6f25, 0x5cf6, timestampField);

      expect(() => normalizeVsixTimestamps(fixture.archive)).toThrow(
        new RegExp(`timestamp extra field 0x${fieldId.toString(16).padStart(4, '0')}`, 'u'),
      );
    },
  );

  test('rejects malformed input without treating signature-like content as an end record', () => {
    expect(() => normalizeVsixTimestamps(Buffer.from('not a VSIX'))).toThrow(
      /too short to contain a ZIP end record/u,
    );
  });

  test('is wired through the deterministic VSCE wrapper in the package command', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { readonly scripts?: { readonly package?: unknown } };

    expect(manifest.scripts?.package).toBe(
      'npm run build && node scripts/package-vsix.mjs artifacts/okf-workbench.vsix',
    );
  });
});
