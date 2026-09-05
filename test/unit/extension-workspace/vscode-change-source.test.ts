import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface TestUriIdentity {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
  toString(): string;
}

const vscodeState = vi.hoisted(() => ({
  watchers: [] as {
    readonly pattern: { readonly baseUri: TestUriIdentity; readonly pattern: string };
    readonly listeners: {
      readonly create: Set<(uri: TestUriIdentity) => void>;
      readonly change: Set<(uri: TestUriIdentity) => void>;
      readonly delete: Set<(uri: TestUriIdentity) => void>;
    };
    disposed: boolean;
    subscriptionDisposals: number;
  }[],
}));

vi.mock('vscode', () => {
  class MockUri {
    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
    readonly query: string;
    readonly fragment: string;
    readonly #serialized: string;

    private constructor(serialized: string) {
      const parsed = new URL(serialized);
      this.scheme = parsed.protocol.slice(0, -1);
      this.authority = parsed.host;
      this.path = decodeURIComponent(parsed.pathname);
      this.query = parsed.search.slice(1);
      this.fragment = parsed.hash.slice(1);
      this.#serialized = serialized;
    }

    static parse(value: string): MockUri {
      return new MockUri(value);
    }

    toString(): string {
      return this.#serialized;
    }
  }

  class MockRelativePattern {
    readonly baseUri: TestUriIdentity;
    readonly pattern: string;

    constructor(baseUri: TestUriIdentity, pattern: string) {
      this.baseUri = baseUri;
      this.pattern = pattern;
    }
  }

  return {
    RelativePattern: MockRelativePattern,
    Uri: MockUri,
    workspace: {
      createFileSystemWatcher(pattern: MockRelativePattern) {
        const listeners = {
          create: new Set<(uri: TestUriIdentity) => void>(),
          change: new Set<(uri: TestUriIdentity) => void>(),
          delete: new Set<(uri: TestUriIdentity) => void>(),
        };
        const state = {
          pattern,
          listeners,
          disposed: false,
          subscriptionDisposals: 0,
        };
        vscodeState.watchers.push(state);

        const subscribe = (
          set: Set<(uri: TestUriIdentity) => void>,
          listener: (uri: TestUriIdentity) => void,
        ) => {
          set.add(listener);
          return {
            dispose() {
              state.subscriptionDisposals += 1;
              set.delete(listener);
            },
          };
        };

        return {
          onDidCreate(listener: (uri: TestUriIdentity) => void) {
            return subscribe(listeners.create, listener);
          },
          onDidChange(listener: (uri: TestUriIdentity) => void) {
            return subscribe(listeners.change, listener);
          },
          onDidDelete(listener: (uri: TestUriIdentity) => void) {
            return subscribe(listeners.delete, listener);
          },
          dispose() {
            state.disposed = true;
            listeners.create.clear();
            listeners.change.clear();
            listeners.delete.clear();
          },
        };
      },
    },
  };
});

import { Uri } from 'vscode';

import { createVscodeMarkdownChangeSource } from '../../../src/extension/workspace/vscodeChangeSource.js';
import {
  RefreshCoordinator,
  type WorkspaceChange,
} from '../../../src/extension/workspace/refreshCoordinator.js';

