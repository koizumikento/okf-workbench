import { describe, expect, it } from 'vitest';

import {
  matchesSha256,
  normalizeSha256,
  sha256Content,
} from '../../../src/extension/workspace/contentHash.js';

describe('SHA-256 content identity', () => {
  it('returns a stable, qualified lowercase hash', () => {
    expect(sha256Content(new TextEncoder().encode('OKF\n'))).toBe(
      'sha256:6268e4b4611fff5030e8deac40a98a6d574b7416dd6d820d4afc8456c22e9633',
    );
  });

  it('matches qualified and bare hexadecimal expectations', () => {
    const content = new TextEncoder().encode('current');
    const qualified = sha256Content(content);
    const bare = qualified.slice('sha256:'.length).toUpperCase();

    expect(matchesSha256(content, qualified)).toBe(true);
    expect(matchesSha256(content, bare)).toBe(true);
    expect(normalizeSha256('not-a-hash')).toBeUndefined();
    expect(matchesSha256(content, 'not-a-hash')).toBe(false);
  });
});
