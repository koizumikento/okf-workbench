import type { OperationProblem } from '../../core/model/index.js';
import type { ParseBundleInput } from '../../core/parser/index.js';
import { loadBundle } from '../runtime/loadBundle.js';
import { MAX_PROPOSAL_PREVIEW_CHANGES } from '../preview/proposal-preview-budget.js';
import { providerMigrationPlanToProposal } from './proposals.js';
import {
  problemsMessage,
  refuseUntrustedWorkspace,
  runProposalCommand,
  runProposalWorkflow,
} from './run-proposal.js';
import type {
  CommandOutcome,
  ProposalWorkflowDependencies,
  ProposalWorkflowLease,
  SelectBundle,
} from './types.js';

export interface MigrateBundleCommandDependencies<TUri> extends ProposalWorkflowDependencies<TUri> {
  readonly selectBundle: SelectBundle<TUri>;
}

function problem(code: string, message: string, correctiveAction: string): OperationProblem {
  return { code, message, correctiveAction };
}

function actorProblem(value: string): string | undefined {
  const token = (candidate: string): boolean =>
    candidate.length > 0 && candidate.length <= 256 && /^[A-Za-z0-9._/@:-]+$/u.test(candidate);
  const prefix = value.startsWith('human:')
    ? value.slice('human:'.length)
    : value.startsWith('process:')
      ? value.slice('process:'.length)
      : undefined;
  const slash = value.indexOf('/');
  const valid =
    (prefix !== undefined && token(prefix)) ||
    (slash > 0 &&
      slash === value.lastIndexOf('/') &&
      token(value.slice(0, slash)) &&
      token(value.slice(slash + 1)));
  return valid && token(value)
    ? undefined
    : 'Use human:<id>, process:<id>, or <producer>/<version>.';
}

export function createMigrateBundleCommand<TUri>(
  dependencies: MigrateBundleCommandDependencies<TUri>,
  admittedLease?: ProposalWorkflowLease,
): () => Promise<CommandOutcome> {
  return async () =>
    runProposalCommand(
      dependencies,
      async (lease) => {
        const trustRefusal = await refuseUntrustedWorkspace(dependencies);
        if (trustRefusal !== undefined) return trustRefusal;

        const selection = await dependencies.selectBundle();
        if (selection === undefined) return { kind: 'cancelled' };

        const actor = await dependencies.ui.input({
          title: 'OKF: Migrate Bundle to v0.2',
          prompt: 'Identify the producer recorded in generated.by',
          placeHolder: 'human:alice or okf-workbench/0.2.1',
          validate: actorProblem,
        });
        if (actor === undefined) return { kind: 'cancelled' };

        let loaded;
        try {
          loaded = await loadBundle(
            dependencies.port,
            dependencies.uris,
            selection.bundleRootUri,
            selection.workspaceSafetyRootUri,
          );
        } catch (error) {
          const problems = [
            problem(
              'migration-source-load-failed',
              error instanceof Error
                ? error.message
                : 'The selected bundle could not be read safely.',
              'Check workspace availability and permissions, then run migration again.',
            ),
          ];
          await dependencies.ui.showError(
            problemsMessage('Migration could not be planned safely.', problems),
          );
          return { kind: 'refused', problems };
        }
        if (loaded.failures.length > 0) {
          const problems = loaded.failures.map((failure) =>
            problem(
              'migration-source-read-failed',
              `${failure.bundlePath}: ${failure.message}`,
              'Repair or restore access to the file before migrating the bundle.',
            ),
          );
          await dependencies.ui.showError(
            problemsMessage('Migration could not be planned safely.', problems),
          );
          return { kind: 'refused', problems };
        }
        if (dependencies.core === undefined) {
          await dependencies.ui.showError(
            'Migration requires the packaged deterministic core. Reload the Extension Host and try again.',
          );
          return { kind: 'failed' };
        }

        const snapshots = new Map<
          string,
          { readonly sha256: string; readonly byteLength: number }
        >();
        for (const document of loaded.documents) {
          if (!(document.content instanceof Uint8Array) || document.contentHash === undefined) {
            const problems = [
              problem(
                'migration-source-snapshot-failed',
                `${document.bundlePath}: the workspace adapter did not retain the original provider bytes and hash.`,
                'Refresh the selected bundle, then run migration again.',
              ),
            ];
            await dependencies.ui.showError(
              problemsMessage('Migration could not be planned safely.', problems),
            );
            return { kind: 'refused', problems };
          }
          snapshots.set(document.bundlePath, {
            sha256: document.contentHash,
            byteLength: document.content.byteLength,
          });
        }

        const input: ParseBundleInput = {
          rootUri: dependencies.uris.serialize(selection.bundleRootUri),
          revision: 0,
          documents: loaded.documents,
        };
        let plan;
        try {
          plan = dependencies.core.migrate(input, actor);
        } catch (error) {
          await dependencies.ui.showError(
            `Migration could not be planned by the deterministic core. ${error instanceof Error ? error.message : 'The core rejected the request.'}`,
          );
          return { kind: 'failed' };
        }
        if (plan.files.length > MAX_PROPOSAL_PREVIEW_CHANGES) {
          const problems = [
            problem(
              'preview-limit',
              `Migration would change ${String(plan.files.length)} files, exceeding the complete-proposal limit of ${String(MAX_PROPOSAL_PREVIEW_CHANGES)}.`,
              'Split the bundle so every migration can be reviewed as one complete proposal.',
            ),
          ];
          await dependencies.ui.showError(
            problemsMessage('Migration could not be prepared safely.', problems),
          );
          return { kind: 'refused', problems };
        }

        const manualCount = plan.documents.filter((document) => document.manualFollowUp).length;
        if (plan.files.length === 0) {
          await (manualCount > 0
            ? dependencies.ui.showWarning(
                `No automatic migration changes are available. ${String(manualCount)} document(s) need manual follow-up; their Citations content was retained.`,
              )
            : dependencies.ui.showInformation(
                'This bundle is already at OKF v0.2 and needs no deterministic migration changes.',
              ));
          return { kind: 'unchanged' };
        }
        if (manualCount > 0) {
          await dependencies.ui.showWarning(
            `${String(manualCount)} document(s) contain ambiguous legacy fields or Citations and will need manual follow-up. Their content will not be removed.`,
          );
        }

        const proposal = providerMigrationPlanToProposal(
          selection.bundleRootUri,
          plan,
          dependencies.uris,
          {
            workspaceSafetyRoot: selection.workspaceSafetyRootUri,
            expectedContentSnapshots: snapshots,
          },
        );
        const revalidateBundleWrite = dependencies.revalidateBundleWrite;
        return runProposalWorkflow(
          dependencies,
          lease,
          proposal,
          {
            title: 'Migrate OKF bundle to v0.2',
            summary: [
              `Bundle: ${selection.label ?? dependencies.uris.serialize(selection.bundleRootUri)}`,
              `Version: ${plan.fromVersion} → ${plan.toVersion}`,
              `Producer: ${actor}`,
              `Automatic changes: ${String(plan.files.length)}`,
              `Manual follow-up: ${String(manualCount)}`,
            ],
          },
          revalidateBundleWrite === undefined
            ? { previewMode: 'existing-file-changes' }
            : {
                previewMode: 'existing-file-changes',
                beforeApply: () => revalidateBundleWrite(selection.bundleRootUri),
              },
        );
      },
      admittedLease,
    );
}
