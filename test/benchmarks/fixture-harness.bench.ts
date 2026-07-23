import { bench, describe } from 'vitest';

import { decodeExtensionToWebviewMessage } from '../../src/shared/protocol/index.js';
import {
  createInitialPresentationState,
  presentationReducer,
  visibleNodes,
} from '../../src/webview/state/index.js';
import { generatePerformanceGraph, PERFORMANCE_FIXTURES } from './graph-fixtures.js';

const small = generatePerformanceGraph(PERFORMANCE_FIXTURES.small);
const representative = generatePerformanceGraph(PERFORMANCE_FIXTURES.representative);

describe('performance harness overhead (not headed-editor QR evidence)', () => {
  bench('generate the deterministic 100-node / 500-edge payload', () => {
    generatePerformanceGraph(PERFORMANCE_FIXTURES.small);
  });

  bench('generate the deterministic 1,000-node / 5,000-edge payload', () => {
    generatePerformanceGraph(PERFORMANCE_FIXTURES.representative);
  });

  bench('decode the representative replacement message', () => {
    decodeExtensionToWebviewMessage(
      {
        protocolVersion: 1,
        type: 'replaceGraph',
        revision: representative.revision,
        deliveryId: 1,
        payload: representative,
      },
      0,
    );
  });

  bench('search and sort the representative accessible result set', () => {
    const state = presentationReducer(createInitialPresentationState(), {
      type: 'replaceGraph',
      graph: representative,
    });
    visibleNodes(presentationReducer(state, { type: 'setSearch', query: 'Concept 009' }));
  });

  bench('replace and search the small payload', () => {
    const state = presentationReducer(createInitialPresentationState(), {
      type: 'replaceGraph',
      graph: small,
    });
    visibleNodes(presentationReducer(state, { type: 'setSearch', query: 'architecture' }));
  });
});
