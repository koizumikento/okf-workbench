import type { PerformanceInputSnapshot } from './performance-input-snapshot.mjs';

export declare const CURRENT_PERFORMANCE_VSCODE_VERSION: '1.129.1';
export declare const PERFORMANCE_INPUT_IDENTITY_FIELDS: readonly string[];
export declare const HEADED_HARNESS_BUILD_CONFIGURATION_PATH: string;
export declare const DIAGNOSTICS_OBSERVER_PATH: string;

export interface HeadedHarnessCapture {
  readonly javascript: string;
  readonly bundleSha256: string;
  readonly definitionSha256: string;
  readonly inputSnapshot: PerformanceInputSnapshot;
}

export interface PerformanceInputIdentity {
  readonly productionRuntimeSnapshotSha256: string;
  readonly productionBuildInputSnapshotSha256: string;
  readonly diagnosticsObserverSnapshotSha256: string;
  readonly qr003HarnessInputSnapshotSha256: string;
  readonly qr003HarnessDefinitionSha256: string;
  readonly qr003HarnessBundleSha256: string;
}

export interface CurrentPerformanceInputs {
  readonly productionRuntimeSnapshot: PerformanceInputSnapshot;
  readonly productionBuildInputSnapshot: PerformanceInputSnapshot;
  readonly diagnosticsObserverSnapshot: PerformanceInputSnapshot;
  readonly headedHarness: HeadedHarnessCapture;
  readonly inputIdentity: PerformanceInputIdentity;
}

export declare function captureProductionRuntimeSnapshot(
  repositoryRoot: string,
): Promise<PerformanceInputSnapshot>;
export declare function captureProductionBuildInputSnapshot(
  repositoryRoot: string,
): Promise<PerformanceInputSnapshot>;
export declare function assertProductionBuildInputSnapshotUnchanged(
  snapshot: PerformanceInputSnapshot,
  repositoryRoot?: string,
  label?: string,
): Promise<void>;
export declare function captureDiagnosticsObserverSnapshot(
  repositoryRoot: string,
): Promise<PerformanceInputSnapshot>;
export declare function captureHeadedHarness(
  repositoryRoot: string,
  materializationRoot?: string,
): Promise<HeadedHarnessCapture>;
export declare function buildHeadedHarnessFromCapturedInputs(
  value: {
    readonly discoveredInputPaths: readonly string[];
    readonly inputSnapshot: PerformanceInputSnapshot;
  },
  materializationRoot: string,
): Promise<HeadedHarnessCapture>;
export declare function preparePrivatePerformanceMaterializationRoot(
  sourceRoot: string,
  materializationRoot: string,
): Promise<void>;
export declare function captureCurrentPerformanceInputs(
  repositoryRoot: string,
): Promise<CurrentPerformanceInputs>;
export declare function createPerformanceInputIdentity(value: {
  readonly productionRuntimeSnapshot: PerformanceInputSnapshot;
  readonly productionBuildInputSnapshot: PerformanceInputSnapshot;
  readonly diagnosticsObserverSnapshot: PerformanceInputSnapshot;
  readonly headedHarness: HeadedHarnessCapture;
}): PerformanceInputIdentity;
