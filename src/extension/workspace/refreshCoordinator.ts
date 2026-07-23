export type WorkspaceChangeKind = 'change' | 'create' | 'delete' | 'rename' | 'rescan';

export interface WorkspaceChange<TUri> {
  readonly kind: WorkspaceChangeKind;
  /** New/current URI, or deleted URI for delete events. */
  readonly uri?: TUri;
  /** Previous URI for a native rename event. */
  readonly previousUri?: TUri;
}

export interface DisposableLike {
  dispose(): void;
}

export interface WorkspaceChangeSource<TUri> {
  subscribe(listener: (change: WorkspaceChange<TUri>) => void): DisposableLike;
}

export interface RefreshRequest<TContext, TUri> {
  readonly context: TContext;
  readonly changes: readonly WorkspaceChange<TUri>[];
  readonly signal: AbortSignal;
}

export interface PublishedRefresh<TContext, TResult, TUri> {
  readonly context: TContext;
  readonly result: TResult;
  readonly changes: readonly WorkspaceChange<TUri>[];
  readonly revision: number;
}

export interface RefreshScheduler<THandle> {
  set(callback: () => void, delayMilliseconds: number): THandle;
  clear(handle: THandle): void;
}

export const WORKSPACE_REFRESH_DEBOUNCE_MILLISECONDS = 250;
export const WORKSPACE_REFRESH_MAX_LATENCY_MILLISECONDS = 1_000;
export const WORKSPACE_REFRESH_MAX_PENDING_PATHS = 512;

const RESCAN_CHANGE_KEY = 'rescan';
const WORKSPACE_REFRESH_MAX_PENDING_CHANGES = WORKSPACE_REFRESH_MAX_PENDING_PATHS + 1;

const defaultScheduler: RefreshScheduler<ReturnType<typeof setTimeout>> = {
  set(callback, delayMilliseconds) {
    return setTimeout(callback, delayMilliseconds);
  },
  clear(handle) {
    clearTimeout(handle);
  },
};

export interface RefreshCoordinatorOptions<TContext, TResult, TUri, THandle> {
  readonly refresh: (request: RefreshRequest<TContext, TUri>) => Promise<TResult>;
  readonly publish: (refresh: PublishedRefresh<TContext, TResult, TUri>) => void;
  readonly onError?: (error: unknown, context: TContext) => void;
  readonly scheduler?: RefreshScheduler<THandle>;
}

/**
 * Owns one bundle's change subscription at a time. Newer work invalidates
 * older async results even when the refresh callback ignores AbortSignal.
 */
export class RefreshCoordinator<
  TContext,
  TResult,
  TUri,
  THandle = ReturnType<typeof setTimeout>,
