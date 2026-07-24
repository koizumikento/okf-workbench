export interface CliParityResult {
  readonly byteLength: number;
  readonly sha256: string;
  readonly targetPlatform: string;
}

export function verifyCliParity(cliPath: string, vsixPath: string): Promise<CliParityResult>;
