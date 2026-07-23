import { Uri } from 'vscode';

import { OKF_SEMANTIC_LIMITS } from '../../core/model/index.js';
import {
  isUriContained,
  normalizeContainedRelativePath,
  preserveProviderRelativePath,
} from './pathSafety.js';

const utf8Encoder = new TextEncoder();

function assertBoundedUri(uri: Uri, subject: string): string {
  const serialized = uri.toString();
  if (
    serialized.length > OKF_SEMANTIC_LIMITS.maxSourceUriCodeUnits ||
    utf8Encoder.encode(serialized).byteLength > OKF_SEMANTIC_LIMITS.maxSourceUriBytes
  ) {
    throw new Error(
      `${subject} exceeds the ${String(OKF_SEMANTIC_LIMITS.maxSourceUriCodeUnits)}-code-unit or ${String(OKF_SEMANTIC_LIMITS.maxSourceUriBytes)}-byte workspace URI safety limit.`,
    );
  }
  return serialized;
}

export interface WorkspaceUriCodec<TUri> {
  parse(value: string): TUri;
  serialize(uri: TUri): string;
  /**
   * Returns the exact URI chain from a containing root through its descendant,
   * inclusive. Implementations must preserve provider segment identity rather
   * than decoding percent-looking names.
   */
  containedPathSegments(root: TUri, descendant: TUri): readonly TUri[];
  /** Resolves a validated user/generated path, including encoded-path threat checks. */
  joinContained(root: TUri, relativePath: string): TUri;
  /** Resolves provider-reported POSIX segments verbatim, without percent decoding. */
  joinProviderPath(root: TUri, relativePath: string): TUri;
  equals(left: TUri, right: TUri): boolean;
}

export const vscodeUriCodec: WorkspaceUriCodec<Uri> = {
  parse(value) {
    return Uri.parse(value, true);
  },
  serialize(uri) {
    return uri.toString();
  },
  containedPathSegments(root, descendant) {
    const rootSerialized = assertBoundedUri(root, 'The workspace safety root');
    const descendantSerialized = assertBoundedUri(descendant, 'The selected write root');
    if (!isUriContained(root, descendant)) {
      throw new Error('The selected write root is outside its workspace safety root.');
    }
    const rootPath = root.path === '/' ? '/' : root.path.replace(/\/+$/u, '');
    const descendantPath = descendant.path === '/' ? '/' : descendant.path.replace(/\/+$/u, '');
    if (rootPath === descendantPath) {
      return rootSerialized === descendantSerialized ? [root] : [root, descendant];
    }
    const relativePath =
      rootPath === '/' ? descendantPath.slice(1) : descendantPath.slice(rootPath.length + 1);
    if (
      relativePath.length > OKF_SEMANTIC_LIMITS.maxProviderPathCodeUnits ||
      utf8Encoder.encode(relativePath).byteLength > OKF_SEMANTIC_LIMITS.maxProviderPathBytes
    ) {
      throw new Error('The selected write root has an oversized workspace-relative path.');
    }
    const segments = relativePath.split('/');
    if (segments.length > OKF_SEMANTIC_LIMITS.maxProviderPathSegments) {
      throw new Error(
        `The selected write root is deeper than the ${String(OKF_SEMANTIC_LIMITS.maxProviderPathSegments)}-segment workspace safety limit.`,
      );
    }
    if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
      throw new Error('The selected write root has an ambiguous workspace-relative path.');
    }

    const chain: Uri[] = [root];
    let currentPath = rootPath;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (segment === undefined) {
        continue;
      }
      currentPath = currentPath === '/' ? `/${segment}` : `${currentPath}/${segment}`;
      const segmentUri = root.with({ path: currentPath });
      chain.push(index === segments.length - 1 ? descendant : segmentUri);
    }
    if (chain.at(-1)?.toString() !== descendantSerialized) {
      throw new Error('The selected write root could not be reconstructed from its workspace.');
    }
    return chain;
  },
  joinContained(root, relativePath) {
    const normalized = normalizeContainedRelativePath(relativePath);
    const candidate = Uri.joinPath(root, ...normalized.split('/'));
    if (!isUriContained(root, candidate)) {
      throw new Error('The resolved URI is outside the selected bundle root.');
    }
    return candidate;
  },
  joinProviderPath(root, relativePath) {
    const preserved = preserveProviderRelativePath(relativePath);
    const candidate = Uri.joinPath(root, ...preserved.split('/'));
    if (!isUriContained(root, candidate)) {
      throw new Error('The provider URI is outside the selected bundle root.');
    }
    return candidate;
  },
  equals(left, right) {
    return left.toString() === right.toString();
  },
};
