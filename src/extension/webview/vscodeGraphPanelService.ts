import {
  Position,
  Range,
  Selection,
  TextEditorRevealType,
  Uri,
  ViewColumn,
  window,
  workspace,
  type ExtensionContext,
} from 'vscode';

import type { GraphPayload } from '../../core/model/index.js';
import type { GraphRenderFailureReason } from '../../shared/protocol/index.js';
import type { NodeSourceLocation } from '../runtime/index.js';
import type { DisposableLike } from '../workspace/index.js';
import { GraphPanelController } from './graphPanelController.js';

const GRAPH_VIEW_TYPE = 'okfWorkbench.graph';

export interface VscodeGraphPanelServiceOptions {
  readonly onRejectedMessage?: (reason: string) => void;
  readonly onPostError?: (error: unknown) => void;
  readonly onGraphRendered?: (revision: number) => void;
  readonly onGraphRenderFailed?: (revision: number, reason: GraphRenderFailureReason) => void;
}

/** Keeps at most one editor Webview panel alive for the extension instance. */
export class VscodeGraphPanelService implements DisposableLike {
  readonly #extensionUri: Uri;
  readonly #options: VscodeGraphPanelServiceOptions;
  #current: GraphPanelController<Uri> | undefined;
  #disposed = false;

  public constructor(
    context: Pick<ExtensionContext, 'extensionUri'>,
    options: VscodeGraphPanelServiceOptions = {},
  ) {
    this.#extensionUri = context.extensionUri;
    this.#options = options;
  }

  public open(
    graph: GraphPayload,
    nodeSources: ReadonlyMap<string, NodeSourceLocation<Uri>>,
  ): void {
    if (this.#disposed) {
      throw new Error('The graph panel service has been disposed.');
    }
    if (this.#current !== undefined && !this.#current.disposed) {
      this.#current.replaceGraph(graph, nodeSources);
      this.#current.reveal();
      return;
    }

    const assetRoot = Uri.joinPath(this.#extensionUri, 'dist', 'webview');
    const panel = window.createWebviewPanel(GRAPH_VIEW_TYPE, 'OKF 3D Graph', ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [assetRoot],
      retainContextWhenHidden: false,
    });
    const controller = new GraphPanelController<Uri>({
      panel,
      assets: {
        cspSource: panel.webview.cspSource,
        scriptUri: panel.webview.asWebviewUri(Uri.joinPath(assetRoot, 'main.js')).toString(),
        styleUri: panel.webview.asWebviewUri(Uri.joinPath(assetRoot, 'main.css')).toString(),
      },
      navigator: { openSource: openVscodeSource },
      onDispose: () => {
        if (this.#current === controller) {
          this.#current = undefined;
        }
      },
      ...(this.#options.onRejectedMessage === undefined
        ? {}
        : {
            onRejectedMessage: (reason) =>
              this.#options.onRejectedMessage?.(
                typeof reason === 'string' ? reason : `${reason.code}: ${reason.message}`,
              ),
          }),
      ...(this.#options.onPostError === undefined
        ? {}
        : { onPostError: this.#options.onPostError }),
      ...(this.#options.onGraphRendered === undefined
        ? {}
        : { onGraphRendered: this.#options.onGraphRendered }),
      ...(this.#options.onGraphRenderFailed === undefined
        ? {}
        : { onGraphRenderFailed: this.#options.onGraphRenderFailed }),
    });
    this.#current = controller;
    controller.replaceGraph(graph, nodeSources);
  }

  public replaceCurrent(
    graph: GraphPayload,
    nodeSources: ReadonlyMap<string, NodeSourceLocation<Uri>>,
  ): void {
    this.#current?.replaceGraph(graph, nodeSources);
  }

  /** Closes any panel still bound to a bundle that has just been deselected. */
  public closeCurrent(): void {
    const current = this.#current;
    this.#current = undefined;
    current?.close();
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.closeCurrent();
  }
}

async function openVscodeSource(location: NodeSourceLocation<Uri>): Promise<void> {
  const document = await workspace.openTextDocument(location.uri);
  const editor = await window.showTextDocument(document, { preview: false, preserveFocus: false });
  if (location.range === undefined) {
    return;
  }
  const start = new Position(location.range.start.line, location.range.start.character);
  const end = new Position(location.range.end.line, location.range.end.character);
  const range = new Range(start, end);
  editor.selection = new Selection(start, end);
  editor.revealRange(range, TextEditorRevealType.InCenterIfOutsideViewport);
}
