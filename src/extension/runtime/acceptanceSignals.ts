import type { BundleRuntimeSnapshot } from './types.js';
import type { GraphRenderFailureReason } from '../../shared/protocol/index.js';

const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 60_000;
const MAX_RETAINED_TERMINAL_RESULTS = 16;

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

export type AcceptanceCommandName = 'validateBundle' | 'openGraph';

export type AcceptanceWorkspaceAccess = 'read' | 'write';

export interface AcceptanceCommandCatalogEntry {
  readonly id: string;
  readonly title: string;
  readonly workspaceAccess: AcceptanceWorkspaceAccess;
}

export interface AcceptanceCommandTicket {
  readonly kind: 'okf-acceptance-command';
  readonly command: AcceptanceCommandName;
  readonly requestId: number;
}

export interface AcceptanceValidationCompletion extends AcceptanceRuntimePublication {
  readonly requestId: number;
}

/** Confirms renderer data application; it does not claim first paint or force-engine settlement. */
export interface AcceptanceGraphOpenCompletion extends AcceptanceGraphRender {
  readonly requestId: number;
}

/**
 * A deliberately narrow API exposed only to the packaged-editor acceptance driver.
 * It contains completion metadata, never workspace URIs, frontmatter, or document text.
 */
export interface OkfWorkbenchAcceptanceApi {
  readonly schemaVersion: 1;
  getCommandCatalog(): readonly AcceptanceCommandCatalogEntry[];
  getCompletionState(): AcceptanceCompletionState;
  waitForRuntimePublication(
    afterRevision: number,
    timeoutMs: number,
  ): Promise<AcceptanceRuntimePublication>;
  waitForGraphRender(minimumRevision: number, timeoutMs: number): Promise<AcceptanceGraphRender>;
  waitForValidationCompletion(
    requestId: number,
    timeoutMs: number,
  ): Promise<AcceptanceValidationCompletion>;
  waitForGraphOpenCompletion(
    requestId: number,
    timeoutMs: number,
  ): Promise<AcceptanceGraphOpenCompletion>;
}

interface Waiter<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly predicate: (value: T) => boolean;
}

interface RequestWaiter<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface RequestRegistryState {
  readonly active: number;
  readonly terminal: number;
  readonly waiters: number;
}

type RequestTerminal<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Error };

class AcceptanceRequestRegistry<T, TMetadata> {
  readonly #active = new Map<number, TMetadata>();
  readonly #terminal = new Map<number, RequestTerminal<T>>();
  readonly #waiters = new Map<number, Set<RequestWaiter<T>>>();

  public begin(requestId: number, metadata: TMetadata): void {
    this.#active.set(requestId, metadata);
  }

  public has(requestId: number): boolean {
    return this.#active.has(requestId);
  }

  public update(requestId: number, metadata: TMetadata): void {
    if (this.#active.has(requestId)) {
      this.#active.set(requestId, metadata);
    }
  }

  public entries(): IterableIterator<[number, TMetadata]> {
    return this.#active.entries();
  }

