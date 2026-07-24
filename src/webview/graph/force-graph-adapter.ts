import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph';
import type { GraphPayload } from '../../core/model/types.js';
import { colorForType, fnv1a } from '../state/colors.js';
import { folderPathForNode, topLevelFolderPath } from '../state/folders.js';
import type { GraphRenderer, GraphRendererCallbacks } from './adapter.js';
import { GraphCameraController, type CameraCoordinates } from './camera-controller.js';

interface ForceNode {
  readonly id: string;
  readonly type: string;
  readonly orphan: boolean;
  readonly brokenLinkCount: number;
  readonly folderPath: string;
  readonly topLevelFolderPath: string;
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
}

interface ForceLink {
  readonly id: string;
  source: string | ForceNode;
  target: string | ForceNode;
}

const CAMERA_DISTANCE = 80;
const CAMERA_TRANSITION_MS = 600;
const FOLDER_CLUSTER_FORCE = 'okf-folder-cluster';
const FOLDER_CLUSTER_STRENGTH = 0.14;

export type ForceEngine = 'd3' | 'ngraph';

/** Checked-in fallback; release qualification requires current schema-v3 headed evidence. */
export const DEFAULT_FORCE_ENGINE: ForceEngine = 'd3';
export const FORCE_GRAPH_COOLDOWN_TICKS = 120;
export const SELECTED_NODE_VALUE = 2.4;

export interface ForceGraphRendererOptions {
  readonly forceEngine?: ForceEngine;
  readonly onEngineStop?: () => void;
}

interface FolderClusterForce {
  (alpha: number): void;
  initialize(nodes: ForceNode[]): void;
}

interface Coordinates {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export class ForceGraphRenderer implements GraphRenderer {
  readonly #container: HTMLElement;
  readonly #graph: ForceGraph3DInstance<ForceNode, ForceLink>;
  readonly #resizeObserver: ResizeObserver | undefined;
  readonly #onEngineStop: (() => void) | undefined;
  readonly #cameraController: GraphCameraController;
  readonly #selectedColor: string;
  readonly #forceEngine: ForceEngine;
  #nodes = new Map<string, ForceNode>();
  #groupByFolder = false;
  #selectedNodeId: string | undefined;
  #cameraPauseTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #idlePauseTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #engineActive = false;
  #visible = true;
  #disposed = false;

