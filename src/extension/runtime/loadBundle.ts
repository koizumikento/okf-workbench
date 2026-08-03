import type { BundleDocumentInput } from '../../core/parser/index.js';
import type { ParseFailure } from '../../core/model/index.js';
import { OKF_SEMANTIC_LIMITS } from '../../core/model/index.js';
import { sha256Content } from '../workspace/contentHash.js';
import {
  captureWorkspaceDirectoryChain,
  verifyWorkspaceDirectoryChain,
  type WorkspaceDirectoryChainSnapshot,
} from '../workspace/directorySafety.js';
import {
  addBytesWithinLimit,
  assertSafeActualByteLength,
  assertSafeReportedByteLength,
  BUNDLE_READ_LIMITS,
  readSafetyError,
  throwIfAborted,
} from '../workspace/readSafety.js';
import {
  WorkspaceAccessError,
  type WorkspaceEntry,
  type WorkspacePort,
  type WorkspaceStat,
} from '../workspace/types.js';
import type { WorkspaceUriCodec } from '../workspace/uriCodec.js';

export interface LoadedBundleInput {
  readonly rootUri: string;
  readonly documents: readonly BundleDocumentInput[];
  readonly failures: readonly ParseFailure[];
}

interface BoundedWorkspaceEntry<TUri> extends WorkspaceEntry<TUri> {
  readonly serializedUri: string;
}

interface ParentBoundedWorkspaceEntry<TUri> extends BoundedWorkspaceEntry<TUri> {
  readonly parentChain: WorkspaceDirectoryChainSnapshot<TUri>;
}

type PlannedRead<TUri> =
  | {
      readonly ok: true;
      readonly entry: ParentBoundedWorkspaceEntry<TUri>;
      readonly stat: WorkspaceStat;
    }
  | {
      readonly ok: false;
      readonly entry: BoundedWorkspaceEntry<TUri>;
      readonly error: string;
    };

type ParentPlannedRead<TUri> =
  | Extract<PlannedRead<TUri>, { readonly ok: true }>
  | {
      readonly ok: false;
      readonly entry: ParentBoundedWorkspaceEntry<TUri>;
      readonly error: string;
    };

type ReadResult<TUri> =
  | {
      readonly ok: true;
      readonly entry: ParentBoundedWorkspaceEntry<TUri>;
      readonly content: Uint8Array;
    }
  | {
      readonly ok: false;
      readonly entry: ParentBoundedWorkspaceEntry<TUri>;
      readonly error: string;
      readonly reason: 'read' | 'resource-limit';
      /** Present when the provider returned bytes that were later discarded. */
      readonly actualByteLength?: number;
    };

const utf8Encoder = new TextEncoder();
const AGENT_INTEGRATION_EXCLUDED_DIRECTORY_NAMES = ['.agents'] as const;

function isBundleMarkdownPath(relativePath: string): boolean {
  // Agent integration outputs are repository control files, not OKF concepts.
  // The root AGENTS.md can overlap a root-level bundle, while generated Skills
  // always live beneath the project-local .agents directory.
  return relativePath.endsWith('.md') && relativePath !== 'AGENTS.md';
}

async function assertSafeBundleDirectoryChain<TUri>(
  port: WorkspacePort<TUri>,
  uris: WorkspaceUriCodec<TUri>,
  workspaceSafetyRoot: TUri,
  root: TUri,
  signal: AbortSignal | undefined,
  expected?: WorkspaceDirectoryChainSnapshot<TUri>,
): Promise<WorkspaceDirectoryChainSnapshot<TUri>> {
  throwIfAborted(signal);
  if (expected === undefined) {
    const capture = await captureWorkspaceDirectoryChain(
      workspaceSafetyRoot,
      root,
      port,
      uris,
      signal,
    );
    throwIfAborted(signal);
    if (!capture.ok) {
      throw new WorkspaceAccessError(
        'unavailable',
        boundedFailureDetail(
          `OKF Workbench refused to read the selected bundle because its workspace path is no longer safe. ${capture.failure.message}`,
        ),
      );
    }
    return capture.snapshot;
  }
  const unsafeDirectory = await verifyWorkspaceDirectoryChain(expected, port, uris, signal);
  throwIfAborted(signal);
  if (unsafeDirectory !== undefined) {
    throw new WorkspaceAccessError(
      'unavailable',
      boundedFailureDetail(
        `OKF Workbench refused to read the selected bundle because its workspace directory generation changed. ${unsafeDirectory.message}`,
      ),
    );
  }
  return expected;
}

