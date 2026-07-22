import type { OperationProblem, OperationResult } from '../model/index.js';

interface PathOptions {
  readonly kind: 'file' | 'directory';
  readonly extension?: string;
  readonly rejectReservedMarkdown?: boolean;
  readonly allowCurrentDirectory?: boolean;
}

/**
 * A bundle directory reported by a workspace provider.
 *
 * Keep this distinct from a plain string: plain strings are user-entered paths
 * and continue through percent-decoding and URI-like path rejection. Provider
 * paths are already identities, so their literal percent, colon, and Unicode
 * characters must survive unchanged.
 */
export interface ProviderBundleDirectory {
  readonly pathIdentity: 'provider';
  readonly relativePath: string;
}

export type BundleDirectoryInput = string | ProviderBundleDirectory;

function pathFailure(message: string): OperationResult<never> {
  const problem: OperationProblem = {
    code: 'unsafe-relative-path',
    message,
    correctiveAction: 'Choose a relative path that remains inside the selected bundle root.',
  };

  return { ok: false, problems: [problem] };
}

const MAX_PERCENT_DECODE_ROUNDS = 16;

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

/**
 * Decodes user-entered output paths to a stable value before validating them.
 *
 * A single decode is not sufficient for a write target: `%252e%252e` would
 * otherwise survive as `%2e%2e` and could become `..` in a later URI layer.
 * Repeating `decodeURIComponent` until it no longer changes the value mirrors
 * the privileged workspace containment guard. The fixed limit makes the rule
 * deterministic and prevents adversarially deep encodings.
 */
function decodePathStable(path: string): OperationResult<string> {
  let decoded = path;

  for (let round = 0; round < MAX_PERCENT_DECODE_ROUNDS; round += 1) {
    if (containsControlCharacter(decoded)) {
      return pathFailure(`The path ${JSON.stringify(path)} contains a control character.`);
    }

    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return pathFailure(`The path ${JSON.stringify(path)} contains invalid percent encoding.`);
    }

    if (next === decoded) {
      return { ok: true, value: decoded, warnings: [] };
    }
    decoded = next;
  }

  return pathFailure(
    `The path ${JSON.stringify(path)} contains excessive nested percent encoding.`,
  );
}

function normalizeRelativePath(input: string, options: PathOptions): OperationResult<string> {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return pathFailure('A non-empty relative path is required.');
  }

  const slashNormalized = input.replaceAll('\\', '/');
  const decoded = decodePathStable(slashNormalized);
  if (!decoded.ok) {
    return decoded;
  }

  const candidate = decoded.value.replaceAll('\\', '/');
  if (options.allowCurrentDirectory && candidate === '.') {
    return { ok: true, value: '.', warnings: [] };
  }

  if (
    candidate.startsWith('/') ||
    candidate.startsWith('//') ||
    /^[A-Za-z]:($|\/)/u.test(candidate) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(candidate)
  ) {
    return pathFailure(`The path ${JSON.stringify(input)} is absolute or URI-like.`);
  }

  const segments = candidate.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return pathFailure(
      `The path ${JSON.stringify(input)} contains an empty, current, or parent segment.`,
    );
  }

  const normalized = segments.join('/');
  if (options.kind === 'file' && normalized.endsWith('/')) {
    return pathFailure(`The path ${JSON.stringify(input)} does not identify a file.`);
  }

  if (options.extension !== undefined && !normalized.endsWith(options.extension)) {
    return pathFailure(`The path ${JSON.stringify(input)} must end with ${options.extension}.`);
  }

  if (options.rejectReservedMarkdown) {
    const filename = segments.at(-1)?.toLowerCase();
    if (filename === 'index.md' || filename === 'log.md') {
      return pathFailure(
        `${JSON.stringify(input)} is reserved by OKF and cannot be a concept path.`,
      );
    }
  }

  return { ok: true, value: normalized, warnings: [] };
}

/**
 * Validates an enumerated provider path while retaining every segment byte-for-byte.
 * Unlike user-entered output paths, provider identities must never be percent-decoded.
 */
