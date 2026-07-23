import { OKF_SEMANTIC_LIMITS } from '../../core/model/index.js';
import { throwIfAborted } from './readSafety.js';
import {
  sameWorkspaceReadIdentity,
  type WorkspacePort,
  type WorkspaceReadIdentity,
  type WorkspaceStat,
} from './types.js';
import type { WorkspaceUriCodec } from './uriCodec.js';

export interface WorkspaceDirectoryChainFailure<TUri> {
  readonly uri: TUri;
  readonly reason: 'access' | 'generation-changed' | 'unsafe-path';
  readonly message: string;
}

export interface WorkspaceDirectoryChainSnapshot<TUri> {
  readonly workspaceSafetyRoot: TUri;
  readonly selectedRoot: TUri;
  readonly segments: readonly {
    readonly uri: TUri;
    readonly serializedUri: string;
    readonly identity?: WorkspaceReadIdentity;
  }[];
}

export type WorkspaceDirectoryChainCapture<TUri> =
  | { readonly ok: true; readonly snapshot: WorkspaceDirectoryChainSnapshot<TUri> }
  | { readonly ok: false; readonly failure: WorkspaceDirectoryChainFailure<TUri> };

export type WorkspaceOptionalResourceParentCapture<TUri> =
  | {
      readonly ok: true;
      readonly parentExists: true;
      readonly snapshot: WorkspaceDirectoryChainSnapshot<TUri>;
    }
  | {
      readonly ok: true;
      readonly parentExists: false;
      readonly snapshot: WorkspaceDirectoryChainSnapshot<TUri>;
    }
  | { readonly ok: false; readonly failure: WorkspaceDirectoryChainFailure<TUri> };

const utf8Encoder = new TextEncoder();

function unsafeSegmentMessage(uri: string, stat: WorkspaceStat | undefined): string {
  if (stat === undefined) {
    return `The workspace path segment ${uri} no longer exists.`;
  }
  if (stat.type === 'symbolic-link') {
    return `Refusing to use the symbolic-link workspace path segment ${uri}.`;
  }
  return `Refusing to use the workspace path segment ${uri} because it is not a directory.`;
}

/**
 * Revalidates a selected directory from its containing workspace root without
 * assuming a `file:` URI or following host filesystem aliases.
 */
export async function inspectWorkspaceDirectoryChain<TUri>(
  workspaceSafetyRoot: TUri,
  selectedRoot: TUri,
  port: WorkspacePort<TUri>,
  uris: WorkspaceUriCodec<TUri>,
  signal?: AbortSignal,
): Promise<WorkspaceDirectoryChainFailure<TUri> | undefined> {
  const capture = await captureWorkspaceDirectoryChain(
    workspaceSafetyRoot,
    selectedRoot,
    port,
    uris,
    signal,
  );
  return capture.ok ? undefined : capture.failure;
}

/**
 * Captures the generation of every real directory from the workspace safety
 * root through the selected root. Native file generations include dev/ino and
 * nanosecond ctime, so rename/symlink/restore cycles cannot pass as unchanged.
 */
