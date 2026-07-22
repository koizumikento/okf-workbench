export {
  createInitializeBundleCommand,
  type InitializeBundleCommandDependencies,
} from './initialize-bundle.js';
export { createNewConceptCommand, type NewConceptCommandDependencies } from './new-concept.js';
export {
  collectWorkspaceIndexSource,
  createRegenerateIndexesCommand,
  type RegenerateIndexesCommandDependencies,
  type WorkspaceIndexSource,
} from './regenerate-indexes.js';
export {
  createSetupAgentIntegrationCommand,
  type SetupAgentIntegrationCommandDependencies,
} from './setup-agent-integration.js';
export {
  agentPlanToProposal,
  bundleFilesToProposal,
  createFileProposal,
  createProposalChange,
  existingFileProposal,
  indexChangesToProposal,
} from './proposals.js';
export {
  problemsMessage,
  refuseUntrustedWorkspace,
  runProposalWorkflow,
  untrustedWorkspaceProblem,
  type RunProposalOptions,
} from './run-proposal.js';
export type {
  AgentIntegrationTarget,
  CommandOutcome,
  CommandUi,
  ConfirmationOptions,
  InitializationTarget,
  ProposalPresentation,
  ProposalPreviewer,
  ProposalPreviewSession,
  ProposalWorkflowDependencies,
  SelectedBundle,
  SelectAgentIntegrationTarget,
  SelectBundle,
  SelectInitializationTarget,
  SelectionItem,
  TextInputOptions,
} from './types.js';
export { VscodeCommandUi } from './vscode-command-ui.js';
