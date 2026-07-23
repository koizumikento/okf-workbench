import type { GraphNode, GraphPayload, SourceRange } from '../../../src/core/model/types.js';

export const sourceRange: SourceRange = {
  start: { offset: 0, line: 0, character: 0 },
  end: { offset: 4, line: 0, character: 4 },
};

export function graphNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'alpha',
    type: 'concept',
    title: 'Alpha',
    description: 'An alpha concept',
    resource: 'urn:okf:alpha',
    tags: ['first'],
    timestamp: '2026-07-22T09:30:00+09:00',
    orphan: false,
    brokenLinkCount: 0,
    ...overrides,
  };
}

export function graphPayload(overrides: Partial<GraphPayload> = {}): GraphPayload {
  const nodes = overrides.nodes ?? [
    graphNode(),
    graphNode({ id: 'beta', title: 'Beta', type: 'note', tags: ['second'] }),
  ];
  const edges = overrides.edges ?? [{ id: 'edge:0', source: 'alpha', target: 'beta', sourceRange }];
  return {
    protocolVersion: 1,
    revision: 1,
    nodes,
    edges,
    backlinks: overrides.backlinks ?? { alpha: [], beta: ['alpha'] },
    brokenLinks: overrides.brokenLinks ?? [],
    statistics: overrides.statistics ?? {
      conceptCount: nodes.length,
      edgeCount: edges.length,
      orphanCount: nodes.filter((node) => node.orphan).length,
      brokenLinkCount: 0,
      typeCounts: { concept: 1, note: 1 },
      tagCounts: { first: 1, second: 1 },
    },
    ...overrides,
  };
}
