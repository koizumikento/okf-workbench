import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';

import * as vscode from 'vscode';

import type { ChangeSetProposal } from '../../core/model/index.js';
import type {
  ProposalPresentation,
  ProposalPreviewIdentity,
  ProposalPreviewer,
  ProposalPreviewSession,
} from '../commands/types.js';
import { matchesSha256 } from '../workspace/contentHash.js';
import {
  captureWorkspaceDirectoryChain,
  captureWorkspaceOptionalResourceParentChain,
  captureWorkspaceResourceParentChain,
  verifyWorkspaceDirectoryChain,
  type WorkspaceDirectoryChainSnapshot,
} from '../workspace/directorySafety.js';
import { assertExpectedByteLength, readWorkspaceFileWithinLimit } from '../workspace/readSafety.js';
import { WorkspaceAccessError, type WorkspacePort } from '../workspace/types.js';
import type { WorkspaceUriCodec } from '../workspace/uriCodec.js';
import {
  inspectProposalPreviewFeasibility,
  MAX_PROPOSAL_PREVIEW_SUMMARY_BYTES,
  renderProposalPreviewSummary,
} from './proposal-preview-budget.js';

const PREVIEW_SCHEME_PREFIX = 'okf-workbench-preview';
const EXPIRED_PREVIEW_TEXT =
  '# OKF preview expired\n\nRe-run the originating OKF command to create a current preview.\n';

function previewLimitError(message: string): Error {
  return new Error(
    `${message} Narrow the operation or split the knowledge bundle before retrying; no preview tabs were opened.`,
  );
}

class PreviewDocumentProvider implements vscode.TextDocumentContentProvider {
  readonly #documents = new Map<string, string>();

  provideTextDocumentContent(uri: vscode.Uri): string | undefined {
    return this.#documents.get(uri.toString()) ?? EXPIRED_PREVIEW_TEXT;
  }

  add(uri: vscode.Uri, content: string): void {
    this.#documents.set(uri.toString(), content);
  }

  clear(): void {
    this.#documents.clear();
  }

  get size(): number {
    return this.#documents.size;
  }
}

function previewUri(
  scheme: string,
  identity: ProposalPreviewIdentity,
  index: number,
  side: 'before' | 'after' | 'summary',
): vscode.Uri {
  return vscode.Uri.from({
    scheme,
    authority: 'readonly',
    path: `/${identity.id}/${String(index).padStart(3, '0')}-${identity.id}-${side}.md`,
  });
}

function targetFingerprint(targetUri: string): string {
  let hash = 0x81_1c_9d_c5;
  for (let index = 0; index < targetUri.length; index += 1) {
    hash ^= targetUri.charCodeAt(index);
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function previewIdentity(
  activationNonce: string,
  run: number,
  targetUri: string,
): ProposalPreviewIdentity {
  const fingerprint = targetFingerprint(targetUri);
  const runToken = String(run).padStart(16, '0');
  return {
    id: `okf-preview-${activationNonce}-${runToken}-target-${fingerprint}`,
    label: `OKF Preview ${activationNonce.slice(0, 8)} #${runToken} / target ${fingerprint}`,
    targetUri,
  };
}

function normalizeActivationNonce(source: string): string {
  if (source.length === 0 || source.length > 1024) {
    throw new Error('The proposal preview activation nonce source has an invalid length.');
  }
  const digest = createHash('sha256').update(source, 'utf8').digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function previewTabs(ownedUris: ReadonlySet<string>): vscode.Tab[] {
  const tabs: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText && ownedUris.has(tab.input.uri.toString())) {
        tabs.push(tab);
        continue;
      }
      if (
        tab.input instanceof vscode.TabInputTextDiff &&
        ownedUris.has(tab.input.original.toString()) &&
        ownedUris.has(tab.input.modified.toString())
      ) {
        tabs.push(tab);
      }
    }
  }
  return tabs;
}

type RequiredPreviewTabIdentity =
  | { readonly kind: 'summary'; readonly uri: string }
  | { readonly kind: 'diff'; readonly original: string; readonly modified: string };

