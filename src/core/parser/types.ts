import type { ParsedBundle } from '../model/index.js';

interface BundleDocumentIdentity {
  readonly uri: string;
  /** Path relative to the selected bundle root. Both host separator styles are accepted. */
  readonly bundlePath: string;
}

/** A workspace-adapter-owned readable document. The core never reads a filesystem. */
export interface ReadableBundleDocumentInput extends BundleDocumentIdentity {
  /**
   * Well-formed decoded Unicode text, or bytes that the parser must decode as strict UTF-8.
   * One leading BOM is accepted; multiple leading BOMs are rejected for both input forms.
   */
  readonly content: string | Uint8Array;
  /** Adapter-provided hash, normally SHA-256. A deterministic fallback is used when omitted. */
  readonly contentHash?: string;
  readonly identityOnlyFailure?: never;
}

/**
 * A provider identity retained after source bytes could not be consumed safely.
 * The parser emits the supplied document-scoped failure and an identity-only
 * concept without synthesizing, hashing, or parsing placeholder content.
 */
export interface IdentityOnlyBundleDocumentInput extends BundleDocumentIdentity {
  readonly identityOnlyFailure: {
    readonly reason: 'resource-limit';
    readonly message: string;
  };
  readonly content?: never;
  readonly contentHash?: never;
}

export type BundleDocumentInput = ReadableBundleDocumentInput | IdentityOnlyBundleDocumentInput;

export interface ParseBundleInput {
  readonly rootUri: string;
  readonly revision: number;
  readonly documents: readonly BundleDocumentInput[];
}

export type BundleParser = (input: ParseBundleInput) => ParsedBundle;
