import type {
  BrokenLinkPresentation,
  GraphEdge,
  GraphNode,
  GraphPayload,
  GraphStatistics,
  SourcePosition,
  SourceRange,
} from '../../core/model/types.js';
import { OKF_SEMANTIC_LIMITS, utf8ByteLength } from '../../core/model/index.js';
import { graphPayloadJsonByteLength } from '../../core/graph/index.js';
import {
  PROTOCOL_VERSION,
  type ExtensionToWebviewMessage,
  type GraphDeliveryIdentity,
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

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isOptionalString(value: UnknownRecord, key: string): boolean {
  return !Object.hasOwn(value, key) || typeof value[key] === 'string';
}

function isBoundedString(value: unknown, maxCodeUnits: number, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length <= maxCodeUnits &&
    utf8ByteLength(value, maxBytes) <= maxBytes
  );
}

function isOptionalBoundedString(value: UnknownRecord, key: string, maxCodeUnits: number): boolean {
  return !Object.hasOwn(value, key) || isBoundedString(value[key], maxCodeUnits, maxCodeUnits * 3);
}

function isDenseArray<T>(
  value: unknown,
  predicate: (entry: unknown) => entry is T,
): value is readonly T[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || !predicate(value[index])) {
      return false;
    }
  }
  return true;
}

function pathSegmentCount(value: string): number {
  let segments = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 0x2f) segments += 1;
  }
  return segments;
}

function isGraphIdentity(value: unknown): value is string {
  return (
    isBoundedString(
      value,
      OKF_SEMANTIC_LIMITS.maxProviderPathCodeUnits,
      OKF_SEMANTIC_LIMITS.maxProviderPathBytes,
    ) &&
    value.length > 0 &&
    pathSegmentCount(value) <= OKF_SEMANTIC_LIMITS.maxProviderPathSegments
  );
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
    isSourcePosition(value.end) &&
    value.start.offset <= value.end.offset
  );
}

function isGraphNode(value: unknown): value is GraphNode {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      ['id', 'type', 'tags', 'orphan', 'brokenLinkCount'],
      ['sourceFailed', 'title', 'description', 'resource', 'timestamp'],
    ) ||
    !isGraphIdentity(value.id) ||
    !isBoundedString(
      value.type,
      OKF_SEMANTIC_LIMITS.maxTypeCodeUnits,
      OKF_SEMANTIC_LIMITS.maxTypeBytes,
    ) ||
    !isDenseArray(value.tags, (tag): tag is string => typeof tag === 'string') ||
    value.tags.length > OKF_SEMANTIC_LIMITS.maxTagsPerConcept ||
    typeof value.orphan !== 'boolean' ||
    !isNonNegativeSafeInteger(value.brokenLinkCount) ||
    !isOptionalBoundedString(value, 'title', OKF_SEMANTIC_LIMITS.maxTitleCodeUnits) ||
    !isOptionalBoundedString(value, 'description', OKF_SEMANTIC_LIMITS.maxDescriptionCodeUnits) ||
    !isOptionalBoundedString(value, 'resource', OKF_SEMANTIC_LIMITS.maxResourceCodeUnits) ||
    !isOptionalBoundedString(value, 'timestamp', OKF_SEMANTIC_LIMITS.maxTimestampCodeUnits)
  ) {
    return false;
  }
  for (const tag of value.tags) {
    if (
      !isBoundedString(tag, OKF_SEMANTIC_LIMITS.maxTagCodeUnits, OKF_SEMANTIC_LIMITS.maxTagBytes)
    ) {
      return false;
    }
  }
  if (Object.hasOwn(value, 'sourceFailed')) {
    return (
      value.sourceFailed === true &&
      value.type === '' &&
      value.tags.length === 0 &&
      value.orphan === false &&
      value.brokenLinkCount === 0 &&
      !Object.hasOwn(value, 'title') &&
      !Object.hasOwn(value, 'description') &&
      !Object.hasOwn(value, 'resource') &&
      !Object.hasOwn(value, 'timestamp')
    );
  }
  return true;
}

