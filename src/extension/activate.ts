import * as vscode from 'vscode';

import { createLazyOkfCore, loadPackagedWasmOkfCore } from '../core/wasm/index.js';
import type { GraphRenderFailureReason } from '../shared/protocol/index.js';
import {
  applyBundledCliEnvironment,
  BUNDLED_CLI_CONFIGURATION,
  bundledCliStatusMessage,
  inspectBundledCli,
  OPEN_CLI_TERMINAL_COMMAND,
  SHOW_CLI_STATUS_COMMAND,
} from './cli/index.js';
import { bundlePathWithinIntegrationRoot } from './composition/bundle-path.js';
import { bundleSelectionChoices } from './composition/bundle-selection.js';
import {
  guardBundleWriteSelection,
  inspectBundleWriteAccess,
  inspectBundleRootIndex,
  inspectExplicitBundleRoot,
} from './composition/bundle-inspection.js';
import {
  createInitializeBundleCommand,
  createNewConceptCommand,
  createRegenerateIndexesCommand,
  createSetupAgentIntegrationCommand,
  problemsMessage,
  REVIEW_PENDING_CHANGES_COMMAND,
  runPublicProposalCommand,
  SerialProposalWorkflowScheduler,
  VscodeCommandUi,
  VscodeProposalDecisionController,
  type CommandOutcome,
  type InitializationTarget,
  type ProposalWorkflowLease,
  type SelectedBundle,
} from './commands/index.js';
import { OKF_COMMANDS, type OkfCommandId, type OkfCommandMetadata } from './commands/ids.js';
import { VscodeProposalPreviewer } from './preview/index.js';
import { FailFastReadCommandGate, readCommandBusyProblem } from './read-command-gate.js';
import {
  BUNDLE_UNAVAILABLE_NOTIFICATION,
  RuntimeAvailabilityNotificationState,
} from './runtimeAvailabilityNotifications.js';
import {
  activeWorkspaceSafetyRootWasRemoved,
  type RuntimeSelectionIdentity,
} from './runtimeSelection.js';
import {
  createVscodeBundleRuntime,
  type BundleRuntimeContext,
  type BundleRuntimeSnapshot,
} from './runtime/index.js';
import {
  createAcceptanceCompletionSignals,
  type AcceptanceCommandTicket,
  type OkfWorkbenchAcceptanceApi,
} from './runtime/acceptanceSignals.js';
import { isEditorDiagnosticFinding } from './diagnostics/index.js';
import { VscodeGraphPanelService, type GraphDeliveryFailureReason } from './webview/index.js';
import {
  BundleContextService,
  inspectWorkspaceDirectoryChain,
  isUriContained,
  ProposalApplicator,
  vscodeUriCodec,
  VscodeWorkspacePort,
  WorkspaceFolderMembershipTracker,
  type BundleCandidate,
} from './workspace/index.js';

const OUTPUT_CHANNEL_NAME = 'OKF Workbench';

type CommandResult = CommandOutcome | AcceptanceCommandTicket | undefined;
type CommandHandler = (
  arguments_: readonly unknown[],
  proposalLease: ProposalWorkflowLease | undefined,
) => Promise<CommandResult>;

interface PendingRuntimeAction {
  readonly root: string;
  readonly acceptanceRequestId: number | undefined;
}

interface PendingRuntimeActions {
  graph?: PendingRuntimeAction;
  validation?: PendingRuntimeAction;
}

type PendingRuntimeActionKind = keyof PendingRuntimeActions;

function errorKind(error: unknown): string {
  return error instanceof Error && error.name.length > 0 ? error.name : 'UnknownError';
}

function requireProposalLease(
  proposalLease: ProposalWorkflowLease | undefined,
): ProposalWorkflowLease {
  if (proposalLease === undefined) {
    throw new Error('A write command reached its handler without public-entry admission.');
  }
  return proposalLease;
}

function findingCounts(snapshot: BundleRuntimeSnapshot<vscode.Uri>): {
  readonly errors: number;
  readonly warnings: number;
  readonly information: number;
} {
  let errors = 0;
  let warnings = 0;
  let information = 0;
  for (const finding of snapshot.findings) {
    if (!isEditorDiagnosticFinding(finding)) {
      continue;
    }
    if (finding.severity === 'error') {
      errors += 1;
    } else if (finding.severity === 'warning') {
      warnings += 1;
    } else {
      information += 1;
    }
  }
  return { errors, warnings, information };
}

