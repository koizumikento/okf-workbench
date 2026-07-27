import { Buffer } from 'node:buffer';
import { TextEncoder } from 'node:util';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeState = vi.hoisted(() => ({
  providers: new Map<
    string,
    { provideTextDocumentContent(uri: { toString(): string }): string | undefined }
  >(),
  registrations: [] as {
    readonly scheme: string;
    readonly provider: {
      provideTextDocumentContent(uri: { toString(): string }): string | undefined;
    };
    readonly dispose: ReturnType<typeof vi.fn>;
  }[],
  documents: new Map<
    string,
    {
      readonly uri: { readonly scheme: string; toString(): string };
      readonly content: string | undefined;
    }
  >(),
  tabs: [] as { readonly input: unknown }[],
  tabChangeListeners: new Set<
    (event: {
      readonly opened: readonly { readonly input: unknown }[];
      readonly closed: readonly { readonly input: unknown }[];
      readonly changed: readonly { readonly input: unknown }[];
    }) => void
  >(),
  tabGroupChangeListeners: new Set<
    (event: {
      readonly opened: readonly unknown[];
      readonly closed: readonly unknown[];
      readonly changed: readonly unknown[];
    }) => void
  >(),
  tabListenerDisposals: [] as ReturnType<typeof vi.fn>[],
  tabGroupListenerDisposals: [] as ReturnType<typeof vi.fn>[],
  closeTabs: vi.fn(),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  executeCommand: vi.fn(),
}));

