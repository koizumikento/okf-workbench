import { OKF_SEMANTIC_LIMITS } from './resource-limits.js';

export type RelativePathBoundFailure = 'code-units' | 'utf8-bytes' | 'segments';

/**
 * Counts the UTF-8 bytes emitted for a JavaScript string without allocating an encoded copy.
 *
 * Unpaired UTF-16 surrogates match TextEncoder's replacement-character behavior. Callers that
 * require well-formed Unicode must reject those separately.
 */
export function utf8ByteLength(value: string, stopAfter = Number.MAX_SAFE_INTEGER): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current <= 0x7f) {
      bytes += 1;
    } else if (current <= 0x7ff) {
      bytes += 2;
    } else if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > stopAfter) {
      return bytes;
    }
  }
  return bytes;
}

export function hasUnpairedUtf16Surrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Applies the one shared generated/provider relative-path resource envelope.
 *
 * The raw-input call prevents an oversized value from reaching replace/split/decode operations.
 * A second call after user-input decoding catches separators that percent decoding introduced.
 */
export function relativePathBoundFailure(
  value: string,
  backslashIsSeparator: boolean,
): RelativePathBoundFailure | undefined {
  if (value.length > OKF_SEMANTIC_LIMITS.maxProviderPathCodeUnits) {
    return 'code-units';
  }
  if (
    utf8ByteLength(value, OKF_SEMANTIC_LIMITS.maxProviderPathBytes) >
    OKF_SEMANTIC_LIMITS.maxProviderPathBytes
  ) {
    return 'utf8-bytes';
  }

  let segments = 1;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x2f || (backslashIsSeparator && code === 0x5c)) {
      segments += 1;
      if (segments > OKF_SEMANTIC_LIMITS.maxProviderPathSegments) {
        return 'segments';
      }
    }
  }
  return undefined;
}
