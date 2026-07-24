import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

let cameraHarnessBundle: Promise<string> | undefined;

test('camera toolbar, help, shortcuts, and selected-node focus share renderer actions', async ({
  page,
}) => {
  await page.setContent('<!doctype html><html><body><main id="root"></main></body></html>');
  await page.addStyleTag({ path: 'dist/webview/main.css' });
  await page.addScriptTag({ content: await getCameraHarnessBundle(), type: 'module' });
  await page.evaluate(() => {
    const cameraGlobal = globalThis as typeof globalThis & {
      __okfCameraHarness?: {
        createApp(root: HTMLElement, calls: unknown[]): { dispose(): void };
      };
      __okfCameraCalls?: unknown[];
      __okfCameraApp?: { dispose(): void };
    };
    const root = document.querySelector<HTMLElement>('#root');
    if (root === null || cameraGlobal.__okfCameraHarness === undefined) {
      throw new Error('Camera harness is unavailable.');
    }
    const calls: unknown[] = [];
    cameraGlobal.__okfCameraCalls = calls;
    cameraGlobal.__okfCameraApp = cameraGlobal.__okfCameraHarness.createApp(root, calls);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          protocolVersion: 1,
          type: 'replaceGraph',
          revision: 1,
          deliveryId: 1,
          payload: {
            protocolVersion: 1,
            revision: 1,
            nodes: [
              {
                id: 'alpha',
                type: 'concept',
                title: 'Alpha',
                description: 'Camera fixture',
                tags: ['camera'],
                orphan: true,
                brokenLinkCount: 0,
              },
            ],
            edges: [],
            backlinks: { alpha: [] },
            brokenLinks: [],
            statistics: {
              conceptCount: 1,
              edgeCount: 0,
              orphanCount: 1,
              brokenLinkCount: 0,
              typeCounts: { concept: 1 },
              tagCounts: { camera: 1 },
            },
          },
        },
      }),
    );
  });

  const toolbar = page.getByRole('toolbar', { name: '3D graph camera controls' });
  await expect(toolbar).toBeVisible();
  await expect(page.getByRole('button', { name: 'Zoom in' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Focus selected concept' })).toBeDisabled();

  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await page.getByRole('button', { name: 'Fit graph' }).click();
  await page.getByRole('button', { name: 'Reset camera' }).click();

  await page.locator('button[data-node-id="alpha"]').click();
  const focusSelected = page.getByRole('button', { name: 'Focus selected concept' });
  await expect(focusSelected).toBeEnabled();
  await focusSelected.click();

  const helpButton = page.getByRole('button', { name: 'Show graph controls' });
  await helpButton.click();
  await expect(helpButton).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('complementary', { name: '3D graph controls' })).toContainText(
    'two-finger swipe to pan',
  );

  const graph = page.getByRole('group', { name: /Interactive 3D graph/u });
  await graph.focus();
  await page.keyboard.press('+');
  await page.keyboard.press('-');
  await page.keyboard.press('f');
  await page.keyboard.press('0');
  await page.keyboard.press('Escape');
  await expect(helpButton).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('button[data-node-id="alpha"]')).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  const calls = await page.evaluate(
    () =>
      (globalThis as typeof globalThis & { readonly __okfCameraCalls?: readonly unknown[] })
        .__okfCameraCalls ?? [],
  );
  expect(calls).toEqual(
    expect.arrayContaining([
      'zoomIn',
      'zoomOut',
      'fitGraph',
      'resetCamera',
      'focusNode:alpha',
      'selectNode:clear',
    ]),
  );
  expect(calls.filter((call) => call === 'zoomIn')).toHaveLength(2);
  expect(calls.filter((call) => call === 'zoomOut')).toHaveLength(2);
  expect(calls.filter((call) => call === 'fitGraph')).toHaveLength(2);
  expect(calls.filter((call) => call === 'resetCamera')).toHaveLength(2);

  await page.evaluate(() => {
    (
      globalThis as typeof globalThis & { readonly __okfCameraApp?: { dispose(): void } }
    ).__okfCameraApp?.dispose();
  });
});

