import type { ApplyReport, ChangeSetProposal, OperationProblem } from '../../core/model/index.js';
import type { BundleDirectoryInput } from '../../core/templates/index.js';
import type { ProposalApplicator } from '../workspace/proposalApplicator.js';
import type { WorkspacePort } from '../workspace/types.js';
import type { WorkspaceUriCodec } from '../workspace/uriCodec.js';
import type { WorkspaceFolderMembershipSession } from '../workspace/workspaceFolderMembership.js';

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
  readonly previewIdentity: ProposalPreviewIdentity;
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

/** Stable identity shared by one summary, all of its diffs, and its approval notification. */
export interface ProposalPreviewIdentity {
  readonly id: string;
  readonly label: string;
  readonly targetUri: string;
}

/** Shows immutable, read-only snapshots of every proposed change. */
export interface ProposalPreviewSession {
  readonly identity: ProposalPreviewIdentity;
  /** Fails synchronously when this exact preview is no longer available for a decision. */
  assertActive(): void;
  /** Brings this exact run's summary back to the foreground without recreating its proposal. */
  reveal(): Promise<void>;
  /** Closes this run's preview tabs and releases its provider-held bytes and registration. */
  dispose(): Promise<void>;
}

/** Owns one recoverable, one-shot Apply/Cancel decision for a previewed proposal. */
export interface ProposalDecisionController {
  request(options: ConfirmationOptions, previewSession: ProposalPreviewSession): Promise<boolean>;
  /** Presents recovery actions when another write command reaches the fail-fast gate. */
  showBusyRecovery(message: string): Promise<void>;
}

export interface ProposalPreviewer<TUri> {
  show(
    proposal: ChangeSetProposal,
    presentation: ProposalPresentation,
    port: WorkspacePort<TUri>,
    uris: WorkspaceUriCodec<TUri>,
  ): Promise<ProposalPreviewSession>;
}

declare const proposalWorkflowLeaseBrand: unique symbol;

/** Opaque proof that the extension-wide write-command gate is currently owned. */
export interface ProposalWorkflowLease {
  readonly [proposalWorkflowLeaseBrand]: true;
}

export interface ProposalWorkflowScheduler {
  /** Starts immediately or rejects as busy; implementations must never retain the callback. */
  runExclusive<TResult>(
    workflow: (lease: ProposalWorkflowLease) => Promise<TResult>,
  ): Promise<TResult>;
  /** Fails when the lease did not come from this scheduler or its command already settled. */
  assertActive(lease: ProposalWorkflowLease): void;
}

export interface ProposalWorkflowDependencies<TUri> {
  readonly port: WorkspacePort<TUri>;
  readonly uris: WorkspaceUriCodec<TUri>;
  readonly applicator: ProposalApplicator<TUri>;
  readonly ui: CommandUi<TUri>;
  readonly previewer: ProposalPreviewer<TUri>;
  /** Host recovery surface for modeless preview confirmation; tests may use CommandUi fallback. */
  readonly proposalDecisionController?: ProposalDecisionController;
  /** Fail-fast gate covering each complete write command, including selection and planning. */
  readonly workflowScheduler: ProposalWorkflowScheduler;
  readonly isWorkspaceTrusted: () => boolean;
  /** Optional host-owned compatibility recheck used immediately before existing-bundle writes. */
  readonly revalidateBundleWrite?: (bundleRootUri: TUri) => Promise<OperationProblem | undefined>;
  /**
   * Captures the exact open workspace folder that authorized a proposal.
   * Removal is irreversible for the returned workflow session.
   */
  readonly captureWorkspaceFolderMembership: (
    workspaceSafetyRootUri: TUri,
  ) => WorkspaceFolderMembershipSession;
}

export type CommandOutcome =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'refused'; readonly problems: readonly OperationProblem[] }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'applied'; readonly report: ApplyReport }
  | { readonly kind: 'failed'; readonly report?: ApplyReport };

export interface SelectedBundle<TUri> {
  readonly bundleRootUri: TUri;
  /** Open workspace folder used to validate every ancestor of the bundle root before writes. */
  readonly workspaceSafetyRootUri: TUri;
  readonly label?: string;
}

export type SelectBundle<TUri> = () => Promise<SelectedBundle<TUri> | undefined>;

export interface InitializationTarget<TUri> {
  readonly targetRootUri: TUri;
  /** Open workspace folder containing `targetRootUri`. */
  readonly workspaceSafetyRootUri: TUri;
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
