import * as vscode from 'vscode';

import type { ChangeSetProposal } from '../../core/model/index.js';
import type {
  ProposalPresentation,
  ProposalPreviewer,
  ProposalPreviewSession,
} from '../commands/types.js';
import type { WorkspacePort } from '../workspace/types.js';
import type { WorkspaceUriCodec } from '../workspace/uriCodec.js';

const PREVIEW_SCHEME = 'okf-workbench-preview';
const EXPIRED_PREVIEW_TEXT =
  '# OKF preview expired\n\nRe-run the originating OKF command to create a current preview.\n';

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

  delete(uri: vscode.Uri): void {
    this.#documents.delete(uri.toString());
  }

  get size(): number {
    return this.#documents.size;
  }
}

function previewUri(run: number, index: number, side: 'before' | 'after' | 'summary'): vscode.Uri {
  return vscode.Uri.from({
    scheme: PREVIEW_SCHEME,
    authority: 'readonly',
    path: `/run-${run}/${String(index).padStart(3, '0')}-${side}.md`,
  });
}

function summaryText(proposal: ChangeSetProposal, presentation: ProposalPresentation): string {
  const lines = [
    `# ${presentation.title}`,
    '',
    ...presentation.summary.map((line) => `- ${line}`),
    '',
    '## Complete proposed path list',
    '',
    ...proposal.changes.map(
      (change, index) =>
        `${index + 1}. \`${change.relativePath}\` (${change.operation})\n   - ${change.targetUri}`,
    ),
    '',
    'Every corresponding before-and-after diff is open in a read-only editor tab.',
    'Review and switch between those tabs while the modeless OKF confirmation waits.',
    'Choose its apply action only after reviewing the complete change set, or dismiss it to cancel.',
    '',
  ];
  return lines.join('\n');
}

/** Opens a read-only summary and one built-in VS Code diff per proposed file. */
export class VscodeProposalPreviewer implements ProposalPreviewer<vscode.Uri>, vscode.Disposable {
  readonly #provider = new PreviewDocumentProvider();
  readonly #registration: vscode.Disposable;
  #run = 0;

  constructor() {
    this.#registration = vscode.workspace.registerTextDocumentContentProvider(
      PREVIEW_SCHEME,
      this.#provider,
    );
  }

  /** Number of virtual-document bodies retained for active confirmation flows. */
  get retainedDocumentCount(): number {
    return this.#provider.size;
  }

  async show(
    proposal: ChangeSetProposal,
    presentation: ProposalPresentation,
    port: WorkspacePort<vscode.Uri>,
    uris: WorkspaceUriCodec<vscode.Uri>,
  ): Promise<ProposalPreviewSession> {
    this.#run += 1;
    const run = this.#run;
    const retainedUris: vscode.Uri[] = [];
    let released = false;
    const release = (): void => {
      if (released) {
        return;
      }
      released = true;
      for (const uri of retainedUris) {
        this.#provider.delete(uri);
      }
      retainedUris.length = 0;
    };
    const summary = previewUri(run, 0, 'summary');
    this.#provider.add(summary, summaryText(proposal, presentation));
    retainedUris.push(summary);
    try {
      const summaryDocument = await vscode.workspace.openTextDocument(summary);
      await vscode.window.showTextDocument(summaryDocument, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: true,
        preview: false,
      });

      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      for (const [index, change] of proposal.changes.entries()) {
        const target = uris.parse(change.targetUri);
        const beforeText =
          change.expected.kind === 'absent' ? '' : decoder.decode(await port.read(target));
        const before = previewUri(run, index + 1, 'before');
        const after = previewUri(run, index + 1, 'after');
        this.#provider.add(before, beforeText);
        this.#provider.add(after, change.proposedText);
        retainedUris.push(before, after);
        await vscode.commands.executeCommand(
          'vscode.diff',
          before,
          after,
          `OKF Preview: ${change.relativePath}`,
          { preview: false, preserveFocus: true },
        );
      }
      return { dispose: release };
    } catch (error) {
      release();
      throw error;
    }
  }

  dispose(): void {
    this.#provider.clear();
    this.#registration.dispose();
  }
}
