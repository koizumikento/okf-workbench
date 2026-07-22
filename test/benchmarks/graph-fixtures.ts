import type {
  GraphEdge,
  GraphNode,
  GraphPayload,
  GraphStatistics,
  SourceRange,
} from '../../src/core/model/types.js';

export const PERFORMANCE_FIXTURE_SEED = 0x004f_4b46;

export interface PerformanceFixtureSpec {
  readonly name: 'small' | 'representative' | 'stress';
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly seed: number;
}

export const PERFORMANCE_FIXTURES: Readonly<
  Record<PerformanceFixtureSpec['name'], PerformanceFixtureSpec>
> = {
  small: {
    name: 'small',
    nodeCount: 100,
    edgeCount: 500,
    seed: PERFORMANCE_FIXTURE_SEED,
  },
  representative: {
    name: 'representative',
    nodeCount: 1_000,
    edgeCount: 5_000,
    seed: PERFORMANCE_FIXTURE_SEED,
  },
  stress: {
    name: 'stress',
    nodeCount: 5_000,
    edgeCount: 25_000,
    seed: PERFORMANCE_FIXTURE_SEED,
  },
};

const TYPES = ['concept', 'decision', 'guide', 'metric', 'playbook', 'project', 'reference'];
const TAGS = [
  'architecture',
  'data',
  'delivery',
  'design',
  'development',
  'discovery',
  'governance',
  'operations',
  'quality',
  'research',
  'security',
  'strategy',
];

/**
 * Build a stable graph payload without reading the clock, random device state, or the filesystem.
 * The first ring of edges guarantees the checked-in fixture sizes have no accidental orphans.
 */
export function generatePerformanceGraph(spec: PerformanceFixtureSpec, revision = 1): GraphPayload {
  assertFixtureSpec(spec);
  const random = createXorShift32(spec.seed);
  const nodes = Array.from({ length: spec.nodeCount }, (_, index) => createNode(index));
  const edges = Array.from({ length: spec.edgeCount }, (_, index) =>
    createEdge(index, spec.nodeCount, random),
  );
  const backlinks = createBacklinks(nodes, edges);

  return {
    protocolVersion: 1,
    revision,
    nodes,
    edges,
    backlinks,
    brokenLinks: [],
    statistics: createStatistics(nodes, edges),
  };
}

function assertFixtureSpec(spec: PerformanceFixtureSpec): void {
  if (!Number.isSafeInteger(spec.nodeCount) || spec.nodeCount <= 1) {
    throw new Error('Performance fixtures require at least two nodes.');
  }
  if (!Number.isSafeInteger(spec.edgeCount) || spec.edgeCount < spec.nodeCount) {
    throw new Error('Performance fixtures require at least one ring edge per node.');
  }
  if (!Number.isSafeInteger(spec.seed)) {
    throw new Error('Performance fixture seeds must be safe integers.');
  }
}

function createNode(index: number): GraphNode {
  const type = TYPES[index % TYPES.length] ?? 'concept';
  const primaryTag = TAGS[index % TAGS.length] ?? 'knowledge';
  const secondaryTag = TAGS[(index * 7 + 3) % TAGS.length] ?? 'knowledge';
  const id = `area-${String(index % 20).padStart(2, '0')}/concept-${String(index).padStart(5, '0')}`;
  return {
    id,
    type,
    title: `Concept ${String(index).padStart(5, '0')}`,
    description: `Deterministic performance fixture concept ${String(index)}.`,
    tags: primaryTag === secondaryTag ? [primaryTag] : [primaryTag, secondaryTag],
    orphan: false,
    brokenLinkCount: 0,
  };
}

function createEdge(index: number, nodeCount: number, random: () => number): GraphEdge {
  const sourceIndex = index < nodeCount ? index : Math.floor(random() * nodeCount);
  let targetIndex = index < nodeCount ? (index + 1) % nodeCount : Math.floor(random() * nodeCount);
  if (targetIndex === sourceIndex) {
    targetIndex = (targetIndex + 1) % nodeCount;
  }
  const source = `area-${String(sourceIndex % 20).padStart(2, '0')}/concept-${String(sourceIndex).padStart(5, '0')}`;
  const target = `area-${String(targetIndex % 20).padStart(2, '0')}/concept-${String(targetIndex).padStart(5, '0')}`;
  return {
    id: `edge-${String(index).padStart(6, '0')}`,
    source,
    target,
    sourceRange: rangeForEdge(index),
  };
}

function rangeForEdge(index: number): SourceRange {
  const offset = index * 8;
  return {
    start: { offset, line: index, character: 0 },
    end: { offset: offset + 7, line: index, character: 7 },
  };
}

function createBacklinks(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): Readonly<Record<string, readonly string[]>> {
  const grouped = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of edges) {
    grouped.get(edge.target)?.add(edge.source);
  }
  return Object.fromEntries(
    nodes.map((node) => [node.id, [...(grouped.get(node.id) ?? [])].sort()]),
  );
}

function createStatistics(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): GraphStatistics {
  const typeCounts: Record<string, number> = {};
  const tagCounts: Record<string, number> = {};
  for (const node of nodes) {
    typeCounts[node.type] = (typeCounts[node.type] ?? 0) + 1;
    for (const tag of node.tags) {
      tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    }
  }
  return {
    conceptCount: nodes.length,
    edgeCount: edges.length,
    orphanCount: 0,
    brokenLinkCount: 0,
    typeCounts,
    tagCounts,
  };
}

function createXorShift32(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e37_79b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}