beforeEach(() => {
  vscodeState.watchers.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

function emit(
  watcher: (typeof vscodeState.watchers)[number],
  kind: 'create' | 'change' | 'delete',
  uri: Uri,
): void {
  for (const listener of watcher.listeners[kind]) {
    listener(uri);
  }
}

describe('createVscodeMarkdownChangeSource', () => {
  it('accepts canonical Windows drive events without admitting sibling roots or other drives', () => {
    const root = Uri.parse('file:///C:/space%20dir/資料');
    // Match VS Code: Uri.path retains C:, but toString() canonicalizes it to c:.
    vi.spyOn(root, 'toString').mockReturnValue('file:///c%3A/space%20dir/資料');
    const changes: WorkspaceChange<Uri>[] = [];
    const disposable = createVscodeMarkdownChangeSource(root).subscribe((change) => {
      changes.push(change);
    });
    const watcher = vscodeState.watchers[0];
    if (watcher === undefined) throw new Error('Expected a watcher.');
    const uri = Uri.parse('file:///c%3A/space%20dir/資料/nested/note.md');
    for (const kind of ['create', 'change', 'delete'] as const) {
      emit(watcher, kind, uri);
      emit(watcher, kind, Uri.parse('file:///d%3A/space%20dir/資料/nested/note.md'));
      emit(watcher, kind, Uri.parse('file:///c%3A/space%20dir/資料-other/note.md'));
    }
    expect(changes).toEqual([
      { kind: 'create', uri },
      { kind: 'change', uri },
      { kind: 'delete', uri },
    ]);
    disposable.dispose();
  });

  it('uses a root-relative Markdown pattern and retains URI containment defense', () => {
    const root = Uri.parse('memfs://workspace/bundles/one');
    const changes: WorkspaceChange<Uri>[] = [];
    const disposable = createVscodeMarkdownChangeSource(root).subscribe((change) => {
      changes.push(change);
    });
    const watcher = vscodeState.watchers[0];
    if (watcher === undefined) {
      throw new Error('Expected a watcher.');
    }

    expect(watcher.pattern).toEqual({ baseUri: root, pattern: '**/*.md' });
    const created = Uri.parse('memfs://workspace/bundles/one/new.md');
    const changed = Uri.parse('memfs://workspace/bundles/one/nested/current.md');
    const deleted = Uri.parse('memfs://workspace/bundles/one/old.md');
    emit(watcher, 'create', created);
    emit(watcher, 'change', changed);
    emit(watcher, 'delete', deleted);
    emit(watcher, 'change', Uri.parse('memfs://workspace/bundles/one-sibling/outside.md'));
    emit(watcher, 'change', Uri.parse('memfs://other/bundles/one/outside.md'));

    expect(changes).toEqual([
      { kind: 'create', uri: created },
      { kind: 'change', uri: changed },
      { kind: 'delete', uri: deleted },
    ]);
    disposable.dispose();
  });

  it('disposes every event subscription and the scoped watcher', () => {
    const root = Uri.parse('memfs://workspace/bundle');
    const changes: WorkspaceChange<Uri>[] = [];
    const disposable = createVscodeMarkdownChangeSource(root).subscribe((change) => {
      changes.push(change);
    });
    const watcher = vscodeState.watchers[0];
    if (watcher === undefined) {
      throw new Error('Expected a watcher.');
    }

    disposable.dispose();
    emit(watcher, 'change', Uri.parse('memfs://workspace/bundle/ignored.md'));

    expect(watcher.subscriptionDisposals).toBe(3);
    expect(watcher.disposed).toBe(true);
    expect(changes).toEqual([]);
  });

  it('stops the old root watcher when the refresh context switches', async () => {
    vi.useFakeTimers();
    const requests: { readonly context: string; readonly changes: readonly string[] }[] = [];
    const rootA = Uri.parse('memfs://workspace/bundle-a');
    const rootB = Uri.parse('memfs://workspace/bundle-b');
    const coordinator = new RefreshCoordinator<string, string, Uri>({
      async refresh({ context, changes }) {
        requests.push({
          context,
          changes: changes.map((change) => change.kind),
        });
        return context;
      },
      publish() {},
    });

    coordinator.switchContext('bundle-a', createVscodeMarkdownChangeSource(rootA));
    const watcherA = vscodeState.watchers[0];
    coordinator.switchContext('bundle-b', createVscodeMarkdownChangeSource(rootB));
    const watcherB = vscodeState.watchers[1];
    if (watcherA === undefined || watcherB === undefined) {
      throw new Error('Expected both context watchers.');
    }

    emit(watcherA, 'change', Uri.parse('memfs://workspace/bundle-a/stale.md'));
    emit(watcherB, 'change', Uri.parse('memfs://workspace/bundle-b/current.md'));
    await vi.advanceTimersByTimeAsync(250);

    expect(watcherA.disposed).toBe(true);
    expect(requests).toEqual([{ context: 'bundle-b', changes: ['rescan', 'change'] }]);

    coordinator.dispose();
    expect(watcherB.disposed).toBe(true);
  });
});
