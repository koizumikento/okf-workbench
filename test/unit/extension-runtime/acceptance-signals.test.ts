import { describe, expect, it, vi } from 'vitest';

import type { BundleRuntimeSnapshot } from '../../../src/extension/runtime/index.js';
import {
  AcceptanceCompletionSignals,
  createAcceptanceCompletionSignals,
} from '../../../src/extension/runtime/acceptanceSignals.js';

function snapshot(revision: number): BundleRuntimeSnapshot<string> {
  return {
    context: { rootUri: 'not-exposed', rootUriString: 'not-exposed' },
    revision,
    bundle: {
      rootUri: 'not-exposed',
      revision,
      concepts: [],
      reservedDocuments: [],
      failures: [],
      findings: [],
    },
    findings: [],
    graph: {
      protocolVersion: 1,
      revision,
      nodes: [],
      edges: [],
      backlinks: {},
      brokenLinks: [],
      statistics: {
        conceptCount: 0,
        edgeCount: 0,
        orphanCount: 0,
        brokenLinkCount: 0,
        typeCounts: {},
        tagCounts: {},
      },
    },
    nodeSources: new Map(),
  };
}

describe('packaged acceptance completion signals', () => {
  it('is unavailable unless the exact driver opt-in is set', () => {
    expect(createAcceptanceCompletionSignals(undefined)).toBeUndefined();
    expect(createAcceptanceCompletionSignals('')).toBeUndefined();
    expect(createAcceptanceCompletionSignals('true')).toBeUndefined();
    expect(createAcceptanceCompletionSignals('0')).toBeUndefined();
    expect(createAcceptanceCompletionSignals('1')).toBeInstanceOf(AcceptanceCompletionSignals);
  });

  it('waits past command scheduling until diagnostics and graph completion are observed', async () => {
    vi.useFakeTimers();
    try {
      const signals = new AcceptanceCompletionSignals();
      const runtimeCompletion = signals.api.waitForRuntimePublication(0, 2_000);

      await vi.advanceTimersByTimeAsync(250);
      signals.recordRuntimePublication(snapshot(1));
      await expect(runtimeCompletion).resolves.toEqual({
        revision: 1,
        diagnosticsPublished: true,
        findingCount: 0,
        conceptCount: 0,
        edgeCount: 0,
      });

      const graphCompletion = signals.api.waitForGraphRender(1, 2_000);
      await vi.advanceTimersByTimeAsync(250);
      signals.recordGraphRender(1);
      await expect(graphCompletion).resolves.toEqual({ revision: 1 });
      expect(signals.api.getCompletionState()).toEqual({
        runtimePublication: expect.objectContaining({ revision: 1 }),
        graphRender: { revision: 1 },
        graphRenderFailure: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when the asynchronous completion signal never arrives', async () => {
    vi.useFakeTimers();
    try {
      const signals = new AcceptanceCompletionSignals();
      const completion = signals.api.waitForRuntimePublication(3, 100);
      const assertion = expect(completion).rejects.toThrow(
        'Timed out waiting for runtime publication after revision 3 after 100 ms.',
      );
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects graph readiness immediately when the Webview reports renderer construction failure', async () => {
    vi.useFakeTimers();
    try {
      const signals = new AcceptanceCompletionSignals();
      const completion = signals.api.waitForGraphRender(4, 60_000);
      const assertion = expect(completion).rejects.toThrow(
        'Webview graph render failed at revision 4: renderer-construction-failed.',
      );

      signals.recordGraphRenderFailure(4, 'renderer-construction-failed');
      await assertion;
      expect(signals.api.getCompletionState()).toEqual({
        runtimePublication: null,
        graphRender: null,
        graphRenderFailure: {
          revision: 4,
          reason: 'renderer-construction-failed',
        },
      });
      await expect(signals.api.waitForGraphRender(4, 60_000)).rejects.toThrow(
        'renderer-construction-failed',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
