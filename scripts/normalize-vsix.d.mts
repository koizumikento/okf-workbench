export const NORMALIZED_DOS_TIME: number;
export const NORMALIZED_DOS_DATE: number;
export const NORMALIZED_EXTERNAL_FILE_ATTRIBUTES: number;
export const NORMALIZED_EXECUTABLE_FILE_ATTRIBUTES: number;

export interface NormalizeVsixOptions {
  readonly executableEntries?: readonly string[];
}

export interface NormalizedVsix {
  readonly archive: Buffer;
  readonly changedEntryCount: number;
  readonly entryCount: number;
}

export interface NormalizedVsixFile {
  readonly changedEntryCount: number;
  readonly entryCount: number;
}

export function normalizeVsixTimestamps(
  input: Uint8Array,
  options?: NormalizeVsixOptions,
): NormalizedVsix;
export function normalizeVsixFile(
  filePath: string,
  options?: NormalizeVsixOptions,
): Promise<NormalizedVsixFile>;
