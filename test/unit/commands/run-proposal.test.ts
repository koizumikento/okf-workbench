import { describe, expect, it } from 'vitest';

import type { ChangeSetProposal } from '../../../src/core/model/index.js';
import { SerialProposalWorkflowScheduler } from '../../../src/extension/commands/proposal-workflow-scheduler.js';
import {
  runProposalCommand,
  runProposalWorkflow as runProposalWorkflowUnderLease,
  type RunProposalOptions,
} from '../../../src/extension/commands/run-proposal.js';
import type {
  CommandOutcome,
  ConfirmationOptions,
  ProposalPresentation,
  ProposalPreviewSession,
  ProposalPreviewer,
  ProposalWorkflowDependencies,
} from '../../../src/extension/commands/types.js';
import {
  MAX_PROPOSAL_PREVIEW_BODY_BYTES,
  MAX_PROPOSAL_PREVIEW_CHANGES,
  MAX_PROPOSAL_PREVIEW_SUMMARY_BYTES,
} from '../../../src/extension/preview/proposal-preview-budget.js';
import { ProposalApplicator } from '../../../src/extension/workspace/proposalApplicator.js';
import { BUNDLE_READ_LIMITS } from '../../../src/extension/workspace/readSafety.js';
import { WorkspaceAccessError } from '../../../src/extension/workspace/types.js';
import { WorkspaceFolderMembershipTracker } from '../../../src/extension/workspace/workspaceFolderMembership.js';
import { FakeWorkspacePort, stringUriCodec } from '../extension-workspace/fakes.js';
import {
  captureOpenWorkspaceFolderMembership,
  FakeCommandUi,
  FakeProposalPreviewer,
} from './fakes.js';

const root = 'memfs://workspace/knowledge';

function proposal(paths: readonly string[], proposalRoot = root): ChangeSetProposal {
  return {
    operation: 'test',
    workspaceSafetyRootUri: proposalRoot,
    writeRootUri: proposalRoot,
    changes: paths.map((relativePath) => ({
      targetUri: `${proposalRoot}/${relativePath}`,
      relativePath,
      operation: 'create',
      expected: { kind: 'absent' },
      encoding: 'utf8',
      proposedText: `${relativePath}\n`,
    })),
  };
}

function harness(port = new FakeWorkspacePort()) {
  port.putDirectory(root);
  const ui = new FakeCommandUi();
  const previewer = new FakeProposalPreviewer();
  return {
    port,
    ui,
    previewer,
    dependencies: {
      port,
      uris: stringUriCodec,
      applicator: new ProposalApplicator(port, stringUriCodec),
      ui,
      previewer,
      workflowScheduler: new SerialProposalWorkflowScheduler(),
      isWorkspaceTrusted: () => true,
      captureWorkspaceFolderMembership: captureOpenWorkspaceFolderMembership,
    },
  };
}

const presentation = { title: 'Test proposal', summary: ['Complete review'] };

function runProposalWorkflow(
  dependencies: ProposalWorkflowDependencies<string>,
  proposed: ChangeSetProposal,
  proposedPresentation: ProposalPresentation,
  options: RunProposalOptions = {},
): Promise<CommandOutcome> {
  return runProposalCommand(dependencies, (lease) =>
    runProposalWorkflowUnderLease(dependencies, lease, proposed, proposedPresentation, options),
  );
}

class PreflightTrackingPort extends FakeWorkspacePort {
  statCalls = 0;

