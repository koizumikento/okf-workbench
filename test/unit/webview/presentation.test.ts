import { describe, expect, it } from 'vitest';
import {
  createInitialPresentationState,
  presentationReducer,
  visibleNodes,
} from '../../../src/webview/state/presentation.js';
import { graphNode, graphPayload } from './fixtures.js';

describe('Webview presentation reducer', () => {
  it('accepts replacement graphs monotonically and clears missing selection', () => {
    const firstGraph = graphPayload({ revision: 2 });
    let state = presentationReducer(createInitialPresentationState(), {
      type: 'replaceGraph',
      graph: firstGraph,
    });
    state = presentationReducer(state, { type: 'selectNode', nodeId: 'alpha' });

    const stale = presentationReducer(state, {
      type: 'replaceGraph',
      graph: graphPayload({ revision: 1 }),
    });
    expect(stale).toBe(state);

    state = presentationReducer(state, {
      type: 'replaceGraph',
      graph: graphPayload({
        revision: 3,
        nodes: [graphNode({ id: 'beta' })],
        edges: [],
        backlinks: { beta: [] },
      }),
    });
    expect(state.revision).toBe(3);
    expect(state.selectedNodeId).toBeUndefined();
  });

  it('composes search, type, and tag filters without mutating the graph', () => {
    const graph = graphPayload({
      nodes: [
        graphNode({ id: 'alpha', title: 'Alpha', type: 'note', tags: ['red'] }),
        graphNode({ id: 'beta', title: 'Beta', type: 'note', tags: ['blue'] }),
        graphNode({ id: 'gamma', title: 'Gamma', type: 'decision', tags: ['red'] }),
      ],
      edges: [],
      backlinks: { alpha: [], beta: [], gamma: [] },
      statistics: {
        conceptCount: 3,
        edgeCount: 0,
        orphanCount: 0,
        brokenLinkCount: 0,
        typeCounts: { note: 2, decision: 1 },
        tagCounts: { red: 2, blue: 1 },
      },
    });
    let state = presentationReducer(createInitialPresentationState(), {
      type: 'replaceGraph',
      graph,
    });
    state = presentationReducer(state, { type: 'setSearch', query: 'a' });
    state = presentationReducer(state, { type: 'toggleType', value: 'note' });
    state = presentationReducer(state, { type: 'toggleTag', value: 'red' });

    expect(visibleNodes(state).map((node) => node.id)).toEqual(['alpha']);
    expect(graph.nodes).toHaveLength(3);

    state = presentationReducer(state, { type: 'clearFilters' });
    expect(visibleNodes(state).map((node) => node.id)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('rejects selection of a node outside the current graph', () => {
    const state = presentationReducer(
      presentationReducer(createInitialPresentationState(), {
        type: 'replaceGraph',
        graph: graphPayload(),
      }),
      { type: 'selectNode', nodeId: 'missing' },
    );
    expect(state.selectedNodeId).toBeUndefined();
  });

  it('does not advance the actionable graph revision for a future loading status', () => {
    let state = presentationReducer(createInitialPresentationState(), {
      type: 'replaceGraph',
      graph: graphPayload({ revision: 2 }),
    });
    state = presentationReducer(state, {
      type: 'setStatus',
      revision: 3,
      status: 'loading',
      message: undefined,
    });

    expect(state.revision).toBe(2);
    expect(state.status).toBe('loading');
  });
});
