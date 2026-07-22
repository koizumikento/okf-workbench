import type {
  ApplyFailure,
  ApplyReport,
  ChangeSetProposal,
  OperationProblem,
} from '../../core/model/index.js';
import type {
  CommandOutcome,
  ProposalPresentation,
  ProposalPreviewSession,
  ProposalWorkflowDependencies,
} from './types.js';

function pathList(proposal: ChangeSetProposal): string {
  return proposal.changes.map((change) => `- ${change.relativePath}`).join('\n');
}

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
  readonly skipPreview?: boolean;
  /** Runs after approval and content preflight, immediately before the first proposed write. */
  readonly beforeApply?: () => Promise<OperationProblem | undefined>;
}

/** Preflight, preview, approve, recheck, and apply a complete immutable proposal. */
export async function runProposalWorkflow<TUri>(
  dependencies: ProposalWorkflowDependencies<TUri>,
  proposal: ChangeSetProposal,
  presentation: ProposalPresentation,
  options: RunProposalOptions = {},
): Promise<CommandOutcome> {
  const trustRefusal = await refuseUntrustedWorkspace(dependencies);
  if (trustRefusal !== undefined) {
    return trustRefusal;
  }

  if (proposal.changes.length === 0) {
    await dependencies.ui.showInformation(`${presentation.title}: no changes are required.`);
    return { kind: 'unchanged' };
  }

  const firstPreflight = await dependencies.applicator.preflight(proposal);
  if (!firstPreflight.ready) {
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
  try {
    if (options.skipPreview !== true) {
      previewSession = await dependencies.previewer.show(
        proposal,
        presentation,
        dependencies.port,
        dependencies.uris,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The preview could not be opened.';
    await dependencies.ui.showError(
      `No files were written because the preview could not be opened. ${message}`,
    );
    return { kind: 'failed' };
  }

  try {
    const approved = await dependencies.ui.confirm({
      title: presentation.title,
      detail: [...presentation.summary, 'Files:', pathList(proposal)].join('\n'),
      confirmLabel: 'Apply changes',
      modeless: true,
    });
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

    const applyProblem = await options.beforeApply?.();
    if (applyProblem !== undefined) {
      await dependencies.ui.showError(
        problemsMessage('No files were written because bundle compatibility changed.', [
          applyProblem,
        ]),
      );
      return { kind: 'refused', problems: [applyProblem] };
    }

    const report = await dependencies.applicator.apply(proposal);
    if (report.failed.length > 0) {
      await dependencies.ui.showError(partialFailureMessage(report));
      return { kind: 'failed', report };
    }

    await dependencies.ui.showInformation(
      `${presentation.title}: wrote ${report.completed.length} file${report.completed.length === 1 ? '' : 's'}.`,
    );
    return { kind: 'applied', report };
  } finally {
    previewSession?.dispose();
  }
}
