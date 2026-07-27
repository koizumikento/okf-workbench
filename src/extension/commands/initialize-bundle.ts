import {
  BUNDLE_PRESETS,
  normalizeBundleDirectory,
  normalizeTemplateOutputPath,
  type BundlePreset,
} from '../../core/templates/index.js';
import { bundleFilesToProposal } from './proposals.js';
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
  SelectInitializationTarget,
  SelectionItem,
} from './types.js';

const PRESET_ITEMS: readonly SelectionItem<BundlePreset>[] = [
  {
    value: 'minimal',
    label: 'Minimal',
    description: 'Create only the root index.md.',
  },
  {
    value: 'software-project',
    label: 'Software Project',
    description: 'Create project, architecture, decision, and playbook starters.',
  },
  {
    value: 'data-analytics',
    label: 'Data & Analytics',
    description: 'Create dataset, metric, and data-quality starters.',
  },
];

export interface InitializeBundleCommandDependencies<
  TUri,
> extends ProposalWorkflowDependencies<TUri> {
  readonly selectInitializationTarget: SelectInitializationTarget<TUri>;
  readonly selectInitializedBundle: (bundleRootUri: TUri) => void | Promise<void>;
  readonly now: () => string;
}

function presetLabel(preset: BundlePreset): string {
  return PRESET_ITEMS.find((item) => item.value === preset)?.label ?? preset;
}

export function createInitializeBundleCommand<TUri>(
  dependencies: InitializeBundleCommandDependencies<TUri>,
  admittedLease?: ProposalWorkflowLease,
): () => Promise<CommandOutcome> {
  return async () =>
    runProposalCommand(
      dependencies,
      async (lease) => {
        const trustRefusal = await refuseUntrustedWorkspace(dependencies);
        if (trustRefusal !== undefined) {
          return trustRefusal;
        }

        const target = await dependencies.selectInitializationTarget();
        if (target === undefined) {
          return { kind: 'cancelled' };
        }

        const directoryInput = await dependencies.ui.input({
          title: 'OKF: Initialize Bundle',
          prompt: 'Bundle directory relative to the selected workspace target',
          value: target.suggestedBundleDirectory,
          placeHolder: 'knowledge',
          validate(value) {
            const result = normalizeBundleDirectory(value);
            return result.ok ? undefined : result.problems[0]?.message;
          },
        });
        if (directoryInput === undefined) {
          return { kind: 'cancelled' };
        }

        const normalizedDirectory = normalizeBundleDirectory(directoryInput);
        if (!normalizedDirectory.ok) {
          await dependencies.ui.showError(
            problemsMessage('The bundle directory is not safe.', normalizedDirectory.problems),
          );
          return { kind: 'refused', problems: normalizedDirectory.problems };
        }

        const preset = await dependencies.ui.select(
          'OKF: Initialize Bundle',
          'Choose a built-in bundle preset',
          PRESET_ITEMS,
        );
        if (preset === undefined || !BUNDLE_PRESETS.includes(preset)) {
          return { kind: 'cancelled' };
        }

        let rendered;
        try {
          if (dependencies.core === undefined) {
            throw new Error('The production Wasm core was not supplied.');
          }
          rendered = dependencies.core.renderBundle(preset, dependencies.now());
        } catch (error: unknown) {
          await dependencies.ui.showError(
            `The selected bundle preset could not be rendered. ${error instanceof Error ? error.message : 'The deterministic core rejected the request.'}`,
          );
          return { kind: 'failed' };
        }
        for (const file of rendered) {
          const relativePath =
            normalizedDirectory.value === '.'
              ? file.relativePath
              : `${normalizedDirectory.value}/${file.relativePath}`;
          const boundedPath = normalizeTemplateOutputPath(relativePath);
          if (!boundedPath.ok) {
            await dependencies.ui.showError(
              problemsMessage(
                'The generated bundle path exceeds a workspace safety limit.',
                boundedPath.problems,
              ),
            );
            return { kind: 'refused', problems: boundedPath.problems };
          }
        }

        let bundleRootUri: TUri;
        try {
          bundleRootUri =
            normalizedDirectory.value === '.'
              ? target.targetRootUri
              : dependencies.uris.joinContained(target.targetRootUri, normalizedDirectory.value);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'The bundle path is not safe.';
          await dependencies.ui.showError(`The bundle target is invalid. ${message}`);
          return { kind: 'failed' };
        }

        const proposal = bundleFilesToProposal(
          'initialize-bundle',
          target.targetRootUri,
          rendered,
          dependencies.uris,
          {
            relativePathPrefix: normalizedDirectory.value,
            workspaceSafetyRoot: target.workspaceSafetyRootUri,
          },
        );
        const outcome = await runProposalWorkflow(
          dependencies,
          lease,
          proposal,
          {
            title: 'Initialize OKF bundle',
            summary: [
              `Workspace target: ${target.label}`,
              `Bundle directory: ${normalizedDirectory.value}`,
              `Preset: ${presetLabel(preset)}`,
            ],
          },
          {
            previewMode: 'existing-file-changes',
          },
        );

        if (outcome.kind === 'applied') {
          // Selection and editor navigation happen after the guarded create and must not retain the
          // extension-wide write lease while VS Code reveals the generated root.
          void Promise.resolve().then(async () => {
            try {
              await dependencies.selectInitializedBundle(bundleRootUri);
            } catch {
              await dependencies.ui
                .showError(
                  'The bundle files were created, but Workbench could not select the new root. Select the bundle directory and continue; do not rerun initialization over the created files.',
                )
                .catch(() => undefined);
            }
            try {
              const rootIndexUri = dependencies.uris.joinContained(bundleRootUri, 'index.md');
              await dependencies.ui.openDocument(rootIndexUri);
            } catch {
              await dependencies.ui
                .showError(
                  'The bundle files were created, but the editor could not open the generated root index.md. Open index.md from the Explorer; do not rerun initialization over the created files.',
                )
                .catch(() => undefined);
            }
          });
        }
        return outcome;
      },
      admittedLease,
    );
}
