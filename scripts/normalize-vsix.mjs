import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const MINIMUM_END_RECORD_SIZE = 22;
const MAXIMUM_ZIP_COMMENT_SIZE = 65_535;

// ZIP timestamps use local-time MS-DOS fields. Use the earliest representable
// value so the archive is independent of the build clock and time zone.
export const NORMALIZED_DOS_TIME = 0x0000;
export const NORMALIZED_DOS_DATE = 0x0021;

const TIMESTAMP_EXTRA_FIELD_IDS = new Set([
  0x000a, // NTFS timestamps
  0x000d, // PKWARE Unix timestamps
  0x5455, // Extended timestamp
  0x5855, // Info-ZIP Unix timestamp
]);

function assertRange(archive, offset, length, description) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > archive.length
  ) {
    throw new Error(`Invalid ${description} range in the VSIX ZIP archive.`);
  }
}

function findEndRecord(archive) {
  if (archive.length < MINIMUM_END_RECORD_SIZE) {
    throw new Error('The VSIX is too short to contain a ZIP end record.');
  }

  const minimumOffset = Math.max(
    0,
    archive.length - MINIMUM_END_RECORD_SIZE - MAXIMUM_ZIP_COMMENT_SIZE,
  );

  for (
    let offset = archive.length - MINIMUM_END_RECORD_SIZE;
    offset >= minimumOffset;
    offset -= 1
  ) {
    if (archive.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      continue;
    }

    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + MINIMUM_END_RECORD_SIZE + commentLength === archive.length) {
      return offset;
    }
  }

  throw new Error('The VSIX does not contain a valid ZIP end record.');
}

function rejectTimestampExtraFields(archive, offset, length, description) {
  const end = offset + length;
  assertRange(archive, offset, length, `${description} extra field`);

  for (let cursor = offset; cursor < end;) {
    assertRange(archive, cursor, 4, `${description} extra-field header`);
    const fieldId = archive.readUInt16LE(cursor);
    const fieldSize = archive.readUInt16LE(cursor + 2);
    const dataOffset = cursor + 4;
    assertRange(archive, dataOffset, fieldSize, `${description} extra-field data`);
    if (dataOffset + fieldSize > end) {
      throw new Error(`Invalid ${description} extra-field length in the VSIX ZIP archive.`);
    }

    if (TIMESTAMP_EXTRA_FIELD_IDS.has(fieldId)) {
      throw new Error(
        `The VSIX contains timestamp extra field 0x${fieldId.toString(16).padStart(4, '0')} in ${description}; refusing to claim deterministic normalization.`,
      );
    }

    cursor = dataOffset + fieldSize;
  }
}

/**
 * Return a copy of a VSIX with every ZIP local-header and central-directory
 * MS-DOS timestamp normalized. Entry contents, CRCs, compression, ordering,
 * attributes, and comments are left byte-for-byte unchanged.
 *
 * ZIP64 and split archives are intentionally rejected because @vscode/vsce
 * 3.9.2 does not emit them for this extension and silently mishandling either
 * format would undermine the reproducibility guarantee.
 */
