import type { ChangeSetProposal } from '../../../src/core/model/index.js';
import type {
  CommandUi,
  ConfirmationOptions,
  ProposalPresentation,
  ProposalPreviewer,
  SelectionItem,
} from '../../../src/extension/commands/types.js';

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
  readonly shown: { proposal: ChangeSetProposal; presentation: ProposalPresentation }[] = [];
  releasedSessions = 0;
  failure: Error | undefined;

  async show(proposal: ChangeSetProposal, presentation: ProposalPresentation) {
    if (this.failure !== undefined) {
      throw this.failure;
    }
    this.shown.push({ proposal, presentation });
    let released = false;
    return {
      dispose: () => {
        if (!released) {
          released = true;
          this.releasedSessions += 1;
        }
      },
    };
  }
}
