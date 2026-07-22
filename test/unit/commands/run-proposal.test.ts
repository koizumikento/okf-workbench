import { describe, expect, it } from 'vitest';

import type { ChangeSetProposal } from '../../../src/core/model/index.js';
import { runProposalWorkflow } from '../../../src/extension/commands/run-proposal.js';
import { ProposalApplicator } from '../../../src/extension/workspace/proposalApplicator.js';
import { WorkspaceAccessError } from '../../../src/extension/workspace/types.js';
import { FakeWorkspacePort, stringUriCodec } from '../extension-workspace/fakes.js';
import { FakeCommandUi, FakeProposalPreviewer } from './fakes.js';

const root = 'memfs://workspace/knowledge';

function proposal(paths: readonly string[]): ChangeSetProposal {
  return {
    operation: 'test',
    writeRootUri: root,
    changes: paths.map((relativePath) => ({
      targetUri: `${root}/${relativePath}`,
      relativePath,
      operation: 'create',
      expected: { kind: 'absent' },
      encoding: 'utf8',
      proposedText: `${relativePath}\n`,
    })),
  };
}

function harness(port = new FakeWorkspacePort()) {
  const ui = new FakeCommandUi();
  const previewer = new FakeProposalPreviewer();
  return {
    port,
    ui,
    previewer,
    dependencies: {
      port,
      uris: stringUriCodec,
      applicator: new ProposalApplicator(port, stringUriCodec),
      ui,
      previewer,
      isWorkspaceTrusted: () => true,
    },
  };
}

const presentation = { title: 'Test proposal', summary: ['Complete review'] };

describe('proposal command workflow', () => {
  it('writes nothing and releases the preview when modeless approval is cancelled', async () => {
    const { port, ui, previewer, dependencies } = harness();
    ui.confirmations.push(false);

    const result = await runProposalWorkflow(
      dependencies,
      proposal(['first.md', 'second.md']),
      presentation,
    );

    expect(result).toEqual({ kind: 'cancelled' });
    expect(previewer.shown).toHaveLength(1);
    expect(previewer.releasedSessions).toBe(1);
    expect(ui.confirmationRequests[0]?.detail).toContain('- first.md\n- second.md');
    expect(ui.confirmationRequests[0]?.modeless).toBe(true);
    expect(port.writes).toEqual([]);
  });

  it('preflights every path and never opens approval when one create collides', async () => {
    const { port, ui, previewer, dependencies } = harness();
    port.putText(`${root}/first.md`, 'existing\n');

    const result = await runProposalWorkflow(
      dependencies,
      proposal(['first.md', 'second.md']),
      presentation,
    );

    expect(result.kind).toBe('failed');
    expect(previewer.shown).toEqual([]);
    expect(ui.confirmationRequests).toEqual([]);
    expect(port.writes).toEqual([]);
    expect(port.text(`${root}/first.md`)).toBe('existing\n');
  });

  it('reports completed, failed, and untouched targets after a partial provider failure', async () => {
    const port = new FakeWorkspacePort();
    port.failWrites.set(
      `${root}/second.md`,
      new WorkspaceAccessError('permission', 'Second is read-only.'),
    );
    const { ui, previewer, dependencies } = harness(port);
    ui.confirmations.push(true);

    const result = await runProposalWorkflow(
      dependencies,
      proposal(['first.md', 'second.md', 'third.md']),
      presentation,
    );

    expect(result).toMatchObject({
      kind: 'failed',
      report: {
        completed: [`${root}/first.md`],
        failed: [expect.objectContaining({ targetUri: `${root}/second.md` })],
        untouched: [`${root}/third.md`],
      },
    });
    expect(ui.errors.at(-1)).toContain('Completed:');
    expect(ui.errors.at(-1)).toContain('Untouched:');
    expect(previewer.releasedSessions).toBe(1);
    expect(port.text(`${root}/third.md`)).toBeUndefined();
  });

  it('refuses every write operation in an untrusted workspace', async () => {
    const { port, ui, dependencies } = harness();
    const result = await runProposalWorkflow(
      { ...dependencies, isWorkspaceTrusted: () => false },
      proposal(['first.md']),
      presentation,
    );

    expect(result.kind).toBe('refused');
    expect(ui.errors[0]).toContain('untrusted');
    expect(port.writes).toEqual([]);
  });

  it('rechecks workspace trust after preview and before applying', async () => {
    const { port, ui, previewer, dependencies } = harness();
    ui.confirmations.push(true);
    let trustChecks = 0;

    const result = await runProposalWorkflow(
      {
        ...dependencies,
        isWorkspaceTrusted: () => {
          trustChecks += 1;
          return trustChecks === 1;
        },
      },
      proposal(['first.md']),
      presentation,
    );

    expect(result.kind).toBe('refused');
    expect(trustChecks).toBe(2);
    expect(previewer.releasedSessions).toBe(1);
    expect(port.writes).toEqual([]);
  });

  it('runs the final compatibility guard after approval and content preflight', async () => {
    const { port, ui, previewer, dependencies } = harness();
    ui.confirmations.push(true);
    let compatibilityChecks = 0;

    const result = await runProposalWorkflow(dependencies, proposal(['first.md']), presentation, {
      beforeApply: async () => {
        compatibilityChecks += 1;
        return {
          code: 'unsupported-okf-version-write',
          message: 'The bundle changed to unsupported OKF version "1.0".',
          correctiveAction: 'Validate the bundle and migrate it before writing.',
        };
      },
    });

    expect(result).toMatchObject({
      kind: 'refused',
      problems: [{ code: 'unsupported-okf-version-write' }],
    });
    expect(compatibilityChecks).toBe(1);
    expect(ui.confirmationRequests).toHaveLength(1);
    expect(ui.errors.at(-1)).toContain('bundle compatibility changed');
    expect(previewer.releasedSessions).toBe(1);
    expect(port.writes).toEqual([]);
  });
});