  public complete(requestId: number, value: T): void {
    if (!this.#active.delete(requestId)) return;
    const requestWaiters = this.#takeWaiters(requestId);
    if (requestWaiters === undefined) {
      this.#retainTerminal(requestId, { ok: true, value });
      return;
    }
    for (const waiter of requestWaiters) waiter.resolve(value);
  }

  public fail(requestId: number, error: Error): void {
    if (!this.#active.delete(requestId)) return;
    const requestWaiters = this.#takeWaiters(requestId);
    if (requestWaiters === undefined) {
      this.#retainTerminal(requestId, { ok: false, error });
      return;
    }
    for (const waiter of requestWaiters) waiter.reject(error);
  }

  public failAll(errorFor: (requestId: number, metadata: TMetadata) => Error): void {
    for (const [requestId, metadata] of [...this.#active]) {
      this.fail(requestId, errorFor(requestId, metadata));
    }
  }

  public discard(requestId: number, error: Error): void {
    this.#active.delete(requestId);
    this.#terminal.delete(requestId);
    const requestWaiters = this.#takeWaiters(requestId);
    if (requestWaiters === undefined) return;
    for (const waiter of requestWaiters) waiter.reject(error);
  }

  public wait(requestId: number, timeoutMs: number, label: string): Promise<T> {
    const terminal = this.#terminal.get(requestId);
    if (terminal !== undefined) {
      this.#terminal.delete(requestId);
      return terminal.ok ? Promise.resolve(terminal.value) : Promise.reject(terminal.error);
    }
    if (!this.#active.has(requestId)) {
      return Promise.reject(new Error(`Unknown or expired acceptance request ${requestId}.`));
    }

    return new Promise<T>((resolve, reject) => {
      const requestWaiters = this.#waiters.get(requestId) ?? new Set<RequestWaiter<T>>();
      const waiter: RequestWaiter<T> = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#expire(
            requestId,
            new Error(`Timed out waiting for ${label} after ${timeoutMs} ms.`),
          );
        }, timeoutMs),
      };
      requestWaiters.add(waiter);
      this.#waiters.set(requestId, requestWaiters);
    });
  }

  public dispose(error: Error): void {
    for (const requestId of [...this.#active.keys()]) {
      this.#expire(requestId, error);
    }
    for (const requestWaiters of this.#waiters.values()) {
      for (const waiter of requestWaiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.#active.clear();
    this.#terminal.clear();
    this.#waiters.clear();
  }

  public state(): RequestRegistryState {
    let waiterCount = 0;
    for (const requestWaiters of this.#waiters.values()) waiterCount += requestWaiters.size;
    return Object.freeze({
      active: this.#active.size,
      terminal: this.#terminal.size,
      waiters: waiterCount,
    });
  }

  #expire(requestId: number, error: Error): void {
    this.#active.delete(requestId);
    this.#terminal.delete(requestId);
    const requestWaiters = this.#takeWaiters(requestId);
    if (requestWaiters === undefined) return;
    for (const waiter of requestWaiters) waiter.reject(error);
  }

  #takeWaiters(requestId: number): Set<RequestWaiter<T>> | undefined {
    const requestWaiters = this.#waiters.get(requestId);
    if (requestWaiters === undefined) return undefined;
    this.#waiters.delete(requestId);
    for (const waiter of requestWaiters) clearTimeout(waiter.timer);
    return requestWaiters;
  }

  #retainTerminal(requestId: number, terminal: RequestTerminal<T>): void {
    this.#terminal.set(requestId, terminal);
    while (this.#terminal.size > MAX_RETAINED_TERMINAL_RESULTS) {
      const oldest = this.#terminal.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.#terminal.delete(oldest);
    }
  }
}

/**
 * Internal completion bridge for the real extension runtime. The factory is strict so ordinary
 * extension sessions return no API, even if a similarly named environment variable is present.
 */
export class AcceptanceCompletionSignals {
  readonly #runtimeWaiters = new Set<Waiter<AcceptanceRuntimePublication>>();
  readonly #graphWaiters = new Set<Waiter<AcceptanceGraphRender>>();
  readonly #validationRequests = new AcceptanceRequestRegistry<
    AcceptanceValidationCompletion,
    undefined
  >();
  readonly #graphOpenRequests = new AcceptanceRequestRegistry<
    AcceptanceGraphOpenCompletion,
    number | undefined
  >();
  readonly #commandCatalog: readonly AcceptanceCommandCatalogEntry[];
  #runtimePublication: AcceptanceRuntimePublication | null = null;
  #graphRender: AcceptanceGraphRender | null = null;
  #graphRenderFailure: AcceptanceGraphRenderFailure | null = null;
  #requestId = 0;
  #disposed = false;

