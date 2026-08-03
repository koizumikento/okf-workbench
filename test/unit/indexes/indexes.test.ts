import { describe, expect, it } from 'vitest';

import type { OperationResult } from '../../../src/core/model/index.js';
import {
  INDEX_END_MARKER,
  INDEX_START_MARKER,
  planIndexes,
  planProviderIndexes,
  renderManagedIndexRegion,
  type IndexPlan,
} from '../../../src/core/indexes/index.js';

function valueOf<T>(result: OperationResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.problems.map((problem) => problem.message).join('\n'));
  }
  return result.value;
}

describe('managed index rendering', () => {
  it('orders concepts before directories and escapes labels and URL segments', () => {
    const region = renderManagedIndexRegion([
      {
        kind: 'concept',
        filename: '日本 語[1].md',
        title: 'Title [one]',
        description: 'Line one\nline two',
      },
      { kind: 'concept', filename: 'fallback-name.md' },
      { kind: 'directory', name: '資料 集' },
    ]);

    expect(region).toBe(
      `${INDEX_START_MARKER}\n` +
        '## Contents\n\n' +
        '- [Title \\[one\\]](./%E6%97%A5%E6%9C%AC%20%E8%AA%9E%5B1%5D.md) - Line one line two\n' +
        '- [fallback-name](./fallback-name.md)\n' +
        '- [資料 集](./%E8%B3%87%E6%96%99%20%E9%9B%86/)\n' +
        `${INDEX_END_MARKER}\n`,
    );
  });
});

