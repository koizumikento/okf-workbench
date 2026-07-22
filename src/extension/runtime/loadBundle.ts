import type { BundleDocumentInput } from '../../core/parser/index.js';
import type { ParseFailure } from '../../core/model/index.js';
import { sha256Content } from '../workspace/contentHash.js';
import {
  WorkspaceAccessError,
  type WorkspaceEntry,
  type WorkspacePort,
} from '../workspace/types.js';
import type { WorkspaceUriCodec } from '../workspace/uriCodec.js';

export interface LoadedBundleInput {
  readonly rootUri: string;
  readonly documents: readonly BundleDocumentInput[];
  readonly failures: readonly ParseFailure[];
}

/** Streams and reads a logical bundle without assuming file-scheme resources. */
export async function loadBundle<TUri>(
  port: WorkspacePort<TUri>,
  uris: WorkspaceUriCodec<TUri>,
  root: TUri,
  signal?: AbortSignal,
): Promise<LoadedBundleInput> {
  throwIfAborted(signal);
  const entries: WorkspaceEntry<TUri>[] = [];
  const traversalFailures: ParseFailure[] = [];
  for await (const event of port.traverse(root, { includeDirectories: false })) {
    throwIfAborted(signal);
    if (event.kind === 'failure') {
      if (event.relativePath.length === 0) {
        throw new WorkspaceAccessError('unavailable', event.message);
      }
      traversalFailures.push({
        kind: 'parse-failure',
        uri: uris.serialize(event.uri),
        bundlePath: event.relativePath,
        reason: 'read',
        message: `Unable to enumerate bundle subtree ${JSON.stringify(event.relativePath)}: ${event.message}`,
      });
      continue;
    }

    const entry = event.entry;
    if (entry.type === 'file' && entry.relativePath.endsWith('.md')) {
      entries.push(entry);
    }
  }
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  throwIfAborted(signal);

  const loaded = await Promise.all(
    entries.map(async (entry): Promise<BundleDocumentInput | ParseFailure> => {
      throwIfAborted(signal);
      try {
        const content = await port.read(entry.uri);
        throwIfAborted(signal);
        return {
          uri: uris.serialize(entry.uri),
          bundlePath: entry.relativePath,
          content,
          contentHash: sha256Content(content),
        };
      } catch (error) {
        throwIfAborted(signal);
        const detail =
          error instanceof Error ? error.message : 'The workspace provider rejected the read.';
        return {
          kind: 'parse-failure',
          uri: uris.serialize(entry.uri),
          bundlePath: entry.relativePath,
          reason: 'read',
          message: `Unable to read bundle document ${JSON.stringify(entry.relativePath)}: ${detail}`,
        };
      }
    }),
  );
  throwIfAborted(signal);

  return {
    rootUri: uris.serialize(root),
    documents: loaded.filter((entry): entry is BundleDocumentInput => !isParseFailure(entry)),
    failures: [...traversalFailures, ...loaded.filter(isParseFailure)].sort(compareFailures),
  };
}

function isParseFailure(value: BundleDocumentInput | ParseFailure): value is ParseFailure {
  return 'kind' in value && value.kind === 'parse-failure';
}

function compareFailures(left: ParseFailure, right: ParseFailure): number {
  return (
    left.bundlePath.localeCompare(right.bundlePath) ||
    left.uri.localeCompare(right.uri) ||
    left.reason.localeCompare(right.reason)
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) {
    return;
  }
  throw signal.reason instanceof Error ? signal.reason : new Error('Bundle refresh was canceled.');
}
