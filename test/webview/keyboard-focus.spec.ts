import { expect, test, type Page } from '@playwright/test';

interface FixtureNode {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly tags: readonly string[];
}

interface FixtureEdge {
  readonly source: string;
  readonly target: string;
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

  await page.keyboard.press('Space');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const clearFilters = page.getByRole('button', { name: 'Clear filters' });
  await expect(clearFilters).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(clearFilters).toBeDisabled();
  await expect(search).toBeFocused();
  await expect(page.locator('button[data-node-id]')).toHaveCount(3);

  await page.keyboard.press('ArrowDown');
  const alpha = page.locator('button[data-node-id="alpha"]');
  await expect(alpha).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(alpha).toHaveAttribute('aria-pressed', 'true');
  await expect(alpha).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Alpha' })).toBeVisible();
});

test('preserves stable details and selection focus across rerenders', async ({ page }) => {
  await sendGraph(page, 2, INITIAL_NODES, [
    { source: 'alpha', target: 'beta' },
    { source: 'alpha', target: 'gamma' },
  ]);
  const alpha = page.locator('button[data-node-id="alpha"]');
  await alpha.focus();
  await page.keyboard.press('Enter');
  await expect(alpha).toBeFocused();

  const gammaLink = page.getByRole('button', { name: 'Gamma', exact: true });
  await gammaLink.focus();
  await expect(gammaLink).toBeFocused();

  await sendGraph(
    page,
    3,
    INITIAL_NODES.map((node) => (node.id === 'gamma' ? { ...node, title: 'Gamma updated' } : node)),
    [
      { source: 'alpha', target: 'gamma' },
      { source: 'alpha', target: 'beta' },
    ],
  );
  await expect(page.getByRole('button', { name: 'Gamma updated', exact: true })).toBeFocused();

  const openSource = page.getByRole('button', { name: 'Open source Markdown' });
  await openSource.focus();
  await alpha.evaluate((element) => {
    if (!(element instanceof HTMLButtonElement)) throw new Error('Expected an Alpha button.');
    element.click();
  });
  await expect(openSource).toBeFocused();
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
    .toEqual({
      protocolVersion: 1,
      type: 'openSource',
      revision: 3,
      deliveryId: 3,
      nodeId: 'alpha',
    });
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
  fixtureEdges?: readonly FixtureEdge[],
): Promise<void> {
  await page.evaluate(
    ({ graphRevision, graphNodes, requestedEdges }) => {
      const nodeIds = new Set(graphNodes.map((node) => node.id));
      const validEdges = (requestedEdges ?? [{ source: 'alpha', target: 'beta' }]).filter(
        (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
      );
      const edges = validEdges.map((edge, index) => ({
        id: `edge:${index.toString(36)}`,
        ...edge,
        sourceRange: {
          start: { offset: index * 5, line: index, character: 0 },
          end: { offset: index * 5 + 4, line: index, character: 4 },
        },
      }));
      const connectedIds = new Set<string>();
      for (const edge of validEdges) {
        connectedIds.add(edge.source);
        connectedIds.add(edge.target);
      }
      const typeCounts: Record<string, number> = {};
      const tagCounts: Record<string, number> = {};
      for (const node of graphNodes) {
        typeCounts[node.type] = (typeCounts[node.type] ?? 0) + 1;
        for (const tag of node.tags) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
      }
      const backlinks = Object.fromEntries(graphNodes.map((node) => [node.id, [] as string[]]));
      for (const edge of validEdges) backlinks[edge.target]?.push(edge.source);

      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            protocolVersion: 1,
            type: 'replaceGraph',
            revision: graphRevision,
            deliveryId: graphRevision,
            payload: {
              protocolVersion: 1,
              revision: graphRevision,
              nodes: graphNodes.map((node) => ({
                ...node,
                description: `${node.title} fixture`,
                orphan: !connectedIds.has(node.id),
                brokenLinkCount: 0,
              })),
              edges,
              backlinks,
              brokenLinks: [],
              statistics: {
                conceptCount: graphNodes.length,
                edgeCount: edges.length,
                orphanCount: graphNodes.filter((node) => !connectedIds.has(node.id)).length,
                brokenLinkCount: 0,
                typeCounts,
                tagCounts,
              },
            },
          },
        }),
      );
    },
    { graphRevision: revision, graphNodes: nodes, requestedEdges: fixtureEdges },
  );
}
