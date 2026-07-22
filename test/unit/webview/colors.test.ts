import { describe, expect, it } from 'vitest';
import { colorForType, fnv1a, TYPE_COLOR_PALETTE } from '../../../src/webview/state/colors.js';
import { displayConceptType, MISSING_TYPE_LABEL } from '../../../src/webview/state/labels.js';

describe('stable concept type colors', () => {
  it('implements FNV-1a over UTF-8', () => {
    expect(fnv1a('hello')).toBe(0x4f_9f_2c_ab);
  });

  it('maps the same arbitrary type to the same checked-in palette entry', () => {
    const type = '実験-result';
    const color = colorForType(type);
    expect(colorForType(type)).toBe(color);
    expect(TYPE_COLOR_PALETTE).toContain(color);
  });

  it('does not collapse type case into a closed registry', () => {
    expect(fnv1a('Note')).not.toBe(fnv1a('note'));
  });

  it('gives an empty diagnostic type a stable color and presentation-only label', () => {
    expect(colorForType('')).toBe(colorForType(''));
    expect(TYPE_COLOR_PALETTE).toContain(colorForType(''));
    expect(displayConceptType('')).toBe(MISSING_TYPE_LABEL);
    expect(displayConceptType('custom-type')).toBe('custom-type');
  });
});
