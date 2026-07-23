import type { LinkClassification } from '../model/index.js';
import { OKF_SEMANTIC_LIMITS } from '../model/resource-limits.js';

export type CanonicalBundlePathResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string; readonly resourceLimit?: true };

export interface ResolvedLinkTarget {
  readonly classification: LinkClassification;
  readonly targetId?: string;
  readonly fragment?: string;
  readonly query?: string;
}

export interface LinkResolutionInventory {
  readonly conceptIdsByPath: ReadonlyMap<string, string>;
  readonly directories: ReadonlySet<string>;
  readonly reservedPaths: ReadonlySet<string>;
}

const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const WINDOWS_DRIVE = /^[A-Za-z]:\//u;
const utf8Encoder = new TextEncoder();

/**
 * Canonicalizes a logical bundle path without consulting the host filesystem.
 * The returned form is relative, contained, and always uses POSIX separators.
 */
export function canonicalizeBundlePath(rawPath: string): CanonicalBundlePathResult {
  if (rawPath.length === 0) {
    return { ok: false, message: 'Bundle path is empty.' };
  }
  if (
    rawPath.length > OKF_SEMANTIC_LIMITS.maxProviderPathCodeUnits ||
    utf8Encoder.encode(rawPath).byteLength > OKF_SEMANTIC_LIMITS.maxProviderPathBytes
  ) {
    return {
      ok: false,
      resourceLimit: true,
      message: `Bundle path exceeds the ${String(OKF_SEMANTIC_LIMITS.maxProviderPathCodeUnits)}-code-unit or ${String(OKF_SEMANTIC_LIMITS.maxProviderPathBytes)}-byte identity safety limit. Shorten the provider-relative path, then retry.`,
    };
  }

  const posixPath = rawPath.replace(/\\/gu, '/');
  if (posixPath.startsWith('/') || WINDOWS_DRIVE.test(posixPath)) {
    return { ok: false, message: 'Bundle path must be relative to the bundle root.' };
  }
  if (hasControlCharacter(posixPath)) {
    return { ok: false, message: 'Bundle path contains a control character.' };
  }

  const parts: string[] = [];
  for (const part of posixPath.split('/')) {
    if (part.length === 0 || part === '.') {
      continue;
    }
    if (part === '..') {
      if (parts.length === 0) {
        return { ok: false, message: 'Bundle path escapes the bundle root.' };
      }
      parts.pop();
      continue;
    }
    parts.push(part);
    if (parts.length > OKF_SEMANTIC_LIMITS.maxProviderPathSegments) {
      return {
        ok: false,
        resourceLimit: true,
        message: `Bundle path exceeds the ${String(OKF_SEMANTIC_LIMITS.maxProviderPathSegments)}-segment identity safety limit. Reduce directory nesting, then retry.`,
      };
    }
  }

  if (parts.length === 0) {
    return { ok: false, message: 'Bundle path does not identify a document.' };
  }

  return { ok: true, path: parts.join('/') };
}

export function conceptIdFromBundlePath(bundlePath: string): string | undefined {
  const canonical = canonicalizeBundlePath(bundlePath);
  if (!canonical.ok || !canonical.path.endsWith('.md')) {
    return undefined;
  }
  const filename = canonical.path.slice(canonical.path.lastIndexOf('/') + 1);
  if (filename === '.md') {
    return undefined;
  }
  return canonical.path.slice(0, -3);
}

export function directoryPathsForDocument(bundlePath: string): readonly string[] {
  const directories = [''];
  const parts = bundlePath.split('/');
  parts.pop();

  let current = '';
  for (const part of parts) {
    current = current.length === 0 ? part : `${current}/${part}`;
    directories.push(current);
  }
  return directories;
}

