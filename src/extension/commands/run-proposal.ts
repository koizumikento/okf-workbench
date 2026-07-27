import type {
  ApplyFailure,
  ApplyReport,
  ChangeSetProposal,
  OperationProblem,
} from '../../core/model/index.js';
import { inspectProposalPreviewFeasibility } from '../preview/proposal-preview-budget.js';
import { ProposalWorkflowBusyError } from './proposal-workflow-scheduler.js';
import type {
  CommandOutcome,
  ConfirmationOptions,
  ProposalPresentation,
  ProposalWorkflowLease,
  ProposalPreviewSession,
  ProposalWorkflowDependencies,
} from './types.js';

function failuresMessage(prefix: string, failures: readonly ApplyFailure[]): string {
  const details = failures.map((item) => {
    const next = item.retryable
      ? 'Refresh the preview and try again.'
      : 'Check workspace permissions or repair the named file before retrying.';
    return `- ${item.targetUri}: ${item.message} ${next}`;
  });
  return `${prefix}\n${details.join('\n')}`;
}

function partialFailureMessage(report: ApplyReport): string {
  const completed = report.completed.length === 0 ? '(none)' : report.completed.join('\n- ');
  const failed = report.failed.map((item) => `${item.targetUri}: ${item.message}`).join('\n- ');
  const untouched = report.untouched.length === 0 ? '(none)' : report.untouched.join('\n- ');
  return [
    'The operation stopped after a workspace write failed.',
    `Completed:\n- ${completed}`,
    `Failed:\n- ${failed}`,
    `Untouched:\n- ${untouched}`,
    'Repair the failed target, inspect completed files, then refresh the preview before retrying.',
  ].join('\n\n');
}

function showInformationWithoutBlocking<TUri>(
  dependencies: ProposalWorkflowDependencies<TUri>,
  message: string,
): void {
  void dependencies.ui.showInformation(message).catch(() => undefined);
}

function previewUnavailableProblem(
  previewSession: ProposalPreviewSession,
): OperationProblem | undefined {
  try {
    previewSession.assertActive();
    return undefined;
  } catch (error) {
    return {
      code: 'preview-unavailable',
      message:
        error instanceof Error
          ? error.message
          : 'The approved proposal preview is no longer available.',
      correctiveAction: 'Run the command again and approve its new preview before writing.',
    };
  }
}

async function reportUnavailablePreview<TUri>(
  dependencies: ProposalWorkflowDependencies<TUri>,
  problem: OperationProblem,
): Promise<CommandOutcome> {
  await dependencies.ui.showError(
    problemsMessage('No files were written because the approved preview closed.', [problem]),
  );
  return { kind: 'refused', problems: [problem] };
}

async function reportUnavailableWorkspaceFolder<TUri>(
  dependencies: ProposalWorkflowDependencies<TUri>,
  problem: OperationProblem,
): Promise<CommandOutcome> {
  await dependencies.ui.showError(
    problemsMessage('No files were written because the selected workspace folder changed.', [
      problem,
    ]),
  );
  return { kind: 'refused', problems: [problem] };
}

function invalidWorkspaceFolderProblem(error: unknown, workspaceSafetyRootUri: string) {
  return {
    code: 'workspace-folder-unavailable',
    message:
      error instanceof Error
        ? `The proposal's workspace safety root is unavailable: ${error.message}`
        : "The proposal's workspace safety root is unavailable.",
    correctiveAction:
      'Open the intended workspace folder and run the command again so a new proposal can be reviewed.',
    uri: workspaceSafetyRootUri,
  } satisfies OperationProblem;
}

export function problemsMessage(heading: string, problems: readonly OperationProblem[]): string {
  return `${heading}\n${problems
    .map((problem) => {
      const correction =
        problem.correctiveAction === undefined ? '' : ` ${problem.correctiveAction}`;
      return `- ${problem.message}${correction}`;
    })
    .join('\n')}`;
}

