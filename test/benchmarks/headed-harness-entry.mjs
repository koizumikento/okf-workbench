/* eslint-disable no-undef -- This entry executes inside the VS Code Webview. */

import { WorkbenchApp } from '../../src/webview/app.ts';
import { ForceGraphRenderer } from '../../src/webview/graph/force-graph-adapter.ts';
import { matchesSearch } from '../../src/webview/state/search.ts';
import { generatePerformanceGraph, PERFORMANCE_FIXTURES } from './graph-fixtures.ts';
import {
  FIRST_INTERACTIVE_FRAME_TIMEOUT_MS,
  waitForAnimationFramePredicate,
} from './headed-animation-frame-deadline.mjs';

const SAMPLE_COUNT = 20;
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const timed = (samples, operation) => {
  const started = performance.now();
  const result = operation();
  samples.push(performance.now() - started);
  return result;
};
const cleanUpEngineMeasurement = (app, root, restoreWebglMethods) => {
  let cleanupFailure;
  try {
    app?.dispose();
  } catch (error) {
    cleanupFailure = error;
  }
  root.remove();
  for (const restore of restoreWebglMethods.reverse()) {
    try {
      restore();
    } catch (error) {
      cleanupFailure ??= error;
    }
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
};

globalThis.__okfHeadedHarness = {
  environment() {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const debug = context?.getExtension('WEBGL_debug_renderer_info');
    const userAgent = navigator.userAgent;
    return {
      vendor:
        context && debug
          ? String(context.getParameter(debug.UNMASKED_VENDOR_WEBGL))
          : 'unavailable',
      renderer:
        context && debug
          ? String(context.getParameter(debug.UNMASKED_RENDERER_WEBGL))
          : 'unavailable',
      chromiumVersion: /Chrome\/([^ ]+)/u.exec(userAgent)?.[1] ?? 'unavailable',
      electronVersion: /Electron\/([^ ]+)/u.exec(userAgent)?.[1] ?? 'unavailable',
    };
  },

  async measureEngine(engine) {
    document.body.replaceChildren();
    const graph = generatePerformanceGraph(PERFORMANCE_FIXTURES.representative);
    const root = document.createElement('main');
    document.body.append(root);
    let renderFrames = 0;
    let renderDrawCalls = 0;
    const restoreWebglMethods = [];
    let app;
    try {
      for (const prototype of [
        globalThis.WebGLRenderingContext?.prototype,
        globalThis.WebGL2RenderingContext?.prototype,
      ]) {
        if (!prototype) continue;
        for (const [method, observe] of [
          ['clear', () => (renderFrames += 1)],
          ['drawArrays', () => (renderDrawCalls += 1)],
          ['drawElements', () => (renderDrawCalls += 1)],
        ]) {
          const originalDescriptor = Object.getOwnPropertyDescriptor(prototype, method);
          if (typeof originalDescriptor?.value !== 'function') continue;
          const original = originalDescriptor.value;
          Object.defineProperty(prototype, method, {
            ...originalDescriptor,
            value: function (...arguments_) {
              observe();
              return Reflect.apply(original, this, arguments_);
            },
          });
          restoreWebglMethods.push(() => {
            Object.defineProperty(prototype, method, originalDescriptor);
          });
        }
      }

      let stopEngine;
      const engineStopped = new Promise((resolve) => {
        stopEngine = resolve;
      });
      let renderer;
      app = new WorkbenchApp(root, { postMessage() {} }, (container, callbacks) => {
        renderer = new ForceGraphRenderer(container, callbacks, {
          forceEngine: engine,
          onEngineStop: () => stopEngine(),
        });
        return renderer;
      });
      const firstFrameStarted = performance.now();
      const firstFrameClearBaseline = renderFrames;
      const firstFrameDrawBaseline = renderDrawCalls;
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            protocolVersion: 1,
            type: 'replaceGraph',
            revision: graph.revision,
            deliveryId: 1,
            payload: graph,
          },
        }),
      );
      const firstFrameObserved = await waitForAnimationFramePredicate(
        () =>
          renderFrames > firstFrameClearBaseline &&
          renderDrawCalls > firstFrameDrawBaseline &&
          root.querySelector('.okf-graph-host canvas') instanceof HTMLCanvasElement,
        FIRST_INTERACTIVE_FRAME_TIMEOUT_MS,
      );
      if (!firstFrameObserved) {
        return {
          measurementFailure: {
            authority: 'headed-vscode-webview-harness',
            phase: 'first-interactive-frame',
            code: 'graph-webgl-render-timeout',
            timeoutMs: FIRST_INTERACTIVE_FRAME_TIMEOUT_MS,
            observedClearCount: renderFrames - firstFrameClearBaseline,
            observedDrawCallCount: renderDrawCalls - firstFrameDrawBaseline,
            canvasPresent:
              root.querySelector('.okf-graph-host canvas') instanceof HTMLCanvasElement,
            nodeCount: graph.nodes.length,
            edgeCount: graph.edges.length,
          },
        };
      }
      const firstInteractiveFrameMs = performance.now() - firstFrameStarted;
      const firstInteractiveFrameWebglClears = renderFrames - firstFrameClearBaseline;
      const firstInteractiveFrameWebglDrawCalls = renderDrawCalls - firstFrameDrawBaseline;

      const searchMs = [];
      const filterMs = [];
      const selectionMs = [];
      const navigationMs = [];
      const interactionOutcomes = {
        search: [],
        filter: [],
        selection: [],
        navigation: [],
      };
      const search = root.querySelector('#okf-concept-search');
      if (!search) throw new Error('Headed harness search control is missing.');
      for (let index = 0; index < SAMPLE_COUNT; index += 1) {
        const searchOutcome = timed(searchMs, () => {
          search.value = index % 2 === 0 ? 'Concept 009' : '';
          search.dispatchEvent(new Event('input', { bubbles: true }));
          const results = [...root.querySelectorAll('button[data-node-id]')];
          const summary = root.querySelector('.okf-results-panel .okf-muted')?.textContent ?? '';
          return (
            results.length > 1 &&
            summary ===
              `${String(results.length)} of ${String(graph.nodes.length)} concepts shown` &&
            (search.value === '' ||
              results.every((button) => {
                const nodeId = button.dataset.nodeId;
                const node = graph.nodes.find((candidate) => candidate.id === nodeId);
                return node !== undefined && matchesSearch(node, search.value);
              }))
          );
        });
        if (!searchOutcome)
          throw new Error('Headed harness search outcome did not match its query.');
        interactionOutcomes.search.push(true);

        const filterOutcome = timed(filterMs, () => {
          const checkbox = root.querySelector('.okf-filter-list input[type="checkbox"]');
          if (!checkbox) throw new Error('Headed harness type filter is missing.');
          const wasChecked = checkbox.checked;
          const beforeCount = root.querySelectorAll('button[data-node-id]').length;
          checkbox.click();
          const afterCount = root.querySelectorAll('button[data-node-id]').length;
          return checkbox.checked !== wasChecked && afterCount > 1 && afterCount !== beforeCount;
        });
        if (!filterOutcome)
          throw new Error('Headed harness filter outcome did not change the result.');
        interactionOutcomes.filter.push(true);

        const selectionOutcome = timed(selectionMs, () => {
          const button = root.querySelector('button[data-node-id]');
          if (!button) throw new Error('Headed harness result is missing.');
          button.click();
          const selectedTitle = button.querySelector('.okf-result__title')?.textContent ?? '';
          return (
            button.getAttribute('aria-pressed') === 'true' &&
            selectedTitle.length > 0 &&
            (root.querySelector('.okf-details')?.textContent ?? '').includes(selectedTitle)
          );
        });
        if (!selectionOutcome)
          throw new Error('Headed harness selection outcome was not rendered.');
        interactionOutcomes.selection.push(true);

        const navigationOutcome = timed(navigationMs, () => {
          const buttons = [...root.querySelectorAll('button[data-node-id]')];
          const first = buttons[0];
          const second = buttons[1];
          if (!first || !second) throw new Error('Headed harness navigation results are missing.');
          first.focus();
          first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
          return document.activeElement === second;
        });
        if (!navigationOutcome) throw new Error('Headed harness navigation did not move focus.');
        interactionOutcomes.navigation.push(true);
      }

      const cooldownStarted = performance.now();
      const cooldownReached = await Promise.race([
        engineStopped.then(() => true),
        wait(120_000).then(() => false),
      ]);
      const cooldownMs = performance.now() - cooldownStarted;
      await wait(100);
      await frame();
      await frame();
      const idleBaseline = renderFrames;
      await wait(250);
      const idleAnimationFramesAfterCooldown = renderFrames - idleBaseline;

      const cameraBaseline = renderFrames;
      const cameraDrawBaseline = renderDrawCalls;
      const cameraStarted = performance.now();
      const cameraTarget = graph.nodes.at(-1);
      if (!cameraTarget) throw new Error('Headed harness camera target is missing.');
      renderer.focusNode(cameraTarget.id);
      await wait(700);
      const cameraDurationMs = performance.now() - cameraStarted;
      const cameraFrameCount = renderFrames - cameraBaseline;
      const cameraDrawCallCount = renderDrawCalls - cameraDrawBaseline;
      if (cameraFrameCount < 1) {
        throw new Error('Headed harness camera motion produced no observed WebGL clear.');
      }
      if (cameraDrawCallCount < cameraFrameCount) {
        throw new Error(
          'Headed harness camera motion did not draw graph geometry for every observed WebGL clear.',
        );
      }
      const cameraFps = cameraFrameCount / (cameraDurationMs / 1_000);
      const memory = performance.memory?.usedJSHeapSize;
      const totalWebglClearCount = renderFrames;
      const totalWebglDrawCallCount = renderDrawCalls;

      return {
        firstInteractiveFrameMs: [firstInteractiveFrameMs],
        firstInteractiveFrameWebglClears: [firstInteractiveFrameWebglClears],
        firstInteractiveFrameWebglDrawCalls: [firstInteractiveFrameWebglDrawCalls],
        cooldownReached,
        cooldownMs: [cooldownMs],
        idleAnimationFramesAfterCooldown: [idleAnimationFramesAfterCooldown],
        interactions: { searchMs, filterMs, selectionMs, navigationMs },
        interactionOutcomes,
        rendererJsHeapMb: typeof memory === 'number' ? memory / 1024 ** 2 : null,
        cameraDurationMs,
        cameraFrameCount,
        cameraDrawCallCount,
        cameraFps,
        totalWebglClearCount,
        totalWebglDrawCallCount,
      };
    } finally {
      cleanUpEngineMeasurement(app, root, restoreWebglMethods);
    }
  },
};
