export {
  BUNDLE_DISCOVERY_EXCLUDED_DIRECTORY_NAMES,
  BundleContextService,
  type BundleCandidate,
  type BundleDiscovery,
  type BundleDiscoveryFailure,
  type BundleIndexDecision,
  type BundleIndexInspection,
  type BundleSelection,
  type BundleSelectionReason,
  type InspectBundleIndex,
} from './bundleContext.js';
export { matchesSha256, normalizeSha256, sha256Content } from './contentHash.js';
export {
  isUriContained,
  normalizeContainedRelativePath,
  preserveProviderRelativePath,
  relativeParentPaths,
  UnsafeWorkspacePathError,
  type UriIdentity,
} from './pathSafety.js';
export { ProposalApplicator, type ProposalPreflightReport } from './proposalApplicator.js';
export {
  RefreshCoordinator,
  WORKSPACE_REFRESH_DEBOUNCE_MILLISECONDS,
  type DisposableLike,
  type PublishedRefresh,
  type RefreshCoordinatorOptions,
  type RefreshRequest,
  type RefreshScheduler,
  type WorkspaceChange,
  type WorkspaceChangeKind,
  type WorkspaceChangeSource,
} from './refreshCoordinator.js';
export {
  WorkspaceAccessError,
  type WorkspaceAccessErrorCode,
  type WorkspaceEntry,
  type WorkspaceEntryType,
  type WorkspaceEnumerationOptions,
  type WorkspacePort,
  type WorkspaceStat,
  type WorkspaceTraversalEvent,
  type WorkspaceTraversalOptions,
  type WorkspaceWriteOptions,
} from './types.js';
export { vscodeUriCodec, type WorkspaceUriCodec } from './uriCodec.js';
export { createVscodeMarkdownChangeSource } from './vscodeChangeSource.js';
export { VscodeWorkspacePort } from './vscodeWorkspacePort.js';
