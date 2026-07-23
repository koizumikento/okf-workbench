import { describe, expect, it } from 'vitest';

import {
  classifyNetworkUrl,
  createWebviewNetworkRecorder,
  type WebviewNetworkRecorder,
} from '../../benchmarks/webview-network-recorder.mjs';

const WEBVIEW_HOST = '07ah2qk3gn0a6knrq6q3pnd6p9d310f8gqc9g48lfsosvfbe2dc2';
const WEBVIEW_URL = `vscode-webview://${WEBVIEW_HOST}/index.html?extensionId=straydog.okf-workbench`;

describe('headed Webview network recorder', () => {
  it('enables Network before resuming the initial paused target and captures late HTTP/WS traffic', async () => {
    const harness = recorderHarness({
      wait() {
        harness.socket.emitMessage({
          sessionId: 'okf-session',
          method: 'Network.requestWillBeSent',
          params: { request: { url: 'https://late.example/after-operation' } },
        });
        return Promise.resolve();
      },
    });
    const recorder = await harness.create();
    harness.socket.emitMessage({
      sessionId: 'workbench-session',
      method: 'Network.requestWillBeSent',
      params: {
        requestId: 'okf-navigation',
        frameId: 'okf-target',
        request: { url: WEBVIEW_URL },
      },
    });
    harness.attachOkfTarget();
    await recorder.waitForOkfTarget();
    for (const resource of ['main.js', 'main.css']) {
      harness.socket.emitMessage({
        sessionId: 'okf-session',
        method: 'Network.requestWillBeSent',
        params: {
          request: {
            url: `https://file+.vscode-resource.vscode-cdn.net/extension/${resource}`,
          },
        },
      });
    }
    harness.socket.emitMessage({
      sessionId: 'okf-session',
      method: 'Network.requestWillBeSent',
      params: { request: { url: 'https://fetch.example/never-completes' } },
    });
    harness.socket.emitMessage({
      sessionId: 'okf-session',
      method: 'Network.webSocketCreated',
      params: { url: 'wss://socket.example/stream' },
    });
    harness.socket.emitMessage({
      sessionId: 'okf-session',
      method: 'Network.webTransportCreated',
      params: { url: 'https://transport.example/session' },
    });

    const observation = await recorder.snapshot(
      'Initial Webview resources plus CDP events through the final barrier.',
    );

    const enableIndex = harness.commands.findIndex(
      (command) => command.method === 'Network.enable' && command.sessionId === 'okf-session',
    );
    const recursiveAttachIndex = harness.commands.findIndex(
      (command) => command.method === 'Target.setAutoAttach' && command.sessionId === 'okf-session',
    );
    const resumeIndex = harness.commands.findIndex(
      (command) =>
        command.method === 'Runtime.runIfWaitingForDebugger' && command.sessionId === 'okf-session',
    );
    expect(recursiveAttachIndex).toBeGreaterThanOrEqual(0);
    expect(enableIndex).toBeGreaterThan(recursiveAttachIndex);
    expect(enableIndex).toBeGreaterThanOrEqual(0);
    expect(resumeIndex).toBeGreaterThan(enableIndex);
    expect(observation).toMatchObject({
      remoteRequestCount: 4,
      remoteOrigins: [
        'https://fetch.example',
        'https://late.example',
        'https://transport.example',
        'wss://socket.example',
      ],
      localResourceRequestCount: 2,
      localOrigins: ['https://file+.vscode-resource.vscode-cdn.net'],
      webviewNavigationRequestCount: 1,
      webviewNavigationOrigins: [`vscode-webview://${WEBVIEW_HOST}`],
      otherRequestCount: 0,
      otherSchemes: [],
    });
    expect(harness.commands.slice(-5)).toEqual([
      expect.objectContaining({ method: 'Runtime.evaluate', sessionId: 'okf-session' }),
      expect.objectContaining({ method: 'Runtime.evaluate', sessionId: 'workbench-session' }),
      expect.objectContaining({ method: 'Network.disable', sessionId: 'okf-session' }),
      expect.objectContaining({ method: 'Network.disable', sessionId: 'workbench-session' }),
      expect.objectContaining({ method: 'Target.getTargets' }),
    ]);
    recorder.close();
  });

  it('rejects a pre-existing OKF Webview because its initial navigation was not paused', async () => {
    const harness = recorderHarness({ preexistingOkfTarget: true });
    await expect(harness.create()).rejects.toThrow('must be armed before any OKF Webview target');
  });

  it('rejects an OKF target that was not paused before Network.enable', async () => {
    const harness = recorderHarness();
    const recorder = await harness.create();
    harness.attachOkfTarget({ waitingForDebugger: false });
    await expect(recorder.waitForOkfTarget()).rejects.toThrow(
      'was not paused before its initial Network domain was enabled',
    );
    recorder.close();
  });

  it('rejects a Network.enable protocol error', async () => {
    const harness = recorderHarness({ failNetworkEnable: true });
    const recorder = await harness.create();
    harness.attachOkfTarget();
    await expect(recorder.waitForOkfTarget()).rejects.toThrow('CDP Network.enable failed');
    recorder.close();
  });

  it('counts a remote redirect in the frame-correlated initial navigation', async () => {
    const harness = recorderHarness();
    const recorder = await readyRecorder(harness);
    harness.socket.emitMessage({
      sessionId: 'workbench-session',
      method: 'Network.requestWillBeSent',
      params: {
        requestId: 'okf-navigation',
        frameId: 'okf-target',
        request: { url: WEBVIEW_URL },
      },
    });
    harness.socket.emitMessage({
      sessionId: 'workbench-session',
      method: 'Network.requestWillBeSent',
      params: {
        requestId: 'okf-navigation',
        frameId: 'okf-target',
        request: { url: 'https://redirect.example/escaped' },
      },
    });
    const observation = await recorder.snapshot(
      'Initial Webview resources plus CDP events through the final barrier.',
    );
    expect(observation.remoteOrigins).toEqual(['https://redirect.example']);
    expect(observation.remoteRequestCount).toBe(1);
    recorder.close();
  });

  it('rejects a matching-looking navigation from a different CDP frame', async () => {
    const harness = recorderHarness();
    const recorder = await readyRecorder(harness);
    harness.socket.emitMessage({
      sessionId: 'workbench-session',
      method: 'Network.requestWillBeSent',
      params: {
        requestId: 'forged-navigation',
        frameId: 'different-frame',
        request: { url: WEBVIEW_URL },
      },
    });
    await expect(recorder.snapshot('Initial Webview resources plus CDP events.')).rejects.toThrow(
      'exactly one frame-correlated initial navigation',
    );
    recorder.close();
  });

  it('rejects multiple initial navigations correlated to the selected frame', async () => {
    const harness = recorderHarness();
    const recorder = await readyRecorder(harness);
    for (const requestId of ['first-navigation', 'second-navigation']) {
      harness.socket.emitMessage({
        sessionId: 'workbench-session',
        method: 'Network.requestWillBeSent',
        params: {
          requestId,
          frameId: 'okf-target',
          request: { url: WEBVIEW_URL },
        },
      });
    }
    await expect(recorder.snapshot('Initial Webview resources plus CDP events.')).rejects.toThrow(
      'exactly one frame-correlated initial navigation',
    );
    recorder.close();
  });

  it.each(['close', 'error'] as const)(
    'rejects a partial observation after an unexpected CDP socket %s',
    async (signal) => {
      const harness = recorderHarness();
      const recorder = await readyRecorder(harness);
      harness.socket.emitSignal(signal);
      await expect(recorder.snapshot('Initial Webview resources plus CDP events.')).rejects.toThrow(
        `CDP socket ${signal === 'close' ? 'closed' : 'failed'}`,
      );
      recorder.close();
    },
  );

  it('rejects a detached OKF session before the final barrier', async () => {
    const harness = recorderHarness();
    const recorder = await readyRecorder(harness);
    harness.socket.emitMessage({
      method: 'Target.detachedFromTarget',
      params: { sessionId: 'okf-session', targetId: 'okf-target' },
    });
    await expect(recorder.snapshot('Initial Webview resources plus CDP events.')).rejects.toThrow(
      'session detached before network capture completed',
    );
    recorder.close();
  });

  it('arms recursive iframe auto-attach and Network on the workbench page session', async () => {
    const harness = recorderHarness();
    const recorder = await harness.create();
    const rootWorkerAttach = harness.commands.findIndex(
      (command) => command.method === 'Target.setAutoAttach' && command.sessionId === undefined,
    );
    const workbenchAttach = harness.commands.findIndex(
      (command) => command.method === 'Target.attachToTarget',
    );
    const parentEnable = harness.commands.findIndex(
      (command) => command.method === 'Network.enable' && command.sessionId === 'workbench-session',
    );
    const recursiveAttach = harness.commands.findIndex(
      (command) =>
        command.method === 'Target.setAutoAttach' && command.sessionId === 'workbench-session',
    );
    expect(rootWorkerAttach).toBeGreaterThanOrEqual(0);
    expect(rootWorkerAttach).toBeLessThan(workbenchAttach);
    expect(harness.commands[rootWorkerAttach]?.params).toMatchObject({
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [
        { type: 'worker', exclude: false },
        { type: 'shared_worker', exclude: false },
        { type: 'service_worker', exclude: false },
        { exclude: true },
      ],
    });
    expect(parentEnable).toBeGreaterThanOrEqual(0);
    expect(recursiveAttach).toBeGreaterThan(parentEnable);
    expect(harness.commands[recursiveAttach]?.params).toMatchObject({
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: 'iframe', exclude: false }, { exclude: true }],
    });
    recorder.close();
  });

  it.each(['before-response', 'after-response'] as const)(
    'binds the explicit workbench root attachment event when it arrives %s',
    async (workbenchAttachEventOrder) => {
      const harness = recorderHarness({ workbenchAttachEventOrder });
      const recorder = await harness.create();

      expect(
        harness.commands.some(
          (command) =>
            command.method === 'Network.enable' && command.sessionId === 'workbench-session',
        ),
      ).toBe(true);
      recorder.close();
    },
  );

  it('associates browser-root shared and service workers and captures their egress', async () => {
    const harness = recorderHarness();
    const recorder = await harness.create();
    harness.emitOkfNavigation();
    harness.attachOkfTarget();
    await recorder.waitForOkfTarget();

    harness.attachTarget({
      sessionId: 'shared-worker-root-session',
      targetId: 'shared-worker-root-target',
      type: 'shared_worker',
      url: `vscode-webview://${WEBVIEW_HOST}/shared-worker.js`,
    });
    harness.socket.emitMessage({
      sessionId: 'okf-session',
      method: 'Network.requestWillBeSent',
      params: {
        requestId: 'shared-worker-root-target',
        frameId: 'okf-target',
        request: { url: `vscode-webview://${WEBVIEW_HOST}/shared-worker.js` },
      },
    });
    harness.attachTarget({
      sessionId: 'service-worker-root-session',
      targetId: 'service-worker-root-target',
      type: 'service_worker',
      url: `vscode-webview://${WEBVIEW_HOST}/service-worker.js`,
    });
    await waitForSentCommand(
      harness,
      (command) =>
        command.method === 'Runtime.runIfWaitingForDebugger' &&
        command.sessionId === 'service-worker-root-session',
    );
    for (const [sessionId, url] of [
      ['shared-worker-root-session', 'wss://shared-root.example/socket'],
      ['service-worker-root-session', 'https://service-root.example/fetch'],
    ] as const) {
      harness.socket.emitMessage({
        sessionId,
        method: sessionId.startsWith('shared')
          ? 'Network.webSocketCreated'
          : 'Network.requestWillBeSent',
        params: sessionId.startsWith('shared') ? { url } : { request: { url } },
      });
    }

    const observation = await recorder.snapshot('Browser-root worker capture.');

    expect(observation.remoteRequestCount).toBe(2);
    expect(observation.remoteOrigins).toEqual([
      'https://service-root.example',
      'wss://shared-root.example',
    ]);
    for (const sessionId of ['shared-worker-root-session', 'service-worker-root-session']) {
      const recursiveAttachIndex = harness.commands.findIndex(
        (command) => command.method === 'Target.setAutoAttach' && command.sessionId === sessionId,
      );
      const enableIndex = harness.commands.findIndex(
        (command) => command.method === 'Network.enable' && command.sessionId === sessionId,
      );
      const resumeIndex = harness.commands.findIndex(
        (command) =>
          command.method === 'Runtime.runIfWaitingForDebugger' && command.sessionId === sessionId,
      );
      expect(enableIndex).toBeGreaterThan(recursiveAttachIndex);
      expect(resumeIndex).toBeGreaterThan(enableIndex);
    }
    recorder.close();
  });

  it('captures a browser-root service worker attached by the pre-Webview auto-attach command', async () => {
    let injected = false;
    const harness = recorderHarness({
      onCommand(command, socket) {
        if (
          !injected &&
          command.method === 'Target.setAutoAttach' &&
          command.sessionId === undefined
        ) {
          injected = true;
          socket.emitMessage({
            method: 'Target.attachedToTarget',
            params: {
              sessionId: 'early-service-session',
              waitingForDebugger: true,
              targetInfo: {
                targetId: 'early-service-target',
                type: 'service_worker',
                url: `blob:vscode-webview://${WEBVIEW_HOST}/service-worker.js`,
              },
            },
          });
        }
        if (command.method === 'Network.enable' && command.sessionId === 'early-service-session') {
          socket.emitMessage({
            sessionId: 'early-service-session',
            method: 'Network.requestWillBeSent',
            params: { request: { url: 'https://early-service.example/fetch' } },
          });
        }
      },
    });
    const recorder = await harness.create();
    harness.emitOkfNavigation();
    harness.attachOkfTarget();
    await recorder.waitForOkfTarget();

    const observation = await recorder.snapshot('Pre-Webview browser-root auto-attach.');

    expect(observation.remoteOrigins).toEqual(['https://early-service.example']);
    expect(observation.remoteRequestCount).toBe(1);
    const rootArm = harness.commands.findIndex(
      (command) => command.method === 'Target.setAutoAttach' && command.sessionId === undefined,
    );
    const workbenchAttach = harness.commands.findIndex(
      (command) => command.method === 'Target.attachToTarget',
    );
    expect(rootArm).toBeLessThan(workbenchAttach);
    recorder.close();
  });

  it('excludes a pre-existing browser-root service worker from the selected capture', async () => {
    const preexisting = {
      targetId: 'preexisting-service-target',
      type: 'service_worker' as const,
      url: 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/service-worker.js',
    };
    const harness = recorderHarness({ preexistingRootTargets: [preexisting] });
    const recorder = await harness.create();
    harness.attachTarget({
      sessionId: 'preexisting-service-session',
      ...preexisting,
      waitingForDebugger: false,
    });
    harness.emitOkfNavigation();
    harness.attachOkfTarget();
    await recorder.waitForOkfTarget();

    const observation = await recorder.snapshot('Pre-existing root workers are excluded.');

    expect(observation.remoteRequestCount).toBe(0);
    expect(
      harness.commands.some(
        (command) =>
          command.method === 'Network.enable' &&
          command.sessionId === 'preexisting-service-session',
      ),
    ).toBe(false);
    recorder.close();
  });

  it.each(['Inspector.targetCrashed', 'Target.detachedFromTarget'] as const)(
    'rejects %s on a browser-root session that duplicates a selected recursive worker',
    async (method) => {
      const harness = recorderHarness();
      const recorder = await readyRecorder(harness);
      harness.attachTarget({
        parentSessionId: 'okf-session',
        sessionId: 'duplicate-recursive-session',
        targetId: 'duplicate-worker-target',
        type: 'worker',
        url: 'blob:duplicate-worker',
      });
      harness.attachTarget({
        sessionId: 'duplicate-root-session',
        targetId: 'duplicate-worker-target',
        type: 'worker',
        url: 'blob:duplicate-worker',
      });
      await waitForSentCommand(
        harness,
        (command) =>
          command.method === 'Runtime.runIfWaitingForDebugger' &&
          command.sessionId === 'duplicate-root-session',
      );
      harness.socket.emitMessage(
        method === 'Target.detachedFromTarget'
          ? {
              method,
              params: {
                sessionId: 'duplicate-root-session',
                targetId: 'duplicate-worker-target',
              },
            }
          : {
              sessionId: 'duplicate-root-session',
              method,
              params: {},
            },
      );

      await expect(
        recorder.snapshot('Duplicate worker lifecycle loss must fail closed.'),
      ).rejects.toThrow(/(?:reported|detached)/u);
      recorder.close();
    },
  );

  it('rejects a browser-root targetDestroyed event for duplicate root and recursive sessions', async () => {
    const harness = recorderHarness();
    const recorder = await readyRecorder(harness);
    for (const target of [
      {
        parentSessionId: 'okf-session',
        sessionId: 'destroy-recursive-session',
      },
      {
        sessionId: 'destroy-root-session',
      },
    ]) {
      harness.attachTarget({
        ...target,
        targetId: 'destroy-duplicate-target',
        type: 'worker',
        url: 'blob:destroy-duplicate-worker',
      });
    }
    await waitForSentCommand(
      harness,
      (command) =>
        command.method === 'Runtime.runIfWaitingForDebugger' &&
        command.sessionId === 'destroy-root-session',
    );
    harness.socket.emitMessage({
      method: 'Target.targetDestroyed',
      params: { targetId: 'destroy-duplicate-target' },
    });

    await expect(recorder.snapshot('Global duplicate target destruction.')).rejects.toThrow(
      'Target.targetDestroyed',
    );
    recorder.close();
  });

  it('preserves root-observed egress when a recursive session for the same target attaches later', async () => {
    const harness = recorderHarness();
    const recorder = await harness.create();
    harness.emitOkfNavigation();
    harness.attachOkfTarget();
    await recorder.waitForOkfTarget();
    harness.attachTarget({
      sessionId: 'root-first-session',
      targetId: 'root-first-target',
      type: 'worker',
      url: 'blob:root-first-worker',
    });
    await waitForSentCommand(
      harness,
      (command) =>
        command.method === 'Runtime.runIfWaitingForDebugger' &&
        command.sessionId === 'root-first-session',
    );
    harness.socket.emitMessage({
      sessionId: 'root-first-session',
      method: 'Network.requestWillBeSent',
      params: { request: { url: 'https://root-first.example/egress' } },
    });
    harness.attachTarget({
      parentSessionId: 'okf-session',
      sessionId: 'recursive-later-session',
      targetId: 'root-first-target',
      type: 'worker',
      url: 'blob:root-first-worker',
    });

    const observation = await recorder.snapshot('Duplicate target event ordering.');

    expect(observation.remoteOrigins).toEqual(['https://root-first.example']);
    expect(observation.remoteRequestCount).toBe(1);
    recorder.close();
  });

  it('fails closed for an unassociated new browser-root worker', async () => {
    const harness = recorderHarness();
    const recorder = await readyRecorder(harness);
    harness.attachTarget({
      sessionId: 'ambiguous-root-session',
      targetId: 'ambiguous-root-target',
      type: 'shared_worker',
      url: 'https://unrelated.example/shared.js',
    });

    await expect(recorder.snapshot('Ambiguous root worker must fail closed.')).rejects.toThrow(
      'could not be unambiguously associated',
    );
    recorder.close();
  });

  it('does not collapse distinct opaque Webview hosts when associating a service worker', async () => {
    const harness = recorderHarness();
    const recorder = await readyRecorder(harness);
    harness.attachTarget({
      sessionId: 'other-host-service-session',
      targetId: 'other-host-service-target',
      type: 'service_worker',
      url: 'blob:vscode-webview://11111111111111111111111111111111/service-worker.js',
    });

    await expect(recorder.snapshot('Distinct opaque Webview host.')).rejects.toThrow(
      'could not be unambiguously associated',
    );
    recorder.close();
  });

  it('fails closed for an unknown target type beneath the selected Webview', async () => {
    let injected = false;
    const harness = recorderHarness({
      onCommand(command, socket) {
        if (
          !injected &&
          command.method === 'Runtime.evaluate' &&
          command.sessionId === 'okf-session'
        ) {
          injected = true;
          socket.emitMessage({
            sessionId: 'okf-session',
            method: 'Target.attachedToTarget',
            params: {
              sessionId: 'worklet-session',
              waitingForDebugger: true,
              targetInfo: {
                targetId: 'worklet-target',
                type: 'worklet',
                url: `vscode-webview://${WEBVIEW_HOST}/worklet.js`,
              },
            },
          });
        }
      },
    });
    const recorder = await readyRecorder(harness);

    await expect(recorder.snapshot('Unknown descendants must fail closed.')).rejects.toThrow(
      'unsupported worklet target beneath a captured Webview',
    );
    recorder.close();
  });

  it('rejects a selected worker that attaches while Network.disable is in flight', async () => {
    let injected = false;
    const harness = recorderHarness({
      onCommand(command, socket) {
        if (
          !injected &&
          command.method === 'Network.disable' &&
          command.sessionId === 'okf-session'
        ) {
          injected = true;
          socket.emitMessage({
            sessionId: 'okf-session',
            method: 'Target.attachedToTarget',
            params: {
              sessionId: 'late-worker-session',
              waitingForDebugger: true,
              targetInfo: {
                targetId: 'late-worker-target',
                type: 'worker',
                url: `vscode-webview://${WEBVIEW_HOST}/late-worker.js`,
              },
            },
          });
        }
      },
    });
    const recorder = await readyRecorder(harness);

    await expect(recorder.snapshot('Finalization race must fail closed.')).rejects.toThrow(
      'attached after the OKF Webview network tree was sealed',
    );
    recorder.close();
  });

  it('restarts the final barrier when a supported worker attaches and includes its egress', async () => {
    let okfBarrierCount = 0;
    let injected = false;
    const harness = recorderHarness({
      onCommand(command, socket) {
        if (command.method === 'Runtime.evaluate' && command.sessionId === 'okf-session') {
          okfBarrierCount += 1;
          if (!injected && okfBarrierCount === 2) {
            injected = true;
            socket.emitMessage({
              sessionId: 'okf-session',
              method: 'Target.attachedToTarget',
              params: {
                sessionId: 'barrier-worker-session',
                waitingForDebugger: true,
                targetInfo: {
                  targetId: 'barrier-worker-target',
                  type: 'worker',
                  url: 'blob:barrier-worker',
                },
              },
            });
          }
        }
        if (command.method === 'Network.enable' && command.sessionId === 'barrier-worker-session') {
          socket.emitMessage({
            sessionId: 'barrier-worker-session',
            method: 'Network.requestWillBeSent',
            params: { request: { url: 'https://barrier-worker.example/egress' } },
          });
        }
      },
    });
    const recorder = await harness.create();
    harness.emitOkfNavigation();
    harness.attachOkfTarget();
    await recorder.waitForOkfTarget();

    const observation = await recorder.snapshot('Successful final-barrier tree restart.');

    expect(observation.remoteOrigins).toEqual(['https://barrier-worker.example']);
    expect(observation.remoteRequestCount).toBe(1);
    expect(okfBarrierCount).toBeGreaterThanOrEqual(3);
    expect(
      harness.commands.some(
        (command) =>
          command.method === 'Runtime.evaluate' && command.sessionId === 'barrier-worker-session',
      ),
    ).toBe(true);
    expect(
      harness.commands.some(
        (command) =>
          command.method === 'Network.disable' && command.sessionId === 'barrier-worker-session',
      ),
    ).toBe(true);
    recorder.close();
  });

  it('rejects a fresh parent-observed selected-frame request while Network.disable is in flight', async () => {
    let injected = false;
    const harness = recorderHarness({
      onCommand(command, socket) {
        if (
          !injected &&
          command.method === 'Network.disable' &&
          command.sessionId === 'okf-session'
        ) {
          injected = true;
          socket.emitMessage({
            sessionId: 'workbench-session',
            method: 'Network.requestWillBeSent',
            params: {
              requestId: 'fresh-after-seal-navigation',
              frameId: 'okf-target',
              request: { url: 'https://after-seal.example/new-document' },
            },
          });
        }
      },
    });
    const recorder = await readyRecorder(harness);

    await expect(recorder.snapshot('Parent-observed finalization race.')).rejects.toThrow(
      'parent-observed request after finalization was sealed',
    );
    recorder.close();
  });

  it('rejects a command-driven Inspector crash during the final child barrier', async () => {
    let injected = false;
    const harness = recorderHarness({
      onCommand(command, socket) {
        if (
          !injected &&
          command.method === 'Runtime.evaluate' &&
          command.sessionId === 'okf-session'
        ) {
          injected = true;
          socket.emitMessage({
            sessionId: 'okf-session',
            method: 'Inspector.targetReloadedAfterCrash',
            params: {},
          });
        }
      },
    });
    const recorder = await readyRecorder(harness);

    await expect(recorder.snapshot('Command-driven crash.')).rejects.toThrow(
      'Inspector.targetReloadedAfterCrash',
    );
    recorder.close();
  });

  it.each([
    ['Inspector.targetCrashed', 'okf-session', undefined],
    ['Inspector.targetReloadedAfterCrash', 'okf-session', undefined],
    ['Target.targetCrashed', undefined, 'okf-target'],
    ['Target.targetDestroyed', undefined, 'okf-target'],
    ['Inspector.detached', 'workbench-session', undefined],
    ['Target.targetDestroyed', undefined, 'workbench-target'],
  ] as const)('rejects lifecycle loss from %s', async (method, sessionId, targetId) => {
    const harness = recorderHarness();
    const recorder = await readyRecorder(harness);
    harness.socket.emitMessage({
      ...(sessionId === undefined ? {} : { sessionId }),
      method,
      params: targetId === undefined ? {} : { targetId },
    });

    await expect(recorder.snapshot('Lifecycle loss must fail closed.')).rejects.toThrow(
      /(?:reported|detached)/u,
    );
    recorder.close();
  });

  it('times out instead of hanging when the CDP socket never opens', async () => {
    const harness = recorderHarness({ commandTimeoutMs: 1, openSocket: false });
    await expect(harness.create()).rejects.toThrow(
      'WebSocket did not open before the command timeout',
    );
  });

  it('rejects a CDP socket that is already closed before initialization', async () => {
    const harness = recorderHarness({ openSocket: false });
    harness.socket.readyState = 3;
    await expect(harness.create()).rejects.toThrow('WebSocket was already closed');
  });

  it('recursively arms and aggregates iframe, worker, shared-worker, and service-worker traffic', async () => {
    const harness = recorderHarness();
    const recorder = await harness.create();
    harness.emitOkfNavigation();
    harness.attachOkfTarget();
    await recorder.waitForOkfTarget();

    const descendants = [
      {
        parentSessionId: 'okf-session',
        sessionId: 'nested-iframe-session',
        targetId: 'nested-iframe-target',
        type: 'iframe',
        url: 'about:blank',
        origin: 'https://iframe-fetch.example',
      },
      {
        parentSessionId: 'okf-session',
        sessionId: 'worker-session',
        targetId: 'worker-target',
        type: 'worker',
        url: 'blob:worker',
        origin: 'https://worker-fetch.example',
      },
      {
        parentSessionId: 'okf-session',
        sessionId: 'shared-worker-session',
        targetId: 'shared-worker-target',
        type: 'shared_worker',
        url: 'blob:shared-worker',
        origin: 'wss://shared-worker.example',
      },
      {
        parentSessionId: 'okf-session',
        sessionId: 'service-worker-session',
        targetId: 'service-worker-target',
        type: 'service_worker',
        url: 'blob:service-worker',
        origin: 'https://service-worker.example',
      },
      {
        parentSessionId: 'nested-iframe-session',
        sessionId: 'nested-worker-session',
        targetId: 'nested-worker-target',
        type: 'worker',
        url: 'blob:nested-worker',
        origin: 'https://nested-worker.example',
      },
    ] as const;
    for (const descendant of descendants) {
      harness.attachTarget(descendant);
      harness.socket.emitMessage({
        sessionId: descendant.sessionId,
        method:
          descendant.type === 'shared_worker'
            ? 'Network.webSocketCreated'
            : descendant.type === 'service_worker'
              ? 'Network.webTransportCreated'
              : 'Network.requestWillBeSent',
        params:
          descendant.type === 'shared_worker' || descendant.type === 'service_worker'
            ? { url: `${descendant.origin}/channel` }
            : { request: { url: `${descendant.origin}/request` } },
      });
    }

    const observation = await recorder.snapshot('Recursive OKF Webview descendant capture.');

    expect(observation.remoteRequestCount).toBe(descendants.length);
    expect(observation.remoteOrigins).toEqual(descendants.map(({ origin }) => origin).sort());
    for (const descendant of descendants) {
      const recursiveAttachIndex = harness.commands.findIndex(
        (command) =>
          command.method === 'Target.setAutoAttach' && command.sessionId === descendant.sessionId,
      );
      const enableIndex = harness.commands.findIndex(
        (command) =>
          command.method === 'Network.enable' && command.sessionId === descendant.sessionId,
      );
      const resumeIndex = harness.commands.findIndex(
        (command) =>
          command.method === 'Runtime.runIfWaitingForDebugger' &&
          command.sessionId === descendant.sessionId,
      );
      expect(recursiveAttachIndex).toBeGreaterThanOrEqual(0);
      expect(harness.commands[recursiveAttachIndex]?.params).toMatchObject({
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{ exclude: false }],
      });
      expect(enableIndex).toBeGreaterThan(recursiveAttachIndex);
      expect(resumeIndex).toBeGreaterThan(enableIndex);
    }
    recorder.close();
  });

  it('ignores worker traffic whose ancestry is rooted in another Webview', async () => {
    const harness = recorderHarness();
    const recorder = await harness.create();
    harness.attachTarget({
      parentSessionId: 'workbench-session',
      sessionId: 'other-webview-session',
      targetId: 'other-webview-target',
      type: 'iframe',
      url: `vscode-webview://${WEBVIEW_HOST}/index.html?extensionId=other.extension`,
    });
    harness.attachTarget({
      parentSessionId: 'other-webview-session',
      sessionId: 'unrelated-worker-session',
      targetId: 'unrelated-worker-target',
      type: 'worker',
      url: 'blob:unrelated-worker',
    });
    harness.socket.emitMessage({
      sessionId: 'unrelated-worker-session',
      method: 'Network.requestWillBeSent',
      params: { request: { url: 'https://unrelated-worker.example/escaped' } },
    });
    harness.emitOkfNavigation();
    harness.attachOkfTarget();
    await recorder.waitForOkfTarget();

    const observation = await recorder.snapshot('Only the selected OKF Webview target tree.');

    expect(observation.remoteRequestCount).toBe(0);
    expect(observation.remoteOrigins).toEqual([]);
    recorder.close();
  });

  it('fails closed when a selected worker descendant detaches', async () => {
    const harness = recorderHarness();
    const recorder = await harness.create();
    harness.emitOkfNavigation();
    harness.attachOkfTarget();
    await recorder.waitForOkfTarget();
    harness.attachTarget({
      parentSessionId: 'okf-session',
      sessionId: 'worker-session',
      targetId: 'worker-target',
      type: 'worker',
      url: 'blob:worker',
    });
    harness.socket.emitMessage({
      sessionId: 'okf-session',
      method: 'Target.detachedFromTarget',
      params: { sessionId: 'worker-session', targetId: 'worker-target' },
    });

    await expect(recorder.snapshot('Detached descendant must invalidate capture.')).rejects.toThrow(
      'Webview descendant CDP session detached',
    );
    recorder.close();
  });

  it('fails closed when Network.enable errors for a selected worker descendant', async () => {
    const harness = recorderHarness({ failNetworkEnableSessionIds: ['worker-session'] });
    const recorder = await harness.create();
    harness.emitOkfNavigation();
    harness.attachOkfTarget();
    await recorder.waitForOkfTarget();
    harness.attachTarget({
      parentSessionId: 'okf-session',
      sessionId: 'worker-session',
      targetId: 'worker-target',
      type: 'worker',
      url: 'blob:worker',
    });

    await expect(recorder.snapshot('Errored descendant must invalidate capture.')).rejects.toThrow(
      'CDP Network.enable failed',
    );
    recorder.close();
  });

  it('selects an initially blank Webview target from the frame-correlated parent navigation', async () => {
    const harness = recorderHarness();
    const recorder = await harness.create();
    harness.emitOkfNavigation();
    harness.attachOkfTarget({ url: '' });

    await expect(recorder.waitForOkfTarget()).resolves.toBeDefined();
    const observation = await recorder.snapshot('Frame-correlated initially blank Webview target.');
    expect(observation.webviewNavigationRequestCount).toBe(1);
    recorder.close();
  });

  it('retains a parent-observed remote redirect before an initially blank iframe becomes the OKF Webview', async () => {
    const harness = recorderHarness();
    const recorder = await harness.create();
    harness.socket.emitMessage({
      sessionId: 'workbench-session',
      method: 'Network.requestWillBeSent',
      params: {
        requestId: 'preselection-navigation',
        frameId: 'okf-target',
        request: { url: 'https://preselection.example/redirect' },
      },
    });
    harness.attachOkfTarget({ url: '' });
    harness.emitOkfNavigation({ requestId: 'preselection-navigation' });

    await recorder.waitForOkfTarget();
    const observation = await recorder.snapshot('Initially blank preselection request history.');

    expect(observation.webviewNavigationRequestCount).toBe(1);
    expect(observation.remoteRequestCount).toBe(1);
    expect(observation.remoteOrigins).toEqual(['https://preselection.example']);
    recorder.close();
  });

  it('classifies only the exact packaged origin and bounded opaque Webview navigation', () => {
    expect(
      classifyNetworkUrl(
        'https://file+.vscode-resource.vscode-cdn.net/extension/dist/webview/main.js',
      ),
    ).toEqual({
      kind: 'local',
      origin: 'https://file+.vscode-resource.vscode-cdn.net',
    });
    expect(classifyNetworkUrl(WEBVIEW_URL)).toEqual({
      kind: 'navigation',
      origin: `vscode-webview://${WEBVIEW_HOST}`,
    });
    expect(classifyNetworkUrl('vscode-webview://trusted-source/index.html')).toEqual({
      kind: 'other',
      origin: 'vscode-webview:',
    });
    expect(classifyNetworkUrl('https://evil.vscode-resource.vscode-cdn.net/main.js')).toEqual({
      kind: 'remote',
      origin: 'https://evil.vscode-resource.vscode-cdn.net',
    });
    expect(classifyNetworkUrl('wss://example.com/socket')).toEqual({
      kind: 'remote',
      origin: 'wss://example.com',
    });
  });
});

