import { Uri } from 'vscode';

import {
  isUriContained,
  normalizeContainedRelativePath,
  preserveProviderRelativePath,
} from './pathSafety.js';

export interface WorkspaceUriCodec<TUri> {
  parse(value: string): TUri;
  serialize(uri: TUri): string;
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
