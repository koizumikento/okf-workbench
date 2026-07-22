export interface CrossPlatformVsixCandidate {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface CrossPlatformVsixResult {
  readonly candidates: readonly CrossPlatformVsixCandidate[];
  readonly sha256: string;
  readonly size: number;
}

export function verifyCrossPlatformVsix(
  rootDirectory: string,
  expectedCount?: number,
): Promise<CrossPlatformVsixResult>;
