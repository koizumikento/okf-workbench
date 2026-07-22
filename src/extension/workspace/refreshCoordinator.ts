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
  #timer: THandle | undefined;
  #abortController: AbortController | undefined;
  #pending: WorkspaceChange<TUri>[] = [];
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
    this.#abortController = undefined;
    this.#pending.push(change);
    if (this.#timer !== undefined) {
      this.#scheduler.clear(this.#timer);
    }
    this.#timer = this.#scheduler.set(() => {
      this.#timer = undefined;
      void this.#runRefresh();
    }, WORKSPACE_REFRESH_DEBOUNCE_MILLISECONDS);
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
    if (context === undefined || this.#disposed || this.#pending.length === 0) {
      return;
    }

    const changes = this.#coalesce(this.#pending);
    this.#pending = [];
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
    }
  }

  #coalesce(changes: readonly WorkspaceChange<TUri>[]): readonly WorkspaceChange<TUri>[] {
    const unique = new Map<string, WorkspaceChange<TUri>>();
    for (const change of changes) {
      const key = `${change.kind}\0${String(change.previousUri ?? '')}\0${String(
        change.uri ?? '',
      )}`;
      unique.set(key, change);
    }
    return [...unique.values()];
  }

  #stopCurrent(): void {
    this.#generation += 1;
    if (this.#timer !== undefined) {
      this.#scheduler.clear(this.#timer);
      this.#timer = undefined;
    }
    this.#abortController?.abort();
    this.#abortController = undefined;
    this.#pending = [];
    this.#subscription?.dispose();
    this.#subscription = undefined;
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error('The refresh coordinator has been disposed.');
    }
  }
}
