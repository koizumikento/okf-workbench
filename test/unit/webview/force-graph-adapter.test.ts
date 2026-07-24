import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { graphNode, graphPayload } from './fixtures.js';

const forceGraphMock = vi.hoisted(() => {
  const calls = new Map<string, unknown[][]>();
  const callbacks = new Map<string, (...arguments_: unknown[]) => void>();
  const target = {};
  const chain = new Proxy(target, {
    get: (_target, property) => {
      if (typeof property !== 'string') return undefined;
      return (...arguments_: unknown[]) => {
        const methodCalls = calls.get(property) ?? [];
        methodCalls.push(arguments_);
        calls.set(property, methodCalls);
        if (property.startsWith('on') && typeof arguments_[0] === 'function') {
          callbacks.set(property, arguments_[0] as (...callbackArguments: unknown[]) => void);
        }
        return chain;
      };
    },
  });
  const constructor = vi.fn(function MockForceGraph() {
    return chain;
  });

  return {
    constructor,
    calls,
    callbacks,
    reset: () => {
      constructor.mockClear();
      calls.clear();
      callbacks.clear();
    },
  };
});

vi.mock('3d-force-graph', () => ({ default: forceGraphMock.constructor }));

import {
  DEFAULT_FORCE_ENGINE,
  FORCE_GRAPH_COOLDOWN_TICKS,
  ForceGraphRenderer,
  SELECTED_NODE_VALUE,
  selectedColorForBackground,
} from '../../../src/webview/graph/force-graph-adapter.js';

function countCalls(method: string): number {
  return forceGraphMock.calls.get(method)?.length ?? 0;
}

function createContainer(): HTMLElement {
  // The adapter boundary needs only these layout/DOM members; WebGL belongs to Playwright evidence.
  return {
    clientWidth: 800,
    clientHeight: 600,
    hidden: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    replaceChildren: vi.fn(),
  } as unknown as HTMLElement;
}

