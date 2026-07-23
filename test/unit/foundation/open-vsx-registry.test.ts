import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  inspectOpenVsxRegistry,
  writeOpenVsxRegistryEvidence,
} from '../../../scripts/check-open-vsx-registry.mjs';

const temporaryDirectories = new Set<string>();

type RegistryResponseKind = 'namespace' | 'extension' | 'version';

interface FreshnessHeaders {
  readonly age?: string | null;
  readonly date?: string | null;
}

function jsonResponse(
  status: number,
  body: unknown,
  freshnessHeaders: FreshnessHeaders = {},
): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  const age = freshnessHeaders.age === undefined ? '0' : freshnessHeaders.age;
  const date =
    freshnessHeaders.date === undefined ? 'Wed, 22 Jul 2026 08:00:00 GMT' : freshnessHeaders.date;
  if (age !== null) {
    headers.set('age', age);
  }
  if (date !== null) {
    headers.set('date', date);
  }
  return new Response(JSON.stringify(body), {
    headers,
    status,
  });
}

function successfulFetch(
  extensionExists = false,
  freshnessByResponse: Partial<Record<RegistryResponseKind, FreshnessHeaders>> = {},
): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/straydog')) {
      return jsonResponse(
        200,
        {
          access: 'restricted',
          extensions: { 'shosei-vscode': 'https://open-vsx.org/api/straydog/shosei-vscode' },
          name: 'straydog',
          verified: true,
        },
        freshnessByResponse.namespace,
      );
    }
    if (url.endsWith('/api/straydog/okf-workbench/0.1.0')) {
      return jsonResponse(
        404,
        { error: 'Extension version not found' },
        freshnessByResponse.version,
      );
    }
    if (url.endsWith('/api/straydog/okf-workbench')) {
      return extensionExists
        ? jsonResponse(
            200,
            {
              name: 'okf-workbench',
              namespace: 'straydog',
              version: '0.0.9',
            },
            freshnessByResponse.extension,
          )
        : jsonResponse(404, { error: 'Extension not found' }, freshnessByResponse.extension);
    }
    return jsonResponse(500, { error: `Unexpected URL ${url}` });
  }) as typeof fetch;
}

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true })),
  );
  temporaryDirectories.clear();
  vi.restoreAllMocks();
});

