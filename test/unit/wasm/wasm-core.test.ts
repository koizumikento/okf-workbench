import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeAll, describe, expect, test } from 'vitest';

import {
  createWasmOkfCore,
  typescriptOkfCore,
  type OkfCore,
} from '../../../src/core/wasm/index.js';
import {
  AGENT_SKILL_PATH,
  CONCEPT_TEMPLATES,
  renderAgentSkill,
  renderAgentsManagedBlock,
  renderBundlePreset,
  renderConceptTemplate,
} from '../../../src/core/templates/index.js';
import { OKF_SEMANTIC_LIMITS } from '../../../src/core/model/index.js';
import type { ParseBundleInput } from '../../../src/core/parser/index.js';
import { loadFixture, readFixtureFiles } from '../../helpers/fixtures.js';

const fixtureNames = [
  'broken-links',
  'curation',
  'custom-metadata',
  'invalid-documents',
  'minimal-valid',
  'nested-links',
  'path-portability',
  'reserved-documents',
  'yaml-standard-tags',
];
let core: OkfCore;

beforeAll(() => {
  execFileSync(
    'cargo',
    [
      'build',
      '--locked',
      '--target',
      'wasm32-unknown-unknown',
      '--release',
      '--package',
      'okf-wasm',
    ],
    { stdio: 'pipe' },
  );
  core = createWasmOkfCore(
    readFileSync(resolve('target/wasm32-unknown-unknown/release/okf_wasm.wasm')),
  );
}, 60_000);

