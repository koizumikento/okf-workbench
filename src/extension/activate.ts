import * as vscode from 'vscode';

import type { GraphRenderFailureReason } from '../shared/protocol/index.js';
import { bundlePathWithinIntegrationRoot } from './composition/bundle-path.js';
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
  untrustedWorkspaceProblem,
  VscodeCommandUi,
  type CommandOutcome,
  type InitializationTarget,
  type SelectedBundle,
} from './commands/index.js';
import { OKF_COMMANDS, type OkfCommandId } from './commands/ids.js';
import { VscodeProposalPreviewer } from './preview/index.js';
import {
  BUNDLE_UNAVAILABLE_NOTIFICATION,
  RuntimeAvailabilityNotificationState,
} from './runtimeAvailabilityNotifications.js';
import {
  createVscodeBundleRuntime,
  type BundleRuntimeContext,
  type BundleRuntimeSnapshot,
} from './runtime/index.js';
import {
  createAcceptanceCompletionSignals,
  type OkfWorkbenchAcceptanceApi,
} from './runtime/acceptanceSignals.js';
import { VscodeGraphPanelService } from './webview/index.js';
import {
  BundleContextService,
  isUriContained,
  ProposalApplicator,
  vscodeUriCodec,
  VscodeWorkspacePort,
  type BundleCandidate,
} from './workspace/index.js';

const OUTPUT_CHANNEL_NAME = 'OKF Workbench';

type CommandResult = CommandOutcome | undefined;
type CommandHandler = (...arguments_: readonly unknown[]) => Promise<CommandResult>;

interface PendingRuntimeActions {
  graphRoot?: string;
  validationRoot?: string;
}

const WRITE_COMMAND_IDS: ReadonlySet<OkfCommandId> = new Set([
  'okfWorkbench.initializeBundle',
  'okfWorkbench.newConcept',
  'okfWorkbench.regenerateIndexes',
  'okfWorkbench.setupAgentIntegration',
]);

