import { clearTimeout, setTimeout } from 'node:timers';
import { URL } from 'node:url';

const COMMAND_TIMEOUT_MS = 5_000;
const TARGET_TIMEOUT_MS = 30_000;
const FINAL_QUIET_PERIOD_MS = 100;
const OKF_EXTENSION_ID = 'straydog.okf-workbench';
const PACKAGED_RESOURCE_ORIGIN = 'https://file+.vscode-resource.vscode-cdn.net';
const MAX_TREE_STABILIZATION_PASSES = 100;
const CAPTURED_DESCENDANT_TARGET_TYPES = new Set([
  'iframe',
  'worker',
  'shared_worker',
  'service_worker',
]);
const ROOT_WORKER_TARGET_TYPES = new Set(['worker', 'shared_worker', 'service_worker']);
const WORKBENCH_AUTO_ATTACH_FILTER = [{ type: 'iframe', exclude: false }, { exclude: true }];
const ROOT_WORKER_AUTO_ATTACH_FILTER = [
  { type: 'worker', exclude: false },
  { type: 'shared_worker', exclude: false },
  { type: 'service_worker', exclude: false },
  { exclude: true },
];
const DESCENDANT_AUTO_ATTACH_FILTER = [{ exclude: false }];

export async function createWebviewNetworkRecorder(port, options = {}) {
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  const createSocket = options.createSocket ?? ((url) => new globalThis.WebSocket(url));
  const wait =
    options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const versionResponse = await fetchImplementation(
    `http://127.0.0.1:${String(port)}/json/version`,
  );
  if (!versionResponse.ok) {
    throw new Error(
      `Could not discover the browser CDP endpoint (${String(versionResponse.status)}).`,
    );
  }
  const version = await versionResponse.json();
  if (
    typeof version !== 'object' ||
    version === null ||
    typeof version.webSocketDebuggerUrl !== 'string' ||
    version.webSocketDebuggerUrl.length === 0
  ) {
    throw new Error('The browser CDP endpoint did not expose a WebSocket debugger URL.');
  }

  const recorder = new WebviewNetworkRecorder(createSocket(version.webSocketDebuggerUrl), {
    commandTimeoutMs: options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS,
    finalQuietPeriodMs: options.finalQuietPeriodMs ?? FINAL_QUIET_PERIOD_MS,
    targetTimeoutMs: options.targetTimeoutMs ?? TARGET_TIMEOUT_MS,
    wait,
  });
  try {
    await recorder.initialize();
    return recorder;
  } catch (error) {
    recorder.close();
    throw error;
  }
}

class WebviewNetworkRecorder {
  #commandId = 0;
  #fatalError;
  #finalizing = false;
  #intentionalClose = false;
  #okfSession;
  #parentNavigationRequests = new Map();
  #pendingCommands = new Map();
  #preexistingRootTargetIds = new Set();
  #readyResolve;
  #readySettled = false;
  #selectedFrameRequestUrls = [];
  #sessions = new Map();
  #socket;
  #targetReady;
  #treeGeneration = 0;
  #workbenchAttachPending = false;
  #workbenchAttachmentEventSessionId;
  #workbenchNetworkEnabled = false;
  #workbenchSessionId;
  #workbenchTargetId;
  #options;

