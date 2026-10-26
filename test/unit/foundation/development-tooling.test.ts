import { createRequire } from 'node:module';

import { ClientSecretCredential } from '@azure/identity';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const serialize = require('serialize-javascript') as (
  value: unknown,
  options: { space: number },
) => string;

describe('development dependency security overrides', () => {
  test('Azure Identity can acquire a token through the overridden MSAL without network access', async () => {
    const requests: { method: string; url: string }[] = [];
    const credential = new ClientSecretCredential(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      'test-only-secret',
      {
        disableInstanceDiscovery: true,
        httpClient: {
          async sendRequest(request) {
            requests.push({ method: request.method, url: request.url });
            return {
              request,
              status: 200,
              headers: {
                get: () => undefined,
                has: () => false,
                set: () => undefined,
                delete: () => undefined,
                toJSON: () => ({}),
                *[Symbol.iterator]() {},
              },
              bodyAsText: JSON.stringify({
                access_token: 'test-only-offline-token',
                token_type: 'Bearer',
                expires_in: 3600,
              }),
            };
          },
        },
      },
    );

    const token = await credential.getToken('https://management.azure.com/.default');

    expect(token.token).toBe('test-only-offline-token');
    expect(requests).toEqual([
      {
        method: 'POST',
        url: expect.stringMatching(
          /^https:\/\/login\.microsoftonline\.com\/00000000-0000-0000-0000-000000000001\/oauth2\/v2\.0\/token\?/u,
        ),
      },
    ]);
  });

  test('serialization escapes a script terminator at the end of a function source', () => {
    function source() {}
    source.toString = () => 'function source(){}//</script';

    expect(serialize({ nested: { source } }, { space: 2 })).not.toMatch(/<\/script/iu);
    expect(serialize({ nested: { source } }, { space: 2 })).toContain('\\u003C');
  });
});
