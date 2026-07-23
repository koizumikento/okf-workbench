import { describe, expect, it } from 'vitest';

import { SerialProposalWorkflowScheduler } from '../../../src/extension/commands/proposal-workflow-scheduler.js';
import { createRegenerateIndexesCommand } from '../../../src/extension/commands/regenerate-indexes.js';
import { MAX_PROPOSAL_PREVIEW_CHANGES } from '../../../src/extension/preview/proposal-preview-budget.js';
import { ProposalApplicator } from '../../../src/extension/workspace/proposalApplicator.js';
import { FakeWorkspacePort, stringUriCodec } from '../extension-workspace/fakes.js';
import {
  captureOpenWorkspaceFolderMembership,
  FakeCommandUi,
  FakeProposalPreviewer,
} from './fakes.js';

const workspaceRoot = 'memfs://workspace';
const bundleRoot = `${workspaceRoot}/knowledge`;

function createCommand(directoryCount: number) {
  const port = new FakeWorkspacePort();
  port.putDirectory(workspaceRoot);
  port.putDirectory(bundleRoot);
  const ui = new FakeCommandUi();
  const previewer = new FakeProposalPreviewer();
  ui.selections.push('missing-indexes-only');

  const command = createRegenerateIndexesCommand({
    port,
    uris: stringUriCodec,
    applicator: new ProposalApplicator(port, stringUriCodec),
    ui,
    previewer,
    workflowScheduler: new SerialProposalWorkflowScheduler(),
    isWorkspaceTrusted: () => true,
    captureWorkspaceFolderMembership: captureOpenWorkspaceFolderMembership,
    selectBundle: async () => ({
      bundleRootUri: bundleRoot,
      workspaceSafetyRootUri: workspaceRoot,
    }),
    collectIndexSource: async () => ({
      ok: true,
      value: {
        concepts: Array.from({ length: directoryCount }, (_, index) => ({
          relativePath: `directory-${String(index).padStart(3, '0')}/concept.md`,
          title: `Concept ${String(index)}`,
        })),
        existingIndexes: [],
      },
      warnings: [],
    }),
  });

  return { command, port, previewer, ui };
}

describe('Regenerate Indexes complete-preview boundary', () => {
  it('previews exactly the change limit and refuses +1 before opening a preview', async () => {
    // Every distinct concept directory creates its own index plus the root index.
    const exact = createCommand(MAX_PROPOSAL_PREVIEW_CHANGES - 1);
    await expect(exact.command()).resolves.toEqual({ kind: 'cancelled' });
    expect(exact.previewer.shown).toHaveLength(1);
    expect(exact.previewer.shown[0]?.proposal.changes).toHaveLength(MAX_PROPOSAL_PREVIEW_CHANGES);
    expect(exact.port.writes).toEqual([]);

    const exceeded = createCommand(MAX_PROPOSAL_PREVIEW_CHANGES);
    const result = await exceeded.command();

    expect(result).toMatchObject({
      kind: 'refused',
      problems: [
        {
          code: 'preview-limit',
          message: expect.stringContaining(`${String(MAX_PROPOSAL_PREVIEW_CHANGES + 1)} files`),
        },
      ],
    });
    expect(exceeded.previewer.shown).toEqual([]);
    expect(exceeded.ui.confirmationRequests).toEqual([]);
    expect(exceeded.port.writes).toEqual([]);
    expect(exceeded.ui.errors[0]).toContain('Indexes could not be previewed completely');
  });
});
