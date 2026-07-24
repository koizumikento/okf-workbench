import { readFile } from 'node:fs/promises';

import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';

import { summarizeDurations } from '../benchmarks/evidence-metrics.js';
import { generatePerformanceGraph, PERFORMANCE_FIXTURES } from '../benchmarks/graph-fixtures.js';

const ENGINES = ['d3', 'ngraph'] as const;
const INTERACTION_SAMPLES = 20;

let benchmarkBundle: Promise<string> | undefined;

test.describe('performance evidence harness', () => {
  test('measures accessible interactions with the representative payload', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await installBenchmarkHarness(page);
    const payload = generatePerformanceGraph(PERFORMANCE_FIXTURES.representative);

    const measurements = await page.evaluate(
      ({ graph, sampleCount }) => {
        const harness = (
          globalThis as typeof globalThis & {
            readonly __okfPerformanceHarness?: PerformanceHarness;
          }
        ).__okfPerformanceHarness;
        if (harness === undefined) throw new Error('Performance harness did not load.');
        const root = document.createElement('main');
        document.body.replaceChildren(root);
        const app = harness.createApp(root);
        const mark = <T>(samples: number[], operation: () => T): T => {
          const started = performance.now();
          const result = operation();
          samples.push(performance.now() - started);
          return result;
        };

        const firstFrameMs: number[] = [];
        mark(firstFrameMs, () => {
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
        });

        const searchMs: number[] = [];
        const filterMs: number[] = [];
        const selectionMs: number[] = [];
        const navigationMs: number[] = [];
        const search = document.querySelector<HTMLInputElement>('#okf-concept-search');
        if (search === null) throw new Error('Search control was not created.');

        for (let index = 0; index < sampleCount; index += 1) {
          mark(searchMs, () => {
            search.value = index % 2 === 0 ? 'Concept 009' : '';
            search.dispatchEvent(new Event('input', { bubbles: true }));
          });

          mark(filterMs, () => {
            const checkbox = document.querySelector<HTMLInputElement>(
              '.okf-filter-list input[type="checkbox"]',
            );
            if (checkbox === null) throw new Error('Type filter was not created.');
            checkbox.click();
          });

          mark(selectionMs, () => {
            const button = document.querySelector<HTMLButtonElement>('button[data-node-id]');
            if (button === null) throw new Error('Accessible result was not created.');
            button.click();
          });

          mark(navigationMs, () => {
            const button = document.querySelector<HTMLButtonElement>('button[data-node-id]');
            if (button === null) throw new Error('Accessible result was not created.');
            button.focus();
            button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
          });
        }
        app.dispose();
        return { firstFrameMs, searchMs, filterMs, selectionMs, navigationMs };
      },
      { graph: payload, sampleCount: INTERACTION_SAMPLES },
    );

    for (const samples of [
      measurements.searchMs,
      measurements.filterMs,
      measurements.selectionMs,
      measurements.navigationMs,
    ]) {
      expect(samples).toHaveLength(INTERACTION_SAMPLES);
      expect(samples.every((sample) => Number.isFinite(sample) && sample >= 0)).toBe(true);
    }

    await testInfo.attach('browser-interaction-harness.json', {
      body: Buffer.from(
        JSON.stringify(
          {
            authority: 'browser-harness-only',
            warning: 'This is not headed VS Code/VSCodium QR-003 evidence.',
            fixture: PERFORMANCE_FIXTURES.representative,
            firstSynchronousRender: summarizeDurations(measurements.firstFrameMs),
            interactions: {
              search: summarizeDurations(measurements.searchMs),
              filter: summarizeDurations(measurements.filterMs),
              selection: summarizeDurations(measurements.selectionMs),
              navigation: summarizeDurations(measurements.navigationMs),
            },
          },
          undefined,
          2,
        ),
      ),
      contentType: 'application/json',
    });
  });

  test('compares d3 and ngraph and verifies cooldown reaches an idle render loop', async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(180_000);
    await installBenchmarkHarness(page);
    const payload = generatePerformanceGraph(PERFORMANCE_FIXTURES.representative);
    const results: Record<string, unknown> = {};

    for (const engine of ENGINES) {
      const measurement = await page.evaluate(
        async ({ graph, forceEngine }) => {
          const harness = (
            globalThis as typeof globalThis & {
              readonly __okfPerformanceHarness?: PerformanceHarness;
            }
          ).__okfPerformanceHarness;
          if (harness === undefined) throw new Error('Performance harness did not load.');
          const waitForFrame = (
            requestFrame: (callback: FrameRequestCallback) => number,
          ): Promise<DOMHighResTimeStamp> => new Promise((resolve) => requestFrame(resolve));
          document.body.replaceChildren();
          const container = document.createElement('div');
          container.style.width = '1,280px';
          container.style.height = '720px';
          document.body.append(container);

          const originalRequestAnimationFrame = window.requestAnimationFrame.bind(window);
          let drawCalls = 0;
          const restoreDrawMethods: (() => void)[] = [];
          const instrumentDrawMethod = (prototype: object, method: string): void => {
            const methods = prototype as unknown as Record<string, unknown>;
            const original = methods[method];
            if (typeof original !== 'function') return;
            methods[method] = function instrumentedDraw(this: unknown, ...arguments_: unknown[]) {
              drawCalls += 1;
              return Reflect.apply(original, this, arguments_);
            };
            restoreDrawMethods.push(() => {
              methods[method] = original;
            });
          };
          for (const prototype of [
            globalThis.WebGLRenderingContext?.prototype,
            globalThis.WebGL2RenderingContext?.prototype,
          ]) {
            if (prototype === undefined) continue;
            instrumentDrawMethod(prototype, 'drawArrays');
            instrumentDrawMethod(prototype, 'drawElements');
          }

          let notifyEngineStop: (() => void) | undefined;
          const engineStopped = new Promise<void>((resolve) => {
            notifyEngineStop = resolve;
          });
          const renderer = harness.createRenderer(container, forceEngine, () =>
            notifyEngineStop?.(),
          );
          const started = performance.now();
          renderer.replaceGraph(graph, new Set(graph.nodes.map((node) => node.id)));
          await waitForFrame(originalRequestAnimationFrame);
          await waitForFrame(originalRequestAnimationFrame);
          const interactiveFrameMs = performance.now() - started;

          const cooldownReached = await Promise.race([
            engineStopped.then(() => true),
            new Promise<boolean>((resolve) => globalThis.setTimeout(() => resolve(false), 60_000)),
          ]);
          const cooldownMs = performance.now() - started;
          // Let callbacks that were already queued before pauseAnimation drain before measuring idle.
          await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
          await waitForFrame(originalRequestAnimationFrame);
          await waitForFrame(originalRequestAnimationFrame);
          const drainedDrawCalls = drawCalls;
          await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
          const idleWebglDrawCallsAfterCooldown = drawCalls - drainedDrawCalls;
          const canvas = container.querySelector('canvas');
          const heap = (
            performance as Performance & {
              readonly memory?: { readonly usedJSHeapSize?: number };
            }
          ).memory?.usedJSHeapSize;

          renderer.dispose();
          for (const restore of restoreDrawMethods.reverse()) restore();
          return {
            engine: forceEngine,
            interactiveFrameMs,
            cooldownReached,
            cooldownMs,
            idleWebglDrawCallsAfterCooldown,
            canvasCreated: canvas !== null,
            usedJsHeapBytes: heap,
          };
        },
        { graph: payload, forceEngine: engine },
      );

      expect(measurement.canvasCreated).toBe(true);
      expect(measurement.cooldownReached).toBe(true);
      expect(measurement.idleWebglDrawCallsAfterCooldown).toBe(0);
      results[engine] = measurement;
    }

    const browserMetadata = await captureBrowserMetadata(page);
    const packageManifest = JSON.parse(await readFile('package.json', 'utf8')) as {
      readonly dependencies?: Readonly<Record<string, string>>;
    };
    await testInfo.attach('browser-force-engine-comparison.json', {
      body: Buffer.from(
        JSON.stringify(
          {
            authority: 'browser-harness-only',
            warning: 'Headless Playwright is not headed VS Code/VSCodium QR-003 evidence.',
            browser: { name: browser.browserType().name(), version: browser.version() },
            browserMetadata,
            fixture: PERFORMANCE_FIXTURES.representative,
            packageVersions: {
              '3d-force-graph': packageManifest.dependencies?.['3d-force-graph'] ?? 'unknown',
            },
            engines: results,
          },
          undefined,
          2,
        ),
      ),
      contentType: 'application/json',
    });
  });
});