function errorKind(error: unknown): string {
  return error instanceof Error && error.name.length > 0 ? error.name : 'UnknownError';
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
  const acceptanceSignals = createAcceptanceCompletionSignals(process.env['OKF_ACCEPTANCE_DRIVER']);
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME, { log: true });
  const ui = new VscodeCommandUi();
  const previewer = new VscodeProposalPreviewer();
  const port = new VscodeWorkspacePort();
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
  let selectedRuntimeRoot: string | undefined;

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

  const onRuntimePublish = (snapshot: BundleRuntimeSnapshot<vscode.Uri>): void => {
    const root = snapshot.context.rootUriString;
    if (availabilityNotifications.recordPublication(root)) {
      output.info('bundle.refresh availability=recovered');
    }
    try {
      if (pending.graphRoot === root) {
        delete pending.graphRoot;
        graphPanels.open(snapshot.graph, snapshot.nodeSources);
      } else {
        graphPanels.replaceCurrent(snapshot.graph, snapshot.nodeSources);
      }
    } catch (error: unknown) {
      output.error(`webview.open failed=true error_type=${errorKind(error)}`);
      showBackgroundError(
        'OKF Workbench refreshed the bundle, but could not open the graph. Close any stale graph tab and run OKF: Open 3D Graph again.',
      );
    }

    if (pending.validationRoot === root) {
      delete pending.validationRoot;
      const counts = findingCounts(snapshot);
      showBackgroundInformation(
        `OKF validation complete: ${counts.errors} error(s), ${counts.warnings} warning(s), and ${counts.information} information item(s). Review OKF Conformance, Curation, and Compatibility entries in Problems.`,
      );
    }

    output.info(
      `bundle.refresh revision=${snapshot.revision} concepts=${snapshot.graph.statistics.conceptCount} findings=${snapshot.findings.length}`,
    );
    acceptanceSignals?.recordRuntimePublication(snapshot);
  };
  const onRuntimeError = (
    error: unknown,
    runtimeContext: BundleRuntimeContext<vscode.Uri>,
  ): void => {
    const pendingGraphFailed = pending.graphRoot === runtimeContext.rootUriString;
    const pendingValidationFailed = pending.validationRoot === runtimeContext.rootUriString;
    if (pendingGraphFailed) {
      delete pending.graphRoot;
    }
    if (pendingValidationFailed) {
      delete pending.validationRoot;
    }
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
    onPublish: onRuntimePublish,
    onClear: () => graphPanels.closeCurrent(),
    onError: onRuntimeError,
  });

  const ensureRuntimeSelection = (candidate: BundleCandidate<vscode.Uri>): void => {
    if (selectedRuntimeRoot === candidate.rootUriString) {
      return;
    }
    if (pending.graphRoot !== candidate.rootUriString) {
      delete pending.graphRoot;
    }
    if (pending.validationRoot !== candidate.rootUriString) {
      delete pending.validationRoot;
    }
    selectedRuntimeRoot = candidate.rootUriString;
    availabilityNotifications.select(candidate.rootUriString);
    runtime.select(candidate.rootUri);
    output.info('bundle.selection changed=true');
  };

  const selectCandidate = (candidate: BundleCandidate<vscode.Uri>): SelectedBundle<vscode.Uri> => {
    bundleContext.select(candidate);
    ensureRuntimeSelection(candidate);
    return { bundleRootUri: candidate.rootUri, label: candidateLabel(candidate) };
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
    if (vscode.workspace.getWorkspaceFolder(rootUri) === undefined) {
      await ui.showError('Select a bundle directory inside an open workspace folder.');
      return undefined;
    }
    const inspection = await inspectExplicitBundleRoot(rootUri, port, vscodeUriCodec);
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
        discovery.candidates.map((candidate) => ({
          label: candidateLabel(candidate),
          description: vscode.workspace.asRelativePath(candidate.indexUri, false),
          candidate,
        })),
        {
          title: 'OKF: Select Bundle',
          placeHolder: 'Multiple OKF bundle roots were found',
          ignoreFocusOut: true,
        },
      );
      return selected === undefined ? undefined : selectCandidate(selected.candidate);
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
        return {
          targetRootUri: invokedResource,
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
    const access = await inspectBundleWriteAccess(bundleRootUri, port, vscodeUriCodec);
    return access.ok ? undefined : access.problem;
  };

  const workflowDependencies = {
    port,
    uris: vscodeUriCodec,
    applicator,
    ui,
    previewer,
    isWorkspaceTrusted: () => vscode.workspace.isTrusted,
    revalidateBundleWrite,
  };
  const refreshAfterWrite = (outcome: CommandOutcome): void => {
    if (outcome.kind === 'applied' && selectedRuntimeRoot !== undefined) {
      runtime.requestFullRefresh();
      output.info(`workspace.write completed=${outcome.report.completed.length} refresh=requested`);
    }
  };

  const handlers: Record<OkfCommandId, CommandHandler> = {
    'okfWorkbench.initializeBundle': async (...arguments_) => {
      const command = createInitializeBundleCommand({
        ...workflowDependencies,
        selectInitializationTarget: () => selectInitializationTarget(uriArgument(arguments_[0])),
        selectInitializedBundle,
        now: () => new Date().toISOString(),
      });
      const outcome = await command();
      refreshAfterWrite(outcome);
      return outcome;
    },
    'okfWorkbench.newConcept': async (...arguments_) => {
      const command = createNewConceptCommand({
        ...workflowDependencies,
        selectBundle: () => selectWritableBundle(uriArgument(arguments_[0])),
      });
      const outcome = await command();
      refreshAfterWrite(outcome);
      return outcome;
    },
    'okfWorkbench.validateBundle': async (...arguments_) => {
      const selection = await selectBundle(uriArgument(arguments_[0]));
      if (selection === undefined) {
        return { kind: 'cancelled' };
      }
      const root = vscodeUriCodec.serialize(selection.bundleRootUri);
      pending.validationRoot = root;
      runtime.requestFullRefresh();
      output.info('bundle.validation requested=true');
      return undefined;
    },
    'okfWorkbench.regenerateIndexes': async (...arguments_) => {
      const command = createRegenerateIndexesCommand({
        ...workflowDependencies,
        selectBundle: () => selectWritableBundle(uriArgument(arguments_[0])),
      });
      const outcome = await command();
      refreshAfterWrite(outcome);
      return outcome;
    },
    'okfWorkbench.openGraph': async (...arguments_) => {
      const selection = await selectBundle(uriArgument(arguments_[0]));
      if (selection === undefined) {
        return { kind: 'cancelled' };
      }
      const root = vscodeUriCodec.serialize(selection.bundleRootUri);
      const snapshot = runtime.current;
      if (snapshot?.context.rootUriString === root) {
        graphPanels.open(snapshot.graph, snapshot.nodeSources);
      } else {
        pending.graphRoot = root;
        runtime.requestFullRefresh();
      }
      output.info('graph.open requested=true');
      return undefined;
    },
    'okfWorkbench.setupAgentIntegration': async (...arguments_) => {
      const command = createSetupAgentIntegrationCommand({
        ...workflowDependencies,
        selectAgentIntegrationTarget: () =>
          selectAgentIntegrationTarget(uriArgument(arguments_[0])),
      });
      const outcome = await command();
      refreshAfterWrite(outcome);
      return outcome;
    },
  };

  const executeCommand = async (
    commandId: OkfCommandId,
    arguments_: readonly unknown[],
  ): Promise<CommandResult> => {
    output.info(`command.start id=${commandId}`);
    if (WRITE_COMMAND_IDS.has(commandId) && !vscode.workspace.isTrusted) {
      const problem = untrustedWorkspaceProblem();
      output.warn(`command.finish id=${commandId} outcome=refused reason=workspace-untrusted`);
      // The packaged acceptance driver must observe the refusal result without a modal obscuring
      // the command boundary. Ordinary sessions still receive the user-facing explanation.
      if (acceptanceSignals === undefined) {
        void ui
          .showError(problemsMessage('Write operation refused.', [problem]))
          .catch((error: unknown) => {
            output.error(`notification.failed=true error_type=${errorKind(error)}`);
          });
      }
      return { kind: 'refused', problems: [problem] };
    }
    try {
      const result = await handlers[commandId](...arguments_);
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

  context.subscriptions.push(output, previewer, graphPanels, runtime);
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const current = bundleContext.current;
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (
        current === undefined ||
        folders.some((folder) => isUriContained(folder.uri, current.rootUri))
      ) {
        return;
      }
      bundleContext.clear();
      runtime.clear();
      availabilityNotifications.clear();
      selectedRuntimeRoot = undefined;
      delete pending.graphRoot;
      delete pending.validationRoot;
      output.info('bundle.selection cleared=true reason=workspace-folder-change');
    }),
  );
  for (const command of OKF_COMMANDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command.id, (...arguments_: readonly unknown[]) =>
        executeCommand(command.id, arguments_),
      ),
    );
  }

  output.info(`extension.activate commands=${OKF_COMMANDS.length}`);
  return acceptanceSignals?.api;
}

export function deactivate(): void {
  // Disposables are owned by the extension context.
}