  public constructor(
    container: HTMLElement,
    callbacks: GraphRendererCallbacks,
    options: ForceGraphRendererOptions = {},
  ) {
    this.#container = container;
    this.#onEngineStop = options.onEngineStop;
    this.#forceEngine = options.forceEngine ?? DEFAULT_FORCE_ENGINE;
    const backgroundColor = resolveBackgroundColor(container);
    this.#selectedColor = selectedColorForBackground(backgroundColor);
    const graph = new ForceGraph3D(container, {
      controlType: 'orbit',
      rendererConfig: { antialias: true, alpha: false },
    }) as unknown as ForceGraph3DInstance<ForceNode, ForceLink>;
    this.#graph = graph
      .backgroundColor(backgroundColor)
      .showNavInfo(false)
      .nodeId('id')
      // A blank tooltip prevents user-controlled labels from entering the library's HTML tooltip path.
      .nodeLabel('')
      .nodeColor((node) =>
        node.id === this.#selectedNodeId ? this.#selectedColor : colorForType(node.type),
      )
      .nodeVal((node) =>
        node.id === this.#selectedNodeId
          ? SELECTED_NODE_VALUE
          : node.orphan || node.brokenLinkCount > 0
            ? 1.4
            : 1,
      )
      .nodeOpacity(0.9)
      .linkOpacity(0.38)
      .linkDirectionalArrowLength(3.5)
      .linkDirectionalArrowRelPos(1)
      .forceEngine(this.#forceEngine)
      .cooldownTicks(FORCE_GRAPH_COOLDOWN_TICKS)
      .onEngineStop(() => this.#handleEngineStop())
      .enableNavigationControls(true)
      .enableNodeDrag(false)
      .onNodeClick((node, event) => callbacks.onSelect(node.id, event.detail >= 2))
      .onBackgroundClick(() => callbacks.onSelect(undefined, false));

    const controls = graph.controls();
    this.#cameraController = new GraphCameraController(
      container,
      {
        getPosition: () => graph.cameraPosition(),
        getTarget: () => readControlsTarget(controls),
        moveTo: (position, target, transitionDurationMs) => {
          graph.cameraPosition(position, target, transitionDurationMs);
        },
        fitGraph: (transitionDurationMs, paddingPixels) => {
          graph.zoomToFit(transitionDurationMs, paddingPixels);
        },
      },
      {
        controls,
        transitionDurationMs: prefersReducedMotion() ? 0 : CAMERA_TRANSITION_MS,
        onMotionStart: () => this.#beginCameraMotion(),
        onMotionEnd: (settleDurationMs) => this.#scheduleCameraPause(settleDurationMs),
        ...(callbacks.onFailure === undefined ? {} : { onError: callbacks.onFailure }),
      },
    );

    if (typeof ResizeObserver === 'function') {
      this.#resizeObserver = new ResizeObserver(() => this.resize());
      this.#resizeObserver.observe(container);
    }
    this.resize();
  }

  public replaceGraph(payload: GraphPayload, visibleNodeIds: ReadonlySet<string>): void {
    if (this.#disposed) return;

    const nodes: ForceNode[] = payload.nodes
      .filter((node) => visibleNodeIds.has(node.id))
      .map((node) => {
        const folderPath = folderPathForNode(node.id);
        const forceNode: ForceNode = {
          id: node.id,
          type: node.type,
          orphan: node.orphan,
          brokenLinkCount: node.brokenLinkCount,
          folderPath,
          topLevelFolderPath: topLevelFolderPath(node.id),
        };
        if (this.#groupByFolder && this.#forceEngine === 'ngraph') {
          const target = deterministicFolderTarget(
            forceNode.topLevelFolderPath,
            forceNode.folderPath,
          );
          forceNode.x = target.x;
          forceNode.y = target.y;
          forceNode.z = target.z;
        }
        return forceNode;
      });
    const links: ForceLink[] = payload.edges
      .filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target))
      .map((edge) => ({ id: edge.id, source: edge.source, target: edge.target }));

    this.#nodes = new Map(nodes.map((node) => [node.id, node]));
    if (this.#selectedNodeId !== undefined && !this.#nodes.has(this.#selectedNodeId)) {
      this.#selectedNodeId = undefined;
    }
    this.#clearCameraPauseTimer();
    this.#clearIdlePauseTimer();
    this.#engineActive = true;
    // graphData resets the library countdown for both supported force engines.
    this.#graph.graphData({ nodes, links });
    this.#graph.refresh();
    if (this.#visible) {
      this.#clearIdlePauseTimer();
      this.#graph.resumeAnimation();
    } else {
      this.#graph.pauseAnimation();
    }
  }

