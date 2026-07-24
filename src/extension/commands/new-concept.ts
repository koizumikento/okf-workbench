import {
  conceptDescriptionInputProblem,
  conceptTitleInputProblem,
  conceptTypeInputProblem,
  CONCEPT_TEMPLATE_DEFINITIONS,
  normalizeBundleDirectory,
  normalizeConceptDescriptionInput,
  normalizeConceptPath,
  parseConceptTagsInput,
  renderConceptTemplate,
  type ConceptTemplate,
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
  SelectBundle,
  SelectionItem,
} from './types.js';

const TEMPLATE_ITEMS: readonly SelectionItem<ConceptTemplate>[] = CONCEPT_TEMPLATE_DEFINITIONS.map(
  (definition) => ({
    value: definition.id,
    label: definition.title,
    description: `Suggested type: ${definition.suggestedType}`,
  }),
);

export interface NewConceptCommandDependencies<TUri> extends ProposalWorkflowDependencies<TUri> {
  readonly selectBundle: SelectBundle<TUri>;
}

function conceptPath(destination: string, filename: string): string {
  return destination === '.' ? filename : `${destination}/${filename}`;
}

function validateFilename(value: string): string | undefined {
  if (value.includes('/') || value.includes('\\')) {
    return 'Enter one filename only; use the destination field for directories.';
  }
  const result = normalizeConceptPath(value);
  return result.ok ? undefined : result.problems[0]?.message;
}

