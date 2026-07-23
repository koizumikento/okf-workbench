import { describe, expect, it } from 'vitest';

import {
  FailFastReadCommandGate,
  readCommandBusyProblem,
} from '../../../src/extension/read-command-gate.js';

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('read command admission gate', () => {
  it('does not execute or retain 100 overlapping commands with distinct explicit roots', async () => {
    const gate = new FailFastReadCommandGate();
    const activeStarted = deferred<undefined>();
    const releaseActive = deferred<undefined>();
    const selectedRoots: string[] = [];
    let rejectedCallbacks = 0;

    const active = gate.run(async () => {
      selectedRoots.push('memfs://workspace/bundle-a');
      activeStarted.resolve(undefined);
      await releaseActive.promise;
      return 'memfs://workspace/bundle-a';
    });
    await activeStarted.promise;

    const rejected = await Promise.all(
      Array.from({ length: 100 }, (_, index) => {
        const explicitRoot = `memfs://workspace/bundle-${String(index + 1)}`;
        return gate.run(async () => {
          rejectedCallbacks += 1;
          selectedRoots.push(explicitRoot);
          return explicitRoot;
        });
      }),
    );

    expect(rejected.every((result) => !result.admitted)).toBe(true);
    expect(rejected.filter((result) => !result.admitted && result.shouldNotify).length).toBe(1);
    expect(rejectedCallbacks).toBe(0);
    expect(selectedRoots).toEqual(['memfs://workspace/bundle-a']);

    releaseActive.resolve(undefined);
    await expect(active).resolves.toEqual({
      admitted: true,
      value: 'memfs://workspace/bundle-a',
    });

    await expect(
      gate.run(async () => {
        selectedRoots.push('memfs://workspace/bundle-b');
        return 'memfs://workspace/bundle-b';
      }),
    ).resolves.toEqual({ admitted: true, value: 'memfs://workspace/bundle-b' });
    expect(selectedRoots).toEqual(['memfs://workspace/bundle-a', 'memfs://workspace/bundle-b']);
  });

  it('releases admission after failure and returns an actionable structured busy problem', async () => {
    const gate = new FailFastReadCommandGate();

    await expect(
      gate.run(async () => {
        throw new Error('selection failed');
      }),
    ).rejects.toThrow('selection failed');
    await expect(gate.run(async () => 'next-root')).resolves.toEqual({
      admitted: true,
      value: 'next-root',
    });
    expect(readCommandBusyProblem()).toEqual({
      code: 'read-command-busy',
      message: 'Another OKF read command is selecting a bundle or scheduling its refresh.',
      correctiveAction:
        'Wait for that command to finish, then run Validate Bundle or Open 3D Graph again.',
    });
  });
});
