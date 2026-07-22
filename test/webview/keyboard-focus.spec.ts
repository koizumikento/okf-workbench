import { expect, test, type Page } from '@playwright/test';

interface FixtureNode {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly tags: readonly string[];
}

const INITIAL_NODES: readonly FixtureNode[] = [
  { id: 'alpha', type: 'note', title: 'Alpha', tags: ['red'] },
  { id: 'beta', type: 'note', title: 'Beta', tags: ['blue'] },
  { id: 'gamma', type: 'decision', title: 'Gamma', tags: ['red'] },
];

test.beforeEach(async ({ page }) => {
  await page.setContent('<main data-okf-workbench-root></main>');
  await page.evaluate(() => {
    const webviewGlobal = globalThis as typeof globalThis & {
      __okfMessages?: unknown[];
      acquireVsCodeApi?: () => { postMessage(message: unknown): void };
    };
    webviewGlobal.__okfMessages = [];
    webviewGlobal.acquireVsCodeApi = () => ({
      postMessage(message) {
        webviewGlobal.__okfMessages?.push(message);
      },
    });
  });
  await page.addStyleTag({ path: 'dist/webview/main.css' });
  await page.addScriptTag({ path: 'dist/webview/main.js', type: 'module' });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const messages = (
          globalThis as typeof globalThis & { readonly __okfMessages?: readonly unknown[] }
        ).__okfMessages;
        return messages?.some(
          (message) =>
            typeof message === 'object' &&
            message !== null &&
            'type' in message &&
            message.type === 'ready',
        );
      }),
    )
    .toBe(true);
  await sendGraph(page, 1, INITIAL_NODES);
  await expect(page.locator('button[data-node-id]')).toHaveCount(INITIAL_NODES.length);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const messages = (
          globalThis as typeof globalThis & { readonly __okfMessages?: readonly unknown[] }
        ).__okfMessages;
        return messages?.some(
          (message) =>
            typeof message === 'object' &&
            message !== null &&
            'type' in message &&
            message.type === 'graphRendered' &&
            'revision' in message &&
            message.revision === 1,
        );
      }),
    )
    .toBe(true);
});

test('keeps filter and selected-result focus during keyboard-only interaction', async ({
  page,
}) => {
  const search = page.getByRole('searchbox', { name: 'Search concepts' });
  const decisionFilter = page.getByLabel('decision', { exact: true });

  await page.keyboard.press('Tab');
  await expect(search).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(decisionFilter).toBeFocused();

  await page.keyboard.press('Space');
  await expect(decisionFilter).toBeChecked();
  await expect(decisionFilter).toBeFocused();
  await expect(page.locator('button[data-node-id]')).toHaveCount(1);
  await expect(page.locator('button[data-node-id="gamma"]')).toBeVisible();

  await page.keyboard.press('Space');
  await expect(decisionFilter).not.toBeChecked();
  await expect(decisionFilter).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(search).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const alpha = page.locator('button[data-node-id="alpha"]');
  await expect(alpha).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(alpha).toHaveAttribute('aria-pressed', 'true');
  await expect(alpha).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Alpha' })).toBeVisible();
});

test('restores semantic or nearest focus across graph replacement and opens source by keyboard', async ({
  page,
}) => {
  const search = page.getByRole('searchbox', { name: 'Search concepts' });
  await page.keyboard.press('Tab');
  await expect(search).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  const gamma = page.locator('button[data-node-id="gamma"]');
  await expect(gamma).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(gamma).toBeFocused();

  await sendGraph(page, 2, [
    { id: 'alpha', type: 'note', title: 'Alpha', tags: ['red'] },
    { id: 'beta', type: 'note', title: 'Beta', tags: ['blue'] },
    { id: 'gamma', type: 'decision', title: '0 Gamma', tags: ['red'] },
  ]);
  await expect(gamma).toBeFocused();

  await sendGraph(page, 3, [
    { id: 'alpha', type: 'note', title: 'Alpha', tags: ['red'] },
    { id: 'beta', type: 'note', title: 'Beta', tags: ['blue'] },
  ]);
  const alpha = page.locator('button[data-node-id="alpha"]');
  await expect(alpha).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(alpha).toBeFocused();

  await page.keyboard.press('Tab');
  await expect(page.locator('button[data-node-id="beta"]')).toBeFocused();
  await page.keyboard.press('Tab');
  const openSource = page.getByRole('button', { name: 'Open source Markdown' });
  await expect(openSource).toBeFocused();
  await page.keyboard.press('Enter');

  await expect
    .poll(() =>
      page.evaluate(() => {
        const messages = (
          globalThis as typeof globalThis & { readonly __okfMessages?: readonly unknown[] }
        ).__okfMessages;
        return messages?.at(-1);
      }),
    )
    .toEqual({ protocolVersion: 1, type: 'openSource', revision: 3, nodeId: 'alpha' });
});