/** Streams and reads a logical bundle without assuming file-scheme resources. */
export async function loadBundle<TUri>(
  port: WorkspacePort<TUri>,
  uris: WorkspaceUriCodec<TUri>,
  root: TUri,
  workspaceSafetyRoot: TUri,
  signal?: AbortSignal,
): Promise<LoadedBundleInput> {
  const directoryChain = await assertSafeBundleDirectoryChain(
    port,
    uris,
    workspaceSafetyRoot,
    root,
    signal,
  );
  const rootUri = uris.serialize(root);
  let traversalIdentityBytes = assertBoundedProviderIdentity(rootUri, 'bundle root URI', 'uri');
  const reserveTraversalIdentity = (additional: number): void => {
    const next = addBytesWithinLimit(
      traversalIdentityBytes,
      additional,
      BUNDLE_READ_LIMITS.maxTraversalIdentityBytes,
    );
    if (next === undefined) {
      throw readSafetyError(
        `OKF Workbench refused to enumerate the selected bundle because provider paths and URIs exceed the ${String(BUNDLE_READ_LIMITS.maxTraversalIdentityBytes)}-byte cumulative identity safety limit.`,
      );
    }
    traversalIdentityBytes = next;
  };
  const entries: BoundedWorkspaceEntry<TUri>[] = [];
  const traversalFailures: ParseFailure[] = [];
  for await (const event of port.traverse(root, {
    excludeDirectoryNames: AGENT_INTEGRATION_EXCLUDED_DIRECTORY_NAMES,
    includeDirectories: false,
    maxDepth: BUNDLE_READ_LIMITS.maxTraversalDepth,
  })) {
    throwIfAborted(signal);
    const eventRelativePath =
      event.kind === 'failure' ? event.relativePath : event.entry.relativePath;
    reserveTraversalIdentity(
      assertBoundedProviderIdentity(eventRelativePath, 'provider-relative path', 'path'),
    );
    if (event.kind === 'failure') {
      if (
        event.relativePath.length === 0 ||
        event.reason === 'generation-changed' ||
        event.reason === 'safety-limit'
      ) {
        throw new WorkspaceAccessError('unavailable', boundedFailureDetail(event.message));
      }
      if (traversalFailures.length >= BUNDLE_READ_LIMITS.maxRetainedFailures) {
        throw readSafetyError(
          `OKF Workbench refused to load the selected bundle after more than ${String(BUNDLE_READ_LIMITS.maxRetainedFailures)} unreadable subtrees or documents were reported, exceeding the retained-failure safety limit.`,
        );
      }
      const serializedUri = uris.serialize(event.uri);
      reserveTraversalIdentity(assertBoundedProviderIdentity(serializedUri, 'provider URI', 'uri'));
      traversalFailures.push({
        kind: 'parse-failure',
        uri: serializedUri,
        bundlePath: event.relativePath,
        reason: 'read',
        message: boundedFailureDetail(
          `Unable to enumerate bundle subtree ${JSON.stringify(event.relativePath)}: ${event.message}`,
        ),
      });
      continue;
    }

    const entry = event.entry;
    let expectedEntryUri: TUri;
    try {
      expectedEntryUri = uris.joinProviderPath(root, entry.relativePath);
    } catch (error) {
      throw readSafetyError(
        `OKF Workbench refused a provider entry whose relative path could not be resolved inside the selected bundle (${safeErrorDetail(error)}).`,
      );
    }
    if (!uris.equals(expectedEntryUri, entry.uri)) {
      throw readSafetyError(
        'OKF Workbench refused a provider entry whose URI does not match its bundle-relative path.',
      );
    }
    if (entry.type === 'file' && isBundleMarkdownPath(entry.relativePath)) {
      if (entries.length >= BUNDLE_READ_LIMITS.maxMarkdownDocuments) {
        throw readSafetyError(
          `OKF Workbench refused to load the selected bundle because it contains more than ${String(BUNDLE_READ_LIMITS.maxMarkdownDocuments)} Markdown documents, exceeding the document-count safety limit.`,
        );
      }
      const serializedUri = uris.serialize(entry.uri);
      reserveTraversalIdentity(assertBoundedProviderIdentity(serializedUri, 'provider URI', 'uri'));
      entries.push({ ...entry, serializedUri });
    }
  }
  // Traversal itself is a provider await boundary. Detect a parent swap before
  // issuing any stat/read for the enumerated Markdown identities.
  await assertSafeBundleDirectoryChain(
    port,
    uris,
    workspaceSafetyRoot,
    root,
    signal,
    directoryChain,
  );
  entries.sort(
    (left, right) =>
      left.relativePath.localeCompare(right.relativePath) ||
      left.serializedUri.localeCompare(right.serializedUri),
  );
  throwIfAborted(signal);

  const planned = await inspectRegularFilesWithStableParents(
    port,
    uris,
    root,
    directoryChain,
    entries,
    signal,
  );

  const loaded: (BundleDocumentInput | ParseFailure)[] = [];
  let readFailureCount = 0;
  const retainFailure = (
    entry: BoundedWorkspaceEntry<TUri>,
    error: string,
    action: string,
    reason: 'read' | 'resource-limit' = 'read',
  ): void => {
    if (traversalFailures.length + readFailureCount >= BUNDLE_READ_LIMITS.maxRetainedFailures) {
      throw readSafetyError(
        `OKF Workbench refused to load the selected bundle after more than ${String(BUNDLE_READ_LIMITS.maxRetainedFailures)} unreadable subtrees or documents were reported, exceeding the retained-failure safety limit.`,
      );
    }
    const message = boundedFailureDetail(
      `Unable to ${action} bundle document ${JSON.stringify(entry.relativePath)}: ${error}`,
    );
    loaded.push(
      reason === 'resource-limit'
        ? {
            uri: entry.serializedUri,
            bundlePath: entry.relativePath,
            identityOnlyFailure: { reason, message },
          }
        : {
            kind: 'parse-failure',
            uri: entry.serializedUri,
            bundlePath: entry.relativePath,
            reason,
            message,
          },
    );
    readFailureCount += 1;
  };

  const readablePlans: Extract<PlannedRead<TUri>, { readonly ok: true }>[] = [];
  let reportedBytes = 0;
  for (const plan of planned) {
    if (!plan.ok) {
      retainFailure(plan.entry, plan.error, 'inspect');
      continue;
    }
    const subject = `bundle document ${JSON.stringify(plan.entry.relativePath)}`;
    try {
      assertSafeReportedByteLength(plan.stat, BUNDLE_READ_LIMITS.maxDocumentBytes, subject);
    } catch (error) {
      retainFailure(plan.entry, safeErrorDetail(error), 'inspect the size of', 'resource-limit');
      continue;
    }
    const nextTotal = addBytesWithinLimit(
      reportedBytes,
      plan.stat.size,
      BUNDLE_READ_LIMITS.maxTotalDocumentBytes,
    );
    if (nextTotal === undefined) {
      throw readSafetyError(
        `OKF Workbench refused to load the selected bundle because provider-reported Markdown content exceeds the ${String(BUNDLE_READ_LIMITS.maxTotalDocumentBytes)}-byte cumulative safety limit.`,
      );
    }
    reportedBytes = nextTotal;
    readablePlans.push(plan);
  }

  let actualBytes = 0;
  let freshReportedBytes = 0;
  for (
    let start = 0;
    start < readablePlans.length;
    start += BUNDLE_READ_LIMITS.maxConcurrentReads
  ) {
    const batch = readablePlans.slice(start, start + BUNDLE_READ_LIMITS.maxConcurrentReads);
    // A prior stat may be stale after a large bundle preflight. Re-stat this
    // fixed batch immediately before scheduling any of its reads.
    const freshPlans = await inspectRegularFilesWithStableParents(
      port,
      uris,
      root,
      directoryChain,
      batch.map(({ entry }) => entry),
      signal,
    );
    const freshReadable: Extract<PlannedRead<TUri>, { readonly ok: true }>[] = [];
    for (const plan of freshPlans) {
      if (!plan.ok) {
        retainFailure(plan.entry, plan.error, 'revalidate');
        continue;
      }
      const subject = `bundle document ${JSON.stringify(plan.entry.relativePath)}`;
      try {
        assertSafeReportedByteLength(plan.stat, BUNDLE_READ_LIMITS.maxDocumentBytes, subject);
      } catch (error) {
        retainFailure(
          plan.entry,
          safeErrorDetail(error),
          'revalidate the size of',
          'resource-limit',
        );
        continue;
      }
      const nextTotal = addBytesWithinLimit(
        freshReportedBytes,
        plan.stat.size,
        BUNDLE_READ_LIMITS.maxTotalDocumentBytes,
      );
      if (nextTotal === undefined) {
        throw readSafetyError(
          `OKF Workbench refused to load the selected bundle because freshly reported Markdown content exceeds the ${String(BUNDLE_READ_LIMITS.maxTotalDocumentBytes)}-byte cumulative safety limit.`,
        );
      }
      freshReportedBytes = nextTotal;
      freshReadable.push(plan);
    }

    const outcomes = await runInDeterministicBatches(
      freshReadable,
      BUNDLE_READ_LIMITS.maxConcurrentReads,
      async ({ entry, stat }): Promise<ReadResult<TUri>> => {
        throwIfAborted(signal);
        let content: Uint8Array;
        try {
          content = await port.read(entry.uri, {
            expectedIdentity: stat.readIdentity,
          });
        } catch (error) {
          throwIfAborted(signal);
          return { ok: false, entry, error: safeErrorDetail(error), reason: 'read' };
        }
        try {
          assertSafeActualByteLength(
            content,
            BUNDLE_READ_LIMITS.maxDocumentBytes,
            `bundle document ${JSON.stringify(entry.relativePath)}`,
          );
        } catch (error) {
          return {
            ok: false,
            entry,
            error: safeErrorDetail(error),
            reason: 'resource-limit',
            actualByteLength: content.byteLength,
          };
        }
        throwIfAborted(signal);
        return { ok: true, entry, content };
      },
      signal,
    );

    const unavailableParents = await readParentAccessFailures(
      freshReadable.map(({ entry }) => entry.parentChain),
      port,
      uris,
      signal,
    );
    await assertSafeBundleDirectoryChain(
      port,
      uris,
      workspaceSafetyRoot,
      root,
      signal,
      directoryChain,
    );

    for (const outcome of outcomes) {
      const materializedByteLength = outcome.ok
        ? outcome.content.byteLength
        : (outcome.actualByteLength ?? 0);
      const nextActualTotal = addBytesWithinLimit(
        actualBytes,
        materializedByteLength,
        BUNDLE_READ_LIMITS.maxTotalDocumentBytes,
      );
      if (nextActualTotal === undefined) {
        throw readSafetyError(
          `OKF Workbench refused to retain the selected bundle because the provider returned more than the ${String(BUNDLE_READ_LIMITS.maxTotalDocumentBytes)}-byte cumulative Markdown safety limit.`,
        );
      }
      actualBytes = nextActualTotal;
      const parentFailure = unavailableParents.get(
        readParentChainKey(outcome.entry.parentChain, uris),
      );
      if (parentFailure !== undefined) {
        retainFailure(outcome.entry, parentFailure, 'revalidate the parent of');
        continue;
      }
      if (!outcome.ok) {
        retainFailure(outcome.entry, outcome.error, 'read', outcome.reason);
        continue;
      }

      const subject = `bundle document ${JSON.stringify(outcome.entry.relativePath)}`;
      assertSafeActualByteLength(outcome.content, BUNDLE_READ_LIMITS.maxDocumentBytes, subject);
      loaded.push({
        uri: outcome.entry.serializedUri,
        bundlePath: outcome.entry.relativePath,
        content: outcome.content,
        contentHash: sha256Content(outcome.content),
      });
    }
  }
  throwIfAborted(signal);
  // Providers do not expose an atomic directory handle spanning URI-first
  // enumeration and reads. Revalidate after every issued read has settled so
  // a mid-load ancestor swap can never publish the resulting bytes.
  await assertSafeBundleDirectoryChain(
    port,
    uris,
    workspaceSafetyRoot,
    root,
    signal,
    directoryChain,
  );

  return {
    rootUri,
    documents: loaded.filter((entry): entry is BundleDocumentInput => !isParseFailure(entry)),
    failures: [...traversalFailures, ...loaded.filter(isParseFailure)].sort(compareFailures),
  };
}

