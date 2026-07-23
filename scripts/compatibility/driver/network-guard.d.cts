export const NETWORK_GUARD_LIFETIME: 'extension-host-exit';
export const NETWORK_GUARD_LIMITATIONS: string;
export const NETWORK_GUARD_SCOPE: 'listed-commonjs-export-owner-properties-only';
export const NETWORK_NOT_OBSERVED_LIMITATIONS: string;
export const OPTIONAL_GLOBAL_INTERCEPTED_METHODS: readonly [
  'globalThis.fetch',
  'globalThis.WebSocket',
];
export const STATIC_INTERCEPTED_METHODS: readonly string[];

export interface NetworkGuard {
  readonly interceptedMethods: readonly string[];
  restore(): void;
}

export interface ActiveNetworkObservation {
  readonly status: 'installed';
  readonly scope: 'listed-commonjs-export-owner-properties-only';
  readonly interceptedMethods: string[];
  readonly limitations: string;
  readonly lifetime: 'extension-host-exit';
  readonly guardRestored: false;
  readonly quiescenceMs: number;
  result: 'pending' | 'zero-attempts-observed';
}

export interface PostUninstallNetworkObservation {
  readonly status: 'not-installed';
  readonly scope: 'none';
  readonly interceptedMethods: readonly [];
  readonly limitations: string;
  readonly lifetime: null;
  readonly guardRestored: null;
  readonly quiescenceMs: null;
  readonly result: 'not-observed';
}

export function installNetworkGuard(attempts: string[]): NetworkGuard;
export function activeNetworkObservation(
  interceptedMethods: readonly string[],
  quiescenceMs: number,
): ActiveNetworkObservation;
export function postUninstallNetworkObservation(): PostUninstallNetworkObservation;
export function assertActiveNetworkEvidence(report: unknown, expectedQuiescenceMs: number): void;
export function assertPostUninstallNetworkEvidence(report: unknown): void;
