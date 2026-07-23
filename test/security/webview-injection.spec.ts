import { expect, test } from '@playwright/test';

const injection = '</script><img data-okf-injected src=x onerror="globalThis.__okfPwned=true">';

test('renders hostile metadata and broken-link text without script execution or network egress', async ({
  page,
}) => {
  await page.setContent('<div data-okf-workbench-root></div>');
  await page.evaluate(() => {
    const securityGlobal = globalThis as typeof globalThis & {
      __okfMessages?: unknown[];
      __okfNetworkCalls?: string[];
      __okfPwned?: boolean;
      acquireVsCodeApi?: () => { postMessage(message: unknown): void };
    };
    securityGlobal.__okfMessages = [];
    securityGlobal.__okfNetworkCalls = [];
    securityGlobal.__okfPwned = false;
    securityGlobal.acquireVsCodeApi = () => ({
      postMessage: (message) => securityGlobal.__okfMessages?.push(message),
    });
    globalThis.fetch = ((input: string | URL | Request) => {
      securityGlobal.__okfNetworkCalls?.push(String(input));
      return Promise.reject(new Error('Network is disabled in the security harness.'));
    }) as typeof fetch;
  });
  await page.addStyleTag({ path: 'dist/webview/main.css' });
  await page.addScriptTag({ path: 'dist/webview/main.js', type: 'module' });

  await expect
    .poll(() =>
      page.evaluate(() => {
        const securityGlobal = globalThis as typeof globalThis & { __okfMessages?: unknown[] };
        return securityGlobal.__okfMessages?.length ?? 0;
      }),
    )
    .toBeGreaterThan(0);

  await page.evaluate((hostile) => {
    const range = {
      start: { offset: 0, line: 0, character: 0 },
      end: { offset: 4, line: 0, character: 4 },
    };
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
                id: `id-${hostile}`,
                type: hostile,
                title: hostile,
                description: hostile,
                resource: hostile,
                tags: [hostile],
                timestamp: hostile,
                orphan: true,
                brokenLinkCount: 1,
              },
            ],
            edges: [],
            backlinks: { [`id-${hostile}`]: [] },
            brokenLinks: [
              {
                sourceId: `id-${hostile}`,
                label: hostile,
                rawTarget: hostile,
                sourceRange: range,
              },
            ],
            statistics: {
              conceptCount: 1,
              edgeCount: 0,
              orphanCount: 1,
              brokenLinkCount: 1,
              typeCounts: { [hostile]: 1 },
              tagCounts: { [hostile]: 1 },
            },
          },
        },
      }),
    );
  }, injection);

  const conceptButton = page.locator('button[data-node-id]').first();
  await expect(conceptButton).toContainText(injection);
  await conceptButton.click();
  await expect(page.getByRole('heading', { name: injection }).last()).toBeVisible();
  await expect(page.locator('.okf-metadata')).toContainText(injection);
  await expect(page.locator('.okf-broken-list__target')).toHaveText(injection);

  expect(await page.locator('[data-okf-injected]').count()).toBe(0);
  expect(await page.locator('script').count()).toBe(1);
  expect(
    await page.evaluate(() => {
      const securityGlobal = globalThis as typeof globalThis & {
        __okfNetworkCalls?: string[];
        __okfPwned?: boolean;
      };
      return {
        networkCalls: securityGlobal.__okfNetworkCalls,
        pwned: securityGlobal.__okfPwned,
      };
    }),
  ).toEqual({ networkCalls: [], pwned: false });
});
