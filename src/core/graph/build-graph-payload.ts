import {
  OKF_SEMANTIC_LIMITS,
  utf8ByteLength,
  type BrokenLinkPresentation,
  type Concept,
  type GraphEdge,
  type GraphNode,
  type GraphPayload,
  type GraphStatistics,
  type ParsedBundle,
  type SourceRange,
} from '../model/index.js';
import { graphPayloadJsonByteLength } from './graph-payload-size.js';

interface EdgeCandidate {
  readonly source: string;
  readonly target: string;
  readonly sourceRange: SourceRange;
}

type FailedSourceIndex = ReadonlyMap<string, ReadonlySet<string>>;

export class GraphResourceLimitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'GraphResourceLimitError';
  }
}

/** Derives a deterministic, renderer-independent graph from a bounded parsed bundle. */
export function buildGraphPayload(bundle: ParsedBundle): GraphPayload {
  const failedSourceKeys = assertBoundedGraphInput(bundle);
  const concepts = uniqueConcepts(bundle.concepts);
  const failedConceptIds = new Set(
    concepts
      .filter((concept) => isFailedSource(failedSourceKeys, concept))
      .map((concept) => concept.id),
  );
  const conceptIds = new Set(concepts.map((concept) => concept.id));
  const edgeCandidates: EdgeCandidate[] = [];
  const brokenLinks: BrokenLinkPresentation[] = [];

  for (const concept of concepts) {
    if (failedConceptIds.has(concept.id)) {
      continue;
    }
    for (const link of concept.links) {
      if (
        link.classification === 'internal' &&
        link.targetId !== undefined &&
        conceptIds.has(link.targetId)
      ) {
        edgeCandidates.push({
          source: concept.id,
          target: link.targetId,
          sourceRange: cloneRange(link.range),
        });
      } else if (
        link.classification === 'broken' ||
        (link.classification === 'internal' &&
          (link.targetId === undefined || !conceptIds.has(link.targetId)))
      ) {
        brokenLinks.push({
          sourceId: concept.id,
          label: link.label,
          rawTarget: link.rawTarget,
          sourceRange: cloneRange(link.range),
        });
      }
    }
  }

  edgeCandidates.sort(compareEdgeCandidates);
  const edges = edgeCandidates.map((candidate, index): GraphEdge => {
    const id = `edge:${index.toString(36)}`;
    if (id.length > OKF_SEMANTIC_LIMITS.maxCompactGraphEdgeIdCodeUnits) {
      throw graphLimit('The compact edge identity exceeded its internal safety limit.');
    }
    return { id, ...candidate };
  });
  brokenLinks.sort(compareBrokenLinks);

  const connectedIds = new Set<string>();
  const backlinkSets = new Map(concepts.map((concept) => [concept.id, new Set<string>()]));
  const brokenCounts = new Map<string, number>();

  for (const edge of edges) {
    connectedIds.add(edge.source);
    connectedIds.add(edge.target);
    backlinkSets.get(edge.target)?.add(edge.source);
  }
  for (const broken of brokenLinks) {
    brokenCounts.set(broken.sourceId, (brokenCounts.get(broken.sourceId) ?? 0) + 1);
  }

  const nodes = concepts.map((concept) => {
    const sourceFailed = failedConceptIds.has(concept.id);
    return graphNode(
      concept,
      sourceFailed ? false : !connectedIds.has(concept.id),
      sourceFailed ? 0 : (brokenCounts.get(concept.id) ?? 0),
      sourceFailed,
    );
  });
  const backlinks = Object.fromEntries(
    concepts.map((concept) => [
      concept.id,
      [...(backlinkSets.get(concept.id) ?? [])].sort(compareText),
    ]),
  );
  const payload: GraphPayload = {
    protocolVersion: 1,
    revision: bundle.revision,
    nodes,
    edges,
    backlinks,
    brokenLinks,
    statistics: graphStatistics(nodes, edges, brokenLinks, failedConceptIds),
  };
  if (
    graphPayloadJsonByteLength(payload, OKF_SEMANTIC_LIMITS.maxGraphPayloadBytes) >
    OKF_SEMANTIC_LIMITS.maxGraphPayloadBytes
  ) {
    throw graphLimit(
      `The derived graph exceeds the ${String(OKF_SEMANTIC_LIMITS.maxGraphPayloadBytes)}-byte serialized payload limit.`,
    );
  }
  return payload;
}

