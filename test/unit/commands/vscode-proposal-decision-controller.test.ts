import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeState = vi.hoisted(() => {
  const status = {
    name: '',
    text: '',
    tooltip: '',
    command: '',
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    status,
    createStatusBarItem: vi.fn(() => status),
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    executeCommand: vi.fn(),
  };
});

vi.mock('vscode', () => ({
  StatusBarAlignment: { Left: 1 },
  window: {
    createStatusBarItem: vscodeState.createStatusBarItem,
    showWarningMessage: vscodeState.showWarningMessage,
    showInformationMessage: vscodeState.showInformationMessage,
    showErrorMessage: vscodeState.showErrorMessage,
  },
  commands: {
    executeCommand: vscodeState.executeCommand,
  },
}));

import type {
  ConfirmationOptions,
  ProposalPreviewSession,
} from '../../../src/extension/commands/types.js';
import {
  PENDING_PROPOSAL_CONTEXT,
  REVIEW_PENDING_CHANGES_COMMAND,
  VscodeProposalDecisionController,
} from '../../../src/extension/commands/vscode-proposal-decision-controller.js';

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

function preview(): ProposalPreviewSession & {
  readonly reveal: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
  expire(): void;
} {
  let expired = false;
  return {
    identity: {
      id: 'preview-run-1',
      label: 'OKF Preview run 1',
      targetUri: 'memfs://workspace/knowledge',
    },
    assertActive() {
      if (expired) throw new Error('Preview expired.');
    },
    reveal: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    expire() {
      expired = true;
    },
  };
}

const confirmation: ConfirmationOptions = {
  title: 'Set Up Agent Integration',
  detail: '2 proposed files',
  confirmLabel: 'Apply changes',
  previewIdentity: {
    id: 'preview-run-1',
    label: 'OKF Preview run 1',
    targetUri: 'memfs://workspace/knowledge',
  },
  modeless: true,
};

async function nextMicrotask(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('VscodeProposalDecisionController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscodeState.showInformationMessage.mockResolvedValue(undefined);
    vscodeState.showErrorMessage.mockResolvedValue(undefined);
    vscodeState.executeCommand.mockResolvedValue(undefined);
  });

  it('keeps a hidden confirmation recoverable and settles it from a reopened review', async () => {
    vscodeState.showWarningMessage.mockResolvedValueOnce(undefined).mockResolvedValueOnce('Cancel');
    const session = preview();
    const controller = new VscodeProposalDecisionController();
    let settled = false;

    const decision = controller.request(confirmation, session).finally(() => {
      settled = true;
    });
    await nextMicrotask();

    expect(settled).toBe(false);
    expect(vscodeState.status.show).toHaveBeenCalledOnce();
    expect(vscodeState.status.command).toBe(REVIEW_PENDING_CHANGES_COMMAND);
    expect(vscodeState.executeCommand).toHaveBeenCalledWith(
      'setContext',
      PENDING_PROPOSAL_CONTEXT,
      true,
    );

    await expect(controller.reviewPending()).resolves.toBe(true);
    await expect(decision).resolves.toBe(false);
    expect(session.reveal).toHaveBeenCalledOnce();
    expect(vscodeState.status.hide).toHaveBeenCalled();
    expect(vscodeState.executeCommand).toHaveBeenCalledWith(
      'setContext',
      PENDING_PROPOSAL_CONTEXT,
      false,
    );
  });

  it('ignores an older prompt result after review opens a newer decision attempt', async () => {
    const initialPrompt = deferred<string | undefined>();
    const reopenedPrompt = deferred<string | undefined>();
    vscodeState.showWarningMessage
      .mockReturnValueOnce(initialPrompt.promise)
      .mockReturnValueOnce(reopenedPrompt.promise);
    const controller = new VscodeProposalDecisionController();
    const decision = controller.request(confirmation, preview());
    let settled = false;
    void decision.finally(() => {
      settled = true;
    });

    await controller.reviewPending();
    initialPrompt.resolve('Apply changes');
    await nextMicrotask();
    expect(settled).toBe(false);

    reopenedPrompt.resolve('Apply changes');
    await expect(decision).resolves.toBe(true);
  });

  it('offers review and cancel actions when another write command reaches the busy gate', async () => {
    const initialPrompt = deferred<string | undefined>();
    vscodeState.showWarningMessage
      .mockReturnValueOnce(initialPrompt.promise)
      .mockResolvedValueOnce('Cancel pending changes');
    const controller = new VscodeProposalDecisionController();
    const decision = controller.request(confirmation, preview());

    await controller.showBusyRecovery('Write operation is already in progress.');

    await expect(decision).resolves.toBe(false);
    expect(vscodeState.showWarningMessage).toHaveBeenNthCalledWith(
      2,
      'Write operation is already in progress.',
      'Review pending changes',
      'Cancel pending changes',
    );
  });

  it('fails closed when the pending preview is no longer available', async () => {
    const initialPrompt = deferred<string | undefined>();
    vscodeState.showWarningMessage.mockReturnValueOnce(initialPrompt.promise);
    const session = preview();
    const controller = new VscodeProposalDecisionController();
    const decision = controller.request(confirmation, session);
    session.expire();

    await expect(controller.reviewPending()).resolves.toBe(true);
    await expect(decision).resolves.toBe(false);
    expect(vscodeState.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('No files were written'),
      { modal: true },
    );
  });

  it('cancels a pending decision when the host disposes the controller', async () => {
    const initialPrompt = deferred<string | undefined>();
    vscodeState.showWarningMessage.mockReturnValueOnce(initialPrompt.promise);
    const controller = new VscodeProposalDecisionController();
    const decision = controller.request(confirmation, preview());

    controller.dispose();

    await expect(decision).resolves.toBe(false);
    expect(vscodeState.status.dispose).toHaveBeenCalledOnce();
  });

  it('reports when there is no pending proposal to review', async () => {
    const controller = new VscodeProposalDecisionController();

    await expect(controller.reviewPending()).resolves.toBe(false);
    expect(vscodeState.showInformationMessage).toHaveBeenCalledWith(
      'No OKF changes are awaiting review.',
    );
  });
});
