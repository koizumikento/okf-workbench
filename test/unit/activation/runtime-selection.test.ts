import { describe, expect, it } from 'vitest';

import { activeWorkspaceSafetyRootWasRemoved } from '../../../src/extension/runtimeSelection.js';

describe('runtime selection lifecycle identity', () => {
  it('forces a new generation only when the exact active safety root was removed', () => {
    const selection = {
      root: 'memfs://workspace/knowledge',
      workspaceSafetyRoot: 'memfs://workspace',
    };

    expect(activeWorkspaceSafetyRootWasRemoved(undefined, ['memfs://workspace'])).toBe(false);
    expect(activeWorkspaceSafetyRootWasRemoved(selection, [])).toBe(false);
    expect(activeWorkspaceSafetyRootWasRemoved(selection, ['memfs://workspace-other'])).toBe(false);
    expect(activeWorkspaceSafetyRootWasRemoved(selection, ['memfs://workspace/child'])).toBe(false);
    expect(activeWorkspaceSafetyRootWasRemoved(selection, ['memfs://workspace'])).toBe(true);
  });
});
