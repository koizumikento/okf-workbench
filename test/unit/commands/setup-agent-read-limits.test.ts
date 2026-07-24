import { describe, expect, it } from 'vitest';

import { typescriptOkfCore } from '../../../src/core/wasm/index.js';
import { SerialProposalWorkflowScheduler } from '../../../src/extension/commands/proposal-workflow-scheduler.js';
import { createSetupAgentIntegrationCommand } from '../../../src/extension/commands/setup-agent-integration.js';
import { BUNDLE_READ_LIMITS } from '../../../src/extension/workspace/readSafety.js';
import type { WorkspaceStat } from '../../../src/extension/workspace/types.js';
import { ProposalApplicator } from '../../../src/extension/workspace/proposalApplicator.js';
import { FakeWorkspacePort, stringUriCodec } from '../extension-workspace/fakes.js';
import {
  captureOpenWorkspaceFolderMembership,
  FakeCommandUi,
  FakeProposalPreviewer,
} from './fakes.js';

const workspaceRoot = 'memfs://workspace';
const agentsUri = `${workspaceRoot}/AGENTS.md`;

class ExistingAgentPort extends FakeWorkspacePort {
  public constructor(
    private readonly reportedBytes: number,
    private readonly returnedBytes: number,
  ) {
    super();
    this.putDirectory(workspaceRoot);
  }

  override async stat(uri: string): Promise<WorkspaceStat | undefined> {
    if (uri === agentsUri) {
      return { type: 'file', size: this.reportedBytes, ctime: 0, mtime: 0 };
    }
    return super.stat(uri);
  }

  override async read(uri: string): Promise<Uint8Array> {
    if (uri === agentsUri) {
      this.reads.push(uri);
      return new Uint8Array(this.returnedBytes);
    }
    return super.read(uri);
  }
}

function createCommand(port: ExistingAgentPort) {
  const ui = new FakeCommandUi();
  const previewer = new FakeProposalPreviewer();
  ui.selections.push('agents-md');
  const command = createSetupAgentIntegrationCommand({
    core: typescriptOkfCore,
    port,
    uris: stringUriCodec,
    applicator: new ProposalApplicator(port, stringUriCodec),
    ui,
    previewer,
    workflowScheduler: new SerialProposalWorkflowScheduler(),
    isWorkspaceTrusted: () => true,
    captureWorkspaceFolderMembership: captureOpenWorkspaceFolderMembership,
    selectAgentIntegrationTarget: async () => ({
      integrationRootUri: workspaceRoot,
      bundlePath: 'knowledge',
    }),
  });
  return { command, previewer, ui };
}

describe('Set Up Agent Integration bounded existing-file reads', () => {
  it('refuses a provider-reported +1 file before reading it', async () => {
    const port = new ExistingAgentPort(BUNDLE_READ_LIMITS.maxDocumentBytes + 1, 0);
    const { command, previewer, ui } = createCommand(port);

    await expect(command()).resolves.toEqual({ kind: 'failed' });
    expect(port.reads).toEqual([]);
    expect(port.writes).toEqual([]);
    expect(previewer.shown).toEqual([]);
    expect(ui.errors[0]).toContain('reported size');
  });

  it('refuses a dishonest +1 returned file before previewing it', async () => {
    const port = new ExistingAgentPort(1, BUNDLE_READ_LIMITS.maxDocumentBytes + 1);
    const { command, previewer, ui } = createCommand(port);

    await expect(command()).resolves.toEqual({ kind: 'failed' });
    expect(port.reads).toEqual([agentsUri]);
    expect(port.writes).toEqual([]);
    expect(previewer.shown).toEqual([]);
    expect(ui.errors[0]).toContain('provider returned');
  });
});
