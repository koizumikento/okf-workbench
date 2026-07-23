import type { GraphNode } from '../core/model/types.js';
import {
  decodeExtensionToWebviewMessage,
  PROTOCOL_VERSION,
  type GraphRenderFailureReason,
  type WebviewToExtensionMessage,
} from '../shared/protocol/index.js';
import { renderDetails } from './details/index.js';
import { createElement } from './dom/elements.js';
import type { GraphRenderer, GraphRendererFactory } from './graph/adapter.js';
import { createForceGraphRenderer } from './graph/force-graph-adapter.js';
import {
  availableTags,
  availableTypes,
  createInitialPresentationState,
  displayConceptType,
  isListNavigationKey,
  nextResultIndex,
  preservedItemIndex,
  presentationReducer,
  visibleNodes,
  type PresentationAction,
  type PresentationState,
} from './state/index.js';

export interface WebviewApi {
  postMessage(message: WebviewToExtensionMessage): void;
}

interface AppElements {
  readonly status: HTMLParagraphElement;
  readonly statistics: HTMLParagraphElement;
  readonly search: HTMLInputElement;
  readonly typeFilters: HTMLDivElement;
  readonly tagFilters: HTMLDivElement;
  readonly clearFilters: HTMLButtonElement;
  readonly graphHost: HTMLDivElement;
  readonly rendererStatus: HTMLParagraphElement;
  readonly graphEmpty: HTMLParagraphElement;
  readonly resultSummary: HTMLParagraphElement;
  readonly results: HTMLUListElement;
  readonly resultEmpty: HTMLParagraphElement;
  readonly details: HTMLElement;
}

type FilterGroup = 'tag' | 'type';

type FocusAnchor =
  | { readonly kind: 'control'; readonly value: 'clearFilters' | 'search' }
  | { readonly kind: 'result'; readonly value: string; readonly index: number }
  | {
      readonly kind: 'filter';
      readonly group: FilterGroup;
      readonly value: string;
      readonly index: number;
    }
  | { readonly kind: 'details'; readonly value: string; readonly index: number };

class UnavailableGraphRenderer implements GraphRenderer {
  public replaceGraph(): void {}
  public selectNode(): void {}
  public focusNode(): void {}
  public resize(): void {}
  public pause(): void {}
  public setVisible(): void {}
  public dispose(): void {}
}

export class WorkbenchApp {
  readonly #api: WebviewApi;
  readonly #elements: AppElements;
  readonly #renderer: GraphRenderer;
  #rendererOperational: boolean;
  #rendererFailureReason: GraphRenderFailureReason | undefined;
  #deliveryId: number | undefined;
  #reportedFailureDeliveryId: number | undefined;
  #state: PresentationState = createInitialPresentationState();
  #disposed = false;

  readonly #onWindowMessage = (event: MessageEvent<unknown>): void => {
    const decoded = decodeExtensionToWebviewMessage(
      event.data,
      this.#state.revision,
      this.#deliveryId ?? 0,
    );
    if (!decoded.ok) return;

