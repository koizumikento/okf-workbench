import type {
  BrokenLinkPresentation,
  GraphEdge,
  GraphNode,
  GraphPayload,
  GraphStatistics,
  SourcePosition,
  SourceRange,
} from '../../core/model/types.js';
import {
  PROTOCOL_VERSION,
  type ExtensionToWebviewMessage,
  type GraphRenderFailureReason,
  type ProtocolDecodeError,
  type ProtocolDecodeResult,
  type WebviewStatus,
  type WebviewToExtensionMessage,
} from './messages.js';

const MAX_ACTION_ID_LENGTH = 4_096;
const MAX_STATUS_MESSAGE_LENGTH = 4_096;

type UnknownRecord = Readonly<Record<string, unknown>>;

function fail<T>(code: ProtocolDecodeError['code'], message: string): ProtocolDecodeResult<T> {
  return { ok: false, error: { code, message } };
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalString(value: UnknownRecord, key: string): boolean {
  return !Object.hasOwn(value, key) || typeof value[key] === 'string';
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isSourcePosition(value: unknown): value is SourcePosition {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['offset', 'line', 'character']) &&
    isNonNegativeSafeInteger(value.offset) &&
    isNonNegativeSafeInteger(value.line) &&
    isNonNegativeSafeInteger(value.character)
  );
}

function isSourceRange(value: unknown): value is SourceRange {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['start', 'end']) &&
    isSourcePosition(value.start) &&
    isSourcePosition(value.end)
  );
}

function isGraphNode(value: unknown): value is GraphNode {
  return (
    isRecord(value) &&
    hasOnlyKeys(
      value,
      ['id', 'type', 'tags', 'orphan', 'brokenLinkCount'],
      ['title', 'description', 'resource', 'timestamp'],
    ) &&
    isNonEmptyString(value.id) &&
    typeof value.type === 'string' &&
    isStringArray(value.tags) &&
    typeof value.orphan === 'boolean' &&
    isNonNegativeSafeInteger(value.brokenLinkCount) &&
    isOptionalString(value, 'title') &&
    isOptionalString(value, 'description') &&
    isOptionalString(value, 'resource') &&
    isOptionalString(value, 'timestamp')
  );
}

function isGraphEdge(value: unknown): value is GraphEdge {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['id', 'source', 'target', 'sourceRange']) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.source) &&
    isNonEmptyString(value.target) &&
    isSourceRange(value.sourceRange)
  );
}

function isBrokenLink(value: unknown): value is BrokenLinkPresentation {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['sourceId', 'label', 'rawTarget', 'sourceRange']) &&
    isNonEmptyString(value.sourceId) &&
    typeof value.label === 'string' &&
    isNonEmptyString(value.rawTarget) &&
    isSourceRange(value.sourceRange)
  );
}

function isCountRecord(value: unknown): value is Readonly<Record<string, number>> {
  return isRecord(value) && Object.values(value).every(isNonNegativeSafeInteger);
}

function isGraphStatistics(value: unknown): value is GraphStatistics {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'conceptCount',
      'edgeCount',
      'orphanCount',
      'brokenLinkCount',
      'typeCounts',
      'tagCounts',
    ]) &&
    isNonNegativeSafeInteger(value.conceptCount) &&
    isNonNegativeSafeInteger(value.edgeCount) &&
    isNonNegativeSafeInteger(value.orphanCount) &&
    isNonNegativeSafeInteger(value.brokenLinkCount) &&
    isCountRecord(value.typeCounts) &&
    isCountRecord(value.tagCounts)
  );
}

function isBacklinks(value: unknown): value is Readonly<Record<string, readonly string[]>> {
  return isRecord(value) && Object.values(value).every(isStringArray);
}

function hasValidGraphReferences(payload: GraphPayload): boolean {
  const nodeIds = new Set(payload.nodes.map((node) => node.id));
  if (nodeIds.size !== payload.nodes.length) {
    return false;
  }

  if (payload.edges.some((edge) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target))) {
    return false;
  }

  if (
    Object.entries(payload.backlinks).some(
      ([target, sources]) => !nodeIds.has(target) || sources.some((source) => !nodeIds.has(source)),
    )
  ) {
    return false;
  }

  return payload.brokenLinks.every((link) => nodeIds.has(link.sourceId));
}

export function isGraphPayload(value: unknown): value is GraphPayload {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'protocolVersion',
      'revision',
      'nodes',
      'edges',
      'backlinks',
      'brokenLinks',
      'statistics',
    ]) ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    !isNonNegativeSafeInteger(value.revision) ||
    !Array.isArray(value.nodes) ||
    !value.nodes.every(isGraphNode) ||
    !Array.isArray(value.edges) ||
    !value.edges.every(isGraphEdge) ||
    !isBacklinks(value.backlinks) ||
    !Array.isArray(value.brokenLinks) ||
    !value.brokenLinks.every(isBrokenLink) ||
    !isGraphStatistics(value.statistics)
  ) {
    return false;
  }

  const decoded: GraphPayload = {
    protocolVersion: PROTOCOL_VERSION,
    revision: value.revision,
    nodes: value.nodes,
    edges: value.edges,
    backlinks: value.backlinks,
    brokenLinks: value.brokenLinks,
    statistics: value.statistics,
  };
  return hasValidGraphReferences(decoded);
}

