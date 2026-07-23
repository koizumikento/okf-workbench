export declare const PERFORMANCE_INPUT_SNAPSHOT_DOMAIN: string;

export interface PerformanceInputSnapshotEntry {
  readonly relativePath: string;
  readonly content: Uint8Array;
  readonly sha256: string;
}

export interface PerformanceInputSnapshot {
  readonly root: string;
  readonly files: readonly string[];
  readonly directories: readonly string[];
  readonly excludedFiles: readonly string[];
  readonly entries: readonly PerformanceInputSnapshotEntry[];
  readonly sha256: string;
}

export interface PerformanceInputSnapshotOptions {
  readonly files?: readonly string[];
  readonly directories?: readonly string[];
  readonly excludedFiles?: readonly string[];
}

export declare function captureInputSnapshot(
  root: string,
  options: PerformanceInputSnapshotOptions,
): Promise<PerformanceInputSnapshot>;

export declare function captureStableInputSnapshot(
  root: string,
  options: PerformanceInputSnapshotOptions,
  label?: string,
): Promise<PerformanceInputSnapshot>;

export declare function assertInputSnapshotUnchanged(
  snapshot: PerformanceInputSnapshot,
  root?: string,
  label?: string,
): Promise<void>;

export declare function materializeInputSnapshot(
  snapshot: PerformanceInputSnapshot,
  destinationRoot: string,
): Promise<void>;
