import { describe, expect, it } from 'vitest';
import { matchesSearch, normalizeSearchValue } from '../../../src/webview/state/search.js';
import { graphNode } from './fixtures.js';

describe('concept search', () => {
  const node = graphNode({
    id: '研究/AI-agent',
    title: 'ＡＩエージェント設計',
    tags: ['Knowledge-Graph', '調査'],
  });

  it('uses Unicode NFKC and locale-independent lower-case matching', () => {
    expect(normalizeSearchValue('ＡＩ-Agent')).toBe('ai-agent');
    expect(matchesSearch(node, 'aiエージェント')).toBe(true);
    expect(matchesSearch(node, 'KNOWLEDGE-graph')).toBe(true);
  });

  it('searches ID, title, and tags and composes whitespace-separated terms', () => {
    expect(matchesSearch(node, '研究')).toBe(true);
    expect(matchesSearch(node, '設計')).toBe(true);
    expect(matchesSearch(node, '調査')).toBe(true);
    expect(matchesSearch(node, '研究 調査')).toBe(true);
    expect(matchesSearch(node, '研究 missing')).toBe(false);
  });

  it('does not expand the FR-053 search surface to resource or timestamp metadata', () => {
    expect(matchesSearch(node, 'urn:okf:alpha')).toBe(false);
    expect(matchesSearch(node, '2026-07-22')).toBe(false);
  });

  it('treats an empty query as a match', () => {
    expect(matchesSearch(node, '  ')).toBe(true);
  });
});