describe('Open VSX registry preflight', () => {
  test.each([false, true])(
    'accepts an available target version when extensionExists=%s',
    async (extensionExists) => {
      const evidence = await inspectOpenVsxRegistry({
        extension: 'okf-workbench',
        fetchImplementation: successfulFetch(extensionExists),
        namespace: 'straydog',
        now: () => new Date('2026-07-22T08:00:00.000Z'),
        version: '0.1.0',
      });

      expect(evidence).toEqual({
        schemaVersion: 1,
        checkedAt: '2026-07-22T08:00:00.000Z',
        registryUrl: 'https://open-vsx.org',
        namespace: { access: 'restricted', name: 'straydog', verified: true },
        extension: {
          exists: extensionExists,
          id: 'straydog.okf-workbench',
          targetVersion: '0.1.0',
          targetVersionAvailable: true,
        },
        freshness: {
          requestCacheMode: 'no-store',
          responses: {
            namespace: {
              ageSeconds: 0,
              date: 'Wed, 22 Jul 2026 08:00:00 GMT',
              effectiveAgeSeconds: 0,
              validatedAt: '2026-07-22T08:00:00.000Z',
              validationSource: 'age-header',
            },
            extension: {
              ageSeconds: 0,
              date: 'Wed, 22 Jul 2026 08:00:00 GMT',
              effectiveAgeSeconds: 0,
              validatedAt: '2026-07-22T08:00:00.000Z',
              validationSource: 'age-header',
            },
            version: {
              ageSeconds: 0,
              date: 'Wed, 22 Jul 2026 08:00:00 GMT',
              effectiveAgeSeconds: 0,
              validatedAt: '2026-07-22T08:00:00.000Z',
              validationSource: 'age-header',
            },
          },
        },
      });

      const fetchImplementation = successfulFetch(extensionExists);
      await inspectOpenVsxRegistry({
        extension: 'okf-workbench',
        fetchImplementation,
        namespace: 'straydog',
        version: '0.1.0',
      });
      for (const [, init] of vi.mocked(fetchImplementation).mock.calls) {
        expect(init).toMatchObject({
          cache: 'no-store',
          headers: {
            Accept: 'application/json',
            'Cache-Control': 'no-cache, no-store',
            Pragma: 'no-cache',
          },
          redirect: 'error',
        });
      }
    },
  );

  test('accepts the inclusive 30-second freshness boundary from Age or Date', async () => {
    const ageEvidence = await inspectOpenVsxRegistry({
      extension: 'okf-workbench',
      fetchImplementation: successfulFetch(false, {
        extension: { age: '30', date: 'Wed, 22 Jul 2026 08:00:00 GMT' },
        namespace: { age: '30', date: 'Wed, 22 Jul 2026 08:00:00 GMT' },
        version: { age: '30', date: 'Wed, 22 Jul 2026 08:00:00 GMT' },
      }),
      namespace: 'straydog',
      now: () => new Date('2026-07-22T08:00:00.000Z'),
      version: '0.1.0',
    });
    expect(ageEvidence.freshness.responses).toEqual({
      namespace: {
        ageSeconds: 30,
        date: 'Wed, 22 Jul 2026 08:00:00 GMT',
        effectiveAgeSeconds: 30,
        validatedAt: '2026-07-22T08:00:00.000Z',
        validationSource: 'age-header',
      },
      extension: {
        ageSeconds: 30,
        date: 'Wed, 22 Jul 2026 08:00:00 GMT',
        effectiveAgeSeconds: 30,
        validatedAt: '2026-07-22T08:00:00.000Z',
        validationSource: 'age-header',
      },
      version: {
        ageSeconds: 30,
        date: 'Wed, 22 Jul 2026 08:00:00 GMT',
        effectiveAgeSeconds: 30,
        validatedAt: '2026-07-22T08:00:00.000Z',
        validationSource: 'age-header',
      },
    });

    const dateEvidence = await inspectOpenVsxRegistry({
      extension: 'okf-workbench',
      fetchImplementation: successfulFetch(false, {
        extension: { age: null, date: 'Wed, 22 Jul 2026 07:59:30 GMT' },
        namespace: { age: null, date: 'Wed, 22 Jul 2026 07:59:30 GMT' },
        version: { age: null, date: 'Wed, 22 Jul 2026 07:59:30 GMT' },
      }),
      namespace: 'straydog',
      now: () => new Date('2026-07-22T08:00:00.000Z'),
      version: '0.1.0',
    });
    for (const freshness of Object.values(dateEvidence.freshness.responses)) {
      expect(freshness).toEqual({
        ageSeconds: null,
        date: 'Wed, 22 Jul 2026 07:59:30 GMT',
        effectiveAgeSeconds: 30,
        validatedAt: '2026-07-22T08:00:00.000Z',
        validationSource: 'date-header',
      });
    }
  });

  test.each(['namespace', 'extension', 'version'] as const)(
    'rejects missing, invalid, stale, and future Date fallback on the %s response',
    async (responseKind) => {
      const cases: ReadonlyArray<readonly [FreshnessHeaders, RegExp]> = [
        [{ age: null, date: null }, /omitted the response Date header/u],
        [{ age: null, date: 'Wed, 22 Jul 2026 08:00:00 UTC' }, /invalid Date header/u],
        [{ age: null, date: 'Wed, 22 Jul 2026 07:59:29 GMT' }, /stale response Date/u],
        [{ age: null, date: 'Wed, 22 Jul 2026 08:00:01 GMT' }, /future Date header/u],
      ];

      for (const [freshnessHeaders, expected] of cases) {
        await expect(
          inspectOpenVsxRegistry({
            extension: 'okf-workbench',
            fetchImplementation: successfulFetch(false, {
              [responseKind]: freshnessHeaders,
            }),
            namespace: 'straydog',
            now: () => new Date('2026-07-22T08:00:00.000Z'),
            version: '0.1.0',
          }),
        ).rejects.toThrow(expected);
      }
    },
  );

  test.each(['namespace', 'extension', 'version'] as const)(
    'rejects a missing Date on the %s response even when Age is present',
    async (responseKind) => {
      await expect(
        inspectOpenVsxRegistry({
          extension: 'okf-workbench',
          fetchImplementation: successfulFetch(false, {
            [responseKind]: { age: '0', date: null },
          }),
          namespace: 'straydog',
          now: () => new Date('2026-07-22T08:00:00.000Z'),
          version: '0.1.0',
        }),
      ).rejects.toThrow(/omitted the response Date header/u);
    },
  );

  test('strictly validates a present Date header even when Age is authoritative', async () => {
    await expect(
      inspectOpenVsxRegistry({
        extension: 'okf-workbench',
        fetchImplementation: successfulFetch(false, {
          namespace: { age: '0', date: 'Thu, 22 Jul 2026 08:00:00 GMT' },
        }),
        namespace: 'straydog',
        now: () => new Date('2026-07-22T08:00:00.000Z'),
        version: '0.1.0',
      }),
    ).rejects.toThrow(/invalid Date header/u);
  });

  test('rejects a Date fallback just outside the inclusive freshness boundary', async () => {
    await expect(
      inspectOpenVsxRegistry({
        extension: 'okf-workbench',
        fetchImplementation: successfulFetch(false, {
          namespace: { age: null, date: 'Wed, 22 Jul 2026 07:59:30 GMT' },
        }),
        namespace: 'straydog',
        now: () => new Date('2026-07-22T08:00:00.001Z'),
        version: '0.1.0',
      }),
    ).rejects.toThrow(/30\.001 seconds old/u);
  });

  test.each([
    ['missing namespace', [jsonResponse(404, { error: 'Namespace not found' })], /unavailable/u],
    [
      'unverified namespace',
      [jsonResponse(200, { access: 'restricted', name: 'straydog', verified: false })],
      /not verified/u,
    ],
    [
      'unrestricted namespace',
      [jsonResponse(200, { access: 'unrestricted', name: 'straydog', verified: true })],
      /expected restricted/u,
    ],
  ])('rejects %s', async (_label, responses, expected) => {
    const fetchImplementation = vi.fn(async () => responses[0]) as typeof fetch;
    await expect(
      inspectOpenVsxRegistry({
        extension: 'okf-workbench',
        fetchImplementation,
        namespace: 'straydog',
        version: '0.1.0',
      }),
    ).rejects.toThrow(expected);
  });

  test('rejects an occupied target version and malformed registry responses', async () => {
    const occupiedFetch = successfulFetch();
    vi.mocked(occupiedFetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/0.1.0')) {
        return jsonResponse(200, {
          name: 'okf-workbench',
          namespace: 'straydog',
          version: '0.1.0',
        });
      }
      return successfulFetch()(input);
    });
    await expect(
      inspectOpenVsxRegistry({
        extension: 'okf-workbench',
        fetchImplementation: occupiedFetch,
        namespace: 'straydog',
        version: '0.1.0',
      }),
    ).rejects.toThrow(/already exists/u);

    const malformedFetch = vi.fn(async () => {
      return new Response('not json', {
        headers: {
          age: '0',
          date: 'Wed, 22 Jul 2026 08:00:00 GMT',
        },
        status: 200,
      });
    }) as typeof fetch;
    await expect(
      inspectOpenVsxRegistry({
        extension: 'okf-workbench',
        fetchImplementation: malformedFetch,
        namespace: 'straydog',
        version: '0.1.0',
      }),
    ).rejects.toThrow(/non-JSON/u);
  });

  test('rejects unsafe path segments, non-origin registry URLs, and stale cached responses', async () => {
    for (const namespace of ['.', '..', ' straydog', 'straydog ', 'stray/dog', 'stray\\dog']) {
      await expect(
        inspectOpenVsxRegistry({
          extension: 'okf-workbench',
          fetchImplementation: successfulFetch(),
          namespace,
          version: '0.1.0',
        }),
      ).rejects.toThrow(/path segment/u);
    }

    await expect(
      inspectOpenVsxRegistry({
        extension: 'okf-workbench',
        fetchImplementation: successfulFetch(),
        namespace: 'straydog',
        registryUrl: 'http://open-vsx.org/api',
        version: '0.1.0',
      }),
    ).rejects.toThrow(/HTTPS origin/u);

    const staleFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ name: 'straydog', verified: true }), {
        headers: {
          age: '31',
          'content-type': 'application/json',
          date: 'Wed, 22 Jul 2026 08:00:00 GMT',
        },
        status: 200,
      });
    }) as typeof fetch;
    await expect(
      inspectOpenVsxRegistry({
        extension: 'okf-workbench',
        fetchImplementation: staleFetch,
        namespace: 'straydog',
        version: '0.1.0',
      }),
    ).rejects.toThrow(/stale cached response/u);
  });

  test('writes auditable JSON evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'okf-open-vsx-'));
    temporaryDirectories.add(directory);
    const evidence = await inspectOpenVsxRegistry({
      extension: 'okf-workbench',
      fetchImplementation: successfulFetch(),
      namespace: 'straydog',
      now: () => new Date('2026-07-22T07:52:42.000Z'),
      version: '0.1.0',
    });
    const path = join(directory, 'nested', 'registry.json');

    await writeOpenVsxRegistryEvidence(path, evidence);

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(evidence);
  });
});
