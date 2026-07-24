import type { GraphPayload } from '../../core/model/types.js';

export interface GraphRendererCallbacks {
  readonly onFailure?: () => void;
  readonly onSelect: (nodeId: string | undefined, focus: boolean) => void;
}

/** Repository-owned boundary. No renderer-library types may escape this interface. */
export interface GraphRenderer {
  replaceGraph(payload: GraphPayload, visibleNodeIds: ReadonlySet<string>): void;
  setFolderGrouping(enabled: boolean): void;
  selectNode(nodeId: string | undefined): void;
  focusNode(nodeId: string): void;
  zoomIn(): void;
  zoomOut(): void;
  fitGraph(): void;
  resetCamera(): void;
  resize(): void;
  pause(): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

export type GraphRendererFactory = (
  container: HTMLElement,
  callbacks: GraphRendererCallbacks,
) => GraphRenderer;
