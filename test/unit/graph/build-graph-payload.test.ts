import { describe, expect, it } from 'vitest';

import type {
  Concept,
  ConceptLink,
  ParseFailure,
  ParsedBundle,
  SourceRange,
} from '../../../src/core/model/index.js';
import { OKF_SEMANTIC_LIMITS } from '../../../src/core/model/index.js';
import {
  buildGraphPayload,
  graphPayloadJsonByteLength,
  GraphResourceLimitError,
} from '../../../src/core/graph/index.js';

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
      contentHash: 'sha256:test',
    },
    frontmatter: {
      raw: normalized,
      explicitTags: {},
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

function bundle(
  concepts: readonly Concept[],
  failures: readonly ParseFailure[] = [],
): ParsedBundle {
  return {
    rootUri,
    revision: 42,
    concepts,
    reservedDocuments: [],
    failures,
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
    expect(graph.edges.map(({ id }) => id)).toEqual(['edge:0', 'edge:1']);
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

  it('uses v0.2 defaults only when their fields are absent and suppresses legacy timestamps when generated is present', () => {
    const base = concept('v02-boundaries', {
      timestamp: '2026-07-22T09:30:00Z',
    });
    const v02: Concept = {
      ...base,
      frontmatter: {
        ...base.frontmatter,
        raw: {
          ...base.frontmatter.raw,
          generated: { by: 'process:test' },
          status: true,
        },
        normalized: {
          ...base.frontmatter.normalized,
          generated: { by: 'process:test' },
          trustTier: 'machine-confirmed',
          sources: [{ resource: 'https://example.com/source' }],
          runtime: 'bigquery',
          computation: 'references/query.sql',
        },
      },
      generated: { by: 'process:test' },
      trustTier: 'machine-confirmed',
      sources: [{ resource: 'https://example.com/source' }],
      runtime: 'bigquery',
      computation: 'references/query.sql',
    };

    const graph = buildGraphPayload(bundle([v02]));

    expect(graph.nodes[0]).toMatchObject({
      generatedBy: 'process:test',
      trustTier: 'machine-confirmed',
      sourceCount: 1,
      runtime: 'bigquery',
      computation: 'references/query.sql',
    });
    expect(graph.nodes[0]).not.toHaveProperty('timestamp');
    expect(graph.nodes[0]).not.toHaveProperty('status');
    expect(graphPayloadJsonByteLength(graph)).toBe(
      new TextEncoder().encode(JSON.stringify(graph)).byteLength,
    );
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

  it('fails closed on duplicate non-empty concept IDs independent of inventory order', () => {
    const first = concept('duplicate', { type: 'first' });
    const second = { ...concept('duplicate', { type: 'second' }), title: 'Second duplicate' };

    for (const concepts of [
      [first, second],
      [second, first],
    ]) {
      expect(() => buildGraphPayload(bundle(concepts))).toThrow(/duplicate concept ID/u);
    }
  });

  it('indexes failed sources by exact URI and path components without delimiter collisions', () => {
    const healthy = {
      ...concept('healthy', { type: 'safe' }),
      source: {
        uri: 'a',
        bundlePath: 'b\0c',
        contentHash: 'sha256:healthy',
      },
    };
    const graph = buildGraphPayload(
      bundle(
        [healthy],
        [
          {
            kind: 'parse-failure',
            uri: 'a\0b',
            bundlePath: 'c',
            reason: 'read',
            message: 'Different source.',
          },
        ],
      ),
    );

    expect(graph.nodes[0]).toMatchObject({ id: 'healthy', type: 'safe' });
    expect(graph.nodes[0]).not.toHaveProperty('sourceFailed');
  });

  it('orders equal-offset relationships by the complete source range tuple', () => {
    const firstRange: SourceRange = {
      start: { offset: 10, line: 1, character: 2 },
      end: { offset: 20, line: 1, character: 12 },
    };
    const secondRange: SourceRange = {
      start: { offset: 10, line: 2, character: 1 },
      end: { offset: 20, line: 2, character: 11 },
    };
    const internalFirst = {
      ...link('source', 'internal', './target.md', 10, 'target'),
      range: firstRange,
    };
    const internalSecond = {
      ...link('source', 'internal', './target.md', 10, 'target'),
      range: secondRange,
    };
    const brokenFirst = {
      ...link('source', 'broken', './missing.md', 10),
      range: firstRange,
    };
    const brokenSecond = {
      ...link('source', 'broken', './missing.md', 10),
      range: secondRange,
    };
    const forward = buildGraphPayload(
      bundle([
        concept('source', {
          links: [internalSecond, brokenSecond, internalFirst, brokenFirst],
        }),
        concept('target'),
      ]),
    );
    const reverse = buildGraphPayload(
      bundle([
        concept('target'),
        concept('source', {
          links: [brokenFirst, internalFirst, brokenSecond, internalSecond],
        }),
      ]),
    );

    expect(reverse).toEqual(forward);
    expect(forward.edges.map(({ sourceRange }) => sourceRange.start.line)).toEqual([1, 2]);
    expect(forward.brokenLinks.map(({ sourceRange }) => sourceRange.start.line)).toEqual([1, 2]);
  });

  it('rejects an empty unresolved internal target before producing a decoder-invalid graph', () => {
    const invalid = concept('source', {
      links: [link('source', 'internal', '', 10)],
    });

    expect(() => buildGraphPayload(bundle([invalid]))).toThrow(
      /internal or broken-link target must not be empty/u,
    );
  });

  it('does not let an invalid empty concept ID poison the complete graph payload', () => {
    const graph = buildGraphPayload(bundle([concept(''), concept('valid')]));

    expect(graph.nodes.map(({ id }) => id)).toEqual(['valid']);
    expect(graph.backlinks).toEqual({ valid: [] });
    expect(graph.statistics).toMatchObject({ conceptCount: 1, orphanCount: 1 });

    const exactTypes = Array.from({ length: OKF_SEMANTIC_LIMITS.maxUniqueGraphTypes }, (_, index) =>
      concept(`valid-${String(index)}`, { type: `type-${String(index)}` }),
    );
    const withDiscardedSentinel = buildGraphPayload(
      bundle([...exactTypes, concept('', { type: 'must-not-spend-a-type' })]),
    );
    expect(Object.keys(withDiscardedSentinel.statistics.typeCounts)).toHaveLength(
      OKF_SEMANTIC_LIMITS.maxUniqueGraphTypes,
    );
    expect(withDiscardedSentinel.statistics.typeCounts).not.toHaveProperty('must-not-spend-a-type');
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

  it('keeps a failed source as an identity-only node without derived curation metadata', () => {
    const failed = concept('failed', {
      type: 'must-not-leak',
      tags: ['must-not-leak'],
      links: [link('failed', 'broken', './missing.md', 10)],
    });
    const valid = concept('valid', { type: 'reference', tags: ['safe'] });
    const graph = buildGraphPayload(
      bundle(
        [failed, valid],
        [
          {
            kind: 'parse-failure',
            uri: failed.source.uri,
            bundlePath: failed.source.bundlePath,
            reason: 'frontmatter',
            message: 'Invalid YAML.',
          },
        ],
      ),
    );

    expect(graph.nodes).toEqual([
      {
        id: 'failed',
        sourceFailed: true,
        type: '',
        tags: [],
        orphan: false,
        brokenLinkCount: 0,
      },
      expect.objectContaining({ id: 'valid', type: 'reference', orphan: true }),
    ]);
    expect(graph.brokenLinks).toEqual([]);
    expect(graph.statistics).toMatchObject({
      conceptCount: 2,
      orphanCount: 1,
      brokenLinkCount: 0,
      typeCounts: { reference: 1 },
      tagCounts: { safe: 1 },
    });
  });

  it('does not spend exact type or tag cardinality on a failed-source sentinel', () => {
    const valid = Array.from({ length: OKF_SEMANTIC_LIMITS.maxUniqueGraphTypes }, (_, index) =>
      concept(`valid-${String(index)}`, {
        type: `type-${String(index)}`,
        tags: [`tag-${String(index)}`],
      }),
    );
    const failed = concept('failed', {
      type: 'must-not-spend-a-type',
      tags: ['must-not-spend-a-tag'],
      links: [link('failed', 'broken', './must-not-spend-a-link.md', 10)],
    });
    const graph = buildGraphPayload(
      bundle(
        [...valid, failed],
        [
          {
            kind: 'parse-failure',
            uri: failed.source.uri,
            bundlePath: failed.source.bundlePath,
            reason: 'resource-limit',
            scope: 'document',
            message: 'Source was not parsed.',
          },
        ],
      ),
    );

    expect(Object.keys(graph.statistics.typeCounts)).toHaveLength(
      OKF_SEMANTIC_LIMITS.maxUniqueGraphTypes,
    );
    expect(graph.statistics.typeCounts).not.toHaveProperty('must-not-spend-a-type');
    expect(graph.statistics.tagCounts).not.toHaveProperty('must-not-spend-a-tag');
    expect(graph.brokenLinks).toEqual([]);
  });

  it('uses compact deterministic edge IDs that never embed long concept identities', () => {
    const prefix = 'a'.repeat(1_000);
    const source = concept(`${prefix}-source`, {
      links: [link(`${prefix}-source`, 'internal', './target.md', 4, `${prefix}-target`)],
    });
    const target = concept(`${prefix}-target`);

    const graph = buildGraphPayload(bundle([target, source]));

    expect(graph.edges[0]?.id).toBe('edge:0');
    expect(graph.edges[0]?.id.length).toBeLessThanOrEqual(
      OKF_SEMANTIC_LIMITS.maxCompactGraphEdgeIdCodeUnits,
    );
    expect(graph.edges[0]?.id).not.toContain(prefix);
  });

  it('counts escaped JSON bytes exactly without materializing a serialized payload', () => {
    const special = concept('special', {
      type: 'quote"slash\\line\n',
      tags: ['雪', '\u0001', '\ud800'],
    });
    const graph = buildGraphPayload(bundle([special]));

    expect(graphPayloadJsonByteLength(graph)).toBe(
      new TextEncoder().encode(JSON.stringify(graph)).byteLength,
    );

    const sparse = { ...graph, nodes: new Array(2) } as unknown as typeof graph;
    expect(graphPayloadJsonByteLength(sparse)).toBe(
      new TextEncoder().encode(JSON.stringify(sparse)).byteLength,
    );
  });

  it('fails closed on one-over graph string and cardinality limits', () => {
    expect(
      buildGraphPayload(
        bundle([
          concept('exact-type', {
            type: 'x'.repeat(OKF_SEMANTIC_LIMITS.maxTypeCodeUnits),
          }),
        ]),
      ).nodes[0]?.type,
    ).toHaveLength(OKF_SEMANTIC_LIMITS.maxTypeCodeUnits);
    expect(() =>
      buildGraphPayload(
        bundle([
          concept('oversized-type', {
            type: 'x'.repeat(OKF_SEMANTIC_LIMITS.maxTypeCodeUnits + 1),
          }),
        ]),
      ),
    ).toThrow(GraphResourceLimitError);

    const excessiveTypes = Array.from(
      { length: OKF_SEMANTIC_LIMITS.maxUniqueGraphTypes + 1 },
      (_, index) => concept(`type-${String(index)}`, { type: `type-${String(index)}` }),
    );
    expect(() => buildGraphPayload(bundle(excessiveTypes))).toThrow(/type cardinality limit/u);
  });

  it('bounds aggregate producer identities before building lookup keys', () => {
    const failureUri = `file:///${'u'.repeat(
      OKF_SEMANTIC_LIMITS.maxSourceUriCodeUnits - 'file:///'.length,
    )}`;
    const failureCount =
      Math.floor(OKF_SEMANTIC_LIMITS.maxGraphIdentityBytes / failureUri.length) + 1;
    const failures = Array.from({ length: failureCount }, (_, index): ParseFailure => ({
      kind: 'parse-failure',
      uri: failureUri,
      bundlePath: `failure-${String(index)}.md`,
      reason: 'read',
      message: 'Unreadable.',
    }));

    expect(() => buildGraphPayload(bundle([], failures))).toThrow(/aggregate limit/u);
  });

  it('accepts the exact serialized graph cap and refuses one extra byte before serialization', () => {
    const concepts = Array.from({ length: 1_100 }, (_, index) =>
      concept(`payload-${String(index).padStart(4, '0')}`, {
        type: 'concept',
      }),
    ).map((item) => ({ ...item, description: '' }));
    const baseGraph = buildGraphPayload(bundle(concepts));
    let remaining =
      OKF_SEMANTIC_LIMITS.maxGraphPayloadBytes - graphPayloadJsonByteLength(baseGraph);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThan(concepts.length * OKF_SEMANTIC_LIMITS.maxDescriptionCodeUnits);
    const padded = concepts.map((item) => {
      const length = Math.min(remaining, OKF_SEMANTIC_LIMITS.maxDescriptionCodeUnits);
      remaining -= length;
      return { ...item, description: 'x'.repeat(length) };
    });
    expect(remaining).toBe(0);

    const exact = buildGraphPayload(bundle(padded));
    expect(graphPayloadJsonByteLength(exact)).toBe(OKF_SEMANTIC_LIMITS.maxGraphPayloadBytes);

    const expandableIndex = padded.findIndex(
      ({ description }) => description.length < OKF_SEMANTIC_LIMITS.maxDescriptionCodeUnits,
    );
    expect(expandableIndex).toBeGreaterThanOrEqual(0);
    const oneOver = padded.map((item, index) =>
      index === expandableIndex ? { ...item, description: `${item.description}x` } : item,
    );
    expect(() => buildGraphPayload(bundle(oneOver))).toThrow(/serialized payload limit/u);
  });

  it('does not reject a bounded graph because a non-serialized diagnostic message is long', () => {
    const longId = 'long-id-'.repeat(375);
    const item = concept(longId);
    const input = bundle([item]);
    const graph = buildGraphPayload({
      ...input,
      findings: [
        {
          code: 'okf.curation.orphan-concept',
          category: 'curation',
          severity: 'warning',
          uri: item.source.uri,
          message: `OKF curation: ${'detail'.repeat(1_000)}`,
        },
      ],
    });

    expect(graph.nodes[0]?.id).toBe(longId);
  });
});
