import {
  CONCEPT_TEMPLATE_DEFINITIONS,
  normalizeBundleDirectory,
  normalizeConceptPath,
  renderConceptTemplate,
  type ConceptTemplate,
} from '../../core/templates/index.js';
import { bundleFilesToProposal } from './proposals.js';
import { problemsMessage, refuseUntrustedWorkspace, runProposalWorkflow } from './run-proposal.js';
import type {
  CommandOutcome,
  ProposalWorkflowDependencies,
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

function parseTags(value: string): readonly string[] {
  if (value.trim().length === 0) {
    return [];
  }
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

export function createNewConceptCommand<TUri>(
  dependencies: NewConceptCommandDependencies<TUri>,
): () => Promise<CommandOutcome> {
  return async () => {
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
      validate: (value) =>
        value.trim().length === 0 ? 'Enter a non-empty concept type.' : undefined,
    });
    if (type === undefined) {
      return { kind: 'cancelled' };
    }

    const title = await dependencies.ui.input({
      title: 'OKF: New Concept',
      prompt: 'Concept title',
      placeHolder: 'Durable knowledge title',
      validate: (value) => (value.trim().length === 0 ? 'Enter a concept title.' : undefined),
    });
    if (title === undefined) {
      return { kind: 'cancelled' };
    }

    const description = await dependencies.ui.input({
      title: 'OKF: New Concept',
      prompt: 'Description (optional)',
      placeHolder: 'What durable knowledge does this concept capture?',
    });
    if (description === undefined) {
      return { kind: 'cancelled' };
    }

    const tagsInput = await dependencies.ui.input({
      title: 'OKF: New Concept',
      prompt: 'Tags, separated by commas (optional)',
      placeHolder: 'architecture, decision',
    });
    if (tagsInput === undefined) {
      return { kind: 'cancelled' };
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

    const optionalDescription = description.trim().length === 0 ? undefined : description;
    const optionalTags = parseTags(tagsInput);
    const rendered = renderConceptTemplate({
      template,
      relativePath: conceptPath(destination.value, filename),
      type,
      title,
      ...(optionalDescription === undefined ? {} : { description: optionalDescription }),
      ...(optionalTags.length === 0 ? {} : { tags: optionalTags }),
    });
    if (!rendered.ok) {
      await dependencies.ui.showError(
        problemsMessage('The concept could not be rendered.', rendered.problems),
      );
      return { kind: 'refused', problems: rendered.problems };
    }

    const proposal = bundleFilesToProposal(
      'new-concept',
      selection.bundleRootUri,
      [rendered.value],
      dependencies.uris,
    );
    const revalidateBundleWrite = dependencies.revalidateBundleWrite;
    const outcome = await runProposalWorkflow(
      dependencies,
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
        rendered.value.relativePath,
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
  };
}