function assertBoundedGraphInput(bundle: ParsedBundle): FailedSourceIndex {
  if (!Number.isSafeInteger(bundle.revision) || bundle.revision < 0) {
    throw graphLimit('The graph revision must be a non-negative safe integer.');
  }
  assertBoundedString(
    bundle.rootUri,
    OKF_SEMANTIC_LIMITS.maxSourceUriCodeUnits,
    OKF_SEMANTIC_LIMITS.maxSourceUriBytes,
    'Bundle root URI',
  );
  if (bundle.concepts.length > OKF_SEMANTIC_LIMITS.maxGraphNodes) {
    throw graphLimit(
      `The bundle exceeds the ${String(OKF_SEMANTIC_LIMITS.maxGraphNodes)}-node graph limit.`,
    );
  }
  if (bundle.findings.length > OKF_SEMANTIC_LIMITS.maxFindings) {
    throw graphLimit(
      `The bundle exceeds the ${String(OKF_SEMANTIC_LIMITS.maxFindings)}-finding limit.`,
    );
  }
  if (bundle.failures.length > OKF_SEMANTIC_LIMITS.maxFindings) {
    throw graphLimit(
      `The bundle exceeds the ${String(OKF_SEMANTIC_LIMITS.maxFindings)}-failure limit.`,
    );
  }
  if (
    bundle.failures.some(
      (failure) => failure.reason === 'resource-limit' && failure.scope === 'bundle',
    )
  ) {
    throw graphLimit('A bundle-scoped resource failure prevents graph publication.');
  }

  let identityBytes = addIdentityBytes(0, bundle.rootUri);
  const failedSourceKeys = new Map<string, Set<string>>();
  for (const failure of bundle.failures) {
    assertBoundedString(
      failure.uri,
      OKF_SEMANTIC_LIMITS.maxSourceUriCodeUnits,
      OKF_SEMANTIC_LIMITS.maxSourceUriBytes,
      'Parse failure URI',
    );
    if (failure.bundlePath.length > 0) {
      assertBoundedString(
        failure.bundlePath,
        OKF_SEMANTIC_LIMITS.maxProviderPathCodeUnits,
        OKF_SEMANTIC_LIMITS.maxProviderPathBytes,
        'Parse failure path',
      );
    }
    identityBytes = addIdentityBytes(identityBytes, failure.uri);
    identityBytes = addIdentityBytes(identityBytes, failure.bundlePath);
    const paths = failedSourceKeys.get(failure.uri);
    if (paths === undefined) {
      failedSourceKeys.set(failure.uri, new Set([failure.bundlePath]));
    } else {
      paths.add(failure.bundlePath);
    }
  }
  for (const finding of bundle.findings) {
    assertBoundedString(
      finding.uri,
      OKF_SEMANTIC_LIMITS.maxSourceUriCodeUnits,
      OKF_SEMANTIC_LIMITS.maxSourceUriBytes,
      'Finding URI',
    );
    identityBytes = addIdentityBytes(identityBytes, finding.uri);
  }

  let linkCount = 0;
  let tagAssignments = 0;
  const types = new Set<string>();
  const tags = new Set<string>();
  for (const concept of bundle.concepts) {
    // Defensive compatibility: an invalid provider basename exactly equal to `.md` has no graph
    // identity and is discarded below. Do not let its non-published fields spend graph budgets.
    if (concept.id.length === 0) {
      continue;
    }
    assertGraphIdentity(concept.id, 'Concept ID');
    assertBoundedString(
      concept.source.bundlePath,
      OKF_SEMANTIC_LIMITS.maxProviderPathCodeUnits,
      OKF_SEMANTIC_LIMITS.maxProviderPathBytes,
      'Concept source path',
    );
    if (pathSegmentCount(concept.source.bundlePath) > OKF_SEMANTIC_LIMITS.maxProviderPathSegments) {
      throw graphLimit(
        `A concept source path exceeds the ${String(OKF_SEMANTIC_LIMITS.maxProviderPathSegments)}-segment limit.`,
      );
    }
    assertBoundedString(
      concept.source.uri,
      OKF_SEMANTIC_LIMITS.maxSourceUriCodeUnits,
      OKF_SEMANTIC_LIMITS.maxSourceUriBytes,
      'Concept source URI',
    );
    assertBoundedString(
      concept.source.contentHash,
      OKF_SEMANTIC_LIMITS.maxContentHashCodeUnits,
      OKF_SEMANTIC_LIMITS.maxContentHashCodeUnits * 3,
      'Concept content hash',
    );
    identityBytes = addIdentityBytes(identityBytes, concept.id);
    identityBytes = addIdentityBytes(identityBytes, concept.source.bundlePath);
    identityBytes = addIdentityBytes(identityBytes, concept.source.uri);

    if (isFailedSource(failedSourceKeys, concept)) {
      continue;
    }

    assertBoundedString(
      concept.type,
      OKF_SEMANTIC_LIMITS.maxTypeCodeUnits,
      OKF_SEMANTIC_LIMITS.maxTypeBytes,
      'Concept type',
    );
    assertOptionalMetadata(concept.title, OKF_SEMANTIC_LIMITS.maxTitleCodeUnits, 'Concept title');
    assertOptionalMetadata(
      concept.description,
      OKF_SEMANTIC_LIMITS.maxDescriptionCodeUnits,
      'Concept description',
    );
    assertOptionalMetadata(
      concept.resource,
      OKF_SEMANTIC_LIMITS.maxResourceCodeUnits,
      'Concept resource',
    );
    assertOptionalMetadata(
      concept.timestamp,
      OKF_SEMANTIC_LIMITS.maxTimestampCodeUnits,
      'Concept timestamp',
    );
    if (concept.tags.length > OKF_SEMANTIC_LIMITS.maxTagsPerConcept) {
      throw graphLimit(
        `A concept exceeds the ${String(OKF_SEMANTIC_LIMITS.maxTagsPerConcept)}-tag limit.`,
      );
    }
    tagAssignments += concept.tags.length;
    if (tagAssignments > OKF_SEMANTIC_LIMITS.maxBundleTagAssignments) {
      throw graphLimit(
        `The bundle exceeds the ${String(OKF_SEMANTIC_LIMITS.maxBundleTagAssignments)}-tag assignment limit.`,
      );
    }
    types.add(concept.type);
    for (const tag of concept.tags) {
      assertBoundedString(
        tag,
        OKF_SEMANTIC_LIMITS.maxTagCodeUnits,
        OKF_SEMANTIC_LIMITS.maxTagBytes,
        'Concept tag',
      );
      tags.add(tag);
    }
    if (types.size > OKF_SEMANTIC_LIMITS.maxUniqueGraphTypes) {
      throw graphLimit(
        `The graph exceeds the ${String(OKF_SEMANTIC_LIMITS.maxUniqueGraphTypes)}-type cardinality limit.`,
      );
    }
    if (tags.size > OKF_SEMANTIC_LIMITS.maxUniqueGraphTags) {
      throw graphLimit(
        `The graph exceeds the ${String(OKF_SEMANTIC_LIMITS.maxUniqueGraphTags)}-tag cardinality limit.`,
      );
    }

    for (const link of concept.links) {
      linkCount += 1;
      if (
        linkCount > OKF_SEMANTIC_LIMITS.maxBundleLinks ||
        linkCount > OKF_SEMANTIC_LIMITS.maxGraphEdges
      ) {
        throw graphLimit(
          `The graph exceeds the ${String(Math.min(OKF_SEMANTIC_LIMITS.maxBundleLinks, OKF_SEMANTIC_LIMITS.maxGraphEdges))}-relationship limit.`,
        );
      }
      if (link.sourceId !== concept.id) {
        throw graphLimit('A graph link does not belong to its containing concept.');
      }
      assertBoundedString(
        link.rawTarget,
        OKF_SEMANTIC_LIMITS.maxLinkTargetCodeUnits,
        OKF_SEMANTIC_LIMITS.maxLinkTargetBytes,
        'Markdown link target',
      );
      assertBoundedString(
        link.label,
        OKF_SEMANTIC_LIMITS.maxLinkLabelCodeUnits,
        OKF_SEMANTIC_LIMITS.maxLinkLabelBytes,
        'Markdown link label',
      );
      if (link.targetId !== undefined) {
        if (link.targetId.length === 0) {
          throw graphLimit('A link target ID must not be empty.');
        }
        assertGraphIdentity(link.targetId, 'Link target ID');
      }
      if (
        (link.classification === 'broken' || link.classification === 'internal') &&
        link.rawTarget.length === 0
      ) {
        throw graphLimit('An internal or broken-link target must not be empty.');
      }
      assertSourceRange(link.range);
    }
  }

  return failedSourceKeys;
}

