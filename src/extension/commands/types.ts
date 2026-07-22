import type { ApplyReport, ChangeSetProposal, OperationProblem } from '../../core/model/index.js';
import type { BundleDirectoryInput } from '../../core/templates/index.js';
import type { ProposalApplicator } from '../workspace/proposalApplicator.js';
import type { WorkspacePort } from '../workspace/types.js';
import type { WorkspaceUriCodec } from '../workspace/uriCodec.js';

export interface SelectionItem<TValue extends string> {
  readonly value: TValue;
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
}

export interface TextInputOptions {
  readonly title: string;
  readonly prompt: string;
  readonly value?: string;
  readonly placeHolder?: string;
  readonly validate?: (value: string) => string | undefined;
}

export interface ConfirmationOptions {
  readonly title: string;
  readonly detail: string;
  readonly confirmLabel: string;
  /** Preview confirmations must leave the editor usable while this prompt is pending. */
  readonly modeless: true;
}

/** The small user-interaction surface used by command workflows. */
export interface CommandUi<TUri> {
  select<TValue extends string>(
    title: string,
    placeHolder: string,
    items: readonly SelectionItem<TValue>[],
  ): Promise<TValue | undefined>;
  input(options: TextInputOptions): Promise<string | undefined>;
  confirm(options: ConfirmationOptions): Promise<boolean>;
  showInformation(message: string): Promise<void>;
  showWarning(message: string): Promise<void>;
  showError(message: string): Promise<void>;
  openDocument(uri: TUri): Promise<void>;
}

export interface ProposalPresentation {
  readonly title: string;
  readonly summary: readonly string[];
}

/** Shows immutable, read-only snapshots of every proposed change. */
export interface ProposalPreviewSession {
  /** Releases provider-held preview bytes after the confirmation flow finishes. */
  dispose(): void;
}

export interface ProposalPreviewer<TUri> {
  show(
    proposal: ChangeSetProposal,
    presentation: ProposalPresentation,
    port: WorkspacePort<TUri>,
    uris: WorkspaceUriCodec<TUri>,
  ): Promise<ProposalPreviewSession>;
}

export interface ProposalWorkflowDependencies<TUri> {
  readonly port: WorkspacePort<TUri>;
  readonly uris: WorkspaceUriCodec<TUri>;
  readonly applicator: ProposalApplicator<TUri>;
  readonly ui: CommandUi<TUri>;
  readonly previewer: ProposalPreviewer<TUri>;
  readonly isWorkspaceTrusted: () => boolean;
  /** Optional host-owned compatibility recheck used immediately before existing-bundle writes. */
  readonly revalidateBundleWrite?: (bundleRootUri: TUri) => Promise<OperationProblem | undefined>;
}

export type CommandOutcome =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'refused'; readonly problems: readonly OperationProblem[] }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'applied'; readonly report: ApplyReport }
  | { readonly kind: 'failed'; readonly report?: ApplyReport };

export interface SelectedBundle<TUri> {
  readonly bundleRootUri: TUri;
  readonly label?: string;
}

export type SelectBundle<TUri> = () => Promise<SelectedBundle<TUri> | undefined>;

export interface InitializationTarget<TUri> {
  readonly targetRootUri: TUri;
  readonly label: string;
  readonly suggestedBundleDirectory: string;
}

export type SelectInitializationTarget<TUri> = () => Promise<
  InitializationTarget<TUri> | undefined
>;

export interface AgentIntegrationTarget<TUri> {
  /** Repository or workspace root that will contain AGENTS.md and .agents/. */
  readonly integrationRootUri: TUri;
  /** Selected bundle root, retained for the final compatibility recheck. */
  readonly bundleRootUri?: TUri;
  /** Actual bundle directory relative to integrationRootUri, or "." for that root. */
  readonly bundlePath: BundleDirectoryInput;
  readonly label?: string;
}

export type SelectAgentIntegrationTarget<TUri> = () => Promise<
  AgentIntegrationTarget<TUri> | undefined
>;
