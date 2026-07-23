import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

test('loads the locally bundled accessible Webview shell', async ({ page }) => {
  await page.setContent('<main class="okf-workbench" data-okf-workbench-root></main>');
  await page.addStyleTag({ path: 'dist/webview/main.css' });
  await page.addScriptTag({ path: 'dist/webview/main.js', type: 'module' });

  await expect(page.getByRole('heading', { name: 'OKF 3D Graph' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Starting graph view…');

  const bundle = await readFile('dist/webview/main.js', 'utf8');
  expect(bundle).not.toMatch(/\b(?:fetch|import)\(\s*["'`]https?:\/\//u);
  expect(bundle).not.toMatch(/\b(?:EventSource|WebSocket)\s*\(\s*["'`](?:https?|wss?):\/\//u);
});

test('presents resource and timestamp metadata as inert text', async ({ page }) => {
  await page.setContent('<main class="okf-workbench" data-okf-workbench-root></main>');
  await page.addStyleTag({ path: 'dist/webview/main.css' });
  await page.addScriptTag({ path: 'dist/webview/main.js', type: 'module' });

  const resource = '<img src=x onerror="globalThis.__metadataExecuted=true">';
  const timestamp = '<script>globalThis.__metadataExecuted=true</script>';
  await page.evaluate(
    ({ metadataResource, metadataTimestamp }) => {
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
                  description: 'Metadata presentation fixture',
                  resource: metadataResource,
                  tags: ['test'],
                  timestamp: metadataTimestamp,
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
                tagCounts: { test: 1 },
              },
            },
          },
        }),
      );
    },
    { metadataResource: resource, metadataTimestamp: timestamp },
  );

  await page.getByRole('button', { name: /Alpha/u }).click();
  const metadata = page.locator('.okf-metadata');
  await expect(metadata).toContainText(resource);
  await expect(metadata).toContainText(timestamp);
  await expect(metadata.locator('img')).toHaveCount(0);
  await expect(metadata.locator('script')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as typeof globalThis & { readonly __metadataExecuted?: boolean })
            .__metadataExecuted,
      ),
    )
    .toBeUndefined();
});

test('presents a failed source as repairable identity instead of invented metadata', async ({
  page,
}) => {
  await page.setContent('<main class="okf-workbench" data-okf-workbench-root></main>');
  await page.addStyleTag({ path: 'dist/webview/main.css' });
  await page.addScriptTag({ path: 'dist/webview/main.js', type: 'module' });

  await page.evaluate(() => {
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
                id: 'invalid-yaml',
                sourceFailed: true,
                type: '',
                tags: [],
                orphan: false,
                brokenLinkCount: 0,
              },
            ],
            edges: [],
            backlinks: { 'invalid-yaml': [] },
            brokenLinks: [],
            statistics: {
              conceptCount: 1,
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
  });

  const result = page.getByRole('button', {
    name: /invalid-yaml.*Source could not be parsed.*Problems/u,
  });
  await expect(result).toBeVisible();
  await expect(result).toContainText('Source unavailable');
  await result.click();

  const details = page.getByRole('complementary', { name: 'Selected concept details' });
  await expect(details).toContainText('Source status');
  await expect(details).toContainText('Could not be parsed');
  await expect(details).toContainText('Repair the document using the Problems panel');
  await expect(details.getByText('Type', { exact: true })).toHaveCount(0);
  await expect(details.getByText('Tags', { exact: true })).toHaveCount(0);
  await expect(details.getByText('Orphan', { exact: true })).toHaveCount(0);
  await expect(details.getByText('Broken links', { exact: true })).toHaveCount(0);
  await expect(details.getByRole('button', { name: 'Open source Markdown' })).toBeVisible();
});
