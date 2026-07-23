export interface PerformanceEvidencePublicationOptions {
  readonly repositoryRoot: string;
  readonly outputPath: string;
  readonly evidenceBytes: string | Uint8Array;
  readonly reportBytes: string | Uint8Array;
  readonly verify?: () => void | Promise<void>;
}

export declare function withPerformanceDeadline<T>(
  operation: PromiseLike<T> | T,
  timeoutMs: number,
  label: string,
): Promise<T>;

export declare function publishPerformanceEvidence(
  options: PerformanceEvidencePublicationOptions,
): Promise<Readonly<{ outputPath: string; reportPath: string }>>;