async function inspectRegularFilesWithStableParents<TUri>(
  port: WorkspacePort<TUri>,
  uris: WorkspaceUriCodec<TUri>,
  root: TUri,
  bundleChain: WorkspaceDirectoryChainSnapshot<TUri>,
  entries: readonly BoundedWorkspaceEntry<TUri>[],
  signal: AbortSignal | undefined,
): Promise<PlannedRead<TUri>[]> {
  const planned: PlannedRead<TUri>[] = [];
  for (let start = 0; start < entries.length; start += BUNDLE_READ_LIMITS.maxConcurrentReads) {
    throwIfAborted(signal);
    const batch = entries.slice(start, start + BUNDLE_READ_LIMITS.maxConcurrentReads);
    const parents = new Map<string, TUri>();
    const parentKeys: string[] = [];
    for (const entry of batch) {
      const slash = entry.relativePath.lastIndexOf('/');
      const parent =
        slash < 0 ? root : uris.joinProviderPath(root, entry.relativePath.slice(0, slash));
      const key = uris.serialize(parent);
      parentKeys.push(key);
      parents.set(key, parent);
    }
    const captured = await runInDeterministicBatches(
      [...parents.entries()],
      BUNDLE_READ_LIMITS.maxConcurrentReads,
      async ([key, parent]) => {
        const capture = await captureWorkspaceDirectoryChain(root, parent, port, uris, signal);
        if (!capture.ok) {
          if (capture.failure.reason === 'access' && !uris.equals(capture.failure.uri, root)) {
            return {
              ok: false as const,
              key,
              error: boundedFailureDetail(
                `The document parent could not be inspected. ${capture.failure.message}`,
              ),
            };
          }
          throw new WorkspaceAccessError(
            'unavailable',
            boundedFailureDetail(
              `OKF Workbench refused to read a bundle document because its parent directory is not stable. ${capture.failure.message}`,
            ),
          );
        }
        return { ok: true as const, key, snapshot: capture.snapshot };
      },
      signal,
    );
    const snapshots = new Map(
      captured
        .filter(
          (result): result is Extract<(typeof captured)[number], { readonly ok: true }> =>
            result.ok,
        )
        .map((result) => [result.key, result.snapshot] as const),
    );
    const captureAccessFailures = new Map(
      captured
        .filter(
          (result): result is Extract<(typeof captured)[number], { readonly ok: false }> =>
            !result.ok,
        )
        .map((result) => [result.key, result.error] as const),
    );
    const bound: ParentBoundedWorkspaceEntry<TUri>[] = [];
    for (const [index, entry] of batch.entries()) {
      const key = parentKeys[index];
      const parentChain = key === undefined ? undefined : snapshots.get(key);
      const captureAccessFailure = key === undefined ? undefined : captureAccessFailures.get(key);
      if (captureAccessFailure !== undefined) {
        planned.push({ ok: false, entry, error: captureAccessFailure });
        continue;
      }
      if (parentChain === undefined) {
        throw new WorkspaceAccessError(
          'unavailable',
          'OKF Workbench could not bind a bundle document to its parent directory generation.',
        );
      }
      bound.push({ ...entry, parentChain });
    }

    await assertSafeReadParentChains([bundleChain], port, uris, signal);
    const unavailableBeforeStat = await readParentAccessFailures(
      bound.map(({ parentChain }) => parentChain),
      port,
      uris,
      signal,
    );
    const inspectable = bound.filter((entry) => {
      const parentFailure = unavailableBeforeStat.get(readParentChainKey(entry.parentChain, uris));
      if (parentFailure === undefined) {
        return true;
      }
      planned.push({ ok: false, entry, error: parentFailure });
      return false;
    });
    const inspected = await runInDeterministicBatches(
      inspectable,
      BUNDLE_READ_LIMITS.maxConcurrentReads,
      (entry) => inspectRegularFile(port, entry, signal),
      signal,
    );
    await assertSafeReadParentChains([bundleChain], port, uris, signal);
    const unavailableAfterStat = await readParentAccessFailures(
      inspectable.map(({ parentChain }) => parentChain),
      port,
      uris,
      signal,
    );
    for (const result of inspected) {
      const parentFailure = unavailableAfterStat.get(
        readParentChainKey(result.entry.parentChain, uris),
      );
      planned.push(
        parentFailure === undefined
          ? result
          : { ok: false, entry: result.entry, error: parentFailure },
      );
    }
  }
  return planned;
}