function preserveProviderRelativePath(
  input: string,
  options: PathOptions,
): OperationResult<string> {
  if (typeof input !== 'string' || input.length === 0) {
    return pathFailure('A non-empty provider-relative path is required.');
  }
  if (containsControlCharacter(input)) {
    return pathFailure(`The provider path ${JSON.stringify(input)} contains a control character.`);
  }
  if (input.includes('\\')) {
    return pathFailure(`The provider path ${JSON.stringify(input)} must use POSIX separators.`);
  }
  if (input.startsWith('/') || input.startsWith('//') || /^[A-Za-z]:($|\/)/u.test(input)) {
    return pathFailure(`The provider path ${JSON.stringify(input)} is absolute.`);
  }

  if (options.allowCurrentDirectory && input === '.') {
    return { ok: true, value: '.', warnings: [] };
  }

  const segments = input.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return pathFailure(
      `The provider path ${JSON.stringify(input)} contains an empty, current, or parent segment.`,
    );
  }
  if (options.extension !== undefined && !input.endsWith(options.extension)) {
    return pathFailure(
      `The provider path ${JSON.stringify(input)} must end with ${options.extension}.`,
    );
  }
  if (options.rejectReservedMarkdown) {
    const filename = segments.at(-1)?.toLowerCase();
    if (filename === 'index.md' || filename === 'log.md') {
      return pathFailure(
        `${JSON.stringify(input)} is reserved by OKF and cannot be a concept path.`,
      );
    }
  }

  return { ok: true, value: input, warnings: [] };
}

export function normalizeConceptPath(input: string): OperationResult<string> {
  const result = normalizeRelativePath(input, {
    kind: 'file',
    extension: '.md',
    rejectReservedMarkdown: true,
  });
  if (!result.ok) {
    return result;
  }

  const filename = result.value.slice(result.value.lastIndexOf('/') + 1);
  if (filename === '.md') {
    return pathFailure(
      `The concept path ${JSON.stringify(input)} must include a filename before the .md extension.`,
    );
  }

  return result;
}

export function normalizeIndexPath(input: string): OperationResult<string> {
  const result = normalizeRelativePath(input, { kind: 'file', extension: '.md' });
  if (!result.ok) {
    return result;
  }

  if (result.value !== 'index.md' && !result.value.endsWith('/index.md')) {
    return pathFailure(`${JSON.stringify(input)} is not a directory index path.`);
  }

  return result;
}

export function preserveProviderConceptPath(input: string): OperationResult<string> {
  return preserveProviderRelativePath(input, {
    kind: 'file',
    extension: '.md',
    rejectReservedMarkdown: true,
  });
}

export function preserveProviderIndexPath(input: string): OperationResult<string> {
  const result = preserveProviderRelativePath(input, { kind: 'file', extension: '.md' });
  if (!result.ok) {
    return result;
  }
  if (result.value !== 'index.md' && !result.value.endsWith('/index.md')) {
    return pathFailure(`${JSON.stringify(input)} is not a directory index path.`);
  }
  return result;
}

/**
 * Validates a provider-reported bundle directory without decoding or
 * normalizing its identity. The returned discriminator is required by agent
 * integration renderers before they use the provider-safe validation branch.
 */
export function preserveProviderBundleDirectory(
  input: string,
): OperationResult<ProviderBundleDirectory> {
  const result = preserveProviderRelativePath(input, {
    kind: 'directory',
    allowCurrentDirectory: true,
  });
  if (!result.ok) {
    return result;
  }

  return {
    ok: true,
    value: { pathIdentity: 'provider', relativePath: result.value },
    warnings: [],
  };
}

export function normalizeBundleDirectory(input: string): OperationResult<string> {
  let candidate = input.replaceAll('\\', '/');
  while (candidate.startsWith('./')) {
    candidate = candidate.slice(2);
  }
  while (candidate.endsWith('/') && candidate !== '/') {
    candidate = candidate.slice(0, -1);
  }

  if (candidate.length === 0 && input.trim().length > 0) {
    candidate = '.';
  }

  return normalizeRelativePath(candidate, {
    kind: 'directory',
    allowCurrentDirectory: true,
  });
}

export function encodeMarkdownPathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/gu,
    (character) => `%${character.codePointAt(0)?.toString(16).toUpperCase() ?? ''}`,
  );
}
