import { describe, expect, it } from 'vitest';
import { OKF_SEMANTIC_LIMITS } from '../../../src/core/model/index.js';
import {
  decodeExtensionToWebviewMessage,
  decodeWebviewToExtensionMessage,
  isGraphPayload,
} from '../../../src/shared/protocol/index.js';
import { graphNode, graphPayload, sourceRange } from './fixtures.js';

describe('extension-to-Webview protocol decoder', () => {
  it('accepts a current replacement graph whose envelope and payload revisions agree', () => {
    const payload = graphPayload({ revision: 4 });
    const result = decodeExtensionToWebviewMessage(
      { protocolVersion: 1, type: 'replaceGraph', revision: 4, deliveryId: 1, payload },
      3,
    );

    expect(result).toEqual({
      ok: true,
      value: {
        protocolVersion: 1,
        type: 'replaceGraph',
        revision: 4,
        deliveryId: 1,
        payload,
      },
    });
  });

  it('accepts normalized resource and timestamp metadata without a source URI', () => {
    const payload = graphPayload();
    const result = decodeExtensionToWebviewMessage(
      { protocolVersion: 1, type: 'replaceGraph', revision: 1, deliveryId: 1, payload },
      0,
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.type !== 'replaceGraph') {
      throw new Error('Expected a decoded replacement graph.');
    }
    expect(result.value.payload.nodes[0]).toMatchObject({
      resource: 'urn:okf:alpha',
      timestamp: '2026-07-22T09:30:00+09:00',
    });
    expect(JSON.stringify(payload.nodes)).not.toContain('file:///');
    expect(payload.nodes.every((node) => !Object.hasOwn(node, 'sourceUri'))).toBe(true);
  });

  it('rejects mismatched and stale revisions', () => {
    const payload = graphPayload({ revision: 4 });
    expect(
      decodeExtensionToWebviewMessage(
        { protocolVersion: 1, type: 'replaceGraph', revision: 5, deliveryId: 1, payload },
        3,
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
    expect(
      decodeExtensionToWebviewMessage(
        { protocolVersion: 1, type: 'replaceGraph', revision: 4, deliveryId: 1, payload },
        5,
      ),
    ).toMatchObject({ ok: false, error: { code: 'stale-revision' } });
  });

  it('rejects an older or replayed delivery after a newer post of the same revision', () => {
    const payload = graphPayload({ revision: 4 });
    expect(
      decodeExtensionToWebviewMessage(
        { protocolVersion: 1, type: 'replaceGraph', revision: 4, deliveryId: 3, payload },
        4,
        4,
      ),
    ).toMatchObject({ ok: false, error: { code: 'stale-revision' } });
    expect(
      decodeExtensionToWebviewMessage(
        { protocolVersion: 1, type: 'replaceGraph', revision: 4, deliveryId: 4, payload },
        4,
        4,
      ),
    ).toMatchObject({ ok: false, error: { code: 'stale-revision' } });
    expect(
      decodeExtensionToWebviewMessage(
        { protocolVersion: 1, type: 'replaceGraph', revision: 4, deliveryId: 5, payload },
        4,
        4,
      ),
    ).toMatchObject({ ok: true, value: { type: 'replaceGraph', deliveryId: 5 } });
  });

  it('rejects malformed graph references and unknown fields', () => {
    const payload = graphPayload({
      edges: [{ id: 'alpha:0:missing', source: 'alpha', target: 'missing', sourceRange }],
    });
    expect(
      decodeExtensionToWebviewMessage(
        { protocolVersion: 1, type: 'replaceGraph', revision: 1, deliveryId: 1, payload },
        0,
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
    expect(
      decodeExtensionToWebviewMessage(
        { protocolVersion: 1, type: 'status', revision: 1, status: 'ready', unexpected: true },
        0,
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
    expect(
      decodeExtensionToWebviewMessage(
        {
          protocolVersion: 1,
          type: 'replaceGraph',
          revision: 1,
          deliveryId: 1,
          payload: {
            ...graphPayload(),
            nodes: [graphNode(), { ...graphNode({ id: 'beta' }), resource: 7 }],
          },
        },
        0,
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
    expect(
      decodeExtensionToWebviewMessage(
        {
          protocolVersion: 1,
          type: 'replaceGraph',
          revision: 1,
          deliveryId: 1,
          payload: {
            ...graphPayload(),
            nodes: [
              { ...graphNode(), sourceUri: 'file:///workspace/knowledge/alpha.md' },
              graphNode({ id: 'beta' }),
            ],
          },
        },
        0,
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
  });

  it('rejects a non-ordinal edge identity even when its references are valid', () => {
    const payload = graphPayload();
    expect(
      isGraphPayload({
        ...payload,
        edges: [{ ...payload.edges[0], id: 'not-an-ordinal' }],
      }),
    ).toBe(false);
  });

  it('rejects sparse graph arrays without throwing during validation', () => {
    const payload = graphPayload();
    const sparseNodes = new Array(payload.nodes.length);
    const sparseEdges = new Array(1);
    const sparseBrokenLinks = new Array(1);
    const sparseTags = new Array(1);
    const sparseBacklinks = new Array(1);

    for (const candidate of [
      { ...payload, nodes: sparseNodes },
      { ...payload, edges: sparseEdges },
      { ...payload, brokenLinks: sparseBrokenLinks },
      { ...payload, nodes: [{ ...payload.nodes[0], tags: sparseTags }, payload.nodes[1]] },
      { ...payload, backlinks: { ...payload.backlinks, alpha: sparseBacklinks } },
    ]) {
      expect(() => isGraphPayload(candidate)).not.toThrow();
      expect(isGraphPayload(candidate)).toBe(false);
    }
  });

  it('requires every backlink node ID to be an own record key', () => {
    for (const id of ['toString', '__proto__']) {
      const candidate = graphPayload({
        nodes: [graphNode({ id, orphan: true })],
        edges: [],
        backlinks: { extra: [] },
        brokenLinks: [],
        statistics: {
          conceptCount: 1,
          edgeCount: 0,
          orphanCount: 1,
          brokenLinkCount: 0,
          typeCounts: { concept: 1 },
          tagCounts: { first: 1 },
        },
      });

      expect(() => isGraphPayload(candidate)).not.toThrow();
      expect(isGraphPayload(candidate)).toBe(false);
    }
  });

  it('keeps a missing-type diagnostic node without rejecting the valid graph around it', () => {
    const payload = graphPayload({
      nodes: [
        graphNode({ orphan: true }),
        graphNode({ id: 'missing-type', title: 'Missing Type', type: '', orphan: true }),
      ],
      edges: [],
      backlinks: { alpha: [], 'missing-type': [] },
      statistics: {
        conceptCount: 2,
        edgeCount: 0,
        orphanCount: 2,
        brokenLinkCount: 0,
        typeCounts: { concept: 1, '': 1 },
        tagCounts: { first: 2 },
      },
    });

    const result = decodeExtensionToWebviewMessage(
      { protocolVersion: 1, type: 'replaceGraph', revision: 1, deliveryId: 1, payload },
      0,
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.type !== 'replaceGraph') {
      throw new Error('Expected the diagnostic node to remain in a replacement graph.');
    }
    expect(result.value.payload.nodes.map((node) => node.id)).toEqual(['alpha', 'missing-type']);
  });

  it('accepts an identity-only failed source while excluding it from derived statistics', () => {
    const payload = graphPayload({
      nodes: [
        graphNode({ orphan: true }),
        {
          id: 'failed',
          sourceFailed: true,
          type: '',
          tags: [],
          orphan: false,
          brokenLinkCount: 0,
        },
      ],
      edges: [],
      backlinks: { alpha: [], failed: [] },
      statistics: {
        conceptCount: 2,
        edgeCount: 0,
        orphanCount: 1,
        brokenLinkCount: 0,
        typeCounts: { concept: 1 },
        tagCounts: { first: 1 },
      },
    });

    expect(isGraphPayload(payload)).toBe(true);
    expect(
      isGraphPayload({
        ...payload,
        nodes: [{ ...payload.nodes[1], title: 'Spoofed parsed metadata' }],
      }),
    ).toBe(false);

    const validIncoming = {
      ...payload,
      nodes: [{ ...payload.nodes[0], orphan: false }, payload.nodes[1]],
      edges: [{ id: 'edge:0', source: 'alpha', target: 'failed', sourceRange }],
      backlinks: { alpha: [], failed: ['alpha'] },
      statistics: { ...payload.statistics, edgeCount: 1, orphanCount: 0 },
    };
    expect(isGraphPayload(validIncoming)).toBe(true);
    expect(
      isGraphPayload({
        ...validIncoming,
        edges: [{ id: 'edge:0', source: 'failed', target: 'alpha', sourceRange }],
        backlinks: { alpha: ['failed'], failed: [] },
      }),
    ).toBe(false);
    expect(
      isGraphPayload({
        ...payload,
        brokenLinks: [
          {
            sourceId: 'failed',
            label: 'Unparsed source claim',
            rawTarget: './missing.md',
            sourceRange,
          },
        ],
        statistics: { ...payload.statistics, brokenLinkCount: 1 },
      }),
    ).toBe(false);
  });

  it('rejects one-over graph identities, tags, node counts, and inconsistent summaries', () => {
    expect(
      isGraphPayload(
        graphPayload({
          nodes: [
            graphNode({
              id: 'x'.repeat(OKF_SEMANTIC_LIMITS.maxProviderPathCodeUnits + 1),
            }),
          ],
          edges: [],
          backlinks: {},
        }),
      ),
    ).toBe(false);
    expect(
      isGraphPayload(
        graphPayload({
          nodes: [
            graphNode({
              tags: Array.from(
                { length: OKF_SEMANTIC_LIMITS.maxTagsPerConcept + 1 },
                (_, index) => `tag-${String(index)}`,
              ),
            }),
          ],
        }),
      ),
    ).toBe(false);
    expect(
      isGraphPayload(
        graphPayload({
          nodes: Array.from({ length: OKF_SEMANTIC_LIMITS.maxGraphNodes + 1 }, (_, index) =>
            graphNode({ id: `node-${String(index)}` }),
          ),
        }),
      ),
    ).toBe(false);
    expect(
      isGraphPayload(
        graphPayload({
          statistics: {
            ...graphPayload().statistics,
            conceptCount: 99,
          },
        }),
      ),
    ).toBe(false);
  });

  it('rejects a graph whose escaped serialized payload exceeds the shared byte cap', () => {
    const description = 'x'.repeat(OKF_SEMANTIC_LIMITS.maxDescriptionCodeUnits);
    const nodes = Array.from({ length: 1_100 }, (_, index) =>
      graphNode({
        id: `payload-${String(index).padStart(4, '0')}`,
        description,
        tags: [],
        orphan: true,
      }),
    );
    const backlinks = Object.fromEntries(nodes.map((node) => [node.id, []]));
    expect(
      isGraphPayload({
        protocolVersion: 1,
        revision: 1,
        nodes,
        edges: [],
        backlinks,
        brokenLinks: [],
        statistics: {
          conceptCount: nodes.length,
          edgeCount: 0,
          orphanCount: nodes.length,
          brokenLinkCount: 0,
          typeCounts: { concept: nodes.length },
          tagCounts: {},
        },
      }),
    ).toBe(false);
  });
});

describe('Webview-to-extension protocol decoder', () => {
  it('accepts ready, current graph outcomes, and node-only source action', () => {
    const delivery = { revision: 7, deliveryId: 4 };
    expect(
      decodeWebviewToExtensionMessage({ protocolVersion: 1, type: 'ready' }, delivery),
    ).toMatchObject({
      ok: true,
      value: { type: 'ready' },
    });
    expect(
      decodeWebviewToExtensionMessage(
        { protocolVersion: 1, type: 'graphRendered', ...delivery },
        delivery,
      ),
    ).toMatchObject({ ok: true, value: { type: 'graphRendered', ...delivery } });
    expect(
      decodeWebviewToExtensionMessage(
        {
          protocolVersion: 1,
          type: 'graphRenderFailed',
          ...delivery,
          reason: 'renderer-construction-failed',
        },
        delivery,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        type: 'graphRenderFailed',
        ...delivery,
        reason: 'renderer-construction-failed',
      },
    });
    expect(
      decodeWebviewToExtensionMessage(
        { protocolVersion: 1, type: 'openSource', ...delivery, nodeId: 'nested/alpha' },
        delivery,
      ),
    ).toMatchObject({ ok: true, value: { nodeId: 'nested/alpha' } });
  });

  it('rejects stale actions and any Webview-supplied source URI', () => {
    const delivery = { revision: 7, deliveryId: 4 };
    expect(
      decodeWebviewToExtensionMessage(
        { protocolVersion: 1, type: 'graphRendered', revision: 6, deliveryId: 4 },
        delivery,
      ),
    ).toMatchObject({ ok: false, error: { code: 'stale-revision' } });
    expect(
      decodeWebviewToExtensionMessage(
        {
          protocolVersion: 1,
          type: 'graphRenderFailed',
          revision: 7,
          deliveryId: 4,
          reason: 'sensitive exception text',
        },
        delivery,
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
    expect(
      decodeWebviewToExtensionMessage(
        { protocolVersion: 1, type: 'openSource', revision: 6, deliveryId: 4, nodeId: 'alpha' },
        delivery,
      ),
    ).toMatchObject({ ok: false, error: { code: 'stale-revision' } });
    expect(
      decodeWebviewToExtensionMessage(
        {
          protocolVersion: 1,
          type: 'openSource',
          revision: 7,
          deliveryId: 4,
          nodeId: 'alpha',
          sourceUri: 'file:///untrusted.md',
        },
        delivery,
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
    expect(
      decodeWebviewToExtensionMessage(
        { protocolVersion: 1, type: 'graphRendered', revision: 7, deliveryId: 3 },
        delivery,
      ),
    ).toMatchObject({ ok: false, error: { code: 'stale-revision' } });
  });
});
