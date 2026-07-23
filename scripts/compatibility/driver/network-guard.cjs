'use strict';

/* global module, require */
/* eslint-disable @typescript-eslint/no-require-imports -- The guard replaces exact CommonJS module export owners at runtime. */

const STATIC_NETWORK_GUARD_TARGETS = Object.freeze([
  Object.freeze({ moduleName: 'node:http', methods: Object.freeze(['get', 'request']) }),
  Object.freeze({ moduleName: 'node:https', methods: Object.freeze(['get', 'request']) }),
  Object.freeze({ moduleName: 'node:http2', methods: Object.freeze(['connect']) }),
  Object.freeze({
    moduleName: 'node:net',
    methods: Object.freeze(['connect', 'createConnection']),
  }),
  Object.freeze({ moduleName: 'node:tls', methods: Object.freeze(['connect']) }),
  Object.freeze({
    moduleName: 'node:dns',
    methods: Object.freeze(['lookup', 'resolve', 'resolve4', 'resolve6']),
  }),
  Object.freeze({ moduleName: 'node:dgram', methods: Object.freeze(['createSocket']) }),
]);

const STATIC_INTERCEPTED_METHODS = Object.freeze(
  STATIC_NETWORK_GUARD_TARGETS.flatMap(({ moduleName, methods }) =>
    methods.map((method) => `${moduleName}.${method}`),
  ),
);
const OPTIONAL_GLOBAL_INTERCEPTED_METHODS = Object.freeze([
  'globalThis.fetch',
  'globalThis.WebSocket',
]);
const NETWORK_GUARD_SCOPE = 'listed-commonjs-export-owner-properties-only';
const NETWORK_GUARD_LIFETIME = 'extension-host-exit';
const NETWORK_GUARD_LIMITATIONS =
  'This is JavaScript-hook evidence for the listed CommonJS builtin export-owner properties and ' +
  'available globals only. It is not OS-level isolation and does not observe ESM named bindings, ' +
  'cached references, prototype or raw bindings, dns.promises, child processes, editor-owned ' +
  'traffic, or Webview traffic. The persisted attempt list ends at report creation; the hooks ' +
  'remain installed to deny later tail calls until process exit.';
const NETWORK_NOT_OBSERVED_LIMITATIONS =
  'No Extension Host network hooks are installed in the post-uninstall phase; this phase verifies extension API absence only.';

function installNetworkGuard(attempts) {
  if (!Array.isArray(attempts)) {
    throw new TypeError('Network attempts must be recorded in an array.');
  }

  const restorations = [];
  const interceptedMethods = [];
  try {
    for (const { moduleName, methods } of STATIC_NETWORK_GUARD_TARGETS) {
      const owner = require(moduleName);
      for (const method of methods) {
        const original = owner[method];
        if (typeof original !== 'function') {
          throw new Error(
            `Cannot install network guard for missing method ${moduleName}.${method}.`,
          );
        }
        owner[method] = () => {
          attempts.push(`${moduleName}.${method}`);
          throw new Error(
            `Outbound network access is denied by the acceptance driver: ${moduleName}.${method}`,
          );
        };
        interceptedMethods.push(`${moduleName}.${method}`);
        restorations.push(() => {
          owner[method] = original;
        });
      }
    }

    const originalFetch = globalThis.fetch;
    if (typeof originalFetch === 'function') {
      globalThis.fetch = () => {
        attempts.push('globalThis.fetch');
        return Promise.reject(
          new Error('Outbound network access is denied by the acceptance driver: fetch'),
        );
      };
      interceptedMethods.push('globalThis.fetch');
      restorations.push(() => {
        globalThis.fetch = originalFetch;
      });
    }

    const OriginalWebSocket = globalThis.WebSocket;
    if (typeof OriginalWebSocket === 'function') {
      globalThis.WebSocket = function DeniedWebSocket() {
        attempts.push('globalThis.WebSocket');
        throw new Error('Outbound network access is denied by the acceptance driver: WebSocket');
      };
      interceptedMethods.push('globalThis.WebSocket');
      restorations.push(() => {
        globalThis.WebSocket = OriginalWebSocket;
      });
    }
  } catch (error) {
    for (const restore of restorations.reverse()) restore();
    throw error;
  }

  let restored = false;
  return Object.freeze({
    interceptedMethods: Object.freeze([...interceptedMethods]),
    restore: () => {
      if (restored) return;
      restored = true;
      for (const restore of restorations.reverse()) restore();
    },
  });
}