  constructor(socket, options) {
    this.#socket = socket;
    this.#options = options;
    this.#targetReady = new Promise((resolve) => {
      this.#readyResolve = resolve;
    });
    socket.addEventListener('message', (event) => this.#handleMessage(event));
    socket.addEventListener('close', () => {
      if (!this.#intentionalClose) {
        this.#fail(new Error('The browser CDP socket closed before network capture completed.'));
      }
    });
    socket.addEventListener('error', () => {
      if (!this.#intentionalClose) {
        this.#fail(new Error('The browser CDP socket failed before network capture completed.'));
      }
    });
  }

  async initialize() {
    await this.#waitForOpen();
    await this.#send('Target.setDiscoverTargets', {
      discover: true,
    });
    const targets = await this.#send('Target.getTargets');
    if (
      !Array.isArray(targets?.targetInfos) ||
      targets.targetInfos.some((target) => isOkfWebviewTarget(target))
    ) {
      throw new Error(
        'Network capture must be armed before any OKF Webview target or initial navigation exists.',
      );
    }
    const workbenchTargets = targets.targetInfos.filter(isWorkbenchPageTarget);
    if (workbenchTargets.length !== 1) {
      throw new Error(
        'The browser CDP endpoint did not expose exactly one VS Code workbench page.',
      );
    }
    for (const target of targets.targetInfos) {
      if (
        ROOT_WORKER_TARGET_TYPES.has(target?.type) &&
        typeof target?.targetId === 'string' &&
        target.targetId.length > 0
      ) {
        this.#preexistingRootTargetIds.add(target.targetId);
      }
    }
    await this.#send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: ROOT_WORKER_AUTO_ATTACH_FILTER,
    });
    this.#workbenchTargetId = workbenchTargets[0].targetId;
    this.#workbenchAttachPending = true;
    let attached;
    try {
      attached = await this.#send('Target.attachToTarget', {
        targetId: this.#workbenchTargetId,
        flatten: true,
      });
    } finally {
      this.#workbenchAttachPending = false;
    }
    if (typeof attached?.sessionId !== 'string' || attached.sessionId.length === 0) {
      throw new Error('Could not attach a CDP session to the VS Code workbench page.');
    }
    if (
      this.#workbenchAttachmentEventSessionId !== undefined &&
      this.#workbenchAttachmentEventSessionId !== attached.sessionId
    ) {
      throw new Error(
        'The workbench Target.attachedToTarget event did not match the attach command response.',
      );
    }
    this.#workbenchSessionId = attached.sessionId;
    await this.#send('Network.enable', {}, this.#workbenchSessionId);
    this.#workbenchNetworkEnabled = true;
    await this.#send(
      'Target.setAutoAttach',
      {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: WORKBENCH_AUTO_ATTACH_FILTER,
      },
      this.#workbenchSessionId,
    );
  }

  async waitForOkfTarget() {
    this.#throwIfFatal();
    if (this.#readySettled && this.#okfSession !== undefined) return this.#okfSession;
    const session = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            'The auto-attached OKF Webview target did not enable CDP Network capture in time.',
          ),
        );
      }, this.#options.targetTimeoutMs);
      void this.#targetReady.then((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    this.#throwIfFatal();
    if (session === undefined) {
      throw new Error('The OKF Webview CDP target did not become available.');
    }
    return session;
  }

  async snapshot(captureScope) {
    const session = await this.waitForOkfTarget();
    await this.#awaitSelectedTreeArmed();
    this.#assertRootWorkersResolved();
    this.#throwIfFatal();
    if (
      session.detached ||
      !session.networkEnabled ||
      !this.#workbenchNetworkEnabled ||
      this.#workbenchSessionId === undefined
    ) {
      throw new Error('The OKF Webview CDP session is not live at the network snapshot boundary.');
    }

    await this.#fullBarrierSelectedTree();
    await this.#options.wait(this.#options.finalQuietPeriodMs);
    const seal = await this.#fullBarrierSelectedTree();
    this.#assertRootWorkersResolved();
    this.#assertSelectedTreeHealthy();
    this.#finalizing = true;
    const selectedSessions = seal.sessions;
    this.#assertFinalizationSeal(seal);
    for (const selectedSession of selectedSessions.toSorted(
      (left, right) => this.#sessionDepth(right) - this.#sessionDepth(left),
    )) {
      await this.#send('Network.disable', {}, selectedSession.sessionId);
      selectedSession.networkEnabled = false;
      this.#assertFinalizationSeal(seal);
    }
    await this.#send('Network.disable', {}, this.#workbenchSessionId);
    this.#workbenchNetworkEnabled = false;
    await this.#send('Target.getTargets');
    this.#assertFinalizationSeal(seal);
    this.#assertRootWorkersResolved();
    this.#throwIfFatal();

    const selectedParentRequests = [...this.#parentNavigationRequests.values()].filter(
      (request) => request.frameId === session.targetInfo.targetId,
    );
    const matchingNavigations = selectedParentRequests.filter((request) =>
      request.urls.some((url) => isOkfWebviewUrl(url)),
    );
    if (matchingNavigations.length !== 1) {
      throw new Error(
        'The OKF Webview target must have exactly one frame-correlated initial navigation.',
      );
    }
    const classified = [
      ...selectedParentRequests.flatMap((request) => request.urls),
      ...this.#selectedFrameRequestUrls,
      ...selectedSessions.flatMap((selectedSession) => selectedSession.urls),
    ].map(classifyNetworkUrl);
    const remote = classified.filter((entry) => entry.kind === 'remote');
    const local = classified.filter((entry) => entry.kind === 'local');
    const navigation = classified.filter((entry) => entry.kind === 'navigation');
    const other = classified.filter((entry) => entry.kind === 'other');
    return {
      authority: 'headed-vscode-webview-cdp',
      captureScope,
      remoteRequestCount: remote.length,
      remoteOrigins: uniqueSorted(remote.map((entry) => entry.origin)),
      localResourceRequestCount: local.length,
      localOrigins: uniqueSorted(local.map((entry) => entry.origin)),
      webviewNavigationRequestCount: navigation.length,
      webviewNavigationOrigins: uniqueSorted(navigation.map((entry) => entry.origin)),
      otherRequestCount: other.length,
      otherSchemes: uniqueSorted(other.map((entry) => entry.origin)),
    };
  }

  close() {
    this.#intentionalClose = true;
    this.#socket.close();
  }

  #handleMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch (error) {
      this.#fail(new Error(`The browser CDP socket emitted invalid JSON: ${String(error)}`));
      return;
    }
    if (Number.isSafeInteger(message.id)) {
      const pending = this.#pendingCommands.get(message.id);
      if (pending === undefined) return;
      this.#pendingCommands.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        pending.reject(
          new Error(
            `CDP ${pending.method} failed: ${String(message.error.message ?? 'unknown error')}`,
          ),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method === 'Target.attachedToTarget') {
      this.#handleAttachedTarget(message.params, message.sessionId);
      return;
    }
    if (message.method === 'Target.targetInfoChanged') {
      this.#handleTargetInfoChanged(message.params?.targetInfo, message.sessionId);
      return;
    }
    if (message.method === 'Target.detachedFromTarget') {
      if (message.params?.sessionId === this.#workbenchSessionId) {
        this.#fail(
          new Error('The VS Code workbench CDP session detached before network capture completed.'),
        );
        return;
      }
      const session = this.#sessions.get(message.params?.sessionId);
      if (session !== undefined) {
        session.detached = true;
        this.#treeGeneration += 1;
        if (this.#isCaptureRelevantSession(session)) {
          const targetLabel =
            session === this.#okfSession ? 'OKF Webview' : 'OKF Webview descendant';
          this.#fail(
            new Error(`The ${targetLabel} CDP session detached before network capture completed.`),
          );
        }
      }
      return;
    }
    if (
      message.method === 'Inspector.detached' ||
      message.method === 'Inspector.targetCrashed' ||
      message.method === 'Inspector.targetReloadedAfterCrash'
    ) {
      if (message.sessionId === this.#workbenchSessionId) {
        this.#fail(
          new Error(
            `The VS Code workbench CDP session reported ${message.method} before network capture completed.`,
          ),
        );
        return;
      }
      const session = this.#sessions.get(message.sessionId);
      if (session !== undefined) {
        session.detached = true;
        this.#treeGeneration += 1;
        if (this.#isCaptureRelevantSession(session)) {
          this.#fail(
            new Error(
              `An OKF Webview CDP session reported ${message.method} before network capture completed.`,
            ),
          );
        }
      }
      return;
    }
    if (message.method === 'Target.targetCrashed' || message.method === 'Target.targetDestroyed') {
      this.#handleTargetEnded(message.params?.targetId, message.method);
      return;
    }

    if (
      message.sessionId === this.#workbenchSessionId &&
      message.method === 'Network.requestWillBeSent' &&
      typeof message.params?.request?.url === 'string'
    ) {
      const requestId = message.params?.requestId;
      const frameId = message.params?.frameId;
      const url = message.params.request.url;
      const isSelectedFrame =
        this.#okfSession !== undefined && frameId === this.#okfSession.targetInfo.targetId;
      if (this.#finalizing && isSelectedFrame) {
        this.#fail(
          new Error(
            'The selected OKF Webview frame issued a parent-observed request after finalization was sealed.',
          ),
        );
        return;
      }
      const existing =
        typeof requestId === 'string' ? this.#parentNavigationRequests.get(requestId) : undefined;
      if (existing !== undefined) {
        if (typeof frameId === 'string' && frameId !== existing.frameId) {
          this.#fail(new Error('A Webview navigation request changed its CDP frame identity.'));
          return;
        }
        existing.urls.push(url);
        this.#considerOkfSessionsForTarget(existing.frameId);
      } else if (typeof requestId === 'string' && typeof frameId === 'string') {
        this.#parentNavigationRequests.set(requestId, {
          frameId,
          urls: [url],
        });
        this.#considerOkfSessionsForTarget(frameId);
      } else if (isSelectedFrame) {
        this.#selectedFrameRequestUrls.push(url);
      }
      this.#considerRootWorkerAssociations();
      return;
    }

    const session = this.#sessions.get(message.sessionId);
    if (session === undefined) return;
    if (
      message.method === 'Network.requestWillBeSent' &&
      typeof message.params?.request?.url === 'string'
    ) {
      session.urls.push(message.params.request.url);
      session.requests.push({
        frameId: message.params?.frameId,
        requestId: message.params?.requestId,
        url: message.params.request.url,
      });
      this.#considerRootWorkerAssociations();
    } else if (
      message.method === 'Network.webSocketCreated' &&
      typeof message.params?.url === 'string'
    ) {
      session.urls.push(message.params.url);
    } else if (
      message.method === 'Network.webTransportCreated' &&
      typeof message.params?.url === 'string'
    ) {
      session.urls.push(message.params.url);
    }
  }

  #handleAttachedTarget(parameters, parentSessionId) {
    const isRootAttachment = parentSessionId === undefined;
    const parentIsTracked =
      isRootAttachment ||
      parentSessionId === this.#workbenchSessionId ||
      this.#sessions.has(parentSessionId);
    if (!parentIsTracked) return;
    const targetInfo = parameters?.targetInfo;
    if (
      typeof parameters?.sessionId !== 'string' ||
      parameters.sessionId.length === 0 ||
      typeof targetInfo?.targetId !== 'string' ||
      targetInfo.targetId.length === 0 ||
      typeof targetInfo.type !== 'string'
    ) {
      this.#fail(new Error('CDP auto-attach emitted a malformed target session.'));
      return;
    }
    if (
      isRootAttachment &&
      targetInfo.targetId === this.#workbenchTargetId &&
      isWorkbenchPageTarget(targetInfo) &&
      (this.#workbenchAttachPending || this.#workbenchSessionId !== undefined)
    ) {
      if (
        (this.#workbenchAttachmentEventSessionId !== undefined &&
          this.#workbenchAttachmentEventSessionId !== parameters.sessionId) ||
        (this.#workbenchSessionId !== undefined &&
          this.#workbenchSessionId !== parameters.sessionId)
      ) {
        this.#fail(
          new Error(
            'The workbench Target.attachedToTarget event changed its CDP session identity.',
          ),
        );
        return;
      }
      this.#workbenchAttachmentEventSessionId = parameters.sessionId;
      return;
    }
    if (isRootAttachment && this.#preexistingRootTargetIds.has(targetInfo.targetId)) {
      this.#resumeUntrackedTarget(parameters.sessionId, parameters.waitingForDebugger === true);
      return;
    }
    if (isRootAttachment && !ROOT_WORKER_TARGET_TYPES.has(targetInfo.type)) {
      this.#resumeUntrackedTarget(parameters.sessionId, parameters.waitingForDebugger === true);
      this.#fail(
        new Error(
          `Browser-root CDP auto-attach unexpectedly captured unsupported ${targetInfo.type} target.`,
        ),
      );
      return;
    }
    if (
      !isRootAttachment &&
      parentSessionId === this.#workbenchSessionId &&
      targetInfo.type !== 'iframe'
    ) {
      this.#resumeUntrackedTarget(parameters.sessionId, parameters.waitingForDebugger === true);
      this.#fail(
        new Error(
          `Workbench CDP auto-attach unexpectedly captured unsupported ${targetInfo.type} target.`,
        ),
      );
      return;
    }
    if (!CAPTURED_DESCENDANT_TARGET_TYPES.has(targetInfo.type)) {
      const parentSession = this.#sessions.get(parentSessionId);
      let unsupportedDescendant;
      if (parentSession !== undefined) {
        unsupportedDescendant = new Error(
          `CDP attached an unsupported ${targetInfo.type} target beneath a captured Webview.`,
        );
        parentSession.unsupportedDescendant = unsupportedDescendant;
      }
      this.#resumeUntrackedTarget(parameters.sessionId, parameters.waitingForDebugger === true);
      if (
        unsupportedDescendant !== undefined &&
        parentSession !== undefined &&
        this.#isSelectedSession(parentSession)
      ) {
        this.#fail(unsupportedDescendant);
      }
      return;
    }
    if (this.#sessions.has(parameters.sessionId)) {
      this.#fail(new Error('CDP auto-attach reused a session identity.'));
      return;
    }
    const parentSession = this.#sessions.get(parentSessionId);
    if (
      this.#finalizing &&
      (isRootAttachment ||
        parentSessionId === this.#workbenchSessionId ||
        (parentSession !== undefined && this.#isSelectedSession(parentSession)))
    ) {
      this.#fail(new Error('A CDP target attached after the OKF Webview network tree was sealed.'));
      return;
    }
    const session = {
      armComplete: false,
      armError: undefined,
      autoAttachArmed: false,
      detached: false,
      networkEnabled: false,
      parentSessionId,
      requests: [],
      rootAssociation: undefined,
      rootCandidate: isRootAttachment,
      sessionId: parameters.sessionId,
      targetInfo,
      unsupportedDescendant: undefined,
      urls: [],
      waitingForDebugger: parameters.waitingForDebugger === true,
    };
    this.#sessions.set(session.sessionId, session);
    this.#treeGeneration += 1;
    this.#considerOkfSession(session);
    this.#considerRootWorkerAssociations();
    session.armPromise = (async () => {
      if (!session.waitingForDebugger) {
        session.armError = new Error(
          session === this.#okfSession
            ? 'The OKF Webview target was not paused before its initial Network domain was enabled.'
            : 'An auto-attached Webview descendant was not paused before Network capture was armed.',
        );
      }
      try {
        await this.#send(
          'Target.setAutoAttach',
          {
            autoAttach: true,
            waitForDebuggerOnStart: true,
            flatten: true,
            filter: DESCENDANT_AUTO_ATTACH_FILTER,
          },
          session.sessionId,
        );
        session.autoAttachArmed = true;
      } catch (error) {
        session.armError ??= asError(
          error,
          'Could not arm recursive CDP auto-attach on a Webview target.',
        );
      }
      try {
        await this.#send('Network.enable', {}, session.sessionId);
        session.networkEnabled = true;
      } catch (error) {
        session.armError ??= asError(error, 'Could not enable CDP Network on a Webview target.');
      }
      try {
        await this.#send('Runtime.runIfWaitingForDebugger', {}, session.sessionId);
      } catch (error) {
        session.armError ??= asError(error, 'Could not resume an auto-attached Webview target.');
      } finally {
        session.armComplete = true;
        this.#assertSelectedTreeHealthy();
        this.#settleOkfReady();
      }
    })();
  }

  #handleTargetInfoChanged(targetInfo, observerSessionId) {
    if (typeof targetInfo?.targetId !== 'string') return;
    const sessions = this.#sessionsForObservedTarget(targetInfo.targetId, observerSessionId);
    if (sessions.length > 1) {
      this.#fail(
        new Error('A CDP target-info event was ambiguous across multiple captured sessions.'),
      );
      return;
    }
    const session = sessions[0];
    if (session !== undefined) {
      session.targetInfo = targetInfo;
      this.#considerOkfSession(session);
      this.#considerRootWorkerAssociations();
    }
  }

  #handleTargetEnded(targetId, method) {
    if (typeof targetId !== 'string') return;
    if (targetId === this.#workbenchTargetId) {
      this.#fail(
        new Error(`The VS Code workbench CDP target reported ${method} during network capture.`),
      );
      return;
    }
    const sessions = [...this.#sessions.values()].filter(
      (session) => session.targetInfo.targetId === targetId,
    );
    for (const session of sessions) {
      session.detached = true;
    }
    if (sessions.length > 0) this.#treeGeneration += 1;
    if (sessions.some((session) => this.#isSelectedSession(session))) {
      this.#fail(new Error(`An OKF Webview CDP target reported ${method} during network capture.`));
    }
  }

  #sessionsForObservedTarget(targetId, observerSessionId) {
    const matching = [...this.#sessions.values()].filter(
      (session) => session.targetInfo.targetId === targetId,
    );
    if (observerSessionId !== undefined) {
      const contextual = matching.filter(
        (session) =>
          session.parentSessionId === observerSessionId || session.sessionId === observerSessionId,
      );
      if (contextual.length > 0) return contextual;
    } else {
      const root = matching.filter((session) => session.rootCandidate);
      if (root.length > 0) return root;
    }
    return matching;
  }

  #considerOkfSessionsForTarget(targetId) {
    for (const session of this.#sessions.values()) {
      if (
        session.parentSessionId === this.#workbenchSessionId &&
        session.targetInfo.targetId === targetId
      ) {
        this.#considerOkfSession(session);
      }
    }
  }

  #considerOkfSession(session) {
    if (
      session === undefined ||
      session.parentSessionId !== this.#workbenchSessionId ||
      session.targetInfo.type !== 'iframe' ||
      (!isOkfWebviewTarget(session.targetInfo) &&
        !this.#hasOkfNavigationForTarget(session.targetInfo.targetId))
    ) {
      return;
    }
    if (this.#finalizing && this.#okfSession !== session) {
      this.#fail(new Error('An OKF Webview target was selected after finalization was sealed.'));
      return;
    }
    const wasUnselected = this.#okfSession === undefined;
    if (this.#okfSession !== undefined && this.#okfSession !== session) {
      this.#fail(new Error('More than one OKF Webview target was observed during one capture.'));
      return;
    }
    this.#okfSession = session;
    if (wasUnselected) this.#treeGeneration += 1;
    this.#considerRootWorkerAssociations();
    this.#assertSelectedTreeHealthy();
    this.#settleOkfReady();
  }

  #hasOkfNavigationForTarget(targetId) {
    return [...this.#parentNavigationRequests.values()].some(
      (request) => request.frameId === targetId && request.urls.some((url) => isOkfWebviewUrl(url)),
    );
  }

  #considerRootWorkerAssociations() {
    if (this.#okfSession === undefined || this.#fatalError !== undefined) return;
    const allRoots = [...this.#sessions.values()].filter((session) => session.rootCandidate);
    for (const root of allRoots) {
      const duplicates = [...this.#sessions.values()].filter(
        (session) =>
          !session.rootCandidate &&
          this.#isSelectedSession(session) &&
          session.targetInfo.type === root.targetInfo.type &&
          session.targetInfo.targetId === root.targetInfo.targetId,
      );
      if (duplicates.length > 0 && root.rootAssociation === undefined) {
        this.#associateRootWorker(root);
      }
    }

    const unresolved = allRoots.filter((session) => session.rootAssociation === undefined);
    const selectedTargetId = this.#okfSession.targetInfo.targetId;
    const sharedSignals = this.#okfSession.requests.filter(
      (request) => typeof request.requestId === 'string' && request.frameId === selectedTargetId,
    );
    for (const signal of sharedSignals) {
      const matches = unresolved.filter(
        (session) =>
          session.rootAssociation === undefined &&
          session.targetInfo.type === 'shared_worker' &&
          session.targetInfo.targetId === signal.requestId,
      );
      if (matches.length > 1) {
        this.#fail(
          new Error('A shared-worker CDP target was ambiguous for the selected Webview request.'),
        );
        return;
      }
      if (matches.length === 1) this.#associateRootWorker(matches[0]);
    }

    const webviewIdentities = uniqueSorted(
      [
        this.#okfSession.targetInfo.url,
        ...[...this.#parentNavigationRequests.values()]
          .filter((navigation) => navigation.frameId === selectedTargetId)
          .flatMap((navigation) => navigation.urls),
      ]
        .map(webviewProtocolHost)
        .filter((identity) => identity !== undefined),
    );
    if (webviewIdentities.length > 1) {
      this.#fail(
        new Error('The selected OKF Webview exposed ambiguous protocol-and-host identities.'),
      );
      return;
    }
    if (webviewIdentities.length === 1) {
      const serviceMatches = unresolved.filter(
        (session) =>
          session.rootAssociation === undefined &&
          session.targetInfo.type === 'service_worker' &&
          webviewProtocolHost(session.targetInfo.url) === webviewIdentities[0],
      );
      if (serviceMatches.length > 1) {
        this.#fail(
          new Error(
            'More than one browser-root service worker matched the selected Webview identity.',
          ),
        );
        return;
      }
      if (serviceMatches.length === 1) this.#associateRootWorker(serviceMatches[0]);
    }

    for (const root of unresolved) {
      if (
        root.rootAssociation === undefined &&
        root.targetInfo.type === 'worker' &&
        (root.targetInfo.openerId === selectedTargetId ||
          root.targetInfo.openerFrameId === selectedTargetId)
      ) {
        this.#associateRootWorker(root);
      }
    }
  }

  #associateRootWorker(session) {
    if (this.#finalizing) {
      this.#fail(
        new Error('A browser-root worker became associated after finalization was sealed.'),
      );
      return;
    }
    session.rootAssociation = this.#okfSession;
    this.#treeGeneration += 1;
    this.#assertSelectedTreeHealthy();
  }

  #settleOkfReady() {
    if (
      this.#readySettled ||
      this.#fatalError !== undefined ||
      this.#okfSession === undefined ||
      !this.#okfSession.armComplete
    ) {
      return;
    }
    this.#assertSelectedTreeHealthy();
    if (this.#fatalError === undefined) {
      this.#readySettled = true;
      this.#readyResolve(this.#okfSession);
    }
  }

  #isSelectedSession(session) {
    if (this.#okfSession === undefined) return false;
    let current = session;
    const visited = new Set();
    while (current !== undefined && !visited.has(current.sessionId)) {
      if (current === this.#okfSession) return true;
      if (current.rootAssociation === this.#okfSession) return true;
      visited.add(current.sessionId);
      if (
        current.parentSessionId === this.#workbenchSessionId ||
        current.parentSessionId === undefined
      ) {
        return false;
      }
      current = this.#sessions.get(current.parentSessionId);
    }
    return false;
  }

  #isCaptureRelevantSession(session) {
    return this.#isSelectedSession(session);
  }

  #selectedSessions() {
    return [...this.#sessions.values()].filter((session) => this.#isSelectedSession(session));
  }

  #assertSelectedTreeHealthy() {
    if (this.#fatalError !== undefined || this.#okfSession === undefined) return;
    for (const session of this.#selectedSessions()) {
      if (session.detached) {
        this.#fail(
          new Error('An OKF Webview CDP session detached before network capture completed.'),
        );
        return;
      }
      if (session.unsupportedDescendant !== undefined) {
        this.#fail(session.unsupportedDescendant);
        return;
      }
      if (!session.armComplete) continue;
      if (session.armError !== undefined) {
        this.#fail(session.armError);
        return;
      }
      if (!session.autoAttachArmed || !session.networkEnabled || !session.waitingForDebugger) {
        this.#fail(
          new Error(
            'An OKF Webview CDP session reached the capture boundary without complete recursive Network coverage.',
          ),
        );
        return;
      }
    }
  }

  async #awaitSelectedTreeArmed() {
    for (let pass = 0; pass < MAX_TREE_STABILIZATION_PASSES; pass += 1) {
      this.#throwIfFatal();
      const sessions = this.#selectedSessions();
      await Promise.all(sessions.map((session) => session.armPromise));
      this.#assertSelectedTreeHealthy();
      this.#throwIfFatal();
      const after = this.#selectedSessions();
      if (
        after.length === sessions.length &&
        after.every((session) => sessions.includes(session))
      ) {
        return;
      }
    }
    throw new Error('The OKF Webview CDP descendant tree did not stabilize.');
  }

  async #fullBarrierSelectedTree() {
    for (let pass = 0; pass < MAX_TREE_STABILIZATION_PASSES; pass += 1) {
      await this.#awaitSelectedTreeArmed();
      const generation = this.#treeGeneration;
      const sessions = this.#selectedSessions();
      for (const session of sessions) {
        await this.#send(
          'Runtime.evaluate',
          { expression: 'void 0', returnByValue: true },
          session.sessionId,
        );
      }
      await this.#send(
        'Runtime.evaluate',
        { expression: 'void 0', returnByValue: true },
        this.#workbenchSessionId,
      );
      await this.#awaitSelectedTreeArmed();
      this.#considerRootWorkerAssociations();
      this.#throwIfFatal();
      const after = this.#selectedSessions();
      if (
        generation === this.#treeGeneration &&
        after.length === sessions.length &&
        after.every((session) => sessions.includes(session))
      ) {
        return { generation, sessions };
      }
    }
    throw new Error(
      'The OKF Webview CDP descendant tree changed throughout the full final barrier.',
    );
  }

  #assertRootWorkersResolved() {
    this.#considerRootWorkerAssociations();
    this.#throwIfFatal();
    const unresolved = [...this.#sessions.values()].filter(
      (session) => session.rootCandidate && session.rootAssociation === undefined,
    );
    if (unresolved.length > 0) {
      const labels = unresolved
        .map((session) => `${session.targetInfo.type}:${session.targetInfo.targetId}`)
        .sort()
        .join(', ');
      throw new Error(
        `Browser-root worker targets could not be unambiguously associated with the selected OKF Webview: ${labels}.`,
      );
    }
  }

  #assertFinalizationSeal(seal) {
    this.#throwIfFatal();
    const current = this.#selectedSessions();
    if (
      this.#treeGeneration !== seal.generation ||
      current.length !== seal.sessions.length ||
      current.some((session) => !seal.sessions.includes(session))
    ) {
      throw new Error('The OKF Webview CDP target tree changed after the finalization seal.');
    }
  }

  #sessionDepth(session) {
    let depth = 0;
    let current = session;
    const visited = new Set();
    while (
      current !== undefined &&
      current.parentSessionId !== this.#workbenchSessionId &&
      !visited.has(current.sessionId)
    ) {
      visited.add(current.sessionId);
      depth += 1;
      current = this.#sessions.get(current.parentSessionId);
    }
    return depth;
  }

  #resumeUntrackedTarget(sessionId, waitingForDebugger) {
    if (!waitingForDebugger) return;
    void this.#send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch((error) => {
      this.#fail(asError(error, 'Could not resume an excluded CDP target.'));
    });
  }

  #waitForOpen() {
    if (this.#socket.readyState === 1) return Promise.resolve();
    if (this.#socket.readyState === 2 || this.#socket.readyState === 3) {
      return Promise.reject(new Error('The browser CDP WebSocket was already closed.'));
    }
    return new Promise((resolve, reject) => {
      const opened = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error('Could not open the browser CDP WebSocket.'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('The browser CDP WebSocket did not open before the command timeout.'));
      }, this.#options.commandTimeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.#socket.removeEventListener('open', opened);
        this.#socket.removeEventListener('error', failed);
        this.#socket.removeEventListener('close', failed);
      };
      this.#socket.addEventListener('open', opened);
      this.#socket.addEventListener('error', failed);
      this.#socket.addEventListener('close', failed);
    });
  }

  #send(method, parameters = {}, sessionId) {
    this.#throwIfFatal();
    const id = (this.#commandId += 1);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingCommands.delete(id);
        reject(new Error(`CDP ${method} did not respond before the command timeout.`));
      }, this.#options.commandTimeoutMs);
      this.#pendingCommands.set(id, { method, reject, resolve, timer });
      try {
        this.#socket.send(
          JSON.stringify({
            id,
            method,
            params: parameters,
            ...(sessionId === undefined ? {} : { sessionId }),
          }),
        );
      } catch (error) {
        clearTimeout(timer);
        this.#pendingCommands.delete(id);
        reject(new Error(`Could not send CDP ${method}: ${String(error)}`));
      }
    });
  }

  #fail(error) {
    if (this.#fatalError !== undefined) return;
    this.#fatalError = error;
    for (const pending of this.#pendingCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pendingCommands.clear();
    if (!this.#readySettled) {
      this.#readySettled = true;
      this.#readyResolve(undefined);
    }
  }

  #throwIfFatal() {
    if (this.#fatalError !== undefined) throw this.#fatalError;
  }
}

