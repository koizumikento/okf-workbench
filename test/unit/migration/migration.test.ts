import { describe, expect, it } from 'vitest';

import { planMigration } from '../../../src/core/migration/index.js';
import type { ParseBundleInput } from '../../../src/core/parser/index.js';

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
    expect(plan.files.map((file) => file.relativePath)).toEqual(['index.md', 'provenance.md']);
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
});
