import { describe, expect, it } from 'vitest';

import { planMigration } from '../../../src/core/migration/index.js';
import { parseBundle, type ParseBundleInput } from '../../../src/core/parser/index.js';

function input(documents: readonly (readonly [string, string])[]): ParseBundleInput {
  return {
    rootUri: 'fixture:/migration',
    revision: 1,
    documents: documents.map(([bundlePath, content]) => ({
      uri: `fixture:/migration/${bundlePath}`,
      bundlePath,
      content,
    })),
  };
}

describe('OKF v0.2 migration', () => {
  it('migrates deterministic legacy fields and is idempotent', () => {
    const root = ['---', 'okf_version: "0.1"', '---', '# Root', ''].join('\n');
    const concept = [
      '---',
      'type: Reference',
      'title: Provenance',
      'description: Legacy provenance',
      'timestamp: "2026-07-22T10:00:00Z"',
      'custom_field: retained',
      '---',
      '# Provenance',
      '',
      '# Citations',
      '',
      '- https://example.com/one',
      '* https://example.com/two',
      '',
    ].join('\n');
    const plan = planMigration({
      bundle: input([
        ['index.md', root],
        ['provenance.md', concept],
      ]),
      actor: 'human:reviewer',
    });

    expect(plan.fromVersion).toBe('0.1');
    expect(plan.files.map((file) => file.relativePath)).toEqual(['provenance.md', 'index.md']);
    const rootOutput = plan.files.find((file) => file.relativePath === 'index.md')?.content ?? '';
    const output = plan.files.find((file) => file.relativePath === 'provenance.md')?.content ?? '';
    expect(rootOutput).toContain('okf_version: "0.2"');
    expect(output).toContain('generated:\n  by: "human:reviewer"');
    expect(output).toContain('custom_field: retained');
    expect(output).toContain('  - resource: "https://example.com/one"');
    expect(output).toContain('# Citations\n\n- https://example.com/one');
    expect(plan.documents.some((document) => document.manualFollowUp)).toBe(false);

    expect(
      planMigration({
        bundle: input([
          ['index.md', rootOutput],
          ['provenance.md', output],
        ]),
        actor: 'human:reviewer',
      }).files,
    ).toEqual([]);
  });

  it('retains ambiguous citations and reports manual follow-up', () => {
    const plan = planMigration({
      bundle: input([
        ['index.md', ['---', 'okf_version: "0.1"', '---', '# Root', ''].join('\n')],
        [
          'notes.md',
          [
            '---',
            'type: Reference',
            'title: Notes',
            'description: Notes',
            '---',
            '# Notes',
            '',
            '# Citations',
            '',
            '- [Named source](https://example.com/source)',
            '',
          ].join('\n'),
        ],
      ]),
      actor: 'human:reviewer',
    });

    expect(plan.documents.find((document) => document.relativePath === 'notes.md')).toMatchObject({
      changed: false,
      manualFollowUp: true,
    });
    expect(plan.files.some((file) => file.relativePath === 'notes.md')).toBe(false);
  });

  it('requires an explicit conventional actor', () => {
    expect(() =>
      planMigration({
        bundle: input([
          ['index.md', ['---', 'okf_version: "0.1"', '---', '# Root', ''].join('\n')],
        ]),
        actor: 'inferred user',
      }),
    ).toThrow(/Migration actor/);
  });

  it('ignores fenced citation examples and uses ordinal path order', () => {
    const plan = planMigration({
      bundle: input([
        ['index.md', ['---', 'okf_version: "0.1"', '---', '# Root', ''].join('\n')],
        [
          'B.md',
          [
            '---',
            'type: Reference',
            'title: Example',
            'description: Code sample',
            '---',
            '# Example',
            '',
            '```md',
            '# Citations',
            '- https://example.com/not-a-source',
            '```',
            '',
          ].join('\n'),
        ],
        [
          'a.md',
          [
            '---',
            'type: Reference',
            'title: Lowercase RFC3339',
            'description: Lowercase RFC3339',
            'timestamp: "2026-07-22t10:00:00z"',
            '---',
            '# Lowercase',
            '',
          ].join('\n'),
        ],
      ]),
      actor: 'human:reviewer',
    });

    expect(plan.files.map((file) => file.relativePath)).toEqual(['a.md', 'index.md']);
    expect(plan.files.some((file) => file.content.includes('not-a-source'))).toBe(false);
    expect(plan.files.find((file) => file.relativePath === 'a.md')?.content).toContain(
      'generated:\n  by: "human:reviewer"',
    );
  });

  it('migrates quoted keys and produces a parseable proposal', () => {
    const plan = planMigration({
      bundle: input([
        ['index.md', ['---', '"okf_version": "0.1"', '---', '# Root', ''].join('\n')],
        [
          'quoted.md',
          [
            '---',
            'type: Reference',
            '\'timestamp\': "2026-07-22T10:00:00Z"',
            '---',
            '# Quoted',
            '',
          ].join('\n'),
        ],
      ]),
      actor: 'human:reviewer',
    });
    expect(plan.files.map(({ relativePath }) => relativePath)).toEqual(['quoted.md', 'index.md']);
    const migrated = parseBundle(
      input(plan.files.map(({ relativePath, content }) => [relativePath, content] as const)),
    );
    expect(migrated.failures).toEqual([]);
    expect(migrated.reservedDocuments[0]?.okfVersion).toBe('0.2');
    expect(migrated.concepts[0]?.generated).toMatchObject({
      by: 'human:reviewer',
      at: '2026-07-22T10:00:00Z',
    });
  });

  it('refuses anchored root versions and leaves anchored or multiline timestamps manual', () => {
    expect(() =>
      planMigration({
        bundle: input([
          [
            'index.md',
            [
              '---',
              'okf_version: &version "0.1"',
              'producer_version: *version',
              '---',
              '# Root',
              '',
            ].join('\n'),
          ],
        ]),
        actor: 'human:reviewer',
      }),
    ).toThrow(/single-line, unanchored/);
    for (const root of [
      ['---', 'okf_version: !!str', '  0.1', '---', '# Root', ''].join('\n'),
      ['---', 'okf_version: !<tag:yaml.org,2002:str> >-', '  0.1', '---', '# Root', ''].join('\n'),
      ['---', 'okf_version: !!str # retained', '  0.1', '---', '# Root', ''].join('\n'),
      ['---', 'okf_version: "0.' + '\\', '  1"', '---', '# Root', ''].join('\n'),
    ]) {
      expect(() =>
        planMigration({
          bundle: input([['index.md', root]]),
          actor: 'human:reviewer',
        }),
      ).toThrow(/single-line, unanchored/);
    }
    expect(() =>
      planMigration({
        bundle: input([
          [
            'index.md',
            [
              '---',
              'okf_version: !<tag:yaml.org,2002:str> &version "0.1"',
              'producer_version: *version',
              '---',
              '# Root',
              '',
            ].join('\n'),
          ],
        ]),
        actor: 'human:reviewer',
      }),
    ).toThrow(/single-line, unanchored/);

    const plan = planMigration({
      bundle: input([
        ['index.md', ['---', 'okf_version: "0.1"', '---', '# Root', ''].join('\n')],
        [
          'anchored.md',
          [
            '---',
            'type: Reference',
            'timestamp: &when "2026-07-22T10:00:00Z"',
            'producer_time: *when',
            '---',
            '# Anchored',
            '',
          ].join('\n'),
        ],
        [
          'multiline.md',
          [
            '---',
            'type: Reference',
            'timestamp: >-',
            '  2026-07-22T10:00:00Z',
            '---',
            '# Multiline',
            '',
          ].join('\n'),
        ],
        [
          'tagged-anchored.md',
          [
            '---',
            'type: Reference',
            'timestamp: !<tag:yaml.org,2002:str> &when "2026-07-22T10:00:00Z"',
            'producer_time: *when',
            '---',
            '# Tagged anchored',
            '',
          ].join('\n'),
        ],
        [
          'tag-only-line.md',
          [
            '---',
            'type: Reference',
            'timestamp: !!str',
            '  2026-07-22T10:00:00Z',
            '---',
            '# Tag only line',
            '',
          ].join('\n'),
        ],
        [
          'tagged-block.md',
          [
            '---',
            'type: Reference',
            'timestamp: !<tag:yaml.org,2002:str> >-',
            '  2026-07-22T10:00:00Z',
            '---',
            '# Tagged block',
            '',
          ].join('\n'),
        ],
        [
          'comment-continuation.md',
          [
            '---',
            'type: Reference',
            'timestamp: !!str # retained',
            '  2026-07-22T10:00:00Z',
            '---',
            '# Comment continuation',
            '',
          ].join('\n'),
        ],
        [
          'quoted-continuation.md',
          [
            '---',
            'type: Reference',
            'timestamp: "2026-07-22T10:00:' + '\\',
            '  00Z"',
            '---',
            '# Quoted continuation',
            '',
          ].join('\n'),
        ],
      ]),
      actor: 'human:reviewer',
    });
    expect(plan.files.map(({ relativePath }) => relativePath)).toEqual(['index.md']);
    expect(
      plan.documents
        .filter(({ relativePath }) => relativePath !== 'index.md')
        .every(({ manualFollowUp, changed }) => manualFollowUp && !changed),
    ).toBe(true);
    expect(
      plan.documents
        .filter(({ relativePath }) => relativePath !== 'index.md')
        .every(({ manualReasons }) =>
          manualReasons.includes('timestamp-requires-manual-migration'),
        ),
    ).toBe(true);
  });

  it('does not convert indented code or a non-ATX Citations# heading', () => {
    const plan = planMigration({
      bundle: input([
        ['index.md', ['---', 'okf_version: "0.1"', '---', '# Root', ''].join('\n')],
        [
          'indented.md',
          [
            '---',
            'type: Reference',
            '---',
            '# Indented',
            '',
            '# Citations',
            '',
            '    - https://example.com/code',
            '',
          ].join('\n'),
        ],
        [
          'not-heading.md',
          [
            '---',
            'type: Reference',
            '---',
            '# Citations#',
            '',
            '- https://example.com/not-a-citation',
            '',
          ].join('\n'),
        ],
        [
          'tabbed.md',
          [
            '---',
            'type: Reference',
            '---',
            '# Citations',
            '',
            '\t- https://example.com/tab-code',
            '',
          ].join('\n'),
        ],
        [
          'three-space-tab.md',
          [
            '---',
            'type: Reference',
            '---',
            '# Citations',
            '',
            '   \t- https://example.com/tab-code',
            '',
          ].join('\n'),
        ],
        [
          'indented-fence-close.md',
          [
            '---',
            'type: Reference',
            '---',
            '```md',
            '    ```',
            '# Citations',
            '- https://example.com/not-a-source',
            '```',
            '',
          ].join('\n'),
        ],
      ]),
      actor: 'human:reviewer',
    });
    expect(plan.files.map(({ relativePath }) => relativePath)).toEqual(['index.md']);
    expect(plan.documents.find(({ relativePath }) => relativePath === 'indented.md')).toMatchObject(
      { manualFollowUp: true, citationCandidates: [] },
    );
    expect(
      plan.documents.find(({ relativePath }) => relativePath === 'not-heading.md'),
    ).toMatchObject({ manualFollowUp: false, citationCandidates: [] });
    for (const relativePath of ['tabbed.md', 'three-space-tab.md']) {
      expect(
        plan.documents.find((document) => document.relativePath === relativePath),
      ).toMatchObject({
        manualFollowUp: true,
        manualReasons: ['citations-require-manual-review'],
        citationCandidates: [],
      });
    }
    expect(
      plan.documents.find(({ relativePath }) => relativePath === 'indented-fence-close.md'),
    ).toMatchObject({ manualFollowUp: false, citationCandidates: [] });
  });

  it.each(['\n', '\r\n', '\r'] as const)(
    'preserves a leading BOM and applies source offsets with %j line endings',
    (eol) => {
      const root = `\uFEFF---${eol}okf_version: "0.1"${eol}---${eol}# Root${eol}`;
      const concept = `\uFEFF---${eol}type: Reference${eol}timestamp: "2026-07-22T10:00:00Z"${eol}---${eol}# Citations${eol}${eol}- https://example.com/source${eol}`;
      for (const asBytes of [false, true]) {
        const encode = (value: string): string | Uint8Array =>
          asBytes ? new TextEncoder().encode(value) : value;
        const plan = planMigration({
          bundle: {
            rootUri: 'fixture:/migration-bom',
            revision: 1,
            documents: [
              {
                uri: 'fixture:/migration-bom/index.md',
                bundlePath: 'index.md',
                content: encode(root),
              },
              {
                uri: 'fixture:/migration-bom/concept.md',
                bundlePath: 'concept.md',
                content: encode(concept),
              },
            ],
          },
          actor: 'human:reviewer',
        });
        const rootOutput = plan.files.find(
          ({ relativePath }) => relativePath === 'index.md',
        )?.content;
        const conceptOutput = plan.files.find(
          ({ relativePath }) => relativePath === 'concept.md',
        )?.content;
        expect(rootOutput).toBe(`\uFEFF---${eol}okf_version: "0.2"${eol}---${eol}# Root${eol}`);
        expect(conceptOutput?.startsWith('\uFEFF---')).toBe(true);
        expect(conceptOutput).toContain(`generated:${eol}  by: "human:reviewer"`);
        expect(conceptOutput).toContain(
          `sources:${eol}  - resource: "https://example.com/source"${eol}---`,
        );
      }
    },
  );

  it('scans every Citations section and leaves HTML pseudo-sections for manual review', () => {
    const plan = planMigration({
      bundle: input([
        ['index.md', ['---', 'okf_version: "0.1"', '---', '# Root', ''].join('\n')],
        [
          'multiple.md',
          [
            '---',
            'type: Reference',
            '---',
            '# Citations',
            '- https://example.com/one',
            '# Notes',
            'text',
            '# Citations',
            '- https://example.com/two',
            '',
          ].join('\n'),
        ],
        [
          'html.md',
          [
            '---',
            'type: Reference',
            '---',
            '<!--',
            '# Citations',
            '- https://example.com/not-a-source',
            '-->',
            '',
          ].join('\n'),
        ],
        [
          'script.md',
          [
            '---',
            'type: Reference',
            '---',
            '<script>',
            '',
            '# Citations',
            '- https://example.com/not-a-source',
            '</script>',
            '',
          ].join('\n'),
        ],
      ]),
      actor: 'human:reviewer',
    });
    expect(plan.documents.find(({ relativePath }) => relativePath === 'multiple.md')).toMatchObject(
      {
        changed: true,
        manualFollowUp: false,
        citationCandidates: ['https://example.com/one', 'https://example.com/two'],
      },
    );
    expect(plan.documents.find(({ relativePath }) => relativePath === 'html.md')).toMatchObject({
      changed: false,
      manualFollowUp: true,
      manualReasons: ['citations-require-manual-review'],
      citationCandidates: [],
    });
    expect(plan.documents.find(({ relativePath }) => relativePath === 'script.md')).toMatchObject({
      changed: false,
      manualFollowUp: true,
      manualReasons: ['citations-require-manual-review'],
      citationCandidates: [],
    });
  });

  it('analyzes Citations when sources already exist and rejects U+FEFF in URLs', () => {
    const plan = planMigration({
      bundle: input([
        ['index.md', ['---', 'okf_version: "0.2"', '---', '# Root', ''].join('\n')],
        [
          'existing.md',
          [
            '---',
            'type: Reference',
            'sources:',
            '  - resource: "https://example.com/existing"',
            '---',
            '# Citations',
            '- [Named](https://example.com/named)',
            '',
          ].join('\n'),
        ],
        [
          'bom-url.md',
          [
            '---',
            'type: Reference',
            '---',
            '# Citations',
            '- https://example.com/a\uFEFFb',
            '',
          ].join('\n'),
        ],
      ]),
      actor: 'human:reviewer',
    });
    for (const relativePath of ['existing.md', 'bom-url.md']) {
      expect(
        plan.documents.find((document) => document.relativePath === relativePath),
      ).toMatchObject({
        changed: false,
        manualFollowUp: true,
        manualReasons: ['citations-require-manual-review'],
      });
    }
  });

  it('stops automatic Citations insertion when the rendered YAML exceeds parser limits', () => {
    const longUrl = `https://example.com/${'a'.repeat(65_500)}`;
    const plan = planMigration({
      bundle: input([
        ['index.md', ['---', 'okf_version: "0.1"', '---', '# Root', ''].join('\n')],
        [
          'long.md',
          ['---', 'type: Reference', '---', '# Citations', `- ${longUrl}`, `- ${longUrl}`, ''].join(
            '\n',
          ),
        ],
      ]),
      actor: 'human:reviewer',
    });
    expect(plan.documents.find(({ relativePath }) => relativePath === 'long.md')).toMatchObject({
      changed: false,
      manualFollowUp: true,
      manualReasons: ['citations-require-manual-review'],
      citationCandidates: [longUrl],
    });
    expect(plan.files.map(({ relativePath }) => relativePath)).toEqual(['index.md']);
  });
});
