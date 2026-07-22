import { describe, expect, it } from 'vitest';
import {
  decodeExtensionToWebviewMessage,
  decodeWebviewToExtensionMessage,
} from '../../../src/shared/protocol/index.js';
import { graphNode, graphPayload, sourceRange } from './fixtures.js';

describe('extension-to-Webview protocol decoder', () => {
  it('accepts a current replacement graph whose envelope and payload revisions agree', () => {
    const payload = graphPayload({ revision: 4 });
    const result = decodeExtensionToWebviewMessage(
      { protocolVersion: 1, type: 'replaceGraph', revision: 4, payload },
      3,
    );

    expect(result).toEqual({
      ok: true,
      value: { protocolVersion: 1, type: 'replaceGraph', revision: 4, payload },
    });
  });

  it('accepts normalized resource and timestamp metadata without a source URI', () => {
    const payload = graphPayload();
    const result = decodeExtensionToWebviewMessage(
      { protocolVersion: 1, type: 'replaceGraph', revision: 1, payload },
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
        { protocolVersion: 1, type: 'replaceGraph', revision: 5, payload },
        3,
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
    expect(
      decodeExtensionToWebviewMessage(
        { protocolVersion: 1, type: 'replaceGraph', revision: 4, payload },
        5,
      ),
    ).toMatchObject({ ok: false, error: { code: 'stale-revision' } });
  });

  it('rejects malformed graph references and unknown fields', () => {
    const payload = graphPayload({
      edges: [{ id: 'alpha:0:missing', source: 'alpha', target: 'missing', sourceRange }],
    });
    expect(
      decodeExtensionToWebviewMessage(
        { protocolVersion: 1, type: 'replaceGraph', revision: 1, payload },
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

  it('keeps a missing-type diagnostic node without rejecting the valid graph around it', () => {
    const payload = graphPayload({
      nodes: [graphNode(), graphNode({ id: 'missing-type', title: 'Missing Type', type: '' })],
      edges: [],
      backlinks: { alpha: [], 'missing-type': [] },
      statistics: {
        conceptCount: 2,
        edgeCount: 0,
        orphanCount: 0,
        brokenLinkCount: 0,
        typeCounts: { concept: 1, '': 1 },
        tagCounts: { first: 2 },
      },
    });

    const result = decodeExtensionToWebviewMessage(
      { protocolVersion: 1, type: 'replaceGraph', revision: 1, payload },
      0,
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.type !== 'replaceGraph') {
      throw new Error('Expected the diagnostic node to remain in a replacement graph.');
    }
    expect(result.value.payload.nodes.map((node) => node.id)).toEqual(['alpha', 'missing-type']);
  });
});

describe('Webview-to-extension protocol decoder', () => {
  it('accepts ready, current graph outcomes, and node-only source action', () => {
    expect(decodeWebviewToExtensionMessage({ protocolVersion: 1, type: 'ready' }, 7)).toMatchObject(
      {
        ok: true,
        value: { type: 'ready' },
      },
    );
    expect(
      decodeWebviewToExtensionMessage(
        { protocolVersion: 1, type: 'graphRendered', revision: 7 },
        7,
      ),
    ).toMatchObject({ ok: true, value: { type: 'graphRendered', revision: 7 } });
    expect(
      decodeWebviewToExtensionMessage(
        {
          protocolVersion: 1,
          type: 'graphRenderFailed',
          revision: 7,
          reason: 'renderer-construction-failed',
        },
        7,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        type: 'graphRenderFailed',
        revision: 7,
        reason: 'renderer-construction-failed',
      },
    });
    expect(
      decodeWebviewToExtensionMessage(
        { protocolVersion: 1, type: 'openSource', revision: 7, nodeId: 'nested/alpha' },
        7,
      ),
    ).toMatchObject({ ok: true, value: { nodeId: 'nested/alpha' } });
  });

  it('rejects stale actions and any Webview-supplied source URI', () => {
    expect(
      decodeWebviewToExtensionMessage(
        { protocolVersion: 1, type: 'graphRendered', revision: 6 },
        7,
      ),
    ).toMatchObject({ ok: false, error: { code: 'stale-revision' } });
    expect(
      decodeWebviewToExtensionMessage(
        {
          protocolVersion: 1,
          type: 'graphRenderFailed',
          revision: 7,
          reason: 'sensitive exception text',
        },
        7,
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
    expect(
      decodeWebviewToExtensionMessage(
        { protocolVersion: 1, type: 'openSource', revision: 6, nodeId: 'alpha' },
        7,
      ),
    ).toMatchObject({ ok: false, error: { code: 'stale-revision' } });
    expect(
      decodeWebviewToExtensionMessage(
        {
          protocolVersion: 1,
          type: 'openSource',
          revision: 7,
          nodeId: 'alpha',
          sourceUri: 'file:///untrusted.md',
        },
        7,
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
  });
});