describe('index planning', () => {
  it('creates only absent indexes in missing-indexes-only mode', () => {
    const plan = valueOf(
      planIndexes({
        mode: 'missing-indexes-only',
        concepts: [
          { relativePath: 'root.md', title: 'Root' },
          { relativePath: '資料/日本 語.md', title: '日本語' },
        ],
        existingIndexes: [{ relativePath: 'index.md', content: '# Hand-written root\n' }],
      }),
    );

    expect(plan.changes.map((change) => change.relativePath)).toEqual([
      'index.md',
      '資料/index.md',
    ]);
    expect(plan.changes[0]).toMatchObject({
      relativePath: 'index.md',
      operation: 'update',
      previousText: '# Hand-written root\n',
    });
    expect(plan.changes[0]?.proposedText).toBe(
      '---\nokf_version: "0.2"\n---\n# Hand-written root\n',
    );
    expect(plan.changes[1]?.operation).toBe('create');
    expect(plan.changes[1]?.proposedText).toContain(
      '- [日本語](./%E6%97%A5%E6%9C%AC%20%E8%AA%9E.md)',
    );
  });

  it('updates one region while preserving unrelated CRLF bytes and is idempotent', () => {
    const existing =
      '# Hand-written\r\n\r\n' +
      `${INDEX_START_MARKER}\r\n` +
      'old generated content\r\n' +
      `${INDEX_END_MARKER}\r\n` +
      '\r\nTail stays [exact].\r\n';
    const first = valueOf(
      planIndexes({
        mode: 'update-all',
        concepts: [{ relativePath: 'alpha.md', title: 'Alpha', description: 'Description' }],
        existingIndexes: [{ relativePath: 'index.md', content: existing }],
      }),
    );

    expect(first.changes).toHaveLength(1);
    const proposed = first.changes[0]?.proposedText;
    expect(proposed).toBeDefined();
    expect(proposed?.startsWith('---\r\nokf_version: "0.2"\r\n---\r\n')).toBe(true);
    expect(proposed).toContain('# Hand-written\r\n\r\n');
    expect(proposed?.endsWith('\r\nTail stays [exact].\r\n')).toBe(true);
    expect(proposed).toContain('- [Alpha](./alpha.md) - Description\r\n');
    expect(proposed?.replaceAll('\r\n', '')).not.toContain('\n');

    const second = valueOf(
      planIndexes({
        mode: 'update-all',
        concepts: [{ relativePath: 'alpha.md', title: 'Alpha', description: 'Description' }],
        existingIndexes: [{ relativePath: 'index.md', content: proposed ?? '' }],
      }),
    );
    expect(second.changes).toEqual([]);
  });

  it('appends a missing region after existing content in update-all mode', () => {
    const existing = '# Custom index\n\nKeep me.\n';
    const plan = valueOf(
      planIndexes({
        mode: 'update-all',
        concepts: [{ relativePath: 'alpha.md', title: 'Alpha' }],
        existingIndexes: [{ relativePath: 'index.md', content: existing }],
      }),
    );

    expect(plan.changes[0]?.proposedText).toBe(
      `---\nokf_version: "0.2"\n---\n${existing}\n${INDEX_START_MARKER}\n## Contents\n\n- [Alpha](./alpha.md)\n${INDEX_END_MARKER}\n`,
    );
  });

  it('adds a missing version inside existing frontmatter without rewriting unknown source', () => {
    const existing = [
      '---',
      '# producer comment stays here',
      'title: "Team knowledge"',
      'custom:',
      '  nested: [one, 2]',
      'quoted: "keep: exact"',
      '---',
      '# Human body',
      'No final newline',
    ].join('\n');
    const first = valueOf(
      planIndexes({
        mode: 'missing-indexes-only',
        concepts: [],
        existingIndexes: [{ relativePath: 'index.md', content: existing }],
      }),
    );

    expect(first.changes).toHaveLength(1);
    expect(first.changes[0]).toMatchObject({
      relativePath: 'index.md',
      operation: 'update',
      previousText: existing,
    });
    const proposed = first.changes[0]?.proposedText ?? '';
    expect(proposed).toBe(
      existing.replace('title: "Team knowledge"', 'okf_version: "0.2"\ntitle: "Team knowledge"'),
    );
    expect(proposed.replace('okf_version: "0.2"\n', '')).toBe(existing);
    expect(proposed.endsWith('No final newline')).toBe(true);
    expect(proposed.endsWith('\n')).toBe(false);

    const second = valueOf(
      planIndexes({
        mode: 'missing-indexes-only',
        concepts: [],
        existingIndexes: [{ relativePath: 'index.md', content: proposed }],
      }),
    );
    expect(second.changes).toEqual([]);
  });

  it.each([
    {
      name: 'flow mapping',
      existing: '---\n{ title: Knowledge }\n---\n# Body',
      expected: '---\n{okf_version: "0.2", title: Knowledge }\n---\n# Body',
    },
    {
      name: 'anchored block mapping',
      existing: '---\n&root\ntitle: Knowledge\n---\n# Body',
      expected: '---\n&root\nokf_version: "0.2"\ntitle: Knowledge\n---\n# Body',
    },
    {
      name: 'indented block mapping',
      existing: '---\n  title: Knowledge\n---\n# Body',
      expected: '---\n  okf_version: "0.2"\n  title: Knowledge\n---\n# Body',
    },
    {
      name: 'flow mapping with a retained comment',
      existing: '---\n{ # retained\n title: Knowledge}\n---\n# Body',
      expected: '---\n{okf_version: "0.2", # retained\n title: Knowledge}\n---\n# Body',
    },
  ])('safely inserts into a $name', ({ existing, expected }) => {
    const plan = valueOf(
      planIndexes({
        mode: 'missing-indexes-only',
        concepts: [],
        existingIndexes: [{ relativePath: 'index.md', content: existing }],
      }),
    );

    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]?.proposedText).toBe(expected);
    expect(
      valueOf(
        planIndexes({
          mode: 'missing-indexes-only',
          concepts: [],
          existingIndexes: [{ relativePath: 'index.md', content: expected }],
        }),
      ).changes,
    ).toEqual([]);
  });

  it('preserves a BOM and CRLF source while inserting into existing frontmatter', () => {
    const existing =
      '\uFEFF---\r\n' +
      '# retained comment\r\n' +
      'title: "Knowledge"\r\n' +
      'custom: 0x2A\r\n' +
      '---\r\n' +
      '# Body without final newline';
    const plan = valueOf(
      planIndexes({
        mode: 'missing-indexes-only',
        concepts: [],
        existingIndexes: [{ relativePath: 'index.md', content: existing }],
      }),
    );

    const proposed = plan.changes[0]?.proposedText ?? '';
    expect(proposed).toBe(
      existing.replace('title: "Knowledge"', 'okf_version: "0.2"\r\ntitle: "Knowledge"'),
    );
    expect(proposed.startsWith('\uFEFF')).toBe(true);
    expect(proposed.endsWith('# Body without final newline')).toBe(true);
    expect(proposed).not.toMatch(/(^|[^\r])\n/u);
  });

  it('prepends CRLF frontmatter while preserving human body and updating one managed region', () => {
    const existing =
      '# Human introduction\r\n\r\n' +
      `${INDEX_START_MARKER}\r\n` +
      'old generated content\r\n' +
      `${INDEX_END_MARKER}\r\n` +
      'Tail without final newline';
    const first = valueOf(
      planIndexes({
        mode: 'update-all',
        concepts: [{ relativePath: 'alpha.md', title: 'Alpha' }],
        existingIndexes: [{ relativePath: 'index.md', content: existing }],
      }),
    );

    const proposed = first.changes[0]?.proposedText ?? '';
    expect(proposed).toBe(
      '---\r\nokf_version: "0.2"\r\n---\r\n' +
        '# Human introduction\r\n\r\n' +
        `${INDEX_START_MARKER}\r\n` +
        '## Contents\r\n\r\n' +
        '- [Alpha](./alpha.md)\r\n' +
        `${INDEX_END_MARKER}\r\n` +
        'Tail without final newline',
    );
    expect(proposed).not.toMatch(/(^|[^\r])\n/u);

    const second = valueOf(
      planIndexes({
        mode: 'update-all',
        concepts: [{ relativePath: 'alpha.md', title: 'Alpha' }],
        existingIndexes: [{ relativePath: 'index.md', content: proposed }],
      }),
    );
    expect(second.changes).toEqual([]);
  });

  it('recognizes CR-only managed markers and preserves that newline style', () => {
    const existing =
      '---\rokf_version: "0.2"\r---\r' +
      '# Human\r\r' +
      `${INDEX_START_MARKER}\r` +
      'old\r' +
      `${INDEX_END_MARKER}\r` +
      'Tail';
    const first = valueOf(
      planIndexes({
        mode: 'update-all',
        concepts: [{ relativePath: 'alpha.md', title: 'Alpha' }],
        existingIndexes: [{ relativePath: 'index.md', content: existing }],
      }),
    );

    const proposed = first.changes[0]?.proposedText ?? '';
    expect(proposed).toContain(
      `${INDEX_START_MARKER}\r## Contents\r\r- [Alpha](./alpha.md)\r${INDEX_END_MARKER}\r`,
    );
    expect(proposed.endsWith('Tail')).toBe(true);
    expect(proposed).not.toContain('\n');

    const second = valueOf(
      planIndexes({
        mode: 'update-all',
        concepts: [{ relativePath: 'alpha.md', title: 'Alpha' }],
        existingIndexes: [{ relativePath: 'index.md', content: proposed }],
      }),
    );
    expect(second.changes).toEqual([]);
  });

  it('refuses malformed root frontmatter instead of returning a partial synthesis plan', () => {
    const result = planIndexes({
      mode: 'update-all',
      concepts: [{ relativePath: 'alpha.md', title: 'Alpha' }],
      existingIndexes: [
        {
          relativePath: 'index.md',
          content: '---\nokf_version: [\n---\n# Broken root\n',
        },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      problems: [{ code: 'root-version-synthesis-refused' }],
    });
  });

  it.each([
    {
      name: 'incomplete',
      content: `${INDEX_START_MARKER}\ncontent\n`,
      code: 'managed-region-incomplete-markers',
    },
    {
      name: 'reversed',
      content: `${INDEX_END_MARKER}\ncontent\n${INDEX_START_MARKER}\n`,
      code: 'managed-region-reversed-markers',
    },
    {
      name: 'duplicate',
      content: `${INDEX_START_MARKER}\na\n${INDEX_END_MARKER}\n${INDEX_START_MARKER}\nb\n${INDEX_END_MARKER}\n`,
      code: 'managed-region-duplicate-markers',
    },
    {
      name: 'nested',
      content: `${INDEX_START_MARKER}\na\n${INDEX_START_MARKER}\nb\n${INDEX_END_MARKER}\n${INDEX_END_MARKER}\n`,
      code: 'managed-region-duplicate-markers',
    },
    {
      name: 'CR-only incomplete',
      content: `${INDEX_START_MARKER}\rcontent\r`,
      code: 'managed-region-incomplete-markers',
    },
    {
      name: 'CR-only duplicate',
      content: `${INDEX_START_MARKER}\ra\r${INDEX_END_MARKER}\r${INDEX_START_MARKER}\rb\r${INDEX_END_MARKER}\r`,
      code: 'managed-region-duplicate-markers',
    },
  ])('refuses $name markers without returning a partial plan', ({ content, code }) => {
    const result = planIndexes({
      mode: 'update-all',
      concepts: [
        { relativePath: 'alpha.md', title: 'Alpha' },
        { relativePath: 'nested/beta.md', title: 'Beta' },
      ],
      existingIndexes: [
        { relativePath: 'index.md', content: '# Safe root\n' },
        { relativePath: 'nested/index.md', content },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems[0]?.code).toBe(code);
      expect(result.problems[0]?.message).toContain('nested/index.md');
    }
  });

  it('returns index changes in deterministic root-to-leaf order', () => {
    const plan: IndexPlan = valueOf(
      planIndexes({
        mode: 'missing-indexes-only',
        concepts: [{ relativePath: 'z/deep/item.md' }, { relativePath: 'a/item.md' }],
        existingIndexes: [],
      }),
    );
    expect(plan.changes.map(({ relativePath }) => relativePath)).toEqual([
      'index.md',
      'a/index.md',
      'z/index.md',
      'z/deep/index.md',
    ]);
  });

  it('keeps provider percent identities distinct and emits correctly encoded index links', () => {
    const providerConcepts = [
      { relativePath: 'literal%.md', title: 'Literal percent' },
      { relativePath: 'encoded%2Fsegment.md', title: 'Literal encoded separator' },
      { relativePath: 'encoded%252Fsegment.md', title: 'Literal double encoding' },
      { relativePath: 'encoded/segment.md', title: 'Actual nested segment' },
      { relativePath: 'space dir/日本 語.md', title: 'Unicode and space' },
    ];
    const plan = valueOf(
      planProviderIndexes({
        mode: 'missing-indexes-only',
        concepts: providerConcepts,
        existingIndexes: [],
      }),
    );

    expect(plan.changes.map(({ relativePath }) => relativePath)).toEqual([
      'index.md',
      'encoded/index.md',
      'space dir/index.md',
    ]);
    const rootIndex = plan.changes.find(({ relativePath }) => relativePath === 'index.md');
    expect(rootIndex?.proposedText).toContain('- [Literal percent](./literal%25.md)');
    expect(rootIndex?.proposedText).toContain(
      '- [Literal encoded separator](./encoded%252Fsegment.md)',
    );
    expect(rootIndex?.proposedText).toContain(
      '- [Literal double encoding](./encoded%25252Fsegment.md)',
    );
    expect(rootIndex?.proposedText).toContain('- [encoded](./encoded/)');
    expect(rootIndex?.proposedText).toContain('- [space dir](./space%20dir/)');
    expect(
      plan.changes.find(({ relativePath }) => relativePath === 'space dir/index.md')?.proposedText,
    ).toContain('- [Unicode and space](./%E6%97%A5%E6%9C%AC%20%E8%AA%9E.md)');

    expect(
      planIndexes({
        mode: 'missing-indexes-only',
        concepts: providerConcepts.slice(1, 4),
        existingIndexes: [],
      }),
    ).toMatchObject({
      ok: false,
      problems: [{ code: 'duplicate-concept-path' }],
    });
  });

  it.each(['.md', 'nested/.md'])(
    'refuses a provider concept without a filename stem before rendering indexes: %s',
    (relativePath) => {
      expect(
        planProviderIndexes({
          mode: 'missing-indexes-only',
          concepts: [{ relativePath }],
          existingIndexes: [],
        }),
      ).toMatchObject({
        ok: false,
        problems: [{ code: 'unsafe-relative-path' }],
      });
    },
  );
});