export function classifyNetworkUrl(value) {
  try {
    const parsed = new URL(value);
    const protocol = parsed.protocol.toLowerCase();
    const host = parsed.host.toLowerCase();
    const origin = `${protocol}//${host}`;
    if (origin === PACKAGED_RESOURCE_ORIGIN) {
      return { kind: 'local', origin };
    }
    if (protocol === 'vscode-webview:' && /^[a-z\d]{32,64}$/u.test(host)) {
      return { kind: 'navigation', origin };
    }
    if (['http:', 'https:', 'ws:', 'wss:'].includes(protocol)) {
      return { kind: 'remote', origin };
    }
    return { kind: 'other', origin: protocol || 'unknown:' };
  } catch {
    return { kind: 'other', origin: 'invalid:' };
  }
}

function isOkfWebviewTarget(value) {
  return value?.type === 'iframe' && typeof value.url === 'string' && isOkfWebviewUrl(value.url);
}

function isOkfWebviewUrl(value) {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'vscode-webview:' &&
      parsed.searchParams.get('extensionId') === OKF_EXTENSION_ID
    );
  } catch {
    return false;
  }
}

function isWorkbenchPageTarget(value) {
  return (
    value?.type === 'page' &&
    typeof value.url === 'string' &&
    value.url.startsWith('vscode-file://vscode-app/') &&
    value.url.includes('/workbench/')
  );
}

function webviewProtocolHost(value) {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'blob:') {
      return webviewProtocolHost(value.slice('blob:'.length));
    }
    if (parsed.protocol !== 'vscode-webview:' || parsed.host.length === 0) return undefined;
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}`;
  } catch {
    return undefined;
  }
}

function asError(value, fallbackMessage) {
  return value instanceof Error ? value : new Error(`${fallbackMessage} ${String(value)}`);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}
