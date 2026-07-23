import { describe, expect, it } from 'vitest';

import { planIndexes, renderManagedIndexRegion } from '../../../src/core/indexes/index.js';
import { mergeManagedRegion } from '../../../src/core/indexes/managed-region.js';
import type { OperationResult } from '../../../src/core/model/index.js';
import { planAgentsFile } from '../../../src/core/templates/index.js';

function valueOf<T>(result: OperationResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.problems.map((problem) => problem.message).join('\n'));
  }
  return result.value;
}

describe('BOM-prefixed managed regions', () => {
  it('updates and re-reads an AGENTS.md marker at the first logical line', () => {
    const initial = valueOf(
      planAgentsFile({
        bundlePath: 'knowledge',
        existingText: '',
      }),
    );
    const bomExisting = `\uFEFF${initial.proposedText}`;
    const unchanged = valueOf(
      planAgentsFile({
        bundlePath: 'knowledge',
        existingText: bomExisting,
      }),
    );

    expect(unchanged.status).toBe('unchanged');
    expect(unchanged.proposedText).toBe(bomExisting);

    const updated = valueOf(
      planAgentsFile({
        bundlePath: 'docs/knowledge',
        existingText: bomExisting,
      }),
    );
    expect(updated.status).toBe('update');
    expect(updated.proposedText.startsWith('\uFEFF<!-- okf-workbench:start -->')).toBe(true);
    expect(updated.proposedText).toContain('`docs/knowledge/index.md`');
    expect(
      valueOf(
        planAgentsFile({
          bundlePath: 'docs/knowledge',
          existingText: updated.proposedText,
        }),
      ).status,
    ).toBe('unchanged');
  });

  it('updates and re-reads a nested index marker at the first logical line', () => {
    const rootIndex =
      '---\nokf_version: "0.1"\n---\n' +
      renderManagedIndexRegion([{ kind: 'directory', name: 'nested' }]);
    const nestedIndex = `\uFEFF${renderManagedIndexRegion([
      { kind: 'concept', filename: 'alpha.md', title: 'Old title' },
    ])}`;
    const first = valueOf(
      planIndexes({
        mode: 'update-all',
        concepts: [{ relativePath: 'nested/alpha.md', title: 'Alpha' }],
        existingIndexes: [
          { relativePath: 'index.md', content: rootIndex },
          { relativePath: 'nested/index.md', content: nestedIndex },
        ],
      }),
    );

    expect(first.changes).toHaveLength(1);
    expect(first.changes[0]?.relativePath).toBe('nested/index.md');
    const proposed = first.changes[0]?.proposedText ?? '';
    expect(proposed.startsWith('\uFEFF<!-- okf-workbench:index:start -->')).toBe(true);
    expect(proposed).toContain('- [Alpha](./alpha.md)');

    const second = valueOf(
      planIndexes({
        mode: 'update-all',
        concepts: [{ relativePath: 'nested/alpha.md', title: 'Alpha' }],
        existingIndexes: [
          { relativePath: 'index.md', content: rootIndex },
          { relativePath: 'nested/index.md', content: proposed },
        ],
      }),
    );
    expect(second.changes).toEqual([]);
  });
});

describe('managed-region scan bounds', () => {
  it('replaces markers after two MiB of dense newlines without retaining one object per line', () => {
    const prefix = '\n'.repeat(2 * 1024 * 1024);
    const markers = {
      start: '<!-- dense:start -->',
      end: '<!-- dense:end -->',
      name: 'dense test',
    };
    const renderedRegion = `${markers.start}\nreplacement\n${markers.end}\n`;
    const existingText =
      `${prefix}${markers.start}\r\n` + `stale\r\n${markers.end}\r\n` + 'unrelated tail\r\n';

    const result = mergeManagedRegion({
      existingText,
      renderedRegion,
      markers,
      appendWhenMissing: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.problems.map((problem) => problem.message).join('\n'));
    }
    expect(result.value.slice(0, prefix.length)).toBe(prefix);
    expect(result.value.slice(prefix.length)).toBe(
      `${markers.start}\r\nreplacement\r\n${markers.end}\r\nunrelated tail\r\n`,
    );
  });
});
