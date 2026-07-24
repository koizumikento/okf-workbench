export interface VsixValidationResult {
  readonly entryCount: number;
  readonly targetPlatform?: string;
  readonly wasmSha256: string;
  readonly bundledCli?: {
    readonly byteLength: number;
    readonly executableEntry: string;
    readonly sha256: string;
  };
}

export const CANONICAL_PROJECT_LICENSE_TEXT: string;
export const PROJECT_LICENSE_ENTRY: 'extension/LICENSE.txt';
export const BUNDLED_CLI_MANIFEST_ENTRY: 'extension/dist/bundled-cli.json';
export const BUNDLED_CLI_EXECUTABLE_ENTRIES: readonly [
  'extension/dist/bin/okf',
  'extension/dist/bin/okf.exe',
];
export const PUBLIC_MANIFEST_RESOURCES: Readonly<{
  homepage: string;
  repository: Readonly<{ type: 'git'; url: string }>;
  bugs: Readonly<{ url: string }>;
}>;
export const VSIX_MARKETPLACE_LINKS: Readonly<Record<string, string>>;
export const REQUIRED_VSIX_ENTRIES: readonly string[];

export function validateProjectLicense(input: Uint8Array): void;
export function validatePublicManifestResources(manifest: object): void;
export function validateVsixManifestMarketplaceLinks(vsixManifest: string): void;
export function validateVsixManifestProjectLicense(vsixManifest: string): void;
export function extractTargetPlatform(vsixManifest: string): string | undefined;
export function validateVsixArchive(
  input: Uint8Array,
  expectedProjectLicense: Uint8Array,
): VsixValidationResult;
export function validateVsixFile(
  filePath: string,
  projectLicensePath?: string,
): Promise<VsixValidationResult>;
