import { parseBundle } from '../../core/parser/index.js';
import { OKF_SEMANTIC_LIMITS, type OperationProblem } from '../../core/model/index.js';

import { WorkspaceAccessError, type WorkspacePort } from '../workspace/types.js';
import type { WorkspaceUriCodec } from '../workspace/uriCodec.js';
import {
  captureWorkspaceDirectoryChain,
  inspectWorkspaceDirectoryChain,
  verifyWorkspaceDirectoryChain,
} from '../workspace/directorySafety.js';
import { BUNDLE_READ_LIMITS, readWorkspaceFileWithinLimit } from '../workspace/readSafety.js';
import type { WorkspaceStat } from '../workspace/types.js';

// Preserve a leading BOM so the core parser, rather than this adapter, enforces the one-BOM policy.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

function safeSerializedUri<TUri>(uri: TUri, uris: WorkspaceUriCodec<TUri>): string | undefined {
  const serialized = uris.serialize(uri);
  if (serialized.length > OKF_SEMANTIC_LIMITS.maxSourceUriCodeUnits) {
    return undefined;
  }
  return encoder.encode(serialized).byteLength <= OKF_SEMANTIC_LIMITS.maxSourceUriBytes
    ? serialized
    : undefined;
}

export interface RootIndexInspectionInput {
  readonly rootUri: string;
  readonly indexUri: string;
  readonly text: string;
}

export type OkfVersionCompatibility = 'supported' | 'future-minor' | 'unsupported';

export interface OkfVersionInspection {
  /** A deterministic JSON rendering suitable for a warning, including quotes for strings. */
  readonly declared: string;
  readonly compatibility: OkfVersionCompatibility;
}

export type BundleRootIndexDecision =
  | {
      readonly isBundleRoot: false;
      readonly reason: 'missing-index' | 'missing-version' | 'invalid-index' | 'unreadable-index';
    }
  | {
      readonly isBundleRoot: false;
      readonly reason: 'invalid-version';
      readonly declared: string;
    }
  | {
      readonly isBundleRoot: true;
      readonly label?: string;
      readonly version: OkfVersionInspection;
    };

export type SelectedBundleRootInspection<TUri> =
  | {
      readonly ok: true;
      readonly indexUri: TUri;
      readonly decision: Extract<BundleRootIndexDecision, { readonly isBundleRoot: true }>;
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'invalid-root'
        | 'missing-index'
        | 'unreadable-index'
        | 'missing-version'
        | 'invalid-index'
        | 'invalid-version';
    };

export type ExplicitBundleRootInspection<TUri> =
  | {
      readonly ok: true;
      readonly indexUri: TUri;
      readonly decision: BundleRootIndexDecision;
    }
  | {
      readonly ok: false;
      readonly reason: 'invalid-root';
    };

export type BundleWriteAccess =
  | {
      readonly ok: true;
      readonly compatibility: 'supported' | 'future-minor' | 'undeclared';
    }
  | {
      readonly ok: false;
      readonly problem: OperationProblem;
    };

/**
 * Identifies a bundle root by parsing the actual YAML frontmatter rather than
 * matching text that could occur in Markdown, a comment, or malformed YAML.
 */
export function inspectBundleRootIndex(input: RootIndexInspectionInput): BundleRootIndexDecision {
  const parsed = parseBundle({
    rootUri: input.rootUri,
    revision: 0,
    documents: [
      {
        uri: input.indexUri,
        bundlePath: 'index.md',
        content: input.text,
      },
    ],
  });
  if (parsed.failures.length > 0) {
    return { isBundleRoot: false, reason: 'invalid-index' };
  }

  const rootIndex = parsed.reservedDocuments.find(
    (document) => document.reservedKind === 'index' && document.source.bundlePath === 'index.md',
  );
  if (rootIndex === undefined) {
    return { isBundleRoot: false, reason: 'missing-version' };
  }
  const raw = rootIndex?.frontmatter?.raw;
  if (raw === undefined || !Object.hasOwn(raw, 'okf_version')) {
    return { isBundleRoot: false, reason: 'missing-version' };
  }
  const declaredVersion = rootIndex.okfVersion;
  if (declaredVersion === undefined) {
    return {
      isBundleRoot: false,
      reason: 'invalid-version',
      declared: JSON.stringify(raw.okf_version) ?? 'undefined',
    };
  }

  const title = rootIndex.frontmatter?.normalized.title;
  const label = title !== undefined && title.trim().length > 0 ? title.trim() : undefined;
  const version = inspectOkfVersion(declaredVersion);
  if (version === undefined) {
    return {
      isBundleRoot: false,
      reason: 'invalid-version',
      declared: JSON.stringify(declaredVersion) ?? 'undefined',
    };
  }
  return {
    isBundleRoot: true,
    ...(label === undefined ? {} : { label }),
    version,
  };
}