vi.mock('vscode', () => {
  class MockUri {
    readonly #value: string;
    readonly scheme: string;

    constructor(value: string) {
      this.#value = value;
      this.scheme = value.slice(0, value.indexOf(':'));
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

  class MockTabInputText {
    constructor(readonly uri: MockUri) {}
  }

  class MockTabInputTextDiff {
    constructor(
      readonly original: MockUri,
      readonly modified: MockUri,
    ) {}
  }

  vscodeState.closeTabs.mockImplementation(async (tabs: readonly { readonly input: unknown }[]) => {
    const closing = new Set(tabs);
    vscodeState.tabs = vscodeState.tabs.filter((tab) => !closing.has(tab));
    for (const listener of vscodeState.tabChangeListeners) {
      listener({ opened: [], closed: tabs, changed: [] });
    }
    return true;
  });

  return {
    Uri: MockUri,
    TabInputText: MockTabInputText,
    TabInputTextDiff: MockTabInputTextDiff,
    ViewColumn: { Beside: 2 },
    workspace: {
      registerTextDocumentContentProvider: vi.fn(
        (
          scheme: string,
          provider: {
            provideTextDocumentContent(uri: { toString(): string }): string | undefined;
          },
        ) => {
          vscodeState.providers.set(scheme, provider);
          const dispose = vi.fn(() => vscodeState.providers.delete(scheme));
          vscodeState.registrations.push({ scheme, provider, dispose });
          return { dispose };
        },
      ),
      openTextDocument: vi.fn(async (uri: MockUri) => {
        const cached = vscodeState.documents.get(uri.toString());
        if (cached !== undefined) {
          return cached;
        }
        const document = {
          uri,
          content: vscodeState.providers.get(uri.scheme)?.provideTextDocumentContent(uri),
        };
        vscodeState.documents.set(uri.toString(), document);
        return document;
      }),
    },
    window: {
      showTextDocument: vi.fn(async (document: { readonly uri: MockUri }) => {
        const tab = { input: new MockTabInputText(document.uri) };
        vscodeState.tabs.push(tab);
        for (const listener of vscodeState.tabChangeListeners) {
          listener({ opened: [tab], closed: [], changed: [] });
        }
      }),
      showInformationMessage: vscodeState.showInformationMessage,
      showWarningMessage: vscodeState.showWarningMessage,
      tabGroups: {
        get all() {
          return [{ tabs: vscodeState.tabs }];
        },
        onDidChangeTabs: vi.fn(
          (
            listener: (event: {
              readonly opened: readonly { readonly input: unknown }[];
              readonly closed: readonly { readonly input: unknown }[];
              readonly changed: readonly { readonly input: unknown }[];
            }) => void,
          ) => {
            vscodeState.tabChangeListeners.add(listener);
            const dispose = vi.fn(() => vscodeState.tabChangeListeners.delete(listener));
            vscodeState.tabListenerDisposals.push(dispose);
            return { dispose };
          },
        ),
        onDidChangeTabGroups: vi.fn(
          (
            listener: (event: {
              readonly opened: readonly unknown[];
              readonly closed: readonly unknown[];
              readonly changed: readonly unknown[];
            }) => void,
          ) => {
            vscodeState.tabGroupChangeListeners.add(listener);
            const dispose = vi.fn(() => vscodeState.tabGroupChangeListeners.delete(listener));
            vscodeState.tabGroupListenerDisposals.push(dispose);
            return { dispose };
          },
        ),
        close: vscodeState.closeTabs,
      },
    },
    commands: {
      executeCommand: vscodeState.executeCommand.mockImplementation(
        async (_command: string, before: MockUri, after: MockUri) => {
          if (!vscodeState.documents.has(before.toString())) {
            vscodeState.documents.set(before.toString(), {
              uri: before,
              content: vscodeState.providers.get(before.scheme)?.provideTextDocumentContent(before),
            });
          }
          if (!vscodeState.documents.has(after.toString())) {
            vscodeState.documents.set(after.toString(), {
              uri: after,
              content: vscodeState.providers.get(after.scheme)?.provideTextDocumentContent(after),
            });
          }
          const tab = { input: new MockTabInputTextDiff(before, after) };
          vscodeState.tabs.push(tab);
          for (const listener of vscodeState.tabChangeListeners) {
            listener({ opened: [tab], closed: [], changed: [] });
          }
        },
      ),
    },
  };
});

import * as vscode from 'vscode';

import type { ChangeSetProposal } from '../../../src/core/model/index.js';
import { SerialProposalWorkflowScheduler } from '../../../src/extension/commands/proposal-workflow-scheduler.js';
import {
  runProposalCommand,
  runProposalWorkflow as runProposalWorkflowUnderLease,
  type RunProposalOptions,
} from '../../../src/extension/commands/run-proposal.js';
import type {
  CommandOutcome,
  CommandUi,
  ConfirmationOptions,
  ProposalPresentation,
  ProposalWorkflowDependencies,
} from '../../../src/extension/commands/types.js';
import { VscodeCommandUi } from '../../../src/extension/commands/vscode-command-ui.js';
import {
  MAX_PROPOSAL_PREVIEW_BODY_BYTES,
  MAX_PROPOSAL_PREVIEW_CHANGES,
  MAX_PROPOSAL_PREVIEW_SUMMARY_BYTES,
  renderProposalPreviewSummary,
} from '../../../src/extension/preview/proposal-preview-budget.js';
import { VscodeProposalPreviewer } from '../../../src/extension/preview/vscode-proposal-previewer.js';
import { sha256Content } from '../../../src/extension/workspace/contentHash.js';
import { ProposalApplicator } from '../../../src/extension/workspace/proposalApplicator.js';
import { BUNDLE_READ_LIMITS } from '../../../src/extension/workspace/readSafety.js';
import type {
  WorkspacePort,
  WorkspaceStat,
  WorkspaceWriteOptions,
} from '../../../src/extension/workspace/types.js';
import type { WorkspaceUriCodec } from '../../../src/extension/workspace/uriCodec.js';
import { captureOpenWorkspaceFolderMembership } from './fakes.js';

const encoder = new TextEncoder();
const confirmationPreviewIdentity = {
  id: 'okf-preview-7-target-deadbeef',
  label: 'OKF Preview #7 / target deadbeef',
  targetUri: 'memfs://workspace/knowledge',
};

function runProposalWorkflow(
  dependencies: ProposalWorkflowDependencies<vscode.Uri>,
  proposal: ChangeSetProposal,
  presentation: ProposalPresentation,
  options: RunProposalOptions = {},
): Promise<CommandOutcome> {
  return runProposalCommand(dependencies, (lease) =>
    runProposalWorkflowUnderLease(dependencies, lease, proposal, presentation, options),
  );
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const proposal: ChangeSetProposal = {
  operation: 'test-preview',
  workspaceSafetyRootUri: 'memfs://workspace/knowledge',
  writeRootUri: 'memfs://workspace/knowledge',
  changes: [
    {
      targetUri: 'memfs://workspace/knowledge/index.md',
      relativePath: 'index.md',
      operation: 'update',
      expected: {
        kind: 'sha256',
        value: sha256Content(encoder.encode('before\n')),
        byteLength: 7,
      },
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
  stat: async (uri) =>
    uri.toString() === 'memfs://workspace/knowledge'
      ? { type: 'directory', size: 0, ctime: 0, mtime: 0 }
      : uri.toString() === 'memfs://workspace/knowledge/index.md'
        ? { type: 'file', size: 7, ctime: 0, mtime: 0 }
        : undefined,
  write: async () => undefined,
};

function containedTestPathSegments(
  root: vscode.Uri,
  descendant: vscode.Uri,
): readonly vscode.Uri[] {
  const rootText = root.toString().replace(/\/$/u, '');
  const descendantText = descendant.toString().replace(/\/$/u, '');
  if (rootText === descendantText) {
    return [root];
  }
  if (!descendantText.startsWith(`${rootText}/`)) {
    throw new Error('Test descendant is outside its root.');
  }
  const segments = descendantText.slice(rootText.length + 1).split('/');
  return [
    root,
    ...segments.map((_, index) =>
      vscode.Uri.parse(`${rootText}/${segments.slice(0, index + 1).join('/')}`, true),
    ),
  ];
}

const uris: WorkspaceUriCodec<vscode.Uri> = {
  parse: (value) => vscode.Uri.parse(value, true),
  serialize: (uri) => uri.toString(),
  containedPathSegments: containedTestPathSegments,
  joinContained: (root) => root,
  joinProviderPath: (root) => root,
  equals: (left, right) => left.toString() === right.toString(),
};

type TestTab = (typeof vscodeState.tabs)[number];

function emitTabChange(event: {
  readonly opened?: readonly TestTab[];
  readonly closed?: readonly TestTab[];
  readonly changed?: readonly TestTab[];
}): void {
  for (const listener of vscodeState.tabChangeListeners) {
    listener({
      opened: event.opened ?? [],
      closed: event.closed ?? [],
      changed: event.changed ?? [],
    });
  }
}

function removeTab(tab: TestTab): void {
  vscodeState.tabs = vscodeState.tabs.filter((candidate) => candidate !== tab);
  emitTabChange({ closed: [tab] });
}

function replaceTab(tab: TestTab, replacement: TestTab): void {
  const index = vscodeState.tabs.indexOf(tab);
  if (index < 0) {
    throw new Error('Expected the tab being replaced to remain open.');
  }
  vscodeState.tabs[index] = replacement;
  emitTabChange({ opened: [replacement], closed: [tab] });
}

function summaryTab(): TestTab {
  const tab = vscodeState.tabs.find(
    (candidate) =>
      candidate.input instanceof vscode.TabInputText &&
      candidate.input.uri.toString().includes('-summary.md'),
  );
  if (tab === undefined) {
    throw new Error('Expected the proposal summary tab to be open.');
  }
  return tab;
}

function firstDiffTab(): TestTab {
  const tab = vscodeState.tabs.find(
    (candidate) => candidate.input instanceof vscode.TabInputTextDiff,
  );
  if (tab === undefined) {
    throw new Error('Expected a proposal diff tab to be open.');
  }
  return tab;
}

const workflowRoot = 'memfs://workspace/knowledge';

const workflowUris: WorkspaceUriCodec<vscode.Uri> = {
  parse: (value) => vscode.Uri.parse(value, true),
  serialize: (uri) => uri.toString(),
  containedPathSegments: containedTestPathSegments,
  joinContained: (root, relativePath) =>
    vscode.Uri.parse(`${root.toString().replace(/\/$/u, '')}/${relativePath}`, true),
  joinProviderPath: (root, relativePath) =>
    vscode.Uri.parse(`${root.toString().replace(/\/$/u, '')}/${relativePath}`, true),
  equals: (left, right) => left.toString() === right.toString(),
};

class PreviewWorkflowPort implements WorkspacePort<vscode.Uri> {
  readonly writes: string[] = [];
  readonly files = new Map<string, Uint8Array>();
  readonly directoryGenerations = new Map<string, number>([[workflowRoot, 0]]);
  beforeRead: ((uri: string) => Promise<void> | void) | undefined;
  afterStat: ((uri: string, stat: WorkspaceStat | undefined) => Promise<void> | void) | undefined;
  afterWrite: ((uri: string) => void) | undefined;

  async read(uri: vscode.Uri): Promise<Uint8Array> {
    const serialized = uri.toString();
    await this.beforeRead?.(serialized);
    const content = this.files.get(serialized);
    if (content === undefined) {
      throw new Error(`Missing test file ${serialized}.`);
    }
    return content.slice();
  }

  async *traverse() {
    // Proposal workflow tests do not enumerate workspace resources.
  }

  async enumerate() {
    return [];
  }

  async stat(uri: vscode.Uri): Promise<WorkspaceStat | undefined> {
    const serialized = uri.toString();
    const directoryGeneration = this.directoryGenerations.get(serialized);
    let stat: WorkspaceStat | undefined;
    if (directoryGeneration !== undefined) {
      stat = {
        type: 'directory',
        size: 0,
        ctime: directoryGeneration,
        mtime: directoryGeneration,
        readIdentity: {
          kind: 'trusted-provider',
          type: 'directory',
          size: 0,
          ctime: directoryGeneration,
          mtime: directoryGeneration,
        },
      };
    } else {
      const content = this.files.get(serialized);
      stat =
        content === undefined
          ? undefined
          : { type: 'file', size: content.byteLength, ctime: 0, mtime: 0 };
    }
    await this.afterStat?.(serialized, stat);
    return stat;
  }

  async write(uri: vscode.Uri, content: Uint8Array, options: WorkspaceWriteOptions): Promise<void> {
    const serialized = uri.toString();
    if (options.expected.kind === 'absent' && this.files.has(serialized)) {
      throw new Error(`Test target already exists: ${serialized}.`);
    }
    options.assertAuthorized?.();
    this.files.set(serialized, content.slice());
    this.writes.push(serialized);
    this.afterWrite?.(serialized);
  }
}

function workflowProposal(relativePaths: readonly string[]): ChangeSetProposal {
  return {
    operation: 'preview-tab-liveness',
    workspaceSafetyRootUri: workflowRoot,
    writeRootUri: workflowRoot,
    changes: relativePaths.map((relativePath) => ({
      targetUri: `${workflowRoot}/${relativePath}`,
      relativePath,
      operation: 'create',
      expected: { kind: 'absent' },
      encoding: 'utf8',
      proposedText: `${relativePath}\n`,
    })),
  };
}

function commandUi(confirm: (options: ConfirmationOptions) => Promise<boolean>): {
  readonly ui: CommandUi<vscode.Uri>;
  readonly errors: string[];
} {
  const errors: string[] = [];
  return {
    errors,
    ui: {
      async select<TValue extends string>(): Promise<TValue | undefined> {
        return undefined;
      },
      async input() {
        return undefined;
      },
      confirm,
      async showInformation() {},
      async showWarning() {},
      async showError(message) {
        errors.push(message);
      },
      async openDocument() {},
    },
  };
}

function workflowDependencies(
  workflowPort: PreviewWorkflowPort,
  previewer: VscodeProposalPreviewer,
  ui: CommandUi<vscode.Uri>,
) {
  return {
    port: workflowPort,
    uris: workflowUris,
    applicator: new ProposalApplicator(workflowPort, workflowUris),
    ui,
    previewer,
    workflowScheduler: new SerialProposalWorkflowScheduler(),
    isWorkspaceTrusted: () => true,
    captureWorkspaceFolderMembership: captureOpenWorkspaceFolderMembership,
  };
}

beforeEach(() => {
  vscodeState.providers.clear();
  vscodeState.registrations.length = 0;
  vscodeState.documents.clear();
  vscodeState.tabs.length = 0;
  vscodeState.tabChangeListeners.clear();
  vscodeState.tabGroupChangeListeners.clear();
  vscodeState.tabListenerDisposals.length = 0;
  vscodeState.tabGroupListenerDisposals.length = 0;
  vscodeState.closeTabs.mockClear();
  vscodeState.showInformationMessage.mockReset();
  vscodeState.showWarningMessage.mockReset();
  vscodeState.executeCommand.mockClear();
});

describe('VS Code proposal confirmation', () => {
  it('does not retain a completed command while an informational notification remains open', async () => {
    let dismissNotification: (() => void) | undefined;
    vscodeState.showInformationMessage.mockReturnValue(
      new Promise<void>((resolve) => {
        dismissNotification = resolve;
      }),
    );
    const ui = new VscodeCommandUi();

    await expect(ui.showInformation('Bundle initialized.')).resolves.toBeUndefined();

    expect(vscodeState.showInformationMessage).toHaveBeenCalledWith('Bundle initialized.');
    dismissNotification?.();
  });

  it('does not fail a completed command when an informational notification throws', async () => {
    vscodeState.showInformationMessage.mockImplementation(() => {
      throw new Error('host notification failure');
    });
    const ui = new VscodeCommandUi();

    await expect(ui.showInformation('Bundle initialized.')).resolves.toBeUndefined();
  });

  it('keeps the editor interactive while the apply continuation is pending', async () => {
    vscodeState.showWarningMessage.mockResolvedValue('Apply changes');
    const ui = new VscodeCommandUi();

    await expect(
      ui.confirm({
        title: 'Regenerate indexes',
        detail: 'A complete path list is available in the preview summary.',
        confirmLabel: 'Apply changes',
        previewIdentity: confirmationPreviewIdentity,
        modeless: true,
      }),
    ).resolves.toBe(true);

    expect(vscodeState.showWarningMessage).toHaveBeenCalledWith(
      'OKF Preview #7 / target deadbeef: Regenerate indexes. Target: memfs://workspace/knowledge. A complete path list is available in the preview summary. Review the tabs with this exact preview identity, then choose Apply changes or Cancel.',
      { modal: false },
      'Apply changes',
      'Cancel',
    );
  });

  it('treats the explicit cancel action as refusal to apply', async () => {
    vscodeState.showWarningMessage.mockResolvedValue('Cancel');
    const ui = new VscodeCommandUi();

    await expect(
      ui.confirm({
        title: 'Regenerate indexes',
        detail: 'Review every diff.',
        confirmLabel: 'Apply changes',
        previewIdentity: confirmationPreviewIdentity,
        modeless: true,
      }),
    ).resolves.toBe(false);
  });

  it('uses a modeless warning for background availability failures', async () => {
    vscodeState.showWarningMessage.mockResolvedValue(undefined);
    const ui = new VscodeCommandUi();

    await ui.showWarning('Bundle unavailable.');

    expect(vscodeState.showWarningMessage).toHaveBeenCalledWith('Bundle unavailable.');
  });
});

describe('VS Code proposal preview storage', () => {
  it('reveals the exact active summary without changing proposal identity', async () => {
    const previewer = new VscodeProposalPreviewer(() => 'recoverable-summary');
    const session = await previewer.show(
      workflowProposal(['concept.md']),
      { title: 'Recoverable preview', summary: ['Review every proposed file'] },
      new PreviewWorkflowPort(),
      workflowUris,
    );
    const identityBeforeReveal = session.identity;

    await session.reveal();

    expect(session.identity).toBe(identityBeforeReveal);
    expect(vscode.window.showTextDocument).toHaveBeenLastCalledWith(
      expect.objectContaining({
        uri: expect.objectContaining({
          scheme: expect.stringContaining('okf-workbench-preview'),
        }),
      }),
      {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
        preview: false,
      },
    );
    expect(() => session.assertActive()).not.toThrow();
    await session.dispose();
    previewer.dispose();
  });

  it('opens a complete preview at the exact change-count limit', async () => {
    const previewer = new VscodeProposalPreviewer(() => 'count-limit');
    const paths = Array.from(
      { length: MAX_PROPOSAL_PREVIEW_CHANGES },
      (_, index) => `concept-${String(index)}.md`,
    );

    const session = await previewer.show(
      workflowProposal(paths),
      { title: 'Count boundary', summary: ['Every bounded change is visible'] },
      new PreviewWorkflowPort(),
      workflowUris,
    );

    expect(vscodeState.executeCommand).toHaveBeenCalledTimes(MAX_PROPOSAL_PREVIEW_CHANGES);
    expect(vscodeState.tabs).toHaveLength(MAX_PROPOSAL_PREVIEW_CHANGES + 1);
    expect(previewer.retainedDocumentCount).toBe(MAX_PROPOSAL_PREVIEW_CHANGES * 2 + 1);
    await session.dispose();
    previewer.dispose();
  });

  it('refuses one change beyond the limit before registering a provider or opening a tab', async () => {
    const previewer = new VscodeProposalPreviewer(() => 'count-overflow');
    const paths = Array.from(
      { length: MAX_PROPOSAL_PREVIEW_CHANGES + 1 },
      (_, index) => `concept-${String(index)}.md`,
    );
    const overLimitProposal = workflowProposal(paths);
    const readPort = new PreviewWorkflowPort();
    const readSpy = vi.spyOn(readPort, 'read');

    await expect(
      previewer.show(
        {
          ...overLimitProposal,
          changes: overLimitProposal.changes.map((change) => ({
            ...change,
            operation: 'update' as const,
            expected: {
              kind: 'sha256' as const,
              value: 'must-not-be-read',
              byteLength: 1,
            },
          })),
        },
        { title: 'Count overflow', summary: ['Must fail atomically'] },
        readPort,
        workflowUris,
      ),
    ).rejects.toThrow(`safe preview limit of ${String(MAX_PROPOSAL_PREVIEW_CHANGES)}`);
    expect(vscodeState.registrations).toEqual([]);
    expect(vscodeState.providers.size).toBe(0);
    expect(vscodeState.tabs).toEqual([]);
    expect(vscodeState.executeCommand).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
    expect(previewer.retainedDocumentCount).toBe(0);
    previewer.dispose();
  });

  it('opens a complete preview at the exact cumulative body-byte limit', async () => {
    const previewer = new VscodeProposalPreviewer(() => 'byte-limit');
    const fileCount = MAX_PROPOSAL_PREVIEW_BODY_BYTES / BUNDLE_READ_LIMITS.maxDocumentBytes;
    const exactBodyProposal = workflowProposal(
      Array.from({ length: fileCount }, (_, index) => `exact-${String(index)}.md`),
    );
    const boundedProposal: ChangeSetProposal = {
      ...exactBodyProposal,
      changes: exactBodyProposal.changes.map((change) => ({
        ...change,
        proposedText: 'a'.repeat(BUNDLE_READ_LIMITS.maxDocumentBytes),
      })),
    };

    const session = await previewer.show(
      boundedProposal,
      { title: 'Byte boundary', summary: ['The complete body is visible'] },
      new PreviewWorkflowPort(),
      workflowUris,
    );

    expect(vscodeState.tabs).toHaveLength(fileCount + 1);
    expect(previewer.retainedDocumentCount).toBe(fileCount * 2 + 1);
    await session.dispose();
    previewer.dispose();
  });

  it('refuses cumulative proposed content over budget before opening anything', async () => {
    const previewer = new VscodeProposalPreviewer(() => 'after-overflow');
    const exactFileCount = MAX_PROPOSAL_PREVIEW_BODY_BYTES / BUNDLE_READ_LIMITS.maxDocumentBytes;
    const baseProposal = workflowProposal(
      Array.from({ length: exactFileCount + 1 }, (_, index) => `oversized-${String(index)}.md`),
    );
    const oversizedProposal: ChangeSetProposal = {
      ...baseProposal,
      changes: baseProposal.changes.map((change, index) => ({
        ...change,
        proposedText:
          index < exactFileCount ? 'a'.repeat(BUNDLE_READ_LIMITS.maxDocumentBytes) : 'a',
      })),
    };

    await expect(
      previewer.show(
        oversizedProposal,
        { title: 'After overflow', summary: ['Must fail atomically'] },
        new PreviewWorkflowPort(),
        workflowUris,
      ),
    ).rejects.toThrow('before-and-after bodies exceed');
    expect(vscodeState.registrations).toEqual([]);
    expect(vscodeState.tabs).toEqual([]);
    expect(previewer.retainedDocumentCount).toBe(0);
    previewer.dispose();
  });

  it('refuses oversized existing content before registering or opening anything', async () => {
    const previewer = new VscodeProposalPreviewer(() => 'before-overflow');
    const read = vi.fn(async () => new Uint8Array(MAX_PROPOSAL_PREVIEW_BODY_BYTES + 1));
    const oversizedPort: WorkspacePort<vscode.Uri> = {
      ...port,
      read,
      stat: async (uri) =>
        uri.toString() === 'memfs://workspace/knowledge'
          ? { type: 'directory', size: 0, ctime: 0, mtime: 0 }
          : {
              type: 'file',
              size: MAX_PROPOSAL_PREVIEW_BODY_BYTES + 1,
              ctime: 0,
              mtime: 0,
            },
    };
    const existingProposal: ChangeSetProposal = {
      ...proposal,
      changes: proposal.changes.map((change) => ({ ...change, proposedText: '' })),
    };

    await expect(
      previewer.show(
        existingProposal,
        { title: 'Before overflow', summary: ['Must fail atomically'] },
        oversizedPort,
        uris,
      ),
    ).rejects.toThrow('byte length');
    expect(read).not.toHaveBeenCalled();
    expect(vscodeState.registrations).toEqual([]);
    expect(vscodeState.tabs).toEqual([]);
    expect(previewer.retainedDocumentCount).toBe(0);
    previewer.dispose();
  });

  it('does not open a partial preview when a later snapshot read fails', async () => {
    const previewer = new VscodeProposalPreviewer(() => 'later-read-failure');
    let reads = 0;
    const failingPort: WorkspacePort<vscode.Uri> = {
      ...port,
      stat: async (uri) =>
        uri.toString() === 'memfs://workspace/knowledge'
          ? { type: 'directory', size: 0, ctime: 0, mtime: 0 }
          : { type: 'file', size: 7, ctime: 0, mtime: 0 },
      read: async () => {
        reads += 1;
        if (reads === 2) {
          throw new Error('Second snapshot unavailable.');
        }
        return encoder.encode('before\n');
      },
    };
    const firstChange = proposal.changes[0];
    if (firstChange === undefined) {
      throw new Error('Expected the preview fixture change.');
    }
    const multiReadProposal: ChangeSetProposal = {
      ...proposal,
      changes: [
        { ...firstChange, targetUri: `${workflowRoot}/first.md`, relativePath: 'first.md' },
        { ...firstChange, targetUri: `${workflowRoot}/second.md`, relativePath: 'second.md' },
      ],
    };

    await expect(
      previewer.show(
        multiReadProposal,
        { title: 'Read failure', summary: ['Must fail atomically'] },
        failingPort,
        uris,
      ),
    ).rejects.toThrow('Second snapshot unavailable');
    expect(reads).toBe(2);
    expect(vscodeState.registrations).toEqual([]);
    expect(vscodeState.tabs).toEqual([]);
    expect(previewer.retainedDocumentCount).toBe(0);
    previewer.dispose();
  });

  it('refuses an absent create target when its existing parent generation changes with a collision', async () => {
    const previewer = new VscodeProposalPreviewer(() => 'create-parent-collision');
    const nestedParent = `${workflowRoot}/nested`;
    const target = `${nestedParent}/new.md`;
    const collisionPort = new PreviewWorkflowPort();
    collisionPort.directoryGenerations.set(nestedParent, 1);
    let collisionInstalled = false;
    collisionPort.afterStat = (uri, stat) => {
      if (uri !== target || stat !== undefined || collisionInstalled) {
        return;
      }
      collisionInstalled = true;
      collisionPort.files.set(target, encoder.encode('colliding content\n'));
      collisionPort.directoryGenerations.set(nestedParent, 2);
    };

    await expect(
      previewer.show(
        workflowProposal(['nested/new.md']),
        { title: 'Create collision', summary: ['Must fail before presentation'] },
        collisionPort,
        workflowUris,
      ),
    ).rejects.toThrow('directory generation changed');
    expect(collisionInstalled).toBe(true);
    expect(vscodeState.registrations).toEqual([]);
    expect(vscodeState.providers.size).toBe(0);
    expect(vscodeState.documents.size).toBe(0);
    expect(vscodeState.tabs).toEqual([]);
    expect(vscodeState.executeCommand).not.toHaveBeenCalled();
    expect(previewer.retainedDocumentCount).toBe(0);
    previewer.dispose();
  });

  it('refuses every preview body when an earlier nested parent changes during a later target read', async () => {
    const previewer = new VscodeProposalPreviewer(() => 'earlier-parent-later-read');
    const earlierDirectory = `${workflowRoot}/earlier`;
    const earlierParent = `${earlierDirectory}/nested`;
    const laterDirectory = `${workflowRoot}/later`;
    const laterParent = `${laterDirectory}/nested`;
    const earlierTarget = `${earlierParent}/first.md`;
    const laterTarget = `${laterParent}/second.md`;
    const snapshotPort = new PreviewWorkflowPort();
    for (const directory of [earlierDirectory, earlierParent, laterDirectory, laterParent]) {
      snapshotPort.directoryGenerations.set(directory, 1);
    }
    snapshotPort.files.set(earlierTarget, encoder.encode('before\n'));
    snapshotPort.files.set(laterTarget, encoder.encode('before\n'));
    const laterReadStarted = deferred<undefined>();
    const releaseLaterRead = deferred<undefined>();
    snapshotPort.beforeRead = async (uri) => {
      if (uri !== laterTarget) {
        return;
      }
      laterReadStarted.resolve(undefined);
      await releaseLaterRead.promise;
    };
    const fixtureChange = proposal.changes[0];
    if (fixtureChange === undefined) {
      throw new Error('Expected the preview fixture change.');
    }
    const multiChangeProposal: ChangeSetProposal = {
      ...proposal,
      changes: [
        {
          ...fixtureChange,
          targetUri: earlierTarget,
          relativePath: 'earlier/nested/first.md',
        },
        {
          ...fixtureChange,
          targetUri: laterTarget,
          relativePath: 'later/nested/second.md',
        },
      ],
    };

    const showPromise = previewer.show(
      multiChangeProposal,
      { title: 'Nested parent race', summary: ['Must fail before presentation'] },
      snapshotPort,
      workflowUris,
    );
    await laterReadStarted.promise;
    snapshotPort.directoryGenerations.set(earlierParent, 2);
    releaseLaterRead.resolve(undefined);

    await expect(showPromise).rejects.toThrow('directory generation changed');
    expect(vscodeState.registrations).toEqual([]);
    expect(vscodeState.providers.size).toBe(0);
    expect(vscodeState.documents.size).toBe(0);
    expect(vscodeState.tabs).toEqual([]);
    expect(vscodeState.executeCommand).not.toHaveBeenCalled();
    expect(previewer.retainedDocumentCount).toBe(0);
    previewer.dispose();
  });

  it('opens a generated summary at the exact byte limit', async () => {
    const previewer = new VscodeProposalPreviewer(() => 'summary-boundary');
    const boundedProposal = workflowProposal(['summary.md']);
    const maximumLengthIdentity = {
      id: `okf-preview-ffffffff-ffff-ffff-ffff-ffffffffffff-${'9'.repeat(16)}-target-ffffffff`,
      label: `OKF Preview ffffffff #${'9'.repeat(16)} / target ffffffff`,
      targetUri: workflowRoot,
    };
    const emptyPresentation = { title: 'Summary boundary', summary: [''] };
    const emptyBytes = Buffer.byteLength(
      renderProposalPreviewSummary(boundedProposal, emptyPresentation, maximumLengthIdentity),
      'utf8',
    );
    const presentationAtLimit = {
      ...emptyPresentation,
      summary: ['s'.repeat(MAX_PROPOSAL_PREVIEW_SUMMARY_BYTES - emptyBytes)],
    };

    const session = await previewer.show(
      boundedProposal,
      presentationAtLimit,
      new PreviewWorkflowPort(),
      workflowUris,
    );
    const summaryDocument = [...vscodeState.documents.entries()].find(([uri]) =>
      uri.includes('-summary.md'),
    )?.[1];

    expect(Buffer.byteLength(summaryDocument?.content ?? '', 'utf8')).toBe(
      MAX_PROPOSAL_PREVIEW_SUMMARY_BYTES,
    );
    await session.dispose();
    previewer.dispose();
  });

  it('bounds the generated complete-path summary before opening a tab', async () => {
    const previewer = new VscodeProposalPreviewer(() => 'summary-overflow');

    await expect(
      previewer.show(
        workflowProposal(['summary.md']),
        {
          title: 'Summary overflow',
          summary: ['s'.repeat(MAX_PROPOSAL_PREVIEW_SUMMARY_BYTES + 1)],
        },
        new PreviewWorkflowPort(),
        workflowUris,
      ),
    ).rejects.toThrow('complete proposed-path summary exceeds');
    expect(vscodeState.registrations).toEqual([]);
    expect(vscodeState.tabs).toEqual([]);
    expect(previewer.retainedDocumentCount).toBe(0);
    previewer.dispose();
  });

  it('refuses approval when the required summary tab is closed and reopened', async () => {
    const previewer = new VscodeProposalPreviewer();
    const workflowPort = new PreviewWorkflowPort();
    const { ui, errors } = commandUi(async () => {
      const summary = summaryTab();
      if (!(summary.input instanceof vscode.TabInputText)) {
        throw new Error('Expected a text summary tab.');
      }
      const reopened = { input: new vscode.TabInputText(summary.input.uri) };
      removeTab(summary);
      vscodeState.tabs.push(reopened);
      emitTabChange({ opened: [reopened] });
      return true;
    });

    const result = await runProposalWorkflow(
      workflowDependencies(workflowPort, previewer, ui),
      workflowProposal(['first.md']),
      { title: 'Preview tab liveness', summary: ['Review every tab'] },
    );

    expect(result).toMatchObject({
      kind: 'refused',
      problems: [{ code: 'preview-unavailable' }],
    });
    expect(errors.at(-1)).toContain('approved preview closed');
    expect(workflowPort.writes).toEqual([]);
    expect(vscodeState.tabChangeListeners.size).toBe(0);
    expect(vscodeState.tabGroupChangeListeners.size).toBe(0);
    previewer.dispose();
  });

  it('refuses every write when one required diff closes during the compatibility guard', async () => {
    const previewer = new VscodeProposalPreviewer();
    const workflowPort = new PreviewWorkflowPort();
    const guardStarted = deferred<undefined>();
    const releaseGuard = deferred<undefined>();
    const { ui } = commandUi(async () => true);
    const workflow = runProposalWorkflow(
      workflowDependencies(workflowPort, previewer, ui),
      workflowProposal(['first.md', 'second.md']),
      { title: 'Preview tab liveness', summary: ['Review every tab'] },
      {
        beforeApply: async () => {
          guardStarted.resolve(undefined);
          await releaseGuard.promise;
          return undefined;
        },
      },
    );

    await guardStarted.promise;
    removeTab(firstDiffTab());
    releaseGuard.resolve(undefined);

    await expect(workflow).resolves.toMatchObject({
      kind: 'refused',
      problems: [{ code: 'preview-unavailable' }],
    });
    expect(workflowPort.writes).toEqual([]);
    previewer.dispose();
  });

  it('stops remaining writes when a required diff is replaced after the first write', async () => {
    const previewer = new VscodeProposalPreviewer();
    const workflowPort = new PreviewWorkflowPort();
    workflowPort.afterWrite = (uri) => {
      if (uri === `${workflowRoot}/first.md`) {
        replaceTab(firstDiffTab(), {
          input: new vscode.TabInputText(vscode.Uri.parse('file:///replacement-note.md')),
        });
      }
    };
    const { ui } = commandUi(async () => true);

    const result = await runProposalWorkflow(
      workflowDependencies(workflowPort, previewer, ui),
      workflowProposal(['first.md', 'second.md', 'third.md']),
      { title: 'Preview tab liveness', summary: ['Review every tab'] },
    );

    expect(result).toMatchObject({
      kind: 'failed',
      report: {
        completed: [`${workflowRoot}/first.md`],
        failed: [
          {
            targetUri: `${workflowRoot}/second.md`,
            code: 'preview-unavailable',
          },
        ],
        untouched: [`${workflowRoot}/third.md`],
      },
    });
    expect(workflowPort.writes).toEqual([`${workflowRoot}/first.md`]);
    previewer.dispose();
  });

  it('keeps the preview valid through unrelated tab and group changes', async () => {
    const previewer = new VscodeProposalPreviewer();
    const session = await previewer.show(
      proposal,
      { title: 'Preview indexes', summary: ['Review all files'] },
      port,
      uris,
    );
    const unrelated = {
      input: new vscode.TabInputText(vscode.Uri.parse('file:///unrelated-note.md')),
    };
    vscodeState.tabs.push(unrelated);
    emitTabChange({ opened: [unrelated] });
    emitTabChange({ changed: [unrelated] });
    vscodeState.tabs = vscodeState.tabs.map((tab) => ({ input: tab.input }));
    for (const listener of vscodeState.tabGroupChangeListeners) {
      listener({ opened: [{}], closed: [], changed: [{}] });
    }
    const resyncedUnrelated = vscodeState.tabs.find(
      (tab) =>
        tab.input instanceof vscode.TabInputText &&
        tab.input.uri.toString() === 'file:///unrelated-note.md',
    );
    if (resyncedUnrelated === undefined) {
      throw new Error('Expected the unrelated tab after host tab-model resynchronization.');
    }
    removeTab(resyncedUnrelated);

    expect(() => session.assertActive()).not.toThrow();
    await session.dispose();
    expect(vscodeState.tabChangeListeners.size).toBe(0);
    expect(vscodeState.tabGroupChangeListeners.size).toBe(0);
    expect(vscodeState.tabListenerDisposals[0]).toHaveBeenCalledTimes(1);
    expect(vscodeState.tabGroupListenerDisposals[0]).toHaveBeenCalledTimes(1);
    previewer.dispose();
  });

  it('permanently expires when a required tab is closed and reopened in one host event', async () => {
    const previewer = new VscodeProposalPreviewer();
    const session = await previewer.show(
      proposal,
      { title: 'Preview indexes', summary: ['Review all files'] },
      port,
      uris,
    );
    const summary = summaryTab();
    const reopened = { input: summary.input };
    const index = vscodeState.tabs.indexOf(summary);
    vscodeState.tabs[index] = reopened;
    emitTabChange({ opened: [reopened], closed: [summary] });

    expect(() => session.assertActive()).toThrow('required summary or diff tab');
    await session.dispose();
    previewer.dispose();
  });

  it('expires when the exact required tab input changes even if a duplicate identity remains', async () => {
    const previewer = new VscodeProposalPreviewer();
    const session = await previewer.show(
      proposal,
      { title: 'Preview indexes', summary: ['Review all files'] },
      port,
      uris,
    );
    const summary = summaryTab();
    const duplicate = { input: summary.input };
    vscodeState.tabs.push(duplicate);
    emitTabChange({ opened: [duplicate] });
    (summary as { input: unknown }).input = new vscode.TabInputText(
      vscode.Uri.parse('file:///repurposed-summary-tab.md'),
    );
    emitTabChange({ changed: [summary] });

    expect(() => session.assertActive()).toThrow('required summary or diff tab');
    await session.dispose();
    previewer.dispose();
  });

  it('detects a missing required tab synchronously even without a host tab event', async () => {
    const previewer = new VscodeProposalPreviewer();
    const session = await previewer.show(
      proposal,
      { title: 'Preview indexes', summary: ['Review all files'] },
      port,
      uris,
    );
    const summary = summaryTab();
    vscodeState.tabs = vscodeState.tabs.filter((tab) => tab !== summary);

    expect(() => session.assertActive()).toThrow('required summary or diff tab');
    await session.dispose();
    previewer.dispose();
  });

  it('closes only exact run-owned tabs and disposes every run registration and body', async () => {
    const previewer = new VscodeProposalPreviewer();
    const oldSummaries: {
      readonly uri: { toString(): string };
      readonly provider: {
        provideTextDocumentContent(uri: { toString(): string }): string | undefined;
      };
    }[] = [];
    const userTab = { input: new vscode.TabInputText(vscode.Uri.parse('file:///user-note.md')) };
    vscodeState.tabs.push(userTab);

    for (let run = 0; run < 3; run += 1) {
      const session = await previewer.show(
        proposal,
        { title: 'Preview indexes', summary: ['Review all files'] },
        port,
        uris,
      );
      expect(previewer.retainedDocumentCount).toBe(3);
      expect(vscodeState.providers.size).toBe(1);
      expect(vscodeState.tabs).toHaveLength(3);
      const registration = vscodeState.registrations.at(-1);
      const runToken = String(run + 1).padStart(16, '0');
      expect(registration?.scheme).toMatch(
        new RegExp(`^okf-workbench-preview-[0-9a-f-]{36}-${runToken}-[0-9a-f]{8}$`, 'u'),
      );
      expect(session.identity).toMatchObject({
        id: expect.stringMatching(`^okf-preview-[0-9a-f-]{36}-${runToken}-target-[0-9a-f]{8}$`),
        label: expect.stringContaining(`#${runToken} / target`),
        targetUri: proposal.writeRootUri,
      });
      expect(vscodeState.executeCommand.mock.calls.at(-1)?.[3]).toContain(session.identity.label);
      expect(vscodeState.executeCommand.mock.calls.at(-1)?.[3]).toContain(proposal.writeRootUri);
      const summary = vscode.Uri.from({
        scheme: registration?.scheme ?? 'missing-preview-registration',
        authority: 'readonly',
        path: `/${session.identity.id}/000-${session.identity.id}-summary.md`,
      });
      if (registration !== undefined) {
        oldSummaries.push({ uri: summary, provider: registration.provider });
      }

      await Promise.all([session.dispose(), session.dispose()]);
      expect(previewer.retainedDocumentCount).toBe(0);
      expect(vscodeState.providers.size).toBe(0);
      expect(registration?.dispose).toHaveBeenCalledTimes(1);
      expect(vscodeState.closeTabs.mock.calls.at(-1)?.[0]).toHaveLength(2);
      expect(vscodeState.closeTabs.mock.calls.at(-1)?.[1]).toBe(true);
      expect(vscodeState.closeTabs.mock.invocationCallOrder.at(-1)).toBeLessThan(
        registration?.dispose.mock.invocationCallOrder[0] ?? 0,
      );
      expect(vscodeState.tabs).toEqual([userTab]);
    }

    for (const { uri, provider } of oldSummaries) {
      expect(provider.provideTextDocumentContent(uri)).toContain('OKF preview expired');
    }
    previewer.dispose();
  });

  it('uses a fresh activation nonce so cached first-run documents cannot survive a restart', async () => {
    const staleProposal: ChangeSetProposal = {
      ...proposal,
      changes: proposal.changes.map((change) => ({
        ...change,
        proposedText: 'stale activation content\n',
      })),
    };
    const currentProposal: ChangeSetProposal = {
      ...proposal,
      changes: proposal.changes.map((change) => ({
        ...change,
        proposedText: 'current activation content\n',
      })),
    };
    const stalePreviewer = new VscodeProposalPreviewer(() => 'activation-one');
    const staleSession = await stalePreviewer.show(
      staleProposal,
      { title: 'Stale activation', summary: ['Old host content'] },
      port,
      uris,
    );
    const staleScheme = vscodeState.registrations[0]?.scheme;

    // Model an abrupt Extension Host restart: editor tabs/documents survive, host providers and
    // listeners do not get an orderly disposal callback.
    vscodeState.providers.clear();
    vscodeState.tabChangeListeners.clear();
    vscodeState.tabGroupChangeListeners.clear();

    const currentPreviewer = new VscodeProposalPreviewer(() => 'activation-two');
    const currentSession = await currentPreviewer.show(
      currentProposal,
      { title: 'Current activation', summary: ['New host content'] },
      port,
      uris,
    );
    const currentScheme = vscodeState.registrations[1]?.scheme;
    const staleAfterDocument = [...vscodeState.documents.entries()].find(
      ([uri]) => uri.startsWith(`${staleScheme ?? 'missing'}:`) && uri.includes('-after.md'),
    )?.[1];
    const currentAfterDocument = [...vscodeState.documents.entries()].find(
      ([uri]) => uri.startsWith(`${currentScheme ?? 'missing'}:`) && uri.includes('-after.md'),
    )?.[1];

    expect(staleScheme).toMatch(/^okf-workbench-preview-[0-9a-f-]{36}-/u);
    expect(currentScheme).toMatch(/^okf-workbench-preview-[0-9a-f-]{36}-/u);
    expect(currentScheme).not.toBe(staleScheme);
    expect(currentSession.identity.id).not.toBe(staleSession.identity.id);
    expect(staleAfterDocument?.content).toBe('stale activation content\n');
    expect(currentAfterDocument?.content).toBe('current activation content\n');
    expect(() => currentSession.assertActive()).not.toThrow();
    const currentSummaryTab = vscodeState.tabs.find(
      (tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === currentScheme,
    );
    if (currentSummaryTab === undefined) {
      throw new Error('Expected the current activation summary tab.');
    }
    removeTab(currentSummaryTab);
    expect(() => currentSession.assertActive()).toThrow('required summary or diff tab');

    await currentSession.dispose();
    await staleSession.dispose();
    currentPreviewer.dispose();
    stalePreviewer.dispose();
  });

  it('releases a partially opened run when VS Code cannot open a diff', async () => {
    vscodeState.executeCommand.mockRejectedValueOnce(new Error('Diff editor unavailable.'));
    const previewer = new VscodeProposalPreviewer();
    const userTab = { input: new vscode.TabInputText(vscode.Uri.parse('file:///user-note.md')) };
    vscodeState.tabs.push(userTab);

    await expect(
      previewer.show(
        proposal,
        { title: 'Preview indexes', summary: ['Review all files'] },
        port,
        uris,
      ),
    ).rejects.toThrow('Diff editor unavailable.');
    expect(previewer.retainedDocumentCount).toBe(0);
    expect(vscodeState.providers.size).toBe(0);
    expect(vscodeState.registrations[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(vscodeState.tabs).toEqual([userTab]);

    previewer.dispose();
  });

  it('drops provider bytes and registration even when the editor rejects tab cleanup', async () => {
    vscodeState.closeTabs.mockRejectedValueOnce(new Error('Tab close unavailable.'));
    const previewer = new VscodeProposalPreviewer();
    const session = await previewer.show(
      proposal,
      { title: 'Preview indexes', summary: ['Review all files'] },
      port,
      uris,
    );

    await expect(session.dispose()).resolves.toBeUndefined();
    expect(previewer.retainedDocumentCount).toBe(0);
    expect(vscodeState.providers.size).toBe(0);
    expect(vscodeState.registrations[0]?.dispose).toHaveBeenCalledTimes(1);

    previewer.dispose();
  });

  it('releases an active run when the host disposes the preview service', async () => {
    const previewer = new VscodeProposalPreviewer();
    await previewer.show(
      proposal,
      { title: 'Preview indexes', summary: ['Review all files'] },
      port,
      uris,
    );

    previewer.dispose();

    await vi.waitFor(() => {
      expect(previewer.retainedDocumentCount).toBe(0);
      expect(vscodeState.providers.size).toBe(0);
      expect(vscodeState.tabs).toEqual([]);
    });
    await expect(
      previewer.show(
        proposal,
        { title: 'Preview indexes', summary: ['Review all files'] },
        port,
        uris,
      ),
    ).rejects.toThrow('disposed');
  });

  it('re-cleans a diff that finishes opening after host disposal', async () => {
    const allowLateDiff = deferred<undefined>();
    vscodeState.executeCommand.mockImplementationOnce(
      async (_command: string, before: vscode.Uri, after: vscode.Uri) => {
        vscodeState.providers.get(before.scheme)?.provideTextDocumentContent(before);
        vscodeState.providers.get(after.scheme)?.provideTextDocumentContent(after);
        await allowLateDiff.promise;
        vscodeState.tabs.push({ input: new vscode.TabInputTextDiff(before, after) });
      },
    );
    const previewer = new VscodeProposalPreviewer();
    const showing = previewer.show(
      proposal,
      { title: 'Preview indexes', summary: ['Review all files'] },
      port,
      uris,
    );
    await vi.waitFor(() => {
      expect(vscodeState.executeCommand).toHaveBeenCalledTimes(1);
    });
    const registration = vscodeState.registrations[0];

    previewer.dispose();
    await vi.waitFor(() => {
      expect(previewer.retainedDocumentCount).toBe(0);
      expect(vscodeState.providers.size).toBe(0);
    });
    allowLateDiff.resolve(undefined);

    await expect(showing).rejects.toThrow('disposed before previewing completed');
    await vi.waitFor(() => {
      expect(vscodeState.tabs).toEqual([]);
    });
    expect(registration?.dispose).toHaveBeenCalledTimes(1);
    expect(
      registration?.provider.provideTextDocumentContent(vscode.Uri.parse('unknown:old')),
    ).toContain('OKF preview expired');
  });
});
