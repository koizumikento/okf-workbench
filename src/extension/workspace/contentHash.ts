import { createHash } from 'node:crypto';

const SHA256_PREFIX = 'sha256:';
const SHA256_HEX = /^[a-f\d]{64}$/u;

/** Returns a lowercase, algorithm-qualified SHA-256 content hash. */
export function sha256Content(content: Uint8Array): string {
  return `${SHA256_PREFIX}${createHash('sha256').update(content).digest('hex')}`;
}

/** Accepts both canonical `sha256:<hex>` values and legacy bare hex values. */
export function normalizeSha256(value: string): string | undefined {
  const lowered = value.toLowerCase();
  const hex = lowered.startsWith(SHA256_PREFIX) ? lowered.slice(SHA256_PREFIX.length) : lowered;
  return SHA256_HEX.test(hex) ? `${SHA256_PREFIX}${hex}` : undefined;
}

export function matchesSha256(content: Uint8Array, expected: string): boolean {
  const normalized = normalizeSha256(expected);
  return normalized !== undefined && sha256Content(content) === normalized;
}
