import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RefreshCoordinator,
  WORKSPACE_REFRESH_MAX_LATENCY_MILLISECONDS,
  WORKSPACE_REFRESH_MAX_PENDING_PATHS,
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

  it('coalesces duplicate changes while they enter the pending batch', async () => {
    vi.useFakeTimers();
    const requests: RefreshRequest<string, string>[] = [];
    const source = new FakeChangeSource<string>();
    const coordinator = new RefreshCoordinator<string, string, string>({
      async refresh(request) {
        requests.push(request);
        return 'current';
      },
      publish() {},
    });

    coordinator.switchContext('bundle-a', source);
    for (let index = 0; index < 1_000; index += 1) {
      source.emit({ kind: 'change', uri: 'memfs://bundle/a.md' });
    }
    await vi.advanceTimersByTimeAsync(250);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.changes).toEqual([
      { kind: 'rescan' },
      { kind: 'change', uri: 'memfs://bundle/a.md' },
    ]);
  });

  it('collapses an over-limit set of distinct pending paths to one full rescan', async () => {
    vi.useFakeTimers();
    const requests: RefreshRequest<string, string>[] = [];
    const source = new FakeChangeSource<string>();
    const coordinator = new RefreshCoordinator<string, string, string>({
      async refresh(request) {
        requests.push(request);
        return 'current';
      },
      publish() {},
    });

    coordinator.switchContext('bundle-a', source);
    for (let index = 0; index < 1_000; index += 1) {
      source.emit({ kind: 'change', uri: `memfs://bundle/${String(index)}.md` });
    }
    await vi.advanceTimersByTimeAsync(250);

    expect(WORKSPACE_REFRESH_MAX_PENDING_PATHS).toBeLessThan(1_000);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.changes).toEqual([{ kind: 'rescan' }]);
  });

  it('retains the exact pending-path boundary without collapsing it', async () => {
    vi.useFakeTimers();
    const requests: RefreshRequest<string, string>[] = [];
    const source = new FakeChangeSource<string>();
    const coordinator = new RefreshCoordinator<string, string, string>({
      async refresh(request) {
        requests.push(request);
        return 'current';
      },
      publish() {},
    });

    coordinator.switchContext('bundle-a', source);
    for (let index = 0; index < WORKSPACE_REFRESH_MAX_PENDING_PATHS; index += 1) {
      source.emit({ kind: 'change', uri: `memfs://bundle/${String(index)}.md` });
    }
    await vi.advanceTimersByTimeAsync(250);

    expect(requests[0]?.changes).toHaveLength(WORKSPACE_REFRESH_MAX_PENDING_PATHS + 1);
    expect(requests[0]?.changes.at(-1)).toEqual({
      kind: 'change',
      uri: `memfs://bundle/${String(WORKSPACE_REFRESH_MAX_PENDING_PATHS - 1)}.md`,
    });
  });

  it('refreshes by the non-reset maximum latency under continuous churn', async () => {
    vi.useFakeTimers();
    const requests: RefreshRequest<string, string>[] = [];
    const source = new FakeChangeSource<string>();
    const coordinator = new RefreshCoordinator<string, string, string>({
      async refresh(request) {
        requests.push(request);
        return 'current';
      },
      publish() {},
    });

    coordinator.switchContext('bundle-a', source);
    for (let index = 0; index < 4; index += 1) {
      await vi.advanceTimersByTimeAsync(249);
      source.emit({ kind: 'change', uri: `memfs://bundle/${String(index)}.md` });
    }

    await vi.advanceTimersByTimeAsync(WORKSPACE_REFRESH_MAX_LATENCY_MILLISECONDS - 4 * 249 - 1);
    expect(requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toHaveLength(1);
  });

  it('runs one trailing refresh without overlapping an abort-ignoring refresh', async () => {
    vi.useFakeTimers();
    const first = deferred<string>();
    const second = deferred<string>();
    const pending = [first, second];
    const signals: AbortSignal[] = [];
    const published: PublishedRefresh<string, string, string>[] = [];
    const source = new FakeChangeSource<string>();
    let active = 0;
    let maximumActive = 0;
    let requestCount = 0;
    const coordinator = new RefreshCoordinator<string, string, string>({
      async refresh(request) {
        requestCount += 1;
        signals.push(request.signal);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        const next = pending.shift();
        if (next === undefined) {
          throw new Error('Unexpected refresh.');
        }
        try {
          return await next.promise;
        } finally {
          active -= 1;
        }
      },
      publish(update) {
        published.push(update);
      },
    });

    coordinator.switchContext('bundle-a', source);
    await vi.advanceTimersByTimeAsync(250);
    for (let index = 0; index < 1_000; index += 1) {
      source.emit({ kind: 'change', uri: 'memfs://bundle/a.md' });
    }
    await vi.advanceTimersByTimeAsync(WORKSPACE_REFRESH_MAX_LATENCY_MILLISECONDS);

    expect(signals[0]?.aborted).toBe(true);
    expect(requestCount).toBe(1);
    expect(maximumActive).toBe(1);

    first.resolve('stale');
    await vi.advanceTimersByTimeAsync(0);
    expect(requestCount).toBe(2);
    expect(maximumActive).toBe(1);
    expect(published).toEqual([]);

    second.resolve('current');
    await vi.advanceTimersByTimeAsync(0);
    expect(requestCount).toBe(2);
    expect(maximumActive).toBe(1);
    expect(published).toEqual([
      expect.objectContaining({ context: 'bundle-a', result: 'current', revision: 1 }),
    ]);
    expect(published[0]?.changes).toEqual([{ kind: 'change', uri: 'memfs://bundle/a.md' }]);
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

  it('reports only a current-generation refresh rejection', async () => {
    vi.useFakeTimers();
    const first = deferred<string>();
    const second = deferred<string>();
    const pending = [first, second];
    const errors: unknown[] = [];
    const source = new FakeChangeSource<string>();
    const coordinator = new RefreshCoordinator<string, string, string>({
      refresh() {
        const next = pending.shift();
        if (next === undefined) {
          throw new Error('Unexpected refresh.');
        }
        return next.promise;
      },
      publish() {
        throw new Error('A rejected refresh must not publish.');
      },
      onError(error) {
        errors.push(error);
      },
    });

    coordinator.switchContext('bundle-a', source);
    await vi.advanceTimersByTimeAsync(250);
    source.emit({ kind: 'change', uri: 'memfs://bundle/a.md' });
    await vi.advanceTimersByTimeAsync(250);

    const staleError = new Error('stale failure');
    first.reject(staleError);
    await Promise.resolve();
    expect(errors).toEqual([]);

    const currentError = new Error('current failure');
    second.reject(currentError);
    await Promise.resolve();
    expect(errors).toEqual([currentError]);
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
