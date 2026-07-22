import { describe, expect, it } from 'vitest';

import type {
  Concept,
  ConceptLink,
  ParsedBundle,
  SourceRange,
} from '../../../src/core/model/index.js';
import { buildGraphPayload } from '../../../src/core/graph/index.js';

const rootUri = 'file:///workspace/knowledge';

function range(start: number, end = start + 4): SourceRange {
  return {
    start: { offset: start, line: 0, character: start },
    end: { offset: end, line: 0, character: end },
  };
}

function link(
  sourceId: string,
  classification: ConceptLink['classification'],
  rawTarget: string,
  start: number,
  targetId?: string,
): ConceptLink {
  return {
    sourceId,
    classification,
    rawTarget,
    label: `Label ${rawTarget}`,
    range: range(start, start + rawTarget.length),
    ...(targetId === undefined ? {} : { targetId }),
  };
}

function concept(
  id: string,
  options: {
    readonly type?: string;
    readonly resource?: string;
    readonly tags?: readonly string[];
    readonly timestamp?: string;
    readonly links?: readonly ConceptLink[];
  } = {},
): Concept {
  const type = options.type ?? 'Generic';
  const normalized = {
    type,
    title: `Title ${id}`,
    description: `Description ${id}`,
    ...(options.resource === undefined ? {} : { resource: options.resource }),
    tags: options.tags ?? [],
    ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
  };
  return {
    kind: 'concept',
    id,
    source: {
      uri: `${rootUri}/${id}.md`,
      bundlePath: `${id}.md`,
      contentHash: `hash:${id}`,
    },
    frontmatter: {
      raw: normalized,
      source: `type: ${type}\n`,
      range: range(0, 50),
      fields: { type: range(4, 15) },
      normalized,
    },
    type,
    title: `Title ${id}`,
    description: `Description ${id}`,
    ...(options.resource === undefined ? {} : { resource: options.resource }),
    tags: options.tags ?? [],
    ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
    body: '',
    bodyRange: range(51, 51),
    links: options.links ?? [],
  };
}

function bundle(concepts: readonly Concept[]): ParsedBundle {
  return {
    rootUri,
    revision: 42,
    concepts,
    reservedDocuments: [],
    failures: [],
    findings: [],
  };
}

describe('buildGraphPayload', () => {
  it('builds one edge per resolved link occurrence and grouped backlinks', () => {
    const alpha = concept('alpha', {
      type: 'Known',
      resource: 'urn:okf:alpha',
      tags: ['shared', 'shared', 'alpha'],
      timestamp: '2026-07-22T09:30:00+09:00',
      links: [
        link('alpha', 'internal', './beta.md', 100, 'beta'),
        link('alpha', 'internal', './beta.md', 120, 'beta'),
        link('alpha', 'broken', './missing.md', 140),
        link('alpha', 'external', 'https://example.com', 160),
        link('alpha', 'out-of-bundle', '../../outside.md', 180),
        link('alpha', 'fragment', '#section', 200),
        link('alpha', 'directory', './folder/', 220),
      ],
    });
    const beta = concept('beta', { type: 'Known', tags: ['shared'] });
    const orphan = concept('zeta/orphan', {
      type: '__future/custom',
      tags: ['orphan'],
    });

    const graph = buildGraphPayload(bundle([orphan, beta, alpha]));

    expect(graph.protocolVersion).toBe(1);
    expect(graph.revision).toBe(42);
    expect(graph.nodes.map((node) => node.id)).toEqual(['alpha', 'beta', 'zeta/orphan']);
    expect(graph.nodes[0]).toMatchObject({
      resource: 'urn:okf:alpha',
      timestamp: '2026-07-22T09:30:00+09:00',
    });
    expect(graph.nodes[1]).not.toHaveProperty('resource');
    expect(graph.nodes[1]).not.toHaveProperty('timestamp');
    expect(graph.nodes.every((node) => !Object.hasOwn(node, 'sourceUri'))).toBe(true);
    expect(graph.nodes.every((node) => !Object.hasOwn(node, 'source'))).toBe(true);
    expect(JSON.stringify(graph)).not.toContain(rootUri);
    expect(
      graph.nodes.map(({ id, orphan: isOrphan, brokenLinkCount }) => [
        id,
        isOrphan,
        brokenLinkCount,
      ]),
    ).toEqual([
      ['alpha', false, 1],
      ['beta', false, 0],
      ['zeta/orphan', true, 0],
    ]);

    expect(graph.edges).toHaveLength(2);
    expect(
      graph.edges.map(({ source, target, sourceRange }) => [
        source,
        target,
        sourceRange.start.offset,
      ]),
    ).toEqual([
      ['alpha', 'beta', 100],
      ['alpha', 'beta', 120],
    ]);
    expect(new Set(graph.edges.map((edge) => edge.id)).size).toBe(2);
    expect(graph.backlinks).toEqual({ alpha: [], beta: ['alpha'], 'zeta/orphan': [] });
    expect(graph.brokenLinks).toEqual([
      {
        sourceId: 'alpha',
        label: 'Label ./missing.md',
        rawTarget: './missing.md',
        sourceRange: range(140, 152),
      },
    ]);
    expect(graph.statistics).toEqual({
      conceptCount: 3,
      edgeCount: 2,
      orphanCount: 1,
      brokenLinkCount: 1,
      typeCounts: { Known: 2, '__future/custom': 1 },
      tagCounts: { alpha: 1, orphan: 1, shared: 2 },
    });
    expect(JSON.parse(JSON.stringify(graph))).toEqual(graph);
  });

  it('is independent of parser inventory ordering and never creates a phantom concept node', () => {
    const source = concept('source', {
      links: [
        link('source', 'internal', './target.md', 50, 'target'),
        link('source', 'internal', './vanished.md', 70, 'vanished'),
      ],
    });
    const target = concept('target');

    const forward = buildGraphPayload(bundle([source, target]));
    const reverse = buildGraphPayload(bundle([target, source]));

    expect(reverse).toEqual(forward);
    expect(forward.nodes.map((node) => node.id)).toEqual(['source', 'target']);
    expect(forward.edges).toHaveLength(1);
    expect(forward.brokenLinks).toEqual([
      {
        sourceId: 'source',
        label: 'Label ./vanished.md',
        rawTarget: './vanished.md',
        sourceRange: range(70, 83),
      },
    ]);
    expect(forward.statistics).toMatchObject({
      conceptCount: 2,
      edgeCount: 1,
      brokenLinkCount: 1,
    });
  });

  it('does not mark a self-linked concept as an orphan', () => {
    const self = concept('self', {
      links: [link('self', 'internal', './self.md', 10, 'self')],
    });

    const graph = buildGraphPayload(bundle([self]));
    expect(graph.nodes[0]).toMatchObject({ id: 'self', orphan: false });
    expect(graph.backlinks).toEqual({ self: ['self'] });
    expect(graph.statistics.orphanCount).toBe(0);
  });
});
