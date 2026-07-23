export type ListNavigationKey = 'ArrowDown' | 'ArrowUp' | 'End' | 'Home';

export type DetailsFocusGroup = 'backlink' | 'outgoing' | 'source';

/**
 * Identify a details control by its semantic destination rather than its current list position.
 * The occurrence keeps duplicate links distinct without letting unrelated sibling reordering
 * change the key. JSON encoding avoids collisions for concept IDs containing punctuation.
 */
export function detailsFocusKey(group: DetailsFocusGroup, nodeId: string, occurrence = 0): string {
  return JSON.stringify([group, nodeId, occurrence]);
}

export function isListNavigationKey(key: string): key is ListNavigationKey {
  return key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End';
}

/** Return the next result index for a wrapping, keyboard-accessible node list. */
export function nextResultIndex(
  key: ListNavigationKey,
  currentIndex: number,
  resultCount: number,
): number | undefined {
  if (resultCount === 0) {
    return undefined;
  }
  if (key === 'Home') {
    return 0;
  }
  if (key === 'End') {
    return resultCount - 1;
  }
  if (key === 'ArrowDown') {
    return currentIndex < 0 || currentIndex >= resultCount - 1 ? 0 : currentIndex + 1;
  }
  return currentIndex <= 0 ? resultCount - 1 : currentIndex - 1;
}

/**
 * Preserve the same semantic item after a DOM list is rebuilt. If it no longer exists, select the
 * item now occupying the nearest stable index rather than dropping focus onto the document body.
 */
export function preservedItemIndex(
  previousValue: string,
  previousIndex: number,
  nextValues: readonly string[],
): number | undefined {
  const exactIndex = nextValues.indexOf(previousValue);
  if (exactIndex >= 0) return exactIndex;
  if (nextValues.length === 0) return undefined;
  return Math.max(0, Math.min(previousIndex, nextValues.length - 1));
}