> implements DisposableLike {
  readonly #refresh: (request: RefreshRequest<TContext, TUri>) => Promise<TResult>;
  readonly #publish: (refresh: PublishedRefresh<TContext, TResult, TUri>) => void;
  readonly #onError: ((error: unknown, context: TContext) => void) | undefined;
  readonly #scheduler: RefreshScheduler<THandle>;

  #context: TContext | undefined;
  #subscription: DisposableLike | undefined;
  #debounceTimer: THandle | undefined;
  #maximumLatencyTimer: THandle | undefined;
  #debounceTimerGeneration = 0;
  #maximumLatencyTimerGeneration = 0;
  #abortController: AbortController | undefined;
  #inFlight: Promise<void> | undefined;
  readonly #pending = new Map<string, WorkspaceChange<TUri>>();
  readonly #pendingPaths = new Set<string>();
  #pendingCollapsedToRescan = false;
  #pendingReady = false;
  #generation = 0;
  #revision = 0;
  #disposed = false;

  constructor(options: RefreshCoordinatorOptions<TContext, TResult, TUri, THandle>) {
    this.#refresh = options.refresh;
    this.#publish = options.publish;
    this.#onError = options.onError;
    this.#scheduler =
      options.scheduler ?? (defaultScheduler as unknown as RefreshScheduler<THandle>);
  }

  get revision(): number {
    return this.#revision;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** Switches ownership and immediately schedules a full refresh. */
  switchContext(context: TContext, source: WorkspaceChangeSource<TUri>): void {
    this.#assertActive();
    this.#stopCurrent();
    this.#context = context;
    this.#subscription = source.subscribe((change) => {
      this.request(change);
    });
    this.request({ kind: 'rescan' });
  }

  clearContext(): void {
    this.#assertActive();
    this.#stopCurrent();
    this.#context = undefined;
  }

  request(change: WorkspaceChange<TUri>): void {
    this.#assertActive();
    if (this.#context === undefined) {
      return;
    }

    this.#generation += 1;
    this.#abortController?.abort();
    this.#retainPending(change);
    this.#schedulePending();
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#stopCurrent();
    this.#context = undefined;
    this.#disposed = true;
  }

  async #runRefresh(): Promise<void> {
    const context = this.#context;
    if (context === undefined || this.#disposed || this.#pending.size === 0) {
      return;
    }

    const changes = [...this.#pending.values()];
    this.#clearPending();
    const generation = this.#generation;
    const abortController = new AbortController();
    this.#abortController = abortController;

    try {
      const result = await this.#refresh({
        context,
        changes,
        signal: abortController.signal,
      });
      if (
        this.#disposed ||
        abortController.signal.aborted ||
        generation !== this.#generation ||
        context !== this.#context
      ) {
        return;
      }
      this.#revision += 1;
      this.#publish({ context, result, changes, revision: this.#revision });
    } catch (error) {
      if (
        !this.#disposed &&
        !abortController.signal.aborted &&
        generation === this.#generation &&
        context === this.#context
      ) {
        this.#onError?.(error, context);
      }
    } finally {
      if (this.#abortController === abortController) {
        this.#abortController = undefined;
      }
      this.#inFlight = undefined;
      this.#startRefreshIfReady();
    }
  }

  #retainPending(change: WorkspaceChange<TUri>): void {
    if (this.#pendingCollapsedToRescan) {
      return;
    }

    const key = this.#changeKey(change);
    const newPaths = this.#newPaths(change);
    const exceedsChangeLimit =
      !this.#pending.has(key) && this.#pending.size >= WORKSPACE_REFRESH_MAX_PENDING_CHANGES;
    const exceedsPathLimit =
      this.#pendingPaths.size + newPaths.length > WORKSPACE_REFRESH_MAX_PENDING_PATHS;
    if (exceedsChangeLimit || exceedsPathLimit) {
      this.#collapsePendingToRescan();
      return;
    }

    this.#pending.set(key, change);
    for (const path of newPaths) {
      this.#pendingPaths.add(path);
    }
  }

  #schedulePending(): void {
    if (this.#pendingReady) {
      return;
    }

    this.#clearDebounceTimer();
    const debounceTimerGeneration = this.#debounceTimerGeneration;
    this.#debounceTimer = this.#scheduler.set(() => {
      if (debounceTimerGeneration !== this.#debounceTimerGeneration) {
        return;
      }
      this.#debounceTimer = undefined;
      this.#markPendingReady();
    }, WORKSPACE_REFRESH_DEBOUNCE_MILLISECONDS);

    if (this.#maximumLatencyTimer === undefined) {
      const maximumLatencyTimerGeneration = this.#maximumLatencyTimerGeneration;
      this.#maximumLatencyTimer = this.#scheduler.set(() => {
        if (maximumLatencyTimerGeneration !== this.#maximumLatencyTimerGeneration) {
          return;
        }
        this.#maximumLatencyTimer = undefined;
        this.#markPendingReady();
      }, WORKSPACE_REFRESH_MAX_LATENCY_MILLISECONDS);
    }
  }

  #markPendingReady(): void {
    if (this.#pending.size === 0 || this.#disposed || this.#context === undefined) {
      return;
    }
    this.#pendingReady = true;
    this.#clearPendingTimers();
    this.#startRefreshIfReady();
  }

  #startRefreshIfReady(): void {
    if (
      !this.#pendingReady ||
      this.#inFlight !== undefined ||
      this.#disposed ||
      this.#context === undefined ||
      this.#pending.size === 0
    ) {
      return;
    }

    this.#inFlight = this.#runRefresh();
    void this.#inFlight.catch(() => {
      // #runRefresh reports current-generation errors through onError. Keep a
      // throwing onError callback from becoming an unhandled rejection.
    });
  }

  #changeKey(change: WorkspaceChange<TUri>): string {
    if (change.kind === 'rescan' && change.previousUri === undefined && change.uri === undefined) {
      return RESCAN_CHANGE_KEY;
    }
    return `${change.kind}\0${String(change.previousUri ?? '')}\0${String(change.uri ?? '')}`;
  }

  #newPaths(change: WorkspaceChange<TUri>): string[] {
    const newPaths: string[] = [];
    for (const uri of [change.previousUri, change.uri]) {
      if (uri === undefined) {
        continue;
      }
      const path = String(uri);
      if (!this.#pendingPaths.has(path) && !newPaths.includes(path)) {
        newPaths.push(path);
      }
    }
    return newPaths;
  }

  #collapsePendingToRescan(): void {
    this.#pending.clear();
    this.#pendingPaths.clear();
    this.#pending.set(RESCAN_CHANGE_KEY, { kind: 'rescan' });
    this.#pendingCollapsedToRescan = true;
  }

  #clearPending(): void {
    this.#pending.clear();
    this.#pendingPaths.clear();
    this.#pendingCollapsedToRescan = false;
    this.#pendingReady = false;
    this.#clearPendingTimers();
  }

  #clearDebounceTimer(): void {
    this.#debounceTimerGeneration += 1;
    if (this.#debounceTimer !== undefined) {
      this.#scheduler.clear(this.#debounceTimer);
      this.#debounceTimer = undefined;
    }
  }

  #clearMaximumLatencyTimer(): void {
    this.#maximumLatencyTimerGeneration += 1;
    if (this.#maximumLatencyTimer !== undefined) {
      this.#scheduler.clear(this.#maximumLatencyTimer);
      this.#maximumLatencyTimer = undefined;
    }
  }

  #clearPendingTimers(): void {
    this.#clearDebounceTimer();
    this.#clearMaximumLatencyTimer();
  }

  #stopCurrent(): void {
    this.#generation += 1;
    this.#clearPending();
    this.#abortController?.abort();
    this.#subscription?.dispose();
    this.#subscription = undefined;
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error('The refresh coordinator has been disposed.');
    }
  }
}