async function installBenchmarkHarness(page: Page): Promise<void> {
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: await getBenchmarkBundle(), type: 'module' });
  await page.waitForFunction(() => '__okfPerformanceHarness' in globalThis);
}

function getBenchmarkBundle(): Promise<string> {
  benchmarkBundle ??= build({
    absWorkingDir: process.cwd(),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    stdin: {
      contents: `
        import { WorkbenchApp } from './src/webview/app.ts';
        import { ForceGraphRenderer } from './src/webview/graph/force-graph-adapter.ts';
        globalThis.__okfPerformanceHarness = {
          createRenderer(container, forceEngine, onEngineStop) {
            return new ForceGraphRenderer(container, { onSelect() {} }, { forceEngine, onEngineStop });
          },
          createApp(root) {
            const renderer = {
              replaceGraph() {}, setFolderGrouping() {}, selectNode() {}, focusNode() {}, zoomIn() {}, zoomOut() {},
              fitGraph() {}, resetCamera() {}, resize() {}, pause() {}, setVisible() {}, dispose() {}
            };
            return new WorkbenchApp(root, { postMessage() {} }, () => renderer);
          }
        };
      `,
      loader: 'ts',
      resolveDir: process.cwd(),
      sourcefile: 'okf-performance-harness.ts',
    },
  }).then(
    (result) => result.outputFiles[0]?.text ?? Promise.reject(new Error('No bundle emitted.')),
  );
  return benchmarkBundle;
}

async function captureBrowserMetadata(page: Page): Promise<Readonly<Record<string, unknown>>> {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    const debug = context?.getExtension('WEBGL_debug_renderer_info');
    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      logicalProcessors: navigator.hardwareConcurrency,
      gpuVendor:
        context !== null && debug != null
          ? context.getParameter(debug.UNMASKED_VENDOR_WEBGL)
          : null,
      gpuRenderer:
        context !== null && debug != null
          ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL)
          : null,
    };
  });
}

interface PerformanceHarness {
  readonly createRenderer: (
    container: HTMLElement,
    engine: (typeof ENGINES)[number],
    onEngineStop: () => void,
  ) => {
    replaceGraph(
      graph: ReturnType<typeof generatePerformanceGraph>,
      nodeIds: ReadonlySet<string>,
    ): void;
    dispose(): void;
  };
  readonly createApp: (root: HTMLElement) => { dispose(): void };
}