export function untrustedWorkspaceProblem(): OperationProblem {
  return {
    code: 'workspace-untrusted',
    message: 'OKF Workbench will not write files while this workspace is untrusted.',
    correctiveAction: 'Trust the workspace, review its contents, and run the command again.',
  };
}

export async function refuseUntrustedWorkspace<TUri>(
  dependencies: ProposalWorkflowDependencies<TUri>,
): Promise<CommandOutcome | undefined> {
  if (dependencies.isWorkspaceTrusted()) {
    return undefined;
  }
  const problem = untrustedWorkspaceProblem();
  await dependencies.ui.showError(problemsMessage('Write operation refused.', [problem]));
  return { kind: 'refused', problems: [problem] };
}

export interface RunProposalOptions {
  readonly confirmLabel?: string;
  /** Runs after approval and content preflight, immediately before the first proposed write. */
  readonly beforeApply?: () => Promise<OperationProblem | undefined>;
}

export function proposalWorkflowBusyProblem(): OperationProblem {
  return {
    code: 'proposal-workflow-busy',
    message: 'Another OKF write workflow is already awaiting input or applying changes.',
    correctiveAction: 'Finish or cancel the active workflow, then run this command again.',
  };
}

/** Acquires the public gate or continues the exact active lease without nested admission. */
export async function runProposalCommand<TUri>(
  dependencies: ProposalWorkflowDependencies<TUri>,
  command: (lease: ProposalWorkflowLease) => Promise<CommandOutcome>,
  admittedLease?: ProposalWorkflowLease,
): Promise<CommandOutcome> {
  if (admittedLease !== undefined) {
    dependencies.workflowScheduler.assertActive(admittedLease);
    return command(admittedLease);
  }
  try {
    return await dependencies.workflowScheduler.runExclusive(command);
  } catch (error) {
    if (!(error instanceof ProposalWorkflowBusyError)) {
      throw error;
    }
    const problem = proposalWorkflowBusyProblem();
    // One modeless warning may remain visible; every refused concurrent command still settles now.
    if (error.shouldNotify) {
      const message = problemsMessage('Write operation is already in progress.', [problem]);
      const notification =
        dependencies.proposalDecisionController === undefined
          ? dependencies.ui.showWarning(message)
          : dependencies.proposalDecisionController.showBusyRecovery(message);
      void notification.catch(() => undefined);
    }
    return { kind: 'refused', problems: [problem] };
  }
}

/**
 * Owns the registered write-command boundary. The lease is acquired before the activation layer
 * checks trust or invokes a factory, so rejected command callbacks are never queued behind it.
 */
export async function runPublicProposalCommand<TUri>(
  dependencies: ProposalWorkflowDependencies<TUri>,
  command: (lease: ProposalWorkflowLease) => Promise<CommandOutcome>,
  reportUntrustedWorkspace: (problem: OperationProblem) => void | Promise<void>,
): Promise<CommandOutcome> {
  return runProposalCommand(dependencies, async (lease) => {
    if (!dependencies.isWorkspaceTrusted()) {
      const problem = untrustedWorkspaceProblem();
      try {
        await reportUntrustedWorkspace(problem);
      } catch {
        // Notification failures cannot turn a structured trust refusal into a queued or failed run.
      }
      return { kind: 'refused', problems: [problem] };
    }
    return command(lease);
  });
}

