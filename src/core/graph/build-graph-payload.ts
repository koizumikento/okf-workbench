import type {
  BrokenLinkPresentation,
  Concept,
  ConceptLink,
  GraphEdge,
  GraphNode,
  GraphPayload,
  GraphStatistics,
  ParsedBundle,
  SourceRange,
} from '../model/index.js';

/** Derives a deterministic, renderer-independent graph from a parsed bundle. */
export function buildGraphPayload(bundle: ParsedBundle): GraphPayload {
  const concepts = uniqueConcepts(bundle.concepts);
  const conceptIds = new Set(concepts.map((concept) => concept.id));
  const edges: GraphEdge[] = [];
  const brokenLinks: BrokenLinkPresentation[] = [];

  for (const concept of concepts) {
    for (const link of concept.links) {
      if (
        link.classification === 'internal' &&
        link.targetId !== undefined &&
        conceptIds.has(link.targetId)
      ) {
        edges.push(graphEdge(concept.id, link.targetId, link));
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

  edges.sort(compareEdges);
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

  const nodes = concepts.map((concept) =>
    graphNode(concept, !connectedIds.has(concept.id), brokenCounts.get(concept.id) ?? 0),
  );
  const backlinks = Object.fromEntries(
    concepts.map((concept) => [
      concept.id,
      [...(backlinkSets.get(concept.id) ?? [])].sort(compareText),
    ]),
  );

  return {
    protocolVersion: 1,
    revision: bundle.revision,
    nodes,
    edges,
    backlinks,
    brokenLinks,
    statistics: graphStatistics(nodes, edges, brokenLinks),
  };
}

function uniqueConcepts(input: readonly Concept[]): readonly Concept[] {
  const sorted = [...input].sort(compareConcepts);
  const concepts: Concept[] = [];
  let previousId: string | undefined;

  for (const concept of sorted) {
    if (concept.id !== previousId) {
      concepts.push(concept);
      previousId = concept.id;
    }
  }
  return concepts;
}

function graphNode(concept: Concept, orphan: boolean, brokenLinkCount: number): GraphNode {
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

function graphEdge(sourceId: string, targetId: string, link: ConceptLink): GraphEdge {
  const sourceRange = cloneRange(link.range);
  return {
    id: `edge:${JSON.stringify([sourceId, targetId, sourceRange.start.offset, sourceRange.end.offset])}`,
    source: sourceId,
    target: targetId,
    sourceRange,
  };
}

function graphStatistics(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  brokenLinks: readonly BrokenLinkPresentation[],
): GraphStatistics {
  const typeCounts = new Map<string, number>();
  const tagCounts = new Map<string, number>();

  for (const node of nodes) {
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

function compareEdges(left: GraphEdge, right: GraphEdge): number {
  return (
    compareText(left.source, right.source) ||
    left.sourceRange.start.offset - right.sourceRange.start.offset ||
    left.sourceRange.end.offset - right.sourceRange.end.offset ||
    compareText(left.target, right.target) ||
    compareText(left.id, right.id)
  );
}

function compareBrokenLinks(left: BrokenLinkPresentation, right: BrokenLinkPresentation): number {
  return (
    compareText(left.sourceId, right.sourceId) ||
    left.sourceRange.start.offset - right.sourceRange.start.offset ||
    left.sourceRange.end.offset - right.sourceRange.end.offset ||
    compareText(left.rawTarget, right.rawTarget) ||
    compareText(left.label, right.label)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
