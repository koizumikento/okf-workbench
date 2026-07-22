import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RefreshCoordinator,
  type PublishedRefresh,
  type RefreshRequest,
} from '../../../src/extension/workspace/refreshCoordinator.js';
import { deferred, FakeChangeSource } from './fakes.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('RefreshCoordinator', () => {
  it('coalesces a 250 ms event burst into one refresh and revision', async () => {
    vi.useFakeTimers();
    const requests: RefreshRequest<string, string>[] = [];
    const published: PublishedRefresh<string, string, string>[] = [];
    const source = new FakeChangeSource<string>();
    const coordinator = new RefreshCoordinator<string, string, string>({
      async refresh(request) {
        requests.push(request);
        return `result:${request.context}`;
      },
      publish(update) {
        published.push(update);
      },
    });

    coordinator.switchContext('bundle-a', source);
    source.emit({ kind: 'create', uri: 'memfs://bundle/a.md' });
    source.emit({ kind: 'change', uri: 'memfs://bundle/a.md' });
    source.emit({ kind: 'delete', uri: 'memfs://bundle/old.md' });
    source.emit({
      kind: 'rename',
      previousUri: 'memfs://bundle/before.md',
      uri: 'memfs://bundle/after.md',
    });

    await vi.advanceTimersByTimeAsync(249);
    expect(requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.changes.map((change) => change.kind)).toEqual([
      'rescan',
      'create',
      'change',
      'delete',
      'rename',
    ]);
    expect(published).toEqual([
      expect.objectContaining({ context: 'bundle-a', result: 'result:bundle-a', revision: 1 }),
    ]);
    expect(coordinator.revision).toBe(1);
  });

  it('does not publish a stale async result even if refresh ignores abort', async () => {
    vi.useFakeTimers();
    const first = deferred<string>();
    const second = deferred<string>();
    const pending = [first, second];
    const signals: AbortSignal[] = [];
    const published: PublishedRefresh<string, string, string>[] = [];
    const source = new FakeChangeSource<string>();
    const coordinator = new RefreshCoordinator<string, string, string>({
      refresh(request) {
        signals.push(request.signal);
        const next = pending.shift();
        if (next === undefined) {
          throw new Error('Unexpected refresh.');
        }
        return next.promise;
      },
      publish(update) {
        published.push(update);
      },
    });

    coordinator.switchContext('bundle-a', source);
    await vi.advanceTimersByTimeAsync(250);
    source.emit({ kind: 'change', uri: 'memfs://bundle/a.md' });
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    first.resolve('stale');
    await Promise.resolve();
    expect(published).toEqual([]);
    second.resolve('current');
    await Promise.resolve();

    expect(published).toEqual([
      expect.objectContaining({ context: 'bundle-a', result: 'current', revision: 1 }),
    ]);
  });

  it('disposes the old watcher and pending work when switching bundles', async () => {
    vi.useFakeTimers();
    const published: PublishedRefresh<string, string, string>[] = [];
    const firstSource = new FakeChangeSource<string>();
    const secondSource = new FakeChangeSource<string>();
    const coordinator = new RefreshCoordinator<string, string, string>({
      async refresh({ context }) {
        return context;
      },
      publish(update) {
        published.push(update);
      },
    });

    coordinator.switchContext('bundle-a', firstSource);
    firstSource.emit({ kind: 'change', uri: 'memfs://a/concept.md' });
    coordinator.switchContext('bundle-b', secondSource);

    expect(firstSource.disposed).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(published).toEqual([
      expect.objectContaining({ context: 'bundle-b', result: 'bundle-b', revision: 1 }),
    ]);

    coordinator.dispose();
    expect(secondSource.disposed).toBe(true);
    expect(coordinator.disposed).toBe(true);
    expect(() => coordinator.request({ kind: 'rescan' })).toThrow(/disposed/u);
  });

  it('keeps published revisions monotonic across context switches', async () => {
    vi.useFakeTimers();
    const revisions: number[] = [];
    const coordinator = new RefreshCoordinator<string, string, string>({
      async refresh({ context }) {
        return context;
      },
      publish({ revision }) {
        revisions.push(revision);
      },
    });

    coordinator.switchContext('bundle-a', new FakeChangeSource());
    await vi.advanceTimersByTimeAsync(250);
    coordinator.switchContext('bundle-b', new FakeChangeSource());
    await vi.advanceTimersByTimeAsync(250);

    expect(revisions).toEqual([1, 2]);
  });
});