function candidateLabel(candidate: BundleCandidate<vscode.Uri>): string {
  if (candidate.label !== undefined) {
    return candidate.label;
  }
  const relative = vscode.workspace.asRelativePath(candidate.rootUri, false);
  return relative.length > 0 ? relative : candidate.rootUri.path.split('/').at(-1) || 'OKF bundle';
}

function candidateForRoot(rootUri: vscode.Uri, label?: string): BundleCandidate<vscode.Uri> {
  const indexUri = vscode.Uri.joinPath(rootUri, 'index.md');
  return {
    rootUri,
    rootUriString: vscodeUriCodec.serialize(rootUri),
    indexUri,
    indexUriString: vscodeUriCodec.serialize(indexUri),
    ...(label === undefined ? {} : { label }),
  };
}

function uriArgument(value: unknown): vscode.Uri | undefined {
  return value instanceof vscode.Uri ? value : undefined;
}

export function activate(context: vscode.ExtensionContext): OkfWorkbenchAcceptanceApi | undefined {
  const core = createLazyOkfCore(loadPackagedWasmOkfCore);
  const acceptanceSignals = createAcceptanceCompletionSignals(
    process.env['OKF_ACCEPTANCE_DRIVER'],
    OKF_COMMANDS,
  );
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME, { log: true });
  const bundledCli = inspectBundledCli(__dirname);
  let bundledCliEnvironmentEnabled = true;
  const synchronizeBundledCliEnvironment = (): void => {
    bundledCliEnvironmentEnabled = vscode.workspace
      .getConfiguration('okfWorkbench.cli')
      .get<boolean>('exposeInIntegratedTerminal', true);
    applyBundledCliEnvironment(
      context.environmentVariableCollection,
      bundledCli,
      bundledCliEnvironmentEnabled,
    );
  };
  synchronizeBundledCliEnvironment();
  output.info(
    bundledCli.available
      ? `cli.integration available=true target=${bundledCli.targetPlatform}`
      : `cli.integration available=false reason=${bundledCli.reason}`,
  );
  const ui = new VscodeCommandUi();
  const previewer = new VscodeProposalPreviewer();
  const proposalDecisionController = new VscodeProposalDecisionController({
    onLog: (message) => output.info(message),
  });
  const workflowScheduler = new SerialProposalWorkflowScheduler();
  const readCommandGate = new FailFastReadCommandGate();
  const port = new VscodeWorkspacePort();
  const workspaceFolderMembership = new WorkspaceFolderMembershipTracker(vscodeUriCodec, () =>
    (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri),
  );
  const applicator = new ProposalApplicator(port, vscodeUriCodec);
  const graphPanels = new VscodeGraphPanelService(context, {
    onRejectedMessage: () => output.warn('webview.message rejected=true'),
    onPostError: (error) => {
      output.error(`webview.interaction failed=true error_type=${errorKind(error)}`);
      void ui
        .showError(
          'The graph could not complete that interaction. The source may have moved or the Webview may have closed; refresh the bundle and try again.',
        )
        .catch((notificationError: unknown) => {
          output.error(`notification.failed=true error_type=${errorKind(notificationError)}`);
        });
    },
    ...(acceptanceSignals === undefined
      ? {}
      : {
          onGraphRendered: (revision: number) => acceptanceSignals.recordGraphRender(revision),
          onGraphRenderFailed: (revision: number, reason: GraphRenderFailureReason) =>
            acceptanceSignals.recordGraphRenderFailure(revision, reason),
        }),
  });
  const bundleContext = new BundleContextService(port, vscodeUriCodec, (inspection) =>
    inspectBundleRootIndex({
      rootUri: vscodeUriCodec.serialize(inspection.rootUri),
      indexUri: vscodeUriCodec.serialize(inspection.indexUri),
      text: inspection.text,
    }),
  );
  const pending: PendingRuntimeActions = {};
  const availabilityNotifications = new RuntimeAvailabilityNotificationState();
  let selectedRuntimeSelection: RuntimeSelectionIdentity | undefined;

  const takePending = (
    kind: PendingRuntimeActionKind,
    root?: string,
  ): PendingRuntimeAction | undefined => {
    const action = pending[kind];
    if (action === undefined || (root !== undefined && action.root !== root)) {
      return undefined;
    }
    if (kind === 'graph') {
      delete pending.graph;
    } else {
      delete pending.validation;
    }
    return action;
  };
  const failPending = (kind: PendingRuntimeActionKind, reason: string, root?: string): boolean => {
    const action = takePending(kind, root);
    if (action === undefined) return false;
    if (action.acceptanceRequestId !== undefined) {
      if (kind === 'graph') {
        acceptanceSignals?.recordGraphOpenFailure(action.acceptanceRequestId, reason);
      } else {
        acceptanceSignals?.recordValidationFailure(action.acceptanceRequestId, reason);
      }
    }
    return true;
  };
  const discardPending = (
    kind: PendingRuntimeActionKind,
    reason: string,
    root?: string,
  ): boolean => {
    const action = takePending(kind, root);
    if (action === undefined) return false;
    if (action.acceptanceRequestId !== undefined) {
      if (kind === 'graph') {
        acceptanceSignals?.discardGraphOpenCommand(action.acceptanceRequestId, reason);
      } else {
        acceptanceSignals?.discardValidationCommand(action.acceptanceRequestId, reason);
      }
    }
    return true;
  };
  const replacePending = (kind: PendingRuntimeActionKind, action: PendingRuntimeAction): void => {
    failPending(kind, 'superseded');
    pending[kind] = action;
  };
  const failAllPending = (reason: string): void => {
    failPending('graph', reason);
    failPending('validation', reason);
  };
  const failAllAcceptanceRequests = (reason: string): void => {
    failAllPending(reason);
    acceptanceSignals?.failActiveGraphOpenCommands(reason);
    acceptanceSignals?.failActiveValidationCommands(reason);
  };

  const showBackgroundError = (message: string): void => {
    void ui.showError(message).catch((error: unknown) => {
      output.error(`notification.failed=true error_type=${errorKind(error)}`);
    });
  };
  const showBackgroundInformation = (message: string): void => {
    void ui.showInformation(message).catch((error: unknown) => {
      output.error(`notification.failed=true error_type=${errorKind(error)}`);
    });
  };
  const showBackgroundWarning = (message: string): void => {
    void ui.showWarning(message).catch((error: unknown) => {
      output.error(`notification.failed=true error_type=${errorKind(error)}`);
    });
  };
  const runReadCommand = async (
    operation: () => Promise<CommandResult>,
  ): Promise<CommandResult> => {
    const admission = await readCommandGate.run(operation);
    if (admission.admitted) {
      return admission.value;
    }

    const problem = readCommandBusyProblem();
    output.warn('read-command refused=true reason=read-command-busy');
    if (admission.shouldNotify && acceptanceSignals === undefined) {
      showBackgroundWarning(problemsMessage('Read operation is already starting.', [problem]));
    }
    return { kind: 'refused', problems: [problem] };
  };

  const onRuntimePublish = (snapshot: BundleRuntimeSnapshot<vscode.Uri>): void => {
    const root = snapshot.context.rootUriString;
    const pendingGraph = takePending('graph', root);
    const pendingValidation = takePending('validation', root);
    if (availabilityNotifications.recordPublication(root)) {
      output.info('bundle.refresh availability=recovered');
    }
    try {
      if (pendingGraph !== undefined) {
        if (pendingGraph.acceptanceRequestId !== undefined) {
          acceptanceSignals?.armGraphOpenCommand(
            pendingGraph.acceptanceRequestId,
            snapshot.revision,
          );
        }
        const graphRequestId = pendingGraph.acceptanceRequestId;
        const onDeliveryFailure =
          graphRequestId === undefined
            ? undefined
            : (reason: GraphDeliveryFailureReason): void =>
                acceptanceSignals?.recordGraphOpenFailure(graphRequestId, reason);
        graphPanels.open(snapshot.graph, snapshot.nodeSources, onDeliveryFailure);
      } else {
        graphPanels.replaceCurrent(snapshot.graph, snapshot.nodeSources);
      }
    } catch (error: unknown) {
      if (pendingGraph?.acceptanceRequestId !== undefined) {
        acceptanceSignals?.recordGraphOpenFailure(
          pendingGraph.acceptanceRequestId,
          'panel-open-failed',
        );
      }
      output.error(`webview.open failed=true error_type=${errorKind(error)}`);
      showBackgroundError(
        'OKF Workbench refreshed the bundle, but could not open the graph. Close any stale graph tab and run OKF: Open 3D Graph again.',
      );
    }

    if (pendingValidation !== undefined) {
      const counts = findingCounts(snapshot);
      showBackgroundInformation(
        `OKF validation complete: ${counts.errors} error(s), ${counts.warnings} warning(s), and ${counts.information} information item(s). ${snapshot.graph.statistics.orphanCount} orphan concept(s) are shown in the 3D Graph without editor diagnostics. Review actionable OKF Conformance, Curation, and Compatibility entries in Problems.`,
      );
    }

    output.info(
      `bundle.refresh revision=${snapshot.revision} concepts=${snapshot.graph.statistics.conceptCount} findings=${snapshot.findings.length}`,
    );
    acceptanceSignals?.recordRuntimePublication(snapshot);
    if (pendingValidation?.acceptanceRequestId !== undefined) {
      acceptanceSignals?.recordValidationCompletion(
        pendingValidation.acceptanceRequestId,
        snapshot,
      );
    }
  };
  const onRuntimeError = (
    error: unknown,
    runtimeContext: BundleRuntimeContext<vscode.Uri>,
  ): void => {
    failPending('graph', 'runtime-failed', runtimeContext.rootUriString);
    failPending('validation', 'runtime-failed', runtimeContext.rootUriString);
    acceptanceSignals?.failActiveGraphOpenCommands('runtime-failed');
    acceptanceSignals?.failActiveValidationCommands('runtime-failed');
    const shouldNotify = availabilityNotifications.shouldNotifyFailure(
      runtimeContext.rootUriString,
    );
    output.error(
      `bundle.refresh failed=true derived_state=cleared availability=unavailable notification=${shouldNotify ? 'scheduled' : 'suppressed'} error_type=${errorKind(error)}`,
    );
    if (shouldNotify) {
      showBackgroundWarning(BUNDLE_UNAVAILABLE_NOTIFICATION);
    }
  };
  const runtime = createVscodeBundleRuntime({
    core,
    onPublish: onRuntimePublish,
    onClear: () => {
      failAllAcceptanceRequests('runtime-cleared');
      graphPanels.closeCurrent();
    },
    onError: onRuntimeError,
  });

  const ensureRuntimeSelection = (
    candidate: BundleCandidate<vscode.Uri>,
    workspaceSafetyRootUri: vscode.Uri,
    force = false,
  ): void => {
    const workspaceSafetyRoot = vscodeUriCodec.serialize(workspaceSafetyRootUri);
    if (
      !force &&
      selectedRuntimeSelection?.root === candidate.rootUriString &&
      selectedRuntimeSelection.workspaceSafetyRoot === workspaceSafetyRoot
    ) {
      return;
    }
    failAllAcceptanceRequests('selection-changed');
    selectedRuntimeSelection = {
      root: candidate.rootUriString,
      workspaceSafetyRoot,
    };
    availabilityNotifications.select(candidate.rootUriString);
    runtime.select(candidate.rootUri, workspaceSafetyRootUri);
    output.info('bundle.selection changed=true');
  };

  const selectCandidate = (candidate: BundleCandidate<vscode.Uri>): SelectedBundle<vscode.Uri> => {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(candidate.rootUri);
    if (workspaceFolder === undefined) {
      throw new Error('The selected bundle is outside every open workspace folder.');
    }
    bundleContext.select(candidate);
    ensureRuntimeSelection(candidate, workspaceFolder.uri);
    return {
      bundleRootUri: candidate.rootUri,
      workspaceSafetyRootUri: workspaceFolder.uri,
      label: candidateLabel(candidate),
    };
  };

  const chooseExplicitBundleRoot = async (
    defaultUri: vscode.Uri | undefined,
    requestedRoot?: vscode.Uri,
  ): Promise<BundleCandidate<vscode.Uri> | undefined> => {
    const rootUri =
      requestedRoot ??
      (
        await vscode.window.showOpenDialog({
          title: 'OKF: Select Bundle Root',
          openLabel: 'Select bundle',
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          ...(defaultUri === undefined ? {} : { defaultUri }),
        })
      )?.[0];
    if (rootUri === undefined) {
      return undefined;
    }
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(rootUri);
    if (workspaceFolder === undefined) {
      await ui.showError('Select a bundle directory inside an open workspace folder.');
      return undefined;
    }
    const unsafeDirectory = await inspectWorkspaceDirectoryChain(
      workspaceFolder.uri,
      rootUri,
      port,
      vscodeUriCodec,
    );
    if (unsafeDirectory !== undefined) {
      await ui.showError(
        `Workbench refused the selected directory before reading it. ${unsafeDirectory.message}`,
      );
      output.warn('bundle.selection refused=true reason=unsafe-workspace-path');
      return undefined;
    }
    const inspection = await inspectExplicitBundleRoot(
      rootUri,
      port,
      vscodeUriCodec,
      workspaceFolder.uri,
    );
    if (!inspection.ok) {
      await ui.showError(
        'Workbench could not safely inspect the selected directory. Check that it is an accessible workspace folder, then try again.',
      );
      output.warn(`bundle.selection refused=true reason=${inspection.reason}`);
      return undefined;
    }
    if (!inspection.decision.isBundleRoot) {
      output.warn(
        `bundle.selection explicit_override=true declaration=${inspection.decision.reason}`,
      );
    }
    return candidateForRoot(
      rootUri,
      inspection.decision.isBundleRoot ? inspection.decision.label : undefined,
    );
  };

  const selectBundle = async (
    invokedResource?: vscode.Uri,
  ): Promise<SelectedBundle<vscode.Uri> | undefined> => {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    if (workspaceFolders.length === 0) {
      await ui.showError('Open a workspace folder before selecting an OKF bundle.');
      return undefined;
    }

    if (invokedResource !== undefined) {
      const explicit = await chooseExplicitBundleRoot(invokedResource, invokedResource);
      return explicit === undefined ? undefined : selectCandidate(explicit);
    }

    const current = bundleContext.current;
    if (
      current !== undefined &&
      workspaceFolders.some((folder) => isUriContained(folder.uri, current.rootUri))
    ) {
      return selectCandidate(current);
    }

    bundleContext.clear();
    const discovery = await bundleContext.discover(workspaceFolders.map((folder) => folder.uri));
    output.info(
      `bundle.discovery candidates=${discovery.candidates.length} failures=${discovery.failures.length}`,
    );
    const resolution = bundleContext.resolve(discovery);
    if (resolution.candidate !== undefined) {
      return selectCandidate(resolution.candidate);
    }

    if (resolution.reason === 'ambiguous') {
      const selected = await vscode.window.showQuickPick(
        bundleSelectionChoices(discovery.candidates, (candidate) => ({
          label: candidateLabel(candidate),
          description: vscode.workspace.asRelativePath(candidate.indexUri, false),
        })),
        {
          title: 'OKF: Select Bundle',
          placeHolder: 'Multiple OKF bundle roots were found',
          ignoreFocusOut: true,
        },
      );
      if (selected === undefined) {
        return undefined;
      }
      if (selected.choiceKind === 'candidate') {
        return selectCandidate(selected.candidate);
      }
      const explicit = await chooseExplicitBundleRoot(workspaceFolders[0]?.uri);
      return explicit === undefined ? undefined : selectCandidate(explicit);
    }

    const explicit = await chooseExplicitBundleRoot(workspaceFolders[0]?.uri);
    return explicit === undefined ? undefined : selectCandidate(explicit);
  };

  const selectWritableBundle = async (
    invokedResource?: vscode.Uri,
  ): Promise<SelectedBundle<vscode.Uri> | undefined> =>
    guardBundleWriteSelection(
      await selectBundle(invokedResource),
      port,
      vscodeUriCodec,
      async (problem) => {
        await ui.showError(problemsMessage('Write operation refused.', [problem]));
        output.warn(`workspace.write refused=true reason=${problem.code}`);
      },
    );

  const selectInitializationTarget = async (
    invokedResource: vscode.Uri | undefined,
  ): Promise<InitializationTarget<vscode.Uri> | undefined> => {
    if (invokedResource !== undefined) {
      const folder = vscode.workspace.getWorkspaceFolder(invokedResource);
      const stat = folder === undefined ? undefined : await port.stat(invokedResource);
      if (folder !== undefined && stat?.type === 'directory') {
        const unsafeDirectory = await inspectWorkspaceDirectoryChain(
          folder.uri,
          invokedResource,
          port,
          vscodeUriCodec,
        );
        if (unsafeDirectory !== undefined) {
          await ui.showError(
            `Workbench refused the initialization target. ${unsafeDirectory.message}`,
          );
          output.warn('workspace.initialization_target refused=true reason=unsafe-workspace-path');
          return undefined;
        }
        return {
          targetRootUri: invokedResource,
          workspaceSafetyRootUri: folder.uri,
          label: vscode.workspace.asRelativePath(invokedResource, false),
          suggestedBundleDirectory: 'knowledge',
        };
      }
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      await ui.showError('Open a workspace folder before initializing an OKF bundle.');
      return undefined;
    }
    const folder =
      folders.length === 1
        ? folders[0]
        : await vscode.window.showWorkspaceFolderPick({
            placeHolder: 'Choose the workspace folder that will contain the OKF bundle',
          });
    if (folder === undefined) {
      return undefined;
    }
    return {
      targetRootUri: folder.uri,
      workspaceSafetyRootUri: folder.uri,
      label: folder.name,
      suggestedBundleDirectory: 'knowledge',
    };
  };

  const selectInitializedBundle = (rootUri: vscode.Uri): void => {
    selectCandidate(candidateForRoot(rootUri));
  };

  const selectAgentIntegrationTarget = async (invokedResource?: vscode.Uri) => {
    const bundle = await selectWritableBundle(invokedResource);
    if (bundle === undefined) {
      return undefined;
    }
    const folder = vscode.workspace.getWorkspaceFolder(bundle.bundleRootUri);
    if (folder === undefined) {
      await ui.showError(
        'The selected bundle is not inside an open workspace folder. Select a workspace bundle and try again.',
      );
      return undefined;
    }
    const bundlePath = bundlePathWithinIntegrationRoot(folder.uri, bundle.bundleRootUri);
    if (bundlePath === undefined) {
      await ui.showError(
        'Workbench could not derive a safe bundle path relative to the workspace root.',
      );
      return undefined;
    }
    return {
      integrationRootUri: folder.uri,
      bundleRootUri: bundle.bundleRootUri,
      bundlePath,
      label: folder.name,
    };
  };

  const revalidateBundleWrite = async (bundleRootUri: vscode.Uri) => {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(bundleRootUri);
    if (workspaceFolder === undefined) {
      return {
        code: 'bundle-write-root-revalidation-failed',
        message: 'The selected bundle root is no longer inside an open workspace folder.',
        correctiveAction:
          'No files were written. Reopen the workspace folder and select the bundle again.',
      };
    }
    const access = await inspectBundleWriteAccess(
      bundleRootUri,
      port,
      vscodeUriCodec,
      workspaceFolder.uri,
    );
    return access.ok ? undefined : access.problem;
  };

  const workflowDependencies = {
    core,
    port,
    uris: vscodeUriCodec,
    applicator,
    ui,
    previewer,
    proposalDecisionController,
    workflowScheduler,
    isWorkspaceTrusted: () => vscode.workspace.isTrusted,
    captureWorkspaceFolderMembership: (workspaceSafetyRootUri: vscode.Uri) =>
      workspaceFolderMembership.capture(workspaceSafetyRootUri),
    revalidateBundleWrite,
  };
  const refreshAfterWrite = (outcome: CommandOutcome): void => {
    if (outcome.kind === 'applied' && selectedRuntimeSelection !== undefined) {
      runtime.requestFullRefresh();
      output.info(`workspace.write completed=${outcome.report.completed.length} refresh=requested`);
    }
  };

  const handlers: Record<OkfCommandId, CommandHandler> = {
    'okfWorkbench.initializeBundle': async (arguments_, proposalLease) => {
      const command = createInitializeBundleCommand(
        {
          ...workflowDependencies,
          selectInitializationTarget: () => selectInitializationTarget(uriArgument(arguments_[0])),
          selectInitializedBundle,
          now: () => new Date().toISOString(),
        },
        requireProposalLease(proposalLease),
      );
      const outcome = await command();
      refreshAfterWrite(outcome);
      return outcome;
    },
    'okfWorkbench.newConcept': async (arguments_, proposalLease) => {
      const command = createNewConceptCommand(
        {
          ...workflowDependencies,
          selectBundle: () => selectWritableBundle(uriArgument(arguments_[0])),
        },
        requireProposalLease(proposalLease),
      );
      const outcome = await command();
      refreshAfterWrite(outcome);
      return outcome;
    },
    'okfWorkbench.validateBundle': (arguments_) =>
      runReadCommand(async () => {
        const selection = await selectBundle(uriArgument(arguments_[0]));
        if (selection === undefined) {
          return { kind: 'cancelled' };
        }
        const root = vscodeUriCodec.serialize(selection.bundleRootUri);
        const acceptanceTicket = acceptanceSignals?.beginValidationCommand();
        replacePending('validation', {
          root,
          acceptanceRequestId: acceptanceTicket?.requestId,
        });
        try {
          runtime.requestFullRefresh();
        } catch (error: unknown) {
          discardPending('validation', 'schedule-failed');
          throw error;
        }
        output.info('bundle.validation requested=true');
        return acceptanceTicket;
      }),
    'okfWorkbench.regenerateIndexes': async (arguments_, proposalLease) => {
      const command = createRegenerateIndexesCommand(
        {
          ...workflowDependencies,
          selectBundle: () => selectWritableBundle(uriArgument(arguments_[0])),
        },
        requireProposalLease(proposalLease),
      );
      const outcome = await command();
      refreshAfterWrite(outcome);
      return outcome;
    },
    'okfWorkbench.openGraph': (arguments_) =>
      runReadCommand(async () => {
        const selection = await selectBundle(uriArgument(arguments_[0]));
        if (selection === undefined) {
          return { kind: 'cancelled' };
        }
        const root = vscodeUriCodec.serialize(selection.bundleRootUri);
        const snapshot = runtime.current;
        const acceptanceTicket = acceptanceSignals?.beginGraphOpenCommand();
        if (acceptanceTicket !== undefined) {
          replacePending('graph', {
            root,
            acceptanceRequestId: acceptanceTicket.requestId,
          });
          // Acceptance must observe a graph produced after this command, never a cached Webview ACK.
          try {
            runtime.requestFullRefresh();
          } catch (error: unknown) {
            discardPending('graph', 'schedule-failed');
            throw error;
          }
        } else if (snapshot?.context.rootUriString === root) {
          graphPanels.open(snapshot.graph, snapshot.nodeSources);
        } else {
          replacePending('graph', { root, acceptanceRequestId: undefined });
          try {
            runtime.requestFullRefresh();
          } catch (error: unknown) {
            discardPending('graph', 'schedule-failed');
            throw error;
          }
        }
        output.info('graph.open requested=true');
        return acceptanceTicket;
      }),
    'okfWorkbench.setupAgentIntegration': async (arguments_, proposalLease) => {
      const command = createSetupAgentIntegrationCommand(
        {
          ...workflowDependencies,
          selectAgentIntegrationTarget: () =>
            selectAgentIntegrationTarget(uriArgument(arguments_[0])),
        },
        requireProposalLease(proposalLease),
      );
      const outcome = await command();
      refreshAfterWrite(outcome);
      return outcome;
    },
  };

  const executeCommand = async (
    command: OkfCommandMetadata,
    arguments_: readonly unknown[],
  ): Promise<CommandResult> => {
    const commandId = command.id;
    output.info(`command.start id=${commandId}`);
    try {
      const result =
        command.workspaceAccess === 'write'
          ? await runPublicProposalCommand(
              workflowDependencies,
              async (proposalLease) => {
                const handlerResult = await handlers[commandId](arguments_, proposalLease);
                if (
                  handlerResult === undefined ||
                  handlerResult.kind === 'okf-acceptance-command'
                ) {
                  throw new Error('A write command returned a non-write command result.');
                }
                return handlerResult;
              },
              async (problem) => {
                output.warn(`command.refused id=${commandId} reason=${problem.code}`);
                // The packaged acceptance driver observes the structured result without a
                // notification obscuring its command boundary.
                if (acceptanceSignals !== undefined) {
                  return;
                }
                try {
                  await ui.showError(problemsMessage('Write operation refused.', [problem]));
                } catch (error: unknown) {
                  output.error(`notification.failed=true error_type=${errorKind(error)}`);
                }
              },
            )
          : await handlers[commandId](arguments_, undefined);
      output.info(`command.finish id=${commandId} outcome=${result?.kind ?? 'completed'}`);
      return result;
    } catch (error: unknown) {
      output.error(`command.finish id=${commandId} outcome=failed error_type=${errorKind(error)}`);
      try {
        await ui.showError(
          'OKF Workbench could not complete the command. Check workspace availability and permissions, then retry. See the OKF Workbench output for failure metadata.',
        );
      } catch (notificationError: unknown) {
        output.error(`notification.failed=true error_type=${errorKind(notificationError)}`);
      }
      return undefined;
    }
  };

  context.subscriptions.push(
    output,
    previewer,
    proposalDecisionController,
    graphPanels,
    runtime,
    workspaceFolderMembership,
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      workspaceFolderMembership.handleWorkspaceFoldersChanged({
        removed: event.removed.map((folder) => folder.uri),
      });
      const current = bundleContext.current;
      const selectedSafetyRootWasRemoved = activeWorkspaceSafetyRootWasRemoved(
        selectedRuntimeSelection,
        event.removed.map((folder) => vscodeUriCodec.serialize(folder.uri)),
      );
      if (current === undefined && selectedRuntimeSelection === undefined) {
        return;
      }
      const containingFolder =
        current === undefined ? undefined : vscode.workspace.getWorkspaceFolder(current.rootUri);
      if (current !== undefined && containingFolder !== undefined) {
        ensureRuntimeSelection(current, containingFolder.uri, selectedSafetyRootWasRemoved);
        return;
      }
      bundleContext.clear();
      failAllAcceptanceRequests('workspace-removed');
      runtime.clear();
      availabilityNotifications.clear();
      selectedRuntimeSelection = undefined;
      output.info('bundle.selection cleared=true reason=workspace-folder-change');
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(BUNDLED_CLI_CONFIGURATION)) {
        synchronizeBundledCliEnvironment();
      }
    }),
  );
  for (const command of OKF_COMMANDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command.id, (...arguments_: readonly unknown[]) =>
        executeCommand(command, arguments_),
      ),
    );
  }
  context.subscriptions.push(
    vscode.commands.registerCommand(REVIEW_PENDING_CHANGES_COMMAND, () =>
      proposalDecisionController.reviewPending(),
    ),
    vscode.commands.registerCommand(SHOW_CLI_STATUS_COMMAND, () =>
      vscode.window.showInformationMessage(
        bundledCliStatusMessage(bundledCli, bundledCliEnvironmentEnabled),
      ),
    ),
    vscode.commands.registerCommand(OPEN_CLI_TERMINAL_COMMAND, async () => {
      if (!bundledCli.available || !bundledCliEnvironmentEnabled) {
        await vscode.window.showWarningMessage(
          bundledCliStatusMessage(bundledCli, bundledCliEnvironmentEnabled),
        );
        return;
      }
      const terminal = vscode.window.createTerminal({ name: 'OKF CLI' });
      terminal.show();
      terminal.sendText('okf version', false);
    }),
  );

  if (acceptanceSignals !== undefined) {
    context.subscriptions.push({
      dispose: () => acceptanceSignals.dispose(),
    });
  }

  output.info(
    `extension.activate commands=${String(OKF_COMMANDS.length + 3)} core_commands=${String(OKF_COMMANDS.length)}`,
  );
  return acceptanceSignals?.api;
}

export function deactivate(): void {
  // Disposables are owned by the extension context.
}
