import { describe, expect, it, vi } from 'vitest';

import type { BundleRuntimeSnapshot } from '../../../src/extension/runtime/index.js';
import {
  AcceptanceCompletionSignals,
  createAcceptanceCompletionSignals,
} from '../../../src/extension/runtime/acceptanceSignals.js';

function snapshot(revision: number): BundleRuntimeSnapshot<string> {
  return {
    context: {
      rootUri: 'not-exposed',
      rootUriString: 'not-exposed',
      workspaceSafetyRootUri: 'not-exposed',
    },
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
      const validation = signals.beginValidationCommand();
      const commandCompletion = signals.api.waitForValidationCompletion(validation.requestId, 100);
      const assertion = expect(completion).rejects.toThrow(
        'Timed out waiting for runtime publication after revision 3 after 100 ms.',
      );
      const commandAssertion = expect(commandCompletion).rejects.toThrow(
        `Timed out waiting for Validate request ${validation.requestId} diagnostics and runtime publication after 100 ms.`,
      );
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
      await commandAssertion;
      expect(signals.getRequestStateForTest()).toEqual({
        validation: { active: 0, terminal: 0, waiters: 0 },
        graphOpen: { active: 0, terminal: 0, waiters: 0 },
      });
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

  it('correlates Validate completion to its command request instead of an unrelated refresh', async () => {
    vi.useFakeTimers();
    try {
      const signals = new AcceptanceCompletionSignals();
      const ticket = signals.beginValidationCommand();
      expect(ticket).toEqual({
        kind: 'okf-acceptance-command',
        command: 'validateBundle',
        requestId: 1,
      });
      const completion = signals.api.waitForValidationCompletion(ticket.requestId, 2_000);

      signals.recordRuntimePublication(snapshot(1));
      await vi.advanceTimersByTimeAsync(250);
      signals.recordValidationCompletion(ticket.requestId, snapshot(2));

      await expect(completion).resolves.toEqual({
        revision: 2,
        diagnosticsPublished: true,
        findingCount: 0,
        conceptCount: 0,
        edgeCount: 0,
        requestId: ticket.requestId,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('requires an armed fresh graph revision for the Open Graph command request', async () => {
    vi.useFakeTimers();
    try {
      const signals = new AcceptanceCompletionSignals();
      signals.recordGraphRender(4);
      const ticket = signals.beginGraphOpenCommand();
      expect(ticket).toEqual({
        kind: 'okf-acceptance-command',
        command: 'openGraph',
        requestId: 1,
      });
      const completion = signals.api.waitForGraphOpenCompletion(ticket.requestId, 2_000);

      signals.recordGraphRender(4);
      signals.armGraphOpenCommand(ticket.requestId, 5);
      signals.recordGraphRender(4);
      await vi.advanceTimersByTimeAsync(250);
      signals.recordGraphRender(5);

      await expect(completion).resolves.toEqual({
        revision: 5,
        requestId: ticket.requestId,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails the exact command request on refresh or renderer failure', async () => {
    vi.useFakeTimers();
    try {
      const signals = new AcceptanceCompletionSignals();
      const validation = signals.beginValidationCommand();
      const validationCompletion = signals.api.waitForValidationCompletion(
        validation.requestId,
        60_000,
      );
      const validationAssertion = expect(validationCompletion).rejects.toThrow(
        `Validate request ${validation.requestId} failed before diagnostics and runtime publication completed.`,
      );
      signals.recordValidationFailure(validation.requestId);
      await validationAssertion;

      const graph = signals.beginGraphOpenCommand();
      signals.armGraphOpenCommand(graph.requestId, 7);
      const graphCompletion = signals.api.waitForGraphOpenCompletion(graph.requestId, 60_000);
      const graphAssertion = expect(graphCompletion).rejects.toThrow(
        'Webview graph render failed at revision 7: renderer-update-failed.',
      );
      signals.recordGraphRenderFailure(7, 'renderer-update-failed');
      await graphAssertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails an older same-kind request and consumes every terminal and waiter entry', async () => {
    const signals = new AcceptanceCompletionSignals();
    const firstValidation = signals.beginValidationCommand();
    const firstCompletion = signals.api.waitForValidationCompletion(
      firstValidation.requestId,
      60_000,
    );
    const firstAssertion = expect(firstCompletion).rejects.toThrow('Reason: superseded.');
    const secondValidation = signals.beginValidationCommand();
    await firstAssertion;
    signals.recordValidationCompletion(secondValidation.requestId, snapshot(3));
    await expect(
      signals.api.waitForValidationCompletion(secondValidation.requestId, 60_000),
    ).resolves.toMatchObject({ requestId: secondValidation.requestId, revision: 3 });

    const firstGraph = signals.beginGraphOpenCommand();
    const firstGraphCompletion = signals.api.waitForGraphOpenCompletion(
      firstGraph.requestId,
      60_000,
    );
    const graphAssertion = expect(firstGraphCompletion).rejects.toThrow('Reason: superseded.');
    const secondGraph = signals.beginGraphOpenCommand();
    await graphAssertion;
    signals.recordGraphOpenFailure(secondGraph.requestId, 'panel-closed');
    await expect(
      signals.api.waitForGraphOpenCompletion(secondGraph.requestId, 60_000),
    ).rejects.toThrow('Reason: panel-closed.');

    expect(signals.getRequestStateForTest()).toEqual({
      validation: { active: 0, terminal: 0, waiters: 0 },
      graphOpen: { active: 0, terminal: 0, waiters: 0 },
    });
  });

  it('bounds unclaimed terminal results and rejects expired request IDs immediately', async () => {
    const signals = new AcceptanceCompletionSignals();
    let firstRequestId = 0;
    let lastRequestId = 0;
    for (let index = 0; index < 20; index += 1) {
      const ticket = signals.beginValidationCommand();
      if (index === 0) firstRequestId = ticket.requestId;
      lastRequestId = ticket.requestId;
      signals.recordValidationCompletion(ticket.requestId, snapshot(index + 1));
    }

    expect(signals.getRequestStateForTest().validation).toEqual({
      active: 0,
      terminal: 16,
      waiters: 0,
    });
    await expect(signals.api.waitForValidationCompletion(firstRequestId, 100)).rejects.toThrow(
      `Unknown or expired acceptance request ${firstRequestId}.`,
    );
    await expect(
      signals.api.waitForValidationCompletion(lastRequestId, 100),
    ).resolves.toMatchObject({ requestId: lastRequestId, revision: 20 });
    expect(signals.getRequestStateForTest().validation.terminal).toBe(15);
  });

  it('rejects and clears active request and publication waiters on disposal', async () => {
    const signals = new AcceptanceCompletionSignals();
    const validation = signals.beginValidationCommand();
    const graph = signals.beginGraphOpenCommand();
    const runtimeWait = signals.api.waitForRuntimePublication(0, 60_000);
    const graphWait = signals.api.waitForGraphRender(1, 60_000);
    const validationWait = signals.api.waitForValidationCompletion(validation.requestId, 60_000);
    const graphCommandWait = signals.api.waitForGraphOpenCompletion(graph.requestId, 60_000);

    signals.dispose();

    await expect(runtimeWait).rejects.toThrow('signals were disposed');
    await expect(graphWait).rejects.toThrow('signals were disposed');
    await expect(validationWait).rejects.toThrow('signals were disposed');
    await expect(graphCommandWait).rejects.toThrow('signals were disposed');
    expect(signals.getRequestStateForTest()).toEqual({
      validation: { active: 0, terminal: 0, waiters: 0 },
      graphOpen: { active: 0, terminal: 0, waiters: 0 },
    });
    expect(signals.api.getCompletionState()).toEqual({
      runtimePublication: null,
      graphRender: null,
      graphRenderFailure: null,
    });
    expect(() => signals.beginValidationCommand()).toThrow('signals were disposed');
    expect(() => signals.beginGraphOpenCommand()).toThrow('signals were disposed');
    await expect(signals.api.waitForRuntimePublication(0, 100)).rejects.toThrow(
      'signals were disposed',
    );
    await expect(signals.api.waitForGraphRender(0, 100)).rejects.toThrow('signals were disposed');
    signals.recordRuntimePublication(snapshot(9));
    signals.recordGraphRender(9);
    expect(signals.api.getCompletionState()).toEqual({
      runtimePublication: null,
      graphRender: null,
      graphRenderFailure: null,
    });
  });

  it('discards requests whose command cannot return its acceptance ticket', async () => {
    const signals = new AcceptanceCompletionSignals();
    const validation = signals.beginValidationCommand();
    signals.discardValidationCommand(validation.requestId, 'schedule-failed');
    const graph = signals.beginGraphOpenCommand();
    signals.discardGraphOpenCommand(graph.requestId, 'schedule-failed');

    expect(signals.getRequestStateForTest()).toEqual({
      validation: { active: 0, terminal: 0, waiters: 0 },
      graphOpen: { active: 0, terminal: 0, waiters: 0 },
    });
    await expect(
      signals.api.waitForValidationCompletion(validation.requestId, 100),
    ).rejects.toThrow(`Unknown or expired acceptance request ${validation.requestId}.`);
    await expect(signals.api.waitForGraphOpenCompletion(graph.requestId, 100)).rejects.toThrow(
      `Unknown or expired acceptance request ${graph.requestId}.`,
    );
  });

  it('publishes an immutable command catalog without workspace data', () => {
    const signals = new AcceptanceCompletionSignals([
      { id: 'okfWorkbench.validateBundle', title: 'Validate Bundle', workspaceAccess: 'read' },
      { id: 'okfWorkbench.newConcept', title: 'New Concept', workspaceAccess: 'write' },
    ]);
    const catalog = signals.api.getCommandCatalog();

    expect(catalog).toEqual([
      { id: 'okfWorkbench.validateBundle', title: 'Validate Bundle', workspaceAccess: 'read' },
      { id: 'okfWorkbench.newConcept', title: 'New Concept', workspaceAccess: 'write' },
    ]);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(catalog.every((entry) => Object.isFrozen(entry))).toBe(true);
  });
});