interface RequiredPreviewTab {
  /** A closed VS Code Tab object is permanently invalid, even if the same URI is reopened. */
  tab: vscode.Tab;
  readonly identity: RequiredPreviewTabIdentity;
}

function tabMatchesIdentity(tab: vscode.Tab, identity: RequiredPreviewTabIdentity): boolean {
  if (identity.kind === 'summary') {
    return tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === identity.uri;
  }
  return (
    tab.input instanceof vscode.TabInputTextDiff &&
    tab.input.original.toString() === identity.original &&
    tab.input.modified.toString() === identity.modified
  );
}

function findTab(identity: RequiredPreviewTabIdentity): vscode.Tab | undefined {
  for (const group of vscode.window.tabGroups.all) {
    const tab = group.tabs.find((candidate) => tabMatchesIdentity(candidate, identity));
    if (tab !== undefined) {
      return tab;
    }
  }
  return undefined;
}

interface ActivePreviewSession {
  readonly identity: ProposalPreviewIdentity;
  readonly provider: PreviewDocumentProvider;
  readonly assertActive: () => void;
  readonly reveal: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}

interface PreparedPreviewChange {
  readonly proposal: ChangeSetProposal['changes'][number];
  readonly beforeText: string;
}

interface PreparedPreview {
  readonly summary: string;
  readonly changes: readonly PreparedPreviewChange[];
}