export async function captureWorkspaceDirectoryChain<TUri>(
  workspaceSafetyRoot: TUri,
  selectedRoot: TUri,
  port: WorkspacePort<TUri>,
  uris: WorkspaceUriCodec<TUri>,
  signal?: AbortSignal,
): Promise<WorkspaceDirectoryChainCapture<TUri>> {
  throwIfAborted(signal);
  for (const [uri, subject] of [
    [workspaceSafetyRoot, 'workspace safety root'],
    [selectedRoot, 'selected root'],
  ] as const) {
    const serialized = uris.serialize(uri);
    if (
      serialized.length > OKF_SEMANTIC_LIMITS.maxSourceUriCodeUnits ||
      utf8Encoder.encode(serialized).byteLength > OKF_SEMANTIC_LIMITS.maxSourceUriBytes
    ) {
      return {
        ok: false,
        failure: {
          uri,
          reason: 'unsafe-path',
          message: `The ${subject} exceeds the workspace URI identity safety limit.`,
        },
      };
    }
  }
  let segments: readonly TUri[];
  try {
    segments = uris.containedPathSegments(workspaceSafetyRoot, selectedRoot);
  } catch (error) {
    return {
      ok: false,
      failure: {
        uri: selectedRoot,
        reason: 'unsafe-path',
        message:
          error instanceof Error
            ? error.message
            : 'The selected directory is outside its workspace safety root.',
      },
    };
  }

  const captured: WorkspaceDirectoryChainSnapshot<TUri>['segments'][number][] = [];
  for (const uri of segments) {
    throwIfAborted(signal);
    let stat: WorkspaceStat | undefined;
    try {
      stat = await port.stat(uri);
    } catch (error) {
      return {
        ok: false,
        failure: {
          uri,
          reason: 'access',
          message:
            error instanceof Error
              ? error.message
              : `The workspace path segment ${uris.serialize(uri)} could not be inspected.`,
        },
      };
    }
    throwIfAborted(signal);
    if (stat?.type !== 'directory') {
      return {
        ok: false,
        failure: {
          uri,
          reason: 'generation-changed',
          message: unsafeSegmentMessage(uris.serialize(uri), stat),
        },
      };
    }
    captured.push({
      uri,
      serializedUri: uris.serialize(uri),
      ...(stat.readIdentity === undefined ? {} : { identity: stat.readIdentity }),
    });
  }
  const snapshot: WorkspaceDirectoryChainSnapshot<TUri> = {
    workspaceSafetyRoot,
    selectedRoot,
    segments: captured,
  };
  const changedDuringCapture = await verifyWorkspaceDirectoryChain(snapshot, port, uris, signal);
  if (changedDuringCapture !== undefined) {
    return { ok: false, failure: changedDuringCapture };
  }
  return { ok: true, snapshot };
}

/**
 * Captures a stable directory chain through the parent of one resource.
 * Callers must still verify the returned snapshot after the resource stat and
 * again after its identity-bound read.
 */
export async function captureWorkspaceResourceParentChain<TUri>(
  workspaceSafetyRoot: TUri,
  resource: TUri,
  port: WorkspacePort<TUri>,
  uris: WorkspaceUriCodec<TUri>,
  signal?: AbortSignal,
): Promise<WorkspaceDirectoryChainCapture<TUri>> {
  let segments: readonly TUri[];
  try {
    segments = uris.containedPathSegments(workspaceSafetyRoot, resource);
  } catch (error) {
    return {
      ok: false,
      failure: {
        uri: resource,
        reason: 'unsafe-path',
        message:
          error instanceof Error
            ? error.message
            : 'The workspace resource is outside its safety root.',
      },
    };
  }
  const parent = segments.at(-2);
  if (parent === undefined) {
    return {
      ok: false,
      failure: {
        uri: resource,
        reason: 'unsafe-path',
        message: 'The workspace resource does not have a contained parent directory.',
      },
    };
  }
  return captureWorkspaceDirectoryChain(workspaceSafetyRoot, parent, port, uris, signal);
}

/**
 * Captures the stable existing portion of a resource's parent chain. When a
 * parent suffix is absent, the suffix is rechecked after the existing baseline
 * is captured and callers receive an absence result without probing or reading
 * the resource through a path that did not exist at the baseline.
 */
