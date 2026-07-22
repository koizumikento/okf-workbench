import type { GraphNode } from '../../core/model/types.js';

/** Normalize search values exactly as required by ADR 0005. */
export function normalizeSearchValue(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

export function matchesSearch(node: GraphNode, query: string): boolean {
  const terms = normalizeSearchValue(query)
    .trim()
    .split(/\s+/u)
    .filter((term) => term.length > 0);

  if (terms.length === 0) {
    return true;
  }

  const searchableValues = [node.id, node.title ?? '', ...node.tags].map(normalizeSearchValue);
  return terms.every((term) => searchableValues.some((value) => value.includes(term)));
}