export function resolveLinkTarget(
  rawTarget: string,
  sourceBundlePath: string,
  inventory: LinkResolutionInventory,
): ResolvedLinkTarget {
  const components = splitTarget(rawTarget);
  const suffix = optionalComponents(components.query, components.fragment);

  if (rawTarget.length === 0 || hasControlCharacter(rawTarget)) {
    return { classification: 'invalid', ...suffix };
  }

  if (URI_SCHEME.test(components.path) || components.path.startsWith('//')) {
    return { classification: 'external', ...suffix };
  }

  if (components.path.length === 0) {
    if (components.fragment !== undefined && components.query === undefined) {
      return { classification: 'fragment', fragment: components.fragment };
    }
    return { classification: 'invalid', ...suffix };
  }

  // Markdown URLs are slash-separated. A raw backslash is not a filesystem separator here.
  if (components.path.includes('\\')) {
    return { classification: 'invalid', ...suffix };
  }

  const decoded = decodeUrlPathOnce(components.path);
  if (!decoded.ok) {
    return { classification: 'invalid', ...suffix };
  }

  const rootRelative = components.path.startsWith('/') || decoded.path.startsWith('/');
  const normalized = normalizeResolvedPath(
    decoded.path,
    rootRelative ? '' : directoryName(sourceBundlePath),
  );
  if (!normalized.contained) {
    return { classification: 'out-of-bundle', ...suffix };
  }

  const targetPath = normalized.path;
  if (inventory.directories.has(targetPath)) {
    return { classification: 'directory', ...suffix };
  }

  const targetId = inventory.conceptIdsByPath.get(targetPath);
  if (targetId !== undefined) {
    return { classification: 'internal', targetId, ...suffix };
  }

  if (inventory.reservedPaths.has(targetPath)) {
    return {
      classification: baseName(targetPath) === 'index.md' ? 'directory' : 'invalid',
      ...suffix,
    };
  }

  if (targetPath.endsWith('.md') || decoded.path.endsWith('/')) {
    return { classification: 'broken', ...suffix };
  }

  return { classification: 'invalid', ...suffix };
}

function splitTarget(rawTarget: string): {
  readonly path: string;
  readonly query?: string;
  readonly fragment?: string;
} {
  const fragmentIndex = rawTarget.indexOf('#');
  const beforeFragment = fragmentIndex < 0 ? rawTarget : rawTarget.slice(0, fragmentIndex);
  const fragment = fragmentIndex < 0 ? undefined : rawTarget.slice(fragmentIndex + 1);
  const queryIndex = beforeFragment.indexOf('?');
  const path = queryIndex < 0 ? beforeFragment : beforeFragment.slice(0, queryIndex);
  const query = queryIndex < 0 ? undefined : beforeFragment.slice(queryIndex + 1);
  return {
    path,
    ...(query === undefined ? {} : { query }),
    ...(fragment === undefined ? {} : { fragment }),
  };
}

function optionalComponents(
  query: string | undefined,
  fragment: string | undefined,
): { readonly query?: string; readonly fragment?: string } {
  return {
    ...(query === undefined ? {} : { query }),
    ...(fragment === undefined ? {} : { fragment }),
  };
}

function decodeUrlPathOnce(rawPath: string): CanonicalBundlePathResult {
  try {
    // Decode per segment exactly once, then make encoded separators visible to containment checks.
    const decoded = rawPath
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/')
      .replace(/\\/gu, '/');
    if (hasControlCharacter(decoded)) {
      return { ok: false, message: 'Link target contains a control character.' };
    }
    return { ok: true, path: decoded };
  } catch {
    return { ok: false, message: 'Link target contains invalid percent encoding.' };
  }
}

function normalizeResolvedPath(
  decodedPath: string,
  sourceDirectory: string,
): { readonly contained: true; readonly path: string } | { readonly contained: false } {
  const parts = sourceDirectory.length === 0 ? [] : sourceDirectory.split('/');
  for (const part of decodedPath.split('/')) {
    if (part.length === 0 || part === '.') {
      continue;
    }
    if (part === '..') {
      if (parts.length === 0) {
        return { contained: false };
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return { contained: true, path: parts.join('/') };
}

function directoryName(bundlePath: string): string {
  const separator = bundlePath.lastIndexOf('/');
  return separator < 0 ? '' : bundlePath.slice(0, separator);
}

function baseName(bundlePath: string): string {
  const separator = bundlePath.lastIndexOf('/');
  return separator < 0 ? bundlePath : bundlePath.slice(separator + 1);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}
