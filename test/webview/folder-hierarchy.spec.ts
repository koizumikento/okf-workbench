import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.setContent('<main data-okf-workbench-root></main>');
  await page.evaluate(() => {
    (
      globalThis as typeof globalThis & { acquireVsCodeApi?: () => { postMessage(): void } }
    ).acquireVsCodeApi = () => ({ postMessage() {} });
  });
  await page.addStyleTag({ path: 'dist/webview/main.css' });
  await page.addScriptTag({ path: 'dist/webview/main.js', type: 'module' });
  await page.waitForFunction(() => document.querySelector('[data-okf-workbench-root] input'));
  await sendFolderGraph(page);
});

test('composes folder subtree selection with search and metadata filters', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'All folders (4)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Bundle root (1 direct)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'product (2)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'nested (1)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'research (1)' })).toBeVisible();

  await page.getByRole('button', { name: 'product (2)' }).click();
  await expect(page.getByRole('button', { name: 'Clear filters' })).toBeEnabled();
  await expect(page.locator('button[data-node-id]')).toHaveCount(2);
  await expect(page.locator('button[data-node-id="product/alpha"]')).toBeVisible();
  await expect(page.locator('button[data-node-id="product/nested/beta"]')).toBeVisible();

  await page.getByLabel('note', { exact: true }).check();
  await expect(page.locator('button[data-node-id]')).toHaveCount(1);
  await expect(page.locator('button[data-node-id="product/alpha"]')).toBeVisible();

  await page.getByRole('searchbox', { name: 'Search concepts' }).fill('beta');
  await expect(page.locator('button[data-node-id]')).toHaveCount(0);
  await expect(
    page
      .getByRole('navigation', { name: 'Concepts' })
      .getByText('No concepts match the current search and filters.'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.locator('button[data-node-id]')).toHaveCount(1);
  await expect(page.locator('button[data-node-id="product/nested/beta"]')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search concepts' }).fill('');
  await expect(page.locator('button[data-node-id]')).toHaveCount(4);
});

test('uses folder breadcrumbs for navigation and keeps grouping presentation-only', async ({
  page,
}) => {
  await page.locator('button[data-node-id="product/nested/beta"]').click();
  const details = page.getByRole('complementary', { name: 'Selected concept details' });
  const breadcrumb = details.getByRole('navigation', { name: 'Concept folder' });
  await expect(breadcrumb.getByRole('button', { name: 'Bundle root' })).toBeVisible();
  await expect(breadcrumb.getByRole('button', { name: 'product' })).toBeVisible();
  await expect(breadcrumb.getByRole('button', { name: 'nested' })).toBeVisible();

  await breadcrumb.getByRole('button', { name: 'product' }).click();
  await expect(page.locator('button[data-node-id]')).toHaveCount(2);

  const grouping = page.getByRole('checkbox', { name: 'Group 3D graph by folder' });
  await grouping.check();
  await expect(grouping).toBeChecked();
  await expect(page.locator('button[data-node-id]')).toHaveCount(2);
  await expect(page.getByText('4 concepts · 1 links')).toBeVisible();
});

async function sendFolderGraph(page: Page): Promise<void> {
  await page.evaluate(() => {
    const nodes = [
      { id: 'root', type: 'note', title: 'Root', tags: ['blue'], orphan: true },
      { id: 'product/alpha', type: 'note', title: 'Alpha', tags: ['red'], orphan: false },
      {
        id: 'product/nested/beta',
        type: 'decision',
        title: 'Beta',
        tags: ['red'],
        orphan: false,
      },
      {
        id: 'research/alpha',
        type: 'note',
        title: 'Alpha research',
        tags: ['blue'],
        orphan: true,
      },
    ].map((node) => ({
      ...node,
      brokenLinkCount: 0,
    }));
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
            nodes,
            edges: [
              {
                id: 'edge:0',
                source: 'product/alpha',
                target: 'product/nested/beta',
                sourceRange: {
                  start: { offset: 0, line: 0, character: 0 },
                  end: { offset: 1, line: 0, character: 1 },
                },
              },
            ],
            backlinks: {
              root: [],
              'product/alpha': [],
              'product/nested/beta': ['product/alpha'],
              'research/alpha': [],
            },
            brokenLinks: [],
            statistics: {
              conceptCount: 4,
              edgeCount: 1,
              orphanCount: 2,
              brokenLinkCount: 0,
              typeCounts: { note: 3, decision: 1 },
              tagCounts: { red: 2, blue: 2 },
            },
          },
        },
      }),
    );
  });
  await expect(page.locator('button[data-node-id]')).toHaveCount(4);
}
