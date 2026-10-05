import { describe, test } from 'vitest';

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
  test('generate the deterministic 100-node / 500-edge payload', async ({ bench }) => {
    await bench('generate small graph', () => {
      generatePerformanceGraph(PERFORMANCE_FIXTURES.small);
    }).run();
  });

  test('generate the deterministic 1,000-node / 5,000-edge payload', async ({ bench }) => {
    await bench('generate representative graph', () => {
      generatePerformanceGraph(PERFORMANCE_FIXTURES.representative);
    }).run();
  });

  test('decode the representative replacement message', async ({ bench }) => {
    await bench('decode representative replacement', () => {
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
    }).run();
  });

  test('search and sort the representative accessible result set', async ({ bench }) => {
    await bench('search representative graph', () => {
      const state = presentationReducer(createInitialPresentationState(), {
        type: 'replaceGraph',
        graph: representative,
      });
      visibleNodes(presentationReducer(state, { type: 'setSearch', query: 'Concept 009' }));
    }).run();
  });

  test('replace and search the small payload', async ({ bench }) => {
    await bench('replace and search small graph', () => {
      const state = presentationReducer(createInitialPresentationState(), {
        type: 'replaceGraph',
        graph: small,
      });
      visibleNodes(presentationReducer(state, { type: 'setSearch', query: 'architecture' }));
    }).run();
  });
});
