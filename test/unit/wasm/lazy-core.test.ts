import { describe, expect, test, vi } from 'vitest';

import type { OkfCore } from '../../../src/core/wasm/index.js';
import { createLazyOkfCore } from '../../../src/core/wasm/index.js';

describe('lazy Wasm core adapter', () => {
  test('does not instantiate the core for startup-only CLI activation', () => {
    const inspect = vi.fn();
    const load = vi.fn(
      (): OkfCore =>
        ({
          abiVersion: 1,
          coreVersion: '0.1.0',
          inspect,
        }) as unknown as OkfCore,
    );
    const core = createLazyOkfCore(load);

    expect(load).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();

    void core.abiVersion;
    expect(load).toHaveBeenCalledOnce();
    void core.coreVersion;
    expect(load).toHaveBeenCalledOnce();
  });
});