    if (decoded.value.type === 'replaceGraph') {
      const focusAnchor = this.#captureFocusAnchor();
      this.#state = presentationReducer(this.#state, {
        type: 'replaceGraph',
        graph: decoded.value.payload,
      });
      this.#deliveryId = decoded.value.deliveryId;
      this.#reportedFailureDeliveryId = undefined;
      this.#renderAll();
      const renderFailure = this.#syncGraphData();
      this.#restoreFocusAnchor(focusAnchor);
      if (renderFailure === undefined) {
        this.#api.postMessage({
          protocolVersion: PROTOCOL_VERSION,
          type: 'graphRendered',
          revision: this.#state.revision,
          deliveryId: decoded.value.deliveryId,
        });
      } else {
        this.#reportGraphRenderFailure(renderFailure);
      }
      return;
    }

    this.#state = presentationReducer(this.#state, {
      type: 'setStatus',
      revision: decoded.value.revision,
      status: decoded.value.status,
      message: decoded.value.message,
    });
    this.#renderStatus();
  };

  readonly #onVisibilityChange = (): void => {
    if (!this.#rendererOperational) return;
    try {
      this.#renderer.setVisible(document.visibilityState === 'visible');
    } catch {
      this.#markRendererUnavailable('renderer-update-failed');
      this.#reportGraphRenderFailure('renderer-update-failed');
    }
  };

  readonly #onBeforeUnload = (): void => this.dispose();

  public constructor(
    root: HTMLElement,
    api: WebviewApi,
    rendererFactory: GraphRendererFactory = createForceGraphRenderer,
  ) {
    this.#api = api;
    this.#elements = createShell(root);

    try {
      this.#renderer = rendererFactory(this.#elements.graphHost, {
        onSelect: (nodeId) => this.#selectNode(nodeId, false),
      });
      this.#rendererOperational = true;
      this.#rendererFailureReason = undefined;
    } catch {
      this.#renderer = new UnavailableGraphRenderer();
      this.#rendererOperational = false;
      this.#rendererFailureReason = 'renderer-construction-failed';
      this.#showRendererUnavailable();
    }
    this.#deliveryId = undefined;
    this.#reportedFailureDeliveryId = undefined;

    this.#bindControls();
    window.addEventListener('message', this.#onWindowMessage);
    document.addEventListener('visibilitychange', this.#onVisibilityChange);
    window.addEventListener('beforeunload', this.#onBeforeUnload);
    this.#renderAll();
    this.#api.postMessage({ protocolVersion: PROTOCOL_VERSION, type: 'ready' });
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    window.removeEventListener('message', this.#onWindowMessage);
    document.removeEventListener('visibilitychange', this.#onVisibilityChange);
    window.removeEventListener('beforeunload', this.#onBeforeUnload);
    try {
      this.#renderer.dispose();
    } catch {
      // Disposal is best-effort after renderer initialization or update failure.
    }
  }

  #bindControls(): void {
    this.#elements.search.addEventListener('input', () => {
      const focusAnchor = this.#captureFocusAnchor();
      this.#state = presentationReducer(this.#state, {
        type: 'setSearch',
        query: this.#elements.search.value,
      });
      this.#renderResults();
      this.#renderGraphEmpty();
      this.#syncGraphDataAndReportFailure();
      this.#restoreFocusAnchor(focusAnchor);
    });
    this.#elements.search.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown') return;
      const first = this.#resultButtons()[0];
      if (first !== undefined) {
        event.preventDefault();
        first.focus();
      }
    });
    this.#elements.clearFilters.addEventListener('click', () => {
      const focusAnchor = this.#captureFocusAnchor();
      this.#state = presentationReducer(this.#state, { type: 'clearFilters' });
      this.#updateFilterControls();
      this.#renderResults();
      this.#renderGraphEmpty();
      this.#syncGraphDataAndReportFailure();
      this.#restoreFocusAnchor(focusAnchor);
    });
    this.#elements.results.addEventListener('keydown', (event) => {
      if (!isListNavigationKey(event.key)) return;
      const buttons = this.#resultButtons();
      const current = buttons.findIndex((button) => button === document.activeElement);
      const next = nextResultIndex(event.key, current, buttons.length);
      if (next !== undefined) {
        event.preventDefault();
        buttons[next]?.focus();
      }
    });
  }

  #dispatch(action: PresentationAction): void {
    this.#state = presentationReducer(this.#state, action);
  }

  #selectNode(nodeId: string | undefined, focusGraph: boolean): void {
    const focusAnchor = this.#captureFocusAnchor();
    this.#dispatch({ type: 'selectNode', nodeId });
    this.#dispatch({ type: 'focusNode', nodeId });
    if (this.#rendererOperational) {
      try {
        this.#renderer.selectNode(nodeId);
        if (focusGraph && nodeId !== undefined) this.#renderer.focusNode(nodeId);
      } catch {
        this.#markRendererUnavailable('renderer-update-failed');
        this.#reportGraphRenderFailure('renderer-update-failed');
      }
    }
    this.#renderResultSelection();
    this.#renderDetails();
    this.#restoreFocusAnchor(focusAnchor);
  }

  #revealAndSelectNode(nodeId: string): void {
    this.#state = presentationReducer(this.#state, { type: 'setSearch', query: '' });
    this.#state = presentationReducer(this.#state, { type: 'clearFilters' });
    this.#elements.search.value = '';
    this.#updateFilterControls();
    this.#renderResults();
    this.#renderGraphEmpty();
    this.#syncGraphDataAndReportFailure();
    this.#selectNode(nodeId, true);
    if (!this.#focusResult(nodeId)) this.#elements.search.focus();
  }

  #openSource(nodeId: string): void {
    if (
      this.#deliveryId === undefined ||
      this.#state.graph?.nodes.some((node) => node.id === nodeId) !== true
    ) {
      return;
    }
    this.#api.postMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: 'openSource',
      revision: this.#state.revision,
      deliveryId: this.#deliveryId,
      nodeId,
    });
  }

  #renderAll(): void {
    this.#elements.search.value = this.#state.searchQuery;
    this.#renderStatus();
    this.#renderStatistics();
    this.#renderFilters();
    this.#renderResults();
    this.#renderGraphEmpty();
    this.#renderDetails();
  }

  #renderStatus(): void {
    const fallback =
      this.#state.status === 'booting'
        ? 'Starting graph view…'
        : this.#state.status === 'loading'
          ? 'Loading bundle graph…'
          : this.#state.status === 'error'
            ? 'The graph could not be loaded.'
            : 'Graph is current.';
    this.#elements.status.textContent = this.#state.statusMessage ?? fallback;
    this.#elements.status.dataset.status = this.#state.status;
  }

  #renderStatistics(): void {
    const statistics = this.#state.graph?.statistics;
    this.#elements.statistics.textContent =
      statistics === undefined
        ? 'No graph loaded'
        : `${statistics.conceptCount} concepts · ${statistics.edgeCount} links · ${statistics.orphanCount} orphans · ${statistics.brokenLinkCount} broken links`;
  }

  #renderFilters(): void {
    renderFilterGroup(
      this.#elements.typeFilters,
      'type',
      'Type',
      availableTypes(this.#state),
      this.#state.selectedTypes,
      (value) => {
        const focusAnchor = this.#captureFocusAnchor();
        this.#state = presentationReducer(this.#state, { type: 'toggleType', value });
        this.#updateFilterControls();
        this.#renderResults();
        this.#renderGraphEmpty();
        this.#syncGraphDataAndReportFailure();
        this.#restoreFocusAnchor(focusAnchor);
      },
    );
    renderFilterGroup(
      this.#elements.tagFilters,
      'tag',
      'Tag',
      availableTags(this.#state),
      this.#state.selectedTags,
      (value) => {
        const focusAnchor = this.#captureFocusAnchor();
        this.#state = presentationReducer(this.#state, { type: 'toggleTag', value });
        this.#updateFilterControls();
        this.#renderResults();
        this.#renderGraphEmpty();
        this.#syncGraphDataAndReportFailure();
        this.#restoreFocusAnchor(focusAnchor);
      },
    );
    this.#elements.clearFilters.disabled =
      this.#state.selectedTypes.size === 0 && this.#state.selectedTags.size === 0;
  }

  #renderResults(): void {
    const nodes = visibleNodes(this.#state);
    const total = this.#state.graph?.nodes.length ?? 0;
    this.#elements.resultSummary.textContent = `${nodes.length} of ${total} concepts shown`;
    this.#elements.results.replaceChildren(...nodes.map((node) => this.#createResult(node)));

    const emptyMessage =
      total === 0
        ? 'No concepts were found in this bundle.'
        : nodes.length === 0
          ? 'No concepts match the current search and filters.'
          : '';
    this.#elements.resultEmpty.textContent = emptyMessage;
    this.#elements.resultEmpty.hidden = emptyMessage.length === 0;
  }

  #createResult(node: GraphNode): HTMLLIElement {
    const item = createElement('li', 'okf-result-list__item');
    const button = createElement('button', 'okf-result');
    button.type = 'button';
    button.dataset.nodeId = node.id;
    button.setAttribute('aria-pressed', String(node.id === this.#state.selectedNodeId));
    if (node.sourceFailed === true) {
      button.setAttribute(
        'aria-label',
        `${node.id}. Source could not be parsed; repair it using the Problems panel.`,
      );
    }
    button.append(
      createElement('span', 'okf-result__title', node.title ?? node.id),
      createElement(
        'span',
        'okf-result__meta',
        node.sourceFailed === true
          ? `${node.id} · Source unavailable`
          : `${node.id} · ${displayConceptType(node.type)}`,
      ),
    );
    const indicators = createElement('span', 'okf-result__indicators');
    if (node.sourceFailed === true) {
      indicators.append(createElement('span', 'okf-badge okf-badge--error', 'Source unavailable'));
    } else if (node.orphan) {
      indicators.append(createElement('span', 'okf-badge okf-badge--warning', 'Orphan'));
    }
    if (node.sourceFailed !== true && node.brokenLinkCount > 0) {
      indicators.append(
        createElement(
          'span',
          'okf-badge okf-badge--error',
          `${node.brokenLinkCount} broken ${node.brokenLinkCount === 1 ? 'link' : 'links'}`,
        ),
      );
    }
    button.append(indicators);
    button.addEventListener('click', () => this.#selectNode(node.id, true));
    item.append(button);
    return item;
  }

  #renderGraphEmpty(): void {
    const graph = this.#state.graph;
    const visible = visibleNodes(this.#state);
    const message =
      graph === undefined
        ? 'Waiting for graph data.'
        : graph.nodes.length === 0
          ? 'This bundle contains no concepts.'
          : visible.length === 0
            ? 'No concepts match the current search and filters.'
            : '';
    this.#elements.graphEmpty.textContent = message;
    this.#elements.graphEmpty.hidden = message.length === 0;
  }

  #renderDetails(): void {
    renderDetails(this.#elements.details, this.#state, {
      onNavigate: (nodeId) => this.#revealAndSelectNode(nodeId),
      onOpenSource: (nodeId) => this.#openSource(nodeId),
    });
  }

  #syncGraphData(): GraphRenderFailureReason | undefined {
    const graph = this.#state.graph;
    if (graph === undefined) return undefined;
    if (!this.#rendererOperational) {
      return this.#rendererFailureReason ?? 'renderer-construction-failed';
    }
    try {
      this.#renderer.replaceGraph(graph, new Set(visibleNodes(this.#state).map((node) => node.id)));
      this.#renderer.selectNode(this.#state.selectedNodeId);
      return undefined;
    } catch {
      this.#markRendererUnavailable('renderer-update-failed');
      return 'renderer-update-failed';
    }
  }

  #syncGraphDataAndReportFailure(): void {
    const failure = this.#syncGraphData();
    if (failure !== undefined) this.#reportGraphRenderFailure(failure);
  }

  #markRendererUnavailable(reason: GraphRenderFailureReason): void {
    if (this.#rendererOperational) {
      try {
        this.#renderer.dispose();
      } catch {
        // The renderer is already failing; the accessible UI must remain available regardless.
      }
    }
    this.#rendererOperational = false;
    this.#rendererFailureReason = reason;
    this.#showRendererUnavailable();
  }

  #showRendererUnavailable(): void {
    this.#elements.graphHost.replaceChildren();
    this.#elements.rendererStatus.hidden = false;
    this.#elements.rendererStatus.textContent =
      'The 3D renderer is unavailable. Continue with the Concepts list, then reopen this graph view. If the problem continues, check the OKF Workbench output.';
  }

  #reportGraphRenderFailure(reason: GraphRenderFailureReason): void {
    const revision = this.#state.graph?.revision;
    const deliveryId = this.#deliveryId;
    if (revision === undefined || deliveryId === undefined) return;
    if (this.#reportedFailureDeliveryId === deliveryId) return;
    this.#reportedFailureDeliveryId = deliveryId;
    this.#api.postMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: 'graphRenderFailed',
      revision,
      deliveryId,
      reason,
    });
  }

  #resultButtons(): HTMLButtonElement[] {
    return Array.from(
      this.#elements.results.querySelectorAll<HTMLButtonElement>('button[data-node-id]'),
    );
  }

  #renderResultSelection(): void {
    for (const button of this.#resultButtons()) {
      button.setAttribute(
        'aria-pressed',
        String(button.dataset.nodeId === this.#state.selectedNodeId),
      );
    }
  }

  #updateFilterControls(): void {
    for (const input of this.#filterInputs('type')) {
      input.checked = this.#state.selectedTypes.has(input.dataset.filterValue ?? '');
    }
    for (const input of this.#filterInputs('tag')) {
      input.checked = this.#state.selectedTags.has(input.dataset.filterValue ?? '');
    }
    this.#elements.clearFilters.disabled =
      this.#state.selectedTypes.size === 0 && this.#state.selectedTags.size === 0;
  }

  #filterInputs(group: FilterGroup): HTMLInputElement[] {
    const container = group === 'type' ? this.#elements.typeFilters : this.#elements.tagFilters;
    return Array.from(container.querySelectorAll<HTMLInputElement>('input[data-filter-value]'));
  }

  #captureFocusAnchor(): FocusAnchor | undefined {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return undefined;

    if (active === this.#elements.search) return { kind: 'control', value: 'search' };
    if (active === this.#elements.clearFilters) {
      return { kind: 'control', value: 'clearFilters' };
    }

    const resultButtons = this.#resultButtons();
    const resultIndex = resultButtons.findIndex((button) => button === active);
    if (resultIndex >= 0) {
      const value = resultButtons[resultIndex]?.dataset.nodeId;
      if (value !== undefined) return { kind: 'result', value, index: resultIndex };
    }

    for (const group of ['type', 'tag'] as const) {
      const inputs = this.#filterInputs(group);
      const index = inputs.findIndex((input) => input === active);
      if (index < 0) continue;
      const value = inputs[index]?.dataset.filterValue;
      if (value !== undefined) return { kind: 'filter', group, value, index };
    }

    const detailsButtons = Array.from(
      this.#elements.details.querySelectorAll<HTMLButtonElement>('button[data-focus-key]'),
    );
    const detailsIndex = detailsButtons.findIndex((button) => button === active);
    if (detailsIndex >= 0) {
      const value = detailsButtons[detailsIndex]?.dataset.focusKey;
      if (value !== undefined) return { kind: 'details', value, index: detailsIndex };
    }
    return undefined;
  }

  #restoreFocusAnchor(anchor: FocusAnchor | undefined): void {
    if (anchor === undefined) return;

    if (anchor.kind === 'control') {
      const control =
        anchor.value === 'search' ? this.#elements.search : this.#elements.clearFilters;
      if (this.#focusElement(control)) return;
    } else if (anchor.kind === 'result') {
      const buttons = this.#resultButtons();
      const index = preservedItemIndex(
        anchor.value,
        anchor.index,
        buttons.map((button) => button.dataset.nodeId ?? ''),
      );
      if (index !== undefined && this.#focusElement(buttons[index])) return;
    } else if (anchor.kind === 'filter') {
      const inputs = this.#filterInputs(anchor.group);
      const index = preservedItemIndex(
        anchor.value,
        anchor.index,
        inputs.map((input) => input.dataset.filterValue ?? ''),
      );
      if (index !== undefined && this.#focusElement(inputs[index])) return;
    } else {
      const buttons = Array.from(
        this.#elements.details.querySelectorAll<HTMLButtonElement>('button[data-focus-key]'),
      );
      const index = preservedItemIndex(
        anchor.value,
        anchor.index,
        buttons.map((button) => button.dataset.focusKey ?? ''),
      );
      if (index !== undefined && this.#focusElement(buttons[index])) return;
      if (
        this.#state.selectedNodeId !== undefined &&
        this.#focusResult(this.#state.selectedNodeId)
      ) {
        return;
      }
    }

    this.#focusElement(this.#elements.search);
  }

  #focusResult(nodeId: string): boolean {
    const button = this.#resultButtons().find((candidate) => candidate.dataset.nodeId === nodeId);
    return this.#focusElement(button);
  }

  #focusElement(element: HTMLElement | undefined): boolean {
    if (
      element === undefined ||
      !element.isConnected ||
      element.hidden ||
      element.closest('[hidden]') !== null ||
      ((element instanceof HTMLButtonElement || element instanceof HTMLInputElement) &&
        element.disabled)
    ) {
      return false;
    }
    element.focus();
    return document.activeElement === element;
  }
}