function addIdentityBytes(current: number, value: string): number {
  const next =
    current +
    utf8ByteLength(value, Math.max(0, OKF_SEMANTIC_LIMITS.maxGraphIdentityBytes - current));
  if (next > OKF_SEMANTIC_LIMITS.maxGraphIdentityBytes) {
    throw graphLimit(
      `Graph identities exceed the ${String(OKF_SEMANTIC_LIMITS.maxGraphIdentityBytes)}-byte aggregate limit.`,
    );
  }
  return next;
}

function assertGraphIdentity(value: string, subject: string): void {
  if (value.length === 0) {
    // Empty hand-built concept IDs are discarded by uniqueConcepts for defensive compatibility.
    return;
  }
  assertBoundedString(
    value,
    OKF_SEMANTIC_LIMITS.maxProviderPathCodeUnits,
    OKF_SEMANTIC_LIMITS.maxProviderPathBytes,
    subject,
  );
  if (pathSegmentCount(value) > OKF_SEMANTIC_LIMITS.maxProviderPathSegments) {
    throw graphLimit(
      `${subject} exceeds the ${String(OKF_SEMANTIC_LIMITS.maxProviderPathSegments)}-segment limit.`,
    );
  }
}

function pathSegmentCount(value: string): number {
  let count = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 0x2f) count += 1;
  }
  return count;
}