function readParentChainKey<TUri>(
  snapshot: WorkspaceDirectoryChainSnapshot<TUri>,
  uris: WorkspaceUriCodec<TUri>,
): string {
  return `${uris.serialize(snapshot.workspaceSafetyRoot)}\u0000${uris.serialize(snapshot.selectedRoot)}`;
}

async function readParentAccessFailures<TUri>(
  snapshots: readonly WorkspaceDirectoryChainSnapshot<TUri>[],
  port: WorkspacePort<TUri>,
  uris: WorkspaceUriCodec<TUri>,
  signal: AbortSignal | undefined,
): Promise<ReadonlyMap<string, string>> {
  const distinct = new Map<string, WorkspaceDirectoryChainSnapshot<TUri>>();
  for (const snapshot of snapshots) {
    distinct.set(readParentChainKey(snapshot, uris), snapshot);
  }
  const verified = await runInDeterministicBatches(
    [...distinct.entries()],
    BUNDLE_READ_LIMITS.maxConcurrentReads,
    async ([key, snapshot]) => ({
      key,
      snapshot,
      failure: await verifyWorkspaceDirectoryChain(snapshot, port, uris, signal),
    }),
    signal,
  );
  const accessFailures = new Map<string, string>();
  for (const { key, snapshot, failure } of verified) {
    if (failure === undefined) {
      continue;
    }
    if (failure.reason !== 'access' || uris.equals(failure.uri, snapshot.workspaceSafetyRoot)) {
      throw new WorkspaceAccessError(
        'unavailable',
        boundedFailureDetail(
          `OKF Workbench refused to retain a bundle document because its parent directory generation changed. ${failure.message}`,
        ),
      );
    }
    accessFailures.set(
      key,
      boundedFailureDetail(`The document parent could not be revalidated. ${failure.message}`),
    );
  }
  return accessFailures;
}

