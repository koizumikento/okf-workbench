import type { GraphNode } from '../../core/model/types.js';
import { displayConceptType } from '../state/labels.js';
import { detailsFocusKey, type DetailsFocusGroup } from '../state/focus.js';
import type { PresentationState } from '../state/presentation.js';
import { appendTextDefinition, createElement } from '../dom/elements.js';

export interface DetailsCallbacks {
  readonly onNavigate: (nodeId: string) => void;
  readonly onOpenSource: (nodeId: string) => void;
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
    content.append(title, metadata, repair, sourceButton);
    container.replaceChildren(heading, content);
    return;
  }
  appendTextDefinition(metadata, 'Type', displayConceptType(node.type));
  if (node.title !== undefined) appendTextDefinition(metadata, 'Title', node.title);
  if (node.description !== undefined)
    appendTextDefinition(metadata, 'Description', node.description);
  if (node.resource !== undefined) appendTextDefinition(metadata, 'Resource', node.resource);
  appendTextDefinition(metadata, 'Tags', node.tags.length === 0 ? 'None' : node.tags.join(', '));
  if (node.timestamp !== undefined) appendTextDefinition(metadata, 'Timestamp', node.timestamp);
  appendTextDefinition(metadata, 'Orphan', node.orphan ? 'Yes' : 'No');
  appendTextDefinition(metadata, 'Broken links', String(node.brokenLinkCount));

  const sourceButton = createElement('button', 'okf-primary-button', 'Open source Markdown');
  sourceButton.type = 'button';
  sourceButton.dataset.focusKey = detailsFocusKey('source', node.id);
  sourceButton.addEventListener('click', () => callbacks.onOpenSource(node.id));

  const content = createElement('div', 'okf-details__content');
  content.append(title, metadata, sourceButton);

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