function assertOptionalMetadata(
  value: string | undefined,
  maxCodeUnits: number,
  subject: string,
): void {
  if (value !== undefined) assertBoundedString(value, maxCodeUnits, maxCodeUnits * 3, subject);
}

function assertBoundedString(
  value: string,
  maxCodeUnits: number,
  maxBytes: number,
  subject: string,
): void {
  if (value.length > maxCodeUnits || utf8ByteLength(value, maxBytes) > maxBytes) {
    throw graphLimit(
      `${subject} exceeds its ${String(maxCodeUnits)}-code-unit or ${String(maxBytes)}-byte limit.`,
    );
  }
}

function assertSourceRange(range: SourceRange): void {
  for (const position of [range.start, range.end]) {
    if (
      !Number.isSafeInteger(position.offset) ||
      position.offset < 0 ||
      !Number.isSafeInteger(position.line) ||
      position.line < 0 ||
      !Number.isSafeInteger(position.character) ||
      position.character < 0
    ) {
      throw graphLimit('A graph source range contains an invalid position.');
    }
  }
  if (range.start.offset > range.end.offset) {
    throw graphLimit('A graph source range ends before it starts.');
  }
}

function graphLimit(message: string): GraphResourceLimitError {
  return new GraphResourceLimitError(message);
}

