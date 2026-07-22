import { TextEncoder } from 'node:util';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeState = vi.hoisted(() => ({
  provider: undefined as
    { provideTextDocumentContent(uri: { toString(): string }): string | undefined } | undefined,
  showWarningMessage: vi.fn(),
  executeCommand: vi.fn(),
}));

vi.mock('vscode', () => {
  class MockUri {
    readonly #value: string;

    constructor(value: string) {
      this.#value = value;
    }

    static from(value: {
      readonly scheme: string;
      readonly authority: string;
      readonly path: string;
    }) {
      return new MockUri(`${value.scheme}://${value.authority}${value.path}`);
    }

    static parse(value: string) {
      return new MockUri(value);
    }

    toString(): string {
      return this.#value;
    }
  }

  return {
    Uri: MockUri,
    ViewColumn: { Beside: 2 },
    workspace: {
      registerTextDocumentContentProvider: vi.fn(
        (_scheme: string, provider: typeof vscodeState.provider) => {
          vscodeState.provider = provider;
          return { dispose: vi.fn() };
        },
      ),
      openTextDocument: vi.fn(async (uri: MockUri) => {
        vscodeState.provider?.provideTextDocumentContent(uri);
        return { uri };
      }),
    },
    window: {
      showTextDocument: vi.fn(async () => undefined),
      showWarningMessage: vscodeState.showWarningMessage,
    },
    commands: {
      executeCommand: vscodeState.executeCommand.mockImplementation(
        async (_command: string, before: MockUri, after: MockUri) => {
          vscodeState.provider?.provideTextDocumentContent(before);
          vscodeState.provider?.provideTextDocumentContent(after);
        },
      ),
    },
  };
});

import * as vscode from 'vscode';

import type { ChangeSetProposal } from '../../../src/core/model/index.js';
import { VscodeCommandUi } from '../../../src/extension/commands/vscode-command-ui.js';
import { VscodeProposalPreviewer } from '../../../src/extension/preview/vscode-proposal-previewer.js';
import type { WorkspacePort } from '../../../src/extension/workspace/types.js';
import type { WorkspaceUriCodec } from '../../../src/extension/workspace/uriCodec.js';

const encoder = new TextEncoder();

const proposal: ChangeSetProposal = {
  operation: 'test-preview',
  writeRootUri: 'memfs://workspace/knowledge',
  changes: [
    {
      targetUri: 'memfs://workspace/knowledge/index.md',
      relativePath: 'index.md',
      operation: 'update',
      expected: { kind: 'sha256', value: 'preview-hash' },
      encoding: 'utf8',
      proposedText: 'after\n',
    },
  ],
};

const port: WorkspacePort<vscode.Uri> = {
  read: async () => encoder.encode('before\n'),
  async *traverse() {
    // Preview tests read one declared target and do not traverse the workspace.
  },
  enumerate: async () => [],
  stat: async () => undefined,
  write: async () => undefined,
};

const uris: WorkspaceUriCodec<vscode.Uri> = {
  parse: (value) => vscode.Uri.parse(value, true),
  serialize: (uri) => uri.toString(),
  joinContained: (root) => root,
  joinProviderPath: (root) => root,
  equals: (left, right) => left.toString() === right.toString(),
};

beforeEach(() => {
  vscodeState.provider = undefined;
  vscodeState.showWarningMessage.mockReset();
  vscodeState.executeCommand.mockClear();
});

describe('VS Code proposal confirmation', () => {
  it('keeps the editor interactive while the apply continuation is pending', async () => {
    vscodeState.showWarningMessage.mockResolvedValue('Apply changes');
    const ui = new VscodeCommandUi();

    await expect(
      ui.confirm({
        title: 'Regenerate indexes',
        detail: 'A complete path list is available in the preview summary.',
        confirmLabel: 'Apply changes',
        modeless: true,
      }),
    ).resolves.toBe(true);

    expect(vscodeState.showWarningMessage).toHaveBeenCalledWith(
      'Regenerate indexes Review the opened read-only preview tabs, then choose Apply changes.',
      { modal: false },
      'Apply changes',
    );
  });

  it('uses a modeless warning for background availability failures', async () => {
    vscodeState.showWarningMessage.mockResolvedValue(undefined);
    const ui = new VscodeCommandUi();

    await ui.showWarning('Bundle unavailable.');

    expect(vscodeState.showWarningMessage).toHaveBeenCalledWith('Bundle unavailable.');
  });
});

describe('VS Code proposal preview storage', () => {
  it('releases every run after confirmation and treats old virtual URIs as expired', async () => {
    const previewer = new VscodeProposalPreviewer();
    const oldSummaries: { toString(): string }[] = [];

    for (let run = 0; run < 3; run += 1) {
      const session = await previewer.show(
        proposal,
        { title: 'Preview indexes', summary: ['Review all files'] },
        port,
        uris,
      );
      expect(previewer.retainedDocumentCount).toBe(3);
      const summary = vscode.Uri.from({
        scheme: 'okf-workbench-preview',
        authority: 'readonly',
        path: `/run-${run + 1}/000-summary.md`,
      });
      oldSummaries.push(summary);

      session.dispose();
      session.dispose();
      expect(previewer.retainedDocumentCount).toBe(0);
    }

    for (const summary of oldSummaries) {
      expect(vscodeState.provider?.provideTextDocumentContent(summary)).toContain(
        'OKF preview expired',
      );
    }
    previewer.dispose();
  });

  it('releases a partially opened run when VS Code cannot open a diff', async () => {
    vscodeState.executeCommand.mockRejectedValueOnce(new Error('Diff editor unavailable.'));
    const previewer = new VscodeProposalPreviewer();

    await expect(
      previewer.show(
        proposal,
        { title: 'Preview indexes', summary: ['Review all files'] },
        port,
        uris,
      ),
    ).rejects.toThrow('Diff editor unavailable.');
    expect(previewer.retainedDocumentCount).toBe(0);

    previewer.dispose();
  });
});
