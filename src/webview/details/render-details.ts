import type { GraphNode } from '../../core/model/types.js';
import { folderBreadcrumb } from '../state/folders.js';
import { detailsFocusKey, type DetailsFocusGroup } from '../state/focus.js';
import { displayConceptType } from '../state/labels.js';
import type { PresentationState } from '../state/presentation.js';
import { appendTextDefinition, createElement } from '../dom/elements.js';

export interface DetailsCallbacks {
  readonly onNavigate: (nodeId: string) => void;
  readonly onOpenSource: (nodeId: string) => void;
  readonly onSelectFolder: (folderPath: string) => void;
}

function nodeLabel(node: GraphNode | undefined, fallbackId: string): string {
  return node?.title ?? fallbackId;
}

function appendNodeLinks(
  container: HTMLElement,
  title: string,
  focusGroup: Exclude<DetailsFocusGroup, 'source'>,
  ids: readonly string[],
  nodesById: ReadonlyMap<string, GraphNode>,
  onNavigate: (nodeId: string) => void,
): void {
  container.append(createElement('h3', 'okf-details__subheading', title));
  if (ids.length === 0) {
    container.append(createElement('p', 'okf-muted', 'None'));
    return;
  }

  const list = createElement('ul', 'okf-link-list');
  const occurrences = new Map<string, number>();
  for (const id of ids) {
    const occurrence = occurrences.get(id) ?? 0;
    occurrences.set(id, occurrence + 1);
    const item = createElement('li');
    const button = createElement('button', 'okf-text-button', nodeLabel(nodesById.get(id), id));
    button.type = 'button';
    button.dataset.focusKey = detailsFocusKey(focusGroup, id, occurrence);
    button.addEventListener('click', () => onNavigate(id));
    item.append(button);
    if (nodesById.get(id)?.title !== undefined)
      item.append(createElement('span', 'okf-muted', ` (${id})`));
    list.append(item);
  }
  container.append(list);
}

function createFolderBreadcrumb(
  node: GraphNode,
  selectedFolderPath: string | undefined,
  onSelectFolder: (folderPath: string) => void,
): HTMLElement {
  const navigation = createElement('nav', 'okf-folder-breadcrumb');
  navigation.setAttribute('aria-label', 'Concept folder');
  const list = createElement('ol', 'okf-folder-breadcrumb__list');
  const folders = folderBreadcrumb(node.id);
  for (const [index, folder] of folders.entries()) {
    const item = createElement('li', 'okf-folder-breadcrumb__item');
    const button = createElement('button', 'okf-text-button', folder.label);
    button.type = 'button';
    button.dataset.focusKey = `folder:${folder.path}`;
    button.setAttribute('aria-pressed', String(selectedFolderPath === folder.path));
    button.title =
      folder.path === '' ? 'Show concepts at the bundle root' : `Show ${folder.path} subtree`;
    button.addEventListener('click', () => onSelectFolder(folder.path));
    item.append(button);
    if (index < folders.length - 1) {
      item.append(createElement('span', 'okf-folder-breadcrumb__separator', '/'));
    }
    list.append(item);
  }
  navigation.append(list);
  return navigation;
}