function validEnvelope(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return hasOnlyKeys(value, ['protocolVersion', 'type', ...required], optional);
}

function isStatus(value: unknown): value is WebviewStatus {
  return value === 'loading' || value === 'ready' || value === 'error';
}

function isGraphRenderFailureReason(value: unknown): value is GraphRenderFailureReason {
  return value === 'renderer-construction-failed' || value === 'renderer-update-failed';
}

/** Decode an extension-host message and reject graph/status revisions older than the currently displayed graph. */
export function decodeExtensionToWebviewMessage(
  value: unknown,
  currentRevision: number,
): ProtocolDecodeResult<ExtensionToWebviewMessage> {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return fail('invalid-envelope', 'Expected an object with a message type.');
  }
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    return fail('unsupported-version', 'The message protocol version is not supported.');
  }

  if (value.type === 'replaceGraph') {
    if (
      !validEnvelope(value, ['revision', 'payload']) ||
      !isNonNegativeSafeInteger(value.revision) ||
      !isGraphPayload(value.payload) ||
      value.revision !== value.payload.revision
    ) {
      return fail('invalid-payload', 'The replacement graph payload is invalid.');
    }
    if (value.revision < currentRevision) {
      return fail('stale-revision', 'The replacement graph revision is stale.');
    }
    return {
      ok: true,
      value: {
        protocolVersion: PROTOCOL_VERSION,
        type: 'replaceGraph',
        revision: value.revision,
        payload: value.payload,
      },
    };
  }

  if (value.type === 'status') {
    if (
      !validEnvelope(value, ['revision', 'status'], ['message']) ||
      !isNonNegativeSafeInteger(value.revision) ||
      !isStatus(value.status) ||
      !isOptionalString(value, 'message') ||
      (typeof value.message === 'string' && value.message.length > MAX_STATUS_MESSAGE_LENGTH)
    ) {
      return fail('invalid-payload', 'The Webview status payload is invalid.');
    }
    if (value.revision < currentRevision) {
      return fail('stale-revision', 'The status revision is stale.');
    }
    const decoded = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'status' as const,
      revision: value.revision,
      status: value.status,
    };
    return typeof value.message === 'string'
      ? { ok: true, value: { ...decoded, message: value.message } }
      : { ok: true, value: decoded };
  }

  return fail('unknown-message', 'The extension message type is unknown.');
}

/** Decode a Webview action. Open-source actions are accepted only for the host's current graph revision. */
export function decodeWebviewToExtensionMessage(
  value: unknown,
  expectedRevision: number,
): ProtocolDecodeResult<WebviewToExtensionMessage> {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return fail('invalid-envelope', 'Expected an object with a message type.');
  }
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    return fail('unsupported-version', 'The message protocol version is not supported.');
  }

  if (value.type === 'ready') {
    return validEnvelope(value, [])
      ? { ok: true, value: { protocolVersion: PROTOCOL_VERSION, type: 'ready' } }
      : fail('invalid-payload', 'The ready payload is invalid.');
  }

  if (value.type === 'graphRendered') {
    if (!validEnvelope(value, ['revision']) || !isNonNegativeSafeInteger(value.revision)) {
      return fail('invalid-payload', 'The rendered-graph payload is invalid.');
    }
    if (value.revision !== expectedRevision) {
      return fail(
        'stale-revision',
        'The rendered-graph acknowledgement does not match the current graph revision.',
      );
    }
    return {
      ok: true,
      value: {
        protocolVersion: PROTOCOL_VERSION,
        type: 'graphRendered',
        revision: value.revision,
      },
    };
  }

  if (value.type === 'graphRenderFailed') {
    if (
      !validEnvelope(value, ['revision', 'reason']) ||
      !isNonNegativeSafeInteger(value.revision) ||
      !isGraphRenderFailureReason(value.reason)
    ) {
      return fail('invalid-payload', 'The graph-render failure payload is invalid.');
    }
    if (value.revision !== expectedRevision) {
      return fail(
        'stale-revision',
        'The graph-render failure does not match the current graph revision.',
      );
    }
    return {
      ok: true,
      value: {
        protocolVersion: PROTOCOL_VERSION,
        type: 'graphRenderFailed',
        revision: value.revision,
        reason: value.reason,
      },
    };
  }

  if (value.type === 'openSource') {
    if (
      !validEnvelope(value, ['revision', 'nodeId']) ||
      !isNonNegativeSafeInteger(value.revision) ||
      !isNonEmptyString(value.nodeId) ||
      value.nodeId.length > MAX_ACTION_ID_LENGTH
    ) {
      return fail('invalid-payload', 'The open-source payload is invalid.');
    }
    if (value.revision !== expectedRevision) {
      return fail(
        'stale-revision',
        'The open-source action does not match the current graph revision.',
      );
    }
    return {
      ok: true,
      value: {
        protocolVersion: PROTOCOL_VERSION,
        type: 'openSource',
        revision: value.revision,
        nodeId: value.nodeId,
      },
    };
  }

  return fail('unknown-message', 'The Webview message type is unknown.');
}
