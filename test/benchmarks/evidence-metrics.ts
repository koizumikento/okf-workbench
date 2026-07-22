export const QR002_SAMPLE_COUNT = 20;
export const QR002_P95_LIMIT_MS = 1_000;
export const QR003_FIRST_FRAME_LIMIT_MS = 5_000;
export const QR003_INTERACTION_P95_LIMIT_MS = 100;

export interface SampleSummary {
  readonly count: number;
  readonly minimumMs: number;
  readonly maximumMs: number;
  readonly meanMs: number;
  readonly p95Ms: number;
}

export function summarizeDurations(samples: readonly number[]): SampleSummary {
  if (samples.length === 0 || samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new Error('Duration samples must contain finite non-negative values.');
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const total = sorted.reduce((sum, sample) => sum + sample, 0);
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return {
    count: sorted.length,
    minimumMs: sorted[0] ?? 0,
    maximumMs: sorted.at(-1) ?? 0,
    meanMs: total / sorted.length,
    p95Ms: sorted[p95Index] ?? 0,
  };
}

export function isQr002Passing(samples: readonly number[]): boolean {
  return (
    samples.length >= QR002_SAMPLE_COUNT && summarizeDurations(samples).p95Ms <= QR002_P95_LIMIT_MS
  );
}

export function isQr003InteractionPassing(samples: readonly number[]): boolean {
  return (
    samples.length >= QR002_SAMPLE_COUNT &&
    summarizeDurations(samples).p95Ms <= QR003_INTERACTION_P95_LIMIT_MS
  );
}