async function preparePreview(
  proposal: ChangeSetProposal,
  presentation: ProposalPresentation,
  identity: ProposalPreviewIdentity,
  port: WorkspacePort<vscode.Uri>,
  uris: WorkspaceUriCodec<vscode.Uri>,
  assertServiceActive: () => void,
): Promise<PreparedPreview> {
  const feasibility = inspectProposalPreviewFeasibility(proposal, presentation);
  if (!feasibility.ready) {
    throw previewLimitError(feasibility.problem.message);
  }
  const workspaceSafetyRoot = uris.parse(proposal.workspaceSafetyRootUri);
  const writeRoot = uris.parse(proposal.writeRootUri);
  const directoryChain = await captureWorkspaceDirectoryChain(
    workspaceSafetyRoot,
    writeRoot,
    port,
    uris,
  );
  if (!directoryChain.ok) {
    throw new WorkspaceAccessError('unavailable', directoryChain.failure.message);
  }
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const changes: PreparedPreviewChange[] = [];
  const retainedParentChains = new Map<string, WorkspaceDirectoryChainSnapshot<vscode.Uri>>();
  const retainParentChain = (snapshot: WorkspaceDirectoryChainSnapshot<vscode.Uri>): void => {
    const key = uris.serialize(snapshot.selectedRoot);
    if (!retainedParentChains.has(key)) {
      retainedParentChains.set(key, snapshot);
    }
  };
  const absentParentTargets = new Map<string, vscode.Uri>();
  for (const change of proposal.changes) {
    let beforeText = '';
    const target = uris.parse(change.targetUri);
    if (change.expected.kind === 'absent') {
      const parentChain = await captureWorkspaceOptionalResourceParentChain(
        workspaceSafetyRoot,
        target,
        port,
        uris,
      );
      if (!parentChain.ok) {
        throw new WorkspaceAccessError('unavailable', parentChain.failure.message);
      }
      retainParentChain(parentChain.snapshot);
      if (parentChain.parentExists) {
        const stat = await port.stat(target);
        const [changedParent, changedWriteRoot] = await Promise.all([
          verifyWorkspaceDirectoryChain(parentChain.snapshot, port, uris),
          verifyWorkspaceDirectoryChain(directoryChain.snapshot, port, uris),
        ]);
        if (changedParent !== undefined || changedWriteRoot !== undefined) {
          throw new WorkspaceAccessError(
            'unavailable',
            changedParent?.message ??
              changedWriteRoot?.message ??
              'The preview target directory changed.',
          );
        }
        if (stat !== undefined) {
          throw new WorkspaceAccessError(
            'content-mismatch',
            `The create preview target ${change.targetUri} now exists. Refresh the preview before applying.`,
          );
        }
      } else {
        absentParentTargets.set(change.targetUri, target);
      }
    } else {
      const parentChain = await captureWorkspaceResourceParentChain(
        workspaceSafetyRoot,
        target,
        port,
        uris,
      );
      if (!parentChain.ok) {
        throw new WorkspaceAccessError('unavailable', parentChain.failure.message);
      }
      retainParentChain(parentChain.snapshot);
      const changedWriteRoot = await verifyWorkspaceDirectoryChain(
        directoryChain.snapshot,
        port,
        uris,
      );
      if (changedWriteRoot !== undefined) {
        throw new WorkspaceAccessError('unavailable', changedWriteRoot.message);
      }
      const stat = await port.stat(target);
      assertServiceActive();
      if (stat?.type !== 'file') {
        throw new WorkspaceAccessError(
          'content-mismatch',
          `The original preview target ${change.targetUri} is no longer a regular file. Refresh the preview before applying.`,
        );
      }
      assertExpectedByteLength(stat.size, change.expected.byteLength, change.targetUri);
      const changedBeforeRead = await verifyWorkspaceDirectoryChain(
        parentChain.snapshot,
        port,
        uris,
      );
      if (changedBeforeRead !== undefined) {
        throw new WorkspaceAccessError('unavailable', changedBeforeRead.message);
      }
      const beforeBytes = await readWorkspaceFileWithinLimit(port, target, {
        maxBytes: change.expected.byteLength,
        subject: change.targetUri,
        reportedStat: stat,
      });
      assertServiceActive();
      assertExpectedByteLength(
        beforeBytes.byteLength,
        change.expected.byteLength,
        change.targetUri,
      );
      if (!matchesSha256(beforeBytes, change.expected.value)) {
        throw new WorkspaceAccessError(
          'content-mismatch',
          `The original preview target ${change.targetUri} changed before the diff could be prepared.`,
        );
      }
      const [changedParent, changedDirectory] = await Promise.all([
        verifyWorkspaceDirectoryChain(parentChain.snapshot, port, uris),
        verifyWorkspaceDirectoryChain(directoryChain.snapshot, port, uris),
      ]);
      if (changedParent !== undefined || changedDirectory !== undefined) {
        throw new WorkspaceAccessError(
          'unavailable',
          changedParent?.message ??
            changedDirectory?.message ??
            'The preview target directory changed.',
        );
      }
      beforeText = decoder.decode(beforeBytes);
    }
    changes.push({ proposal: change, beforeText });
  }

  for (const [targetUri, target] of absentParentTargets) {
    const recaptured = await captureWorkspaceOptionalResourceParentChain(
      workspaceSafetyRoot,
      target,
      port,
      uris,
    );
    if (!recaptured.ok) {
      throw new WorkspaceAccessError('unavailable', recaptured.failure.message);
    }
    if (recaptured.parentExists) {
      throw new WorkspaceAccessError(
        'content-mismatch',
        `The create preview target parent for ${targetUri} appeared while the preview was being prepared. Refresh the preview before applying.`,
      );
    }
  }
  const changedBeforePresentation = await verifyWorkspaceDirectoryChain(
    directoryChain.snapshot,
    port,
    uris,
  );
  if (changedBeforePresentation !== undefined) {
    throw new WorkspaceAccessError('unavailable', changedBeforePresentation.message);
  }
  const finalParentChanges = await Promise.all(
    [...retainedParentChains.values()].map((snapshot) =>
      verifyWorkspaceDirectoryChain(snapshot, port, uris),
    ),
  );
  const changedFinalParent = finalParentChanges.find((changed) => changed !== undefined);
  if (changedFinalParent !== undefined) {
    throw new WorkspaceAccessError('unavailable', changedFinalParent.message);
  }
  const summary = renderProposalPreviewSummary(proposal, presentation, identity);
  if (Buffer.byteLength(summary, 'utf8') > MAX_PROPOSAL_PREVIEW_SUMMARY_BYTES) {
    throw previewLimitError(
      `The complete proposed-path summary exceeds the safe preview limit of ${String(MAX_PROPOSAL_PREVIEW_SUMMARY_BYTES)} UTF-8 bytes.`,
    );
  }
  assertServiceActive();
  return { summary, changes };
}