  public setFolderGrouping(enabled: boolean): void {
    if (this.#disposed || this.#groupByFolder === enabled) return;
    this.#groupByFolder = enabled;
    if (this.#forceEngine !== 'd3') return;
    this.#graph.d3Force(FOLDER_CLUSTER_FORCE, enabled ? createFolderClusterForce() : null);
    this.#engineActive = true;
    this.#clearIdlePauseTimer();
    this.#graph.d3ReheatSimulation();
    if (this.#visible) this.#graph.resumeAnimation();
  }

  public selectNode(nodeId: string | undefined): void {
    if (this.#disposed) return;
    this.#selectedNodeId = nodeId !== undefined && this.#nodes.has(nodeId) ? nodeId : undefined;
    this.#graph.refresh();
  }

  public focusNode(nodeId: string): void {
    if (this.#disposed) return;
    const node = this.#nodes.get(nodeId);
    if (node === undefined) return;

    this.#cameraController.focus(
      {
        x: finiteCoordinate(node.x),
        y: finiteCoordinate(node.y),
        z: finiteCoordinate(node.z),
      },
      CAMERA_DISTANCE,
    );
  }

  public zoomIn(): void {
    if (this.#disposed) return;
    this.#cameraController.zoomIn();
  }

  public zoomOut(): void {
    if (this.#disposed) return;
    this.#cameraController.zoomOut();
  }

  public fitGraph(): void {
    if (this.#disposed || this.#nodes.size === 0) return;
    this.#cameraController.fitGraph();
  }

  public resetCamera(): void {
    if (this.#disposed) return;
    this.#cameraController.resetCamera();
  }

  public resize(): void {
    if (this.#disposed) return;
    const width = Math.max(1, this.#container.clientWidth);
    const height = Math.max(1, this.#container.clientHeight);
    this.#graph.width(width).height(height);
  }

  public pause(): void {
    if (this.#disposed) return;
    this.#engineActive = false;
    this.#clearCameraPauseTimer();
    this.#clearIdlePauseTimer();
    this.#graph.pauseAnimation();
  }

  public setVisible(visible: boolean): void {
    if (this.#disposed || this.#visible === visible) return;
    this.#visible = visible;
    this.#container.hidden = !visible;
    if (visible) {
      this.resize();
      this.#graph.refresh();
      if (this.#engineActive) this.#graph.resumeAnimation();
    } else {
      this.#clearCameraPauseTimer();
      this.#clearIdlePauseTimer();
      this.#graph.pauseAnimation();
    }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearCameraPauseTimer();
    this.#clearIdlePauseTimer();
    this.#resizeObserver?.disconnect();
    this.#cameraController.dispose();
    this.#graph.pauseAnimation();
    this.#graph._destructor();
    this.#container.replaceChildren();
    this.#nodes.clear();
  }

  #handleEngineStop(): void {
    if (this.#disposed) return;
    this.#engineActive = false;
    if (this.#cameraPauseTimer === undefined) {
      this.#graph.pauseAnimation();
      // The renderer may finish its current engine tick after invoking this callback.
      // Reassert pause on the next task so that completion cannot leave an idle loop running.
      this.#clearIdlePauseTimer();
      this.#idlePauseTimer = globalThis.setTimeout(() => {
        this.#idlePauseTimer = undefined;
        if (!this.#disposed && !this.#engineActive && this.#cameraPauseTimer === undefined) {
          this.#graph.pauseAnimation();
        }
      }, 0);
    }
    this.#onEngineStop?.();
  }

  #beginCameraMotion(): void {
    if (this.#disposed || !this.#visible) return;
    this.#clearCameraPauseTimer();
    this.#clearIdlePauseTimer();
    this.#graph.resumeAnimation();
  }

  #scheduleCameraPause(settleDurationMs: number): void {
    if (this.#disposed || !this.#visible) return;
    this.#clearCameraPauseTimer();
    this.#cameraPauseTimer = globalThis.setTimeout(
      () => {
        this.#cameraPauseTimer = undefined;
        if (!this.#disposed && !this.#engineActive) {
          this.#graph.pauseAnimation();
        }
      },
      Math.max(0, settleDurationMs) + 50,
    );
  }

  #clearCameraPauseTimer(): void {
    if (this.#cameraPauseTimer === undefined) return;
    globalThis.clearTimeout(this.#cameraPauseTimer);
    this.#cameraPauseTimer = undefined;
  }

  #clearIdlePauseTimer(): void {
    if (this.#idlePauseTimer === undefined) return;
    globalThis.clearTimeout(this.#idlePauseTimer);
    this.#idlePauseTimer = undefined;
  }
}

export function createFolderClusterForce(strength = FOLDER_CLUSTER_STRENGTH): FolderClusterForce {
  let nodes: ForceNode[] = [];
  let targets = new Map<string, Coordinates>();

  const force = ((alpha: number): void => {
    const pull = strength * alpha;
    for (const node of nodes) {
      const target = targets.get(node.id);
      if (target === undefined) continue;
      node.vx = finiteCoordinate(node.vx) + (target.x - finiteCoordinate(node.x)) * pull;
      node.vy = finiteCoordinate(node.vy) + (target.y - finiteCoordinate(node.y)) * pull;
      node.vz = finiteCoordinate(node.vz) + (target.z - finiteCoordinate(node.z)) * pull;
    }
  }) as FolderClusterForce;

  force.initialize = (nextNodes: ForceNode[]): void => {
    nodes = nextNodes;
    const groups = [...new Set(nodes.map((node) => node.topLevelFolderPath))].sort();
    const groupCenters = new Map(
      groups.map((group, index) => [group, groupCenter(index, groups.length)]),
    );
    targets = new Map(
      nodes.map((node) => {
        const center = groupCenters.get(node.topLevelFolderPath) ?? { x: 0, y: 0, z: 0 };
        const nestedOffset = nestedFolderOffset(node.folderPath);
        return [
          node.id,
          {
            x: center.x + nestedOffset.x,
            y: center.y + nestedOffset.y,
            z: center.z + nestedOffset.z,
          },
        ];
      }),
    );
  };

  return force;
}

function deterministicFolderTarget(topLevelPath: string, folderPath: string): Coordinates {
  const seed = fnv1a(topLevelPath);
  const center = groupCenter(seed % 32, 32);
  const nestedOffset = nestedFolderOffset(folderPath);
  return {
    x: center.x + nestedOffset.x,
    y: center.y + nestedOffset.y,
    z: center.z + nestedOffset.z,
  };
}

function groupCenter(index: number, count: number): Coordinates {
  if (count <= 1) return { x: 0, y: 0, z: 0 };
  const radius = 90 + Math.min(count, 12) * 7;
  const y = 1 - (index / Math.max(1, count - 1)) * 2;
  const radial = Math.sqrt(Math.max(0, 1 - y * y));
  const angle = index * Math.PI * (3 - Math.sqrt(5));
  return {
    x: Math.cos(angle) * radial * radius,
    y: y * radius,
    z: Math.sin(angle) * radial * radius,
  };
}

function nestedFolderOffset(folderPath: string): Coordinates {
  if (folderPath === '') return { x: 0, y: 0, z: 0 };
  const hash = fnv1a(folderPath);
  const depth = folderPath.split('/').length;
  const magnitude = Math.min(28, 8 + depth * 5);
  const angle = ((hash % 360) * Math.PI) / 180;
  const elevation = ((((hash >>> 9) % 180) - 90) * Math.PI) / 180;
  return {
    x: Math.cos(angle) * Math.cos(elevation) * magnitude,
    y: Math.sin(elevation) * magnitude,
    z: Math.sin(angle) * Math.cos(elevation) * magnitude,
  };
}

function readControlsTarget(controls: object): CameraCoordinates {
  if (!('target' in controls)) return { x: 0, y: 0, z: 0 };
  const target = controls.target;
  if (typeof target !== 'object' || target === null) return { x: 0, y: 0, z: 0 };
  return {
    x: readCoordinate(target, 'x'),
    y: readCoordinate(target, 'y'),
    z: readCoordinate(target, 'z'),
  };
}

function readCoordinate(value: object, key: 'x' | 'y' | 'z'): number {
  if (!(key in value)) return 0;
  const coordinate = (value as Record<'x' | 'y' | 'z', unknown>)[key];
  return typeof coordinate === 'number' && Number.isFinite(coordinate) ? coordinate : 0;
}

function prefersReducedMotion(): boolean {
  return (
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function finiteCoordinate(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function resolveBackgroundColor(container: HTMLElement): string {
  const value = getComputedStyle(container).getPropertyValue('--vscode-editor-background').trim();
  return value.length > 0 ? value : '#1e1e1e';
}

/** Pick the black/white endpoint with the stronger WCAG contrast against the current editor theme. */
export function selectedColorForBackground(backgroundColor: string): '#000000' | '#ffffff' {
  const rgb = parseCssColor(backgroundColor);
  if (rgb === undefined) return '#ffffff';
  const luminance = relativeLuminance(rgb);
  return luminance > 0.179 ? '#000000' : '#ffffff';
}

function parseCssColor(value: string): readonly [number, number, number] | undefined {
  const normalized = value.trim().toLowerCase();
  const shortHex = /^#([\da-f])([\da-f])([\da-f])$/u.exec(normalized);
  if (shortHex !== null) {
    return [
      Number.parseInt(`${shortHex[1]}${shortHex[1]}`, 16),
      Number.parseInt(`${shortHex[2]}${shortHex[2]}`, 16),
      Number.parseInt(`${shortHex[3]}${shortHex[3]}`, 16),
    ];
  }
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/u.exec(normalized);
  if (hex !== null) {
    return [
      Number.parseInt(hex[1] ?? '', 16),
      Number.parseInt(hex[2] ?? '', 16),
      Number.parseInt(hex[3] ?? '', 16),
    ];
  }
  const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/u.exec(
    normalized,
  );
  if (rgb === null) return undefined;
  return [clampColor(rgb[1]), clampColor(rgb[2]), clampColor(rgb[3])];
}

function clampColor(value: string | undefined): number {
  return Math.max(0, Math.min(255, Number(value ?? 0)));
}

function relativeLuminance(rgb: readonly [number, number, number]): number {
  const [red, green, blue] = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0);
}

export function createForceGraphRenderer(
  container: HTMLElement,
  callbacks: GraphRendererCallbacks,
): GraphRenderer {
  return new ForceGraphRenderer(container, callbacks);
}