interface RecorderHarnessOptions {
  readonly commandTimeoutMs?: number;
  readonly failNetworkEnable?: boolean;
  readonly failNetworkEnableSessionIds?: readonly string[];
  readonly onCommand?: (command: SentCommand, socket: FakeSocket) => void;
  readonly openSocket?: boolean;
  readonly preexistingOkfTarget?: boolean;
  readonly preexistingRootTargets?: readonly {
    readonly targetId: string;
    readonly type: 'worker' | 'shared_worker' | 'service_worker';
    readonly url: string;
  }[];
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly workbenchAttachEventOrder?: 'after-response' | 'before-response' | 'omit';
}

interface SentCommand {
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId?: string;
}

function recorderHarness(options: RecorderHarnessOptions = {}) {
  const commands: SentCommand[] = [];
  const socket = new FakeSocket((command) => {
    commands.push(command);
    queueMicrotask(() => {
      options.onCommand?.(command, socket);
      if (command.method === 'Target.getTargets') {
        socket.respond(command.id, {
          targetInfos: [
            {
              targetId: 'workbench-target',
              type: 'page',
              url: 'vscode-file://vscode-app/out/vs/code/electron-sandbox/workbench/workbench.html',
            },
            ...(options.preexistingOkfTarget === true
              ? [
                  {
                    targetId: 'pre-existing-okf',
                    type: 'iframe',
                    url: WEBVIEW_URL,
                  },
                ]
              : []),
            ...(options.preexistingRootTargets ?? []),
          ],
        });
      } else if (command.method === 'Target.attachToTarget') {
        const attachedEvent = {
          method: 'Target.attachedToTarget',
          params: {
            sessionId: 'workbench-session',
            waitingForDebugger: false,
            targetInfo: {
              attached: true,
              targetId: 'workbench-target',
              type: 'page',
              url: 'vscode-file://vscode-app/out/vs/code/electron-sandbox/workbench/workbench.html',
            },
          },
        };
        if ((options.workbenchAttachEventOrder ?? 'before-response') === 'before-response') {
          socket.emitMessage(attachedEvent);
        }
        socket.respond(command.id, { sessionId: 'workbench-session' });
        if (options.workbenchAttachEventOrder === 'after-response') {
          queueMicrotask(() => socket.emitMessage(attachedEvent));
        }
      } else if (
        command.method === 'Network.enable' &&
        ((command.sessionId === 'okf-session' && options.failNetworkEnable === true) ||
          (command.sessionId !== undefined &&
            options.failNetworkEnableSessionIds?.includes(command.sessionId) === true))
      ) {
        socket.respondError(command.id, 'Network domain unavailable');
      } else {
        socket.respond(command.id, {});
      }
    });
  });
  return {
    commands,
    socket,
    async create(): Promise<WebviewNetworkRecorder> {
      return await createWebviewNetworkRecorder(9_222, {
        commandTimeoutMs: options.commandTimeoutMs ?? 100,
        targetTimeoutMs: 100,
        finalQuietPeriodMs: 0,
        fetchImplementation: async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({ webSocketDebuggerUrl: 'ws://browser.example/devtools' }),
          }) as Response,
        createSocket() {
          if (options.openSocket !== false) queueMicrotask(() => socket.open());
          return socket as unknown as WebSocket;
        },
        wait: options.wait ?? (() => Promise.resolve()),
      });
    },
    attachOkfTarget({ waitingForDebugger = true, url = WEBVIEW_URL } = {}) {
      this.attachTarget({
        parentSessionId: 'workbench-session',
        sessionId: 'okf-session',
        targetId: 'okf-target',
        type: 'iframe',
        url,
        waitingForDebugger,
      });
    },
    attachTarget({
      parentSessionId,
      sessionId,
      targetId,
      type,
      url,
      waitingForDebugger = true,
    }: {
      readonly parentSessionId?: string;
      readonly sessionId: string;
      readonly targetId: string;
      readonly type: string;
      readonly url: string;
      readonly waitingForDebugger?: boolean;
    }) {
      socket.emitMessage({
        sessionId: parentSessionId,
        method: 'Target.attachedToTarget',
        params: {
          sessionId,
          waitingForDebugger,
          targetInfo: {
            targetId,
            type,
            url,
          },
        },
      });
    },
    emitOkfNavigation({
      requestId = 'okf-navigation',
      frameId = 'okf-target',
    }: {
      readonly requestId?: string;
      readonly frameId?: string;
    } = {}) {
      socket.emitMessage({
        sessionId: 'workbench-session',
        method: 'Network.requestWillBeSent',
        params: {
          requestId,
          frameId,
          request: { url: WEBVIEW_URL },
        },
      });
    },
  };
}