export function renderDetails(
  container: HTMLElement,
  state: PresentationState,
  callbacks: DetailsCallbacks,
): void {
  const heading = createElement('h2', 'okf-panel-title', 'Concept details');
  const graph = state.graph;
  const node = graph?.nodes.find((candidate) => candidate.id === state.selectedNodeId);

  if (graph === undefined || node === undefined) {
    container.replaceChildren(
      heading,
      createElement('p', 'okf-muted', 'Select a concept to inspect its metadata and links.'),
    );
    return;
  }

  const title = createElement('h3', 'okf-details__title', node.title ?? node.id);
  const breadcrumb = createFolderBreadcrumb(
    node,
    state.selectedFolderPath,
    callbacks.onSelectFolder,
  );
  const metadata = createElement('dl', 'okf-metadata');
  appendTextDefinition(metadata, 'ID', node.id);
  if (node.sourceFailed === true) {
    appendTextDefinition(metadata, 'Source status', 'Could not be parsed');
    const repair = createElement(
      'p',
      'okf-muted',
      'Source could not be parsed. Repair the document using the Problems panel, then save it to refresh the graph.',
    );
    const sourceButton = createElement('button', 'okf-primary-button', 'Open source Markdown');
    sourceButton.type = 'button';
    sourceButton.dataset.focusKey = detailsFocusKey('source', node.id);
    sourceButton.addEventListener('click', () => callbacks.onOpenSource(node.id));
    const content = createElement('div', 'okf-details__content');
    content.append(title, breadcrumb, metadata, repair, sourceButton);
    container.replaceChildren(heading, content);
    return;
  }
  appendTextDefinition(metadata, 'Type', displayConceptType(node.type));
  if (node.title !== undefined) appendTextDefinition(metadata, 'Title', node.title);
  if (node.description !== undefined)
    appendTextDefinition(metadata, 'Description', node.description);
  if (node.resource !== undefined) appendTextDefinition(metadata, 'Resource', node.resource);
  appendTextDefinition(metadata, 'Tags', node.tags.length === 0 ? 'None' : node.tags.join(', '));
  if (node.generatedBy !== undefined)
    appendTextDefinition(metadata, 'Generated by', node.generatedBy);
  if (node.generatedAt !== undefined)
    appendTextDefinition(metadata, 'Generated at', node.generatedAt);
  else if (node.timestamp !== undefined)
    appendTextDefinition(metadata, 'Legacy timestamp', node.timestamp);
  if (node.trustTier !== undefined) appendTextDefinition(metadata, 'Trust tier', node.trustTier);
  if (node.status !== undefined) appendTextDefinition(metadata, 'Status', node.status);
  if (node.staleAfter !== undefined) appendTextDefinition(metadata, 'Stale after', node.staleAfter);
  if (node.sourceCount !== undefined)
    appendTextDefinition(metadata, 'Sources', String(node.sourceCount));
  if (node.runtime !== undefined) appendTextDefinition(metadata, 'Runtime', node.runtime);
  if (node.computation !== undefined)
    appendTextDefinition(metadata, 'Computation', node.computation);
  appendTextDefinition(metadata, 'Orphan', node.orphan ? 'Yes' : 'No');
  appendTextDefinition(metadata, 'Broken links', String(node.brokenLinkCount));

  const sourceButton = createElement('button', 'okf-primary-button', 'Open source Markdown');
  sourceButton.type = 'button';
  sourceButton.dataset.focusKey = detailsFocusKey('source', node.id);
  sourceButton.addEventListener('click', () => callbacks.onOpenSource(node.id));

  const content = createElement('div', 'okf-details__content');
  content.append(title, breadcrumb, metadata, sourceButton);

  const nodesById = new Map(graph.nodes.map((candidate) => [candidate.id, candidate]));
  const outgoingIds = graph.edges
    .filter((edge) => edge.source === node.id)
    .map((edge) => edge.target);
  const backlinkIds = graph.backlinks[node.id] ?? [];
  appendNodeLinks(
    content,
    'Outgoing links',
    'outgoing',
    outgoingIds,
    nodesById,
    callbacks.onNavigate,
  );
  appendNodeLinks(content, 'Backlinks', 'backlink', backlinkIds, nodesById, callbacks.onNavigate);

  const broken = graph.brokenLinks.filter((link) => link.sourceId === node.id);
  content.append(createElement('h3', 'okf-details__subheading', 'Broken links'));
  if (broken.length === 0) {
    content.append(createElement('p', 'okf-muted', 'None'));
  } else {
    const list = createElement('ul', 'okf-broken-list');
    for (const link of broken) {
      const item = createElement('li', 'okf-broken-list__item');
      const label = link.label.length > 0 ? link.label : '(no label)';
      item.append(
        createElement('strong', undefined, label),
        createElement('span', 'okf-broken-list__target', link.rawTarget),
        createElement(
          'span',
          'okf-muted',
          `Line ${link.sourceRange.start.line + 1}, column ${link.sourceRange.start.character + 1}`,
        ),
      );
      list.append(item);
    }
    content.append(list);
  }

  container.replaceChildren(heading, content);
}
