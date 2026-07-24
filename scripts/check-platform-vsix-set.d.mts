export interface PlatformVsixCandidate {
  readonly artifactLabel: string;
  readonly targetPlatform: string;
  readonly path: string;
  readonly wasmSha256: string;
  readonly cliSha256: string;
}

export const EXPECTED_PLATFORM_ARTIFACTS: readonly Readonly<{
  readonly artifactLabel: string;
  readonly targetPlatform: string;
}>[];

export function verifyPlatformVsixSet(rootDirectory: string): Promise<{
  readonly candidates: readonly PlatformVsixCandidate[];
  readonly wasmSha256: string;
}>;
