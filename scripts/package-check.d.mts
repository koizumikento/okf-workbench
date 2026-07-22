export interface VsixValidationResult {
  readonly entryCount: number;
}

export const REQUIRED_VSIX_ENTRIES: readonly string[];
export const OPTIONAL_VSIX_ENTRIES: readonly string[];

export function validateVsixArchive(input: Uint8Array): VsixValidationResult;
export function validateVsixFile(filePath: string): Promise<VsixValidationResult>;