function activeNetworkObservation(interceptedMethods, quiescenceMs) {
  return {
    status: 'installed',
    scope: NETWORK_GUARD_SCOPE,
    interceptedMethods: [...interceptedMethods],
    limitations: NETWORK_GUARD_LIMITATIONS,
    lifetime: NETWORK_GUARD_LIFETIME,
    guardRestored: false,
    quiescenceMs,
    result: 'pending',
  };
}

function postUninstallNetworkObservation() {
  return {
    status: 'not-installed',
    scope: 'none',
    interceptedMethods: [],
    limitations: NETWORK_NOT_OBSERVED_LIMITATIONS,
    lifetime: null,
    guardRestored: null,
    quiescenceMs: null,
    result: 'not-observed',
  };
}

function assertActiveNetworkEvidence(report, expectedQuiescenceMs) {
  if (!Array.isArray(report?.networkAttempts)) {
    throw new Error('Active packaged evidence must contain a networkAttempts array.');
  }
  if (report.networkAttempts.length > 0) {
    throw new Error(
      `Packaged activation attempted guarded network access: ${report.networkAttempts.join(', ')}.`,
    );
  }
  if (report.completion?.guardedQuiescenceMs !== expectedQuiescenceMs) {
    throw new Error('Active packaged evidence has an invalid guarded quiescence interval.');
  }

  const observation = report.networkObservation;
  if (observation?.status !== 'installed') {
    throw new Error('Active packaged evidence did not install the Extension Host network hooks.');
  }
  if (observation.scope !== NETWORK_GUARD_SCOPE) {
    throw new Error('Active packaged evidence reported an unsupported network-observation scope.');
  }
  assertInstalledInventory(observation.interceptedMethods);
  if (
    observation.limitations !== NETWORK_GUARD_LIMITATIONS ||
    observation.lifetime !== NETWORK_GUARD_LIFETIME ||
    observation.guardRestored !== false ||
    observation.quiescenceMs !== expectedQuiescenceMs ||
    observation.result !== 'zero-attempts-observed'
  ) {
    throw new Error('Active packaged evidence has incomplete network-observation metadata.');
  }
}

function assertPostUninstallNetworkEvidence(report) {
  if (report?.networkAttempts !== null) {
    throw new Error('Post-uninstall evidence must mark network attempts as not observed.');
  }
  if (report?.completion?.guardedQuiescenceMs !== null) {
    throw new Error('Post-uninstall evidence must not report guarded quiescence.');
  }

  const observation = report.networkObservation;
  if (
    observation?.status !== 'not-installed' ||
    observation.scope !== 'none' ||
    !Array.isArray(observation.interceptedMethods) ||
    observation.interceptedMethods.length !== 0 ||
    observation.limitations !== NETWORK_NOT_OBSERVED_LIMITATIONS ||
    observation.lifetime !== null ||
    observation.guardRestored !== null ||
    observation.quiescenceMs !== null ||
    observation.result !== 'not-observed'
  ) {
    throw new Error(
      'Post-uninstall evidence did not declare its network observer as not installed.',
    );
  }
}

function assertInstalledInventory(value) {
  if (!Array.isArray(value)) {
    throw new Error('Network observation did not provide an intercepted-method inventory.');
  }
  const required = value.slice(0, STATIC_INTERCEPTED_METHODS.length);
  if (JSON.stringify(required) !== JSON.stringify(STATIC_INTERCEPTED_METHODS)) {
    throw new Error(
      'Network observation did not install every required CommonJS export-owner hook.',
    );
  }
  const optional = value.slice(STATIC_INTERCEPTED_METHODS.length);
  const validOptionalInventories = [
    [],
    ['globalThis.fetch'],
    ['globalThis.WebSocket'],
    [...OPTIONAL_GLOBAL_INTERCEPTED_METHODS],
  ];
  if (
    !validOptionalInventories.some(
      (candidate) => JSON.stringify(candidate) === JSON.stringify(optional),
    )
  ) {
    throw new Error('Network observation reported an unknown or duplicate intercepted method.');
  }
}

module.exports = {
  NETWORK_GUARD_LIFETIME,
  NETWORK_GUARD_LIMITATIONS,
  NETWORK_GUARD_SCOPE,
  NETWORK_NOT_OBSERVED_LIMITATIONS,
  OPTIONAL_GLOBAL_INTERCEPTED_METHODS,
  STATIC_INTERCEPTED_METHODS,
  activeNetworkObservation,
  assertActiveNetworkEvidence,
  assertPostUninstallNetworkEvidence,
  installNetworkGuard,
  postUninstallNetworkObservation,
};