function inspectOkfVersion(value: string): OkfVersionInspection | undefined {
  const match = /^(\d+)\.(\d+)$/u.exec(value);
  if (match === null) {
    return undefined;
  }
  const declared = JSON.stringify(value);
  if (value === '0.1' || value === '0.2') {
    return { declared, compatibility: 'supported' };
  }
  const major = match[1];
  const minor = match[2];
  if (major !== undefined && minor !== undefined && BigInt(major) === 0n && BigInt(minor) > 2n) {
    return { declared, compatibility: 'future-minor' };
  }
  return { declared, compatibility: 'unsupported' };
}

/**
 * Inspects a user-selected root for best-effort validation or graphing. A missing, unreadable,
 * malformed, or versionless index remains a candidate so its findings are reachable.
 */
export async function inspectExplicitBundleRoot<TUri>(
  rootUri: TUri,
  port: WorkspacePort<TUri>,
  uris: WorkspaceUriCodec<TUri>,
  workspaceSafetyRoot: TUri = rootUri,
): Promise<ExplicitBundleRootInspection<TUri>> {
  const rootUriString = safeSerializedUri(rootUri, uris);
  if (rootUriString === undefined) {
    return { ok: false, reason: 'invalid-root' };
  }
  const directoryChain = await captureWorkspaceDirectoryChain(
    workspaceSafetyRoot,
    rootUri,
    port,
    uris,
  );
  if (!directoryChain.ok) {
    return { ok: false, reason: 'invalid-root' };
  }
  try {
    const rootStat = await port.stat(rootUri);
    if ((await verifyWorkspaceDirectoryChain(directoryChain.snapshot, port, uris)) !== undefined) {
      return { ok: false, reason: 'invalid-root' };
    }
    if (rootStat?.type !== 'directory') {
      return { ok: false, reason: 'invalid-root' };
    }
  } catch {
    return { ok: false, reason: 'invalid-root' };
  }

  let indexUri: TUri;
  try {
    indexUri = uris.joinContained(rootUri, 'index.md');
  } catch {
    return { ok: false, reason: 'invalid-root' };
  }
  const indexUriString = safeSerializedUri(indexUri, uris);
  if (indexUriString === undefined) {
    return { ok: false, reason: 'invalid-root' };
  }

  let indexStat: WorkspaceStat;
  try {
    const stat = await port.stat(indexUri);
    if ((await verifyWorkspaceDirectoryChain(directoryChain.snapshot, port, uris)) !== undefined) {
      return { ok: false, reason: 'invalid-root' };
    }
    if (stat === undefined) {
      return {
        ok: true,
        indexUri,
        decision: { isBundleRoot: false, reason: 'missing-index' },
      };
    }
    if (stat.type !== 'file') {
      return {
        ok: true,
        indexUri,
        decision: { isBundleRoot: false, reason: 'invalid-index' },
      };
    }
    indexStat = stat;
  } catch {
    if ((await verifyWorkspaceDirectoryChain(directoryChain.snapshot, port, uris)) !== undefined) {
      return { ok: false, reason: 'invalid-root' };
    }
    return {
      ok: true,
      indexUri,
      decision: { isBundleRoot: false, reason: 'unreadable-index' },
    };
  }

  let text: string;
  try {
    const changedBeforeRead = await verifyWorkspaceDirectoryChain(
      directoryChain.snapshot,
      port,
      uris,
    );
    if (changedBeforeRead !== undefined) {
      throw new WorkspaceAccessError('unavailable', changedBeforeRead.message);
    }
    text = decoder.decode(
      await readWorkspaceFileWithinLimit(port, indexUri, {
        maxBytes: BUNDLE_READ_LIMITS.maxDocumentBytes,
        subject: 'the selected bundle root index.md',
        reportedStat: indexStat,
      }),
    );
  } catch {
    if ((await verifyWorkspaceDirectoryChain(directoryChain.snapshot, port, uris)) !== undefined) {
      return { ok: false, reason: 'invalid-root' };
    }
    return {
      ok: true,
      indexUri,
      decision: { isBundleRoot: false, reason: 'unreadable-index' },
    };
  }
  if ((await verifyWorkspaceDirectoryChain(directoryChain.snapshot, port, uris)) !== undefined) {
    return { ok: false, reason: 'invalid-root' };
  }

  const decision = inspectBundleRootIndex({
    rootUri: rootUriString,
    indexUri: indexUriString,
    text,
  });
  return { ok: true, indexUri, decision };
}