function isFailedSource(index: FailedSourceIndex, concept: Concept): boolean {
  return index.get(concept.source.uri)?.has(concept.source.bundlePath) === true;
}

function uniqueConcepts(input: readonly Concept[]): readonly Concept[] {
  const sorted = [...input].sort(compareConcepts);
  const concepts: Concept[] = [];
  let previousId: string | undefined;

  for (const concept of sorted) {
    // The canonical parser reports a provider file named exactly `.md` as a source-scoped
    // failure. Keep a malformed hand-built ParsedBundle from poisoning the complete Webview
    // replacement payload with the corresponding empty node ID.
    if (concept.id.length === 0) {
      continue;
    }
    if (concept.id === previousId) {
      throw graphLimit(`The graph contains duplicate concept ID ${JSON.stringify(concept.id)}.`);
    }
    concepts.push(concept);
    previousId = concept.id;
  }
  return concepts;
}

function graphNode(
  concept: Concept,
  orphan: boolean,
  brokenLinkCount: number,
  sourceFailed: boolean,
): GraphNode {
  if (sourceFailed) {
    return {
      id: concept.id,
      sourceFailed: true,
      type: '',
      tags: [],
      orphan: false,
      brokenLinkCount: 0,
    };
  }
  return {
    id: concept.id,
    type: concept.type,
    ...(concept.title === undefined ? {} : { title: concept.title }),
    ...(concept.description === undefined ? {} : { description: concept.description }),
    ...(concept.resource === undefined ? {} : { resource: concept.resource }),
    tags: [...concept.tags],
    ...(concept.timestamp === undefined ? {} : { timestamp: concept.timestamp }),
    orphan,
    brokenLinkCount,
  };
}

function graphStatistics(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  brokenLinks: readonly BrokenLinkPresentation[],
  failedConceptIds: ReadonlySet<string>,
): GraphStatistics {
  const typeCounts = new Map<string, number>();
  const tagCounts = new Map<string, number>();

  for (const node of nodes) {
    if (failedConceptIds.has(node.id)) {
      continue;
    }
    typeCounts.set(node.type, (typeCounts.get(node.type) ?? 0) + 1);
    for (const tag of new Set(node.tags)) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  return {
    conceptCount: nodes.length,
    edgeCount: edges.length,
    orphanCount: nodes.filter((node) => node.orphan).length,
    brokenLinkCount: brokenLinks.length,
    typeCounts: sortedRecord(typeCounts),
    tagCounts: sortedRecord(tagCounts),
  };
}

function sortedRecord(counts: ReadonlyMap<string, number>): Readonly<Record<string, number>> {
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => compareText(left, right)),
  );
}

function cloneRange(range: SourceRange): SourceRange {
  return {
    start: { ...range.start },
    end: { ...range.end },
  };
}

function compareConcepts(left: Concept, right: Concept): number {
  return compareText(left.id, right.id) || compareText(left.source.uri, right.source.uri);
}

function compareEdgeCandidates(left: EdgeCandidate, right: EdgeCandidate): number {
  return (
    compareText(left.source, right.source) ||
    compareRanges(left.sourceRange, right.sourceRange) ||
    compareText(left.target, right.target)
  );
}

function compareBrokenLinks(left: BrokenLinkPresentation, right: BrokenLinkPresentation): number {
  return (
    compareText(left.sourceId, right.sourceId) ||
    compareRanges(left.sourceRange, right.sourceRange) ||
    compareText(left.rawTarget, right.rawTarget) ||
    compareText(left.label, right.label)
  );
}

function compareRanges(left: SourceRange, right: SourceRange): number {
  return (
    compareNumbers(left.start.offset, right.start.offset) ||
    compareNumbers(left.start.line, right.start.line) ||
    compareNumbers(left.start.character, right.start.character) ||
    compareNumbers(left.end.offset, right.end.offset) ||
    compareNumbers(left.end.line, right.end.line) ||
    compareNumbers(left.end.character, right.end.character)
  );
}

function compareNumbers(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
