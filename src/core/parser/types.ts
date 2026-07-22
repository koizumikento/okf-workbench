import type { ParsedBundle } from '../model/index.js';

/** A workspace-adapter-owned document. The core never reads a filesystem. */
export interface BundleDocumentInput {
  readonly uri: string;
  /** Path relative to the selected bundle root. Both host separator styles are accepted. */
  readonly bundlePath: string;
  /** Already-decoded text, or bytes that the parser must decode as strict UTF-8. */
  readonly content: string | Uint8Array;
  /** Adapter-provided hash, normally SHA-256. A deterministic fallback is used when omitted. */
  readonly contentHash?: string;
}

export interface ParseBundleInput {
  readonly rootUri: string;
  readonly revision: number;
  readonly documents: readonly BundleDocumentInput[];
}

export type BundleParser = (input: ParseBundleInput) => ParsedBundle;
