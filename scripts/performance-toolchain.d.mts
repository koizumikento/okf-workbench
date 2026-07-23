import type { PerformanceInputSnapshot } from './performance-input-snapshot.mjs';

export declare const PERFORMANCE_TOOLCHAIN_MANIFEST_PATH: string;
export declare const HEADED_EXECUTION_SOURCE_PATHS: readonly string[];

export declare function discoverPortablePerformanceToolchainDirectories(
  repositoryRoot: string,
): Promise<readonly string[]>;
export declare function captureHeadedEvidenceExecutionSnapshot(
  repositoryRoot: string,
): Promise<PerformanceInputSnapshot>;
export declare function captureAuthorizedEsbuildPlatformSnapshot(
  repositoryRoot: string,
): Promise<PerformanceInputSnapshot>;
export declare function assertAuthorizedPortableEsbuildSnapshot(
  snapshot: PerformanceInputSnapshot,
): void;
export declare function readCurrentEsbuildPlatformPackage(repositoryRoot: string): Promise<{
  readonly key: string;
  readonly packagePath: string;
  readonly executableFiles: readonly string[];
  readonly files: Readonly<Record<string, string>>;
  readonly optionalPackages: readonly {
    readonly packagePath: string;
    readonly files: Readonly<Record<string, string>>;
  }[];
}>;