async function runExclusiveProposalWorkflow<TUri>(
  dependencies: ProposalWorkflowDependencies<TUri>,
  proposal: ChangeSetProposal,
  presentation: ProposalPresentation,
  options: RunProposalOptions,
): Promise<CommandOutcome> {
  const trustRefusal = await refuseUntrustedWorkspace(dependencies);
  if (trustRefusal !== undefined) {
    return trustRefusal;
  }

  if (proposal.changes.length === 0) {
    showInformationWithoutBlocking(dependencies, `${presentation.title}: no changes are required.`);
    return { kind: 'unchanged' };
  }

  let workspaceMembership;
  try {
    const workspaceSafetyRoot = dependencies.uris.parse(proposal.workspaceSafetyRootUri);
    workspaceMembership = dependencies.captureWorkspaceFolderMembership(workspaceSafetyRoot);
  } catch (error) {
    const problem = invalidWorkspaceFolderProblem(error, proposal.workspaceSafetyRootUri);
    return reportUnavailableWorkspaceFolder(dependencies, problem);
  }

  const initialWorkspaceProblem = workspaceMembership.currentProblem();
  if (initialWorkspaceProblem !== undefined) {
    workspaceMembership.dispose();
    return reportUnavailableWorkspaceFolder(dependencies, initialWorkspaceProblem);
  }

  const previewFeasibility = inspectProposalPreviewFeasibility(proposal, presentation);
  if (!previewFeasibility.ready) {
    workspaceMembership.dispose();
    await dependencies.ui.showError(
      problemsMessage('No files were written because preview limits were exceeded.', [
        previewFeasibility.problem,
      ]),
    );
    return { kind: 'refused', problems: [previewFeasibility.problem] };
  }

  let firstPreflight;
  try {
    firstPreflight = await dependencies.applicator.preflight(proposal);
  } catch (error) {
    workspaceMembership.dispose();
    throw error;
  }
  if (!firstPreflight.ready) {
    workspaceMembership.dispose();
    await dependencies.ui.showError(
      failuresMessage(
        'No files were written because preflight checks failed.',
        firstPreflight.failed,
      ),
    );
    return {
      kind: 'failed',
      report: {
        completed: [],
        failed: firstPreflight.failed,
        untouched: proposal.changes
          .map((change) => change.targetUri)
          .filter(
            (target) => !firstPreflight.failed.some((failure) => failure.targetUri === target),
          ),
      },
    };
  }

  let previewSession: ProposalPreviewSession | undefined;
  let workspaceInvalidationSubscription: { dispose(): void } | undefined;
  try {
    previewSession = await dependencies.previewer.show(
      proposal,
      presentation,
      dependencies.port,
      dependencies.uris,
    );
    workspaceInvalidationSubscription = workspaceMembership.onDidInvalidate(() => {
      void previewSession?.dispose();
    });
  } catch (error) {
    await previewSession?.dispose();
    workspaceMembership.dispose();
    const message = error instanceof Error ? error.message : 'The preview could not be opened.';
    await dependencies.ui.showError(
      `No files were written because the preview could not be opened. ${message}`,
    );
    return { kind: 'failed' };
  }

  try {
    const workspaceProblemBeforeConfirmation = workspaceMembership.currentProblem();
    if (workspaceProblemBeforeConfirmation !== undefined) {
      return reportUnavailableWorkspaceFolder(dependencies, workspaceProblemBeforeConfirmation);
    }
    const problemBeforeConfirmation = previewUnavailableProblem(previewSession);
    if (problemBeforeConfirmation !== undefined) {
      const outcome = await reportUnavailablePreview(dependencies, problemBeforeConfirmation);
      return outcome;
    }
    const previewIdentity = previewSession.identity;
    const confirmation = {
      title: presentation.title,
      detail: [
        ...presentation.summary,
        `${proposal.changes.length} proposed file${proposal.changes.length === 1 ? '' : 's'}; the complete path list is in this preview's summary tab.`,
      ].join('\n'),
      confirmLabel: options.confirmLabel ?? 'Apply changes',
      previewIdentity,
      modeless: true,
    } satisfies ConfirmationOptions;
    const approved =
      dependencies.proposalDecisionController === undefined
        ? await dependencies.ui.confirm(confirmation)
        : await dependencies.proposalDecisionController.request(confirmation, previewSession);
    const workspaceProblemAfterConfirmation = workspaceMembership.currentProblem();
    if (workspaceProblemAfterConfirmation !== undefined) {
      return reportUnavailableWorkspaceFolder(dependencies, workspaceProblemAfterConfirmation);
    }
    const problemAfterConfirmation = previewUnavailableProblem(previewSession);
    if (problemAfterConfirmation !== undefined) {
      const outcome = await reportUnavailablePreview(dependencies, problemAfterConfirmation);
      return outcome;
    }
    if (!approved) {
      return { kind: 'cancelled' };
    }

    const trustAfterPreview = await refuseUntrustedWorkspace(dependencies);
    if (trustAfterPreview !== undefined) {
      return trustAfterPreview;
    }

    const secondPreflight = await dependencies.applicator.preflight(proposal);
    if (!secondPreflight.ready) {
      await dependencies.ui.showError(
        failuresMessage(
          'No files were written because workspace content changed after preview.',
          secondPreflight.failed,
        ),
      );
      return {
        kind: 'failed',
        report: {
          completed: [],
          failed: secondPreflight.failed,
          untouched: proposal.changes
            .map((change) => change.targetUri)
            .filter(
              (target) => !secondPreflight.failed.some((failure) => failure.targetUri === target),
            ),
        },
      };
    }

    const workspaceProblemAfterPreflight = workspaceMembership.currentProblem();
    if (workspaceProblemAfterPreflight !== undefined) {
      return reportUnavailableWorkspaceFolder(dependencies, workspaceProblemAfterPreflight);
    }
    const problemAfterPreflight = previewUnavailableProblem(previewSession);
    if (problemAfterPreflight !== undefined) {
      const outcome = await reportUnavailablePreview(dependencies, problemAfterPreflight);
      return outcome;
    }

    const writeAuthorizationGuard = (): OperationProblem | undefined =>
      workspaceMembership.currentProblem() ?? previewUnavailableProblem(previewSession);
    const applyResult = await dependencies.applicator.applyGuarded(
      proposal,
      async () => {
        const unavailableBeforeGuard = writeAuthorizationGuard();
        if (unavailableBeforeGuard !== undefined) {
          return unavailableBeforeGuard;
        }
        const compatibilityProblem = await options.beforeApply?.();
        return writeAuthorizationGuard() ?? compatibilityProblem;
      },
      writeAuthorizationGuard,
    );
    if (applyResult.kind === 'refused') {
      const heading =
        applyResult.problem.code === 'preview-unavailable'
          ? 'No files were written because the approved preview closed.'
          : applyResult.problem.code === 'workspace-folder-unavailable'
            ? 'No files were written because the selected workspace folder changed.'
            : 'No files were written because bundle compatibility changed.';
      await dependencies.ui.showError(problemsMessage(heading, [applyResult.problem]));
      return { kind: 'refused', problems: [applyResult.problem] };
    }

    const report = applyResult.report;
    if (report.failed.length > 0) {
      await dependencies.ui.showError(partialFailureMessage(report));
      return { kind: 'failed', report };
    }

    showInformationWithoutBlocking(
      dependencies,
      `${presentation.title}: wrote ${report.completed.length} file${report.completed.length === 1 ? '' : 's'}.`,
    );
    return { kind: 'applied', report };
  } finally {
    workspaceInvalidationSubscription?.dispose();
    await previewSession?.dispose();
    workspaceMembership.dispose();
  }
}

/** Runs one immutable proposal while its public command owns the extension-wide workflow gate. */
export async function runProposalWorkflow<TUri>(
  dependencies: ProposalWorkflowDependencies<TUri>,
  lease: ProposalWorkflowLease,
  proposal: ChangeSetProposal,
  presentation: ProposalPresentation,
  options: RunProposalOptions = {},
): Promise<CommandOutcome> {
  dependencies.workflowScheduler.assertActive(lease);
  return runExclusiveProposalWorkflow(dependencies, proposal, presentation, options);
}