function isGraphEdge(value: unknown): value is GraphEdge {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['id', 'source', 'target', 'sourceRange']) &&
    isBoundedString(
      value.id,
      OKF_SEMANTIC_LIMITS.maxCompactGraphEdgeIdCodeUnits,
      OKF_SEMANTIC_LIMITS.maxCompactGraphEdgeIdCodeUnits * 3,
    ) &&
    value.id.length > 0 &&
    isGraphIdentity(value.source) &&
    isGraphIdentity(value.target) &&
    isSourceRange(value.sourceRange)
  );
}

function isBrokenLink(value: unknown): value is BrokenLinkPresentation {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['sourceId', 'label', 'rawTarget', 'sourceRange']) &&
    isGraphIdentity(value.sourceId) &&
    isBoundedString(
      value.label,
      OKF_SEMANTIC_LIMITS.maxLinkLabelCodeUnits,
      OKF_SEMANTIC_LIMITS.maxLinkLabelBytes,
    ) &&
    isBoundedString(
      value.rawTarget,
      OKF_SEMANTIC_LIMITS.maxLinkTargetCodeUnits,
      OKF_SEMANTIC_LIMITS.maxLinkTargetBytes,
    ) &&
    value.rawTarget.length > 0 &&
    isSourceRange(value.sourceRange)
  );
}

function isCountRecord(
  value: unknown,
  maxEntries: number,
  maxKeyCodeUnits: number,
  maxKeyBytes: number,
): value is Readonly<Record<string, number>> {
  if (!isRecord(value)) return false;
  let count = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    count += 1;
    if (
      count > maxEntries ||
      !isBoundedString(key, maxKeyCodeUnits, maxKeyBytes) ||
      !isNonNegativeSafeInteger(value[key])
    ) {
      return false;
    }
  }
  return true;
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
    isCountRecord(
      value.typeCounts,
      OKF_SEMANTIC_LIMITS.maxUniqueGraphTypes,
      OKF_SEMANTIC_LIMITS.maxTypeCodeUnits,
      OKF_SEMANTIC_LIMITS.maxTypeBytes,
    ) &&
    isCountRecord(
      value.tagCounts,
      OKF_SEMANTIC_LIMITS.maxUniqueGraphTags,
      OKF_SEMANTIC_LIMITS.maxTagCodeUnits,
      OKF_SEMANTIC_LIMITS.maxTagBytes,
    )
  );
}

function isBacklinks(
  value: unknown,
  nodeCount: number,
): value is Readonly<Record<string, readonly string[]>> {
  if (!isRecord(value)) return false;
  let targetCount = 0;
  let sourceCount = 0;
  for (const target in value) {
    if (!Object.hasOwn(value, target)) continue;
    targetCount += 1;
    if (targetCount > nodeCount || !isGraphIdentity(target)) return false;
    const sources = value[target];
    if (!isDenseArray(sources, isGraphIdentity)) return false;
    sourceCount += sources.length;
    if (sourceCount > OKF_SEMANTIC_LIMITS.maxGraphEdges) return false;
  }
  return targetCount === nodeCount;
}

function hasValidGraphReferences(payload: GraphPayload): boolean {
  const nodeIds = new Set(payload.nodes.map((node) => node.id));
  if (nodeIds.size !== payload.nodes.length) {
    return false;
  }
  const failedSourceIds = new Set(
    payload.nodes.filter((node) => node.sourceFailed === true).map((node) => node.id),
  );

  const edgeIds = new Set<string>();
  const expectedBacklinks = new Map(payload.nodes.map((node) => [node.id, new Set<string>()]));
  const connectedIds = new Set<string>();
  for (let index = 0; index < payload.edges.length; index += 1) {
    const edge = payload.edges[index];
    if (edge === undefined) {
      return false;
    }
    if (
      !nodeIds.has(edge.source) ||
      !nodeIds.has(edge.target) ||
      failedSourceIds.has(edge.source) ||
      edge.id !== `edge:${index.toString(36)}` ||
      edgeIds.has(edge.id)
    ) {
      return false;
    }
    edgeIds.add(edge.id);
    expectedBacklinks.get(edge.target)?.add(edge.source);
    connectedIds.add(edge.source);
    connectedIds.add(edge.target);
  }

  for (const node of payload.nodes) {
    if (!Object.hasOwn(payload.backlinks, node.id)) {
      return false;
    }
    const actual = payload.backlinks[node.id];
    const expected = [...(expectedBacklinks.get(node.id) ?? [])].sort();
    if (
      actual === undefined ||
      actual.length !== expected.length ||
      actual.some((source, index) => source !== expected[index])
    ) {
      return false;
    }
    if (node.sourceFailed !== true && node.orphan !== !connectedIds.has(node.id)) {
      return false;
    }
  }

  const brokenCounts = new Map<string, number>();
  for (const link of payload.brokenLinks) {
    if (!nodeIds.has(link.sourceId) || failedSourceIds.has(link.sourceId)) return false;
    brokenCounts.set(link.sourceId, (brokenCounts.get(link.sourceId) ?? 0) + 1);
  }
  for (const node of payload.nodes) {
    if (node.sourceFailed !== true && node.brokenLinkCount !== (brokenCounts.get(node.id) ?? 0)) {
      return false;
    }
  }
  return hasValidStatistics(payload);
}

