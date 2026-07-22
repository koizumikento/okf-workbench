import { describe, expect, it } from 'vitest';
import {
  isListNavigationKey,
  nextResultIndex,
  preservedItemIndex,
} from '../../../src/webview/state/focus.js';

describe('keyboard result navigation', () => {
  it('wraps arrow navigation and supports Home and End', () => {
    expect(nextResultIndex('ArrowDown', -1, 3)).toBe(0);
    expect(nextResultIndex('ArrowDown', 2, 3)).toBe(0);
    expect(nextResultIndex('ArrowUp', 0, 3)).toBe(2);
    expect(nextResultIndex('Home', 2, 3)).toBe(0);
    expect(nextResultIndex('End', 0, 3)).toBe(2);
  });

  it('does not return a focus target for an empty list', () => {
    expect(nextResultIndex('ArrowDown', -1, 0)).toBeUndefined();
  });

  it('only classifies supported navigation keys', () => {
    expect(isListNavigationKey('ArrowDown')).toBe(true);
    expect(isListNavigationKey('Enter')).toBe(false);
  });

  it('preserves the same semantic item after a list rebuild', () => {
    expect(preservedItemIndex('beta', 1, ['alpha', 'beta', 'gamma'])).toBe(1);
    expect(preservedItemIndex('beta', 1, ['beta', 'gamma'])).toBe(0);
  });

  it('uses the nearest stable index when the focused item disappears', () => {
    expect(preservedItemIndex('beta', 1, ['alpha', 'gamma'])).toBe(1);
    expect(preservedItemIndex('gamma', 2, ['alpha'])).toBe(0);
    expect(preservedItemIndex('alpha', 0, [])).toBeUndefined();
  });
});
