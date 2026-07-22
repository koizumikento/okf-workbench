export interface UriIdentity {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query?: string;
  readonly fragment?: string;
}

export class UnsafeWorkspacePathError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UnsafeWorkspacePathError';
  }
}

function decodeStable(value: string): string {
  let decoded = value;
  for (let index = 0; index < 16; index += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch (error) {
      throw new UnsafeWorkspacePathError('The path contains invalid percent encoding.', {
        cause: error,
      });
    }
    if (next === decoded) {
      return decoded;
    }
    decoded = next;
  }
  throw new UnsafeWorkspacePathError('The path contains excessive nested percent encoding.');
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

/**
 * Validates a POSIX relative path reported by a workspace provider without
 * decoding its segments. Provider names are already identities, so `%2F`
 * must remain a literal filename component rather than becoming `/`.
 */
export function preserveProviderRelativePath(input: string): string {
  if (input.length === 0) {
    throw new UnsafeWorkspacePathError('The provider path must not be empty.');
  }
  if (hasControlCharacter(input)) {
    throw new UnsafeWorkspacePathError('The provider path contains a control character.');
  }
  if (input.includes('\\')) {
    throw new UnsafeWorkspacePathError('The provider path must use POSIX separators.');
  }
  if (input.startsWith('/') || /^[a-zA-Z]:\//u.test(input)) {
    throw new UnsafeWorkspacePathError('The provider path must be relative to the bundle root.');
  }

  const segments = input.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new UnsafeWorkspacePathError(
      'The provider path must not contain empty, current, or parent segments.',
    );
  }

  return input;
}

/**
 * Converts a user-supplied relative path to POSIX form without allowing path
 * normalization to hide an escape from the selected bundle.
 */
export function normalizeContainedRelativePath(input: string): string {
  if (input.length === 0) {
    throw new UnsafeWorkspacePathError('The path must not be empty.');
  }
  if (input.includes('\0')) {
    throw new UnsafeWorkspacePathError('The path must not contain a null byte.');
  }

  const posix = input.replaceAll('\\', '/');
  if (posix.startsWith('/') || /^[a-zA-Z]:\//u.test(posix)) {
    throw new UnsafeWorkspacePathError('The path must be relative to the bundle root.');
  }

  const normalized: string[] = [];
  for (const [index, encodedSegment] of posix.split('/').entries()) {
    if (encodedSegment.length === 0) {
      throw new UnsafeWorkspacePathError('The path must not contain empty segments.');
    }
    const segment = decodeStable(encodedSegment);
    if (segment === '.' || segment === '..') {
      throw new UnsafeWorkspacePathError('The path must not traverse outside the bundle root.');
    }
    if (index === 0 && /^[a-zA-Z]:$/u.test(segment)) {
      throw new UnsafeWorkspacePathError('The path must be relative to the bundle root.');
    }
    if (segment.includes('/') || segment.includes('\\')) {
      throw new UnsafeWorkspacePathError('The path must not contain encoded separators.');
    }
    normalized.push(segment);
  }

  return normalized.join('/');
}

/**
 * Returns every parent path between a proposal write root and its target.
 * User/generated paths are normalized with encoded-escape checks, while
 * provider paths retain their already-established segment identities.
 */
export function relativeParentPaths(input: string, pathIdentity?: 'provider'): readonly string[] {
  const relativePath =
    pathIdentity === 'provider'
      ? preserveProviderRelativePath(input)
      : normalizeContainedRelativePath(input);
  const segments = relativePath.split('/');
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
}

function normalizeAbsoluteUriPath(path: string): string {
  if (path === '/') {
    return path;
  }
  return path.replace(/\/+$/u, '');
}

function sameUriIdentityComponent(left: string | undefined, right: string | undefined): boolean {
  return (left ?? '') === (right ?? '');
}

/** Checks URI containment without relying on an operating-system file path. */
export function isUriContained(root: UriIdentity, candidate: UriIdentity): boolean {
  if (
    root.scheme !== candidate.scheme ||
    root.authority !== candidate.authority ||
    !sameUriIdentityComponent(root.query, candidate.query) ||
    !sameUriIdentityComponent(root.fragment, candidate.fragment)
  ) {
    return false;
  }

  const rootPath = normalizeAbsoluteUriPath(root.path);
  const candidatePath = normalizeAbsoluteUriPath(candidate.path);
  if (rootPath === '/') {
    return candidatePath.startsWith('/');
  }
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);
}
