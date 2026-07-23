export const EXPECTED_CROSS_PLATFORM_ARTIFACT_LABELS: readonly [
  'okf-workbench-package-smoke-Linux-X64',
  'okf-workbench-package-smoke-Windows-X64',
  'okf-workbench-package-smoke-macOS-ARM64',
];

export const CROSS_PLATFORM_VSIX_FILENAME: 'okf-workbench.vsix';

export interface CrossPlatformVsixCandidate {
  readonly artifactLabel: (typeof EXPECTED_CROSS_PLATFORM_ARTIFACT_LABELS)[number];
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface CrossPlatformVsixResult {
  readonly candidates: readonly CrossPlatformVsixCandidate[];
  readonly sha256: string;
  readonly size: number;
}

export function verifyCrossPlatformVsix(rootDirectory: string): Promise<CrossPlatformVsixResult>;
