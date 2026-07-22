import { describe, expect, it } from 'vitest';

import { parseBundle } from '../../../src/core/parser/index.js';
import type { BundleDocumentInput } from '../../../src/core/parser/index.js';

const rootUri = 'memfs:/knowledge';

function document(bundlePath: string, content: string): BundleDocumentInput {
  return {
    uri: `${rootUri}/${bundlePath.replaceAll('\\', '/')}`,
    bundlePath,
    content,
  };
}

function concept(body: string): string {
  return `---\ntype: reference\ntitle: Test\n---\n${body}`;
}

describe('Markdown link extraction and resolution', () => {
  it('resolves Unicode, spaces, root/document paths, query/fragment, and every exclusion category', () => {
    const body = [
      '[Nested target](./nested/target.md?mode=full#section)',
      '[Root Unicode](/shared/%E6%97%A5%E6%9C%AC%20%E8%AA%9E.md)',
      '[External](https://example.test/reference?q=1#top)',
      '[Missing](./missing.md)',
      '[Escape](../../outside.md)',
      '[Encoded escape](/%2e%2e/secret.md)',
      '[Encoded separator escape](%2F..%2Fsecret.md)',
      '[Local heading](#details)',
      '[Directory](./nested/)',
      '[Malformed percent](./bad%ZZ.md)',
      '[Not Markdown](./asset.json)',
      '',
    ].join('\n');
    const bundle = parseBundle({
      rootUri,
      revision: 9,
      documents: [
        document('topics\\source.md', concept(body)),
        document('topics\\nested\\target.md', concept('# Target\n')),
        document('topics\\nested\\index.md', '# Nested\n'),
        document('shared\\日本 語.md', concept('# 日本語\n')),
      ],
    });

    const source = bundle.concepts.find(({ id }) => id === 'topics/source');
    expect(source).toBeDefined();
    expect(source?.links.map(({ classification }) => classification)).toEqual([
      'internal',
      'internal',
      'external',
      'broken',
      'out-of-bundle',
      'out-of-bundle',
      'out-of-bundle',
      'fragment',
      'directory',
      'invalid',
      'invalid',
    ]);

    expect(source?.links[0]).toMatchObject({
      label: 'Nested target',
      targetId: 'topics/nested/target',
      query: 'mode=full',
      fragment: 'section',
    });
    expect(source?.links[1]).toMatchObject({
      rawTarget: '/shared/%E6%97%A5%E6%9C%AC%20%E8%AA%9E.md',
      targetId: 'shared/日本 語',
    });
    expect(source?.links[2]).toMatchObject({ query: 'q=1', fragment: 'top' });

    for (const link of source?.links ?? []) {
      expect(concept(body).slice(link.range.start.offset, link.range.end.offset)).toContain(
        `[${link.label}]`,
      );
    }
  });

  it('extracts full, collapsed, and shortcut references at occurrence ranges', () => {
    const body = [
      '[Full reference][target]',
      '[Collapsed][]',
      '[shortcut]',
      '',
      '[target]: ./target.md',
      '[collapsed]: ./target.md#collapsed',
      '[shortcut]: ./target.md?from=shortcut',
      '',
    ].join('\n');
    const bundle = parseBundle({
      rootUri,
      revision: 1,
      documents: [
        document('source.md', concept(body)),
        document('target.md', concept('# Target\n')),
      ],
    });

    const source = bundle.concepts.find(({ id }) => id === 'source');
    expect(
      source?.links.map(({ label, targetId, fragment, query }) => ({
        label,
        targetId,
        fragment,
        query,
      })),
    ).toEqual([
      { label: 'Full reference', targetId: 'target', fragment: undefined, query: undefined },
      { label: 'Collapsed', targetId: 'target', fragment: 'collapsed', query: undefined },
      { label: 'shortcut', targetId: 'target', fragment: undefined, query: 'from=shortcut' },
    ]);
    expect(source?.links[0]?.range.start.line).toBe(4);
    expect(source?.links[2]?.range.start.line).toBe(6);
  });

  it('keeps one stable directed occurrence per Markdown link and ignores images', () => {
    const body = [
      '[First](./target.md)',
      '![Preview](./target.md)',
      '[Second **formatted**](./target.md)',
      '[First](./target.md)',
      '',
    ].join('\n');
    const bundle = parseBundle({
      rootUri,
      revision: 1,
      documents: [
        document('source.md', concept(body)),
        document('target.md', concept('# Target\n')),
      ],
    });

    const links = bundle.concepts.find(({ id }) => id === 'source')?.links ?? [];
    expect(links).toHaveLength(3);
    expect(links.map(({ label }) => label)).toEqual(['First', 'Second formatted', 'First']);
    expect(
      links.every(({ sourceId, targetId }) => sourceId === 'source' && targetId === 'target'),
    ).toBe(true);
    expect(links.map(({ range }) => range.start.offset)).toEqual(
      [...links].map(({ range }) => range.start.offset).sort((left, right) => left - right),
    );
  });
});
