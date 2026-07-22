import { describe, expect, it } from 'vitest';

import type { OperationResult } from '../../../src/core/model/index.js';
import {
  BUNDLE_PRESET_FILE_PATHS,
  BUNDLE_PRESETS,
  CONCEPT_TEMPLATE_DEFINITIONS,
  CONCEPT_TEMPLATES,
  renderBundlePreset,
  renderConceptTemplate,
} from '../../../src/core/templates/index.js';

function valueOf<T>(result: OperationResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.problems.map((problem) => problem.message).join('\n'));
  }
  return result.value;
}

describe('built-in bundle presets', () => {
  it('renders the exact ADR 0005 file set for every preset', () => {
    for (const preset of BUNDLE_PRESETS) {
      const first = valueOf(
        renderBundlePreset({
          preset,
          timestamp: '2026-07-22T10:00:00+09:00',
        }),
      );
      const second = valueOf(
        renderBundlePreset({
          preset,
          timestamp: '2026-07-22T10:00:00+09:00',
        }),
      );

      expect(first.map((file) => file.relativePath)).toEqual(BUNDLE_PRESET_FILE_PATHS[preset]);
      expect(first).toEqual(second);
      expect(first.every((file) => file.encoding === 'utf8')).toBe(true);
      expect(
        first.every((file) => file.content.endsWith('\n') && !file.content.includes('\r')),
      ).toBe(true);
    }
  });

  it('keeps directory indexes to the generated region and declares v0.1 at the root', () => {
    const files = valueOf(
      renderBundlePreset({
        preset: 'software-project',
        timestamp: '2026-07-22T01:00:00Z',
      }),
    );
    const byPath = new Map(files.map((file) => [file.relativePath, file]));

    expect(byPath.get('index.md')?.content).toMatch(/^---\nokf_version: "0\.1"\n---\n/u);
    expect(byPath.get('architecture/index.md')?.content).toBe(
      '<!-- okf-workbench:index:start -->\n' +
        '## Contents\n\n' +
        '- [System overview](./system-overview.md) - The system boundaries, components, and important data flows.\n' +
        '<!-- okf-workbench:index:end -->\n',
    );
  });

  it('encodes every rendered file as deterministic UTF-8', () => {
    const files = valueOf(
      renderBundlePreset({
        preset: 'data-analytics',
        timestamp: '2026-07-22T01:00:00Z',
      }),
    );
    const encoder = new TextEncoder();
    const decoder = new TextDecoder('utf-8', { fatal: true });

    for (const file of files) {
      expect(decoder.decode(encoder.encode(file.content))).toBe(file.content);
    }
  });
});

describe('built-in concept templates', () => {
  it('offers all seven documented templates without closing the type vocabulary', () => {
    expect(CONCEPT_TEMPLATE_DEFINITIONS.map(({ id }) => id)).toEqual(CONCEPT_TEMPLATES);

    for (const template of CONCEPT_TEMPLATES) {
      const file = valueOf(
        renderConceptTemplate({
          template,
          relativePath: `custom/${template}.md`,
          type: 'experiment-result',
          title: `Custom ${template}`,
          tags: [],
        }),
      );
      expect(file.content).toContain('type: "experiment-result"');
      expect(file.content).not.toContain('\ntags:');
    }
  });

  it('omits optional frontmatter for empty tags and whitespace-only descriptions', () => {
    const file = valueOf(
      renderConceptTemplate({
        template: 'generic-concept',
        relativePath: 'minimal.md',
        type: 'concept',
        title: 'Minimal metadata',
        description: ' \r\n\t ',
        tags: [],
      }),
    );

    expect(file.content).not.toContain('\ndescription:');
    expect(file.content).not.toContain('\ntags:');
  });

  it('normalizes portable paths and renders Unicode, tags, and LF-only YAML safely', () => {
    const file = valueOf(
      renderConceptTemplate({
        template: 'generic-concept',
        relativePath: '知識\\実験 結果.md',
        type: '実験:結果',
        title: '  量子\r\n 実験  ',
        description: '一行目\r\n二行目',
        tags: ['日本語', 'space tag', 'quote"tag'],
        timestamp: '2026-07-22T10:00:00+09:00',
      }),
    );

    expect(file.relativePath).toBe('知識/実験 結果.md');
    expect(file.content).toBe(
      [
        '---',
        'type: "実験:結果"',
        'title: "量子 実験"',
        'description: "一行目\\n二行目"',
        'tags:',
        '  - "日本語"',
        '  - "space tag"',
        '  - "quote\\"tag"',
        'timestamp: "2026-07-22T10:00:00+09:00"',
        '---',
        '# 量子 実験',
        '',
        '一行目',
        '二行目',
        '',
        '## Summary',
        '',
        'Describe the durable knowledge captured by this concept.',
        '',
        '## Details',
        '',
        'Add relevant context, constraints, and links.',
        '',
      ].join('\n'),
    );
    expect(file.content).not.toContain('\r');
  });

  it.each([
    '../escape.md',
    '/absolute.md',
    'C:\\outside.md',
    'safe/%2e%2e/escape.md',
    'https://example.test/concept.md',
    'index.md',
    'nested/log.md',
  ])('refuses the unsafe or reserved concept path %s', (relativePath) => {
    const result = renderConceptTemplate({
      template: 'generic-concept',
      relativePath,
      type: 'custom',
      title: 'Unsafe',
    });
    expect(result.ok).toBe(false);
  });

  it('refuses whitespace-only custom types', () => {
    const result = renderConceptTemplate({
      template: 'generic-concept',
      relativePath: 'valid.md',
      type: ' \t ',
      title: 'Invalid type',
    });
    expect(result).toMatchObject({ ok: false });
  });
});