describe('ForceGraphRenderer lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    forceGraphMock.reset();
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '#101010' }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('makes the evidence-backed default engine and cooldown explicit', () => {
    const renderer = new ForceGraphRenderer(createContainer(), { onSelect: vi.fn() });

    expect(DEFAULT_FORCE_ENGINE).toBe('d3');
    expect(forceGraphMock.calls.get('forceEngine')).toEqual([[DEFAULT_FORCE_ENGINE]]);
    expect(forceGraphMock.calls.get('cooldownTicks')).toEqual([[FORCE_GRAPH_COOLDOWN_TICKS]]);
    renderer.dispose();
  });

  it('allows the headed benchmark to run the ngraph candidate through the same adapter', () => {
    const renderer = new ForceGraphRenderer(
      createContainer(),
      { onSelect: vi.fn() },
      { forceEngine: 'ngraph' },
    );

    expect(forceGraphMock.calls.get('forceEngine')).toEqual([['ngraph']]);
    renderer.dispose();
  });

  it('adds and removes a presentation-only folder cluster force for the d3 engine', () => {
    const renderer = new ForceGraphRenderer(createContainer(), { onSelect: vi.fn() });
    renderer.setFolderGrouping(true);

    const forceCall = forceGraphMock.calls.get('d3Force')?.[0];
    expect(forceCall?.[0]).toBe('okf-folder-cluster');
    const force = forceCall?.[1] as
      | (((alpha: number) => void) & {
          initialize(nodes: Array<Record<string, unknown>>): void;
        })
      | undefined;
    const nodes = [
      {
        id: 'area/alpha',
        folderPath: 'area',
        topLevelFolderPath: 'area',
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
      },
      {
        id: 'other/beta',
        folderPath: 'other',
        topLevelFolderPath: 'other',
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
      },
    ];
    force?.initialize(nodes);
    force?.(1);

    expect(Math.abs(Number(nodes[0]?.vx)) + Math.abs(Number(nodes[0]?.vy))).toBeGreaterThan(0);
    expect(countCalls('d3ReheatSimulation')).toBe(1);

    renderer.setFolderGrouping(false);
    expect(forceGraphMock.calls.get('d3Force')?.at(-1)).toEqual(['okf-folder-cluster', null]);
    renderer.dispose();
  });

  it('uses deterministic initial folder positions for the ngraph benchmark without d3 APIs', () => {
    const renderer = new ForceGraphRenderer(
      createContainer(),
      { onSelect: vi.fn() },
      { forceEngine: 'ngraph' },
    );
    renderer.setFolderGrouping(true);
    renderer.replaceGraph(
      graphPayload({
        nodes: [graphNode({ id: 'area/alpha' }), graphNode({ id: 'other/beta' })],
        edges: [],
      }),
      new Set(['area/alpha', 'other/beta']),
    );

    const graphData = forceGraphMock.calls.get('graphData')?.[0]?.[0] as
      | { readonly nodes: Array<{ readonly x?: number; readonly y?: number; readonly z?: number }> }
      | undefined;
    expect(graphData?.nodes.every((node) => [node.x, node.y, node.z].every(Number.isFinite))).toBe(
      true,
    );
    expect(countCalls('d3Force')).toBe(0);
    expect(countCalls('d3ReheatSimulation')).toBe(0);
    renderer.dispose();
  });

  it('uses opposite high-contrast selection colors for light and dark editor backgrounds', () => {
    expect(selectedColorForBackground('#ffffff')).toBe('#000000');
    expect(selectedColorForBackground('rgb(245, 245, 245)')).toBe('#000000');
    expect(selectedColorForBackground('#1e1e1e')).toBe('#ffffff');
    expect(selectedColorForBackground('#000')).toBe('#ffffff');
  });

  it('distinguishes selection by both theme-aware color and size', () => {
    const renderer = new ForceGraphRenderer(createContainer(), { onSelect: vi.fn() });
    renderer.replaceGraph(graphPayload(), new Set(['alpha', 'beta']));
    renderer.selectNode('alpha');

    const colorAccessor = forceGraphMock.calls.get('nodeColor')?.[0]?.[0] as
      ((node: { readonly id: string; readonly type: string }) => string) | undefined;
    const valueAccessor = forceGraphMock.calls.get('nodeVal')?.[0]?.[0] as
      | ((node: {
          readonly id: string;
          readonly orphan: boolean;
          readonly brokenLinkCount: number;
        }) => number)
      | undefined;
    expect(colorAccessor?.({ id: 'alpha', type: 'concept' })).toBe('#ffffff');
    expect(valueAccessor?.({ id: 'alpha', orphan: false, brokenLinkCount: 0 })).toBe(
      SELECTED_NODE_VALUE,
    );
    expect(valueAccessor?.({ id: 'beta', orphan: false, brokenLinkCount: 0 })).toBe(1);
    renderer.dispose();
  });

  it('selects on click and requests camera focus only on the second click', () => {
    const onSelect = vi.fn();
    const renderer = new ForceGraphRenderer(createContainer(), { onSelect });
    const onNodeClick = forceGraphMock.callbacks.get('onNodeClick');

    onNodeClick?.({ id: 'alpha' }, { detail: 1 });
    onNodeClick?.({ id: 'alpha' }, { detail: 2 });

    expect(onSelect).toHaveBeenNthCalledWith(1, 'alpha', false);
    expect(onSelect).toHaveBeenNthCalledWith(2, 'alpha', true);
    renderer.dispose();
  });

  it('stops the render loop after cooldown and does not restart it merely on reveal', () => {
    const onEngineStop = vi.fn();
    const renderer = new ForceGraphRenderer(
      createContainer(),
      { onSelect: vi.fn() },
      { onEngineStop },
    );
    renderer.replaceGraph(graphPayload(), new Set(['alpha', 'beta']));
    expect(countCalls('resumeAnimation')).toBe(1);

    forceGraphMock.callbacks.get('onEngineStop')?.();
    expect(onEngineStop).toHaveBeenCalledOnce();
    expect(countCalls('pauseAnimation')).toBe(1);

    renderer.setVisible(false);
    renderer.setVisible(true);
    expect(countCalls('resumeAnimation')).toBe(1);

    renderer.dispose();
    expect(countCalls('_destructor')).toBe(1);
  });

  it('runs only a bounded animation window for a camera transition after cooldown', () => {
    const renderer = new ForceGraphRenderer(createContainer(), { onSelect: vi.fn() });
    renderer.replaceGraph(graphPayload(), new Set(['alpha', 'beta']));
    forceGraphMock.callbacks.get('onEngineStop')?.();
    const pausedAfterCooldown = countCalls('pauseAnimation');

    renderer.focusNode('alpha');
    expect(countCalls('resumeAnimation')).toBe(2);
    vi.advanceTimersByTime(649);
    expect(countCalls('pauseAnimation')).toBe(pausedAfterCooldown);
    vi.advanceTimersByTime(1);
    expect(countCalls('pauseAnimation')).toBe(pausedAfterCooldown + 1);

    renderer.dispose();
  });
});