async function assertSafeReadParentChains<TUri>(
  snapshots: readonly WorkspaceDirectoryChainSnapshot<TUri>[],
  port: WorkspacePort<TUri>,
  uris: WorkspaceUriCodec<TUri>,
  signal: AbortSignal | undefined,
): Promise<void> {
  const distinct = new Map<string, WorkspaceDirectoryChainSnapshot<TUri>>();
  for (const snapshot of snapshots) {
    distinct.set(
      `${uris.serialize(snapshot.workspaceSafetyRoot)}\u0000${uris.serialize(snapshot.selectedRoot)}`,
      snapshot,
    );
  }
  const failures = await runInDeterministicBatches(
    [...distinct.values()],
    BUNDLE_READ_LIMITS.maxConcurrentReads,
    (snapshot) => verifyWorkspaceDirectoryChain(snapshot, port, uris, signal),
    signal,
  );
  const failure = failures.find((candidate) => candidate !== undefined);
  if (failure !== undefined) {
    throw new WorkspaceAccessError(
      'unavailable',
      boundedFailureDetail(
        `OKF Workbench refused to retain a bundle document because its parent directory generation changed. ${failure.message}`,
      ),
    );
  }
}

async function inspectRegularFile<TUri>(
  port: WorkspacePort<TUri>,
  entry: ParentBoundedWorkspaceEntry<TUri>,
  signal: AbortSignal | undefined,
): Promise<ParentPlannedRead<TUri>> {
  let stat: WorkspaceStat | undefined;
  try {
    stat = await port.stat(entry.uri);
    throwIfAborted(signal);
  } catch (error) {
    throwIfAborted(signal);
    return { ok: false, entry, error: safeErrorDetail(error) };
  }
  if (stat?.type === 'symbolic-link') {
    throw readSafetyError(
      `OKF Workbench refused to read bundle document ${JSON.stringify(entry.relativePath)} because it became a symbolic link after traversal.`,
    );
  }
  if (stat?.type !== 'file') {
    return {
      ok: false,
      entry,
      error:
        stat === undefined
          ? 'The document no longer exists.'
          : `The document is now a ${stat.type}, not a regular file.`,
    };
  }
  return { ok: true, entry, stat };
}