/** Opens a read-only summary and one built-in VS Code diff per proposed file. */
export class VscodeProposalPreviewer implements ProposalPreviewer<vscode.Uri>, vscode.Disposable {
  readonly #sessions = new Set<ActivePreviewSession>();
  readonly #activationNonce: string;
  #run = 0;
  #disposed = false;

  constructor(createActivationNonce: () => string = randomUUID) {
    this.#activationNonce = normalizeActivationNonce(createActivationNonce());
  }

  /** Number of virtual-document bodies retained for active confirmation flows. */
  get retainedDocumentCount(): number {
    let count = 0;
    for (const session of this.#sessions) {
      count += session.provider.size;
    }
    return count;
  }

  async show(
    proposal: ChangeSetProposal,
    presentation: ProposalPresentation,
    port: WorkspacePort<vscode.Uri>,
    uris: WorkspaceUriCodec<vscode.Uri>,
  ): Promise<ProposalPreviewSession> {
    if (this.#disposed) {
      throw new Error('The proposal preview service has been disposed.');
    }
    this.#run += 1;
    if (!Number.isSafeInteger(this.#run)) {
      throw new Error('The proposal preview run counter is exhausted.');
    }
    const run = this.#run;
    const identity = previewIdentity(this.#activationNonce, run, proposal.writeRootUri);
    const scheme = `${PREVIEW_SCHEME_PREFIX}-${this.#activationNonce}-${String(run).padStart(16, '0')}-${targetFingerprint(proposal.writeRootUri)}`;
    const assertServiceActive = (): void => {
      if (this.#disposed) {
        throw new Error('The proposal preview service was disposed while preparing the preview.');
      }
    };
    const prepared = await preparePreview(
      proposal,
      presentation,
      identity,
      port,
      uris,
      assertServiceActive,
    );
    assertServiceActive();
    const provider = new PreviewDocumentProvider();
    const registration = vscode.workspace.registerTextDocumentContentProvider(scheme, provider);
    const ownedUris = new Set<string>();
    const requiredTabs: RequiredPreviewTab[] = [];
    let releaseStarted = false;
    let requiredTabInvalidated = false;
    let cleanupTail: Promise<void> = Promise.resolve();
    let registrationDisposed = false;
    let tabListener: vscode.Disposable | undefined;
    let tabGroupListener: vscode.Disposable | undefined;
    let summaryDocument: vscode.TextDocument | undefined;
    const requiredTabsPresent = (): boolean => {
      const openTabs = new Set(vscode.window.tabGroups.all.flatMap((group) => group.tabs));
      return requiredTabs.every(
        (required) =>
          openTabs.has(required.tab) && tabMatchesIdentity(required.tab, required.identity),
      );
    };
    const invalidateIfRequiredTabMissing = (): void => {
      if (!releaseStarted && requiredTabs.length > 0 && !requiredTabsPresent()) {
        requiredTabInvalidated = true;
      }
    };
    const invalidateForExplicitTabChange = (event: vscode.TabChangeEvent): void => {
      if (releaseStarted || requiredTabInvalidated || requiredTabs.length === 0) {
        return;
      }
      for (const required of requiredTabs) {
        if (event.closed.includes(required.tab)) {
          requiredTabInvalidated = true;
          return;
        }
        if (
          event.changed.includes(required.tab) &&
          !tabMatchesIdentity(required.tab, required.identity)
        ) {
          requiredTabInvalidated = true;
          return;
        }
      }
    };
    const rebindAfterHostGroupModelChange = (): void => {
      if (releaseStarted || requiredTabInvalidated || requiredTabs.length === 0) {
        return;
      }
      const openTabs = new Set(vscode.window.tabGroups.all.flatMap((group) => group.tabs));
      for (const required of requiredTabs) {
        if (openTabs.has(required.tab) && tabMatchesIdentity(required.tab, required.identity)) {
          continue;
        }
        const replacement = [...openTabs].filter((tab) =>
          tabMatchesIdentity(tab, required.identity),
        );
        if (replacement.length !== 1) {
          requiredTabInvalidated = true;
          return;
        }
        required.tab = replacement[0] as vscode.Tab;
      }
    };
    const assertActive = (): void => {
      if (this.#disposed || releaseStarted) {
        throw new Error(`The ${identity.label} service was disposed before previewing completed.`);
      }
      invalidateIfRequiredTabMissing();
      if (requiredTabInvalidated) {
        throw new Error(
          `The ${identity.label} approval expired because a required summary or diff tab was closed or replaced.`,
        );
      }
    };
    const trackRequiredTab = (requiredIdentity: RequiredPreviewTabIdentity): void => {
      assertActive();
      const tab = findTab(requiredIdentity);
      if (tab === undefined) {
        requiredTabInvalidated = true;
        assertActive();
        return;
      }
      requiredTabs.push({ tab, identity: requiredIdentity });
      assertActive();
    };
    const disposeTabListeners = (): void => {
      try {
        tabListener?.dispose();
      } catch {
        // A host listener failure must not retain proposal bodies or prevent tab cleanup.
      }
      tabListener = undefined;
      try {
        tabGroupListener?.dispose();
      } catch {
        // A host listener failure must not retain proposal bodies or prevent tab cleanup.
      }
      tabGroupListener = undefined;
    };
    const session: ActivePreviewSession = {
      identity,
      provider,
      assertActive,
      reveal: async () => {
        assertActive();
        if (summaryDocument === undefined) {
          throw new Error(`The ${identity.label} summary is not available.`);
        }
        await vscode.window.showTextDocument(summaryDocument, {
          viewColumn: vscode.ViewColumn.Beside,
          preserveFocus: false,
          preview: false,
        });
        rebindAfterHostGroupModelChange();
        assertActive();
      },
      dispose: () => {
        releaseStarted = true;
        disposeTabListeners();
        provider.clear();
        this.#sessions.delete(session);
        cleanupTail = cleanupTail.then(async () => {
          try {
            const tabs = previewTabs(ownedUris);
            if (tabs.length > 0) {
              await vscode.window.tabGroups.close(tabs, true);
            }
          } catch {
            // Preview cleanup must not turn an applied or cancelled proposal into a command error.
          } finally {
            provider.clear();
            this.#sessions.delete(session);
            if (!registrationDisposed) {
              registrationDisposed = true;
              try {
                registration.dispose();
              } catch {
                // The provider no longer retains proposal bodies even if host disposal fails.
              }
            }
          }
        });
        return cleanupTail;
      },
    };
    this.#sessions.add(session);
    const addDocument = (uri: vscode.Uri, content: string): void => {
      assertActive();
      ownedUris.add(uri.toString());
      provider.add(uri, content);
    };

    try {
      tabListener = vscode.window.tabGroups.onDidChangeTabs((event) => {
        invalidateForExplicitTabChange(event);
      });
      tabGroupListener = vscode.window.tabGroups.onDidChangeTabGroups(() => {
        rebindAfterHostGroupModelChange();
      });

      const summary = previewUri(scheme, identity, 0, 'summary');
      addDocument(summary, prepared.summary);
      summaryDocument = await vscode.workspace.openTextDocument(summary);
      assertActive();
      await vscode.window.showTextDocument(summaryDocument, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: true,
        preview: false,
      });
      assertActive();
      trackRequiredTab({ kind: 'summary', uri: summary.toString() });

      for (const [index, preparedChange] of prepared.changes.entries()) {
        const change = preparedChange.proposal;
        const before = previewUri(scheme, identity, index + 1, 'before');
        const after = previewUri(scheme, identity, index + 1, 'after');
        addDocument(before, preparedChange.beforeText);
        addDocument(after, change.proposedText);
        await vscode.commands.executeCommand(
          'vscode.diff',
          before,
          after,
          `${identity.label} · ${identity.targetUri} · ${change.relativePath}`,
          { preview: false, preserveFocus: true },
        );
        assertActive();
        trackRequiredTab({
          kind: 'diff',
          original: before.toString(),
          modified: after.toString(),
        });
      }
      assertActive();
      return { identity, assertActive, reveal: session.reveal, dispose: session.dispose };
    } catch (error) {
      await session.dispose();
      throw error;
    }
  }

  dispose(): void {
    this.#disposed = true;
    for (const session of [...this.#sessions]) {
      void session.dispose();
    }
  }
}
