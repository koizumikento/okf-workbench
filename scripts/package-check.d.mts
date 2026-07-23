export interface VsixValidationResult {
  readonly entryCount: number;
}

export const CANONICAL_PROJECT_LICENSE_TEXT: string;
export const PROJECT_LICENSE_ENTRY: 'extension/LICENSE.txt';
export const REQUIRED_VSIX_ENTRIES: readonly string[];

export function validateProjectLicense(input: Uint8Array): void;
export function validateVsixManifestProjectLicense(vsixManifest: string): void;
export function validateVsixArchive(
  input: Uint8Array,
  expectedProjectLicense: Uint8Array,
): VsixValidationResult;
export function validateVsixFile(
  filePath: string,
  projectLicensePath?: string,
): Promise<VsixValidationResult>;
