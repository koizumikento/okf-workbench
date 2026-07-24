import type { ChangeSetProposal } from '../../../src/core/model/index.js';
import type {
  CommandUi,
  ConfirmationOptions,
  ProposalPresentation,
  ProposalPreviewIdentity,
  ProposalPreviewer,
  SelectionItem,
} from '../../../src/extension/commands/types.js';
import type { WorkspaceFolderMembershipSession } from '../../../src/extension/workspace/workspaceFolderMembership.js';

/** Default open-folder authorization used by command tests that do not exercise membership changes. */
export function captureOpenWorkspaceFolderMembership(): WorkspaceFolderMembershipSession {
  let disposed = false;
  return {
    currentProblem: () =>
      disposed
        ? {
            code: 'workspace-folder-unavailable',
            message: 'The test workspace folder authorization was disposed.',
          }
        : undefined,
    onDidInvalidate: () => ({ dispose() {} }),
    dispose: () => {
      disposed = true;
    },
  };
}

export class FakeCommandUi implements CommandUi<string> {
  readonly selections: (string | undefined)[] = [];
  readonly inputs: (string | undefined)[] = [];
  readonly confirmations: boolean[] = [];
  readonly confirmationRequests: ConfirmationOptions[] = [];
  readonly information: string[] = [];
  readonly warnings: string[] = [];
  readonly errors: string[] = [];
  readonly opened: string[] = [];
  openFailure: Error | undefined;

  async select<TValue extends string>(
    _title: string,
    _placeHolder: string,
    items: readonly SelectionItem<TValue>[],
  ): Promise<TValue | undefined> {
    const requested = this.selections.shift();
    return items.find((item) => item.value === requested)?.value;
  }

  async input(): Promise<string | undefined> {
    return this.inputs.shift();
  }

  async confirm(options: ConfirmationOptions): Promise<boolean> {
    this.confirmationRequests.push(options);
    return this.confirmations.shift() ?? false;
  }

  async showInformation(message: string): Promise<void> {
    this.information.push(message);
  }

  async showWarning(message: string): Promise<void> {
    this.warnings.push(message);
  }

  async showError(message: string): Promise<void> {
    this.errors.push(message);
  }

  async openDocument(uri: string): Promise<void> {
    if (this.openFailure !== undefined) {
      throw this.openFailure;
    }
    this.opened.push(uri);
  }
}

export class FakeProposalPreviewer implements ProposalPreviewer<string> {
  readonly shown: {
    proposal: ChangeSetProposal;
    presentation: ProposalPresentation;
    identity: ProposalPreviewIdentity;
  }[] = [];
  releasedSessions = 0;
  revealedSessions = 0;
  failure: Error | undefined;
  #run = 0;

  async show(proposal: ChangeSetProposal, presentation: ProposalPresentation) {
    if (this.failure !== undefined) {
      throw this.failure;
    }
    this.#run += 1;
    const identity: ProposalPreviewIdentity = {
      id: `fake-okf-preview-${this.#run}`,
      label: `Fake OKF Preview #${this.#run}`,
      targetUri: proposal.writeRootUri,
    };
    this.shown.push({ proposal, presentation, identity });
    let released = false;
    return {
      identity,
      assertActive: () => {
        if (released) {
          throw new Error(`${identity.label} is no longer active.`);
        }
      },
      reveal: async () => {
        if (released) {
          throw new Error(`${identity.label} is no longer active.`);
        }
        this.revealedSessions += 1;
      },
      dispose: async () => {
        if (!released) {
          released = true;
          this.releasedSessions += 1;
        }
      },
    };
  }
}