function isParseFailure(value: BundleDocumentInput | ParseFailure): value is ParseFailure {
  return 'kind' in value && value.kind === 'parse-failure';
}

function compareFailures(left: ParseFailure, right: ParseFailure): number {
  return (
    compareText(left.bundlePath, right.bundlePath) ||
    compareText(left.uri, right.uri) ||
    compareText(left.reason, right.reason)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function runInDeterministicBatches<TInput, TOutput>(
  inputs: readonly TInput[],
  concurrency: number,
  action: (input: TInput) => Promise<TOutput>,
  signal: AbortSignal | undefined,
): Promise<TOutput[]> {
  const outputs: TOutput[] = [];
  for (let start = 0; start < inputs.length; start += concurrency) {
    throwIfAborted(signal);
    const settled = await Promise.allSettled(
      inputs.slice(start, start + concurrency).map((input) => action(input)),
    );
    throwIfAborted(signal);
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        throw outcome.reason;
      }
      outputs.push(outcome.value);
    }
  }
  return outputs;
}

function assertBoundedProviderIdentity(
  value: string,
  subject: string,
  kind: 'path' | 'uri',
): number {
  const maxCodeUnits =
    kind === 'path'
      ? OKF_SEMANTIC_LIMITS.maxProviderPathCodeUnits
      : OKF_SEMANTIC_LIMITS.maxSourceUriCodeUnits;
  const maxBytes =
    kind === 'path'
      ? OKF_SEMANTIC_LIMITS.maxProviderPathBytes
      : OKF_SEMANTIC_LIMITS.maxSourceUriBytes;
  if (value.length > maxCodeUnits) {
    throw readSafetyError(
      `OKF Workbench refused to retain a ${subject} longer than the ${String(maxCodeUnits)}-code-unit identity safety limit.`,
    );
  }
  if (kind === 'path') {
    let segments = value.length === 0 ? 0 : 1;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code === 0x2f || code === 0x5c) {
        segments += 1;
        if (segments > OKF_SEMANTIC_LIMITS.maxProviderPathSegments) {
          throw readSafetyError(
            `OKF Workbench refused to retain a ${subject} deeper than the ${String(OKF_SEMANTIC_LIMITS.maxProviderPathSegments)}-segment identity safety limit.`,
          );
        }
      }
    }
  }
  const byteLength = utf8Encoder.encode(value).byteLength;
  if (byteLength > maxBytes) {
    throw readSafetyError(
      `OKF Workbench refused to retain a ${subject} larger than the ${String(maxBytes)}-byte identity safety limit.`,
    );
  }
  return byteLength;
}

function boundedFailureDetail(message: string): string {
  if (message.length <= OKF_SEMANTIC_LIMITS.maxFailureDetailCodeUnits) {
    return message;
  }
  let end = OKF_SEMANTIC_LIMITS.maxFailureDetailCodeUnits - 1;
  const finalCodeUnit = message.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    end -= 1;
  }
  return `${message.slice(0, end)}…`;
}

function safeErrorDetail(error: unknown): string {
  return boundedFailureDetail(
    error instanceof Error ? error.message : 'The workspace provider rejected the operation.',
  );
}