export function createNewConceptCommand<TUri>(
  dependencies: NewConceptCommandDependencies<TUri>,
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

        const selection = await dependencies.selectBundle();
        if (selection === undefined) {
          return { kind: 'cancelled' };
        }

        const template = await dependencies.ui.select(
          'OKF: New Concept',
          'Choose a concept template',
          TEMPLATE_ITEMS,
        );
        if (template === undefined) {
          return { kind: 'cancelled' };
        }

        const destinationInput = await dependencies.ui.input({
          title: 'OKF: New Concept',
          prompt: 'Destination directory relative to the selected bundle',
          value: '.',
          placeHolder: 'decisions',
          validate(value) {
            const result = normalizeBundleDirectory(value);
            return result.ok ? undefined : result.problems[0]?.message;
          },
        });
        if (destinationInput === undefined) {
          return { kind: 'cancelled' };
        }
        const destination = normalizeBundleDirectory(destinationInput);
        if (!destination.ok) {
          await dependencies.ui.showError(
            problemsMessage('The concept destination is not safe.', destination.problems),
          );
          return { kind: 'refused', problems: destination.problems };
        }

        const definition = CONCEPT_TEMPLATE_DEFINITIONS.find((item) => item.id === template);
        const type = await dependencies.ui.input({
          title: 'OKF: New Concept',
          prompt: 'Concept type (any non-empty value is allowed)',
          value: definition?.suggestedType ?? '',
          placeHolder: 'experiment-result',
          validate: (value) => conceptTypeInputProblem(value)?.message,
        });
        if (type === undefined) {
          return { kind: 'cancelled' };
        }
        const typeProblem = conceptTypeInputProblem(type);
        if (typeProblem !== undefined) {
          await dependencies.ui.showError(
            problemsMessage('The concept type is not usable.', [typeProblem]),
          );
          return { kind: 'refused', problems: [typeProblem] };
        }

        const title = await dependencies.ui.input({
          title: 'OKF: New Concept',
          prompt: 'Concept title',
          placeHolder: 'Durable knowledge title',
          validate: (value) => conceptTitleInputProblem(value)?.message,
        });
        if (title === undefined) {
          return { kind: 'cancelled' };
        }
        const titleProblem = conceptTitleInputProblem(title);
        if (titleProblem !== undefined) {
          await dependencies.ui.showError(
            problemsMessage('The concept title is not usable.', [titleProblem]),
          );
          return { kind: 'refused', problems: [titleProblem] };
        }

        const description = await dependencies.ui.input({
          title: 'OKF: New Concept',
          prompt: 'Description (optional)',
          placeHolder: 'What durable knowledge does this concept capture?',
          validate: (value) => conceptDescriptionInputProblem(value)?.message,
        });
        if (description === undefined) {
          return { kind: 'cancelled' };
        }
        const descriptionProblem = conceptDescriptionInputProblem(description);
        if (descriptionProblem !== undefined) {
          await dependencies.ui.showError(
            problemsMessage('The concept description is not usable.', [descriptionProblem]),
          );
          return { kind: 'refused', problems: [descriptionProblem] };
        }

        const tagsInput = await dependencies.ui.input({
          title: 'OKF: New Concept',
          prompt: 'Tags, separated by commas (optional)',
          placeHolder: 'architecture, decision',
          validate(value) {
            const parsed = parseConceptTagsInput(value);
            return parsed.ok ? undefined : parsed.problems[0]?.message;
          },
        });
        if (tagsInput === undefined) {
          return { kind: 'cancelled' };
        }
        const parsedTags = parseConceptTagsInput(tagsInput);
        if (!parsedTags.ok) {
          await dependencies.ui.showError(
            problemsMessage('The concept tags are not usable.', parsedTags.problems),
          );
          return { kind: 'refused', problems: parsedTags.problems };
        }

        const filename = await dependencies.ui.input({
          title: 'OKF: New Concept',
          prompt: 'Markdown filename',
          value: 'concept.md',
          placeHolder: 'decision-record.md',
          validate: validateFilename,
        });
        if (filename === undefined) {
          return { kind: 'cancelled' };
        }

        const normalizedDescription = normalizeConceptDescriptionInput(description);
        const optionalDescription =
          normalizedDescription === undefined || normalizedDescription.trim().length === 0
            ? undefined
            : normalizedDescription;
        const optionalTags = parsedTags.value;
        const renderInput = {
          template,
          relativePath: conceptPath(destination.value, filename),
          type,
          title,
          ...(optionalDescription === undefined ? {} : { description: optionalDescription }),
          ...(optionalTags.length === 0 ? {} : { tags: optionalTags }),
        };
        const preflight = renderConceptTemplate(renderInput);
        if (!preflight.ok) {
          await dependencies.ui.showError(
            problemsMessage('The concept could not be rendered.', preflight.problems),
          );
          return { kind: 'refused', problems: preflight.problems };
        }
        let rendered;
        try {
          if (dependencies.core === undefined) {
            throw new Error('The production Wasm core was not supplied.');
          }
          rendered = dependencies.core.renderConcept(renderInput);
        } catch (error: unknown) {
          await dependencies.ui.showError(
            `The concept could not be rendered. ${error instanceof Error ? error.message : 'The deterministic core rejected the request.'}`,
          );
          return { kind: 'failed' };
        }

        const proposal = bundleFilesToProposal(
          'new-concept',
          selection.bundleRootUri,
          [rendered],
          dependencies.uris,
          { workspaceSafetyRoot: selection.workspaceSafetyRootUri },
        );
        const revalidateBundleWrite = dependencies.revalidateBundleWrite;
        const outcome = await runProposalWorkflow(
          dependencies,
          lease,
          proposal,
          {
            title: 'Create OKF concept',
            summary: [
              `Bundle: ${selection.label ?? dependencies.uris.serialize(selection.bundleRootUri)}`,
              `Template: ${definition?.title ?? template}`,
              `Type: ${type.trim()}`,
            ],
          },
          revalidateBundleWrite === undefined
            ? {}
            : {
                beforeApply: () => revalidateBundleWrite(selection.bundleRootUri),
              },
        );
        if (outcome.kind === 'applied') {
          const createdUri = dependencies.uris.joinContained(
            selection.bundleRootUri,
            rendered.relativePath,
          );
          try {
            await dependencies.ui.openDocument(createdUri);
          } catch {
            await dependencies.ui.showError(
              `The concept was created at ${dependencies.uris.serialize(createdUri)}, but the editor could not open it. Open the file from the Explorer.`,
            );
          }
        }
        return outcome;
      },
      admittedLease,
    );
}