test('wheel boundary distinguishes mouse zoom, trackpad pan, and pinch zoom', async ({ page }) => {
  await page.setContent(
    '<!doctype html><html><body><div id="outside"></div><div id="mouse"></div><div id="trackpad"></div><div id="pinch"></div></body></html>',
  );
  await page.addScriptTag({ content: await getCameraHarnessBundle(), type: 'module' });

  const result = await page.evaluate(() => {
    const cameraGlobal = globalThis as typeof globalThis & {
      __okfCameraHarness?: {
        createController(root: HTMLElement, calls: unknown[]): { dispose(): void };
      };
    };
    const harness = cameraGlobal.__okfCameraHarness;
    if (harness === undefined) throw new Error('Camera harness is unavailable.');
    const calls: unknown[] = [];
    const mouse = document.querySelector<HTMLElement>('#mouse');
    const trackpad = document.querySelector<HTMLElement>('#trackpad');
    const pinch = document.querySelector<HTMLElement>('#pinch');
    const outside = document.querySelector<HTMLElement>('#outside');
    if (mouse === null || trackpad === null || pinch === null || outside === null) {
      throw new Error('Camera fixture elements are unavailable.');
    }
    const controllers = [
      harness.createController(mouse, calls),
      harness.createController(trackpad, calls),
      harness.createController(pinch, calls),
    ];
    const outsideAllowed = outside.dispatchEvent(
      new WheelEvent('wheel', { cancelable: true, deltaY: 120 }),
    );
    const mouseAllowed = mouse.dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 }),
    );
    const trackpadAllowed = trackpad.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaX: 12,
        deltaY: 6,
      }),
    );
    const pinchAllowed = pinch.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -20,
      }),
    );
    for (const controller of controllers) controller.dispose();
    return { calls, mouseAllowed, outsideAllowed, pinchAllowed, trackpadAllowed };
  });

  expect(result.outsideAllowed).toBe(true);
  expect(result.mouseAllowed).toBe(false);
  expect(result.trackpadAllowed).toBe(false);
  expect(result.pinchAllowed).toBe(false);
  expect(result.calls).toEqual(
    expect.arrayContaining(['camera:zoom-out', 'camera:pan', 'camera:zoom-in']),
  );
});

function getCameraHarnessBundle(): Promise<string> {
  cameraHarnessBundle ??= build({
    absWorkingDir: process.cwd(),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    stdin: {
      contents: `
        import { WorkbenchApp } from './src/webview/app.ts';
        import { GraphCameraController } from './src/webview/graph/camera-controller.ts';

        function createRenderer(calls) {
          return {
            replaceGraph() { calls.push('replaceGraph'); },
            setFolderGrouping(enabled) { calls.push('setFolderGrouping:' + enabled); },
            selectNode(nodeId) { calls.push(nodeId === undefined ? 'selectNode:clear' : 'selectNode:' + nodeId); },
            focusNode(nodeId) { calls.push('focusNode:' + nodeId); },
            zoomIn() { calls.push('zoomIn'); },
            zoomOut() { calls.push('zoomOut'); },
            fitGraph() { calls.push('fitGraph'); },
            resetCamera() { calls.push('resetCamera'); },
            resize() {},
            pause() {},
            setVisible() {},
            dispose() { calls.push('dispose'); }
          };
        }

        globalThis.__okfCameraHarness = {
          createApp(root, calls) {
            return new WorkbenchApp(
              root,
              { postMessage(message) { calls.push(message.type); } },
              () => createRenderer(calls)
            );
          },
          createController(root, calls) {
            Object.defineProperties(root, {
              clientWidth: { configurable: true, value: 800 },
              clientHeight: { configurable: true, value: 600 }
            });
            let position = { x: 0, y: 0, z: 100 };
            let target = { x: 0, y: 0, z: 0 };
            return new GraphCameraController(
              root,
              {
                getPosition() { return position; },
                getTarget() { return target; },
                moveTo(nextPosition, nextTarget) {
                  const previousDistance = Math.hypot(
                    position.x - target.x,
                    position.y - target.y,
                    position.z - target.z
                  );
                  const nextDistance = Math.hypot(
                    nextPosition.x - nextTarget.x,
                    nextPosition.y - nextTarget.y,
                    nextPosition.z - nextTarget.z
                  );
                  const targetMoved =
                    nextTarget.x !== target.x || nextTarget.y !== target.y || nextTarget.z !== target.z;
                  calls.push(
                    targetMoved
                      ? 'camera:pan'
                      : nextDistance < previousDistance
                        ? 'camera:zoom-in'
                        : 'camera:zoom-out'
                  );
                  position = nextPosition;
                  target = nextTarget;
                },
                fitGraph() {}
              },
              { onMotionStart() {}, onMotionEnd() {} }
            );
          }
        };
      `,
      loader: 'ts',
      resolveDir: process.cwd(),
      sourcefile: 'okf-camera-harness.ts',
    },
  }).then(
    (result) => result.outputFiles[0]?.text ?? Promise.reject(new Error('No bundle emitted.')),
  );
  return cameraHarnessBundle;
}
