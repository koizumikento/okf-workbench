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
            '? |-',
            '  : explicit-key-content',
            ': !!str "block key"',
            '?',
            '  newline-explicit',
            ': !!str "newline key"',
            'non_string_shape: |',
            '  ? [one, two]',
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
