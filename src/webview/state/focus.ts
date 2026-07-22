export type ListNavigationKey = 'ArrowDown' | 'ArrowUp' | 'End' | 'Home';

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
