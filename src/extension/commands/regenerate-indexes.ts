import { TextDecoder } from 'node:util';

import type { OperationProblem, OperationResult } from '../../core/model/index.js';
import {
  planProviderIndexes,
  type ExistingIndexInput,
  type IndexConceptInput,
  type IndexGenerationMode,
} from '../../core/indexes/index.js';
import { parseBundle } from '../../core/parser/index.js';
import { sha256Content } from '../workspace/contentHash.js';
import type { WorkspacePort } from '../workspace/types.js';
import type { WorkspaceUriCodec } from '../workspace/uriCodec.js';
import { providerIndexChangesToProposal } from './proposals.js';
import { problemsMessage, refuseUntrustedWorkspace, runProposalWorkflow } from './run-proposal.js';
import type {
  CommandOutcome,
  ProposalWorkflowDependencies,
  SelectBundle,
  SelectionItem,
} from './types.js';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const MODE_ITEMS: readonly SelectionItem<IndexGenerationMode>[] = [
  {
    value: 'missing-indexes-only',
    label: 'Missing indexes only',
    description:
      'Create absent directory indexes; a versionless root receives only its OKF 0.1 declaration.',
  },
  {
    value: 'update-all',
    label: 'Update all',
    description: 'Create missing indexes and safely update every managed index region.',
  },
];

export interface WorkspaceIndexSource {
  readonly concepts: readonly IndexConceptInput[];
  readonly existingIndexes: readonly (ExistingIndexInput & { readonly contentHash: string })[];
}

function problem(code: string, message: string, correctiveAction: string): OperationProblem {
  return { code, message, correctiveAction };
}

/** Reads one consistent planning input without allowing unreadable files to disappear from indexes. */
export async function collectWorkspaceIndexSource<TUri>(
  bundleRootUri: TUri,
  port: WorkspacePort<TUri>,
  uris: WorkspaceUriCodec<TUri>,
): Promise<OperationResult<WorkspaceIndexSource>> {
  let entries;
  try {
    entries = await port.enumerate(bundleRootUri);
  } catch (error) {
    return {
      ok: false,
      problems: [
        problem(
          'index-enumeration-failed',
          error instanceof Error ? error.message : 'The selected bundle could not be enumerated.',
          'Check workspace availability and permissions, then run index generation again.',
        ),
      ],
    };
  }

  const documents = [];
  const existingIndexes: (ExistingIndexInput & { readonly contentHash: string })[] = [];
  const readProblems: OperationProblem[] = [];
  for (const entry of entries) {
    if (entry.type !== 'file' || !entry.relativePath.toLowerCase().endsWith('.md')) {
      continue;
    }
    try {
      const content = await port.read(entry.uri);
      documents.push({
        uri: uris.serialize(entry.uri),
        bundlePath: entry.relativePath,
        content,
      });
      if (entry.relativePath === 'index.md' || entry.relativePath.endsWith('/index.md')) {
        existingIndexes.push({
          relativePath: entry.relativePath,
          content: decoder.decode(content),
          contentHash: sha256Content(content),
        });
      }
    } catch (error) {
      readProblems.push(
        problem(
          'index-source-read-failed',
          `${entry.relativePath}: ${
            error instanceof Error ? error.message : 'The Markdown file could not be read.'
          }`,
          'Repair or restore access to the file before regenerating indexes.',
        ),
      );
    }
  }
  if (readProblems.length > 0) {
    return { ok: false, problems: readProblems };
  }

  const parsed = parseBundle({
    rootUri: uris.serialize(bundleRootUri),
    revision: 0,
    documents,
  });
  if (parsed.failures.length > 0) {
    return {
      ok: false,
      problems: parsed.failures.map((failure) =>
        problem(
          'index-source-parse-failed',
          `${failure.bundlePath}: ${failure.message}`,
          'Repair the Markdown or YAML error before regenerating indexes, so no concept is omitted.',
        ),
      ),
    };
  }

  return {
    ok: true,
    value: {
      concepts: parsed.concepts.map((concept) => ({
        relativePath: concept.source.bundlePath,
        ...(concept.title === undefined ? {} : { title: concept.title }),
        ...(concept.description === undefined ? {} : { description: concept.description }),
      })),
      existingIndexes,
    },
    warnings: [],
  };
}

export interface RegenerateIndexesCommandDependencies<
  TUri,
> extends ProposalWorkflowDependencies<TUri> {
  readonly selectBundle: SelectBundle<TUri>;
  readonly collectIndexSource?: (
    bundleRootUri: TUri,
  ) => Promise<OperationResult<WorkspaceIndexSource>>;
}

export function createRegenerateIndexesCommand<TUri>(
  dependencies: RegenerateIndexesCommandDependencies<TUri>,
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
    const mode = await dependencies.ui.select(
      'OKF: Regenerate Indexes',
      'Choose how existing indexes should be handled',
      MODE_ITEMS,
    );
    if (mode === undefined) {
      return { kind: 'cancelled' };
    }

    const source = await (dependencies.collectIndexSource === undefined
      ? collectWorkspaceIndexSource(selection.bundleRootUri, dependencies.port, dependencies.uris)
      : dependencies.collectIndexSource(selection.bundleRootUri));
    if (!source.ok) {
      await dependencies.ui.showError(
        problemsMessage('Indexes could not be planned safely.', source.problems),
      );
      return { kind: 'refused', problems: source.problems };
    }

    const plan = planProviderIndexes({
      mode,
      concepts: source.value.concepts,
      existingIndexes: source.value.existingIndexes,
    });
    if (!plan.ok) {
      await dependencies.ui.showError(
        problemsMessage('Indexes could not be planned safely.', plan.problems),
      );
      return { kind: 'refused', problems: plan.problems };
    }

    const proposal = providerIndexChangesToProposal(
      selection.bundleRootUri,
      plan.value.changes,
      dependencies.uris,
      {
        expectedContentHashes: new Map(
          source.value.existingIndexes.map((index) => [index.relativePath, index.contentHash]),
        ),
      },
    );
    const revalidateBundleWrite = dependencies.revalidateBundleWrite;
    return runProposalWorkflow(
      dependencies,
      proposal,
      {
        title: 'Regenerate OKF indexes',
        summary: [
          `Bundle: ${selection.label ?? dependencies.uris.serialize(selection.bundleRootUri)}`,
          `Mode: ${mode === 'update-all' ? 'Update all' : 'Missing indexes only'}`,
        ],
      },
      revalidateBundleWrite === undefined
        ? {}
        : {
            beforeApply: () => revalidateBundleWrite(selection.bundleRootUri),
          },
    );
  };
}