describe('Rust/Wasm core boundary', () => {
  test('is capability-free and reports the versioned ABI', () => {
    const bytes = readFileSync(resolve('target/wasm32-unknown-unknown/release/okf_wasm.wasm'));
    const module = new WebAssembly.Module(bytes);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    expect(core.abiVersion).toBe(1);
    expect(core.coreVersion).toBe('0.2.1');
  });

  test.each(fixtureNames)('%s preserves the canonical semantic projection', async (name) => {
    const fixture = await loadFixture(name);
    const files = await readFixtureFiles(fixture);
    const entries = [...files.entries()].sort(([left], [right]) => left.localeCompare(right));
    const rootUri = `fixture:/${encodeURIComponent(name)}`;
    const pathByUri = new Map(
      entries.map(([path]) => [
        `${rootUri}/${path.split('/').map(encodeURIComponent).join('/')}`,
        path,
      ]),
    );
    const inspection = core.inspect(
      {
        rootUri,
        revision: 7,
        documents: entries.map(([bundlePath, content]) => ({
          bundlePath,
          content,
          uri: `${rootUri}/${bundlePath.split('/').map(encodeURIComponent).join('/')}`,
        })),
      },
      '2026-07-22T12:00:00Z',
    );
    const oracle = typescriptOkfCore.inspect(inputFor(entries, rootUri), '2026-07-22T12:00:00Z');

    expect(inspection).toEqual(oracle);

    expect(inspection.bundle.concepts.map(({ id }) => id)).toEqual(
      fixture.manifest.expected.conceptIds,
    );
    expect(inspection.bundle.reservedDocuments.map(({ source }) => source.bundlePath)).toEqual(
      fixture.manifest.expected.reservedFiles,
    );
    expect(
      inspection.bundle.failures.map(({ uri, reason }) => ({
        path: pathByUri.get(uri),
        reason,
      })),
    ).toEqual(fixture.manifest.expected.parseFailures);
    expect(
      inspection.findings.map(({ uri, category, code }) => ({
        category,
        code,
        path: pathByUri.get(uri),
      })),
    ).toEqual(fixture.manifest.expected.findings);
    expect(
      inspection.bundle.concepts.flatMap(({ links }) =>
        links.map(({ sourceId, rawTarget, classification, targetId, fragment, query }) => ({
          sourceId,
          rawTarget,
          kind: classification,
          ...(targetId === undefined ? {} : { targetId }),
          ...(fragment === undefined ? {} : { fragment }),
          ...(query === undefined ? {} : { query }),
        })),
      ),
    ).toEqual(fixture.manifest.expected.links);
    if (fixture.manifest.expected.frontmatterByConceptId !== undefined) {
      expect(
        Object.fromEntries(
          Object.keys(fixture.manifest.expected.frontmatterByConceptId).map((conceptId) => [
            conceptId,
            inspection.bundle.concepts.find(({ id }) => id === conceptId)?.frontmatter.raw,
          ]),
        ),
      ).toEqual(fixture.manifest.expected.frontmatterByConceptId);
    }
    expect(inspection.graph.revision).toBe(7);
    expect(inspection.graph.statistics.conceptCount).toBe(
      fixture.manifest.expected.conceptIds.length,
    );
  });

  test('rejects a corrupted module instead of falling back', () => {
    expect(() => createWasmOkfCore(Uint8Array.from([0, 1, 2]))).toThrow('not valid WebAssembly');
  });

  test('returns malformed ABI requests as bounded data and remains reusable', () => {
    const bytes = readFileSync(resolve('target/wasm32-unknown-unknown/release/okf_wasm.wasm'));
    const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
    const exports = instance.exports as unknown as {
      readonly memory: WebAssembly.Memory;
      readonly okf_alloc: (length: number) => number;
      readonly okf_call: (pointer: number, length: number) => bigint;
      readonly okf_dealloc: (pointer: number, length: number) => void;
    };
    const invalid = Uint8Array.from([0xff]);
    const pointer = exports.okf_alloc(invalid.byteLength);
    new Uint8Array(exports.memory.buffer, pointer, invalid.byteLength).set(invalid);
    const packed = exports.okf_call(pointer, invalid.byteLength);
    const responsePointer = Number(packed >> 32n);
    const responseLength = Number(packed & 0xffff_ffffn);
    const response = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        new Uint8Array(exports.memory.buffer, responsePointer, responseLength),
      ),
    ) as { readonly error?: { readonly code?: unknown } };
    exports.okf_dealloc(responsePointer, responseLength);

    expect(response.error?.code).toBe('invalid-request');
    expect(core.renderBundle('minimal', '2026-07-24T12:34:56Z')).toHaveLength(1);
  });

  test('reuses allocations across repeated requests without unbounded memory growth', () => {
    const bytes = readFileSync(resolve('target/wasm32-unknown-unknown/release/okf_wasm.wasm'));
    const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
    const exports = instance.exports as unknown as {
      readonly memory: WebAssembly.Memory;
      readonly okf_alloc: (length: number) => number;
      readonly okf_call: (pointer: number, length: number) => bigint;
      readonly okf_dealloc: (pointer: number, length: number) => void;
    };
    const request = new TextEncoder().encode('{"operation":"metadata"}');
    const initialMemoryBytes = exports.memory.buffer.byteLength;
    for (let index = 0; index < 500; index += 1) {
      const pointer = exports.okf_alloc(request.byteLength);
      new Uint8Array(exports.memory.buffer, pointer, request.byteLength).set(request);
      const packed = exports.okf_call(pointer, request.byteLength);
      const responsePointer = Number(packed >> 32n);
      const responseLength = Number(packed & 0xffff_ffffn);
      expect(responseLength).toBeGreaterThan(0);
      exports.okf_dealloc(responsePointer, responseLength);
    }
    expect(exports.memory.buffer.byteLength).toBeLessThanOrEqual(initialMemoryBytes + 65_536);

    const input = inputFor(
      [
        ['index.md', ['---', 'okf_version: "0.1"', '---', '# Root', ''].join('\n')],
        ['concept.md', concept('# Concept\n')],
      ],
      'fixture:/abi-lifecycle',
    );
    for (let index = 0; index < 500; index += 1) {
      expect(core.inspect(input, '2026-07-22T12:00:00Z').graph.revision).toBe(7);
    }
    const second = createWasmOkfCore(bytes);
    expect(second.inspect(input, '2026-07-22T12:00:00Z')).toEqual(
      core.inspect(input, '2026-07-22T12:00:00Z'),
    );
  });

  test.each(['minimal', 'software-project', 'data-analytics'] as const)(
    'bundle preset %s is byte-identical to the migration oracle',
    (preset) => {
      const timestamp = '2026-07-24T12:34:56Z';
      const oracle = renderBundlePreset({ preset, timestamp });
      if (!oracle.ok) throw new Error('TypeScript oracle refused a built-in preset.');
      expect(core.renderBundle(preset, timestamp)).toEqual(oracle.value);
    },
  );

  test.each(CONCEPT_TEMPLATES)(
    'concept template %s is byte-identical to the migration oracle',
    (template) => {
      const input = {
        template,
        relativePath: 'nested/example.md',
        type: 'custom-type',
        title: 'Example concept',
        description: 'A deterministic generated concept.',
        tags: ['one', '日本語'],
        timestamp: '2026-07-24T12:34:56Z',
      };
      const oracle = renderConceptTemplate(input);
      if (!oracle.ok) throw new Error('TypeScript oracle refused a built-in template.');
      expect(core.renderConcept(input)).toEqual(oracle.value);
    },
  );

  test('concept template whitespace and unsafe paths match the TypeScript oracle', () => {
    const input = {
      template: 'generic-concept' as const,
      relativePath: 'nested/example.md',
      type: ' custom-type ',
      title: 'Example\r\nconcept',
      description: ' first\rsecond ',
      tags: [' one ', '日本語'],
      timestamp: '2026-07-24T12:34:56Z',
    };
    const oracle = renderConceptTemplate(input);
    if (!oracle.ok) throw new Error('TypeScript oracle refused valid template metadata.');
    expect(core.renderConcept(input)).toEqual(oracle.value);

    for (const relativePath of [
      '../escape.md',
      '%2e%2e/escape.md',
      'safe/%252e%252e/escape.md',
      '/absolute.md',
      'https://example.test/concept.md',
      'index.md',
      '.md',
      'bad%ZZ.md',
      'empty//segment.md',
      'control\u0085.md',
    ]) {
      const unsafe = { ...input, relativePath };
      expect(() => core.renderConcept(unsafe), relativePath).toThrow();
      expect(renderConceptTemplate(unsafe).ok, relativePath).toBe(false);
    }
    const encoded = { ...input, relativePath: 'nested/hello%20world.md' };
    const encodedOracle = renderConceptTemplate(encoded);
    if (!encodedOracle.ok) throw new Error('TypeScript oracle refused a valid encoded path.');
    expect(core.renderConcept(encoded)).toEqual(encodedOracle.value);
  });

  test('agent templates are byte-identical to the migration oracle', () => {
    const agents = renderAgentsManagedBlock('knowledge');
    const skill = renderAgentSkill('knowledge');
    if (!agents.ok || !skill.ok) throw new Error('TypeScript oracle refused agent templates.');
    expect(core.renderAgent('both', 'knowledge')).toEqual([
      { relativePath: 'AGENTS.md', encoding: 'utf8', content: agents.value },
      { relativePath: AGENT_SKILL_PATH, encoding: 'utf8', content: skill.value },
    ]);
  });

  test.each(fixtureNames)(
    '%s index rendering is byte-identical to the migration oracle',
    async (name) => {
      const fixture = await loadFixture(name);
      const files = await readFixtureFiles(fixture);
      const rootUri = `fixture:/${encodeURIComponent(name)}`;
      const input = {
        rootUri,
        revision: 1,
        documents: [...files.entries()].map(([bundlePath, content]) => ({
          bundlePath,
          content,
          uri: `${rootUri}/${bundlePath.split('/').map(encodeURIComponent).join('/')}`,
        })),
      };
      expect(core.renderIndexes(input, 'all')).toEqual(
        typescriptOkfCore.renderIndexes(input, 'all'),
      );
    },
  );

  test('missing index rendering and multiline metadata match the TypeScript oracle', () => {
    const rootUri = 'fixture:/index-parity';
    const input = inputFor(
      [
        ['index.md', ['---', 'okf_version: "0.2"', '---', '# Existing', ''].join('\n')],
        ['a.md', concept('', ['title: "A', '  B"', 'description: "D', '  E"', ''].join('\n'))],
      ],
      rootUri,
    );
    expect(core.renderIndexes(input, 'missing')).toEqual(
      typescriptOkfCore.renderIndexes(input, 'missing'),
    );
  });

  test('index ordering uses JavaScript UTF-16 code-unit order', () => {
    const rootUri = 'fixture:/index-order';
    const input = inputFor(
      [
        ['😀.md', concept('')],
        ['\uE000.md', concept('')],
      ],
      rootUri,
    );
    expect(core.renderIndexes(input, 'all')).toEqual(typescriptOkfCore.renderIndexes(input, 'all'));
  });

  test('failed graph sources and duplicate tag statistics match the TypeScript oracle', () => {
    const rootUri = 'fixture:/graph-parity';
    const input = inputFor(
      [
        [
          'a.md',
          concept(
            '[Missing](missing.md)\n',
            [
              'title: Failed metadata',
              'tags: [x, x]',
              'generated: { by: process:test, at: 2026-07-22T11:00:00Z }',
              'stale_after: 2026-09-23',
              '',
            ].join('\n'),
          ),
        ],
      ],
      rootUri,
    );
    const healthy = core.inspect(input, '2026-07-22T12:00:00Z');
    expect(healthy.graph.statistics.tagCounts).toEqual({ x: 1 });
    const failure = {
      kind: 'parse-failure' as const,
      uri: `${rootUri}/a.md`,
      bundlePath: 'a.md',
      reason: 'read' as const,
      message: 'Injected provider failure.',
    };
    const failures = [failure];
    expect(core.inspect(input, '2026-07-22T12:00:00Z', failures)).toEqual(
      typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z', failures),
    );
    const unrelatedFailure = [{ ...failure, uri: `${rootUri}/other-a.md` }];
    expect(core.inspect(input, '2026-07-22T12:00:00Z', unrelatedFailure)).toEqual(
      typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z', unrelatedFailure),
    );
    const normalizedFailure = [{ ...failure, bundlePath: './a.md' }];
    expect(core.inspect(input, '2026-07-22T12:00:00Z', normalizedFailure)).toEqual(
      typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z', normalizedFailure),
    );
  });

  test('validation quoting, ordering, trimming, and date-only reference times match', () => {
    const rootUri = 'fixture:/validation-edge-parity';
    const longId = `${'a'.repeat(158)}😀b`;
    const input = inputFor(
      [
        ['index.md', ['---', 'okf_version: "\\0"', '---', '# Root', ''].join('\n')],
        ['z.md', concept('', 'resource: " urn:shared "\nstale_after: 2026-07-31\n')],
        ['😀.md', concept('', 'resource: urn:shared\n')],
        ['\uE000.md', concept('', 'resource: urn:shared\n')],
        ['feff-a.md', concept('', 'resource: "\\uFEFFurn:feff"\n')],
        ['feff-b.md', concept('', 'resource: urn:feff\n')],
        [`${longId}.md`, concept('', 'resource: urn:long\n')],
        ['long-peer.md', concept('', 'resource: urn:long\n')],
      ],
      rootUri,
    );
    expect(core.inspect(input, '2026-07-31')).toEqual(
      typescriptOkfCore.inspect(input, '2026-07-31'),
    );
    expect(core.inspect(input, '2026-07-31T00:00:00+0000')).toEqual(
      typescriptOkfCore.inspect(input, '2026-07-31T00:00:00+0000'),
    );
    expect(() => core.inspect(input, 'not-a-date')).toThrow();
    expect(() => typescriptOkfCore.inspect(input, 'not-a-date')).toThrow();
  });

  test('usage counts require a valid local or shared usage window', () => {
    const rootUri = 'fixture:/usage-window';
    const input = inputFor(
      [
        [
          'missing.md',
          concept('', 'sources: [{ resource: https://example.com/source, usage_count: 42 }]\n'),
        ],
        [
          'shared.md',
          concept(
            '',
            [
              'usage_window: { from: 2026-07-01, to: 2026-07-31 }',
              'sources: [{ resource: https://example.com/source, usage_count: 42 }]',
              '',
            ].join('\n'),
          ),
        ],
      ],
      rootUri,
    );
    const inspection = core.inspect(input, '2026-07-22T12:00:00Z');
    expect(inspection).toEqual(typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z'));
    expect(
      inspection.findings.some(
        (finding) =>
          finding.uri.endsWith('/missing.md') && finding.code === 'okf.curation.invalid-sources',
      ),
    ).toBe(true);
    expect(
      inspection.findings.some(
        (finding) =>
          finding.uri.endsWith('/shared.md') && finding.code === 'okf.curation.invalid-sources',
      ),
    ).toBe(false);
  });

  test('adversarial YAML lexical contexts match the TypeScript oracle', () => {
    const cases = [
      ['quoted-flow-shape.md', 'literal: "[|]"\n'],
      ['block-flow-shape.md', 'literal: |-\n  [|]\n'],
      ['plain-fake-anchor.md', 'literal: prefix &a suffix\nbefore: *a\n'],
      ['quoted-fake-set.md', 'literal: "!!set { ? a: b }"\n'],
      ['escaped-quoted-fake-duplicate-set.md', 'literal: "x \\" y: !!set { ? x, ? x }"\n'],
      ['escaped-quoted-fake-mapping-set.md', 'literal: "x \\" y: !!set { ? a: b }"\n'],
      ['block-fake-set.md', 'literal: |-\n  !!set { ? x, ? x }\n'],
      ['quoted-nested-tag.md', 'x: !!set { ? &a [!!int "1"] }\ncopy: *a\n'],
      [
        'cross-member-nested-set.md',
        'outer: !!set\n  ? {value: &a !!str one}\n  ? !!set\n    ? {copy: *a}\noutside: *a\n',
      ],
      [
        'deep-cross-member-nested-set.md',
        'outer: !!set\n  ? {value: &a !!str one}\n  ? !!set\n    ? !!set\n      ? {copy: *a}\noutside: *a\n',
      ],
      [
        'anchored-mapping-nested-timestamp.md',
        'set: !!set\n  ? &m {outer: {time: !!timestamp 2001-2-3T4:5:6Z}}\ncopy: *m\n',
      ],
      [
        'anchored-nested-set-copy.md',
        'outer: !!set\n  ? &s !!set\n    ? {key: !!str one}\ncopy: *s\n',
      ],
      [
        'shadowed-sequence-anchor-in-set.md',
        'first: &a [!!str old]\nset: !!set\n  ? &a {key: !!int "2"}\nafter: *a\n',
      ],
      ['trailing-comment-field-range.md', 'sets:\n  - !!set\n    ? x\n  # trailing\n'],
      ['invalid-deferred-block-in-flow.md', 'outer: [!!set\n  ? {key: &a !!str one}\n]\n'],
      ['explicit-tagged-string-key.md', '? !!str key\n: value\n'],
      ['deep-block-set-tag-source.md', 'x: !!set\n  ? [nested: { key: !!int &a "1" }]\ncopy: *a\n'],
      [
        'deep-block-set-reversed-tag-source.md',
        'x: !!set\n  ? [nested: { key: &a !!int "1" }]\ncopy: *a\n',
      ],
      [
        'block-set-parent-sibling-boundary.md',
        'items:\n  - value: !!set\n      ?\n        - a\n      ?\n        - a\n    sibling: yes\n',
      ],
      ['single-deferred-collection-member.md', 'x: !!set\n  ?\n    nested:\n      key: value\n'],
      ['c1-control-type.md', 'type: "\\u0085"\n'],
      ['c1-control-resource.md', 'resource: "\\u0085urn:x"\n'],
      ['bom-trim-type.md', 'type: "\\uFEFF"\n'],
    ] as const;
    for (const [path, fields] of cases) {
      const rootUri = `fixture:/yaml-parity/${path}`;
      const input = inputFor([[path, concept('', fields)]], rootUri);
      expect(core.inspect(input, '2026-07-22T12:00:00Z'), path).toEqual(
        typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z'),
      );
    }
  });

  test.each([
    {
      name: 'all link-resolution classifications and reference forms',
      documents: [
        [
          'topics/source.md',
          concept(
            [
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
              '[Full reference][target]',
              '[Collapsed][]',
              '[shortcut]',
              '',
              '[target]: ./nested/target.md',
              '[collapsed]: ./nested/target.md#collapsed',
              '[shortcut]: ./nested/target.md?from=shortcut',
              '',
            ].join('\n'),
          ),
        ],
        ['topics/nested/target.md', concept('# Target\n')],
        ['topics/nested/index.md', '# Nested\n'],
        ['shared/日本 語.md', concept('# 日本語\n')],
      ],
    },
    {
      name: 'CR-only frontmatter, body, and source ranges',
      documents: [
        [
          'cr-only.md',
          [
            '---',
            'type: reference',
            'title: CR only',
            '---',
            '# Body',
            '',
            '[Target](./target.md)',
          ].join('\r'),
        ],
        ['target.md', concept('# Target\n')],
      ],
    },
    {
      name: 'one BOM for text and bytes',
      documents: [
        ['text.md', `\uFEFF${concept('# Text 😀\n', 'title: Text 😀\n')}`],
        [
          'bytes.md',
          new TextEncoder().encode(`\uFEFF${concept('# Bytes 😀\n', 'title: Bytes 😀\n')}`),
        ],
      ],
    },
    {
      name: 'explicit standard tags reached through aliases',
      documents: [
        [
          'index.md',
          [
            '---',
            'version_anchor: &version !!str 0.1',
            'okf_version: *version',
            '---',
            '# Root',
            '',
          ].join('\n'),
        ],
        [
          'aliased-type.md',
          [
            '---',
            'type_anchor: &type !!str reference',
            'type: *type',
            'title: Aliased type',
            '---',
            '# Body',
            '',
          ].join('\n'),
        ],
      ],
    },
    {
      name: 'tag-shaped producer mappings are not trusted as provenance',
      documents: [
        [
          'index.md',
          [
            '---',
            'okf_version:',
            '  $okf-workbench:yaml-tag:',
            '    tag: tag:yaml.org,2002:str',
            '    value: "0.1"',
            '    source: "0.1"',
            '---',
            '# Root',
            '',
          ].join('\n'),
        ],
        [
          'spoofed.md',
          [
            '---',
            'fake_type: &fake-type',
            '  $okf-workbench:yaml-tag:',
            '    tag: tag:yaml.org,2002:str',
            '    value: reference',
            '    source: reference',
            'type: *fake-type',
            '---',
            '# Body',
            '',
          ].join('\n'),
        ],
      ],
    },
    {
      name: 'block and flow provenance scanner boundaries',
      documents: [
        [
          'boundaries.md',
          [
            '---',
            'type: reference',
            'tags:',
            '- &tag-anchor !!str "x"',
            'tag_copy: *tag-anchor',
            'sequence:',
            '  - &key-anchor key: value',
            'key_copy: *key-anchor',
            'meta: { "a:b" : !!str "x" }',
            'flow_tags: [',
            '  !!str "x", # first',
            '  !!str "y"',
            ']',
            'items:',
            '  -',
            '    child: !!str "x"',
            '? "explicit:block"',
            ': !!str "block"',
            'flow_explicit: { ? "explicit:flow" : !!str "flow" }',
            'flow_plain: { a:b: !!str "plain" }',
            'old: &shadow !!str "old"',
            '&shadow key: value',
            'shadow_copy: *shadow',
            'flow_old: &flow-shadow !!str "old"',
            'flow_mapping: { &flow-shadow key: value }',
            'flow_shadow_copy: *flow-shadow',
            '"/foo": &slash-anchor !!str "slash"',
            'slash_copy: *slash-anchor',
            '? >-',
            '  explicit-multiline',
            ': !!str "multiline key"',
            'bare_tags:',
            '  -',
            '    &bare-anchor !!str "bare"',
            'bare_copy: *bare-anchor',
            'groups:',
            '  - group:',
            '      child: !!str "one"',
            '  - !!str "two"',
            'explicit_items:',
            '  - ? key',
            '    : !!str "value"',
            'flow_plain_comments: [!!str first # comment',
            '  , !!str second]',
            'flow_comment_delimiter: [!!str "first" # ] ignored',
            '  , !!str "second"]',
            'multiline_plain: !!str first',
            '  second',
            'multiline_dash_plain: !!str first',
            '  - second',
            'multiline_quoted: !!str "first',
            '  second"',
            'untagged_multiline: first',
            '  second',
            'next_line_scalar: !!str',
            '  x',
            'tag_after_comment: !!str # comment',
            '  "comment value"',
            'tag_comment_line: !!str',
            '  # comment-only',
            '  "comment line value"',
            'next_block_scalar: !!str',
            '  |',
            '    hi',
            'next_flow_sequence: !!seq',
            '  [a, b]',
            'next_flow_mapping: !!map',
            '  {a: b}',
            'tab_comment: !!str tabbed\t# comment',
            '? |-',
            '  : explicit-key-content',
            ': !!str "block key"',
            '?',
            '  newline-explicit',
            ': !!str "newline key"',
            'non_string_shape: |',
            '  ? [one, two]',
            '? |-',
            '  type: !!str evil',
            '  ? [one, two]',
            '  { x: 1, x: 2 }',
            ': explicit scalar key',
            'quoted_shape: "first',
            '  type: !!str evil"',
            'flow_shape: {',
            '  type: !!str "evil"',
            '}',
            'split_anchor_tag: &split-anchor # comment',
            '  !!str "split value"',
            'split_anchor_copy: *split-anchor',
            'split_tag_anchor: !!str',
            '  # comment',
            '  &split-reverse "reverse value"',
            'split_reverse_copy: *split-reverse',
            'tagged_timestamp: !!timestamp "2026-07-22T12:00:00Z"',
            'tagged_offset_timestamp: !!timestamp "2026-07-22T12:00:00+09:00"',
            'tagged_date: !!timestamp 2026-07-22',
            'tagged_space_offset: !!timestamp 2001-12-14 21:59:43.10 -05:00',
            'tagged_space_local: !!timestamp 2001-12-15 2:59:43.10',
            'tagged_short_offset: !!timestamp 2001-12-14 21:59:43.10 -5',
            'tagged_hour_offset: !!timestamp 2001-12-14T21:59:43+05',
            'tagged_single_digit_timestamp: !!timestamp 2001-2-3T4:5:6Z',
            'tagged_tab_timestamp: !!timestamp 2001-12-14\t21:59:43Z',
            'tagged_overflow_date: !!timestamp 2001-13-32',
            'tagged_overflow_time: !!timestamp 2001-12-15T24:61:61Z',
            'tagged_overflow_offset: !!timestamp 2001-12-15T00:00:00+29:99',
            'tagged_zero_year: !!timestamp 0000-01-01',
            'tagged_binary: !!binary |',
            '  SGVsbG8=',
            'tagged_wrapped_binary: !!binary |',
            '  SGVs',
            '  bG8=',
            'tagged_loose_binary: !!binary not-base64!',
            'tagged_narrow_binary: !!binary "SGVs bG8="',
            'tagged_bom_binary: !!binary "SGVs﻿bG8="',
            'tagged_zero_width_binary: !!binary "SGVs​bG8="',
            'tagged_astral_binary: !!binary "SGVs🙁bG8="',
            'tagged_float: !!float .inf',
            'tagged_invalid_bool: !!bool nope',
            'tagged_invalid_int: !!int nope',
            'tagged_invalid_float: !!float nope',
            'tagged_invalid_null: !!null nope',
            'tagged_quoted_bool: !!bool "false"',
            'tagged_quoted_int: !!int "42"',
            'semantic_set: !!set',
            '  ? true',
            '  ? [a, b]',
            '  ? alpha',
            'commented_semantic_set: !!set # comment',
            '  ? true',
            'tagged_member_set: !!set',
            '  ? !!str true',
            '  ? !!int nope',
            'deferred_tagged_member_set: !!set',
            '  ? !!str',
            '    deferred',
            'nested_member_set: !!set',
            '  ? [!!set { ? }, !!set { ? true }]',
            'sibling_set_a: !!set',
            '  ?',
            'sibling_set_b: !!set',
            '  ?',
            'sequence_sibling_sets:',
            '  - !!set',
            '    ?',
            '  - !!set',
            '    ?',
            'sequence_complex_sets:',
            '  - !!set',
            '    ? {a: b}',
            '  - deep:',
            '      set: !!set',
            '        ? [x, {y: z}]',
            'deferred_flow_set: !!set # comment',
            '  { ? true }',
            'outer_complex_flow_key_set: !!set { ? { inner: !!set { ? a } } }',
            'nested_shadow_seed: &nested-shadow !!str old',
            'nested_shadow_set: !!set { ? !!set { ? {key: &nested-shadow !!int "2"} } }',
            'nested_shadow_copy: *nested-shadow',
            'anchored_nested_block_set: !!set',
            '  ? &nested-set !!set',
            '    ? {key: &nested-member !!str one}',
            'anchored_nested_set_copy: *nested-set',
            'anchored_nested_member_copy: *nested-member',
            'cross_member_set: !!set',
            '  ? {key: &cross-member !!str one}',
            '  ? {copy: *cross-member}',
            'cross_member_copy: *cross-member',
            'verbatim_string_member_set: !!set { ? !<tag:yaml.org,2002:str> true }',
            'verbatim_scalar_member_set: !!set { ? !<tag:yaml.org,2002:int> "42", ? !<tag:yaml.org,2002:bool> "false" }',
            'underscore_distinct_set: !!set { ? 1000, ? 1_000 }',
            'large_integer_set: !!set { ? 999999999999999999999999, ? 1000000000000000000000000 }',
            'schema_distinct_set: !!set { ? 5, ? 0b101, ? -16, ? -0x10 }',
            'leading_zero_integer: 0000000000000000000000000000000000000000000001',
            'uppercase_radix_set: !!set { ? 1, ? 0X1 }',
            'explicit_schema_distinct_set: !!set { ? !!int 5, ? !!int 0b101, ? !!int -16, ? !!int -0x10 }',
            'explicit_large_integer: !!int "340282366920938463463374607431768211456"',
            'anchored_infinity: !!float &anchored-infinity .inf',
            'anchored_infinity_copy: *anchored-infinity',
            'verbatim_anchored_infinity: !<tag:yaml.org,2002:float> &verbatim-infinity .inf',
            'verbatim_anchored_infinity_copy: *verbatim-infinity',
            'deferred_infinity: !!float',
            '  .inf',
            'deferred_anchored_infinity: !!float',
            '  &deferred-infinity .inf',
            'deferred_anchored_infinity_copy: *deferred-infinity',
            'integer_looking_float: !!float 1',
            'anchored_null: &anchored-null !!null ""',
            'anchored_null_copy: *anchored-null',
            'tagged_alias_seed: &tagged-alias !!str "x"',
            'tagged_alias_set: !!set { ? *tagged-alias, ? *tagged-alias }',
            'tagged_alias_direct_set: !!set { ? *tagged-alias, ? !!str "x" }',
            'identity_timestamp_set: !!set { ? !!timestamp 2026-07-22, ? !!timestamp "2026-07-22" }',
            'identity_binary_set: !!set { ? !!binary SGVsbG8=, ? !!binary "SGVsbG8=" }',
            'repeated_collection_member_set: !!set { ? [a, b], ? [a,b] }',
            'repeated_deferred_sequence_member_set: !!set',
            '  ?',
            '    - a',
            '  ?',
            '    - a',
            'repeated_deferred_mapping_member_set: !!set',
            '  ?',
            '    a: b',
            '  ?',
            '    a: b',
            'outer_nested_block_set: !!set',
            '  ? nested:',
            '      child: value',
            'duplicate_alias_seed: &duplicate-alias value',
            'duplicate_alias_set: !!set { ? *duplicate-alias, ? *duplicate-alias }',
            'tag_anchor_set: !!set &tag-anchor-set { ? *duplicate-alias }',
            '!!str true: value',
            'quoted_comment_range: !!str "one',
            '  two" # comment',
            'quoted_scanner_shapes: "first',
            '  ? [one, two]',
            '  x: one',
            '  x: two',
            '  last"',
            'direct_anchor: &direct-shadow !!str "real"',
            'direct_quoted:',
            '  - "first',
            '    &direct-shadow !!str fake"',
            'direct_anchor_copy: *direct-shadow',
            'plain_question: question ? *missing text',
            'alias_member: &alias-member member',
            'commented_flow_sequence: [',
            '  a,',
            '] # closing comment',
            'commented_flow_map: {',
            '  a: b,',
            '} # closing comment',
            'multiline_plain_comment: !!str one',
            '  two # comment',
            'multiline_plain_flow_shape: plain',
            '  [a,',
            '  b]',
            'plain_closing_bracket_hash: abc]#def',
            'plain_closing_brace_hash: abc}#def',
            'hash_anchor: &hash-anchor#suffix value',
            'tight_flow_plain: {a:#bad',
            '  b: c}',
            'block_scalar_flow_shape: |',
            '  fake: [a,',
            '  b]',
            'block_scalar_invalid_tag_text: |',
            '  !!bool nope',
            'sequence_split_properties:',
            '  - !!str # comment',
            '    &sequence-split "x"',
            'sequence_split_copy: *sequence-split',
            'sequence_reverse_properties:',
            '  - &sequence-reverse # comment',
            '    !!str "y"',
            'sequence_reverse_copy: *sequence-reverse',
            'sequence_block_set:',
            '  - !!set # comment',
            '    ? true',
            'flow_set_member: &flow-set-member alpha',
            'tagged_flow_set: !!set { ? *flow-set-member }',
            'lookalike_nested:',
            '  $okf-workbench:yaml-tag:',
            '    tag: tag:yaml.org,2002:str',
            '    value:',
            '      child: &lookalike-child !!str "x"',
            '    source: producer',
            'lookalike_child_copy: *lookalike-child',
            'tagged_lookalike: !!map',
            '  $okf-workbench:yaml-tag:',
            '    tag: tag:yaml.org,2002:str',
            '    value:',
            '      child: "x"',
            '    source: producer',
            'outer_tagged_lookalike: !!map',
            '  $okf-workbench:yaml-tag:',
            '    tag: tag:yaml.org,2002:str',
            '    value:',
            '      child: &outer-lookalike-child !!str "x"',
            '    source: producer',
            'outer_lookalike_copy: *outer-lookalike-child',
            'literal_anchor: &literal-shadow !!str "real"',
            'literal_shapes: |',
            '  type: !!str evil',
            '  fake: &literal-shadow !!str "fake"',
            'literal_anchor_copy: *literal-shadow',
            '---',
            '# Boundaries',
            '',
          ].join('\n'),
        ],
      ],
    },
    {
      name: 'custom tags and non-string mapping keys fail as data',
      documents: [
        ['custom-tag.md', concept('', 'producer: !runtime-object value\n')],
        [
          'non-string-key.md',
          ['---', 'type: reference', 'producer:', '  ? [one, two]', '  : value', '---', ''].join(
            '\n',
          ),
        ],
        ['valid.md', concept('# Valid\n')],
      ],
    },
    {
      name: 'duplicate keys and non-canonical closing delimiter fail independently',
      documents: [
        ['duplicate.md', ['---', 'type: note', 'type: reference', '---', ''].join('\n')],
        ['flow-duplicate.md', ['---', '{ type: note, type: reference }', '---', ''].join('\n')],
        ['nested-flow-duplicate.md', ['---', 'outer: { x: 1, x: 2 }', '---', ''].join('\n')],
        ['sequence-flow-duplicate.md', ['---', 'items: [{ x: 1, x: 2 }]', '---', ''].join('\n')],
        [
          'block-sequence-duplicate.md',
          ['---', 'items:', '  - x: 1', '    x: 2', '---', ''].join('\n'),
        ],
        [
          'block-scalar-and-duplicate.md',
          [
            '---',
            'description: |',
            '  { x: 1, x: 2 }',
            'type: note',
            'type: reference',
            '---',
            '',
          ].join('\n'),
        ],
        [
          'sequence-block-scalar-and-duplicate.md',
          [
            '---',
            'items:',
            '  - |',
            '    { x: 1, x: 2 }',
            'type: note',
            'type: reference',
            '---',
            '',
          ].join('\n'),
        ],
        [
          'block-scalar-lines-and-duplicate.md',
          [
            '---',
            'note: |',
            '  x: one',
            '  x: two',
            'type: note',
            'type: reference',
            '---',
            '',
          ].join('\n'),
        ],
        [
          'multiline-explicit-duplicate.md',
          ['---', '? >-', '  type', ': one', '? "type"', ': two', '---', ''].join('\n'),
        ],
        [
          'explicit-duplicate.md',
          ['---', '? "type"', ': note', '? "type"', ': reference', '---', ''].join('\n'),
        ],
        ['document-end.md', ['---', 'type: reference', '...', '# Not a delimiter', ''].join('\n')],
        ['valid.md', concept('# Valid\n')],
      ],
    },
  ])('$name matches the TypeScript semantic oracle', ({ documents }) => {
    const rootUri = 'fixture:/adversarial';
    const entries = documents as unknown as readonly (readonly [string, string | Uint8Array])[];
    const input = inputFor(entries, rootUri);
    expect(core.inspect(input, '2026-07-22T12:00:00Z')).toEqual(
      typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z'),
    );
  });

  test.each([
    {
      name: 'reserved-document structure, location, and version rules',
      documents: [
        ['index.md', ['---', 'okf_version: "0.2"', '---', 'plain text only', ''].join('\n')],
        [
          'area/index.md',
          ['---', 'title: Nested frontmatter is forbidden', '---', '# Area', ''].join('\n'),
        ],
        ['log.md', ['# Log', '', '## 2026-02-30', 'entry', ''].join('\n')],
        ['area/log.md', ['# Nested log without date', ''].join('\n')],
        ['valid.md', concept('# Valid\n', 'title: Valid\ndescription: Complete\n')],
      ],
    },
    {
      name: 'concept conformance and timestamp curation boundaries',
      documents: [
        ['index.md', ['---', 'okf_version: "0.1"', '---', '# Root', ''].join('\n')],
        [
          'missing-type.md',
          ['---', 'type: "   "', 'title: "   "', 'description: ""', '---', ''].join('\n'),
        ],
        [
          'bad-timestamp.md',
          concept('', 'title: Bad\ndescription: Bad timestamp\ntimestamp: 2026-07-22\n'),
        ],
        [
          'future.md',
          concept(
            '',
            'title: Future\ndescription: Future timestamp\ntimestamp: "2026-07-22T12:05:00.001Z"\n',
          ),
        ],
        [
          'tolerance.md',
          concept(
            '',
            'title: Tolerance\ndescription: Exact tolerance\ntimestamp: "2026-07-22T12:05:00Z"\n',
          ),
        ],
      ],
    },
    {
      name: 'OKF v0.2 trust, lifecycle, provenance, and attested computation',
      documents: [
        ['index.md', ['---', 'okf_version: "0.2"', '---', '# Root', ''].join('\n')],
        [
          'revenue.md',
          concept(
            '# Computation\n\n```sql\nSELECT @year\n```\n',
            [
              'title: Revenue',
              'description: Sanctioned revenue computation',
              'generated: { by: process:okf-workbench, at: 2026-07-22T11:00:00Z }',
              'verified: { by: human:reviewer, at: 2026-07-22T11:30:00Z }',
              'status: stable',
              'stale_after: 2026-09-23',
              'sources: [{ id: policy, resource: https://example.com/policy }]',
              'runtime: bigquery',
              'parameters: [{ name: year, type: integer, required: true }]',
              'executor: { resource: references/run.md, receipt: [job_id, result] }',
              'attester: { resource: references/attest.py }',
              '',
            ].join('\n'),
            'Attested Computation',
          ),
        ],
        [
          'nested-tags.md',
          concept(
            '',
            [
              'generated:',
              '  by: !!str process:builder',
              '  at: !!str 2026-07-22T11:00:00Z',
              'verified:',
              '  - by: !!str human:reviewer',
              '    at: !!str 2026-07-22T11:30:00Z',
              'sources:',
              '  - resource: !!str https://example.com/source',
              '    author: !!str process:catalog',
              '    usage_count: 42.0',
              '',
            ].join('\n'),
            'Reference',
          ),
        ],
        [
          'shifted-tags.md',
          concept(
            '',
            [
              'verified:',
              '  - invalid',
              '  - by: !!str human:reviewer',
              '    at: !!str 2026-07-22T11:30:00Z',
              'sources:',
              '  - invalid',
              '  - resource: !!str https://example.com/shifted',
              'parameters:',
              '  - invalid',
              '  - name: !!str year',
              '    type: !!str integer',
              '    required: !!bool true',
              '',
            ].join('\n'),
            'Reference',
          ),
        ],
        [
          'tagged-computation.md',
          concept(
            '',
            [
              'status: !!str stable',
              'stale_after: !!str 2026-09-23',
              'usage_window: { from: !!str 2026-07-01, to: !!str 2026-07-31 }',
              'sources: [{ resource: !!str https://example.com/tagged, usage_count: !!int 42 }]',
              'runtime: !!str local',
              'parameters: [{ name: !!str input, type: !!str string, required: !!bool true }]',
              'computation: !!str scripts/run.sh',
              'executor: { resource: !!str references/run.md, receipt: [!!str job_id, !!str result] }',
              'attester: { resource: !!str references/attest.md }',
              '',
            ].join('\n'),
            'Attested Computation',
          ),
        ],
        [
          'missing-usage-window.md',
          concept(
            '',
            'sources: [{ resource: https://example.com/source, usage_count: 42 }]\n',
            'Reference',
          ),
        ],
        [
          'tagged-lexical-ranges.md',
          concept(
            '',
            [
              'executor:',
              '  receipt:',
              '    - !!str "job_id"',
              'producer_map: !!map',
              '  key: value',
              'tag_first_map: !!map &tagged-map',
              '  tagged_key: value',
              'tagged_parent: !!map',
              '  child: !!str "x"',
              '',
              'anchored_flow: [!!str &flow-id "x"]',
              'tagged_flow_parent: !!seq [!!str &tagged-flow-id "x", *tagged-flow-id]',
              'shared_seed: &shared-seed !!str "x"',
              'shared_aliases: [*shared-seed]',
              'verbatim_standard: !<tag:yaml.org,2002:str> "Reference"',
              'shadow_old: &shadow !!str "0.2"',
              'shadow_new: &shadow "1.0"',
              'shadow_alias: *shadow',
              'sequence_values:',
              '  - &sequence-one !!str "x"',
              '  - *sequence-one',
              '  - !!str &sequence-two "y"',
              '  - *sequence-two',
              'object_seed: &object-seed',
              '  child: !!str "x"',
              'object_copy: *object-seed',
              '"tagged:a:b": !!str "x"',
              'empty_tagged: !!str |-',
              '',
              'notes: !!str |-',
              '  first',
              '  second',
              '# detached field comment',
              '',
              '"colon:key": value # inline field comment',
              'commented: value # inline field comment',
              'items: !!seq',
              '  - one',
              '  - two',
              "tags: [!!str alpha, !!str 'it''s']",
              'flow_metadata: [',
              "  { label: !!str 'it''s', count: !!int 2 }",
              ']',
              '',
            ].join('\n'),
            'Reference',
          ),
        ],
        ['mixed-tags.md', concept('', 'tags: [!!str alpha, 42, beta]\n', 'Reference')],
        [
          'flow-fields.md',
          ['---', '{ ? "type": Reference, "colon:key": value, plain: x }', '---', '# Flow'].join(
            '\n',
          ),
        ],
        [
          'explicit-fields.md',
          [
            '---',
            '? "type"',
            '# explicit key comment',
            '',
            ': Reference',
            'literal: |',
            '  first',
            '  # literal',
            '# detached',
            'keep: |+',
            '  retained',
            '',
            'empty_keep: |+ # keep',
            '',
            'empty_clip: |',
            '',
            'empty_strip: |-',
            '',
            'next: value',
            '---',
            '# Explicit',
          ].join('\n'),
        ],
        [
          'alias-mapping-key.md',
          ['---', 'key: &mapping-key name', 'map: { ? *mapping-key : value }', '---', ''].join(
            '\n',
          ),
        ],
        ['implicit-non-string-key.md', ['---', 'producer:', '  true: value', '---', ''].join('\n')],
        [
          'unicode-duplicate-key.md',
          ['---', 'type: reference', '名前: one', '名前: two', '---', ''].join('\n'),
        ],
        ['unicode-malformed-value.md', ['---', 'type: reference', '名前: [', '---', ''].join('\n')],
        [
          'unicode-flow-duplicate-key.md',
          ['---', 'type: reference', 'metadata: {名前: one, 名前: two}', '---', ''].join('\n'),
        ],
        [
          'flow-alias-set-key.md',
          [
            '---',
            'type: reference',
            'alias_member: &alias-member member',
            'alias_flow_set: { ? *alias-member }',
            '---',
            '',
          ].join('\n'),
        ],
        [
          'implicit-alias-mapping-key.md',
          ['---', 'key: &implicit-key field', 'map:', '  *implicit-key : value', '---', ''].join(
            '\n',
          ),
        ],
        [
          'explicit-comment-alias-key.md',
          [
            '---',
            'key: &comment-key field',
            'map:',
            '  ? *comment-key # comment',
            '  : value',
            '---',
            '',
          ].join('\n'),
        ],
        [
          'under-indented-flow-sequence.md',
          ['---', 'type: reference', 'tags: [a,', 'b]', '---', ''].join('\n'),
        ],
        [
          'under-indented-flow-map.md',
          ['---', 'type: reference', 'map: {a: 1,', 'b: 2}', '---', ''].join('\n'),
        ],
        [
          'under-indented-direct-flow-sequence.md',
          ['---', 'type: reference', 'items:', '  - [a,', 'b]', '---', ''].join('\n'),
        ],
        [
          'under-indented-direct-flow-map.md',
          ['---', 'type: reference', 'items:', '  - {a: 1,', 'b: 2}', '---', ''].join('\n'),
        ],
        [
          'under-indented-deferred-flow.md',
          ['---', 'type: reference', 'items:', '  -', '    [a,', 'b]', '---', ''].join('\n'),
        ],
        [
          'under-indented-deferred-tagged-flow.md',
          ['---', 'type: reference', 'items:', '  - !!seq', '    [a,', 'b]', '---', ''].join('\n'),
        ],
        [
          'under-indented-mapping-tagged-flow.md',
          ['---', 'type: reference', 'value: !!seq', '  [a,', 'b]', '---', ''].join('\n'),
        ],
        ['tight-quoted-comment.md', ['---', 'type: "reference"#bad', '---', ''].join('\n')],
        [
          'tight-flow-comment.md',
          ['---', 'type: reference', 'tags: [a]#bad', '---', ''].join('\n'),
        ],
        [
          'tight-flow-map-comment.md',
          ['---', 'type: reference', 'map: {a: 1}#bad', '---', ''].join('\n'),
        ],
        [
          'tight-block-comment.md',
          ['---', 'type: reference', 'value: |#bad', '  content', '---', ''].join('\n'),
        ],
        [
          'unsupported-shorthand-tag.md',
          ['---', 'type: reference', 'value: !!evil payload', '---', ''].join('\n'),
        ],
        [
          'unsupported-verbatim-tag.md',
          ['---', 'type: reference', 'value: !<tag:yaml.org,2002:evil> payload', '---', ''].join(
            '\n',
          ),
        ],
        [
          'unsupported-merge-tag.md',
          ['---', 'type: reference', 'value: !!merge payload', '---', ''].join('\n'),
        ],
        [
          'lowercase-timestamp-zone.md',
          ['---', 'type: reference', 'value: !!timestamp 2001-12-15T00:00:00z', '---', ''].join(
            '\n',
          ),
        ],
        [
          'nested-set-block-scalar.md',
          [
            '---',
            'type: reference',
            'outer: !!set',
            '  ? !!set',
            '    ? {key: &nested-scalar !!str |-',
            '          hello}',
            'outside: *nested-scalar',
            '---',
            '',
          ].join('\n'),
        ],
        [
          'duplicate-bare-set-member.md',
          ['---', 'type: reference', 'set: !!set', '  ?', '  ?', '---', ''].join('\n'),
        ],
        [
          'duplicate-semantic-null-set-member.md',
          [
            '---',
            'type: reference',
            'value: !!set',
            '  ? !!null null',
            '  ? null',
            '  ?',
            '---',
            '',
          ].join('\n'),
        ],
        [
          'duplicate-explicit-string-set-member.md',
          [
            '---',
            'type: reference',
            'value: !!set { ? !!str true, ? !!str "true" }',
            '---',
            '',
          ].join('\n'),
        ],
        [
          'duplicate-quoted-string-set-member.md',
          ['---', 'type: reference', 'value: !!set { ? "x", ? \'x\' }', '---', ''].join('\n'),
        ],
        [
          'duplicate-leading-zero-set-member.md',
          ['---', 'type: reference', 'value: !!set { ? 1, ? 01 }', '---', ''].join('\n'),
        ],
        [
          'duplicate-hex-set-member.md',
          ['---', 'type: reference', 'value: !!set { ? 16, ? 0x10 }', '---', ''].join('\n'),
        ],
        [
          'duplicate-octal-set-member.md',
          ['---', 'type: reference', 'value: !!set { ? 8, ? 0o10 }', '---', ''].join('\n'),
        ],
        [
          'duplicate-large-set-member.md',
          [
            '---',
            'type: reference',
            'value: !!set { ? 9223372036854775808, ? 09223372036854775808 }',
            '---',
            '',
          ].join('\n'),
        ],
        [
          'duplicate-explicit-int-set-member.md',
          ['---', 'type: reference', 'value: !!set { ? !!int 1, ? !!int "01" }', '---', ''].join(
            '\n',
          ),
        ],
        [
          'duplicate-explicit-float-set-member.md',
          [
            '---',
            'type: reference',
            'value: !!set { ? !!float .inf, ? !!float ".inf" }',
            '---',
            '',
          ].join('\n'),
        ],
        [
          'duplicate-deferred-plain-set-member.md',
          [
            '---',
            'type: reference',
            'value: !!set',
            '  ?',
            '    x',
            '  ?',
            '    x',
            '---',
            '',
          ].join('\n'),
        ],
        ['untagged-infinity.md', ['---', 'type: reference', 'value: .inf', '---', ''].join('\n')],
        [
          'overflowing-exponent.md',
          ['---', 'type: reference', 'value: 1e309', '---', ''].join('\n'),
        ],
        [
          'duplicate-overflowing-exponent-set-member.md',
          ['---', 'type: reference', 'value: !!set { ? 1e309, ? 10e308 }', '---', ''].join('\n'),
        ],
        [
          'duplicate-infinity-set-member.md',
          ['---', 'type: reference', 'value: !!set { ? .inf, ? .Inf }', '---', ''].join('\n'),
        ],
        ['untagged-nan.md', ['---', 'type: reference', 'value: .NaN', '---', ''].join('\n')],
        [
          'duplicate-multiline-quoted-set-member.md',
          [
            '---',
            'type: reference',
            'value: !!set',
            '  ? "x',
            '    y"',
            '  ? "x',
            '    y"',
            '---',
            '',
          ].join('\n'),
        ],
        [
          'duplicate-folded-set-member.md',
          [
            '---',
            'type: reference',
            'value: !!set',
            '  ? >-',
            '    a b',
            '  ? "a b"',
            '---',
            '',
          ].join('\n'),
        ],
        [
          'duplicate-literal-set-member.md',
          ['---', 'type: reference', 'value: !!set', '  ? |-', '    a', '  ? "a"', '---', ''].join(
            '\n',
          ),
        ],
        [
          'duplicate-deferred-tagged-set-member.md',
          [
            '---',
            'type: reference',
            'value: !!set',
            '  ? !!str',
            '    true',
            '  ? !!str',
            '    "true"',
            '---',
            '',
          ].join('\n'),
        ],
        [
          'duplicate-explicit-indent-literal-set-member.md',
          ['---', 'type: reference', 'value: !!set', '  ? |2-', '    a', '  ? "a"', '---', ''].join(
            '\n',
          ),
        ],
        [
          'duplicate-explicit-indent-folded-set-member.md',
          [
            '---',
            'type: reference',
            'value: !!set',
            '  ? >2-',
            '    a b',
            '  ? "a b"',
            '---',
            '',
          ].join('\n'),
        ],
        [
          'tight-standard-tag-name.md',
          ['---', 'type: reference', 'x: !!str#bad value', '---', ''].join('\n'),
        ],
        ['tight-alias-name.md', ['---', 'type: reference', 'x: *a#tail', '---', ''].join('\n')],
        [
          'compact-nested-mapping.md',
          ['---', 'type: reference', 'x: plain', '  a: b', '---', ''].join('\n'),
        ],
        [
          'tight-flow-value-comment.md',
          ['---', 'type: reference', 'x: {"a":#bad', '  b: 2}', '---', ''].join('\n'),
        ],
        ['split-explicit-bool-key.md', ['---', '?', '  true', ': value', '---', ''].join('\n')],
        [
          'scoped-keys.md',
          [
            '---',
            'type: Reference',
            'left:',
            '  x: 1',
            'right:',
            '  x: 2',
            '"a:b": 1',
            '"a:c": 2',
            '---',
            '# Scoped',
          ].join('\n'),
        ],
        [
          'invalid-generated-at.md',
          concept('', 'generated: { by: process:test, at: null }\n', 'Reference'),
        ],
        [
          'multiple-inline.md',
          concept(
            '# Computation\n\n```sh\ntrue\n```\n\n```sh\nfalse\n```\n',
            'runtime: local\n',
            'Attested Computation',
          ),
        ],
        [
          'malformed-file-inline.md',
          concept(
            '# Computation\n\n```sh\ntrue\n```\n',
            'runtime: local\ncomputation: 5\n',
            'Attested Computation',
          ),
        ],
        [
          'fake-inline-heading.md',
          concept('```md\n# Computation\n```\n', 'runtime: local\n', 'Attested Computation'),
        ],
        [
          'attached-closing-hashes.md',
          concept(
            '# Computation###\n\n```sh\ntrue\n```\n',
            'runtime: local\n',
            'Attested Computation',
          ),
        ],
        [
          'cr-only-inline.md',
          concept(
            '# Computation\r\r```sh\rtrue\r```\r',
            'runtime: local\n',
            'Attested Computation',
          ),
        ],
        [
          'relaxed-times.md',
          concept(
            '',
            [
              'timestamp: "2026-07-22 10:00:00+0000"',
              'generated: { by: process:test, at: "2026-07-22t11:00:00z" }',
              'verified: { by: human:reviewer, at: "2026-07-22T11:30:00+0000" }',
              '',
            ].join('\n'),
            'Reference',
          ),
        ],
        [
          'quoted-inline-heading.md',
          concept(
            '> # Computation\n>\n> ```sh\n> true\n> ```\n',
            'runtime: local\n',
            'Attested Computation',
          ),
        ],
        [
          'listed-inline-heading.md',
          concept(
            '- # Computation\n\n  ```sh\n  true\n  ```\n',
            'runtime: local\n',
            'Attested Computation',
          ),
        ],
        ['unpadded-stale-after.md', concept('', 'stale_after: 2026-7-1\n', 'Reference')],
        [
          'invalid-actors.md',
          concept(
            '',
            [
              'generated: { by: bogus }',
              'verified: { by: "human:", at: 2026-07-22T11:30:00Z }',
              'sources: [{ resource: https://example.com/source, author: team:finance }]',
              '',
            ].join('\n'),
            'Reference',
          ),
        ],
        [
          'unsafe-count.md',
          concept(
            '',
            'sources: [{ resource: https://example.com/source, usage_count: 9007199254740993 }]\n',
            'Reference',
          ),
        ],
        [
          'ambiguous-computation.md',
          concept(
            '# Computation\n\n```sh\ntrue\n```\n',
            'runtime: local\ncomputation: scripts/run.sh\n',
            'Attested Computation',
          ),
        ],
        ['invalid-trust.md', concept('', 'verified: { by: human:spoofed }\n', 'Reference')],
        ['legacy-only.md', concept('', 'timestamp: 2026-07-22T10:00:00Z\n', 'Reference')],
        [
          'generated-wins.md',
          concept(
            '',
            ['timestamp: not-a-date', 'generated: { by: process:test }', 'status: true', ''].join(
              '\n',
            ),
            'Reference',
          ),
        ],
        [
          'invalid-provenance.md',
          concept(
            '',
            [
              'usage_window: { from: 2026-08-01, to: 2026-07-01 }',
              'sources:',
              '  - resource: https://example.com/source',
              '    usage_count: -1',
              '    last_modified: 2026-02-30',
              '',
            ].join('\n'),
            'Reference',
          ),
        ],
        [
          'incomplete-computation.md',
          concept(
            '# Notes\n',
            'runtime: bigquery\nexecutor: invalid\nattester: { resource: "" }\n',
            'Attested Computation',
          ),
        ],
      ],
    },
    {
      name: 'duplicate resources are deterministic and peer lists are bounded',
      documents: [
        ['index.md', ['---', 'okf_version: "0.1"', '---', '# Root', ''].join('\n')],
        ...Array.from(
          { length: 11 },
          (_, index) =>
            [
              `resource-${String(index).padStart(2, '0')}.md`,
              concept(
                '',
                `title: Resource ${String(index)}\ndescription: Duplicate\nresource: urn:shared\n`,
              ),
            ] as const,
        ),
      ],
    },
    {
      name: 'source failures suppress semantic findings but retain identities and links',
      documents: [
        ['index.md', ['---', 'okf_version: "0.1"', '---', '# Root', ''].join('\n')],
        ['bad.md', Uint8Array.from([0xc3, 0x28])],
        [
          'source.md',
          concept('[Bad](./bad.md)\n', 'title: Source\ndescription: Links to a failed identity\n'),
        ],
      ],
    },
  ])('$name has exact validation and graph parity', ({ documents }) => {
    const rootUri = 'fixture:/validation-adversarial';
    const entries = documents as readonly (readonly [string, string | Uint8Array])[];
    const input = inputFor(entries, rootUri);
    expect(core.inspect(input, '2026-07-22T12:00:00Z')).toEqual(
      typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z'),
    );
  });

  test('resource-limit identity, source, metadata, and Markdown one-over cases match', () => {
    const rootUri = 'fixture:/resource-adversarial';
    const base = [
      'index.md',
      ['---', 'okf_version: "0.1"', '---', '# Root', ''].join('\n'),
    ] as const;
    const cases: readonly {
      readonly name: string;
      readonly entries: readonly (readonly [string, string | Uint8Array])[];
      readonly input?: ReturnType<typeof inputFor>;
    }[] = [
      {
        name: 'provider path code units',
        entries: [
          base,
          [`${'a'.repeat(OKF_SEMANTIC_LIMITS.maxProviderPathCodeUnits)}.md`, concept('')],
        ],
      },
      {
        name: 'provider path segments',
        entries: [
          base,
          [
            `${Array.from({ length: OKF_SEMANTIC_LIMITS.maxProviderPathSegments }, () => 'd').join(
              '/',
            )}/concept.md`,
            concept(''),
          ],
        ],
      },
      {
        name: 'source URI code units',
        entries: [],
        input: {
          rootUri,
          revision: 7,
          documents: [
            {
              bundlePath: 'uri.md',
              content: concept(''),
              uri: `fixture:/${'u'.repeat(OKF_SEMANTIC_LIMITS.maxSourceUriCodeUnits)}`,
            },
          ],
        },
      },
      {
        name: 'content hash code units',
        entries: [],
        input: {
          rootUri,
          revision: 7,
          documents: [
            {
              bundlePath: 'hash.md',
              content: concept(''),
              uri: `${rootUri}/hash.md`,
              contentHash: 'h'.repeat(OKF_SEMANTIC_LIMITS.maxContentHashCodeUnits + 1),
            },
          ],
        },
      },
      {
        name: 'semantic source bytes',
        entries: [
          base,
          [
            'source-bytes.md',
            concept('x'.repeat(OKF_SEMANTIC_LIMITS.maxSemanticDocumentBytes + 1)),
          ],
        ],
      },
      {
        name: 'semantic source lines',
        entries: [
          base,
          ['source-lines.md', concept('x\n'.repeat(OKF_SEMANTIC_LIMITS.maxSemanticDocumentLines))],
        ],
      },
      {
        name: 'frontmatter lines',
        entries: [
          base,
          [
            'yaml-lines.md',
            [
              '---',
              'type: reference',
              ...Array.from(
                { length: OKF_SEMANTIC_LIMITS.maxFrontmatterLines },
                (_, index) => `field_${String(index)}: value`,
              ),
              '---',
              '',
            ].join('\n'),
          ],
        ],
      },
      {
        name: 'frontmatter indentation',
        entries: [
          base,
          [
            'yaml-indent.md',
            [
              '---',
              'type: reference',
              `${' '.repeat(OKF_SEMANTIC_LIMITS.maxFrontmatterIndentColumns + 1)}field: value`,
              '---',
              '',
            ].join('\n'),
          ],
        ],
      },
      {
        name: 'frontmatter structural tokens',
        entries: [
          base,
          [
            'yaml-tokens.md',
            [
              '---',
              'type: reference',
              '#'.repeat(OKF_SEMANTIC_LIMITS.maxFrontmatterStructuralTokens + 1),
              '---',
              '',
            ].join('\n'),
          ],
        ],
      },
      {
        name: 'Markdown body code units',
        entries: [
          base,
          ['body-units.md', concept('x'.repeat(OKF_SEMANTIC_LIMITS.maxMarkdownBodyCodeUnits + 1))],
        ],
      },
      {
        name: 'Markdown lines',
        entries: [
          base,
          ['body-lines.md', concept('x\n'.repeat(OKF_SEMANTIC_LIMITS.maxMarkdownLines + 1))],
        ],
      },
      {
        name: 'concept tags',
        entries: [
          base,
          [
            'tags.md',
            concept(
              '',
              `tags: [${Array.from(
                { length: OKF_SEMANTIC_LIMITS.maxTagsPerConcept + 1 },
                (_, index) => `tag-${String(index)}`,
              ).join(', ')}]\n`,
            ),
          ],
        ],
      },
      {
        name: 'concept type',
        entries: [
          base,
          [
            'type.md',
            [
              '---',
              `type: ${'t'.repeat(OKF_SEMANTIC_LIMITS.maxTypeCodeUnits + 1)}`,
              '---',
              '',
            ].join('\n'),
          ],
        ],
      },
      ...(
        [
          ['title', 'title', OKF_SEMANTIC_LIMITS.maxTitleCodeUnits],
          ['description', 'description', OKF_SEMANTIC_LIMITS.maxDescriptionCodeUnits],
          ['resource', 'resource', OKF_SEMANTIC_LIMITS.maxResourceCodeUnits],
          ['timestamp', 'timestamp', OKF_SEMANTIC_LIMITS.maxTimestampCodeUnits],
        ] as const
      ).map(([name, field, limit]) => ({
        name: `concept ${name}`,
        entries: [
          base,
          [`${name}.md`, concept('', `${field}: ${'x'.repeat(limit + 1)}\n`)] as const,
        ],
      })),
      {
        name: 'concept tag identity',
        entries: [
          base,
          [
            'tag.md',
            concept('', `tags: [${'t'.repeat(OKF_SEMANTIC_LIMITS.maxTagCodeUnits + 1)}]\n`),
          ],
        ],
      },
      {
        name: 'link target',
        entries: [
          base,
          [
            'target.md',
            concept(
              `[Too long](${'a'.repeat(OKF_SEMANTIC_LIMITS.maxLinkTargetCodeUnits + 1)}.md)\n`,
            ),
          ],
        ],
      },
      {
        name: 'link label',
        entries: [
          base,
          [
            'label.md',
            concept(
              `[${'a'.repeat(OKF_SEMANTIC_LIMITS.maxLinkLabelCodeUnits + 1)}](./missing.md)\n`,
            ),
          ],
        ],
      },
    ];

    for (const item of cases) {
      const input = item.input ?? inputFor(item.entries, rootUri);
      const actual = core.inspect(input, '2026-07-22T12:00:00Z');
      const expected = typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z');
      expect(actual, item.name).toEqual(expected);
    }
  }, 60_000);
});

function concept(body: string, additional = '', type = 'reference'): string {
  return `---\ntype: ${type}\n${additional}---\n${body}`;
}

function inputFor(
  entries: readonly (readonly [string, string | Uint8Array])[],
  rootUri: string,
): ParseBundleInput {
  return {
    rootUri,
    revision: 7,
    documents: entries.map(([bundlePath, content]) => ({
      bundlePath,
      content,
      uri: `${rootUri}/${bundlePath.split('/').map(encodeURIComponent).join('/')}`,
    })),
  };
}