  public constructor(commandCatalog: readonly AcceptanceCommandCatalogEntry[] = []) {
    this.#commandCatalog = Object.freeze(
      commandCatalog.map((command) =>
        Object.freeze({
          id: command.id,
          title: command.title,
          workspaceAccess: command.workspaceAccess,
        }),
      ),
    );
  }

  public readonly api: OkfWorkbenchAcceptanceApi = Object.freeze({
    schemaVersion: 1 as const,
    getCommandCatalog: (): readonly AcceptanceCommandCatalogEntry[] => this.#commandCatalog,
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
    waitForValidationCompletion: (
      requestId: number,
      timeoutMs: number,
    ): Promise<AcceptanceValidationCompletion> =>
      this.waitForValidationCompletion(requestId, timeoutMs),
    waitForGraphOpenCompletion: (
      requestId: number,
      timeoutMs: number,
    ): Promise<AcceptanceGraphOpenCompletion> =>
      this.waitForGraphOpenCompletion(requestId, timeoutMs),
  });

  public beginValidationCommand(): AcceptanceCommandTicket {
    this.#assertActive();
    this.failActiveValidationCommands('superseded');
    const requestId = this.#nextRequestId();
    this.#validationRequests.begin(requestId, undefined);
    return commandTicket('validateBundle', requestId);
  }

  public recordValidationCompletion<TUri>(
    requestId: number,
    snapshot: BundleRuntimeSnapshot<TUri>,
  ): void {
    if (this.#disposed) return;
    assertRequestId(requestId);
    if (!this.#validationRequests.has(requestId)) return;
    const completion: AcceptanceValidationCompletion = Object.freeze({
      requestId,
      revision: snapshot.revision,
      diagnosticsPublished: true,
      findingCount: snapshot.findings.length,
      conceptCount: snapshot.graph.statistics.conceptCount,
      edgeCount: snapshot.graph.statistics.edgeCount,
    });
    this.#validationRequests.complete(requestId, completion);
  }

  public recordValidationFailure(requestId: number, reason = 'runtime-failed'): void {
    if (this.#disposed) return;
    assertRequestId(requestId);
    this.#validationRequests.fail(requestId, validationFailureError(requestId, reason));
  }

  public failActiveValidationCommands(reason: string): void {
    if (this.#disposed) return;
    this.#validationRequests.failAll((requestId) => validationFailureError(requestId, reason));
  }

  public discardValidationCommand(requestId: number, reason: string): void {
    if (this.#disposed) return;
    assertRequestId(requestId);
    this.#validationRequests.discard(requestId, validationFailureError(requestId, reason));
  }

  public beginGraphOpenCommand(): AcceptanceCommandTicket {
    this.#assertActive();
    this.failActiveGraphOpenCommands('superseded');
    const requestId = this.#nextRequestId();
    this.#graphOpenRequests.begin(requestId, undefined);
    return commandTicket('openGraph', requestId);
  }

  public armGraphOpenCommand(requestId: number, revision: number): void {
    if (this.#disposed) return;
    assertRequestId(requestId);
    assertRevision(revision, 'graph-open revision');
    this.#graphOpenRequests.update(requestId, revision);
  }

  public recordGraphOpenFailure(requestId: number, reason = 'graph-unavailable'): void {
    if (this.#disposed) return;
    assertRequestId(requestId);
    this.#graphOpenRequests.fail(requestId, graphOpenFailureError(requestId, reason));
  }

  public failActiveGraphOpenCommands(reason: string): void {
    if (this.#disposed) return;
    this.#graphOpenRequests.failAll((requestId) => graphOpenFailureError(requestId, reason));
  }

  public discardGraphOpenCommand(requestId: number, reason: string): void {
    if (this.#disposed) return;
    assertRequestId(requestId);
    this.#graphOpenRequests.discard(requestId, graphOpenFailureError(requestId, reason));
  }

  public recordRuntimePublication<TUri>(snapshot: BundleRuntimeSnapshot<TUri>): void {
    if (this.#disposed) return;
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
    if (this.#disposed) return;
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
    for (const [requestId, expectedRevision] of this.#graphOpenRequests.entries()) {
      if (expectedRevision === undefined || revision !== expectedRevision) continue;
      const completion: AcceptanceGraphOpenCompletion = Object.freeze({
        ...rendered,
        requestId,
      });
      this.#graphOpenRequests.complete(requestId, completion);
    }
  }

  public recordGraphRenderFailure(revision: number, reason: GraphRenderFailureReason): void {
    if (this.#disposed) return;
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
    for (const [requestId, expectedRevision] of this.#graphOpenRequests.entries()) {
      if (expectedRevision === undefined || revision !== expectedRevision) continue;
      this.#graphOpenRequests.fail(requestId, graphRenderFailureError(failure));
    }
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
    this.#assertActive();
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
    this.#assertActive();
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

  public async waitForValidationCompletion(
    requestId: number,
    timeoutMs: number,
  ): Promise<AcceptanceValidationCompletion> {
    this.#assertActive();
    assertRequestId(requestId);
    return await this.#validationRequests.wait(
      requestId,
      normalizeTimeout(timeoutMs),
      `Validate request ${requestId} diagnostics and runtime publication`,
    );
  }

  public async waitForGraphOpenCompletion(
    requestId: number,
    timeoutMs: number,
  ): Promise<AcceptanceGraphOpenCompletion> {
    this.#assertActive();
    assertRequestId(requestId);
    return await this.#graphOpenRequests.wait(
      requestId,
      normalizeTimeout(timeoutMs),
      `Open Graph request ${requestId} Webview graph-data application`,
    );
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const error = new Error('Acceptance completion signals were disposed.');
    rejectAll(this.#runtimeWaiters, error);
    rejectAll(this.#graphWaiters, error);
    this.#validationRequests.dispose(error);
    this.#graphOpenRequests.dispose(error);
    this.#runtimePublication = null;
    this.#graphRender = null;
    this.#graphRenderFailure = null;
  }

  public getRequestStateForTest(): {
    readonly validation: RequestRegistryState;
    readonly graphOpen: RequestRegistryState;
  } {
    return Object.freeze({
      validation: this.#validationRequests.state(),
      graphOpen: this.#graphOpenRequests.state(),
    });
  }

  #nextRequestId(): number {
    this.#requestId += 1;
    return this.#requestId;
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error('Acceptance completion signals were disposed.');
    }
  }
}

function commandTicket(command: AcceptanceCommandName, requestId: number): AcceptanceCommandTicket {
  return Object.freeze({ kind: 'okf-acceptance-command', command, requestId });
}

function graphRenderFailureError(failure: AcceptanceGraphRenderFailure): Error {
  return new Error(
    `Webview graph render failed at revision ${failure.revision}: ${failure.reason}.`,
  );
}

function validationFailureError(requestId: number, reason: string): Error {
  return new Error(
    `Validate request ${requestId} failed before diagnostics and runtime publication completed. Reason: ${reason}.`,
  );
}

function graphOpenFailureError(requestId: number, reason: string): Error {
  return new Error(
    `Open Graph request ${requestId} failed before the Webview applied the graph data. Reason: ${reason}.`,
  );
}

export function createAcceptanceCompletionSignals(
  acceptanceDriverFlag: string | undefined,
  commandCatalog: readonly AcceptanceCommandCatalogEntry[] = [],
): AcceptanceCompletionSignals | undefined {
  return acceptanceDriverFlag === '1' ? new AcceptanceCompletionSignals(commandCatalog) : undefined;
}

function assertRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Acceptance ${label} must be a non-negative safe integer.`);
  }
}

function assertRequestId(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('Acceptance request ID must be a positive safe integer.');
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

function rejectAll<T>(waiters: Set<Waiter<T>>, error: Error): void {
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  waiters.clear();
}
