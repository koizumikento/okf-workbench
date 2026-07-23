export interface PerformanceReportCandidate {
  readonly manifestVersion?: string;
  readonly graphVersion?: string;
  readonly extensionHostBundleSha256?: string;
  readonly webviewJavaScriptBundleSha256?: string;
  readonly webviewCssBundleSha256?: string;
  readonly productionBundleSetSha256?: string;
  readonly productionRuntimeSnapshotSha256?: string;
  readonly inputIdentity?: Readonly<Record<string, string>>;
}

export interface PerformanceEvaluationReport {
  readonly authoritative: boolean;
  readonly capturedAt?: string;
  readonly qr002: Readonly<{ readonly status: string }>;
  readonly qr003: Readonly<{ readonly status: string }>;
  readonly security: Readonly<{ readonly status: string }>;
  readonly reasons: readonly string[];
  readonly [field: string]: unknown;
}

export declare function runBenchmarkReport(
  arguments_?: readonly string[],
): Promise<PerformanceEvaluationReport>;

export declare function createCurrentCandidate(
  currentInputs: unknown,
  fallbackPackageManifest?: unknown,
): PerformanceReportCandidate;

export declare function evaluateEvidence(
  value: unknown,
  candidate: PerformanceReportCandidate,
): PerformanceEvaluationReport;

export declare function isPassingReport(report: PerformanceEvaluationReport): boolean;

export declare function renderMarkdown(report: PerformanceEvaluationReport): string;
