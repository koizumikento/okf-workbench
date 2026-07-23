import { describe, expect, it } from 'vitest';

import { SerialProposalWorkflowScheduler } from '../../../src/extension/commands/proposal-workflow-scheduler.js';
import {
  runProposalCommand,
  runPublicProposalCommand,
} from '../../../src/extension/commands/run-proposal.js';
import type {
  CommandOutcome,
  ProposalWorkflowDependencies,
  ProposalWorkflowLease,
} from '../../../src/extension/commands/types.js';
import { ProposalApplicator } from '../../../src/extension/workspace/proposalApplicator.js';
import { FakeWorkspacePort, stringUriCodec } from '../extension-workspace/fakes.js';
import {
  captureOpenWorkspaceFolderMembership,
  FakeCommandUi,
  FakeProposalPreviewer,
} from '../commands/fakes.js';

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function harness() {
  const port = new FakeWorkspacePort();
  const ui = new FakeCommandUi();
  let trusted = false;
  const dependencies: ProposalWorkflowDependencies<string> = {
    port,
    uris: stringUriCodec,
    applicator: new ProposalApplicator(port, stringUriCodec),
    ui,
    previewer: new FakeProposalPreviewer(),
    workflowScheduler: new SerialProposalWorkflowScheduler(),
    isWorkspaceTrusted: () => trusted,
    captureWorkspaceFolderMembership: captureOpenWorkspaceFolderMembership,
  };
  return {
    dependencies,
    ui,
    trustWorkspace(): void {
      trusted = true;
    },
  };
}

function continueFactoryUnderLease(
  dependencies: ProposalWorkflowDependencies<string>,
  lease: ProposalWorkflowLease,
  callback: () => Promise<CommandOutcome>,
): Promise<CommandOutcome> {
  return runProposalCommand(
    dependencies,
    async (continuedLease) => {
      expect(continuedLease).toBe(lease);
      return callback();
    },
    lease,
  );
}

describe('registered write-command admission', () => {
  it('admits one of 100 untrusted invocations before trust UI and refuses the rest without queues', async () => {
    const { dependencies, ui, trustWorkspace } = harness();
    const notificationStarted = deferred<undefined>();
    const releaseNotification = deferred<undefined>();
    let untrustedNotifications = 0;
    let commandCallbacks = 0;

    const invocations = Array.from({ length: 100 }, () =>
      runPublicProposalCommand(
        dependencies,
        async () => {
          commandCallbacks += 1;
          return { kind: 'cancelled' };
        },
        async () => {
          untrustedNotifications += 1;
          notificationStarted.resolve(undefined);
          await releaseNotification.promise;
        },
      ),
    );
    await notificationStarted.promise;

    const busyResults = await Promise.all(invocations.slice(1));
    expect(
      busyResults.every(
        (result) =>
          result.kind === 'refused' &&
          result.problems.some((problem) => problem.code === 'proposal-workflow-busy'),
      ),
    ).toBe(true);
    expect(commandCallbacks).toBe(0);
    expect(untrustedNotifications).toBe(1);
    expect(ui.warnings).toHaveLength(1);
    expect(ui.errors).toHaveLength(0);

    releaseNotification.resolve(undefined);
    await expect(invocations[0]).resolves.toMatchObject({
      kind: 'refused',
      problems: [{ code: 'workspace-untrusted' }],
    });

    trustWorkspace();
    await expect(
      runPublicProposalCommand(
        dependencies,
        (lease) =>
          continueFactoryUnderLease(dependencies, lease, async () => {
            commandCallbacks += 1;
            return { kind: 'cancelled' };
          }),
        async () => {
          untrustedNotifications += 1;
        },
      ),
    ).resolves.toEqual({ kind: 'cancelled' });
    expect(commandCallbacks).toBe(1);
    expect(untrustedNotifications).toBe(1);
  });

  it('releases public admission after synchronous and asynchronous factory failures', async () => {
    const { dependencies, trustWorkspace } = harness();
    trustWorkspace();
    const reportUntrusted = async (): Promise<void> => {
      throw new Error('Trusted commands must not report an untrusted workspace.');
    };

    await expect(
      runPublicProposalCommand(
        dependencies,
        (lease) =>
          continueFactoryUnderLease(dependencies, lease, () => {
            throw new Error('Synchronous factory failure.');
          }),
        reportUntrusted,
      ),
    ).rejects.toThrow('Synchronous factory failure.');
    await expect(
      runPublicProposalCommand(
        dependencies,
        (lease) =>
          continueFactoryUnderLease(dependencies, lease, async () => {
            await Promise.resolve();
            throw new Error('Asynchronous factory failure.');
          }),
        reportUntrusted,
      ),
    ).rejects.toThrow('Asynchronous factory failure.');
    await expect(
      runPublicProposalCommand(
        dependencies,
        (lease) =>
          continueFactoryUnderLease(dependencies, lease, async () => ({ kind: 'cancelled' })),
        reportUntrusted,
      ),
    ).resolves.toEqual({ kind: 'cancelled' });
  });

  it('contains synchronous and asynchronous trust-notification failures and releases admission', async () => {
    const { dependencies } = harness();
    let commandCallbacks = 0;
    const command = async (): Promise<CommandOutcome> => {
      commandCallbacks += 1;
      return { kind: 'cancelled' };
    };

    await expect(
      runPublicProposalCommand(dependencies, command, () => {
        throw new Error('Synchronous notification failure.');
      }),
    ).resolves.toMatchObject({
      kind: 'refused',
      problems: [{ code: 'workspace-untrusted' }],
    });
    await expect(
      runPublicProposalCommand(dependencies, command, async () => {
        await Promise.resolve();
        throw new Error('Asynchronous notification failure.');
      }),
    ).resolves.toMatchObject({
      kind: 'refused',
      problems: [{ code: 'workspace-untrusted' }],
    });
    expect(commandCallbacks).toBe(0);
  });
});