test('preserves a focused filter by value and falls back within its group after refresh', async ({
  page,
}) => {
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const decisionFilter = page.getByLabel('decision', { exact: true });
  await expect(decisionFilter).toBeFocused();

  await sendGraph(page, 2, [
    { id: 'alpha', type: 'note', title: 'Alpha', tags: ['red'] },
    { id: 'gamma', type: 'decision', title: 'Gamma updated', tags: ['red'] },
  ]);
  await expect(decisionFilter).toBeFocused();

  await sendGraph(page, 3, [{ id: 'alpha', type: 'note', title: 'Alpha', tags: ['red'] }]);
  await expect(page.getByLabel('note', { exact: true })).toBeFocused();
});

test('keeps valid concepts visible when one diagnostic node has an empty type', async ({
  page,
}) => {
  await sendGraph(page, 2, [
    { id: 'alpha', type: 'note', title: 'Alpha', tags: ['red'] },
    { id: 'missing-type', type: '', title: 'Needs repair', tags: ['red'] },
  ]);

  await expect(page.locator('button[data-node-id]')).toHaveCount(2);
  const diagnosticNode = page.locator('button[data-node-id="missing-type"]');
  await expect(diagnosticNode).toContainText('Missing type');

  await page.keyboard.press('Tab');
  await page.keyboard.type('missing-type');
  await page.keyboard.press('ArrowDown');
  await expect(diagnosticNode).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.okf-metadata')).toContainText('Missing type');
  await expect(diagnosticNode).toBeFocused();
});

async function sendGraph(
  page: Page,
  revision: number,
  nodes: readonly FixtureNode[],
): Promise<void> {
  await page.evaluate(
    ({ graphRevision, graphNodes }) => {
      const nodeIds = new Set(graphNodes.map((node) => node.id));
      const edges =
        nodeIds.has('alpha') && nodeIds.has('beta')
          ? [
              {
                id: 'alpha:0:beta',
                source: 'alpha',
                target: 'beta',
                sourceRange: {
                  start: { offset: 0, line: 0, character: 0 },
                  end: { offset: 4, line: 0, character: 4 },
                },
              },
            ]
          : [];
      const typeCounts: Record<string, number> = {};
      const tagCounts: Record<string, number> = {};
      for (const node of graphNodes) {
        typeCounts[node.type] = (typeCounts[node.type] ?? 0) + 1;
        for (const tag of node.tags) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
      }
      const backlinks = Object.fromEntries(graphNodes.map((node) => [node.id, [] as string[]]));
      if (nodeIds.has('alpha') && nodeIds.has('beta')) backlinks.beta = ['alpha'];

      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            protocolVersion: 1,
            type: 'replaceGraph',
            revision: graphRevision,
            payload: {
              protocolVersion: 1,
              revision: graphRevision,
              nodes: graphNodes.map((node) => ({
                ...node,
                description: `${node.title} fixture`,
                orphan: !nodeIds.has('alpha') || !nodeIds.has('beta'),
                brokenLinkCount: 0,
              })),
              edges,
              backlinks,
              brokenLinks: [],
              statistics: {
                conceptCount: graphNodes.length,
                edgeCount: edges.length,
                orphanCount: graphNodes.filter(() => !nodeIds.has('alpha') || !nodeIds.has('beta'))
                  .length,
                brokenLinkCount: 0,
                typeCounts,
                tagCounts,
              },
            },
          },
        }),
      );
    },
    { graphRevision: revision, graphNodes: nodes },
  );
}
