import { TextDecoder } from 'node:util';

import type { OperationProblem, OperationResult } from '../../core/model/index.js';
import {
  planProviderIndexes,
  type ExistingIndexInput,
  type IndexConceptInput,
  type IndexGenerationMode,
} from '../../core/indexes/index.js';
import { parseBundle } from '../../core/parser/index.js';
import { loadBundle } from '../runtime/loadBundle.js';
import { MAX_PROPOSAL_PREVIEW_CHANGES } from '../preview/proposal-preview-budget.js';
import type { WorkspacePort } from '../workspace/types.js';
import type { WorkspaceUriCodec } from '../workspace/uriCodec.js';
import { providerIndexChangesToProposal } from './proposals.js';
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
  readonly existingIndexes: readonly (ExistingIndexInput & {
    readonly contentHash: string;
    readonly contentByteLength: number;
  })[];
}

function problem(code: string, message: string, correctiveAction: string): OperationProblem {
  return { code, message, correctiveAction };
}

/** Reads one consistent planning input without allowing unreadable files to disappear from indexes. */
export async function collectWorkspaceIndexSource<TUri>(
  bundleRootUri: TUri,
  workspaceSafetyRootUri: TUri,
  port: WorkspacePort<TUri>,
  uris: WorkspaceUriCodec<TUri>,
): Promise<OperationResult<WorkspaceIndexSource>> {
  let loaded;
  try {
    loaded = await loadBundle(port, uris, bundleRootUri, workspaceSafetyRootUri);
  } catch (error) {
    return {
      ok: false,
      problems: [
        problem(
          'index-source-load-failed',
          error instanceof Error ? error.message : 'The selected bundle could not be read safely.',
          'Check workspace availability and permissions, reduce or split an oversized bundle, then run index generation again.',
        ),
      ],
    };
  }

  if (loaded.failures.length > 0) {
    return {
      ok: false,
      problems: loaded.failures.map((failure) =>
        problem(
          'index-source-read-failed',
          `${failure.bundlePath}: ${failure.message}`,
          'Repair or restore access to the file before regenerating indexes.',
        ),
      ),
    };
  }

  const documents = loaded.documents;
  const existingIndexes: (ExistingIndexInput & {
    readonly contentHash: string;
    readonly contentByteLength: number;
  })[] = [];
  for (const document of documents) {
    if (document.bundlePath !== 'index.md' && !document.bundlePath.endsWith('/index.md')) {
      continue;
    }
    if (!(document.content instanceof Uint8Array) || document.contentHash === undefined) {
      return {
        ok: false,
        problems: [
          problem(
            'index-source-snapshot-failed',
            `${document.bundlePath}: the workspace adapter did not retain the original provider bytes and hash.`,
            'Refresh the selected bundle, then run index generation again.',
          ),
        ],
      };
    }
    try {
      existingIndexes.push({
        relativePath: document.bundlePath,
        content: decoder.decode(document.content),
        contentHash: document.contentHash,
        contentByteLength: document.content.byteLength,
      });
    } catch (error) {
      return {
        ok: false,
        problems: [
          problem(
            'index-source-read-failed',
            `${document.bundlePath}: ${error instanceof Error ? error.message : 'The Markdown file could not be decoded.'}`,
            'Repair the file as valid UTF-8 before regenerating indexes.',
          ),
        ],
      };
    }
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
    workspaceSafetyRootUri: TUri,
  ) => Promise<OperationResult<WorkspaceIndexSource>>;
}

export function createRegenerateIndexesCommand<TUri>(
  dependencies: RegenerateIndexesCommandDependencies<TUri>,
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
        const mode = await dependencies.ui.select(
          'OKF: Regenerate Indexes',
          'Choose how existing indexes should be handled',
          MODE_ITEMS,
        );
        if (mode === undefined) {
          return { kind: 'cancelled' };
        }

        const source = await (dependencies.collectIndexSource === undefined
          ? collectWorkspaceIndexSource(
              selection.bundleRootUri,
              selection.workspaceSafetyRootUri,
              dependencies.port,
              dependencies.uris,
            )
          : dependencies.collectIndexSource(
              selection.bundleRootUri,
              selection.workspaceSafetyRootUri,
            ));
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
        if (plan.value.changes.length > MAX_PROPOSAL_PREVIEW_CHANGES) {
          const problems = [
            problem(
              'preview-limit',
              `Index regeneration would change ${String(plan.value.changes.length)} files, exceeding the complete-preview limit of ${String(MAX_PROPOSAL_PREVIEW_CHANGES)}.`,
              'Narrow the bundle or regenerate indexes in smaller subtrees so every proposed file can be previewed before applying.',
            ),
          ];
          await dependencies.ui.showError(
            problemsMessage('Indexes could not be previewed completely.', problems),
          );
          return { kind: 'refused', problems };
        }

        const proposal = providerIndexChangesToProposal(
          selection.bundleRootUri,
          plan.value.changes,
          dependencies.uris,
          {
            workspaceSafetyRoot: selection.workspaceSafetyRootUri,
            expectedContentSnapshots: new Map(
              source.value.existingIndexes.map((index) => [
                index.relativePath,
                { sha256: index.contentHash, byteLength: index.contentByteLength },
              ]),
            ),
          },
        );
        const revalidateBundleWrite = dependencies.revalidateBundleWrite;
        return runProposalWorkflow(
          dependencies,
          lease,
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
      },
      admittedLease,
    );
}
