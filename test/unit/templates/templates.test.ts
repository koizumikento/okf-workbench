import { describe, expect, it } from 'vitest';

import type { OperationResult, ParsedBundle } from '../../../src/core/model/index.js';
import { parseBundle } from '../../../src/core/parser/index.js';
import {
  BUNDLE_PRESET_FILE_PATHS,
  BUNDLE_PRESETS,
  CONCEPT_TEMPLATE_DEFINITIONS,
  CONCEPT_TEMPLATES,
  renderBundlePreset,
  renderConceptTemplate,
  type BundlePreset,
  type RenderedTemplateFile,
} from '../../../src/core/templates/index.js';
import { validateBundle } from '../../../src/core/validation/index.js';

const TEMPLATE_TIMESTAMP = '2026-07-22T10:00:00+09:00';
const TEMPLATE_ROOT_URI = 'memfs:/workspace/template-contract';

function valueOf<T>(result: OperationResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.problems.map((problem) => problem.message).join('\n'));
  }
  return result.value;
}

function parseRenderedBundle(files: readonly RenderedTemplateFile[]): ParsedBundle {
  return parseBundle({
    rootUri: TEMPLATE_ROOT_URI,
    revision: 1,
    documents: files.map((file) => ({
      uri: `${TEMPLATE_ROOT_URI}/${encodeURI(file.relativePath)}`,
      bundlePath: file.relativePath,
      content: file.content,
    })),
  });
}

function expectConformant(bundle: ParsedBundle): void {
  expect(bundle.failures).toEqual([]);
  expect(
    validateBundle(bundle, { now: TEMPLATE_TIMESTAMP }).filter(
      ({ category }) => category === 'conformance',
    ),
  ).toEqual([]);
}

const EXPECTED_PRESET_SEMANTICS: Readonly<
  Record<
    BundlePreset,
    {
      readonly concepts: readonly {
        readonly id: string;
        readonly type: string;
        readonly title: string;
        readonly tags: readonly string[];
      }[];
      readonly indexes: readonly string[];
    }
  >
> = {
  minimal: {
    concepts: [],
    indexes: ['index.md'],
  },
  'software-project': {
    concepts: [
      {
        id: 'architecture/system-overview',
        type: 'architecture',
        title: 'System overview',
        tags: ['architecture'],
      },
      {
        id: 'decisions/initial-context',
        type: 'decision',
        title: 'Initial context',
        tags: ['decision', 'context'],
      },
      {
        id: 'playbooks/development',
        type: 'playbook',
        title: 'Development',
        tags: ['development', 'playbook'],
      },
      {
        id: 'project-overview',
        type: 'project-overview',
        title: 'Project overview',
        tags: ['project', 'overview'],
      },
    ],
    indexes: ['architecture/index.md', 'decisions/index.md', 'index.md', 'playbooks/index.md'],
  },
  'data-analytics': {
    concepts: [
      {
        id: 'data-landscape',
        type: 'data-landscape',
        title: 'Data landscape',
        tags: ['data', 'overview'],
      },
      {
        id: 'datasets/example-dataset',
        type: 'dataset',
        title: 'Example dataset',
        tags: ['dataset'],
      },
      {
        id: 'metrics/example-metric',
        type: 'metric',
        title: 'Example metric',
        tags: ['metric'],
      },
      {
        id: 'playbooks/data-quality',
        type: 'playbook',
        title: 'Data quality',
        tags: ['data-quality', 'playbook'],
      },
    ],
    indexes: ['datasets/index.md', 'index.md', 'metrics/index.md', 'playbooks/index.md'],
  },
};

describe('built-in bundle presets', () => {
  it('renders the exact ADR 0005 file set for every preset', () => {
    for (const preset of BUNDLE_PRESETS) {
      const first = valueOf(
        renderBundlePreset({
          preset,
          timestamp: TEMPLATE_TIMESTAMP,
        }),
      );
      const second = valueOf(
        renderBundlePreset({
          preset,
          timestamp: TEMPLATE_TIMESTAMP,
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

  it.each(BUNDLE_PRESETS)(
    'round-trips the %s preset through parsing and conformance validation',
    (preset) => {
      const files = valueOf(
        renderBundlePreset({
          preset,
          timestamp: TEMPLATE_TIMESTAMP,
        }),
      );
      const bundle = parseRenderedBundle(files);
      const expected = EXPECTED_PRESET_SEMANTICS[preset];

      expectConformant(bundle);
      expect(
        bundle.concepts.map(({ id, type, title, tags, timestamp }) => ({
          id,
          type,
          title,
          tags,
          timestamp,
        })),
      ).toEqual(
        expected.concepts.map((concept) => ({
          ...concept,
          timestamp: TEMPLATE_TIMESTAMP,
        })),
      );
      expect(
        bundle.reservedDocuments.map(({ reservedKind, source, okfVersion }) => ({
          path: source.bundlePath,
          reservedKind,
          okfVersion,
        })),
      ).toEqual(
        expected.indexes.map((path) => ({
          path,
          reservedKind: 'index',
          ...(path === 'index.md' ? { okfVersion: '0.1' } : {}),
        })),
      );
    },
  );

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

  it('round-trips all seven variants with their documented semantic shape', () => {
    const rootIndex = valueOf(
      renderBundlePreset({
        preset: 'minimal',
        timestamp: TEMPLATE_TIMESTAMP,
      }),
    );
    const conceptFiles = CONCEPT_TEMPLATE_DEFINITIONS.map((definition) =>
      valueOf(
        renderConceptTemplate({
          template: definition.id,
          relativePath: `templates/${definition.id}.md`,
          type: definition.suggestedType,
          title: definition.title,
          description: `Canonical ${definition.title} template.`,
          tags: ['template', definition.id],
          timestamp: TEMPLATE_TIMESTAMP,
        }),
      ),
    );
    const bundle = parseRenderedBundle([...rootIndex, ...conceptFiles]);

    expectConformant(bundle);
    expect(
      bundle.concepts.map(({ id, type, title, description, tags, timestamp }) => ({
        id,
        type,
        title,
        description,
        tags,
        timestamp,
      })),
    ).toEqual(
      [...CONCEPT_TEMPLATE_DEFINITIONS]
        .sort((left, right) => {
          if (left.id < right.id) {
            return -1;
          }
          if (left.id > right.id) {
            return 1;
          }
          return 0;
        })
        .map((definition) => ({
          id: `templates/${definition.id}`,
          type: definition.suggestedType,
          title: definition.title,
          description: `Canonical ${definition.title} template.`,
          tags: ['template', definition.id],
          timestamp: TEMPLATE_TIMESTAMP,
        })),
    );
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

  it('keeps title and Markdown-looking descriptions in frontmatter only', () => {
    const file = valueOf(
      renderConceptTemplate({
        template: 'generic-concept',
        relativePath: 'lint-clean.md',
        type: 'concept',
        title: 'Lint-clean concept',
        description: '# Alternate title\n[Link](target.md)',
      }),
    );

    expect(file.content).toContain('description: "# Alternate title\\n[Link](target.md)"\n');
    expect(file.content).toContain('\n---\n\n## Summary\n');
    expect(file.content).not.toContain('\n# Lint-clean concept\n');
    expect(file.content).not.toContain('\n# Alternate title\n');
    expect(file.content).not.toContain('\n[Link](target.md)\n');
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