export function normalizeVsixTimestamps(input) {
  if (!(input instanceof Uint8Array)) {
    throw new TypeError('normalizeVsixTimestamps expects a Uint8Array.');
  }

  const archive = Buffer.from(input);
  const endOffset = findEndRecord(archive);
  const diskNumber = archive.readUInt16LE(endOffset + 4);
  const centralDirectoryDisk = archive.readUInt16LE(endOffset + 6);
  const entriesOnDisk = archive.readUInt16LE(endOffset + 8);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralDirectorySize = archive.readUInt32LE(endOffset + 12);
  const centralDirectoryOffset = archive.readUInt32LE(endOffset + 16);

  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw new Error('Split and ZIP64 VSIX archives are not supported by the timestamp normalizer.');
  }

  if (centralDirectoryOffset + centralDirectorySize !== endOffset) {
    throw new Error('The VSIX central-directory bounds do not match its ZIP end record.');
  }

  const localOffsets = new Set();
  let centralOffset = centralDirectoryOffset;
  let changedEntryCount = 0;

  for (let index = 0; index < entryCount; index += 1) {
    assertRange(archive, centralOffset, 46, `central-directory entry ${index + 1}`);
    if (archive.readUInt32LE(centralOffset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error(`Invalid central-directory entry at offset ${centralOffset}.`);
    }

    const compressedSize = archive.readUInt32LE(centralOffset + 20);
    const uncompressedSize = archive.readUInt32LE(centralOffset + 24);
    const fileNameLength = archive.readUInt16LE(centralOffset + 28);
    const extraLength = archive.readUInt16LE(centralOffset + 30);
    const commentLength = archive.readUInt16LE(centralOffset + 32);
    const startingDisk = archive.readUInt16LE(centralOffset + 34);
    const localOffset = archive.readUInt32LE(centralOffset + 42);
    const variableLength = fileNameLength + extraLength + commentLength;

    assertRange(
      archive,
      centralOffset + 46,
      variableLength,
      `central-directory entry ${index + 1} data`,
    );
    if (
      startingDisk !== 0 ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw new Error('ZIP64 or split VSIX entries are not supported by the timestamp normalizer.');
    }
    if (localOffsets.has(localOffset)) {
      throw new Error(`Duplicate local ZIP header offset ${localOffset}.`);
    }
    localOffsets.add(localOffset);

    const centralName = archive.subarray(centralOffset + 46, centralOffset + 46 + fileNameLength);
    rejectTimestampExtraFields(
      archive,
      centralOffset + 46 + fileNameLength,
      extraLength,
      `central-directory entry ${index + 1}`,
    );

    assertRange(archive, localOffset, 30, `local ZIP header for entry ${index + 1}`);
    if (archive.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
      throw new Error(`Invalid local ZIP header at offset ${localOffset}.`);
    }

    const localFileNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const localVariableLength = localFileNameLength + localExtraLength;
    assertRange(
      archive,
      localOffset + 30,
      localVariableLength,
      `local ZIP header ${index + 1} data`,
    );

    const localName = archive.subarray(localOffset + 30, localOffset + 30 + localFileNameLength);
    if (!centralName.equals(localName)) {
      throw new Error(`Local and central ZIP entry names differ for entry ${index + 1}.`);
    }
    rejectTimestampExtraFields(
      archive,
      localOffset + 30 + localFileNameLength,
      localExtraLength,
      `local ZIP header ${index + 1}`,
    );

    const dataOffset = localOffset + 30 + localVariableLength;
    if (dataOffset + compressedSize > centralDirectoryOffset) {
      throw new Error(`Compressed data for ZIP entry ${index + 1} overlaps the central directory.`);
    }

    const changed =
      archive.readUInt16LE(localOffset + 10) !== NORMALIZED_DOS_TIME ||
      archive.readUInt16LE(localOffset + 12) !== NORMALIZED_DOS_DATE ||
      archive.readUInt16LE(centralOffset + 12) !== NORMALIZED_DOS_TIME ||
      archive.readUInt16LE(centralOffset + 14) !== NORMALIZED_DOS_DATE;

    archive.writeUInt16LE(NORMALIZED_DOS_TIME, localOffset + 10);
    archive.writeUInt16LE(NORMALIZED_DOS_DATE, localOffset + 12);
    archive.writeUInt16LE(NORMALIZED_DOS_TIME, centralOffset + 12);
    archive.writeUInt16LE(NORMALIZED_DOS_DATE, centralOffset + 14);
    if (changed) {
      changedEntryCount += 1;
    }

    centralOffset += 46 + variableLength;
  }

  if (centralOffset !== endOffset) {
    throw new Error('The parsed central-directory length does not match the ZIP end record.');
  }

  return { archive, changedEntryCount, entryCount };
}

export async function normalizeVsixFile(filePath) {
  const absolutePath = resolve(filePath);
  const input = await readFile(absolutePath);
  const result = normalizeVsixTimestamps(input);
  const metadata = await stat(absolutePath);
  const temporaryPath = `${absolutePath}.normalize-${process.pid}-${randomUUID()}.tmp`;
  let temporaryFile;

  try {
    temporaryFile = await open(temporaryPath, 'wx', metadata.mode);
    await temporaryFile.writeFile(result.archive);
    await temporaryFile.chmod(metadata.mode);
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
    await rename(temporaryPath, absolutePath);
  } finally {
    await temporaryFile?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }

  return { changedEntryCount: result.changedEntryCount, entryCount: result.entryCount };
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  const filePath = process.argv[2];
  if (filePath === undefined || process.argv.length !== 3) {
    throw new Error('Usage: node scripts/normalize-vsix.mjs <path-to-vsix>');
  }

  const result = await normalizeVsixFile(filePath);
  console.log(
    `Normalized ZIP timestamps for ${result.entryCount} VSIX entries (${result.changedEntryCount} changed).`,
  );
}
