import { describe, expect, it } from 'vitest';

import { SourceRangeIndex } from '../../../src/core/parser/source-range.js';

describe('SourceRangeIndex', () => {
  it('maps LF, CRLF, and CR line endings without counting CRLF twice', () => {
    const text = 'zero\n一\r\ntwo\rthree';
    const index = new SourceRangeIndex(text);

    expect(index.position(0)).toEqual({ offset: 0, line: 0, character: 0 });
    expect(index.position(text.indexOf('一'))).toEqual({
      offset: text.indexOf('一'),
      line: 1,
      character: 0,
    });
    expect(index.position(text.indexOf('two'))).toEqual({
      offset: text.indexOf('two'),
      line: 2,
      character: 0,
    });
    expect(index.position(text.indexOf('three'))).toEqual({
      offset: text.indexOf('three'),
      line: 3,
      character: 0,
    });
  });

  it('indexes a newline-dense maximum workspace document without boxed line records', () => {
    const newlineCount = 2 * 1024 * 1024;
    const text = '\n'.repeat(newlineCount);
    const index = new SourceRangeIndex(text);

    expect(index.position(text.length)).toEqual({
      offset: text.length,
      line: newlineCount,
      character: 0,
    });
  });
});