export async function captureWorkspaceOptionalResourceParentChain<TUri>(
  workspaceSafetyRoot: TUri,
  resource: TUri,
  port: WorkspacePort<TUri>,
  uris: WorkspaceUriCodec<TUri>,
  signal?: AbortSignal,
): Promise<WorkspaceOptionalResourceParentCapture<TUri>> {
  let segments: readonly TUri[];
  try {
    segments = uris.containedPathSegments(workspaceSafetyRoot, resource);
  } catch (error) {
    return {
      ok: false,
      failure: {
        uri: resource,
        reason: 'unsafe-path',
        message:
          error instanceof Error
            ? error.message
            : 'The workspace resource is outside its safety root.',
      },
    };
  }
  const parents = segments.slice(0, -1);
  if (parents.length === 0) {
    return {
      ok: false,
      failure: {
        uri: resource,
        reason: 'unsafe-path',
        message: 'The workspace resource does not have a contained parent directory.',
      },
    };
  }

  let firstMissingIndex: number | undefined;
  for (let index = 0; index < parents.length; index += 1) {
    const uri = parents[index];
    if (uri === undefined) {
      continue;
    }
    throwIfAborted(signal);
    let stat: WorkspaceStat | undefined;
    try {
      stat = await port.stat(uri);
    } catch (error) {
      return {
        ok: false,
        failure: {
          uri,
          reason: 'access',
          message:
            error instanceof Error
              ? error.message
              : `The workspace path segment ${uris.serialize(uri)} could not be inspected.`,
        },
      };
    }
    throwIfAborted(signal);
    if (stat === undefined) {
      firstMissingIndex = index;
      break;
    }
    if (stat.type !== 'directory') {
      return {
        ok: false,
        failure: {
          uri,
          reason: 'generation-changed',
          message: unsafeSegmentMessage(uris.serialize(uri), stat),
        },
      };
    }
  }

  const deepestExistingParent =
    parents[firstMissingIndex === undefined ? parents.length - 1 : firstMissingIndex - 1];
  if (deepestExistingParent === undefined) {
    return {
      ok: false,
      failure: {
        uri: workspaceSafetyRoot,
        reason: 'generation-changed',
        message: 'The workspace safety root no longer exists.',
      },
    };
  }
  const capture = await captureWorkspaceDirectoryChain(
    workspaceSafetyRoot,
    deepestExistingParent,
    port,
    uris,
    signal,
  );
  if (!capture.ok || firstMissingIndex === undefined) {
    return capture.ok ? { ok: true, parentExists: true, snapshot: capture.snapshot } : capture;
  }

  for (const uri of parents.slice(firstMissingIndex)) {
    throwIfAborted(signal);
    let stat: WorkspaceStat | undefined;
    try {
      stat = await port.stat(uri);
    } catch (error) {
      return {
        ok: false,
        failure: {
          uri,
          reason: 'access',
          message:
            error instanceof Error
              ? error.message
              : `The workspace path segment ${uris.serialize(uri)} could not be revalidated.`,
        },
      };
    }
    throwIfAborted(signal);
    if (stat !== undefined) {
      return {
        ok: false,
        failure: {
          uri,
          reason: 'generation-changed',
          message: 'The workspace resource parent chain changed during the operation.',
        },
      };
    }
  }
  const changedExistingChain = await verifyWorkspaceDirectoryChain(
    capture.snapshot,
    port,
    uris,
    signal,
  );
  if (changedExistingChain !== undefined) {
    return { ok: false, failure: changedExistingChain };
  }
  return { ok: true, parentExists: false, snapshot: capture.snapshot };
}

export async function verifyWorkspaceDirectoryChain<TUri>(
  expected: WorkspaceDirectoryChainSnapshot<TUri>,
  port: WorkspacePort<TUri>,
  uris: WorkspaceUriCodec<TUri>,
  signal?: AbortSignal,
): Promise<WorkspaceDirectoryChainFailure<TUri> | undefined> {
  for (let index = 0; index < expected.segments.length; index += 1) {
    const before = expected.segments[index];
    if (before === undefined) {
      return {
        uri: expected.selectedRoot,
        reason: 'generation-changed',
        message: 'The selected workspace directory chain changed during the operation.',
      };
    }
    throwIfAborted(signal);
    let afterStat: WorkspaceStat | undefined;
    try {
      afterStat = await port.stat(before.uri);
    } catch (error) {
      return {
        uri: before.uri,
        reason: 'access',
        message:
          error instanceof Error
            ? error.message
            : 'The selected workspace directory could not be revalidated.',
      };
    }
    throwIfAborted(signal);
    const afterSerialized = uris.serialize(before.uri);
    if (
      afterStat?.type !== 'directory' ||
      before.serializedUri !== afterSerialized ||
      !sameWorkspaceReadIdentity(before.identity, afterStat.readIdentity)
    ) {
      return {
        uri: before.uri,
        reason: 'generation-changed',
        message: 'The selected workspace directory generation changed during the operation.',
      };
    }
  }
  return undefined;
}