async function readyRecorder(
  harness: ReturnType<typeof recorderHarness>,
): Promise<WebviewNetworkRecorder> {
  const recorder = await harness.create();
  harness.attachOkfTarget();
  await recorder.waitForOkfTarget();
  return recorder;
}

async function waitForSentCommand(
  harness: ReturnType<typeof recorderHarness>,
  predicate: (command: SentCommand) => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (harness.commands.some(predicate)) return;
    await Promise.resolve();
  }
  throw new Error('The expected fake CDP command was not sent.');
}

type FakeEvent = Readonly<{ data?: string }>;
type FakeListener = (event: FakeEvent) => void;

class FakeSocket {
  readonly #listeners = new Map<string, Set<FakeListener>>();
  readonly #onSend: (command: SentCommand) => void;
  readyState = 0;

  constructor(onSend: (command: SentCommand) => void) {
    this.#onSend = onSend;
  }

  addEventListener(type: string, listener: FakeListener): void {
    const listeners = this.#listeners.get(type) ?? new Set<FakeListener>();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: FakeListener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  send(value: string): void {
    this.#onSend(JSON.parse(value) as SentCommand);
  }

  close(): void {
    this.readyState = 3;
    this.emitSignal('close');
  }

  open(): void {
    this.readyState = 1;
    this.#emit('open', {});
  }

  respond(id: number, result: Record<string, unknown>): void {
    this.emitMessage({ id, result });
  }

  respondError(id: number, message: string): void {
    this.emitMessage({ id, error: { message } });
  }

  emitMessage(message: unknown): void {
    this.#emit('message', { data: JSON.stringify(message) });
  }

  emitSignal(type: 'close' | 'error'): void {
    this.#emit(type, {});
  }

  #emit(type: string, event: FakeEvent): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}
