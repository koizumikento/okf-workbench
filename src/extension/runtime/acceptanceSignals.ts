import type { BundleRuntimeSnapshot } from './types.js';
import type { GraphRenderFailureReason } from '../../shared/protocol/index.js';

const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 60_000;

export interface AcceptanceRuntimePublication {
  readonly revision: number;
  readonly diagnosticsPublished: true;
  readonly findingCount: number;
  readonly conceptCount: number;
  readonly edgeCount: number;
}

export interface AcceptanceGraphRender {
  readonly revision: number;
}

export interface AcceptanceGraphRenderFailure {
  readonly revision: number;
  readonly reason: GraphRenderFailureReason;
}

export interface AcceptanceCompletionState {
  readonly runtimePublication: AcceptanceRuntimePublication | null;
  readonly graphRender: AcceptanceGraphRender | null;
  readonly graphRenderFailure: AcceptanceGraphRenderFailure | null;
}

/**
 * A deliberately narrow API exposed only to the packaged-editor acceptance driver.
 * It contains completion metadata, never workspace URIs, frontmatter, or document text.
 */
export interface OkfWorkbenchAcceptanceApi {
  readonly schemaVersion: 1;
  getCompletionState(): AcceptanceCompletionState;
  waitForRuntimePublication(
    afterRevision: number,
    timeoutMs: number,
  ): Promise<AcceptanceRuntimePublication>;
  waitForGraphRender(minimumRevision: number, timeoutMs: number): Promise<AcceptanceGraphRender>;
}

interface Waiter<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly predicate: (value: T) => boolean;
}

/**
 * Internal completion bridge for the real extension runtime. The factory is strict so ordinary
 * extension sessions return no API, even if a similarly named environment variable is present.
 */
export class AcceptanceCompletionSignals {
  readonly #runtimeWaiters = new Set<Waiter<AcceptanceRuntimePublication>>();
  readonly #graphWaiters = new Set<Waiter<AcceptanceGraphRender>>();
  #runtimePublication: AcceptanceRuntimePublication | null = null;
  #graphRender: AcceptanceGraphRender | null = null;
  #graphRenderFailure: AcceptanceGraphRenderFailure | null = null;

  public readonly api: OkfWorkbenchAcceptanceApi = Object.freeze({
    schemaVersion: 1 as const,
    getCompletionState: (): AcceptanceCompletionState => this.getCompletionState(),
    waitForRuntimePublication: (
      afterRevision: number,
      timeoutMs: number,
    ): Promise<AcceptanceRuntimePublication> =>
      this.waitForRuntimePublication(afterRevision, timeoutMs),
    waitForGraphRender: (
      minimumRevision: number,
      timeoutMs: number,
    ): Promise<AcceptanceGraphRender> => this.waitForGraphRender(minimumRevision, timeoutMs),
  });