function hasValidStatistics(payload: GraphPayload): boolean {
  const typeCounts = new Map<string, number>();
  const tagCounts = new Map<string, number>();
  let orphanCount = 0;
  for (const node of payload.nodes) {
    if (node.orphan) orphanCount += 1;
    if (node.sourceFailed === true) continue;
    typeCounts.set(node.type, (typeCounts.get(node.type) ?? 0) + 1);
    for (const tag of new Set(node.tags)) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  return (
    payload.statistics.conceptCount === payload.nodes.length &&
    payload.statistics.edgeCount === payload.edges.length &&
    payload.statistics.orphanCount === orphanCount &&
    payload.statistics.brokenLinkCount === payload.brokenLinks.length &&
    countRecordsEqual(payload.statistics.typeCounts, typeCounts) &&
    countRecordsEqual(payload.statistics.tagCounts, tagCounts)
  );
}

function countRecordsEqual(
  actual: Readonly<Record<string, number>>,
  expected: ReadonlyMap<string, number>,
): boolean {
  let count = 0;
  for (const key in actual) {
    if (!Object.hasOwn(actual, key)) continue;
    count += 1;
    if (actual[key] !== expected.get(key)) return false;
  }
  return count === expected.size;
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
    value.nodes.length > OKF_SEMANTIC_LIMITS.maxGraphNodes ||
    !isDenseArray(value.nodes, isGraphNode) ||
    !Array.isArray(value.edges) ||
    value.edges.length > OKF_SEMANTIC_LIMITS.maxGraphEdges ||
    !isDenseArray(value.edges, isGraphEdge) ||
    !isBacklinks(value.backlinks, value.nodes.length) ||
    !Array.isArray(value.brokenLinks) ||
    value.brokenLinks.length > OKF_SEMANTIC_LIMITS.maxGraphEdges ||
    value.edges.length + value.brokenLinks.length >
      Math.min(OKF_SEMANTIC_LIMITS.maxBundleLinks, OKF_SEMANTIC_LIMITS.maxGraphEdges) ||
    !isDenseArray(value.brokenLinks, isBrokenLink) ||
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
  let tagAssignments = 0;
  let identityBytes = 0;
  const types = new Set<string>();
  const tags = new Set<string>();
  for (const node of decoded.nodes) {
    identityBytes += utf8ByteLength(
      node.id,
      Math.max(0, OKF_SEMANTIC_LIMITS.maxGraphIdentityBytes - identityBytes),
    );
    if (identityBytes > OKF_SEMANTIC_LIMITS.maxGraphIdentityBytes) return false;
    tagAssignments += node.tags.length;
    if (tagAssignments > OKF_SEMANTIC_LIMITS.maxBundleTagAssignments) return false;
    if (node.sourceFailed !== true) types.add(node.type);
    for (const tag of node.tags) tags.add(tag);
    if (
      types.size > OKF_SEMANTIC_LIMITS.maxUniqueGraphTypes ||
      tags.size > OKF_SEMANTIC_LIMITS.maxUniqueGraphTags
    ) {
      return false;
    }
  }
  return (
    hasValidGraphReferences(decoded) &&
    graphPayloadJsonByteLength(decoded, OKF_SEMANTIC_LIMITS.maxGraphPayloadBytes) <=
      OKF_SEMANTIC_LIMITS.maxGraphPayloadBytes
  );
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

/** Decode an extension-host message and reject stale revisions or replayed graph deliveries. */
export function decodeExtensionToWebviewMessage(
  value: unknown,
  currentRevision: number,
  currentDeliveryId = 0,
): ProtocolDecodeResult<ExtensionToWebviewMessage> {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return fail('invalid-envelope', 'Expected an object with a message type.');
  }
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    return fail('unsupported-version', 'The message protocol version is not supported.');
  }

  if (value.type === 'replaceGraph') {
    if (
      !validEnvelope(value, ['revision', 'deliveryId', 'payload']) ||
      !isNonNegativeSafeInteger(value.revision) ||
      !isPositiveSafeInteger(value.deliveryId) ||
      !isGraphPayload(value.payload) ||
      value.revision !== value.payload.revision
    ) {
      return fail('invalid-payload', 'The replacement graph payload is invalid.');
    }
    if (value.revision < currentRevision) {
      return fail('stale-revision', 'The replacement graph revision is stale.');
    }
    if (value.revision === currentRevision && value.deliveryId <= currentDeliveryId) {
      return fail(
        'stale-revision',
        'The replacement graph delivery is stale for the current revision.',
      );
    }
    return {
      ok: true,
      value: {
        protocolVersion: PROTOCOL_VERSION,
        type: 'replaceGraph',
        revision: value.revision,
        deliveryId: value.deliveryId,
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

/** Decode a Webview action only for the host's exact current graph delivery. */
export function decodeWebviewToExtensionMessage(
  value: unknown,
  expectedDelivery: GraphDeliveryIdentity | undefined,
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
    if (
      !validEnvelope(value, ['revision', 'deliveryId']) ||
      !isNonNegativeSafeInteger(value.revision) ||
      !isPositiveSafeInteger(value.deliveryId)
    ) {
      return fail('invalid-payload', 'The rendered-graph payload is invalid.');
    }
    if (
      expectedDelivery === undefined ||
      value.revision !== expectedDelivery.revision ||
      value.deliveryId !== expectedDelivery.deliveryId
    ) {
      return fail(
        'stale-revision',
        'The rendered-graph acknowledgement does not match the current graph delivery.',
      );
    }
    return {
      ok: true,
      value: {
        protocolVersion: PROTOCOL_VERSION,
        type: 'graphRendered',
        revision: value.revision,
        deliveryId: value.deliveryId,
      },
    };
  }

  if (value.type === 'graphRenderFailed') {
    if (
      !validEnvelope(value, ['revision', 'deliveryId', 'reason']) ||
      !isNonNegativeSafeInteger(value.revision) ||
      !isPositiveSafeInteger(value.deliveryId) ||
      !isGraphRenderFailureReason(value.reason)
    ) {
      return fail('invalid-payload', 'The graph-render failure payload is invalid.');
    }
    if (
      expectedDelivery === undefined ||
      value.revision !== expectedDelivery.revision ||
      value.deliveryId !== expectedDelivery.deliveryId
    ) {
      return fail(
        'stale-revision',
        'The graph-render failure does not match the current graph delivery.',
      );
    }
    return {
      ok: true,
      value: {
        protocolVersion: PROTOCOL_VERSION,
        type: 'graphRenderFailed',
        revision: value.revision,
        deliveryId: value.deliveryId,
        reason: value.reason,
      },
    };
  }

  if (value.type === 'openSource') {
    if (
      !validEnvelope(value, ['revision', 'deliveryId', 'nodeId']) ||
      !isNonNegativeSafeInteger(value.revision) ||
      !isPositiveSafeInteger(value.deliveryId) ||
      !isGraphIdentity(value.nodeId) ||
      value.nodeId.length > MAX_ACTION_ID_LENGTH
    ) {
      return fail('invalid-payload', 'The open-source payload is invalid.');
    }
    if (
      expectedDelivery === undefined ||
      value.revision !== expectedDelivery.revision ||
      value.deliveryId !== expectedDelivery.deliveryId
    ) {
      return fail(
        'stale-revision',
        'The open-source action does not match the current graph delivery.',
      );
    }
    return {
      ok: true,
      value: {
        protocolVersion: PROTOCOL_VERSION,
        type: 'openSource',
        revision: value.revision,
        deliveryId: value.deliveryId,
        nodeId: value.nodeId,
      },
    };
  }

  return fail('unknown-message', 'The Webview message type is unknown.');
}
