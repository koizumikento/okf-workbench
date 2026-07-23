import { createRequire } from 'node:module';

import { describe, expect, test } from 'vitest';

import {
  activeNetworkObservation,
  assertActiveNetworkEvidence,
  assertPostUninstallNetworkEvidence,
  installNetworkGuard,
  postUninstallNetworkObservation,
  STATIC_INTERCEPTED_METHODS,
} from '../../../scripts/compatibility/driver/network-guard.cjs';

interface MutableFunctionOwner {
  [method: string]: () => unknown;
}

const compatibilityRequire = createRequire(import.meta.url);

describe('packaged Extension Host network evidence', () => {
  test('patches exactly the declared exported methods and available globals', async () => {
    const attempts: string[] = [];
    const originals = STATIC_INTERCEPTED_METHODS.map((label) => {
      const separator = label.lastIndexOf('.');
      const moduleName = label.slice(0, separator);
      const method = label.slice(separator + 1);
      const owner = compatibilityRequire(moduleName) as MutableFunctionOwner;
      return { label, method, original: owner[method], owner };
    });
    const originalFetch = globalThis.fetch;
    const OriginalWebSocket = globalThis.WebSocket;
    const guard = installNetworkGuard(attempts);

    try {
      const expectedInventory = [
        ...STATIC_INTERCEPTED_METHODS,
        ...(typeof originalFetch === 'function' ? ['globalThis.fetch'] : []),
        ...(typeof OriginalWebSocket === 'function' ? ['globalThis.WebSocket'] : []),
      ];
      expect(guard.interceptedMethods).toEqual(expectedInventory);

      for (const { label, method, original, owner } of originals) {
        expect(owner[method]).not.toBe(original);
        expect(() => owner[method]?.()).toThrow(label);
      }
      if (typeof originalFetch === 'function') {
        await expect(globalThis.fetch('https://example.invalid')).rejects.toThrow(
          'acceptance driver: fetch',
        );
      }
      if (typeof OriginalWebSocket === 'function') {
        expect(() => new globalThis.WebSocket('wss://example.invalid')).toThrow(
          'acceptance driver: WebSocket',
        );
      }
      expect(attempts).toEqual(expectedInventory);
    } finally {
      guard.restore();
    }

    for (const { method, original, owner } of originals) {
      expect(owner[method]).toBe(original);
    }
    expect(globalThis.fetch).toBe(originalFetch);
    expect(globalThis.WebSocket).toBe(OriginalWebSocket);
  });

  test('accepts complete active evidence and rejects missing attempt arrays or inventory', () => {
    const observation = activeNetworkObservation(STATIC_INTERCEPTED_METHODS, 500);
    observation.result = 'zero-attempts-observed';
    const report = {
      networkAttempts: [],
      networkObservation: observation,
      completion: { guardedQuiescenceMs: 500 },
    };

    expect(() => assertActiveNetworkEvidence(report, 500)).not.toThrow();
    expect(() => assertActiveNetworkEvidence({ ...report, networkAttempts: null }, 500)).toThrow(
      'networkAttempts array',
    );
    expect(() =>
      assertActiveNetworkEvidence(
        {
          ...report,
          networkObservation: { ...observation, interceptedMethods: [] },
        },
        500,
      ),
    ).toThrow('required CommonJS export-owner hook');
  });

  test('distinguishes post-uninstall absence verification from network observation', () => {
    const report = {
      networkAttempts: null,
      networkObservation: postUninstallNetworkObservation(),
      completion: { guardedQuiescenceMs: null },
    };

    expect(() => assertPostUninstallNetworkEvidence(report)).not.toThrow();
    expect(() => assertPostUninstallNetworkEvidence({ ...report, networkAttempts: [] })).toThrow(
      'not observed',
    );
    expect(() =>
      assertPostUninstallNetworkEvidence({
        ...report,
        networkObservation: { ...report.networkObservation, status: 'installed' },
      }),
    ).toThrow('observer as not installed');
  });
});