  override async stat(uri: string) {
    this.statCalls += 1;
    return super.stat(uri);
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('proposal command workflow', () => {
  it('writes nothing and releases the preview when modeless approval is cancelled', async () => {
    const { port, ui, previewer, dependencies } = harness();
    ui.confirmations.push(false);

    const result = await runProposalWorkflow(
      dependencies,
      proposal(['first.md', 'second.md']),
      presentation,
    );

    expect(result).toEqual({ kind: 'cancelled' });
    expect(previewer.shown).toHaveLength(1);
    expect(previewer.releasedSessions).toBe(1);
    expect(ui.confirmationRequests[0]?.detail).toContain('2 proposed files');
    expect(ui.confirmationRequests[0]?.detail).toContain('complete path list');
    expect(ui.confirmationRequests[0]?.previewIdentity).toEqual(previewer.shown[0]?.identity);
    expect(ui.confirmationRequests[0]?.modeless).toBe(true);
    expect(port.writes).toEqual([]);
  });

  it('releases the preview after an approved proposal is applied', async () => {
    const { port, ui, previewer, dependencies } = harness();
    ui.confirmations.push(true);

    const result = await runProposalWorkflow(dependencies, proposal(['first.md']), presentation);

    expect(result).toMatchObject({ kind: 'applied' });
    expect(port.text(`${root}/first.md`)).toBe('first.md\n');
    expect(previewer.releasedSessions).toBe(1);
  });

  it('refuses an over-count preview before applicator preflight or workspace I/O', async () => {
    const port = new PreflightTrackingPort();
    const { ui, previewer, dependencies } = harness(port);
    const paths = Array.from(
      { length: MAX_PROPOSAL_PREVIEW_CHANGES + 1 },
      (_, index) => `concept-${String(index)}.md`,
    );

    const result = await runProposalWorkflow(dependencies, proposal(paths), presentation);

    expect(result).toMatchObject({
      kind: 'refused',
      problems: [{ code: 'preview-limit' }],
    });
    expect(port.statCalls).toBe(0);
    expect(port.reads).toEqual([]);
    expect(port.writes).toEqual([]);
    expect(previewer.shown).toEqual([]);
    expect(ui.confirmationRequests).toEqual([]);
  });

  it('refuses oversized proposed text before applicator preflight or workspace I/O', async () => {
    const port = new PreflightTrackingPort();
    const { ui, previewer, dependencies } = harness(port);
    const baseProposal = proposal(['oversized.md']);
    const oversizedProposal: ChangeSetProposal = {
      ...baseProposal,
      changes: baseProposal.changes.map((change) => ({
        ...change,
        proposedText: 'a'.repeat(BUNDLE_READ_LIMITS.maxDocumentBytes + 1),
      })),
    };

    const result = await runProposalWorkflow(dependencies, oversizedProposal, presentation);

    expect(result).toMatchObject({
      kind: 'refused',
      problems: [{ code: 'preview-limit' }],
    });
    expect(port.statCalls).toBe(0);
    expect(port.reads).toEqual([]);
    expect(previewer.shown).toEqual([]);
    expect(ui.confirmationRequests).toEqual([]);
  });

  it('accepts proposed text at the exact per-file byte limit', async () => {
    const port = new PreflightTrackingPort();
    const { ui, previewer, dependencies } = harness(port);
    const baseProposal = proposal(['bounded.md']);
    const boundedProposal: ChangeSetProposal = {
      ...baseProposal,
      changes: baseProposal.changes.map((change) => ({
        ...change,
        proposedText: 'a'.repeat(BUNDLE_READ_LIMITS.maxDocumentBytes),
      })),
    };
    ui.confirmations.push(false);

    const result = await runProposalWorkflow(dependencies, boundedProposal, presentation);

    expect(result).toEqual({ kind: 'cancelled' });
    expect(port.statCalls).toBeGreaterThan(0);
    expect(previewer.shown).toHaveLength(1);
    expect(ui.confirmationRequests).toHaveLength(1);
  });

  it('refuses declared existing content above the per-file limit before workspace I/O', async () => {
    const port = new PreflightTrackingPort();
    const { ui, previewer, dependencies } = harness(port);
    const baseProposal = proposal(['existing.md']);
    const oversizedProposal: ChangeSetProposal = {
      ...baseProposal,
      changes: baseProposal.changes.map((change) => ({
        ...change,
        operation: 'update' as const,
        expected: {
          kind: 'sha256' as const,
          value: 'known-before-hash',
          byteLength: BUNDLE_READ_LIMITS.maxDocumentBytes + 1,
        },
        proposedText: '',
      })),
    };

    const result = await runProposalWorkflow(dependencies, oversizedProposal, presentation);

    expect(result).toMatchObject({
      kind: 'refused',
      problems: [{ code: 'preview-limit' }],
    });
    expect(port.statCalls).toBe(0);
    expect(port.reads).toEqual([]);
    expect(previewer.shown).toEqual([]);
    expect(ui.confirmationRequests).toEqual([]);
  });

  it('accepts a declared existing content length at the exact per-file limit', async () => {
    const port = new PreflightTrackingPort();
    const { previewer, dependencies } = harness(port);
    const baseProposal = proposal(['existing.md']);
    const boundedProposal: ChangeSetProposal = {
      ...baseProposal,
      changes: baseProposal.changes.map((change) => ({
        ...change,
        operation: 'update' as const,
        expected: {
          kind: 'sha256' as const,
          value: 'known-before-hash',
          byteLength: BUNDLE_READ_LIMITS.maxDocumentBytes,
        },
        proposedText: '',
      })),
    };

    const result = await runProposalWorkflow(dependencies, boundedProposal, presentation);

    expect(result.kind).toBe('failed');
    expect(port.statCalls).toBeGreaterThan(0);
    expect(previewer.shown).toEqual([]);
  });

  it('refuses aggregate declared existing bytes above the complete-preview budget before I/O', async () => {
    const port = new PreflightTrackingPort();
    const { ui, previewer, dependencies } = harness(port);
    const fileCount = MAX_PROPOSAL_PREVIEW_BODY_BYTES / BUNDLE_READ_LIMITS.maxDocumentBytes + 1;
    const baseProposal = proposal(
      Array.from({ length: fileCount }, (_, index) => `existing-${String(index)}.md`),
    );
    const oversizedProposal: ChangeSetProposal = {
      ...baseProposal,
      changes: baseProposal.changes.map((change) => ({
        ...change,
        operation: 'update' as const,
        expected: {
          kind: 'sha256' as const,
          value: 'known-before-hash',
          byteLength: BUNDLE_READ_LIMITS.maxDocumentBytes,
        },
        proposedText: '',
      })),
    };

    const result = await runProposalWorkflow(dependencies, oversizedProposal, presentation);

    expect(result).toMatchObject({
      kind: 'refused',
      problems: [{ code: 'preview-limit' }],
    });
    expect(port.statCalls).toBe(0);
    expect(port.reads).toEqual([]);
    expect(previewer.shown).toEqual([]);
    expect(ui.confirmationRequests).toEqual([]);
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN])(
    'refuses invalid declared existing byte length %s before workspace I/O',
    async (byteLength) => {
      const port = new PreflightTrackingPort();
      const { ui, previewer, dependencies } = harness(port);
      const baseProposal = proposal(['invalid-existing.md']);
      const invalidProposal: ChangeSetProposal = {
        ...baseProposal,
        changes: baseProposal.changes.map((change) => ({
          ...change,
          operation: 'update' as const,
          expected: {
            kind: 'sha256' as const,
            value: 'known-before-hash',
            byteLength,
          },
          proposedText: '',
        })),
      };

      const result = await runProposalWorkflow(dependencies, invalidProposal, presentation);

      expect(result).toMatchObject({
        kind: 'refused',
        problems: [{ code: 'preview-limit' }],
      });
      expect(port.statCalls).toBe(0);
      expect(port.reads).toEqual([]);
      expect(previewer.shown).toEqual([]);
      expect(ui.confirmationRequests).toEqual([]);
    },
  );

  it('refuses an oversized summary before applicator preflight or workspace I/O', async () => {
    const port = new PreflightTrackingPort();
    const { ui, previewer, dependencies } = harness(port);

    const result = await runProposalWorkflow(dependencies, proposal(['summary.md']), {
      title: 'Oversized summary',
      summary: ['s'.repeat(MAX_PROPOSAL_PREVIEW_SUMMARY_BYTES + 1)],
    });

    expect(result).toMatchObject({
      kind: 'refused',
      problems: [{ code: 'preview-limit' }],
    });
    expect(port.statCalls).toBe(0);
    expect(port.reads).toEqual([]);
    expect(previewer.shown).toEqual([]);
    expect(ui.confirmationRequests).toEqual([]);
  });

  it('preflights every path and never opens approval when one create collides', async () => {
    const { port, ui, previewer, dependencies } = harness();
    port.putText(`${root}/first.md`, 'existing\n');

    const result = await runProposalWorkflow(
      dependencies,
      proposal(['first.md', 'second.md']),
      presentation,
    );

    expect(result.kind).toBe('failed');
    expect(previewer.shown).toEqual([]);
    expect(ui.confirmationRequests).toEqual([]);
    expect(port.writes).toEqual([]);
    expect(port.text(`${root}/first.md`)).toBe('existing\n');
  });

  it('does not request approval when a preview is disposed as show resolves', async () => {
    const { port, ui, previewer, dependencies } = harness();
    const stalePreviewer: ProposalPreviewer<string> = {
      async show(proposed, proposedPresentation) {
        const session = await previewer.show(proposed, proposedPresentation);
        await session.dispose();
        return session;
      },
    };

    const result = await runProposalWorkflow(
      { ...dependencies, previewer: stalePreviewer },
      proposal(['first.md']),
      presentation,
    );

    expect(result).toMatchObject({
      kind: 'refused',
      problems: [{ code: 'preview-unavailable' }],
    });
    expect(ui.confirmationRequests).toEqual([]);
    expect(previewer.releasedSessions).toBe(1);
    expect(port.writes).toEqual([]);
  });

  it('does not yield between the active preview check and opening its confirmation', async () => {
    const { port, dependencies } = harness();
    let released = false;
    let releaseScheduled = false;
    let confirmationSawActivePreview = false;
    class ActiveCheckCommandUi extends FakeCommandUi {
      override async confirm(options: ConfirmationOptions): Promise<boolean> {
        this.confirmationRequests.push(options);
        confirmationSawActivePreview = !released;
        return false;
      }
    }
    const ui = new ActiveCheckCommandUi();
    const racePreviewer: ProposalPreviewer<string> = {
      async show(proposed) {
        const identity = {
          id: 'microtask-preview-race',
          label: 'Microtask preview race',
          targetUri: proposed.writeRootUri,
        };
        return {
          identity,
          assertActive() {
            if (released) {
              throw new Error('The preview closed before confirmation.');
            }
            if (!releaseScheduled) {
              releaseScheduled = true;
              queueMicrotask(() => {
                released = true;
              });
            }
          },
          async dispose() {
            released = true;
          },
        };
      },
    };

    const result = await runProposalWorkflow(
      { ...dependencies, ui, previewer: racePreviewer },
      proposal(['first.md']),
      presentation,
    );

    expect(confirmationSawActivePreview).toBe(true);
    expect(ui.confirmationRequests).toHaveLength(1);
    expect(result).toMatchObject({
      kind: 'refused',
      problems: [{ code: 'preview-unavailable' }],
    });
    expect(port.writes).toEqual([]);
  });

  it('fails concurrent decisions immediately and releases the gate after cancellation and error', async () => {
    const roots = [
      'memfs://workspace/knowledge-a',
      'memfs://workspace/knowledge-b',
      'memfs://workspace/knowledge-c',
    ] as const;
    const approvals = [deferred<boolean>(), deferred<boolean>(), deferred<boolean>()] as const;
    const started = [deferred<undefined>(), deferred<undefined>(), deferred<undefined>()] as const;
    class DeferredCommandUi extends FakeCommandUi {
      #confirmation = 0;
      readonly #unresolvedWarning = deferred<undefined>().promise;

      override async confirm(options: ConfirmationOptions): Promise<boolean> {
        const index = this.#confirmation;
        this.#confirmation += 1;
        this.confirmationRequests.push(options);
        started[index]?.resolve(undefined);
        const approval = approvals[index];
        if (approval === undefined) {
          throw new Error('Unexpected confirmation.');
        }
        return approval.promise;
      }

      override showWarning(message: string): Promise<void> {
        this.warnings.push(message);
        return this.#unresolvedWarning;
      }
    }

    const port = new PreflightTrackingPort();
    for (const proposalRoot of roots) {
      port.putDirectory(proposalRoot);
    }
    const ui = new DeferredCommandUi();
    const previewer = new FakeProposalPreviewer();
    const dependencies = {
      port,
      uris: stringUriCodec,
      applicator: new ProposalApplicator(port, stringUriCodec),
      ui,
      previewer,
      workflowScheduler: new SerialProposalWorkflowScheduler(),
      isWorkspaceTrusted: () => true,
      captureWorkspaceFolderMembership: captureOpenWorkspaceFolderMembership,
    };

    const first = runProposalWorkflow(dependencies, proposal(['first.md'], roots[0]), presentation);
    await started[0].promise;
    const statCallsWhileActive = port.statCalls;
    const concurrent = Array.from({ length: 100 }, (_, index) =>
      runProposalWorkflow(
        dependencies,
        proposal([`busy-${String(index)}.md`], roots[index % roots.length] as string),
        presentation,
      ),
    );
    const concurrentResults = await Promise.all(concurrent);

    expect(
      concurrentResults.every(
        (result) =>
          result.kind === 'refused' &&
          result.problems.some((problem) => problem.code === 'proposal-workflow-busy'),
      ),
    ).toBe(true);
    expect(port.statCalls).toBe(statCallsWhileActive);
    expect(ui.confirmationRequests).toHaveLength(1);
    expect(previewer.shown.map((shown) => shown.proposal.writeRootUri)).toEqual([roots[0]]);
    expect(ui.warnings).toHaveLength(1);

    approvals[0].resolve(false);
    await expect(first).resolves.toEqual({ kind: 'cancelled' });
    const second = runProposalWorkflow(
      dependencies,
      proposal(['second.md'], roots[1]),
      presentation,
    );
    await started[1].promise;
    expect(ui.confirmationRequests).toHaveLength(2);
    expect(ui.confirmationRequests[1]?.previewIdentity.targetUri).toBe(roots[1]);
    await expect(
      runProposalWorkflow(dependencies, proposal(['busy-second-phase.md'], roots[2]), presentation),
    ).resolves.toMatchObject({
      kind: 'refused',
      problems: [{ code: 'proposal-workflow-busy' }],
    });
    expect(ui.warnings).toHaveLength(2);

    approvals[1].reject(new Error('Confirmation host failed.'));
    await expect(second).rejects.toThrow('Confirmation host failed.');
    const third = runProposalWorkflow(dependencies, proposal(['third.md'], roots[2]), presentation);
    await started[2].promise;
    expect(ui.confirmationRequests).toHaveLength(3);
    expect(ui.confirmationRequests[2]?.previewIdentity.targetUri).toBe(roots[2]);
    await expect(
      runProposalWorkflow(dependencies, proposal(['busy-third-phase.md'], roots[0]), presentation),
    ).resolves.toMatchObject({
      kind: 'refused',
      problems: [{ code: 'proposal-workflow-busy' }],
    });
    expect(ui.warnings).toHaveLength(3);

    approvals[2].resolve(false);
    await expect(third).resolves.toEqual({ kind: 'cancelled' });
    expect(previewer.releasedSessions).toBe(3);
    expect(port.writes).toEqual([]);
  });

  it('settles a busy refusal when the coalesced warning rejects', async () => {
    const { ui, dependencies } = harness();
    const activeStarted = deferred<undefined>();
    const releaseActive = deferred<undefined>();
    let rejectedCallbackRan = false;
    ui.showWarning = async (message: string) => {
      ui.warnings.push(message);
      throw new Error('Notification host failed.');
    };

    const active = runProposalCommand(dependencies, async () => {
      activeStarted.resolve(undefined);
      await releaseActive.promise;
      return { kind: 'cancelled' };
    });
    await activeStarted.promise;

    await expect(
      runProposalCommand(dependencies, async () => {
        rejectedCallbackRan = true;
        return { kind: 'cancelled' };
      }),
    ).resolves.toMatchObject({
      kind: 'refused',
      problems: [{ code: 'proposal-workflow-busy' }],
    });
    expect(rejectedCallbackRan).toBe(false);
    expect(ui.warnings).toHaveLength(1);

    releaseActive.resolve(undefined);
    await expect(active).resolves.toEqual({ kind: 'cancelled' });
  });

  it('reports completed, failed, and untouched targets after a partial provider failure', async () => {
    const port = new FakeWorkspacePort();
    port.failWrites.set(
      `${root}/second.md`,
      new WorkspaceAccessError('permission', 'Second is read-only.'),
    );
    const { ui, previewer, dependencies } = harness(port);
    ui.confirmations.push(true);

    const result = await runProposalWorkflow(
      dependencies,
      proposal(['first.md', 'second.md', 'third.md']),
      presentation,
    );

    expect(result).toMatchObject({
      kind: 'failed',
      report: {
        completed: [`${root}/first.md`],
        failed: [expect.objectContaining({ targetUri: `${root}/second.md` })],
        untouched: [`${root}/third.md`],
      },
    });
    expect(ui.errors.at(-1)).toContain('Completed:');
    expect(ui.errors.at(-1)).toContain('Untouched:');
    expect(previewer.releasedSessions).toBe(1);
    expect(port.text(`${root}/third.md`)).toBeUndefined();
  });

  it('refuses every write operation in an untrusted workspace', async () => {
    const { port, ui, dependencies } = harness();
    const result = await runProposalWorkflow(
      { ...dependencies, isWorkspaceTrusted: () => false },
      proposal(['first.md']),
      presentation,
    );

    expect(result.kind).toBe('refused');
    expect(ui.errors[0]).toContain('untrusted');
    expect(port.writes).toEqual([]);
  });

  it('rechecks workspace trust after preview and before applying', async () => {
    const { port, ui, previewer, dependencies } = harness();
    ui.confirmations.push(true);
    let trustChecks = 0;

    const result = await runProposalWorkflow(
      {
        ...dependencies,
        isWorkspaceTrusted: () => {
          trustChecks += 1;
          return trustChecks === 1;
        },
      },
      proposal(['first.md']),
      presentation,
    );

    expect(result.kind).toBe('refused');
    expect(trustChecks).toBe(2);
    expect(previewer.releasedSessions).toBe(1);
    expect(port.writes).toEqual([]);
  });

  it('runs the final compatibility guard after approval and content preflight', async () => {
    const { port, ui, previewer, dependencies } = harness();
    ui.confirmations.push(true);
    let compatibilityChecks = 0;

    const result = await runProposalWorkflow(dependencies, proposal(['first.md']), presentation, {
      beforeApply: async () => {
        compatibilityChecks += 1;
        return {
          code: 'unsupported-okf-version-write',
          message: 'The bundle changed to unsupported OKF version "1.0".',
          correctiveAction: 'Validate the bundle and migrate it before writing.',
        };
      },
    });

    expect(result).toMatchObject({
      kind: 'refused',
      problems: [{ code: 'unsupported-okf-version-write' }],
    });
    expect(compatibilityChecks).toBe(1);
    expect(ui.confirmationRequests).toHaveLength(1);
    expect(ui.errors.at(-1)).toContain('bundle compatibility changed');
    expect(previewer.releasedSessions).toBe(1);
    expect(port.writes).toEqual([]);
  });

  it('runs the compatibility guard after the applicator final preflight', async () => {
    const target = `${root}/first.md`;
    class FinalPreflightTrackingPort extends FakeWorkspacePort {
      targetStatCount = 0;

      override async stat(uri: string) {
        const result = await super.stat(uri);
        if (uri === target) {
          this.targetStatCount += 1;
        }
        return result;
      }
    }

    const port = new FinalPreflightTrackingPort();
    const { ui, dependencies } = harness(port);
    ui.confirmations.push(true);

    const result = await runProposalWorkflow(dependencies, proposal(['first.md']), presentation, {
      beforeApply: async () =>
        port.targetStatCount >= 3
          ? {
              code: 'unsupported-okf-version-write',
              message: 'The bundle changed during the applicator final preflight.',
            }
          : undefined,
    });

    expect(port.targetStatCount).toBe(3);
    expect(result).toMatchObject({
      kind: 'refused',
      problems: [{ code: 'unsupported-okf-version-write' }],
    });
    expect(port.writes).toEqual([]);
  });

  it('refuses every write when the preview closes while the compatibility guard is pending', async () => {
    const { port, ui, previewer, dependencies } = harness();
    ui.confirmations.push(true);
    const guardStarted = deferred<undefined>();
    const releaseGuard = deferred<undefined>();
    let capturedSession: ProposalPreviewSession | undefined;
    const capturingPreviewer: ProposalPreviewer<string> = {
      async show(proposed, proposedPresentation) {
        capturedSession = await previewer.show(proposed, proposedPresentation);
        return capturedSession;
      },
    };

    const workflow = runProposalWorkflow(
      { ...dependencies, previewer: capturingPreviewer },
      proposal(['first.md', 'second.md']),
      presentation,
      {
        beforeApply: async () => {
          guardStarted.resolve(undefined);
          await releaseGuard.promise;
          return undefined;
        },
      },
    );

    await guardStarted.promise;
    if (capturedSession === undefined) {
      throw new Error('Expected the proposal preview session to be captured.');
    }
    await capturedSession.dispose();
    releaseGuard.resolve(undefined);

    await expect(workflow).resolves.toMatchObject({
      kind: 'refused',
      problems: [{ code: 'preview-unavailable' }],
    });
    expect(ui.errors.at(-1)).toContain('approved preview closed');
    expect(previewer.releasedSessions).toBe(1);
    expect(port.writes).toEqual([]);
  });

  it('checks preview liveness immediately before every proposed write', async () => {
    const { port, ui, previewer, dependencies } = harness();
    ui.confirmations.push(true);
    let capturedSession: ProposalPreviewSession | undefined;
    const capturingPreviewer: ProposalPreviewer<string> = {
      async show(proposed, proposedPresentation) {
        capturedSession = await previewer.show(proposed, proposedPresentation);
        return capturedSession;
      },
    };
    port.beforeWrite = (uri) => {
      if (uri === `${root}/first.md`) {
        void capturedSession?.dispose();
      }
    };

    const result = await runProposalWorkflow(
      { ...dependencies, previewer: capturingPreviewer },
      proposal(['first.md', 'second.md', 'third.md']),
      presentation,
    );

    expect(result).toMatchObject({
      kind: 'failed',
      report: {
        completed: [],
        failed: [
          {
            targetUri: `${root}/first.md`,
            code: 'preview-unavailable',
          },
        ],
        untouched: [`${root}/second.md`, `${root}/third.md`],
      },
    });
    expect(port.writes).toEqual([]);
    expect(port.text(`${root}/first.md`)).toBeUndefined();
    expect(port.text(`${root}/second.md`)).toBeUndefined();
    expect(previewer.releasedSessions).toBe(1);
  });

  it('rechecks ancestor safety when the compatibility guard yields', async () => {
    const port = new FakeWorkspacePort();
    port.putDirectory(root);
    port.putDirectory(`${root}/concepts`);
    const { ui, dependencies } = harness(port);
    ui.confirmations.push(true);

    const result = await runProposalWorkflow(
      dependencies,
      proposal(['concepts/first.md']),
      presentation,
      {
        beforeApply: async () => {
          port.putSymbolicLink(`${root}/concepts`);
          return undefined;
        },
      },
    );

    expect(result).toMatchObject({
      kind: 'failed',
      report: {
        completed: [],
        failed: [{ code: 'unsafe-path', targetUri: `${root}/concepts/first.md` }],
      },
    });
    expect(port.writes).toEqual([]);
    expect(port.text(`${root}/concepts/first.md`)).toBeUndefined();
  });

  it('invalidates a modeless proposal when its exact workspace folder is removed', async () => {
    const { port, previewer, dependencies } = harness();
    const approval = deferred<boolean>();
    const confirmationStarted = deferred<undefined>();
    class DeferredApprovalUi extends FakeCommandUi {
      #firstConfirmation = true;

      override async confirm(options: ConfirmationOptions): Promise<boolean> {
        if (!this.#firstConfirmation) {
          return super.confirm(options);
        }
        this.#firstConfirmation = false;
        this.confirmationRequests.push(options);
        confirmationStarted.resolve(undefined);
        return approval.promise;
      }
    }
    const ui = new DeferredApprovalUi();
    let openFolders: readonly string[] = [root, 'memfs://workspace/other'];
    const tracker = new WorkspaceFolderMembershipTracker(stringUriCodec, () => openFolders);
    const guardedDependencies = {
      ...dependencies,
      ui,
      captureWorkspaceFolderMembership: (workspaceRoot: string) => tracker.capture(workspaceRoot),
    };

    const active = runProposalWorkflow(
      guardedDependencies,
      proposal(['first.md', 'second.md']),
      presentation,
    );
    await confirmationStarted.promise;

    // A containing parent is not the exact safety root, and re-adding the exact URI cannot revive
    // the proposal that was previewed before removal.
    openFolders = ['memfs://workspace', 'memfs://workspace/other'];
    tracker.handleWorkspaceFoldersChanged({ removed: [root] });
    openFolders = [root, 'memfs://workspace/other'];
    tracker.handleWorkspaceFoldersChanged({ removed: [] });
    expect(previewer.releasedSessions).toBe(1);

    approval.resolve(true);
    await expect(active).resolves.toMatchObject({
      kind: 'refused',
      problems: [{ code: 'workspace-folder-unavailable', uri: root }],
    });
    expect(port.writes).toEqual([]);
    expect(ui.errors.at(-1)).toContain('workspace folder changed');

    // The scheduler lease and old session are released; a newly reviewed workflow may proceed.
    ui.confirmations.push(false);
    await expect(
      runProposalWorkflow(guardedDependencies, proposal(['fresh.md']), presentation),
    ).resolves.toEqual({ kind: 'cancelled' });
  });

  it('fails closed inside the provider when membership changes after the applicator guard', async () => {
    const { port, ui, previewer, dependencies } = harness();
    ui.confirmations.push(true);
    let openFolders: readonly string[] = [root];
    const tracker = new WorkspaceFolderMembershipTracker(stringUriCodec, () => openFolders);
    port.beforeWrite = () => {
      openFolders = [];
      tracker.handleWorkspaceFoldersChanged({ removed: [root] });
    };

    const result = await runProposalWorkflow(
      {
        ...dependencies,
        captureWorkspaceFolderMembership: (workspaceRoot: string) => tracker.capture(workspaceRoot),
      },
      proposal(['first.md', 'second.md']),
      presentation,
    );

    expect(result).toMatchObject({
      kind: 'failed',
      report: {
        completed: [],
        failed: [
          {
            targetUri: `${root}/first.md`,
            code: 'workspace-folder-unavailable',
          },
        ],
        untouched: [`${root}/second.md`],
      },
    });
    expect(port.writes).toEqual([]);
    expect(previewer.releasedSessions).toBe(1);
  });

  it('stops every subsequent write when membership changes after one completed write', async () => {
    let openFolders: readonly string[] = [root];
    const tracker = new WorkspaceFolderMembershipTracker(stringUriCodec, () => openFolders);
    class RemovalAfterWritePort extends FakeWorkspacePort {
      override async write(
        uri: string,
        content: Uint8Array,
        options: Parameters<FakeWorkspacePort['write']>[2],
      ): Promise<void> {
        await super.write(uri, content, options);
        if (this.writes.length === 1) {
          openFolders = [];
          tracker.handleWorkspaceFoldersChanged({ removed: [root] });
        }
      }
    }
    const port = new RemovalAfterWritePort();
    const { ui, dependencies } = harness(port);
    ui.confirmations.push(true);

    const result = await runProposalWorkflow(
      {
        ...dependencies,
        captureWorkspaceFolderMembership: (workspaceRoot: string) => tracker.capture(workspaceRoot),
      },
      proposal(['first.md', 'second.md', 'third.md']),
      presentation,
    );

    expect(result).toMatchObject({
      kind: 'failed',
      report: {
        completed: [`${root}/first.md`],
        failed: [
          {
            targetUri: `${root}/second.md`,
            code: 'workspace-folder-unavailable',
          },
        ],
        untouched: [`${root}/third.md`],
      },
    });
    expect(port.writes).toEqual([`${root}/first.md`]);
    expect(port.text(`${root}/second.md`)).toBeUndefined();
    expect(port.text(`${root}/third.md`)).toBeUndefined();
  });
});