/** Strictly verifies a selected directory before an existing-bundle write uses it. */
export async function inspectSelectedBundleRoot<TUri>(
  rootUri: TUri,
  port: WorkspacePort<TUri>,
  uris: WorkspaceUriCodec<TUri>,
  workspaceSafetyRoot: TUri = rootUri,
): Promise<SelectedBundleRootInspection<TUri>> {
  const inspection = await inspectExplicitBundleRoot(rootUri, port, uris, workspaceSafetyRoot);
  if (!inspection.ok) {
    return { ok: false, reason: inspection.reason };
  }
  const { decision } = inspection;
  if (!decision.isBundleRoot) {
    return { ok: false, reason: decision.reason };
  }
  return {
    ok: true,
    indexUri: inspection.indexUri,
    decision: { ...decision, isBundleRoot: true },
  };
}

/**
 * Re-reads the selected root immediately before a write workflow. Unsupported versions remain
 * discoverable for validation and graphing, but writes fail closed.
 */
export async function inspectBundleWriteAccess<TUri>(
  rootUri: TUri,
  port: WorkspacePort<TUri>,
  uris: WorkspaceUriCodec<TUri>,
  workspaceSafetyRoot: TUri = rootUri,
): Promise<BundleWriteAccess> {
  const inspection = await inspectExplicitBundleRoot(rootUri, port, uris, workspaceSafetyRoot);
  if (!inspection.ok) {
    return {
      ok: false,
      problem: {
        code: 'bundle-write-root-revalidation-failed',
        message: `The selected bundle root could not be revalidated before writing (${inspection.reason}).`,
        correctiveAction:
          'No files were written. Repair or restore index.md, then select and validate the bundle again.',
      },
    };
  }

  const { decision } = inspection;
  if (!decision.isBundleRoot) {
    if (decision.reason === 'missing-index' || decision.reason === 'missing-version') {
      return { ok: true, compatibility: 'undeclared' };
    }
    if (decision.reason === 'unreadable-index') {
      return {
        ok: false,
        problem: {
          code: 'bundle-write-root-revalidation-failed',
          message: 'The selected bundle root index could not be read before writing.',
          correctiveAction:
            'No files were written. Restore index.md access or valid UTF-8 content, then validate the bundle again.',
        },
      };
    }
    return {
      ok: false,
      problem: {
        code: 'invalid-okf-version-write',
        message:
          decision.reason === 'invalid-version'
            ? `The selected bundle declares invalid OKF version ${decision.declared}.`
            : 'The selected bundle root index contains invalid YAML frontmatter.',
        correctiveAction:
          'No files were written. Validate the bundle read-only, then repair index.md before editing.',
      },
    };
  }

  if (decision.version.compatibility === 'unsupported') {
    return {
      ok: false,
      problem: {
        code: 'unsupported-okf-version-write',
        message: `The selected bundle declares unsupported OKF version ${decision.version.declared}; OKF Workbench writes only OKF 0.1- and 0.2-compatible bundles.`,
        correctiveAction:
          'No files were written. Validate or graph the bundle read-only, then migrate it or review support before editing.',
      },
    };
  }

  return { ok: true, compatibility: decision.version.compatibility };
}

/** Applies the fail-closed version check to any structurally compatible bundle selection. */
export async function guardBundleWriteSelection<
  TUri,
  TSelection extends {
    readonly bundleRootUri: TUri;
    readonly workspaceSafetyRootUri: TUri;
  },
>(
  selection: TSelection | undefined,
  port: WorkspacePort<TUri>,
  uris: WorkspaceUriCodec<TUri>,
  onRefused: (problem: OperationProblem) => Promise<void>,
): Promise<TSelection | undefined> {
  if (selection === undefined) {
    return undefined;
  }
  const unsafeDirectory = await inspectWorkspaceDirectoryChain(
    selection.workspaceSafetyRootUri,
    selection.bundleRootUri,
    port,
    uris,
  );
  if (unsafeDirectory !== undefined) {
    await onRefused({
      code: 'unsafe-workspace-path',
      message: unsafeDirectory.message,
      correctiveAction:
        'No files were written. Select a real directory whose complete path remains inside the open workspace.',
      uri: uris.serialize(unsafeDirectory.uri),
    });
    return undefined;
  }
  const access = await inspectBundleWriteAccess(
    selection.bundleRootUri,
    port,
    uris,
    selection.workspaceSafetyRootUri,
  );
  if (!access.ok) {
    await onRefused(access.problem);
    return undefined;
  }
  return selection;
}
