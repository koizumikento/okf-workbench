import type { WorkspacePort, WorkspaceStat } from './types.js';
import { WorkspaceAccessError } from './types.js';

/**
 * Hard limits for one selected-bundle refresh or authoring snapshot.
 *
 * The document count remains well above the measured 1,000-concept graph while
 * the byte budgets bound retained provider content in the Extension Host.
 */
export const BUNDLE_READ_LIMITS = Object.freeze({
  maxMarkdownDocuments: 2_000,
  maxTraversalDepth: 64,
  maxTraversalIdentityBytes: 32 * 1024 * 1024,
  maxDocumentBytes: 2 * 1024 * 1024,
  maxTotalDocumentBytes: 32 * 1024 * 1024,
  maxConcurrentReads: 8,
  maxRetainedFailures: 128,
});

export interface BoundedWorkspaceReadOptions {
  readonly maxBytes: number;
  readonly subject: string;
  /** Reuses a stat that the caller already obtained immediately before this read. */
  readonly reportedStat?: WorkspaceStat;
  readonly signal?: AbortSignal;
}

function validByteLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError('Workspace read byte limit must be a non-negative safe integer.');
  }
}

function correctiveAction(): string {
  return 'Reduce or split the file or knowledge bundle, then retry the operation.';
}

export function readSafetyError(message: string): WorkspaceAccessError {
  return new WorkspaceAccessError('unavailable', `${message} ${correctiveAction()}`);
}

export function assertSafeReportedByteLength(
  stat: WorkspaceStat,
  maxBytes: number,
  subject: string,
): void {
  validByteLimit(maxBytes);
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
    throw readSafetyError(
      `OKF Workbench refused to read ${subject} because the workspace provider reported an invalid byte size.`,
    );
  }
  if (stat.size > maxBytes) {
    throw readSafetyError(
      `OKF Workbench refused to read ${subject} because its reported size of ${String(stat.size)} bytes exceeds the ${String(maxBytes)}-byte safety limit.`,
    );
  }
}

export function assertSafeActualByteLength(
  content: Uint8Array,
  maxBytes: number,
  subject: string,
): void {
  validByteLimit(maxBytes);
  if (content.byteLength > maxBytes) {
    throw readSafetyError(
      `OKF Workbench refused to retain ${subject} because the provider returned ${String(content.byteLength)} bytes, exceeding the ${String(maxBytes)}-byte safety limit.`,
    );
  }
}

export function assertExpectedByteLength(actual: number, expected: number, subject: string): void {
  if (!Number.isSafeInteger(expected) || expected < 0) {
    throw new WorkspaceAccessError(
      'content-mismatch',
      `The preview for ${subject} does not contain a valid original byte length. Refresh the preview before applying.`,
    );
  }
  if (!Number.isSafeInteger(actual) || actual < 0 || actual !== expected) {
    throw new WorkspaceAccessError(
      'content-mismatch',
      `The byte length of ${subject} changed after preview. Refresh the preview before applying.`,
    );
  }
}

export function addBytesWithinLimit(
  current: number,
  additional: number,
  limit: number,
): number | undefined {
  if (
    !Number.isSafeInteger(current) ||
    !Number.isSafeInteger(additional) ||
    !Number.isSafeInteger(limit) ||
    current < 0 ||
    additional < 0 ||
    limit < 0 ||
    current > limit - additional
  ) {
    return undefined;
  }
  return current + additional;
}

/**
 * Uses provider metadata to avoid an oversized read where possible, then
 * validates the materialized result because providers and files can change.
 */
export async function readWorkspaceFileWithinLimit<TUri>(
  port: WorkspacePort<TUri>,
  uri: TUri,
  options: BoundedWorkspaceReadOptions,
): Promise<Uint8Array> {
  throwIfAborted(options.signal);
  const stat = options.reportedStat ?? (await port.stat(uri));
  throwIfAborted(options.signal);
  if (stat?.type === 'file') {
    assertSafeReportedByteLength(stat, options.maxBytes, options.subject);
  }
  const content = await port.read(uri, { expectedIdentity: stat?.readIdentity });
  throwIfAborted(options.signal);
  assertSafeActualByteLength(content, options.maxBytes, options.subject);
  return content;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) {
    return;
  }
  throw signal.reason instanceof Error ? signal.reason : new Error('Bundle refresh was canceled.');
}
