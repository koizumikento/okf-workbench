import * as vscode from 'vscode';

import type {
  ConfirmationOptions,
  ProposalDecisionController,
  ProposalPreviewSession,
} from './types.js';
import { proposalConfirmationMessage } from './vscode-command-ui.js';

export const REVIEW_PENDING_CHANGES_COMMAND = 'okfWorkbench.reviewPendingChanges';
export const PENDING_PROPOSAL_CONTEXT = 'okfWorkbench.hasPendingProposal';

const REVIEW_LABEL = 'Review pending changes';
const CANCEL_PENDING_LABEL = 'Cancel pending changes';
const CANCEL_LABEL = 'Cancel';

interface PendingDecision {
  readonly options: ConfirmationOptions;
  readonly previewSession: ProposalPreviewSession;
  readonly resolve: (approved: boolean) => void;
  promptAttempt: number;
}

export interface VscodeProposalDecisionControllerOptions {
  readonly onLog?: (message: string) => void;
}

/**
 * Keeps one modeless proposal decision recoverable even when VS Code hides or retains the original
 * notification promise. Every prompt attempt is tied to the same pending object, so late results
 * from a cancelled or superseded activation cannot approve another proposal.
 */
export class VscodeProposalDecisionController
  implements ProposalDecisionController, vscode.Disposable
{
  readonly #status: vscode.StatusBarItem;
  readonly #onLog: ((message: string) => void) | undefined;
  #contextUpdateTail: Promise<unknown> = Promise.resolve();
  #pending: PendingDecision | undefined;
  #disposed = false;

  constructor(options: VscodeProposalDecisionControllerOptions = {}) {
    this.#onLog = options.onLog;
    this.#status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.#status.name = 'OKF pending changes';
    this.#status.text = '$(warning) OKF changes awaiting review';
    this.#status.tooltip = 'Reveal the pending OKF preview and choose Apply or Cancel';
    this.#status.command = REVIEW_PENDING_CHANGES_COMMAND;
    this.#status.hide();
  }

  public request(
    options: ConfirmationOptions,
    previewSession: ProposalPreviewSession,
  ): Promise<boolean> {
    if (this.#disposed) {
      return Promise.resolve(false);
    }
    if (this.#pending !== undefined) {
      throw new Error('A proposal confirmation is already pending.');
    }
    previewSession.assertActive();
    const decision = new Promise<boolean>((resolve) => {
      const pending: PendingDecision = {
        options,
        previewSession,
        resolve,
        promptAttempt: 0,
      };
      this.#pending = pending;
      this.#status.show();
      this.#setContext(true);
      this.#log('proposal.confirmation phase=awaiting-review');
      this.#prompt(pending);
    });
    return decision;
  }

  public async reviewPending(): Promise<boolean> {
    const pending = this.#pending;
    if (pending === undefined) {
      await vscode.window.showInformationMessage('No OKF changes are awaiting review.');
      return false;
    }
    try {
      pending.previewSession.assertActive();
      await pending.previewSession.reveal();
      pending.previewSession.assertActive();
    } catch {
      this.#log(
        'proposal.confirmation phase=finished outcome=cancelled reason=preview-unavailable',
      );
      this.#settle(pending, false);
      await vscode.window.showErrorMessage(
        'The pending OKF preview is no longer available. No files were written; run the original command again.',
        { modal: true },
      );
      return true;
    }
    this.#log('proposal.confirmation phase=review-reopened');
    this.#prompt(pending);
    return true;
  }

  public cancelPending(): boolean {
    const pending = this.#pending;
    if (pending === undefined) return false;
    this.#log('proposal.confirmation phase=finished outcome=cancelled reason=user-recovery');
    this.#settle(pending, false);
    return true;
  }

  public async showBusyRecovery(message: string): Promise<void> {
    const pending = this.#pending;
    if (pending === undefined) {
      await vscode.window.showWarningMessage(message);
      return;
    }
    const selected = await vscode.window.showWarningMessage(
      message,
      REVIEW_LABEL,
      CANCEL_PENDING_LABEL,
    );
    if (this.#pending !== pending) return;
    if (selected === REVIEW_LABEL) {
      await this.reviewPending();
    } else if (selected === CANCEL_PENDING_LABEL) {
      this.cancelPending();
    }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const pending = this.#pending;
    if (pending !== undefined) {
      this.#log('proposal.confirmation phase=finished outcome=cancelled reason=host-disposed');
      this.#settle(pending, false);
    } else {
      this.#setContext(false);
    }
    this.#status.dispose();
  }

  #prompt(pending: PendingDecision): void {
    pending.promptAttempt += 1;
    const attempt = pending.promptAttempt;
    const baseMessage = proposalConfirmationMessage(pending.options);
    const message =
      attempt === 1 ? baseMessage : `Review reopened (attempt ${String(attempt)}). ${baseMessage}`;
    let result: Thenable<string | undefined>;
    try {
      result = vscode.window.showWarningMessage(
        message,
        { modal: false },
        pending.options.confirmLabel,
        CANCEL_LABEL,
      );
    } catch {
      this.#log('proposal.confirmation phase=prompt-failed reason=host-error');
      return;
    }
    void Promise.resolve(result).then(
      (selected) => {
        if (this.#pending !== pending || pending.promptAttempt !== attempt) return;
        if (selected === pending.options.confirmLabel) {
          this.#log('proposal.confirmation phase=finished outcome=approved');
          this.#settle(pending, true);
        } else if (selected === CANCEL_LABEL) {
          this.#log('proposal.confirmation phase=finished outcome=cancelled reason=user-decision');
          this.#settle(pending, false);
        } else {
          this.#log('proposal.confirmation phase=prompt-hidden recovery=available');
        }
      },
      () => {
        if (this.#pending === pending && pending.promptAttempt === attempt) {
          this.#log('proposal.confirmation phase=prompt-failed reason=host-error');
        }
      },
    );
  }

  #settle(pending: PendingDecision, approved: boolean): void {
    if (this.#pending !== pending) return;
    this.#pending = undefined;
    this.#status.hide();
    this.#setContext(false);
    pending.resolve(approved);
  }

  #setContext(active: boolean): void {
    this.#contextUpdateTail = this.#contextUpdateTail
      .then(() => vscode.commands.executeCommand('setContext', PENDING_PROPOSAL_CONTEXT, active))
      .catch(() => {
        this.#log('proposal.confirmation phase=context-update-failed');
      });
  }

  #log(message: string): void {
    try {
      this.#onLog?.(message);
    } catch {
      // Operational logging must not alter proposal confirmation or cancellation.
    }
  }
}