function renderFilterGroup(
  container: HTMLElement,
  group: FilterGroup,
  label: string,
  values: readonly string[],
  selected: ReadonlySet<string>,
  onToggle: (value: string) => void,
): void {
  if (values.length === 0) {
    container.replaceChildren(createElement('p', 'okf-muted', `No ${label.toLowerCase()} values`));
    return;
  }

  const items = values.map((value, index) => {
    const wrapper = createElement('label', 'okf-filter');
    const checkbox = createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selected.has(value);
    checkbox.id = `okf-${label.toLowerCase()}-${String(index)}`;
    checkbox.dataset.filterGroup = group;
    checkbox.dataset.filterValue = value;
    checkbox.addEventListener('change', () => onToggle(value));
    wrapper.append(
      checkbox,
      createElement('span', undefined, group === 'type' ? displayConceptType(value) : value),
    );
    return wrapper;
  });
  container.replaceChildren(...items);
}

function createShell(root: HTMLElement): AppElements {
  root.className = 'okf-workbench';
  const header = createElement('header', 'okf-header');
  const heading = createElement('h1', 'okf-title', 'OKF 3D Graph');
  const status = createElement('p', 'okf-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const statistics = createElement('p', 'okf-statistics');
  header.append(heading, status, statistics);

  const controls = createElement('aside', 'okf-controls');
  controls.setAttribute('aria-label', 'Graph search and filters');
  const searchLabel = createElement('label', 'okf-label', 'Search concepts');
  searchLabel.htmlFor = 'okf-concept-search';
  const search = createElement('input', 'okf-search');
  search.id = 'okf-concept-search';
  search.type = 'search';
  search.placeholder = 'ID, title, or tag';
  search.autocomplete = 'off';

  const typeFieldset = createElement('fieldset', 'okf-fieldset');
  typeFieldset.append(createElement('legend', 'okf-label', 'Types'));
  const typeFilters = createElement('div', 'okf-filter-list');
  typeFieldset.append(typeFilters);
  const tagFieldset = createElement('fieldset', 'okf-fieldset');
  tagFieldset.append(createElement('legend', 'okf-label', 'Tags'));
  const tagFilters = createElement('div', 'okf-filter-list');
  tagFieldset.append(tagFilters);
  const clearFilters = createElement('button', 'okf-secondary-button', 'Clear filters');
  clearFilters.type = 'button';
  controls.append(searchLabel, search, typeFieldset, tagFieldset, clearFilters);

  const graphSection = createElement('section', 'okf-graph-panel');
  graphSection.setAttribute('aria-labelledby', 'okf-graph-title');
  const graphHeading = createElement('h2', 'okf-panel-title', '3D graph');
  graphHeading.id = 'okf-graph-title';
  const graphHost = createElement('div', 'okf-graph-host');
  graphHost.setAttribute('aria-hidden', 'true');
  const rendererStatus = createElement('p', 'okf-renderer-unavailable');
  rendererStatus.setAttribute('role', 'alert');
  rendererStatus.hidden = true;
  const graphEmpty = createElement('p', 'okf-empty okf-graph-empty');
  graphSection.append(graphHeading, graphHost, rendererStatus, graphEmpty);

  const resultsSection = createElement('nav', 'okf-results-panel');
  resultsSection.setAttribute('aria-labelledby', 'okf-results-title');
  const resultsHeading = createElement('h2', 'okf-panel-title', 'Concepts');
  resultsHeading.id = 'okf-results-title';
  const resultSummary = createElement('p', 'okf-muted');
  resultSummary.setAttribute('aria-live', 'polite');
  const results = createElement('ul', 'okf-result-list');
  const resultEmpty = createElement('p', 'okf-empty');
  resultsSection.append(resultsHeading, resultSummary, results, resultEmpty);

  const details = createElement('aside', 'okf-details');
  details.setAttribute('aria-label', 'Selected concept details');

  const workspace = createElement('main', 'okf-layout');
  workspace.append(controls, graphSection, resultsSection, details);
  root.replaceChildren(header, workspace);
  return {
    status,
    statistics,
    search,
    typeFilters,
    tagFilters,
    clearFilters,
    graphHost,
    rendererStatus,
    graphEmpty,
    resultSummary,
    results,
    resultEmpty,
    details,
  };
}
