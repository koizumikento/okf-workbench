import { describe, expect, it } from 'vitest';

import { hasUnpairedUtf16Surrogate } from '../../../src/core/model/index.js';

describe('shared text bounds', () => {
  it('detects every unpaired surrogate position, including a trailing high surrogate', () => {
    expect(hasUnpairedUtf16Surrogate(`tail${String.fromCharCode(0xd800)}`)).toBe(true);
    expect(hasUnpairedUtf16Surrogate(`middle${String.fromCharCode(0xd800)}text`)).toBe(true);
    expect(hasUnpairedUtf16Surrogate(`low${String.fromCharCode(0xdc00)}`)).toBe(true);
  });

  it('accepts a complete surrogate pair', () => {
    expect(hasUnpairedUtf16Surrogate('valid \u{1F680} pair')).toBe(false);
  });
});