  public recordRuntimePublication<TUri>(snapshot: BundleRuntimeSnapshot<TUri>): void {
    const publication: AcceptanceRuntimePublication = Object.freeze({
      revision: snapshot.revision,
      diagnosticsPublished: true,
      findingCount: snapshot.findings.length,
      conceptCount: snapshot.graph.statistics.conceptCount,
      edgeCount: snapshot.graph.statistics.edgeCount,
    });
    if (
      this.#runtimePublication !== null &&
      publication.revision < this.#runtimePublication.revision
    ) {
      return;
    }
    this.#runtimePublication = publication;
    resolveMatching(this.#runtimeWaiters, publication);
  }

  public recordGraphRender(revision: number): void {
    assertRevision(revision, 'graph revision');
    const rendered: AcceptanceGraphRender = Object.freeze({ revision });
    if (this.#graphRender !== null && revision < this.#graphRender.revision) {
      return;
    }
    if (this.#graphRenderFailure !== null && revision >= this.#graphRenderFailure.revision) {
      this.#graphRenderFailure = null;
    }
    this.#graphRender = rendered;
    resolveMatching(this.#graphWaiters, rendered);
  }

  public recordGraphRenderFailure(revision: number, reason: GraphRenderFailureReason): void {
    assertRevision(revision, 'failed graph revision');
    if (
      (this.#graphRenderFailure !== null && revision < this.#graphRenderFailure.revision) ||
      (this.#graphRender !== null && revision < this.#graphRender.revision)
    ) {
      return;
    }
    const failure: AcceptanceGraphRenderFailure = Object.freeze({ revision, reason });
    this.#graphRenderFailure = failure;
    if (this.#graphRender !== null && revision >= this.#graphRender.revision) {
      this.#graphRender = null;
    }
    rejectMatching(this.#graphWaiters, { revision }, graphRenderFailureError(failure));
  }

  public getCompletionState(): AcceptanceCompletionState {
    return Object.freeze({
      runtimePublication: this.#runtimePublication,
      graphRender: this.#graphRender,
      graphRenderFailure: this.#graphRenderFailure,
    });
  }

  public async waitForRuntimePublication(
    afterRevision: number,
    timeoutMs: number,
  ): Promise<AcceptanceRuntimePublication> {
    assertRevision(afterRevision, 'previous runtime revision');
    return await waitForValue(
      this.#runtimeWaiters,
      this.#runtimePublication,
      (value) => value.revision > afterRevision,
      normalizeTimeout(timeoutMs),
      `runtime publication after revision ${afterRevision}`,
    );
  }

  public async waitForGraphRender(
    minimumRevision: number,
    timeoutMs: number,
  ): Promise<AcceptanceGraphRender> {
    assertRevision(minimumRevision, 'minimum graph revision');
    if (this.#graphRenderFailure !== null && this.#graphRenderFailure.revision >= minimumRevision) {
      throw graphRenderFailureError(this.#graphRenderFailure);
    }
    return await waitForValue(
      this.#graphWaiters,
      this.#graphRender,
      (value) => value.revision >= minimumRevision,
      normalizeTimeout(timeoutMs),
      `Webview graph render at revision ${minimumRevision} or newer`,
    );
  }
}

function graphRenderFailureError(failure: AcceptanceGraphRenderFailure): Error {
  return new Error(
    `Webview graph render failed at revision ${failure.revision}: ${failure.reason}.`,
  );
}

export function createAcceptanceCompletionSignals(
  acceptanceDriverFlag: string | undefined,
): AcceptanceCompletionSignals | undefined {
  return acceptanceDriverFlag === '1' ? new AcceptanceCompletionSignals() : undefined;
}

function assertRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Acceptance ${label} must be a non-negative safe integer.`);
  }
}

function normalizeTimeout(value: number): number {
  if (!Number.isFinite(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new Error(
      `Acceptance completion timeout must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} ms.`,
    );
  }
  return Math.floor(value);
}

async function waitForValue<T>(
  waiters: Set<Waiter<T>>,
  current: T | null,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (current !== null && predicate(current)) {
    return current;
  }

  return await new Promise<T>((resolve, reject) => {
    const waiter: Waiter<T> = {
      resolve,
      reject,
      predicate,
      timer: setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`Timed out waiting for ${label} after ${timeoutMs} ms.`));
      }, timeoutMs),
    };
    waiters.add(waiter);
  });
}

function resolveMatching<T>(waiters: Set<Waiter<T>>, value: T): void {
  for (const waiter of waiters) {
    if (!waiter.predicate(value)) {
      continue;
    }
    clearTimeout(waiter.timer);
    waiters.delete(waiter);
    waiter.resolve(value);
  }
}

function rejectMatching<T>(waiters: Set<Waiter<T>>, value: T, error: Error): void {
  for (const waiter of waiters) {
    if (!waiter.predicate(value)) continue;
    clearTimeout(waiter.timer);
    waiters.delete(waiter);
    waiter.reject(error);
  }
}
