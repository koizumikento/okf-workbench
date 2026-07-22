import type { GraphNode, GraphPayload } from '../../core/model/types.js';
import type { WebviewStatus } from '../../shared/protocol/index.js';
import { matchesSearch } from './search.js';

export interface PresentationState {
  readonly revision: number;
  readonly graph: GraphPayload | undefined;
  readonly status: 'booting' | WebviewStatus;
  readonly statusMessage: string | undefined;
  readonly searchQuery: string;
  readonly selectedTypes: ReadonlySet<string>;
  readonly selectedTags: ReadonlySet<string>;
  readonly selectedNodeId: string | undefined;
  readonly focusedNodeId: string | undefined;
}

export type PresentationAction =
  | { readonly type: 'replaceGraph'; readonly graph: GraphPayload }
  | {
      readonly type: 'setStatus';
      readonly revision: number;
      readonly status: WebviewStatus;
      readonly message: string | undefined;
    }
  | { readonly type: 'setSearch'; readonly query: string }
  | { readonly type: 'toggleType'; readonly value: string }
  | { readonly type: 'toggleTag'; readonly value: string }
  | { readonly type: 'clearFilters' }
  | { readonly type: 'selectNode'; readonly nodeId: string | undefined }
  | { readonly type: 'focusNode'; readonly nodeId: string | undefined };

export function createInitialPresentationState(): PresentationState {
  return {
    revision: 0,
    graph: undefined,
    status: 'booting',
    statusMessage: undefined,
    searchQuery: '',
    selectedTypes: new Set(),
    selectedTags: new Set(),
    selectedNodeId: undefined,
    focusedNodeId: undefined,
  };
}

function toggled(values: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(values);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
}

function nodeExists(graph: GraphPayload | undefined, nodeId: string | undefined): boolean {
  return nodeId !== undefined && graph?.nodes.some((node) => node.id === nodeId) === true;
}

export function presentationReducer(
  state: PresentationState,
  action: PresentationAction,
): PresentationState {
  switch (action.type) {
    case 'replaceGraph': {
      if (action.graph.revision < state.revision) {
        return state;
      }
      return {
        ...state,
        revision: action.graph.revision,
        graph: action.graph,
        status: 'ready',
        statusMessage: undefined,
        selectedNodeId: nodeExists(action.graph, state.selectedNodeId)
          ? state.selectedNodeId
          : undefined,
        focusedNodeId: nodeExists(action.graph, state.focusedNodeId)
          ? state.focusedNodeId
          : undefined,
      };
    }
    case 'setStatus':
      return action.revision < state.revision
        ? state
        : {
            ...state,
            status: action.status,
            statusMessage: action.message,
          };
    case 'setSearch':
      return { ...state, searchQuery: action.query };
    case 'toggleType':
      return { ...state, selectedTypes: toggled(state.selectedTypes, action.value) };
    case 'toggleTag':
      return { ...state, selectedTags: toggled(state.selectedTags, action.value) };
    case 'clearFilters':
      return { ...state, selectedTypes: new Set(), selectedTags: new Set() };
    case 'selectNode':
      return nodeExists(state.graph, action.nodeId) || action.nodeId === undefined
        ? { ...state, selectedNodeId: action.nodeId }
        : state;
    case 'focusNode':
      return nodeExists(state.graph, action.nodeId) || action.nodeId === undefined
        ? { ...state, focusedNodeId: action.nodeId }
        : state;
  }
}

export function visibleNodes(state: PresentationState): readonly GraphNode[] {
  if (state.graph === undefined) {
    return [];
  }

  return state.graph.nodes
    .filter((node) => matchesSearch(node, state.searchQuery))
    .filter((node) => state.selectedTypes.size === 0 || state.selectedTypes.has(node.type))
    .filter(
      (node) =>
        state.selectedTags.size === 0 || node.tags.some((tag) => state.selectedTags.has(tag)),
    )
    .slice()
    .sort((left, right) => {
      const leftLabel = left.title ?? left.id;
      const rightLabel = right.title ?? right.id;
      if (leftLabel < rightLabel) return -1;
      if (leftLabel > rightLabel) return 1;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
}

export function selectedNode(state: PresentationState): GraphNode | undefined {
  return state.graph?.nodes.find((node) => node.id === state.selectedNodeId);
}

export function availableTypes(state: PresentationState): readonly string[] {
  return state.graph === undefined ? [] : Object.keys(state.graph.statistics.typeCounts).sort();
}

export function availableTags(state: PresentationState): readonly string[] {
  return state.graph === undefined ? [] : Object.keys(state.graph.statistics.tagCounts).sort();
}
