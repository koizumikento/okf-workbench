import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

let failureHarnessBundle: Promise<string> | undefined;

test('renderer construction failure sends failure readiness while preserving accessible navigation', async ({
  page,
}) => {
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: await getFailureHarnessBundle(), type: 'module' });
  await page.evaluate(() => {
    const failureGlobal = globalThis as typeof globalThis & {
      __okfFailureHarness?: {
        create(
          root: HTMLElement,
          messages: unknown[],
          failureMode: 'construction' | 'update',
        ): { dispose(): void };
      };
      __okfFailureMessages?: unknown[];
      __okfFailureApp?: { dispose(): void };
    };
    const root = document.createElement('main');
    document.body.replaceChildren(root);
    const messages: unknown[] = [];
    const harness = failureGlobal.__okfFailureHarness;
    if (harness === undefined) throw new Error('Failure harness was not installed.');
    failureGlobal.__okfFailureMessages = messages;
    failureGlobal.__okfFailureApp = harness.create(root, messages, 'construction');
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          protocolVersion: 1,
          type: 'replaceGraph',
          revision: 9,
          deliveryId: 1,
          payload: {
            protocolVersion: 1,
            revision: 9,
            nodes: [
              {
                id: 'alpha',
                type: 'concept',
                title: 'Alpha',
                description: 'Accessible fallback concept',
                tags: ['fallback'],
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
              tagCounts: { fallback: 1 },
            },
          },
        },
      }),
    );
  });

  await expect(page.getByRole('alert')).toContainText('Continue with the Concepts list');
  await expect(page.getByRole('alert')).toContainText('reopen this graph view');
  await expect(page.locator('button[data-node-id="alpha"]')).toBeVisible();

  const messages = await page.evaluate(
    () =>
      (globalThis as typeof globalThis & { readonly __okfFailureMessages?: readonly unknown[] })
        .__okfFailureMessages ?? [],
  );
  expect(messages).toContainEqual({
    protocolVersion: 1,
    type: 'graphRenderFailed',
    revision: 9,
    deliveryId: 1,
    reason: 'renderer-construction-failed',
  });
  expect(messages).not.toContainEqual(
    expect.objectContaining({ type: 'graphRendered', revision: 9 }),
  );
  expect(JSON.stringify(messages)).not.toContain('sensitive constructor detail');

  await page.keyboard.press('Tab');
  await page.keyboard.press('ArrowDown');
  const alpha = page.locator('button[data-node-id="alpha"]');
  await expect(alpha).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Open source Markdown' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const failureMessages = (
          globalThis as typeof globalThis & { readonly __okfFailureMessages?: readonly unknown[] }
        ).__okfFailureMessages;
        return failureMessages?.at(-1);
      }),
    )
    .toEqual({
      protocolVersion: 1,
      type: 'openSource',
      revision: 9,
      deliveryId: 1,
      nodeId: 'alpha',
    });

  await page.evaluate(() => {
    (
      globalThis as typeof globalThis & { readonly __okfFailureApp?: { dispose(): void } }
    ).__okfFailureApp?.dispose();
  });
});

test('graph-data application failure reports update failure instead of rendered readiness', async ({
  page,
}) => {
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: await getFailureHarnessBundle(), type: 'module' });
  const messages = await page.evaluate(() => {
    const failureGlobal = globalThis as typeof globalThis & {
      __okfFailureHarness?: {
        create(
          root: HTMLElement,
          messages: unknown[],
          failureMode: 'construction' | 'update',
        ): { dispose(): void };
      };
    };
    const root = document.createElement('main');
    document.body.replaceChildren(root);
    const captured: unknown[] = [];
    const app = failureGlobal.__okfFailureHarness?.create(root, captured, 'update');
    if (app === undefined) throw new Error('Failure harness was not installed.');
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          protocolVersion: 1,
          type: 'replaceGraph',
          revision: 11,
          deliveryId: 2,
          payload: {
            protocolVersion: 1,
            revision: 11,
            nodes: [],
            edges: [],
            backlinks: {},
            brokenLinks: [],
            statistics: {
              conceptCount: 0,
              edgeCount: 0,
              orphanCount: 0,
              brokenLinkCount: 0,
              typeCounts: {},
              tagCounts: {},
            },
          },
        },
      }),
    );
    app.dispose();
    return captured;
  });

  expect(messages).toContainEqual({
    protocolVersion: 1,
    type: 'graphRenderFailed',
    revision: 11,
    deliveryId: 2,
    reason: 'renderer-update-failed',
  });
  expect(messages).not.toContainEqual(
    expect.objectContaining({ type: 'graphRendered', revision: 11 }),
  );
  await expect(page.getByRole('alert')).toContainText('3D renderer is unavailable');
});

function getFailureHarnessBundle(): Promise<string> {
  failureHarnessBundle ??= build({
    absWorkingDir: process.cwd(),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    stdin: {
      contents: `
        import { WorkbenchApp } from './src/webview/app.ts';
        globalThis.__okfFailureHarness = {
          create(root, messages, failureMode) {
            return new WorkbenchApp(
              root,
              { postMessage(message) { messages.push(message); } },
              () => {
                if (failureMode === 'construction') {
                  throw new Error('sensitive constructor detail');
                }
                return {
                  replaceGraph() { throw new Error('sensitive update detail'); },
                  selectNode() {}, focusNode() {}, zoomIn() {}, zoomOut() {}, fitGraph() {},
                  resetCamera() {}, resize() {}, pause() {}, setVisible() {}, dispose() {}
                };
              }
            );
          }
        };
      `,
      loader: 'ts',
      resolveDir: process.cwd(),
      sourcefile: 'okf-renderer-failure-harness.ts',
    },
  }).then(
    (result) => result.outputFiles[0]?.text ?? Promise.reject(new Error('No bundle emitted.')),
  );
  return failureHarnessBundle;
}
