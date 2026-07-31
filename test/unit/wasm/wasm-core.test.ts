import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeAll, describe, expect, test } from 'vitest';

import { GraphResourceLimitError } from '../../../src/core/graph/index.js';
import {
  createWasmOkfCore,
  decodeMigrationPlanResult,
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
import { OKF_SEMANTIC_LIMITS, type ParseFailure } from '../../../src/core/model/index.js';
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
let wasmBytes: Uint8Array<ArrayBuffer>;

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
  wasmBytes = Uint8Array.from(
    readFileSync(resolve('target/wasm32-unknown-unknown/release/okf_wasm.wasm')),
  );
  core = createWasmOkfCore(wasmBytes);
}, 60_000);

describe('Rust/Wasm core boundary', () => {
  test('is capability-free and reports the versioned ABI', () => {
    const bytes = readFileSync(resolve('target/wasm32-unknown-unknown/release/okf_wasm.wasm'));
    const module = new WebAssembly.Module(bytes);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    expect(core.abiVersion).toBe(1);
    expect(core.coreVersion).toBe('0.2.1');
  });

  test('has exact migration-plan parity with the TypeScript oracle', () => {
    const migrationInput = inputFor(
      [
        ['index.md', ['---', 'okf_version: "0.1"', '---', '# Root', ''].join('\n')],
        [
          'legacy.md',
          [
            '---',
            'type: Reference',
            'title: Legacy',
            'description: Legacy provenance',
            'timestamp: "2026-07-22T10:00:00Z"',
            '---',
            '# Legacy',
            '',
            '# Citations',
            '',
            '- https://example.com/source',
            '',
          ].join('\n'),
        ],
      ],
      'fixture:/migration-parity',
    );
    expect(core.migrate(migrationInput, 'okf-workbench/0.2.1')).toEqual(
      typescriptOkfCore.migrate(migrationInput, 'okf-workbench/0.2.1'),
    );
  });

  test.each([
    { fromVersion: '0.1', toVersion: '0.2', files: [{}], documents: [] },
    {
      fromVersion: '0.1',
      toVersion: '0.2',
      files: [],
      documents: [
        {
          relativePath: 'index.md',
          changed: 'yes',
          manualFollowUp: false,
          actions: [],
          citationCandidates: [],
        },
      ],
    },
    {
      fromVersion: '0.1',
      toVersion: '0.2',
      files: [
        { relativePath: 'index.md', encoding: 'utf8', content: 'root' },
        { relativePath: 'concept.md', encoding: 'utf8', content: 'concept' },
      ],
      documents: [
        {
          relativePath: 'index.md',
          changed: true,
          manualFollowUp: false,
          actions: ['root-version-to-0.2'],
          citationCandidates: [],
        },
        {
          relativePath: 'concept.md',
          changed: true,
          manualFollowUp: false,
          actions: ['timestamp-to-generated'],
          citationCandidates: [],
        },
      ],
    },
    {
      fromVersion: '0.1',
      toVersion: '0.2',
      files: [],
      documents: [
        {
          relativePath: 'concept.md',
          changed: false,
          manualFollowUp: false,
          actions: [42],
          citationCandidates: [],
        },
      ],
    },
  ])('rejects malformed migration result %#', (result) => {
    expect(() => decodeMigrationPlanResult(result)).toThrow('invalid migration plan');
  });

  test('keeps migration parity for ordinal paths, fences, CR-only text, and RFC3339 variants', () => {
    const rootUri = 'fixture:/migration-adversarial';
    const migrationInput = inputFor(
      [
        ['index.md', '---\rokf_version: "0.1"\r---\r# Root\r'],
        [
          'B.md',
          [
            '---',
            'type: Reference',
            'title: Fenced',
            'description: Fenced example',
            '---',
            '# Fenced',
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
          '---\rtype: Reference\rtitle: CR\rdescription: CR-only\rtimestamp: "2026-07-22t10:00:60z"\r---\r# CR\r\r# Citations\r\r- https://example.com/source\r',
        ],
        [
          '�.md',
          [
            '---',
            'type: Reference',
            'title: Replacement character',
            'description: UTF-8 ordering',
            'timestamp: "2026-07-22T10:00:00Z"',
            '---',
            '# Replacement',
            '',
          ].join('\n'),
        ],
        [
          '😀.md',
          [
            '---',
            'type: Reference',
            'title: Emoji',
            'description: UTF-8 ordering',
            'timestamp: "2026-07-22T10:00:00Z"',
            '---',
            '# Emoji',
            '',
          ].join('\n'),
        ],
        [
          'space.md',
          [
            '---',
            'type: Reference',
            'title: Space separator',
            'description: Strict RFC3339',
            'timestamp: "2026-07-22 10:00:00Z"',
            '---',
            '# Space',
            '',
          ].join('\n'),
        ],
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
          'indented.md',
          [
            '---',
            'type: Reference',
            '---',
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
      ],
      rootUri,
    );
    expect(core.migrate(migrationInput, 'human:reviewer')).toEqual(
      typescriptOkfCore.migrate(migrationInput, 'human:reviewer'),
    );
  });

  test('keeps migration parity for quoted root and timestamp keys', () => {
    const migrationInput = inputFor(
      [
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
      ],
      'fixture:/migration-quoted',
    );
    expect(core.migrate(migrationInput, 'human:reviewer')).toEqual(
      typescriptOkfCore.migrate(migrationInput, 'human:reviewer'),
    );
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

  test('bundle preset timestamps reject the same invalid metadata as the oracle', () => {
    for (const timestamp of ['', '   ']) {
      for (const preset of ['minimal', 'software-project', 'data-analytics'] as const) {
        expect(() => core.renderBundle(preset, timestamp), `${preset}:${timestamp}`).toThrow();
        expect(
          () => typescriptOkfCore.renderBundle(preset, timestamp),
          `${preset}:${timestamp}`,
        ).toThrow();
      }
    }
    for (const timestamp of ['x'.repeat(257), 'unsafe\u0085time']) {
      for (const preset of ['software-project', 'data-analytics'] as const) {
        expect(() => core.renderBundle(preset, timestamp), `${preset}:${timestamp}`).toThrow();
        expect(
          () => typescriptOkfCore.renderBundle(preset, timestamp),
          `${preset}:${timestamp}`,
        ).toThrow();
      }
      expect(core.renderBundle('minimal', timestamp)).toEqual(
        typescriptOkfCore.renderBundle('minimal', timestamp),
      );
    }
  });

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
      'CON.md',
      'aux.md',
      'COM1.md',
      'COM¹.md',
      'folder/lpt².txt',
      'CONIN$.md',
      'folder/conout$.txt',
      'NUL .md',
      'folder/AUX .txt.md',
      'COM1 .md',
      'folder/LPT9 .txt.md',
      'folder/name?.md',
      'folder/a|b.md',
      'folder/name%3F.md',
      'folder/trailing.',
      'folder/trailing ',
      `${'a'.repeat(253)}.md`,
    ]) {
      const unsafe = { ...input, relativePath };
      expect(() => core.renderConcept(unsafe), relativePath).toThrow();
      expect(renderConceptTemplate(unsafe).ok, relativePath).toBe(false);
    }
    const encoded = { ...input, relativePath: 'nested/hello%20world.md' };
    const encodedOracle = renderConceptTemplate(encoded);
    if (!encodedOracle.ok) throw new Error('TypeScript oracle refused a valid encoded path.');
    expect(core.renderConcept(encoded)).toEqual(encodedOracle.value);

    for (const relativePath of ['nested/.md.md', 'nested/index.md.md', 'nested/log.md.md']) {
      const valid = { ...input, relativePath };
      const validOracle = renderConceptTemplate(valid);
      if (!validOracle.ok) throw new Error(`TypeScript oracle refused ${relativePath}.`);
      expect(core.renderConcept(valid)).toEqual(validOracle.value);
    }
    const excessive = {
      ...input,
      relativePath: 'hello%25252525252525252525252525252520world.md',
    };
    expect(() => core.renderConcept(excessive)).toThrow();
    expect(renderConceptTemplate(excessive).ok).toBe(false);

    for (const invalid of [
      { ...input, type: '   ' },
      { ...input, title: '\uFEFF' },
      { ...input, tags: ['unsafe\u0085tag'] },
      { ...input, timestamp: '' },
    ]) {
      expect(() => core.renderConcept(invalid)).toThrow();
      expect(renderConceptTemplate(invalid).ok).toBe(false);
    }
    for (const title of ['A\uFEFFB', 'A\u0085B']) {
      const valid = { ...input, title };
      const validOracle = renderConceptTemplate(valid);
      if (!validOracle.ok) throw new Error('TypeScript oracle refused valid whitespace metadata.');
      expect(core.renderConcept(valid)).toEqual(validOracle.value);
    }
  });

  test('agent templates are byte-identical to the migration oracle', () => {
    const agents = renderAgentsManagedBlock('knowledge');
    const skill = renderAgentSkill('knowledge');
    if (!agents.ok || !skill.ok) throw new Error('TypeScript oracle refused agent templates.');
    expect(core.renderAgent('both', 'knowledge')).toEqual([
      { relativePath: 'AGENTS.md', encoding: 'utf8', content: agents.value },
      { relativePath: AGENT_SKILL_PATH, encoding: 'utf8', content: skill.value },
    ]);
    for (const path of [
      'know`ledge',
      'a``b',
      './',
      'knowledge/',
      'knowledge\\',
      './knowledge',
      'knowledge///',
      `${`${'x'.repeat(255)}/`.repeat(15)}a/${'x'.repeat(254)}`,
      '%2e',
      '%252e',
    ]) {
      expect(core.renderAgent('both', path)).toEqual(typescriptOkfCore.renderAgent('both', path));
    }
    for (const relativePath of ['knowledge%20base', 'knowledge%2Fbase', 'knowledge%25base']) {
      const providerPath = { pathIdentity: 'provider' as const, relativePath };
      expect(core.renderAgent('both', providerPath)).toEqual(
        typescriptOkfCore.renderAgent('both', providerPath),
      );
    }
    for (const path of [
      '',
      '../escape',
      '/absolute',
      'bad\npath',
      'CON',
      'folder/name?',
      'x'.repeat(256),
    ]) {
      expect(() => core.renderAgent('both', path), path).toThrow();
      expect(() => typescriptOkfCore.renderAgent('both', path), path).toThrow();
    }
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

  test('graph statistic keys use JavaScript UTF-16 code-unit order', () => {
    const rootUri = 'fixture:/graph-stat-order';
    const input = inputFor(
      [
        ['😀.md', concept('[pua](%EE%80%80.md)\n', 'tags: ["😀"]\n', '"😀"')],
        ['\uE000.md', concept('[emoji](%F0%9F%98%80.md)\n', 'tags: ["\uE000"]\n', '"\uE000"')],
      ],
      rootUri,
    );
    const actual = core.inspect(input, '2026-07-22T12:00:00Z').graph;
    const expected = typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z').graph;
    expect(Object.keys(actual.backlinks)).toEqual(Object.keys(expected.backlinks));
    expect(Object.keys(actual.statistics.typeCounts)).toEqual(
      Object.keys(expected.statistics.typeCounts),
    );
    expect(Object.keys(actual.statistics.tagCounts)).toEqual(
      Object.keys(expected.statistics.tagCounts),
    );
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

  test('graph and inspect apply the JavaScript safe-integer revision contract', () => {
    for (const revision of [0, Number.MAX_SAFE_INTEGER]) {
      const input = { ...inputFor([], 'fixture:/revision-boundary'), revision };
      expect(core.inspect(input, '2026-07-22T12:00:00Z')).toEqual(
        typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z'),
      );
      expect(rawWasmRequest({ operation: 'graph', input }).result).toMatchObject({ revision });
    }

    for (const revision of [-1, -0.5]) {
      const input = { ...inputFor([], 'fixture:/revision-boundary'), revision };
      expectGraphLimitParity(input);
      expect(rawWasmRequest({ operation: 'graph', input }).error).toEqual({
        code: 'graph-resource-limit',
        message: 'The graph revision must be a non-negative safe integer.',
      });
      expect(
        rawWasmRequest({
          operation: 'inspect',
          input: { bundle: input, now: '2026-07-22T12:00:00Z', failures: [] },
        }).error,
      ).toEqual({
        code: 'graph-resource-limit',
        message: 'The graph revision must be a non-negative safe integer.',
      });
    }
  });

  test('raw graph and inspect requests classify revision number lexemes like JavaScript', () => {
    const expectedError = {
      code: 'graph-resource-limit',
      message: 'The graph revision must be a non-negative safe integer.',
    };
    for (const revision of [
      '1e400',
      '-1e400',
      '1e+400',
      '-1e+400',
      '9007199254740992.0',
      '9007199254740992e0',
    ]) {
      for (const operation of ['graph', 'inspect'] as const) {
        const request = rawRevisionRequest(operation, revision);
        const parsed = JSON.parse(request) as {
          readonly input:
            | ParseBundleInput
            | {
                readonly bundle: ParseBundleInput;
                readonly now: string;
                readonly failures: readonly ParseFailure[];
              };
        };
        const input =
          operation === 'graph'
            ? (parsed.input as ParseBundleInput)
            : (parsed.input as { readonly bundle: ParseBundleInput }).bundle;
        expectGraphLimitParity(input);
        expect(rawWasmRequestJson(request).error).toEqual(expectedError);
      }
    }

    for (const [revision, expected] of [
      ['0.0', 0],
      ['0e999999999999999999999999', 0],
      ['0e-999999999999999999999999', 0],
      ['1e-400', 0],
      ['-1e-400', 0],
      ['1e0', 1],
      ['9007199254740990.9', Number.MAX_SAFE_INTEGER],
      ['9007199254740991.0', Number.MAX_SAFE_INTEGER],
      ['9007199254740991e0', Number.MAX_SAFE_INTEGER],
    ] as const) {
      const oracleInput = {
        ...inputFor([], 'fixture:/revision-lexeme'),
        revision: expected,
      };
      const oracle = typescriptOkfCore.inspect(oracleInput, '2026-07-22T12:00:00Z');
      expect(rawWasmRequestJson(rawRevisionRequest('graph', revision))).toMatchObject({
        result: { revision: expected },
      });
      expect(rawWasmRequestJson(rawRevisionRequest('inspect', revision)).result).toEqual(oracle);
    }

    for (const request of [
      '{"operation":"graph","input":{"rootUri":"","revision":1,"revision":1,"documents":[]}}',
      '{"operation":"inspect","input":{"bundle":{"rootUri":"","revision":1,"documents":[]},"bundle":{"rootUri":"","revision":1,"documents":[]},"now":"2026-07-22T12:00:00Z","failures":[]}}',
    ]) {
      expect(rawWasmRequestJson(request).error?.code).toBe('invalid-request');
    }

    for (const request of [
      '{"operation":"graph"}',
      '{"operation":"graph","input":null}',
      '{"operation":"graph","input":1}',
      '{"operation":"graph","input":[]}',
      '{"operation":"graph","input":{"rootUri":"","revision":1e400,"documents":[]},"input":{"rootUri":"","revision":1e400,"documents":[]}}',
      '{"operation":"inspect"}',
      '{"operation":"inspect","input":null}',
      '{"operation":"inspect","input":1}',
      '{"operation":"inspect","input":[]}',
      '{"operation":"inspect","input":{"now":"2026-07-22T12:00:00Z","failures":[]}}',
      '{"operation":"inspect","input":{"bundle":null,"now":"2026-07-22T12:00:00Z","failures":[]}}',
      '{"operation":"inspect","input":{"bundle":1,"now":"2026-07-22T12:00:00Z","failures":[]}}',
      '{"operation":"inspect","input":{"bundle":{"rootUri":"","revision":1e400,"documents":[]},"now":"2026-07-22T12:00:00Z","failures":[]},"input":{"bundle":{"rootUri":"","revision":1e400,"documents":[]},"now":"2026-07-22T12:00:00Z","failures":[]}}',
    ]) {
      const error = rawWasmRequestJson(request).error;
      expect(error?.code, request).toBe('invalid-request');
      expect(error?.message, request).toMatch(/^The OKF core request is invalid:/);
    }
  });

  test('orders equal-identity external failures by reason like the TypeScript oracle', () => {
    const input = inputFor([], 'fixture:/failure-order');
    const failure = {
      kind: 'parse-failure' as const,
      uri: 'fixture:/failure-order/same.md',
      bundlePath: 'same.md',
      message: 'Same provider failure.',
    };
    const failures: readonly ParseFailure[] = [
      { ...failure, reason: 'read' },
      { ...failure, reason: 'decode' },
    ];
    const actual = core.inspect(input, '2026-07-22T12:00:00Z', failures);
    const expected = typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z', failures);
    expect(actual).toEqual(expected);
    expect(actual.bundle.failures.map(({ reason }) => reason)).toEqual(['decode', 'read']);
  });

  test('orders astral and BMP external failure identities by UTF-16 code units', () => {
    const input = inputFor([], 'fixture:/failure-utf16-order');
    const failure = {
      kind: 'parse-failure' as const,
      reason: 'read' as const,
      message: 'Provider failure.',
    };
    const pathFailures: readonly ParseFailure[] = [
      { ...failure, uri: 'fixture:/same', bundlePath: '\uE000.md' },
      { ...failure, uri: 'fixture:/same', bundlePath: '😀.md' },
    ];
    const pathActual = core.inspect(input, '2026-07-22T12:00:00Z', pathFailures);
    expect(pathActual).toEqual(
      typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z', pathFailures),
    );
    expect(pathActual.bundle.failures.map(({ bundlePath }) => bundlePath)).toEqual([
      '😀.md',
      '\uE000.md',
    ]);

    const uriFailures: readonly ParseFailure[] = [
      { ...failure, uri: 'fixture:/\uE000', bundlePath: 'same.md' },
      { ...failure, uri: 'fixture:/😀', bundlePath: 'same.md' },
    ];
    const uriActual = core.inspect(input, '2026-07-22T12:00:00Z', uriFailures);
    expect(uriActual).toEqual(
      typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z', uriFailures),
    );
    expect(uriActual.bundle.failures.map(({ uri }) => uri)).toEqual([
      'fixture:/😀',
      'fixture:/\uE000',
    ]);

    const caseFailures: readonly ParseFailure[] = [
      { ...failure, uri: 'fixture:/same', bundlePath: 'a.md' },
      { ...failure, uri: 'fixture:/same', bundlePath: 'A.md' },
    ];
    const caseActual = core.inspect(input, '2026-07-22T12:00:00Z', caseFailures);
    expect(caseActual).toEqual(
      typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z', caseFailures),
    );
    expect(caseActual.bundle.failures.map(({ bundlePath }) => bundlePath)).toEqual([
      'A.md',
      'a.md',
    ]);
  });

  test('deduplicates external failure findings by offsets rather than line metadata', () => {
    const input = inputFor([], 'fixture:/finding-range-dedupe');
    const failure = {
      kind: 'parse-failure' as const,
      uri: 'fixture:/finding-range-dedupe/same.md',
      bundlePath: 'same.md',
      reason: 'read' as const,
      message: 'Same ranged failure.',
    };
    const failures: readonly ParseFailure[] = [
      {
        ...failure,
        range: {
          start: { offset: 4, line: 1, character: 2 },
          end: { offset: 8, line: 1, character: 6 },
        },
      },
      {
        ...failure,
        range: {
          start: { offset: 4, line: 99, character: 40 },
          end: { offset: 8, line: 100, character: 1 },
        },
      },
    ];
    const actual = core.inspect(input, '2026-07-22T12:00:00Z', failures);
    const expected = typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z', failures);
    expect(actual).toEqual(expected);
    expect(actual.bundle.failures).toHaveLength(2);
    expect(actual.findings).toHaveLength(1);
  });

  test('fails closed or sanitizes lone surrogates in external parse failures', () => {
    const input = inputFor([], 'fixture:/external-failure-unicode');
    const failure: ParseFailure = {
      kind: 'parse-failure',
      uri: 'fixture:/external-failure-unicode/failure.md',
      bundlePath: 'failure.md',
      reason: 'read',
      message: 'Provider failure.',
    };
    expect(() =>
      core.inspect(input, '2026-07-22T12:00:00Z', [{ ...failure, uri: `${failure.uri}\uD800` }]),
    ).toThrowError(
      new GraphResourceLimitError('Parse failure URI contains an unpaired UTF-16 surrogate.'),
    );
    expect(() =>
      core.inspect(input, '2026-07-22T12:00:00Z', [
        { ...failure, bundlePath: `${failure.bundlePath}\uD800` },
      ]),
    ).toThrowError(
      new GraphResourceLimitError('Parse failure path contains an unpaired UTF-16 surrogate.'),
    );

    const sanitizedMessage = 'Parse failure detail contains an unpaired UTF-16 surrogate.';
    const actual = core.inspect(input, '2026-07-22T12:00:00Z', [
      { ...failure, message: `${failure.message}\uD800` },
    ]);
    const expected = typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z', [
      { ...failure, message: sanitizedMessage },
    ]);
    expect(actual).toEqual(expected);
    expect(actual.bundle.failures[0]?.message).toBe(sanitizedMessage);
    expect(JSON.stringify(actual)).not.toContain('\\ud800');
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
    for (const now of [
      '2026-07-31T00:00:00',
      '2026-07-31T00:00:00.123',
      '2026-07-31T00:00Z',
      '2026-07-31T24:00:00',
      '2026-07-31T24:00:00Z',
      '2026-07-31T24:00:00+00:00',
      '9999-12-31T24:00Z',
    ]) {
      expect(core.inspect(input, now), now).toEqual(typescriptOkfCore.inspect(input, now));
    }
    expect(() => core.inspect(input, '07/31/2026')).toThrow(TypeError);
    expect(() => typescriptOkfCore.inspect(input, '07/31/2026')).toThrow(TypeError);
    expect(() => core.inspect(input, 'not-a-date')).toThrow();
    expect(() => typescriptOkfCore.inspect(input, 'not-a-date')).toThrow();
    expect(() => core.inspect(input, 'not-a-date')).toThrow(TypeError);
    expect(() => core.inspect(input, new Date(Number.NaN))).toThrow(TypeError);
    expect(() => typescriptOkfCore.inspect(input, new Date(Number.NaN))).toThrow(TypeError);
    for (const invalid of [
      '2026-07-31t00:00:00z',
      '2026-07-31 00:00:00Z',
      '2026-07-31T00:00:60Z',
      '2025-02-29T00:00Z',
      '2025-04-31T00:00Z',
      '0001-13-01',
      '0001-01-00',
    ]) {
      expect(() => core.inspect(input, invalid), invalid).toThrow(TypeError);
      expect(() => typescriptOkfCore.inspect(input, invalid), invalid).toThrow(TypeError);
    }
    for (const invalid of [new Date(Date.UTC(10_000, 0, 1)), new Date(Date.UTC(-1, 0, 1))]) {
      expect(() => core.inspect(input, invalid)).toThrow(TypeError);
      expect(() => typescriptOkfCore.inspect(input, invalid)).toThrow(TypeError);
    }
  });

  test('rejects non-canonical document paths before inspection and index rendering', () => {
    const rootUri = 'fixture:/canonical-input-paths';
    for (const [bundlePath, content] of [
      ['C:/absolute.md', concept('# Drive absolute\n')],
      ['bad\u0001.md', concept('# Control\n')],
    ] as const) {
      const input = inputFor(
        [
          [bundlePath, content],
          ['sibling.md', concept('# Sibling\n')],
        ],
        rootUri,
      );

      expect(core.inspect(input, '2026-07-22T12:00:00Z'), bundlePath).toEqual(
        typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z'),
      );
      expect(core.renderIndexes(input, 'all'), bundlePath).toEqual(
        typescriptOkfCore.renderIndexes(input, 'all'),
      );
    }
  });

  test('isolates an unpaired-surrogate document without losing valid siblings', () => {
    const rootUri = 'fixture:/invalid-unicode-document';
    const input = inputFor(
      [
        ['invalid.md', concept('', 'title: "\uD800"\n')],
        ['sibling.md', concept('# Sibling\n')],
      ],
      rootUri,
    );

    const actual = core.inspect(input, '2026-07-22T12:00:00Z');
    expect(actual).toEqual(typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z'));
    expect(actual.bundle.concepts.map(({ id }) => id)).toEqual(['invalid', 'sibling']);
    expect(actual.bundle.failures).toMatchObject([
      {
        bundlePath: 'invalid.md',
        reason: 'decode',
        message: 'Already-decoded document text contains an unpaired UTF-16 surrogate.',
      },
    ]);
  });

  test('isolates every unpaired-surrogate document identity field at document scope', () => {
    const rootUri = 'fixture:/invalid-unicode-identities';
    const sibling = {
      uri: `${rootUri}/sibling.md`,
      bundlePath: 'sibling.md',
      content: concept('# Sibling\n'),
    } as const;
    const cases = [
      {
        name: 'source URI',
        input: {
          rootUri,
          revision: 7,
          documents: [
            {
              uri: `${rootUri}/\uD800/invalid.md`,
              bundlePath: 'invalid.md',
              content: concept('# Invalid URI\n'),
            },
            sibling,
          ],
        },
        failure: {
          uri: '<provider-uri-invalid-unicode>',
          bundlePath: 'invalid.md',
          message: 'Source URI contains an unpaired UTF-16 surrogate.',
        },
      },
      {
        name: 'bundle path',
        input: {
          rootUri,
          revision: 7,
          documents: [
            {
              uri: `${rootUri}/invalid.md`,
              bundlePath: 'invalid\uD800.md',
              content: concept('# Invalid path\n'),
            },
            sibling,
          ],
        },
        failure: {
          uri: `${rootUri}/invalid.md`,
          bundlePath: '<provider-path-invalid-unicode>',
          message: 'Provider-relative path contains an unpaired UTF-16 surrogate.',
        },
      },
      {
        name: 'content hash',
        input: {
          rootUri,
          revision: 7,
          documents: [
            {
              uri: `${rootUri}/invalid.md`,
              bundlePath: 'invalid.md',
              content: concept('# Invalid hash\n'),
              contentHash: 'hash-\uD800',
            },
            sibling,
          ],
        },
        failure: {
          uri: `${rootUri}/invalid.md`,
          bundlePath: 'invalid.md',
          message:
            'Content identity contains an unpaired UTF-16 surrogate. Refresh the bundle from a conforming provider, then retry.',
        },
      },
      {
        name: 'provider failure detail',
        input: {
          rootUri,
          revision: 7,
          documents: [
            {
              uri: `${rootUri}/invalid.md`,
              bundlePath: 'invalid.md',
              identityOnlyFailure: {
                reason: 'resource-limit' as const,
                message: 'Provider detail \uD800',
              },
            },
            sibling,
          ],
        },
        failure: {
          uri: `${rootUri}/invalid.md`,
          bundlePath: 'invalid.md',
          message: 'Provider failure detail contains an unpaired UTF-16 surrogate.',
        },
      },
    ] as const;

    for (const item of cases) {
      const actual = core.inspect(item.input, '2026-07-22T12:00:00Z');
      expect(actual, item.name).toEqual(
        typescriptOkfCore.inspect(item.input, '2026-07-22T12:00:00Z'),
      );
      expect(
        actual.bundle.concepts.some(({ id }) => id === 'sibling'),
        item.name,
      ).toBe(true);
      expect(actual.bundle.failures, item.name).toMatchObject([
        { ...item.failure, reason: 'resource-limit', scope: 'document' },
      ]);
      expect(JSON.stringify(actual), item.name).not.toContain('\\ud800');
    }
  });

  test('rejects an unpaired-surrogate bundle root before crossing the Wasm boundary', () => {
    const input = inputFor(
      [['sibling.md', concept('# Sibling\n')]],
      'fixture:/invalid-root-\uD800',
    );

    for (const candidate of [core, typescriptOkfCore]) {
      expect(() => candidate.inspect(input, '2026-07-22T12:00:00Z')).toThrowError(
        new GraphResourceLimitError('A bundle-scoped resource failure prevents graph publication.'),
      );
    }
    expect(core.renderIndexes(input, 'all')).toEqual(typescriptOkfCore.renderIndexes(input, 'all'));
  });

  test('classifies encoded trailing separators after URL-path normalization', () => {
    const rootUri = 'fixture:/encoded-trailing-separators';
    const input = inputFor(
      [
        [
          'source.md',
          concept(
            [
              '[Upper slash](missing%2F)',
              '[Lower slash](missing%2f)',
              '[Encoded backslash](missing%5C)',
              '',
            ].join('\n'),
          ),
        ],
      ],
      rootUri,
    );

    const actual = core.inspect(input, '2026-07-22T12:00:00Z');
    expect(actual).toEqual(typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z'));
    expect(actual.bundle.concepts[0]?.links.map(({ classification }) => classification)).toEqual([
      'broken',
      'broken',
      'broken',
    ]);
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
      ['plain-flow-question-lookalike.md', 'custom: word [ ?x\n'],
      ['plain-flow-colon-lookalike.md', 'custom: word [ :x\n'],
      ['plain-flow-alias-lookalike.md', 'custom: word [ *x\n'],
      ['plain-flow-tag-lookalike.md', 'custom: word [ !ostr\n'],
      ['plain-flow-standard-tag-lookalike.md', 'custom: word [ !!set\n'],
      ['plain-flow-unknown-tag-lookalike.md', 'custom: word [ !!foo\n'],
      ['plain-flow-duplicate-anchor-lookalike.md', 'custom: word [ &x &x\n'],
      ['plain-map-duplicate-anchor-lookalike.md', 'custom: word { &x &x\n'],
      ['plain-flow-duplicate-tag-lookalike.md', 'custom: word [ !!str !!str\n'],
      ['leading-question-plain-duplicate-anchor-lookalike.md', 'custom: ?x [ &x &x\n'],
      ['leading-colon-plain-duplicate-tag-lookalike.md', 'custom: :x [ !!str !!str\n'],
      ['leading-dash-plain-duplicate-anchor-lookalike.md', 'custom: -x [ &x &x\n'],
      ['deferred-plain-duplicate-anchor-lookalike.md', 'custom:\n  ?x [ &x &x\n'],
      ['multiline-plain-flow-lookalike.md', 'custom: word [\n  ?x\n'],
      ['deferred-plain-flow-lookalike.md', 'custom:\n  word [ *x\n'],
      ['tagged-deferred-plain-flow-lookalike.md', 'custom: !!str\n  word [ !ostr\n'],
      ['leading-question-plain-flow-lookalike.md', 'custom: ?x [ :y\n'],
      ['leading-colon-plain-tag-lookalike.md', 'custom: :x [ !!str 0xF\n'],
      ['leading-dash-plain-set-lookalike.md', 'custom: -x [ !!set { ? a }\n'],
      ['leading-question-plain-alias-lookalike.md', 'custom: ?x [ *x\n'],
      [
        'flow-double-colon-plain-scalar.md',
        'verified: { by: provider::region/model::v2, at: 2026-07-22T12:00:00Z }\n',
      ],
      ['tight-flow-sequence-value.md', 'custom: [a:[b]]\n'],
      ['tight-flow-mapping-value.md', 'custom: [a:{b}]\n'],
      ['tight-flow-leading-double-colon.md', 'custom: [::x]\n'],
      ['tight-flow-leading-colon-with-colon.md', 'custom: [:x:y]\n'],
      ['tight-flow-key-ending-colon.md', 'custom: {a:: b}\n'],
      ['tight-flow-question-with-colons.md', 'custom: [?x::y]\n'],
      ['tight-flow-map-question-colon.md', 'custom: {?a:b}\n'],
      ['tight-flow-map-colon-value.md', 'custom: {a: ::b}\n'],
      ['tight-flow-question-key-collection-value.md', 'custom: {?a:[a]}\n'],
      ['tight-flow-colon-key-collection-value.md', 'custom: {:a:[a]}\n'],
      ['tight-flow-bare-question-key.md', 'custom: {?a}\n'],
      ['tight-flow-explicit-key-control.md', 'custom: {? a: [a]}\n'],
      ['tight-flow-quoted-explicit-key-control.md', 'custom: {? "a": [a]}\n'],
      [
        'nested-tight-flow-indicator-key-collection-values.md',
        'custom: [{?a:[a]}, {outer: {:a:[a]}}]\n',
      ],
      ['mixed-tight-flow-replacement-order.md', 'custom: {?a:b}\nother: [::x]\nmore: {?c:d}\n'],
      ['duplicate-block-boolean-key.md', 'custom:\n  true: one\n  true: two\n'],
      ['nonstring-flow-sequence-key-range.md', 'custom: {[a]:a}\n'],
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
        'sequence-cross-member-nested-set.md',
        'outer: !!set\n  ? {value: &a !!str one}\n  ? [!!set { ? {copy: *a} }]\noutside: *a\n',
      ],
      ['sequence-local-anchor-nested-set.md', 'value: [!!set { ? { key: !!str &a "one" } }, *a]\n'],
      [
        'deep-cross-member-nested-set.md',
        'outer: !!set\n  ? {value: &a !!str one}\n  ? !!set\n    ? !!set\n      ? {copy: *a}\noutside: *a\n',
      ],
      [
        'deep-block-scalar-set.md',
        'outer: !!set\n  ? !!set\n    ? !!set\n      ? value: &a !!str |-\n          hello\noutside: *a\n',
      ],
      [
        'deep-binary-block-scalar-set.md',
        'outer: !!set\n  ? !!set\n    ? value: &a !!binary |-\n        SGVsbG8=\noutside: *a\n',
      ],
      ['tagged-string-mapping-key-set.md', 'set: !!set\n  ? !!str key: value\n'],
      ['quoted-tagged-string-mapping-key-set.md', 'set: !!set\n  ? !!str "key": value\n'],
      ['empty-tagged-string-set.md', 'set: !!set\n  ? !!str\n'],
      ['commented-empty-tagged-string-set.md', 'set: !!set\n  ? !!str # empty\n'],
      ['empty-nested-set.md', 'set: !!set\n  ? !!set\n'],
      ['explicit-nonstring-int-key.md', '!!int "1": one\n'],
      ['implicit-nonfinite-float-key.md', '!!float .inf: one\n'],
      ['explicit-nonfinite-float-key.md', '? !!float .nan\n: one\n'],
      ['flow-nonfinite-float-key.md', 'custom: { !!float .inf: one }\n'],
      ['sequence-pair-nonfinite-float-key.md', 'custom:\n  - !!float .nan: one\n'],
      ['implicit-invalid-timestamp-key.md', '!!timestamp foo: one\n'],
      ['explicit-invalid-timestamp-key.md', '? !!timestamp foo\n: one\n'],
      ['flow-invalid-timestamp-key.md', 'custom: { !!timestamp foo: one }\n'],
      ['sequence-pair-invalid-timestamp-key.md', 'custom:\n  - !!timestamp foo: one\n'],
      ['invalid-timestamp-after-boolean-key.md', 'true: one\n!!timestamp foo: two\n'],
      ['invalid-timestamp-after-tagged-int-key.md', '!!int 1: one\n!!timestamp foo: two\n'],
      [
        'invalid-timestamp-after-flow-boolean-key.md',
        'custom: { true: one }\n!!timestamp foo: two\n',
      ],
      [
        'nested-invalid-timestamp-after-nonstring-key.md',
        'outer:\n  true: one\n  !!timestamp foo: two\n',
      ],
      ['timestamp-compact-mapping-value.md', 'custom: !!timestamp foo: bar\n'],
      ['timestamp-sequence-compact-mapping-value.md', 'custom:\n  - key: !!timestamp foo: bar\n'],
      ['timestamp-flow-compact-mapping-value.md', 'custom: {a: !!timestamp foo: bar}\n'],
      ['sequence-compact-nested-mapping.md', 'custom:\n  - key: value\n      nested: x\n'],
      ['sequence-flow-item-missing-indicator.md', 'custom:\n  - {key: value}\n    nested: x\n'],
      ['sequence-flow-item-misaligned-dash.md', 'custom:\n  - [one]\n    - two\n'],
      ['sequence-flow-item-misaligned-bare-dash.md', 'custom:\n  - [one]\n    -\n      two\n'],
      ['sequence-flow-item-misaligned-tab-dash.md', 'custom:\n  - [one]\n    -\ttwo\n'],
      ['sequence-flow-item-nbsp-dash.md', 'custom:\n  - [one]\n    -\u00a0two\n'],
      ['sequence-flow-item-em-space-dash.md', 'custom:\n  - [one]\n    -\u2003two\n'],
      [
        'sequence-flow-item-overindented-missing-indicator.md',
        'custom:\n  - [one]\n      nested: y\n',
      ],
      ['implicit-tagged-flow-map-key-range.md', '!!str {k: v}: one\n'],
      ['implicit-tagged-flow-sequence-key-range.md', '!!binary [a, b]: one\n'],
      ['sequence-pair-tagged-flow-map-key-range.md', 'custom:\n  - !!timestamp {k: v}: one\n'],
      ['sequence-pair-tagged-flow-sequence-key-range.md', 'custom:\n  - !!null [a, b]: one\n'],
      ['implicit-binary-reserved-indicator-key.md', '!!binary @@: one\n'],
      ['reserved-indicator-plain-value.md', 'custom: @x\n'],
      ['reserved-indicator-tagged-value.md', 'custom: !!binary @@\n'],
      ['reserved-indicator-sequence-value.md', 'items:\n  - !!binary @@\n'],
      ['flow-set-tagged-sequence-member.md', 'custom: !!set { ? !!seq [one] }\n'],
      ['flow-set-tagged-mapping-member.md', 'custom: !!set { ? !!map {one: two} }\n'],
      ['flow-set-tagged-sequence-explicit-null.md', 'set: !!set { ? !!str [a, b]: }\n'],
      ['flow-set-tagged-sequence-null-value.md', 'set: !!set { !!str [a, b]: null }\n'],
      ['block-set-tagged-sequence-explicit-null.md', 'set: !!set\n  ? !!str [a, b]\n  :\n'],
      [
        'block-set-tagged-sequence-null-spelling.md',
        'set: !!set\n  ? !!str [a, b]\n  : null\n  ? next\n',
      ],
      [
        'block-set-tagged-sequence-tilde-spelling.md',
        'set: !!set\n  ? !!str [a, b]\n  : ~\n  ? next\n',
      ],
      [
        'block-set-comment-only-non-null.md',
        'set: !!set\n  ? !!str [a, b]\n  : # comment\n  ? next\n',
      ],
      ['block-set-explicit-null-tag-value.md', 'set: !!set\n  ? a\n  : !!null null\n'],
      ['block-set-explicit-null-tag-empty-value.md', 'set: !!set\n  ? a\n  : !!null ""\n'],
      ['flow-set-explicit-null-tag-value.md', 'set: !!set { a: !!null null }\n'],
      ['block-set-mixed-case-null-value.md', 'set: !!set\n  ? a\n  : nUlL\n'],
      ['block-set-terminal-null-value.md', 'set: !!set\n  ? a\n  : null\n'],
      ['block-set-terminal-tilde-value.md', 'set: !!set\n  ? a\n  : ~\n'],
      ['block-set-terminal-anchored-null-value.md', 'set: !!set\n  ? a\n  : &n null\n'],
      ['flow-set-comment-only-non-null.md', 'set: !!set { ? !!str [a, b]: # comment\n}\n'],
      [
        'block-set-deferred-tagged-map-member.md',
        'set: !!set\n  ? !!map\n    k: v\n  :\n  ? next\n',
      ],
      ['flow-set-nested-collection-key-range.md', 'set: !!set { ? !!map { [x]: y } }\n'],
      ['flow-set-untagged-nested-collection-key-range.md', 'set: !!set { ? { [x]: y } }\n'],
      [
        'flow-set-scalar-tagged-nested-collection-key-range.md',
        'set: !!set { ? !!str { [x]: y } }\n',
      ],
      ['set-explicit-nonstring-int-key.md', 'set: !!set\n  ? !!int "1": one\n'],
      ['flow-explicit-timestamp-key.md', 'map: { !!timestamp "2001-12-15": one }\n'],
      ['nested-flow-set-mapping.md', 'outer: !!set\n  ? !!set { ? {value: one} }\n'],
      ['set-nested-explicit-int-key.md', 'set: !!set\n  ? { !!int "1": one }\n'],
      ['set-nested-explicit-timestamp-key.md', 'set: !!set\n  ? { !!timestamp 2001-2-3: one }\n'],
      [
        'nested-flow-set-cross-member-anchor.md',
        'outer: !!set\n  ? !!set { ? {value: &a !!str one} }\n  ? {copy: *a}\noutside: *a\n',
      ],
      ['explicit-indent-map-scalar.md', 'map:\n  value: !!str |2-\n    hello\n'],
      ['explicit-indent-map-overindented.md', 'map:\n  value: !!str |2-\n      hello\n'],
      ['explicit-indent-map-whitespace-line.md', 'map:\n  value: !!str |2+\n    hello\n    \n'],
      ['deferred-explicit-indent-map-scalar.md', 'map:\n  value: !!str\n    |2-\n      hello\n'],
      ['explicit-indent-sequence-scalar.md', 'items:\n  - !!str >2-\n    hello\n    world\n'],
      ['explicit-indent-set-scalar.md', 'set: !!set\n  ? &a !!str |2-\n    hello\noutside: *a\n'],
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
      ['terminal-sequence-blank-line.md', 'custom:\n  - child value\n\n'],
      ['terminal-deep-mapping-blank-line.md', 'custom:\n  child:\n    grandchild: value\n\n'],
      [
        'terminal-deep-mapping-indented-comment.md',
        'custom:\n  child:\n    grandchild: value\n    # deep comment\n',
      ],
      [
        'terminal-direct-mapping-parent-comment.md',
        'outer:\n  custom: value\n  # parent comment\n',
      ],
      [
        'terminal-deep-mapping-comment-chain.md',
        'outer:\n  custom:\n    child: value\n    # child comment\n  # parent comment\n',
      ],
      ['terminal-deep-sequence-comment.md', 'custom:\n  outer:\n    - value\n    # deep comment\n'],
      [
        'nested-set-crlf-followed-by-sibling-and-blank.md',
        'outer:\r\n  set: !!set\r\n    ? !!str |-\r\n      alpha\r\n  # parent separator\r\n    ? beta\r\n  next: value\r\n\n',
      ],
      ['terminal-sequence-crlf-blank-line.md', 'custom:\r\n  - child value\r\n\r\n'],
      ['terminal-sequence-of-set-blank-line.md', 'sets:\n  - !!set\n    ? x\n\n'],
      ['terminal-sequence-of-set-crlf-blank-line.md', 'sets:\r\n  - !!set\r\n    ? x\r\n\r\n'],
      ['terminal-sequence-indented-comment.md', 'items:\n  - one\n\n  # trailing comment\n'],
      [
        'deferred-map-parent-sibling.md',
        'outer:\n  custom: !!map\n    child: !!str value\n  next: value\n',
      ],
      [
        'deferred-map-parent-comment.md',
        'outer:\n  custom: !!map\n    child: !!str value\n  # between\n  next: value\n',
      ],
      [
        'deferred-scalar-parent-comment.md',
        'outer:\n  custom:\n    child value\n  # parent comment\n',
      ],
      [
        'deferred-sequence-parent-sibling.md',
        'outer:\n  custom: !!seq\n    - &a !!str value\n  next: *a\n',
      ],
      [
        'deferred-map-anchor-alias.md',
        'outer:\n  custom: &a !!map\n    child: !!str value\n  next: *a\n',
      ],
      ['invalid-deferred-block-in-flow.md', 'outer: [!!set\n  ? {key: &a !!str one}\n]\n'],
      ['invalid-deferred-flow-map-value.md', 'outer: {key: !!set # tag\n  ? x\n}\n'],
      ['invalid-deferred-nested-flow-sequence.md', 'outer: [[!!set\n  ? x\n]]\n'],
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
      [
        'single-deferred-tagged-collection-member.md',
        'x: !!set\n  ?\n    nested:\n      key: !!int "1"\n',
      ],
      [
        'single-deferred-tagged-flow-sequence-member.md',
        'x: !!set\n  ?\n    [!!timestamp "2001-12-15"]\n',
      ],
      ['single-deferred-tagged-flow-mapping-member.md', 'x: !!set\n  ?\n    {key: !!int "1"}\n'],
      [
        'commented-deferred-tagged-flow-member.md',
        'x: !!set\n  ? # member\n    [!!timestamp "2001-12-15"]\n',
      ],
      [
        'detached-comment-deferred-tagged-flow-member.md',
        'x: !!set\n  ?\n    # member\n    [!!timestamp "2001-12-15"]\n',
      ],
      [
        'property-comment-deferred-flow-member.md',
        'x: !!set\n  ? &a # member\n    [!!timestamp "2001-12-15"]\ncopy: *a\n',
      ],
      [
        'tag-comment-deferred-flow-member.md',
        'x: !!set\n  ? !!seq # member\n    [!!timestamp "2001-12-15"]\n',
      ],
      [
        'tag-comment-deferred-block-member.md',
        'x: !!set\n  ? !!map # member\n    key: !!timestamp "2001-12-15"\n',
      ],
      ['deferred-sequence-sibling-member.md', 'x: !!set\n  ? !!seq\n    - !!str one\n    - two\n'],
      [
        'deferred-omap-sibling-member.md',
        'x: !!set\n  ? !!omap\n    - first: !!str one\n    - second: two\n',
      ],
      [
        'deferred-pairs-sibling-member.md',
        'x: !!set\n  ? !!pairs\n    - first: !!str one\n    - second: two\n',
      ],
      [
        'deferred-map-tagged-fields.md',
        'x: !!set\n  ? !!map\n    first: !!str one\n    second: !!int "2"\n',
      ],
      ['anchored-flow-map-set-member.md', 'x: !!set\n  ? &a !!map {key: !!str value}\ncopy: *a\n'],
      [
        'anchored-deferred-tagged-sequence.md',
        'x: !!set\n  ? &a !!seq # member\n    [!!timestamp "2001-12-15"]\ncopy: *a\n',
      ],
      ['deferred-block-nonstring-key.md', 'x: !!set\n  ?\n    !!int "1": one\n'],
      ['deferred-property-map-nonstring-key.md', 'x: !!set\n  ? !!map\n    !!int "1": one\n'],
      ['deferred-anchor-map-nonstring-key.md', 'x: !!set\n  ? &member\n    !!int "1": one\n'],
      ['deferred-explicit-nonstring-key.md', 'x: !!set\n  ?\n    ? !!int "1"\n    : one\n'],
      ['deferred-explicit-string-key.md', 'x: !!set\n  ?\n    ? !!str key\n    : value\n'],
      ['deferred-explicit-plain-key.md', 'x: !!set\n  ?\n    ? key\n    : value\n'],
      ['deferred-explicit-quoted-key.md', 'x: !!set\n  ?\n    ? "key"\n    : value\n'],
      ['deferred-explicit-anchored-key.md', 'x: !!set\n  ?\n    ? &key key\n    : value\n'],
      ['deferred-explicit-collection-key.md', 'x: !!set\n  ?\n    ? [a, b]\n    : value\n'],
      ['deferred-string-key-control.md', 'x: !!set\n  ?\n    !!str "1": one\n'],
      ['second-set-member-nonstring-key.md', 'x: !!set\n  ? safe\n  ?\n    !!int "1": one\n'],
      ['sequence-set-nonstring-key.md', 'items:\n  - !!set\n    ?\n      !!int "1": one\n'],
      ['set-block-scalar-mapping-lookalike.md', 'x: !!set\n  ? |-\n    !!int "1": one\n'],
      [
        'set-multiline-quoted-mapping-lookalike.md',
        'x: !!set\n  ? "first\n    !!int \\"1\\": one"\n',
      ],
      ['set-comment-mapping-lookalike.md', 'x: !!set\n  ? safe\n  # !!int "1": not a key\n'],
      [
        'nested-set-tagged-members.md',
        'x: !!set\n  ? !!set\n    ? !!int "1"\n    ? !!null ""\n    ? !!seq [one]\n    ? !!map {one: two}\n',
      ],
      [
        'tagged-flow-collection-comment.md',
        'x: !!set\n  ? !!seq [!!str "one", !!str "two"] # trailing\n',
      ],
      [
        'tagged-block-scalar-mapping-lookalike.md',
        'x: !!set\n  ? !!str |2-\n      !!int "1": not a key\n',
      ],
      ['tagged-block-scalar-explicit-lookalike.md', 'x: !!set\n  ? !!str |2-\n      ? !!int "1"\n'],
      [
        'anchored-omap-alias-tags.md',
        'x: !!set\n  ? &a !!omap [{one: !!str "first"}, {two: !!int "2"}]\ncopy: *a\n',
      ],
      [
        'anchored-pairs-alias-tags.md',
        'x: !!set\n  ? &a !!pairs [{one: !!str "first"}, {two: !!int "2"}]\ncopy: *a\n',
      ],
      ['terminal-set-member-comment.md', 'x: !!set\n  ? value\n# trailing\nnext: value\n'],
      ['terminal-property-set-member-comment.md', 'x: !!set\n  ? !!str\n# trailing\nnext: value\n'],
      [
        'terminal-anchored-set-member-comment.md',
        'x: &set !!set\n  ? &member\n# trailing\nnext: value\n',
      ],
      [
        'terminal-block-scalar-set-member-comment.md',
        'x: !!set\n  ? !!str |2-\n      ?\n# trailing\nnext: value\n',
      ],
      ['terminal-bare-set-markers.md', 'items:\n  - !!set\n    ?\n  - !!set\n    ?\n'],
      ['terminal-anchor-only-set-marker.md', 'set: !!set\n  ? &a\n'],
      ['terminal-commented-set-marker.md', 'set: !!set\n  ? # empty\n  # trailing\n'],
      ['nested-terminal-bare-set-marker.md', 'outer: !!set\n  ? !!set\n    ?\n'],
      ['terminal-bare-set-trailing-comment.md', 'set: !!set\n  ?\n# trailing\n'],
      ['terminal-bare-set-comment-before-field.md', 'set: !!set\n  ?\n# trailing\nnext: value\n'],
      ['anchor-only-set-before-field.md', 'set: !!set\n  ? &a\nnext: value\n'],
      ['tag-only-set-before-field.md', 'set: !!set\n  ? !!str\nnext: value\n'],
      ['nested-set-tag-only-before-field.md', 'set: !!set\n  ? !!set\nnext: value\n'],
      ['set-block-scalar-question.md', 'set: !!set\n  ? !!str |-\n      ?\n'],
      ['literal-nel-double-quoted-key.md', '"A\u0085B": value\n'],
      ['literal-nel-single-quoted-key.md', "'A\u0085B': value\n"],
      ['literal-nel-tagged-key.md', '!!str "A\u0085B": value\n'],
      ['literal-nel-explicit-tagged-key.md', '? !!str "A\u0085B"\n: !!str value\n'],
      ['literal-nel-semantic-duplicate-key.md', '"A\\NB": one\n"A\u0085B": two\n'],
      [
        'literal-nel-explicit-semantic-duplicate-key.md',
        '? !!str "A\u0085B"\n: one\n? "A\u0085B"\n: two\n',
      ],
      [
        'literal-nel-multiline-explicit-semantic-duplicate-key.md',
        '"A\\NB": one\n? !!str\n  "A\u0085B"\n: two\n',
      ],
      [
        'literal-nel-flow-semantic-duplicate-key.md',
        'custom: {"A\u0085B": one, !!str \'A\u0085B\': two}\n',
      ],
      [
        'literal-nel-nested-tagged-key.md',
        '"A\u0085B":\n  nested: !!str "value"\n  binary: !!binary "SGVsbG8="\n',
      ],
      [
        'literal-nel-flow-key-nested-tagged-sequence.md',
        'custom: {!!str "K\u0085L": [!!str "V\u0085W", !!float "1.5"]}\n',
      ],
      [
        'flow-tagged-key-nested-tagged-sequence.md',
        'custom: {!!str "KL": [!!str "VW", !!float "1.5"]}\n',
      ],
      [
        'literal-nel-sequence-flow-tagged-key.md',
        'custom:\n  - {!!str "A\u0085B": !!str "V\u0085W"}\n',
      ],
      ['sequence-flow-tagged-value.md', 'custom:\n  - {AB: !!str "VW"}\n'],
      ['literal-nel-flow-tagged-key.md', 'custom: {!!str "A\u0085B": !!str "V\u0085W"}\n'],
      ['literal-nel-binary.md', 'custom: !!binary "SGVs\u0085bG8="\n'],
      ['literal-nel-block-binary.md', 'custom: !!binary |-\n  SGVs\u0085bG8=\n'],
      ['literal-nel-structural-colon.md', 'custom:\u0085value\n'],
      ['literal-nel-structural-key.md', 'custom\u0085:value\n'],
      ['literal-nel-plain-scalar-colon.md', 'custom: prefix:\u0085suffix\n'],
      ['literal-nel-plain-scalar-before-colon.md', 'custom: prefix\u0085:suffix\n'],
      ['literal-nel-plain-key.md', 'custom\u0085: value\n'],
      ['literal-nel-flow-plain-scalar-colon.md', 'outer: [prefix:\u0085suffix]\n'],
      ['literal-nel-flow-plain-scalar-before-colon.md', 'outer: [prefix\u0085:suffix]\n'],
      ['literal-nel-flow-map-key-before-colon.md', 'custom: {prefix\u0085:suffix}\n'],
      ['literal-nel-flow-mapping-key.md', 'outer: {custom\u0085: value}\n'],
      ['literal-nel-block-scalar-before-colon.md', 'custom: |-\n  prefix\u0085:suffix\n'],
      ['literal-nel-nested-plain-continuation.md', 'custom:\n  child:\u0085 value\n'],
      ['literal-nel-nested-deferred-scalar.md', 'outer:\n  child:\u0085value\n'],
      ['literal-nel-nested-mapping-before-colon.md', 'custom:\n  child\u0085: value\n'],
      [
        'literal-nel-nested-mapping-value-before-colon.md',
        'custom:\n  child: prefix\u0085:suffix\n',
      ],
      ['literal-nel-descendant-mapping-value.md', 'outer:\n  custom:\n    child:\u0085 value\n'],
      [
        'literal-nel-invalid-implicit-key-with-sibling.md',
        'custom:\n  child:\u0085 value\n  sibling: ok\n',
      ],
      ['literal-nel-multiple-continuation-lines.md', 'custom:\n  a:\u0085 b\n  c:\u0085 d\n'],
      ['literal-nel-anchored-deferred-scalar.md', 'custom:\n  &a child:\u0085 value\ncopy: *a\n'],
      [
        'literal-nel-tagged-anchored-deferred-scalar.md',
        'custom:\n  &a !!str child:\u0085 value\ncopy: *a\n',
      ],
      ['literal-nel-explicit-map-key.md', 'outer:\n  ? prefix:\u0085suffix\n  : value\n'],
      ['literal-nel-explicit-map-key-space.md', 'outer:\n  ? prefix:\u0085 suffix\n  : value\n'],
      [
        'literal-nel-deferred-scalar-before-root-sibling.md',
        'custom:\n  child:\u0085 value\nnext: ok\n',
      ],
      [
        'literal-nel-inline-scalar-before-root-sibling.md',
        'custom: head\n  child:\u0085 value\nnext: ok\n',
      ],
      [
        'literal-nel-block-scalar-before-root-sibling.md',
        'custom: |-\n  child:\u0085 value\nnext: ok\n',
      ],
      [
        'literal-nel-tagged-block-scalar-before-root-sibling.md',
        'custom: !!str |-\n  child:\u0085 value\nnext: ok\n',
      ],
      [
        'literal-nel-comment-before-root-sibling.md',
        'custom:\n  child value\n  # note:\u0085 value\nnext: ok\n',
      ],
      [
        'literal-nel-multiline-double-quote-before-root-sibling.md',
        'custom: "first\n  child:\u0085 value"\nnext: ok\n',
      ],
      [
        'literal-nel-multiline-single-quote-before-root-sibling.md',
        "custom: 'first\n  child:\u0085 value'\nnext: ok\n",
      ],
      ['literal-nel-inline-plain-continuation.md', 'custom: head\n  child:\u0085 value\n'],
      ['literal-nel-later-plain-continuation.md', 'custom:\n  first line\n  child:\u0085 value\n'],
      ['literal-nel-before-colon-continuation.md', 'tags:\n  key\u0085:value\n'],
      [
        'literal-nel-sequence-anchor-continuation.md',
        'custom:\n  - &a child:\u0085 value\ncopy: *a\n',
      ],
      ['literal-nel-block-sequence-plain-colon.md', 'outer:\n  - prefix:\u0085suffix\n'],
      [
        'literal-nel-block-sequence-trailing-comment.md',
        'outer:\n  - prefix:\u0085suffix\n# tail\n',
      ],
      ['literal-nel-nested-mapping-key.md', 'outer:\n  custom\u0085: value\n'],
      ['literal-nel-nested-block-sequence.md', 'wrap:\n  outer:\n    - prefix:\u0085suffix\n'],
      ['commented-flow-empty-string-key.md', 'custom: { ? !!str # key\n  : one }\n'],
      [
        'commented-flow-anchored-empty-string-key.md',
        'custom: { ? &empty # anchor\n  !!str # key\n  : one }\n',
      ],
      ['tagged-map-key-source.md', 'custom: !!map\n  !!str key: !!str value\n'],
      ['duplicate-inline-value-tag.md', 'title: !!str !!str Visible\ncustom: 日本😀\n'],
      ['duplicate-root-key-tag.md', '!!str !!int key: one\n'],
      ['duplicate-deferred-map-tag.md', 'custom: !!map\n  &a !!str : one\n'],
      ['duplicate-deferred-map-reverse-anchor-tag.md', 'custom: !!map\n  !!str &a : one\n'],
      ['duplicate-tag-block-scalar-text.md', 'custom: |-\n  !!str !!int value\n'],
      ['duplicate-tag-plain-continuation-text.md', 'custom: first\n  !!str !!int value\n'],
      ['duplicate-tag-multiline-quoted-text.md', 'custom: "first\n  !!str !!int value"\n'],
      [
        'duplicate-tag-flow-multiline-quoted-text.md',
        'custom: { key: "first\n  !!str !!int key: one" }\n',
      ],
      [
        'duplicate-tag-multiline-quoted-implicit-key.md',
        '"first\n  !!str !!int key: one": value\n',
      ],
      ['duplicate-tag-multiline-node.md', 'title: !!str\n  !!int Visible\ncustom: 日本😀\n'],
      ['duplicate-anchor-inline-node.md', 'custom: &first &second value\n'],
      ['duplicate-anchor-multiline-node.md', 'custom: &first\n  &second value\n'],
      ['duplicate-anchor-flow-node.md', 'custom: [&first &second value]\n'],
      [
        'duplicate-tag-anchor-property-chain.md',
        'title: &a\n  !!str\n  !!int Visible\ncustom: 日本😀\n',
      ],
      [
        'commented-multiline-empty-key-duplicate.md',
        'custom: { ? !!str # key\n  : one, ? !!str "" : two }\n',
      ],
      ['semantic-tagged-flow-key-duplicate.md', 'custom: { same: one, !!str same: two }\n'],
      ['semantic-tagged-block-key-duplicate.md', 'custom:\n  !!str same: one\n  same: two\n'],
      [
        'multiline-commented-flow-key-duplicate-range.md',
        'custom: { ? same : one, ? &a # anchor\n  !!str # tag\n  same : two }\n',
      ],
      [
        'commented-multiline-empty-key-plain-duplicate.md',
        'custom: { ? !!str # key\n  : one, ? "" : two }\n',
      ],
      [
        'commented-flow-key-alias-provenance.md',
        'custom: { ? !!str\n  &a # anchor\n  : one }\ncopy: *a\n',
      ],
      ['multiline-flow-key-following-range.md', 'custom: {\n  !!str\n  : one\n}\n1: bad\n'],
      ['multiline-flow-key-one-space-following-range.md', 'custom: {\n !!str\n : one\n}\n1: bad\n'],
      [
        'multiline-flow-tag-before-anchor-following-range.md',
        'custom: {\n  !!str &a\n  : one\n}\n1: bad\n',
      ],
      ['literal-nel-tagged-invalid-compact.md', 'custom: !!str prefix\u0085: suffix\n'],
      ['literal-nel-anchored-invalid-compact.md', 'custom: &a !!str prefix\u0085: suffix\n'],
      ['malformed-multiline-flow-set-separator.md', 'custom: !!set { ? !!str\n  , ? "" }\n'],
      ['block-scalar-nested-mapping-like-text.md', 'custom: |-\n  fake: one\n    fake: two\n'],
      [
        'plain-scalar-unmatched-quote-before-nonfinite.md',
        'custom: plain "open\nbad: .inf\ntail: close"\n',
      ],
      [
        'plain-scalar-unmatched-quote-before-large-integer.md',
        'custom: plain "open\nbig: 999999999999999999999999999999999999\ntail: close"\n',
      ],
      [
        'deferred-plain-scalar-property-like-text.md',
        'custom:\n  first\n  !!str text\nafter: ok\n',
      ],
      ['deferred-plain-scalar-alias-text.md', 'custom:\n  first\n  *alias text\nafter: ok\n'],
      [
        'deferred-plain-scalar-custom-tag-text.md',
        'custom:\n  first\n  !ostr internal\nafter: ok\n',
      ],
      ['deferred-plain-scalar-unknown-tag-text.md', 'custom:\n  first\n  !!foo text\nafter: ok\n'],
      ['sequence-map-tagged-empty-key.md', 'items:\n  - !!map\n    !!str : one\n'],
      ['scalar-string-tagged-flow-map.md', 'custom: !!str { child: value }\n'],
      ['scalar-binary-tagged-flow-sequence.md', 'custom: !!binary [one, two]\n'],
      ['scalar-timestamp-tagged-flow-map.md', 'custom: !!timestamp { child: value }\n'],
      ['scalar-bool-tagged-flow-sequence.md', 'custom: !!bool [true, false]\n'],
      ['scalar-null-tagged-flow-map.md', 'custom: !!null {child: value}\n'],
      ['sequence-timestamp-tagged-flow-map.md', 'items:\n  - !!timestamp {k: v}\n'],
      ['sequence-binary-tagged-flow-map.md', 'items:\n  - !!binary {k: v}\n'],
      ['sequence-int-tagged-flow-map.md', 'items:\n  - !!int {k: v}\n'],
      ['sequence-float-tagged-flow-sequence.md', 'items:\n  - !!float [1, 2]\n'],
      ['sequence-timestamp-tagged-block-map.md', 'items:\n  - !!timestamp\n    k: v\n'],
      ['sequence-binary-tagged-block-sequence.md', 'items:\n  - !!binary\n    - one\n'],
      ['tagged-string-nonfinite-sequence.md', 'items:\n  - !!str .inf\n'],
      ['deferred-tagged-string-nonfinite.md', 'custom: !!str\n  .inf\n'],
      ['collection-tagged-string-nonfinite-sequence.md', 'custom: !!str\n  - .inf\n'],
      ['collection-tagged-string-nonfinite-mapping.md', 'custom: !!str\n  child: .inf\n'],
      [
        'collection-tagged-anchor-nonfinite-sequence.md',
        'custom: !!str\n  - &a\n    .inf\ncopy: *a\n',
      ],
      [
        'collection-tagged-anchor-nonfinite-mapping.md',
        'custom: !!str\n  child: &a\n    .inf\ncopy: *a\n',
      ],
      [
        'collection-member-own-deferred-string-tag.md',
        'custom: !!str\n  - &a\n    !!str\n    .inf\ncopy: *a\n',
      ],
      [
        'split-anchor-valid-timestamp.md',
        'custom: &a # property\n  !!timestamp # property\n  2001-2-3T4:5:6Z\ncopy: *a\n',
      ],
      [
        'standalone-anchor-invalid-timestamp.md',
        'custom:\n  &a\n  !!timestamp\n  plain\ncopy: *a\n',
      ],
      ['scalar-integer-tagged-block-map.md', 'custom: !!int\n  child: value\n'],
      ['scalar-string-tagged-block-sequence.md', 'custom: !!str\n  - one\n  - two\n'],
      ['scalar-integer-boolean.md', 'custom: !!int true\n'],
      ['scalar-integer-null.md', 'custom: !!int null\n'],
      ['scalar-float-boolean.md', 'custom: !!float true\n'],
      ['scalar-float-null.md', 'custom: !!float null\n'],
      ['scalar-boolean-null.md', 'custom: !!bool null\n'],
      ['scalar-null-boolean.md', 'custom: !!null true\n'],
      ['scalar-string-nonfinite.md', 'custom: !!str .inf\n'],
      [
        'anchor-before-scalar-tags.md',
        'integer: &integer !!int plain\ninteger_copy: *integer\ntime: &time !!timestamp plain\ntime_copy: *time\n',
      ],
      [
        'anchor-before-invalid-integer.md',
        'integer: &integer !!int plain\ninteger_copy: *integer\n',
      ],
      [
        'anchor-before-valid-timestamp.md',
        'time: &time !!timestamp 2001-12-15T02:59:43Z\ntime_copy: *time\n',
      ],
      [
        'explicit-scalar-tagged-mapping-keys.md',
        '? !!int plain\n: integer\n? !!float plain\n: float\n? !!bool plain\n: boolean\n? !!null plain\n: null\n? !!int true\n: integer-boolean\n? !!float null\n: float-null\n? !!bool null\n: boolean-null\n? !!null true\n: null-boolean\n',
      ],
      ['explicit-invalid-integer-key.md', '? !!int plain\n: value\n'],
      ['explicit-boolean-shaped-integer-key.md', '? !!int true\n: value\n'],
      ['explicit-valid-integer-key.md', '? !!int 1\n: value\n'],
      ['explicit-invalid-float-key.md', '? !!float plain\n: value\n'],
      ['explicit-valid-float-key.md', '? !!float 1.5\n: value\n'],
      ['explicit-invalid-boolean-key.md', '? !!bool plain\n: value\n'],
      ['explicit-valid-boolean-key.md', '? !!bool true\n: value\n'],
      ['explicit-invalid-null-key.md', '? !!null plain\n: value\n'],
      ['explicit-valid-null-key.md', '? !!null null\n: value\n'],
      [
        'split-property-collection-provenance.md',
        'custom: !!str # tag\n  &collection {child: value}\ncopy: *collection\n',
      ],
      ['empty-nested-mapping-field-range.md', 'outer:\n  empty:\nafter: value\n'],
      ['terminal-empty-status-field-range.md', 'status:\n'],
      ['empty-explicit-timestamp.md', 'custom: !!timestamp\n'],
      ['empty-explicit-binary.md', 'custom: !!binary\n'],
      ['string-tagged-hex.md', 'custom: !!str 0xF\n'],
      ['string-tagged-octal.md', 'custom: !!str 0o7\n'],
      ['string-tagged-positive.md', 'custom: !!str +1\n'],
      ['string-tagged-negative-zero.md', 'custom: !!str -0\n'],
      ['string-tagged-uppercase-boolean.md', 'custom: !!str TRUE\n'],
      ['string-tagged-titlecase-null.md', 'custom: !!str Null\n'],
      ['string-tagged-nan.md', 'custom: !!str .NaN\n'],
      ['literal-line-separator.md', 'custom: \u2028\n'],
      ['embedded-line-separator.md', 'custom: before\u2028after\n'],
      ['literal-paragraph-separator.md', 'custom: \u2029\n'],
      ['embedded-paragraph-separator.md', 'custom: before\u2029after\n'],
      ['dotted-anchor.md', 'custom: &a.b value\ncopy: *a.b\n'],
      ['slashed-anchor.md', 'custom: &a/b value\ncopy: *a/b\n'],
      ['colon-anchor.md', 'custom: &a:b value\ncopy: *a:b\n'],
      ['question-anchor.md', 'custom: &a?b value\ncopy: *a?b\n'],
      ['unicode-anchor.md', 'custom: &日本語 value\ncopy: *日本語\n'],
      ['multiline-double-quoted-flow-key.md', 'custom: { "a\n b": c }\n'],
      ['multiline-single-quoted-flow-key.md', "custom: { 'a\n b': c }\n"],
      ['nested-multiline-quoted-flow-key.md', 'custom: { nested: { "a\n b": c } }\n'],
      ['internal-sentinel-plain-text.md', 'custom: prefix !ostr suffix\n'],
      ['internal-sentinel-comma-plain-text.md', 'custom: prefix, !ostr suffix\n'],
      ['frontmatter-leading-bom.md', '\uFEFFtype: reference\ncustom: ok\n'],
      ['integer-leading-zeroes.md', 'custom: !!int 00123\n'],
      ['integer-quoted-leading-zeroes.md', 'custom: !!int "00123"\n'],
      ['integer-double-zero.md', 'custom: !!int 00\n'],
      ['integer-leading-zero-one.md', 'custom: !!int 01\n'],
      ['integer-positive-leading-zeroes.md', 'custom: !!int +0123\n'],
      ['integer-negative-leading-zeroes.md', 'custom: !!int -0123\n'],
      ['large-radix-set-member.md', 'custom: !!set { ? 0x20000000000001 }\n'],
      ['null-semantic-flow-key-duplicate.md', 'custom: { ? !!null "" : one, ? null : two }\n'],
      ['duplicate-tag-empty-implicit-key.md', 'custom: !!map\n  !!str !!int : one\n'],
      ['block-scalar-flow-like-empty-key.md', 'custom: |-\n  - !!str : one\n'],
      ['block-scalar-implicit-empty-duplicates.md', 'custom: |-\n  : one\n  : two\n'],
      ['block-scalar-explicit-empty-duplicates.md', 'custom: |-\n  ?\n  : one\n  ?\n  : two\n'],
      ['single-quoted-flow-like-empty-key.md', "custom: '{!!str : one}'\n"],
      ['double-quoted-flow-like-empty-key.md', 'custom: "{!!str : one}"\n'],
      ['multiline-quoted-empty-key-text.md', 'custom: "first\n  ? !!str\n  : one"\n'],
      ['literal-nel-tagged-compact-like-scalar.md', 'custom: !!str "prefix\u0085: suffix"\n'],
      ['literal-nel-anchored-compact-like-scalar.md', 'custom: &a !!str "prefix\u0085: suffix"\n'],
      ['literal-nel-flow-quoted-value.md', 'custom: {key: "prefix\u0085: suffix"}\n'],
      ['deferred-flat-property-chain.md', 'custom:\n  &a\n  !!str\n  "quoted"\ncopy: *a\n'],
      ['deferred-deep-property-chain.md', 'custom:\n  !!str\n    &a\n    "quoted"\ncopy: *a\n'],
      [
        'nested-empty-key-alias-provenance.md',
        'x: !!set\n  ? !!map\n    ? &a\n      !!str\n    : one\ncopy: *a\n',
      ],
      ['duplicate-tag-sibling-boundary.md', 'a: !!map\nb: value\nc:\n  !!str : one\n'],
      ['sequence-duplicate-bare-empty-key.md', 'items:\n  - ?\n    : one\n    ?\n    : two\n'],
      ['semantic-empty-flow-set-duplicate.md', 'custom: !!set { !!str, "" }\n'],
      ['nested-flow-empty-string-key.md', 'items: [ { ? !!str : one } ]\n'],
      [
        'nested-flow-empty-string-key-duplicate.md',
        'outer: { custom: { ? !!str : one, "": two } }\n',
      ],
      ['multiline-implicit-flow-empty-string-key.md', 'custom: {\n  !!str\n  : one\n}\n'],
      ['flow-tag-before-anchor-empty-string-key.md', 'custom: { ? !!str &a : one }\ncopy: *a\n'],
      [
        'semantic-empty-nested-set-duplicate.md',
        'custom: !!set\n  ? !!set\n    ? !!str\n    ? ""\n',
      ],
      ['flow-explicit-null-key.md', 'custom: { ? : one }\n'],
      ['flow-explicit-null-key-duplicate.md', 'custom: { ? : one, ? : two }\n'],
      ['flow-implicit-null-key.md', 'custom: { : one }\n'],
      ['flow-implicit-null-key-duplicate.md', 'custom: { : one, : two }\n'],
      ['multiline-flow-null-key.md', 'custom: { ? # key\n  : one }\n'],
      ['block-implicit-empty-key-duplicate.md', 'custom:\n  : one\n  : two\n'],
      ['sibling-implicit-empty-keys.md', 'left:\n  : one\nright:\n  : two\n'],
      ['flow-set-bare-duplicate-range.md', 'set: !!set { ?, ? }\n'],
      ['flow-set-tag-only-duplicate-range.md', 'set: !!set { ? !!str, ? !!str }\n'],
      ['block-set-bare-duplicate-range.md', 'set: !!set\n  ?\n  ?\n'],
      ['block-set-tag-only-duplicate-range.md', 'set: !!set\n  ? !!str\n  ? !!str\n'],
      ['terminal-bare-set-field-range.md', 'set: !!set\n  ?\n  ? ""\n'],
      ['anchored-literal-nel-field-range.md', 'custom: &a\n  child:\u0085value\ncopy: *a\n'],
      [
        'deferred-map-later-key-properties-source.md',
        'custom: !!map\n  first: one\n  !!str second: two\n',
      ],
      ['deferred-plain-scalar.md', 'outer:\n  plain value\n'],
      ['deferred-colon-plain-scalar.md', 'outer:\n  key:value\n'],
      ['deferred-quoted-scalar.md', 'outer:\n  "quoted value"\n'],
      ['deferred-number-scalar.md', 'outer:\n  123\n'],
      ['deferred-boolean-scalar.md', 'outer:\n  true\n'],
      ['nested-set-empty-map-key.md', 'x: !!set\n  ? !!map\n    ?\n    : one\n'],
      [
        'nested-set-sequence-empty-map-key.md',
        'set: !!set\n  ? !!map\n    items:\n      - ?\n        : one\n',
      ],
      [
        'nested-set-sequence-duplicate-empty-map-key.md',
        'set: !!set\n  ? !!map\n    items:\n      - ?\n        : one\n      - ?\n        : two\n',
      ],
      ['commented-empty-map-key.md', '? # key\n: one\n'],
      ['spaced-commented-empty-map-key.md', '?  # key\n: one\n'],
      ['anchored-empty-map-key.md', '? &a\n: one\n'],
      ['duplicate-empty-map-key.md', '?\n: one\n?\n: two\n'],
      ['duplicate-commented-empty-map-key.md', '? # first\n: one\n? # second\n: two\n'],
      ['nested-set-commented-empty-map-key.md', 'x: !!set\n  ? !!map\n    ? # key\n    : one\n'],
      ['nested-set-anchored-empty-map-key.md', 'x: !!set\n  ? !!map\n    ? &a\n    : one\n'],
      ['deferred-empty-string-map-key.md', 'custom: !!map\n  ? !!str\n  : one\n'],
      ['root-empty-string-map-key.md', '? !!str\n: one\n'],
      ['multiline-empty-string-map-key.md', '?\n  !!str\n: one\n'],
      ['nested-multiline-empty-string-map-key.md', 'custom:\n  ?\n    !!str\n  : one\n'],
      ['nested-multiline-string-map-key.md', 'custom:\n  ?\n    !!str key\n  : one\n'],
      [
        'nested-multiline-anchored-empty-string-map-key.md',
        'custom: !!map\n  ? &a\n    !!str\n  : one\ncopy: *a\n',
      ],
      [
        'split-anchor-empty-string-map-key.md',
        'custom: !!map\n  ? !!str\n    &a\n  : one\ncopy: *a\n',
      ],
      ['flow-empty-string-map-key.md', 'custom: { ? !!str : one }\n'],
      ['implicit-flow-empty-string-map-key.md', 'custom: {!!str : one}\n'],
      ['implicit-flow-empty-string-map-key-duplicate.md', 'custom: {!!str : one, "": two}\n'],
      ['flow-empty-string-map-key-duplicate.md', 'custom: { ? !!str : one, "": two }\n'],
      [
        'tagged-flow-empty-string-map-key-duplicate.md',
        'custom: !!map { "": one, ? !!str : two }\n',
      ],
      [
        'reverse-tagged-flow-empty-string-map-key-duplicate.md',
        'custom: { ? !!str "" : one, ? !!str : two }\n',
      ],
      ['tab-commented-empty-map-key.md', 'custom: !!map\n  ?\t# empty\n  : one\n'],
      ['bare-implicit-empty-map-key.md', ': one\n'],
      ['nested-bare-implicit-empty-map-key.md', 'outer:\n  : one\n'],
      ['commented-explicit-empty-string-map-key.md', '? !!str # key\n: one\n'],
      [
        'split-commented-explicit-empty-string-map-key.md',
        '? !!str # tag\n  # note\n  &a # anchor\n: one\ncopy: *a\n',
      ],
      ['compact-sequence-empty-string-map-key.md', 'items:\n  - ? !!str\n    : one\n'],
      ['compact-sequence-implicit-empty-string-map-key.md', 'custom:\n  - !!str : one\n'],
      ['nested-implicit-empty-string-map-key.md', 'custom:\n  !!str : one\n'],
      ['root-implicit-empty-string-map-key.md', '!!str : one\n'],
      ['double-tagged-implicit-empty-string-map-key.md', 'custom: !!map\n  !!str : one\n'],
      ['tag-anchor-empty-string-map-key.md', 'custom: !!map\n  ? !!str &a\n  : one\ncopy: *a\n'],
      ['anchor-tag-empty-string-map-key.md', 'custom: !!map\n  ? &a !!str\n  : one\ncopy: *a\n'],
      [
        'nested-set-anchor-tag-empty-string-map-key.md',
        'x: !!set\n  ? !!map\n    ? &a !!str\n    : one\ncopy: *a\n',
      ],
      [
        'empty-string-map-key-duplicate-quoted.md',
        'custom: !!map\n  ? !!str\n  : one\n  "": two\n',
      ],
      [
        'empty-string-map-key-duplicate-tagged.md',
        'custom: !!map\n  ? !!str\n  : one\n  ? !!str\n  : two\n',
      ],
      ['empty-string-map-key-duplicate-inline-tagged.md', '? !!str\n: one\n? !!str ""\n: two\n'],
      [
        'block-scalar-set-lookalike-parent-comment.md',
        'outer:\n  custom: |-\n    !!set\n    ? x\n  # parent comment\n',
      ],
      ['deferred-tagged-quoted-scalar.md', 'custom:\n  !!str "quoted value"\nnext: value\n'],
      [
        'nested-set-deferred-empty-string-map-key.md',
        'x: !!set\n  ? !!map\n    ? !!str\n    : one\n',
      ],
      [
        'nested-anchor-tag-block-set.md',
        'outer:\n  seed: &s # anchor\n    !!set # tag\n    ? x\n  copy: *s\n',
      ],
      ['deferred-anchor-tag-quoted-scalar.md', 'custom: &a\n  !!str\n  "quoted"\ncopy: *a\n'],
      [
        'nested-set-nel-tagged-key-value.md',
        'x: !!set\n  ? !!map\n    outer:\n      !!str "A\u0085B": !!str "V\u0085W"\n',
      ],
      ['flow-set-empty-string-member-duplicate.md', 'custom: !!set { ? !!str, ? "" }\n'],
      ['block-set-empty-string-member-duplicate.md', 'custom: !!set\n  ? !!str\n  ? ""\n'],
      [
        'set-block-scalar-separator-comment.md',
        'x: !!set\n  ? !!str &a |2-\n      one\n  # between\n  ? *a\n',
      ],
      [
        'set-keep-block-scalar-separator-comment.md',
        'x: !!set\n  ? !!str &a |2+\n      one\n  # between\n  ? *a\n',
      ],
      [
        'set-empty-block-scalar-separator-comment.md',
        'x: !!set\n  ? !!str &a |-\n  # between\n  ? *a\n',
      ],
      [
        'literal-nel-set-explicit-mapping-key.md',
        'set: !!set\n  ?\n    ? !!str "A\u0085B"\n    : value\n',
      ],
      [
        'literal-nel-set-commented-explicit-mapping-key.md',
        'set: !!set\n  ?\n    ? !!str # tag\n      "A\u0085B"\n    : value\n',
      ],
      [
        'literal-nel-deferred-map-multiline-duplicate-key.md',
        'set: !!set\n  ? !!map\n    "A\u0085B": one\n    ? !!str\n      "A\u0085B"\n    : two\n',
      ],
      [
        'deferred-map-mixed-duplicate-key.md',
        'set: !!set\n  ? !!map\n    key: one\n    ? !!str key\n    : two\n',
      ],
      [
        'tagged-block-scalar-shallow-comment.md',
        'custom: !!str |-\n  one\n # between\nnext: value\n',
      ],
      ['set-block-scalar-sibling.md', 'x: !!set\n  ? !!str |-\n    one\n  ? two\n'],
      ['set-keep-block-scalar-sibling.md', 'x: !!set\n  ? !!str |+\n    one\n\n  ? two\n'],
      [
        'set-explicit-indent-block-scalar-sibling.md',
        'x: !!set\n  ? !!str |2-\n      ? !!int "1": scalar text\n  ? two\n',
      ],
      [
        'nested-set-block-scalar-sibling.md',
        'x: !!set\n  ? !!set\n    ? !!str >-\n      one\n    ? two\n  ? outer\n',
      ],
      [
        'set-block-scalar-alias-sibling.md',
        'x: !!set\n  ? !!timestamp &a |-\n    2001-12-15\n  ? *a\n',
      ],
      [
        'set-block-scalar-comment-sibling.md',
        'x: !!set\n  ? !!str &a |-\n    one\n  # between\n  ? *a\n',
      ],
      [
        'nested-set-parent-comment-sibling.md',
        'outer:\n  x: !!set\n    ? !!timestamp &a |-\n      2001-12-15\n  # parent comment\n    ? *a\n',
      ],
      [
        'nested-set-parent-comment-sequence-sibling.md',
        'outer:\n  x: !!set\n    ? &a !!seq [!!str one]\n  # parent comment\n    ? *a\n',
      ],
      [
        'nested-set-parent-comment-nested-set-source.md',
        'outer:\n  x: !!set\n    ? !!set\n      ? !!str inner\n  # parent comment\n    ? !!str outer\n  next: value\n',
      ],
      [
        'deferred-map-comment-colon.md',
        'x: !!set\n  ? !!map\n    # note: not a key\n    safe: value\n',
      ],
      ['deferred-map-explicit-key.md', 'x: !!set\n  ? !!map\n    ? !!str "1"\n    : value\n'],
      ['deferred-map-bare-explicit-key.md', 'custom: !!map\n  ?\n  : one\n'],
      ['empty-flow-set-comment.md', 'set: !!set { # only\n }\n'],
      ['flow-set-member-trailing-comment.md', 'set: !!set { ? x # trailing: colon\n }\n'],
      ['flow-set-between-members-comment.md', 'set: !!set { ? !!str one, # c\n ? !!int "2" }\n'],
      [
        'flow-set-leading-member-comment.md',
        'set: !!set {\n  # leading: note\n  ? one,\n  ? two\n}\n',
      ],
      [
        'flow-set-trailing-member-comment.md',
        'set: !!set {\n  ? one, # first: note\n  # between: note\n  ? two\n}\n',
      ],
      ['flow-set-terminal-comment.md', 'set: !!set {\n  ? one,\n  # trailing: only\n}\n'],
      ['multiline-flow-set-field-range.md', 'set: !!set { # opening\n  ? x\n}\n'],
      [
        'multiline-flow-set-sequence-field-range.md',
        'sets:\n  - !!set { # opening\n      ? x\n    }\n',
      ],
      [
        'deferred-map-gap-comment.md',
        'set: !!set\n  ? !!map # tag\n    # gap: !!int fake\n    key: !!str value\n',
      ],
      [
        'deferred-map-explicit-comment-key.md',
        'set: !!set\n  ? !!map\n    ? # key: comment\n      !!str "1"\n    : value\n',
      ],
      [
        'deferred-explicit-key-comment.md',
        'set: !!set\n  ?\n    ? # key\n      !!int "1"\n    : value\n',
      ],
      [
        'deferred-explicit-anchored-key-comment.md',
        'set: !!set\n  ?\n    ? # key\n      &key !!int "1"\n    : value\n',
      ],
      [
        'deferred-explicit-string-key-comment.md',
        'set: !!set\n  ?\n    ? # key\n      !!str "1"\n    : value\n',
      ],
      [
        'deferred-explicit-multiline-tag-key.md',
        'set: !!set\n  ?\n    ? !!int # tag\n      "1"\n    : value\n',
      ],
      [
        'deferred-explicit-multiline-string-key.md',
        'set: !!set\n  ?\n    ? !!str # tag\n      "1"\n    : value\n',
      ],
      ['top-level-explicit-multiline-string-key.md', '? !!str # tag\n  "1"\n: value\n'],
      [
        'deferred-explicit-multiline-tag-anchor-key.md',
        'set: !!set\n  ?\n    ? !!int # tag\n      &key\n      "1"\n    : value\n',
      ],
      [
        'deferred-explicit-multiline-anchor-tag-key.md',
        'set: !!set\n  ?\n    ? &key # anchor\n      !!int\n      "1"\n    : value\n',
      ],
      ['c1-control-type.md', 'type: "\\u0085"\n'],
      ['c1-control-resource.md', 'resource: "\\u0085urn:x"\n'],
      ['literal-c1-control-resource.md', 'resource: "\u0085urn:x"\n'],
      ['literal-c1-type-comment.md', 'type: reference # harmless\u0085comment\n'],
      ['literal-c1-resource-comment.md', 'resource: urn:x # harmless\u0085comment\n'],
      ['literal-c1-tags-comment.md', 'tags: # harmless\u0085comment\n  - safe\n'],
      ['literal-c1-tag-member.md', 'tags:\n  - "unsafe\u0085tag"\n'],
      ['literal-c1-explicit-tag-member.md', 'tags:\n  - !!str "unsafe\u0085tag"\n'],
      ['literal-c1-explicit-type.md', 'type: !!str "unsafe\u0085type"\n'],
      ['literal-c1-explicit-resource.md', 'resource: !!str "unsafe\u0085resource"\n'],
      ['literal-c1-explicit-status.md', 'status: !!str "unsafe\u0085status"\n'],
      ['literal-c1-explicit-custom.md', 'custom: !!str "preserve\u0085value"\n'],
      ['literal-c1-explicit-mixed-tags.md', 'tags: [!!str "preserve\u0085value", !!int "1"]\n'],
      ['literal-c1-tags-scalar.md', 'tags: "A\u0085B"\n'],
      ['literal-c1-tags-flow-map.md', 'tags: {custom: "A\u0085B"}\n'],
      ['literal-c1-tags-block-map.md', 'tags:\n  custom: "A\u0085B"\n'],
      ['literal-c1-tags-block-scalar.md', 'tags: |-\n  A\u0085B\n'],
      ['literal-c1-tags-mixed-array.md', 'tags: ["A\u0085B", 42]\n'],
      ['literal-c1-tags-reversed-mixed-array.md', 'tags: [42, "A\u0085B"]\n'],
      ['literal-c1-type-flow-map.md', 'type: {custom: "A\u0085B"}\n'],
      ['literal-c1-type-flow-sequence.md', 'type: ["A\u0085B"]\n'],
      ['literal-c1-resource-flow-map.md', 'resource: {custom: "A\u0085B"}\n'],
      ['literal-c1-resource-flow-sequence.md', 'resource: ["A\u0085B"]\n'],
      ['literal-c1-status-flow-map.md', 'status: {custom: "A\u0085B"}\n'],
      ['literal-c1-status-flow-sequence.md', 'status: ["A\u0085B"]\n'],
      ['bom-trim-type.md', 'type: "\\uFEFF"\n'],
      ['literal-nel-compact-mapping.md', 'custom: prefix\u0085: suffix\n'],
      ['literal-nel-nested-mapping.md', 'outer:\n  child: ok\n  bad:\u0085value\n'],
    ] as const;
    for (const [path, fields] of cases) {
      const rootUri = `fixture:/yaml-parity/${path}`;
      const content =
        path === 'frontmatter-leading-bom.md' ? `---\n${fields}---\n` : concept('', fields);
      const input = inputFor([[path, content]], rootUri);
      let actual;
      try {
        actual = core.inspect(input, '2026-07-22T12:00:00Z');
      } catch (error) {
        throw new Error(`${path}: Wasm inspection trapped`, { cause: error });
      }
      expect(actual, path).toEqual(typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z'));
    }

    const literalNelTypeInput = inputFor(
      [['literal-nel-type.md', '---\ntype:\u0085 reference\n---\n']],
      'fixture:/yaml-parity/literal-nel-type.md',
    );
    expect(
      core.inspect(literalNelTypeInput, '2026-07-22T12:00:00Z'),
      'literal-nel-type.md',
    ).toEqual(typescriptOkfCore.inspect(literalNelTypeInput, '2026-07-22T12:00:00Z'));

    const literalNelBeforeMarkdownLink = inputFor(
      [['literal-nel-link-range.md', concept('[missing](missing.md)\n', 'custom: "A\u0085B"\n')]],
      'fixture:/yaml-parity/literal-nel-link-range.md',
    );
    expect(core.inspect(literalNelBeforeMarkdownLink, '2026-07-22T12:00:00Z')).toEqual(
      typescriptOkfCore.inspect(literalNelBeforeMarkdownLink, '2026-07-22T12:00:00Z'),
    );

    const literalControlType = inputFor(
      [['literal-c1-control-type.md', '---\ntype: "\u0085"\n---\n']],
      'fixture:/yaml-parity/literal-c1-control-type.md',
    );
    expect(core.inspect(literalControlType, '2026-07-22T12:00:00Z')).toEqual(
      typescriptOkfCore.inspect(literalControlType, '2026-07-22T12:00:00Z'),
    );
    const preservedLiteralControl = inputFor(
      [
        [
          'literal-c1-custom.md',
          '---\ntype: reference\ncustom: "\u0085"\ntitle: "A\u0085B"\n---\n',
        ],
      ],
      'fixture:/yaml-parity/literal-c1-custom.md',
    );
    expect(core.inspect(preservedLiteralControl, '2026-07-22T12:00:00Z')).toEqual(
      typescriptOkfCore.inspect(preservedLiteralControl, '2026-07-22T12:00:00Z'),
    );
  });

  test('tight-flow omitted values match the TypeScript oracle across 45 shape and line-ending cases', () => {
    const shapes = [
      '[value:]',
      '{a:}',
      '[value:, next]',
      '[first, value:]',
      '{a:, b: value}',
      '{a: value, b:}',
      '[[value:]]',
      '[{a:}]',
      '{outer: [value:]}',
      '{outer: {a:}}',
      '[a:[b], value:]',
      '[a:{b}, value:]',
      '{actor: provider::region/model::v2, omitted:}',
      '[before,\n  value:\n]',
      '{before: value,\n  omitted:\n}',
    ] as const;
    const lineEndings = [
      ['lf', '\n'],
      ['crlf', '\r\n'],
      ['cr', '\r'],
    ] as const;
    expect(shapes).toHaveLength(15);
    for (const [shapeIndex, shape] of shapes.entries()) {
      for (const [endingName, lineEnding] of lineEndings) {
        const path = `tight-omitted-${String(shapeIndex).padStart(2, '0')}-${endingName}.md`;
        const content = concept('', `custom: ${shape}\n`).replaceAll('\n', lineEnding);
        const input = inputFor([[path, content]], `fixture:/yaml-parity/${path}`);
        const actual = core.inspect(input, '2026-07-22T12:00:00Z');
        expect(actual, path).toEqual(typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z'));
        if (endingName === 'lf' && shapeIndex < 2) {
          expect(actual.bundle.failures, path).toEqual([]);
          expect(actual.bundle.concepts[0]?.frontmatter.raw.custom, path).toEqual(
            shapeIndex === 0 ? [{ value: null }] : { a: null },
          );
        }
      }
    }
  });

  test('tagged YAML nodes match the TypeScript oracle across root, nested, and line-ending variants', () => {
    const shapes = [
      ['flow-tagged-collection', 'x: {k: !!str {a: b}}\n'],
      ['nested-flow-tagged-collection', 'outer:\n  x: {k: !!str {a: b}}\n'],
      ['tight-flow-tagged-collection', 'x: {k: !!str {a:b}}\n'],
      ['nested-tight-flow-tagged-collection', 'outer:\n  x: {k: !!str {a:b}}\n'],
      ['anchored-tight-flow-tagged-collection', 'x: {k: &a !!str {a:b}, z: *a}\n'],
      ['sequence-anchor-int', 'items:\n  - &a !!int bad\ncopy: *a\n'],
      ['nested-sequence-anchor-int', 'outer:\n  items:\n    - &a !!int bad\n  copy: *a\n'],
      ['sequence-anchor-timestamp', 'items:\n  - &a !!timestamp x\ncopy: *a\n'],
      [
        'nested-sequence-anchor-timestamp',
        'outer:\n  items:\n    - &a !!timestamp x\n  copy: *a\n',
      ],
      ['root-implicit-int-key', '!!int key: value\n'],
      ['nested-implicit-int-key', 'outer:\n  !!int key: value\n'],
      ['root-implicit-seq-key', '!!seq key: value\n'],
      ['nested-implicit-seq-key', 'outer:\n  !!seq key: value\n'],
      ['root-implicit-map-key', '!!map key: value\n'],
      ['nested-implicit-map-key', 'outer:\n  !!map key: value\n'],
      ['root-implicit-set-key', '!!set key: value\n'],
      ['nested-implicit-set-key', 'outer:\n  !!set key: value\n'],
      ['root-implicit-omap-key', '!!omap key: value\n'],
      ['nested-implicit-omap-key', 'outer:\n  !!omap key: value\n'],
      ['root-implicit-pairs-key', '!!pairs key: value\n'],
      ['nested-implicit-pairs-key', 'outer:\n  !!pairs key: value\n'],
      ['map-tagged-scalar', 'x: !!map true\n'],
      ['nested-map-tagged-scalar', 'outer:\n  x: !!map true\n'],
      ['map-tagged-large-decimal', 'x: !!map 999999999999999999999999999999999999\n'],
      [
        'nested-map-tagged-large-decimal',
        'outer:\n  x: !!map 999999999999999999999999999999999999\n',
      ],
      ['map-tagged-large-hexadecimal', `x: !!map 0x${'F'.repeat(256)}\n`],
      [
        'verbatim-map-tagged-large-decimal',
        'x: !<tag:yaml.org,2002:map> 999999999999999999999999999999999999\n',
      ],
      ['sequence-tab-anchor-int', 'items:\n  -\t&a !!int bad\ncopy: *a\n'],
      ['sequence-tab-anchor-timestamp', 'items:\n  -\t&a !!timestamp x\ncopy: *a\n'],
      ['sequence-tab-plain', 'items:\n  -\tplain\n'],
      ['sequence-tab-flow', 'items:\n  -\t[a]\n'],
      ['sequence-tab-comment', 'items:\n  -\t# comment\n'],
      ['leading-tab-comment', '\t# comment\nx: a\n'],
      ['nested-tab-comment', 'x: a\n  \t# comment\ny: b\n'],
      ['multiline-quoted-tab', 'x: "a\n  \tb"\n'],
      ['sequence-wide-space-anchor-int', 'items:\n  -  &a !!int bad\ncopy: *a\n'],
      ['compact-mapping-anchor-int', 'items:\n  - key: &a !!int bad\ncopy: *a\n'],
      ['compact-mapping-anchor-timestamp', 'items:\n  - key: &a !!timestamp x\ncopy: *a\n'],
      ['flow-mapping-anchor-int', 'items:\n  - {key: &a !!int bad}\ncopy: *a\n'],
      ['flow-mapping-anchor-timestamp', 'items:\n  - {key: &a !!timestamp x}\ncopy: *a\n'],
      ['root-string-tilde-key', '!!str ~: value\n'],
      ['nested-string-tilde-key', 'outer:\n  !!str ~: value\n'],
      ['root-empty-int-key', '!!int : value\n'],
      ['nested-empty-int-key', 'outer:\n  !!int : value\n'],
      ['root-empty-seq-key', '!!seq : value\n'],
      ['nested-empty-seq-key', 'outer:\n  !!seq : value\n'],
      ['root-empty-map-key', '!!map : value\n'],
      ['nested-empty-map-key', 'outer:\n  !!map : value\n'],
      ['root-empty-set-key', '!!set : value\n'],
      ['nested-empty-set-key', 'outer:\n  !!set : value\n'],
      ['nested-deferred-set-non-null-key', 'outer:\n  !!set\n  : value\n'],
      ['nested-deferred-set-null-key', 'outer:\n  !!set\n  : null\n'],
      ['nested-deferred-set-empty-key', 'outer:\n  !!set\n  : \n'],
      ['nested-deferred-set-root-comment-boundary', 'outer:\n  !!set\n  : null\n# c\nafter: x\n'],
      [
        'nested-deferred-set-indented-comment-boundary',
        'outer:\n  !!set\n  : null\n  # c\nafter: x\n',
      ],
      ['nested-deferred-set-inline-comment', 'outer:\n  !!set\n  : null # c\nafter: x\n'],
      ['inline-deferred-set-null-key', 'outer: !!set\n  : ~\n'],
      ['inline-deferred-set-root-comment-boundary', 'outer: !!set\n  : null\n# c\nafter: x\n'],
      ['inline-deferred-set-blank-boundary', 'outer: !!set\n  : null\n\nafter: x\n'],
      ['split-tag-anchor-deferred-set', 'outer: !!set\n  &a\n  : null\n# c\ncopy: *a\n'],
      ['split-anchor-tag-deferred-set', 'outer: &a\n  !!set\n  : null\n# c\ncopy: *a\n'],
      ['split-duplicate-anchor-deferred-set', 'outer:\n  !!set\n  &a\n  &b\n  : null\n'],
      ['split-duplicate-tag-deferred-set', 'outer:\n  !!set\n  !!map\n  : null\n'],
      ['split-duplicate-anchor-before-set-value-error', 'outer:\n  !!set\n  &a\n  &b\n  : value\n'],
      ['split-duplicate-tag-before-set-value-error', 'outer:\n  !!set\n  !!map\n  : value\n'],
      ['split-duplicate-anchor', 'x:\n  &a\n  &b\n  text\n'],
      ['sequence-split-duplicate-tag', 'x:\n  - !!str\n    !!int\n    text\n'],
      ['bare-sequence-split-duplicate-tag', 'x:\n  -\n    !!str\n    !!int\n    text\n'],
      ['bare-sequence-split-duplicate-anchor', 'x:\n  -\n    &a\n    &b\n    text\n'],
      [
        'second-sequence-item-split-duplicate-tag',
        'x:\n  - text\n  - !!str\n    !!int\n    text\n',
      ],
      [
        'nested-sequence-item-split-duplicate-tag',
        'x:\n  - !!seq\n    - !!str\n      !!int\n      text\n',
      ],
      ['separate-sequence-item-tags-are-not-duplicates', 'x:\n  -\n    !!str value\n  - !!int 2\n'],
      [
        'nested-deferred-set-parent-field-boundary',
        'parent:\n  outer:\n    !!set\n    : null\n  # c\n  after: x\n',
      ],
      ['split-map-property-field-end', 'x:\n  !!map\n  &a\n  child: v\ncopy: *a\n'],
      ['split-anchor-map-property-field-end', 'x:\n  &a\n  !!map\n  child: v\ncopy: *a\n'],
      ['split-sequence-property-field-end', 'x:\n  !!seq\n  - v\nafter: x\n'],
      ['split-block-scalar-property-field-end', 'x:\n  !!str\n  |\n    a\nafter: x\n'],
      ['split-anchor-mapping-field-end', 'x:\n  &a\n  child: v\ncopy: *a\n'],
      ['nested-deferred-empty-set-followed-by-comment', 'outer:\n  !!set\n  : \n# c\nafter: x\n'],
      ['inline-deferred-empty-set-followed-by-comment', 'outer: !!set\n  :\n# c\nafter: x\n'],
      ['root-empty-omap-key', '!!omap : value\n'],
      ['nested-empty-omap-key', 'outer:\n  !!omap : value\n'],
      ['root-empty-pairs-key', '!!pairs : value\n'],
      ['nested-empty-pairs-key', 'outer:\n  !!pairs : value\n'],
      ['indented-root-empty-int-key', '  !!int : value\n'],
      ['tagged-string-and-plain-bool-keys', '!!seq true: one\ntrue: two\n'],
      ['tagged-string-and-plain-null-keys', '!!seq ~: one\n~: two\n'],
      ['duplicate-empty-tagged-string-keys', '!!seq : one\n!!map : two\n'],
      ['nested-duplicate-empty-tagged-string-keys', 'outer:\n  !!seq : one\n  !!map : two\n'],
      ['tagged-string-and-leading-zero-keys', '!!seq 01: one\n01: two\n'],
      ['leading-zero-and-tagged-string-keys', '-01: one\n!!seq -01: two\n'],
      ['tagged-string-and-binary-keys', '!!seq 0b10: one\n0b10: two\n'],
      ['binary-and-tagged-string-keys', '0B10: one\n!!seq 0B10: two\n'],
      ['root-large-seq-key', '!!seq 999999999999999999999999: value\n'],
      ['nested-large-seq-key', 'outer:\n  !!seq 999999999999999999999999: value\n'],
      ['sequence-large-seq-key', 'items:\n  - !!seq 999999999999999999999999: value\n'],
      ['flow-large-seq-key', 'x: {!!seq 999999999999999999999999: value}\n'],
      ['empty-map-tagged-scalar', 'x: !!map\n'],
      ['flow-tagged-explicit-key-value', 'x: {k: !!str ? a: b}\n'],
      ['flow-tagged-empty-key-value', 'x: {k: !!str : b}\n'],
      ['flow-tagged-commented-block-value', 'x: {k: !!str # c\n  a: b}\n'],
    ] as const;
    const lineEndings = [
      ['lf', '\n'],
      ['crlf', '\r\n'],
      ['cr', '\r'],
    ] as const;

    expect(shapes).toHaveLength(101);
    for (const [name, fields] of shapes) {
      for (const [endingName, lineEnding] of lineEndings) {
        const path = `${name}-${endingName}.md`;
        const content = concept('', fields).replaceAll('\n', lineEnding);
        const input = inputFor([[path, content]], `fixture:/yaml-parity/${path}`);
        const actual = core.inspect(input, '2026-07-22T12:00:00Z');
        expect(actual, path).toEqual(typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z'));
      }
    }
  });

  test('matches Markdown definition limits and multiline link labels', () => {
    const exactDefinitionBody = Array.from(
      { length: 5_000 },
      (_, index) => `[d${String(index)}]: x`,
    ).join('\n');
    const exactDefinitionInput = inputFor(
      [['definition-limit-exact.md', concept(exactDefinitionBody)]],
      'fixture:/markdown-parity/definition-limit-exact.md',
    );
    const exactDefinitionResult = core.inspect(exactDefinitionInput, '2026-07-22T12:00:00Z');
    expect(exactDefinitionResult.bundle.failures).toEqual([]);
    expect(exactDefinitionResult).toEqual(
      typescriptOkfCore.inspect(exactDefinitionInput, '2026-07-22T12:00:00Z'),
    );

    const cases = [
      ['soft-break.md', '[first\nsecond](target.md)\n'],
      ['hard-break-spaces.md', '[first  \nsecond](target.md)\n'],
      ['hard-break-backslash.md', '[first\\\nsecond](target.md)\n'],
      [
        'definition-limit.md',
        Array.from({ length: 5_001 }, (_, index) => `[d${String(index)}]: x`).join('\n'),
      ],
      ['duplicate-definition-limit.md', Array.from({ length: 5_001 }, () => '[d]: x').join('\n')],
      [
        'fenced-definition-lookalikes.md',
        `\`\`\`\n${Array.from({ length: 5_001 }, () => '[d]: x').join('\n')}\n\`\`\`\n`,
      ],
      [
        'indented-definition-lookalikes.md',
        Array.from({ length: 5_001 }, () => '    [d]: x').join('\n'),
      ],
      [
        'blockquote-definition-limit.md',
        Array.from({ length: 5_001 }, (_, index) => `> [d${String(index)}]: x`).join('\n'),
      ],
      [
        'unordered-list-definition-syntax-limit.md',
        Array.from({ length: 5_001 }, (_, index) => `- [d${String(index)}]: x`).join('\n'),
      ],
      [
        'ordered-list-definition-syntax-limit.md',
        Array.from({ length: 5_001 }, (_, index) => `1. [d${String(index)}]: x`).join('\n'),
      ],
      [
        'quoted-list-definition-syntax-limit.md',
        Array.from({ length: 5_001 }, (_, index) => `> - [d${String(index)}]: x`).join('\n'),
      ],
      ['unclosed-definition-target-lookalike.md', `[d]: <${'x'.repeat(2_049)}\n`],
      ['html-definition-lookalike.md', `<div>\n[${'x'.repeat(513)}]: t.md\n</div>\n`],
      ['pre-html-definition-lookalike.md', `<pre>\n[${'x'.repeat(513)}]: t.md\n</pre>\n`],
      ['script-html-definition-lookalike.md', `<script>\n[${'x'.repeat(513)}]: t.md\n</script>\n`],
      ['comment-html-definition-lookalike.md', `<!--\n[${'x'.repeat(513)}]: t.md\n-->\n`],
      ['processing-html-definition-lookalike.md', `<?target\n[${'x'.repeat(513)}]: t.md\n?>\n`],
      ['declaration-html-definition-lookalike.md', `<!DOCTYPE\n[${'x'.repeat(513)}]: t.md\n>\n`],
      ['cdata-html-definition-lookalike.md', `<![CDATA[\n[${'x'.repeat(513)}]: t.md\n]]>\n`],
      [
        'custom-html-definition-lookalike.md',
        `<x-custom>\n[${'x'.repeat(513)}]: t.md\n</x-custom>\n`,
      ],
      ['invalid-definition-unclosed-title.md', `[${'x'.repeat(513)}]: x "unterminated\n`],
      ['invalid-definition-trailing-title.md', `[${'x'.repeat(513)}]: x "ok" trailing\n`],
      ['invalid-definition-unbalanced-destination.md', `[${'x'.repeat(513)}]: (unterminated\n`],
      ['valid-definition-title.md', `[${'x'.repeat(513)}]: x "ok"\n`],
      ['attention-run-limit.md', Array.from({ length: 1_025 }, () => '*a*').join(' ')],
      ['container-nesting-limit.md', `${'> '.repeat(65)}text\n`],
      ['media-nesting-limit.md', `${'!['.repeat(65)}x${'](a.md)'.repeat(65)}\n`],
      ['syntax-candidate-limit.md', '!'.repeat(20_001)],
      ['empty-definition-label.md', `[]: ${'a'.repeat(2_049)}\n`],
      ['list-definition-target-limit.md', `- [d]: ${'a'.repeat(2_049)}\n`],
      ['reference-expansion-boundary.md', `${'[x]\n'.repeat(50)}\n[x]: ${'a'.repeat(2_048)}\n`],
      [
        'reference-title-expansion-boundary.md',
        `${'[x]\n'.repeat(50)}\n[x]: x "${'t'.repeat(2_045)}"\n`,
      ],
      ['fenced-attention-lookalikes.md', `\`\`\`\n${'*a '.repeat(1_025)}\n\`\`\`\n`],
      ['indented-attention-lookalikes.md', `    ${'*a '.repeat(1_025)}\n`],
      ['inline-code-attention-lookalikes.md', `\`${'*a '.repeat(1_025)}\`\n`],
      ['html-attention-lookalikes.md', `<div>\n${'*a '.repeat(1_025)}\n</div>\n`],
      ['thematic-break-lookalike.md', `${'* '.repeat(65)}\n`],
      [
        'container-scoped-fence.md',
        `> \`\`\`\n${Array.from({ length: 5_001 }, (_, index) => `[d${String(index)}]: x`).join('\n')}\n`,
      ],
      [
        'invalid-backtick-fence-info.md',
        `\`\`\` bad\`\n\n${Array.from({ length: 5_001 }, (_, index) => `[d${String(index)}]: x`).join('\n')}\n`,
      ],
      ['lazy-paragraph-definition-lookalike.md', `paragraph\n[${'x'.repeat(513)}]: t.md\n`],
      ['lazy-quote-definition-lookalike.md', `> paragraph\n> [${'x'.repeat(513)}]: t.md\n`],
      ['lazy-list-definition-lookalike.md', `- paragraph\n  [${'x'.repeat(513)}]: t.md\n`],
      ['multiline-definition-title.md', `[d]: ${'x'.repeat(2_049)} "first\n second"\n`],
      ['incomplete-div-html-block.md', `<div\n[${'x'.repeat(513)}]: t.md\n`],
      ['incomplete-script-html-block.md', `<script\n[${'x'.repeat(513)}]: t.md\n`],
      ['attention-work-limit.md', `${'*a*\n'.repeat(512)}${'x\n'.repeat(7_681)}`],
      [
        'label-closing-work-limit.md',
        `${']'.repeat(2_896)}\n\n${']'.repeat(68)}\n\n${']'.repeat(13)}`,
      ],
      [
        'container-continuation-work-limit.md',
        `${'- '.repeat(64)}item\n${`${' '.repeat(128)}continued\n`.repeat(1_023)}`,
      ],
      ['image-candidate-limit.md', `${'![x]\n'.repeat(5_001)}\n[x]: i\n`],
      ['c1-link-paths.md', '[one](a%C2%80.md)\n[two](a%C2%85.md)\n'],
      ['ecmascript-c1-label-trim.md', `[\u0085${'x'.repeat(600)}](target.md)\n`],
      ['ecmascript-bom-label-trim.md', `[\uFEFF${'x'.repeat(200)}\uFEFF](target.md)\n`],
      ['dotless-reference-normalization.md', '[I]\n\n[ı]: target.md\n'],
      ['dotted-reference-normalization.md', '[İ]\n\n[i]: target.md\n'],
      ['nfc-reference-normalization.md', '[é]\n\n[e\u0301]: target.md\n'],
      [
        'canonical-first-definition-wins.md',
        '[i]: first.md\n[middle]: middle.md\n[ı]: second.md\n\n[ı]\n',
      ],
      [
        'casefold-first-definition-wins.md',
        '[SS]: first.md\n[middle]: middle.md\n[ß]: second.md\n\n[ß]\n',
      ],
      [
        'large-valid-reference-expansion.md',
        `${'[x]\n'.repeat(1_025)}\n[x]: x "${'t'.repeat(2_045)}"\n`,
      ],
      [
        'unused-definition-title.md',
        `${'[missing]\n'.repeat(1_025)}\n[unused]: x "${'t'.repeat(2_045)}"\n`,
      ],
      [
        'paragraph-custom-html-attention-limit.md',
        `paragraph\n<x-custom data-value="ok">\n${'*a* '.repeat(1_025)}\n`,
      ],
      ['lazy-indented-attention-limit.md', `paragraph\n    ${'*a* '.repeat(1_025)}\n`],
      ['multiline-code-span-attention-lookalike.md', `\`\`code\n${'*a* '.repeat(1_025)}\n\`\`\n`],
      ['autolink-attention-lookalike.md', `<https://example.test/${'_'.repeat(1_025)}>\n`],
      [
        'inline-html-attribute-attention-lookalike.md',
        `<span data-value="${'_'.repeat(1_025)}">text</span>\n`,
      ],
      ['inline-link-target-attention-lookalike.md', `[x](target-${'_'.repeat(1_025)}.md)\n`],
      [
        'duplicate-multiline-definition-target-limit.md',
        `[d]: x\n[d]: ${'a'.repeat(2_049)} "first\n second"\n`,
      ],
      ['inline-link-label-limit.md', `[${'x'.repeat(513)}](i)\n`],
      ['inline-link-target-limit.md', `[x](${'a'.repeat(2_049)})\n`],
      ['reference-link-label-limit.md', `[${'x'.repeat(513)}][d]\n\n[d]: i\n`],
      ['reference-link-target-limit.md', `[x][d]\n\n[d]: ${'a'.repeat(2_049)}\n`],
      ['inline-image-label-limit.md', `![${'x'.repeat(513)}](i)\n`],
      ['inline-image-target-limit.md', `![x](${'a'.repeat(2_049)})\n`],
      ['reference-image-label-limit.md', `![${'x'.repeat(513)}][d]\n\n[d]: i\n`],
      ['reference-image-target-limit.md', `![x][d]\n\n[d]: ${'a'.repeat(2_049)}\n`],
      [
        'opaque-media-limits.md',
        `\`![${'x'.repeat(513)}](${'a'.repeat(2_049)})\`\n\n\`[${'x'.repeat(513)}](${'a'.repeat(2_049)})\`\n`,
      ],
      [
        'fenced-opaque-media-limits.md',
        `\`\`\`\n![${'x'.repeat(513)}](${'a'.repeat(2_049)})\n[${'x'.repeat(513)}](${'a'.repeat(2_049)})\n\`\`\`\n`,
      ],
      [
        'html-opaque-media-limits.md',
        `<div>\n![${'x'.repeat(513)}](${'a'.repeat(2_049)})\n[${'x'.repeat(513)}](${'a'.repeat(2_049)})\n</div>\n`,
      ],
      [
        'indented-opaque-media-limits.md',
        `    ![${'x'.repeat(513)}](${'a'.repeat(2_049)})\n    [${'x'.repeat(513)}](${'a'.repeat(2_049)})\n`,
      ],
      [
        'reference-opaque-media-limits.md',
        `\`![${'x'.repeat(513)}][d]\`\n\n\`[${'x'.repeat(513)}][d]\`\n\n[d]: target.md\n`,
      ],
      ['invalid-inline-html-attention-limit.md', `<not html ${'*a* '.repeat(1_025)}>\n`],
      ['unmatched-link-suffix-attention-limit.md', `[x](${'*a* '.repeat(1_025)}\n`],
      [
        'multiline-inline-comment-attention-lookalike.md',
        `paragraph <!--\n${'*a* '.repeat(1_025)}\n-->\n`,
      ],
      [
        'lazy-list-inline-comment-attention-lookalike.md',
        `- paragraph <!--\ntext ${'*a* '.repeat(1_025)}\n-->\n`,
      ],
      [
        'lazy-ordered-list-inline-comment-attention-lookalike.md',
        `1. paragraph <!--\ntext ${'*a* '.repeat(1_025)}\n-->\n`,
      ],
      [
        'lazy-blockquote-inline-comment-attention-lookalike.md',
        `> paragraph <!--\ntext ${'*a* '.repeat(1_025)}\n-->\n`,
      ],
      [
        'unterminated-inline-comment-attention-limit.md',
        `paragraph <!--\n${'*a* '.repeat(1_025)}\n`,
      ],
      [
        'blank-separated-inline-comment-attention-limit.md',
        `paragraph <!--\n\n${'*a* '.repeat(1_025)}\n\n-->\n`,
      ],
      [
        'long-multiline-duplicate-definition-target-limit.md',
        `[d]: x\n[d]: ${'a'.repeat(2_049)} "first\n second\n third\n fourth"\n`,
      ],
      [
        'duplicate-definition-title-bracket-lookalike.md',
        `[d]: first.md\n[d]: second.md "${'['.repeat(65)}"\n\n[d]\n`,
      ],
      [
        'cross-container-duplicate-title-attention-limit.md',
        `[d]: first\n> [d]: second "title\n- ${'*a* '.repeat(1_025)}\n- end"\n`,
      ],
      [
        'sibling-list-duplicate-title-attention-limit.md',
        `[d]: first\n- [d]: second "title\n- ${'*a* '.repeat(1_025)}\n- end"\n`,
      ],
      [
        'sibling-ordered-list-duplicate-title-attention-limit.md',
        `[d]: first\n1. [d]: second "title\n2. ${'*a* '.repeat(1_025)}\n3. end"\n`,
      ],
      [
        'wide-ordered-list-duplicate-title-attention-limit.md',
        `[d]: first\n100. [d]: second "title\n  ${'*a* '.repeat(1_025)}\n  end"\n`,
      ],
      [
        'tab-bullet-duplicate-definition-target-limit.md',
        `[d]: first\n-\t[d]: ${'a'.repeat(2_049)} "title\nmore\nend"\n`,
      ],
      [
        'tab-ordered-duplicate-definition-target-limit.md',
        `[d]: first\n1.\t[d]: ${'a'.repeat(2_049)} "title\n more\n end"\n`,
      ],
      [
        'tab-ordered-zero-indent-definition-target-limit.md',
        `[d]: first\n1.\t[d]: ${'a'.repeat(2_049)} "title\nmore\nend"\n`,
      ],
      [
        'tab-noninterrupting-ordered-definition-lookalike.md',
        `[d]: first\n10.\t[d]: ${'a'.repeat(2_049)} "title\n  more\n  end"\n`,
      ],
      [
        'wide-tab-ordered-definition-lookalike.md',
        `[d]: first\n100.\t[d]: ${'a'.repeat(2_049)} "title\n     more\n     end"\n`,
      ],
      [
        'escaped-angle-duplicate-definition-target-limit.md',
        `[d]: first\n[d]: <a\\>${'b'.repeat(2_047)}> "first\n second\n third\n fourth"\n`,
      ],
      [
        'sibling-list-inline-comment-attention-limit.md',
        `- paragraph <!--\n- ${'*a* '.repeat(1_025)}\n- -->\n`,
      ],
      [
        'cross-container-inline-comment-attention-limit.md',
        `> paragraph <!--\n- ${'*a* '.repeat(1_025)}\n- -->\n`,
      ],
      ['multiline-reference-definition.md', '[r]:\n dest.md\n "title"\n'],
      [
        'multiline-reference-definition-before-duplicate.md',
        '[r]:\n dest.md\n "title"\n[r]: b.md\n',
      ],
      ['email-autolink.md', '<a@example.test>\n'],
      ['invalid-email-autolink.md', '<a!b@example.test>\n'],
      ['nested-autolink-order.md', '[<http://example.test/a>](f.md)\n'],
      ['http-autolink-in-image-alt.md', '![<http://example.test/a>](img.png)\n'],
      ['email-autolink-in-image-alt.md', '![<a@example.test>](img.png)\n'],
      ['autolink-in-image-in-outer-link.md', '[![<http://example.test/a>](img.png)](outer.md)\n'],
      [
        'multiline-reference-definition-label-limit.md',
        `[${'a'.repeat(300)}\n${'b'.repeat(213)}]: dest.md\n`,
      ],
      ['multiline-reference-definition-target-limit.md', `[foo\nbar]: ${'a'.repeat(2_049)}\n`],
      [
        'multiline-label-reference-definition-before-duplicate.md',
        '[foo\nbar]: dest.md\n[foo bar]: b.md\n',
      ],
      [
        'multiline-label-duplicate-definition-target-limit.md',
        `[foo bar]: first.md\n[foo\nbar]: ${'a'.repeat(2_049)}\n`,
      ],
      [
        'multiline-label-duplicate-title-bracket-lookalike.md',
        `[foo bar]: first.md\n[foo\nbar]: second.md\n "${'['.repeat(65)}"\n[foo bar]\n`,
      ],
    ] as const;
    for (const [path, body] of cases) {
      const input = inputFor([[path, concept(body)]], `fixture:/markdown-parity/${path}`);
      expect(core.inspect(input, '2026-07-22T12:00:00Z'), path).toEqual(
        typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z'),
      );
    }
    for (const [path, body] of [
      ['multiline-reference-definition.md', '[r]:\n dest.md\n "title"\n'],
      [
        'multiline-reference-definition-before-duplicate.md',
        '[r]:\n dest.md\n "title"\n[r]: b.md\n',
      ],
      ['invalid-email-autolink.md', '<a!b@example.test>\n'],
      ['http-autolink-in-image-alt.md', '![<http://example.test/a>](img.png)\n'],
      ['email-autolink-in-image-alt.md', '![<a@example.test>](img.png)\n'],
      [
        'multiline-label-reference-definition-before-duplicate.md',
        '[foo\nbar]: dest.md\n[foo bar]: b.md\n',
      ],
    ] as const) {
      const input = inputFor([[path, concept(body)]], `fixture:/markdown-parity/${path}`);
      expect(core.inspect(input, '2026-07-22T12:00:00Z').bundle.concepts[0]?.links, path).toEqual(
        [],
      );
    }
    const emailAutolinkInput = inputFor(
      [['email-autolink.md', concept('<a@example.test>\n')]],
      'fixture:/markdown-parity/email-autolink.md',
    );
    expect(
      core.inspect(emailAutolinkInput, '2026-07-22T12:00:00Z').bundle.concepts[0]?.links,
    ).toEqual([
      expect.objectContaining({ classification: 'external', rawTarget: 'mailto:a@example.test' }),
    ]);
    const nestedAutolinkInput = inputFor(
      [['nested-autolink-order.md', concept('[<http://example.test/a>](f.md)\n')]],
      'fixture:/markdown-parity/nested-autolink-order.md',
    );
    expect(
      core
        .inspect(nestedAutolinkInput, '2026-07-22T12:00:00Z')
        .bundle.concepts[0]?.links.map((link) => link.rawTarget),
    ).toEqual(['f.md', 'http://example.test/a']);
    const nestedImageAutolinkInput = inputFor(
      [
        [
          'autolink-in-image-in-outer-link.md',
          concept('[![<http://example.test/a>](img.png)](outer.md)\n'),
        ],
      ],
      'fixture:/markdown-parity/autolink-in-image-in-outer-link.md',
    );
    expect(
      core
        .inspect(nestedImageAutolinkInput, '2026-07-22T12:00:00Z')
        .bundle.concepts[0]?.links.map((link) => link.rawTarget),
    ).toEqual(['outer.md']);
    const multilineDuplicateTitleInput = inputFor(
      [
        [
          'multiline-label-duplicate-title-bracket-lookalike.md',
          concept(`[foo bar]: first.md\n[foo\nbar]: second.md\n "${'['.repeat(65)}"\n[foo bar]\n`),
        ],
      ],
      'fixture:/markdown-parity/multiline-label-duplicate-title-bracket-lookalike.md',
    );
    const multilineDuplicateTitleInspection = core.inspect(
      multilineDuplicateTitleInput,
      '2026-07-22T12:00:00Z',
    );
    expect(multilineDuplicateTitleInspection.bundle.failures).toEqual([]);
    expect(multilineDuplicateTitleInspection.bundle.concepts[0]?.links).toEqual([
      expect.objectContaining({ rawTarget: 'first.md' }),
    ]);
    for (const [path, body] of [
      [
        'multiline-reference-definition-label-limit.md',
        `[${'a'.repeat(300)}\n${'b'.repeat(213)}]: dest.md\n`,
      ],
      ['multiline-reference-definition-target-limit.md', `[foo\nbar]: ${'a'.repeat(2_049)}\n`],
      [
        'multiline-label-duplicate-definition-target-limit.md',
        `[foo bar]: first.md\n[foo\nbar]: ${'a'.repeat(2_049)}\n`,
      ],
    ] as const) {
      const input = inputFor([[path, concept(body)]], `fixture:/markdown-parity/${path}`);
      expect(core.inspect(input, '2026-07-22T12:00:00Z').bundle.failures, path).toEqual([
        expect.objectContaining({ reason: 'resource-limit' }),
      ]);
    }
    const overDefinitionInput = inputFor(
      [['definition-limit.md', concept(cases[3][1])]],
      'fixture:/markdown-parity/definition-limit.md',
    );
    expect(core.inspect(overDefinitionInput, '2026-07-22T12:00:00Z').bundle.failures).toEqual([
      expect.objectContaining({
        bundlePath: 'definition-limit.md',
        reason: 'resource-limit',
        message: expect.stringContaining('link definitions'),
      }),
    ]);
    const referenceExpansionInput = inputFor(
      [
        [
          'reference-expansion-boundary.md',
          concept(`${'[x]\n'.repeat(50)}\n[x]: ${'a'.repeat(2_048)}\n`),
        ],
      ],
      'fixture:/markdown-parity/reference-expansion-boundary.md',
    );
    expect(
      core.inspect(referenceExpansionInput, '2026-07-22T12:00:00Z').bundle.concepts[0]?.links,
    ).toHaveLength(50);
    const largeExpansionInput = inputFor(
      [
        [
          'large-valid-reference-expansion.md',
          concept(`${'[x]\n'.repeat(1_025)}\n[x]: x "${'t'.repeat(2_045)}"\n`),
        ],
      ],
      'fixture:/markdown-parity/large-valid-reference-expansion.md',
    );
    expect(
      core.inspect(largeExpansionInput, '2026-07-22T12:00:00Z').bundle.concepts[0]?.links,
    ).toHaveLength(1_025);
    const firstWinsInput = inputFor(
      [
        [
          'canonical-first-definition-wins.md',
          concept('[i]: first.md\n[middle]: middle.md\n[ı]: second.md\n\n[ı]\n'),
        ],
      ],
      'fixture:/markdown-parity/canonical-first-definition-wins.md',
    );
    expect(
      core.inspect(firstWinsInput, '2026-07-22T12:00:00Z').bundle.concepts[0]?.links[0]?.rawTarget,
    ).toBe('first.md');
    for (const count of [49, 50, 60, 100]) {
      const input = inputFor(
        [
          [
            `canonical-first-definition-fuel-${String(count)}.md`,
            concept(
              `${'[ı]\n'.repeat(count)}\n[i]: first.md\n[ı]: second.md "${'t'.repeat(2_045)}"\n`,
            ),
          ],
        ],
        `fixture:/markdown-parity/canonical-first-definition-fuel-${String(count)}.md`,
      );
      const inspection = core.inspect(input, '2026-07-22T12:00:00Z');
      expect(inspection, String(count)).toEqual(
        typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z'),
      );
      expect(inspection.bundle.concepts[0]?.links, String(count)).toHaveLength(count);
      expect(
        inspection.bundle.concepts[0]?.links.every((link) => link.rawTarget === 'first.md'),
        String(count),
      ).toBe(true);
    }
    for (const [path, body] of [
      [
        'paragraph-custom-html-attention-limit.md',
        `paragraph\n<x-custom data-value="ok">\n${'*a* '.repeat(1_025)}\n`,
      ],
      ['lazy-indented-attention-limit.md', `paragraph\n    ${'*a* '.repeat(1_025)}\n`],
      ['inline-image-label-limit.md', `![${'x'.repeat(513)}](i)\n`],
      ['inline-image-target-limit.md', `![x](${'a'.repeat(2_049)})\n`],
      ['reference-image-label-limit.md', `![${'x'.repeat(513)}][d]\n\n[d]: i\n`],
      ['reference-image-target-limit.md', `![x][d]\n\n[d]: ${'a'.repeat(2_049)}\n`],
      ['invalid-inline-html-attention-limit.md', `<not html ${'*a* '.repeat(1_025)}>\n`],
      ['unmatched-link-suffix-attention-limit.md', `[x](${'*a* '.repeat(1_025)}\n`],
      [
        'unterminated-inline-comment-attention-limit.md',
        `paragraph <!--\n${'*a* '.repeat(1_025)}\n`,
      ],
      [
        'blank-separated-inline-comment-attention-limit.md',
        `paragraph <!--\n\n${'*a* '.repeat(1_025)}\n\n-->\n`,
      ],
      [
        'cross-container-duplicate-title-attention-limit.md',
        `[d]: first\n> [d]: second "title\n- ${'*a* '.repeat(1_025)}\n- end"\n`,
      ],
      [
        'sibling-list-duplicate-title-attention-limit.md',
        `[d]: first\n- [d]: second "title\n- ${'*a* '.repeat(1_025)}\n- end"\n`,
      ],
      [
        'sibling-ordered-list-duplicate-title-attention-limit.md',
        `[d]: first\n1. [d]: second "title\n2. ${'*a* '.repeat(1_025)}\n3. end"\n`,
      ],
      [
        'wide-ordered-list-duplicate-title-attention-limit.md',
        `[d]: first\n100. [d]: second "title\n  ${'*a* '.repeat(1_025)}\n  end"\n`,
      ],
      [
        'tab-bullet-duplicate-definition-target-limit.md',
        `[d]: first\n-\t[d]: ${'a'.repeat(2_049)} "title\nmore\nend"\n`,
      ],
      [
        'tab-ordered-duplicate-definition-target-limit.md',
        `[d]: first\n1.\t[d]: ${'a'.repeat(2_049)} "title\n more\n end"\n`,
      ],
      [
        'tab-ordered-zero-indent-definition-target-limit.md',
        `[d]: first\n1.\t[d]: ${'a'.repeat(2_049)} "title\nmore\nend"\n`,
      ],
      [
        'escaped-angle-duplicate-definition-target-limit.md',
        `[d]: first\n[d]: <a\\>${'b'.repeat(2_047)}> "first\n second\n third\n fourth"\n`,
      ],
      [
        'sibling-list-inline-comment-attention-limit.md',
        `- paragraph <!--\n- ${'*a* '.repeat(1_025)}\n- -->\n`,
      ],
      [
        'cross-container-inline-comment-attention-limit.md',
        `> paragraph <!--\n- ${'*a* '.repeat(1_025)}\n- -->\n`,
      ],
      [
        'long-multiline-duplicate-definition-target-limit.md',
        `[d]: x\n[d]: ${'a'.repeat(2_049)} "first\n second\n third\n fourth"\n`,
      ],
    ] as const) {
      const input = inputFor([[path, concept(body)]], `fixture:/markdown-parity/${path}`);
      expect(core.inspect(input, '2026-07-22T12:00:00Z').bundle.failures, path).toEqual([
        expect.objectContaining({ reason: 'resource-limit' }),
      ]);
    }
    const boundedExpansionBody = `${'[x]\n'.repeat(4_500)}\n[x]: x "${'t'.repeat(235_000)}"\n`;
    const boundedExpansionInput = inputFor(
      [['bounded-reference-expansion.md', concept(boundedExpansionBody)]],
      'fixture:/markdown-parity/bounded-reference-expansion.md',
    );
    const boundedExpansion = core.inspect(boundedExpansionInput, '2026-07-22T12:00:00Z');
    expect(boundedExpansion).toEqual(
      typescriptOkfCore.inspect(boundedExpansionInput, '2026-07-22T12:00:00Z'),
    );
    expect(boundedExpansion.bundle.concepts[0]?.links).toHaveLength(4_500);
    const malformedDuplicateDefinitionsBody = `[d]: x\n${`[d]: x "${'a'.repeat(40)}\n`.repeat(4_500)}`;
    const malformedDuplicateDefinitionsInput = inputFor(
      [
        [
          'malformed-duplicate-definition-title-fuel.md',
          concept(malformedDuplicateDefinitionsBody),
        ],
      ],
      'fixture:/markdown-parity/malformed-duplicate-definition-title-fuel.md',
    );
    expect(core.inspect(malformedDuplicateDefinitionsInput, '2026-07-22T12:00:00Z')).toEqual(
      typescriptOkfCore.inspect(malformedDuplicateDefinitionsInput, '2026-07-22T12:00:00Z'),
    );
    const multilineLinkFuelBody = `[${'f'.repeat(38)}\n${'b'.repeat(38)}](x)\n`.repeat(2_400);
    const multilineLinkFuelInput = inputFor(
      [['multiline-link-fuel.md', concept(multilineLinkFuelBody)]],
      'fixture:/markdown-parity/multiline-link-fuel.md',
    );
    const multilineLinkFuelInspection = core.inspect(
      multilineLinkFuelInput,
      '2026-07-22T12:00:00Z',
    );
    expect(multilineLinkFuelInspection).toEqual(
      typescriptOkfCore.inspect(multilineLinkFuelInput, '2026-07-22T12:00:00Z'),
    );
    expect(multilineLinkFuelInspection.bundle.concepts[0]?.links).toHaveLength(2_400);
    for (const [path, body] of [
      [
        'multiline-inline-comment-attention-lookalike.md',
        `paragraph <!--\n${'*a* '.repeat(1_025)}\n-->\n`,
      ],
      [
        'duplicate-definition-title-bracket-lookalike.md',
        `[d]: first.md\n[d]: second.md "${'['.repeat(65)}"\n\n[d]\n`,
      ],
      [
        'lazy-list-inline-comment-attention-lookalike.md',
        `- paragraph <!--\ntext ${'*a* '.repeat(1_025)}\n-->\n`,
      ],
      [
        'lazy-ordered-list-inline-comment-attention-lookalike.md',
        `1. paragraph <!--\ntext ${'*a* '.repeat(1_025)}\n-->\n`,
      ],
      [
        'lazy-blockquote-inline-comment-attention-lookalike.md',
        `> paragraph <!--\ntext ${'*a* '.repeat(1_025)}\n-->\n`,
      ],
      [
        'wide-tab-ordered-definition-lookalike.md',
        `[d]: first\n100.\t[d]: ${'a'.repeat(2_049)} "title\n     more\n     end"\n`,
      ],
      [
        'tab-noninterrupting-ordered-definition-lookalike.md',
        `[d]: first\n10.\t[d]: ${'a'.repeat(2_049)} "title\n  more\n  end"\n`,
      ],
    ] as const) {
      const input = inputFor([[path, concept(body)]], `fixture:/markdown-parity/${path}`);
      expect(core.inspect(input, '2026-07-22T12:00:00Z').bundle.failures, path).toEqual([]);
    }
  }, 30_000);

  test('matches YAML resource and YAML 1.2 shape boundaries', () => {
    const aliases = (count: number, seed = 'x'): string =>
      `seed: &a !!str ${seed}\ncustom: [${Array.from({ length: count }, () => '*a').join(',')}]\n`;
    const nestedFlow = (depth: number): string =>
      `custom: ${'['.repeat(depth)}leaf${']'.repeat(depth)}\n`;
    const nestedBlockMapping = (depth: number): string =>
      [
        'custom:',
        ...Array.from({ length: depth }, (_, index) => {
          const level = index + 1;
          return `${' '.repeat(level)}level-${String(level)}:${level === depth ? ' leaf' : ''}`;
        }),
        '',
      ].join('\n');
    const recursiveAliases = (factor: number, depth: number): string => {
      const lines = ['a0: &a0 scalar'];
      for (let level = 1; level <= depth; level += 1) {
        lines.push(
          `a${String(level)}: &a${String(level)} [${Array.from(
            { length: factor },
            () => `*a${String(level - 1)}`,
          ).join(',')}]`,
        );
      }
      lines.push(`custom: *a${String(depth)}`, '');
      return lines.join('\n');
    };
    const deeplyNestedFlow = `${'['.repeat(65)}x${']'.repeat(65)}`;
    const cases = [
      ['alias-limit-exact.md', concept('', aliases(100))],
      ['alias-limit-exceeded.md', concept('', aliases(101))],
      ['alias-output-exceeded.md', concept('', aliases(100, 'x'.repeat(2_048)))],
      ['alias-output-before-count.md', concept('', aliases(101, 'x'.repeat(2_048)))],
      [
        'radix-set-output-exceeded.md',
        concept('', `custom: !!set { ? 0x${'F'.repeat(60_000)} }\n`),
      ],
      ['recursive-alias-expansion.md', concept('', recursiveAliases(10, 2))],
      ['recursive-alias-repetition-limit.md', concept('', recursiveAliases(5, 5))],
      ['self-recursive-alias.md', concept('', 'custom: &self [*self]\n')],
      [
        'alias-lookalikes.md',
        concept(
          '',
          'quoted: "*missing"\nplain: prefix *missing\nblock: |-\n  *missing\n# *missing\n',
        ),
      ],
      [
        'leading-zero-values.md',
        concept('', 'zero: 00\none: 01\npositive: +0123\nnegative: -0123\n'),
      ],
      ['leading-zero-key.md', concept('', 'custom: { 01: value }\n')],
      ['tight-flow-scalars.md', concept('', 'custom: [?foo, a?b, :foo]\n')],
      ['nesting-exact.md', concept('', nestedFlow(64))],
      ['nesting-exceeded.md', concept('', nestedFlow(65))],
      ['block-nesting-exact.md', concept('', nestedBlockMapping(64))],
      ['block-nesting-exceeded.md', concept('', nestedBlockMapping(65))],
      ['compact-nesting-exact.md', concept('', `custom:\n  ${'- '.repeat(64)}leaf\n`)],
      ['compact-nesting-exceeded.md', concept('', `custom:\n  ${'- '.repeat(65)}leaf\n`)],
      [
        'implicit-flow-map-nesting-exact.md',
        concept('', `custom: ${'['.repeat(63)}key: value${']'.repeat(63)}\n`),
      ],
      [
        'implicit-flow-map-nesting-exceeded.md',
        concept('', `custom: ${'['.repeat(64)}key: value${']'.repeat(64)}\n`),
      ],
      ['tight-hash-flow-nesting.md', concept('', `custom: [foo#bar, ${deeplyNestedFlow}]\n`)],
      ['url-hash-flow-nesting.md', concept('', `custom: [http://x#frag, ${deeplyNestedFlow}]\n`)],
      ['tight-hash-flow-map-nesting.md', concept('', `custom: {foo#bar: ${deeplyNestedFlow}}\n`)],
      ['plain-bracket-lookalike.md', concept('', `custom: prefix ${'['.repeat(65)}\n`)],
      ['plain-brace-lookalike.md', concept('', `custom: prefix ${'{'.repeat(65)}\n`)],
      [
        'plain-url-flow-lookalike.md',
        concept('', `custom: http://example.test/x#frag/${'['.repeat(65)}\n`),
      ],
      ['yaml-bom.md', '---\n\uFEFFtype: reference\n---\n'],
      ['multiple-yaml-documents.md', '---\ntype: reference\n...\nafter: x\n---\n'],
      ['indented-document-marker-lookalike.md', concept('', 'custom: first\n  ...\nafter: ok\n')],
      [
        'deferred-document-marker-lookalike.md',
        concept('', 'custom:\n  first\n  ...\nafter: ok\n'),
      ],
      [
        'deferred-plain-comment-gap.md',
        concept('', 'custom:\n  first\n  # gap\n  !!str text\nafter: ok\n'),
      ],
    ] as const;
    for (const [path, content] of cases) {
      const input = inputFor([[path, content]], `fixture:/yaml-resource-parity/${path}`);
      expect(core.inspect(input, '2026-07-22T12:00:00Z'), path).toEqual(
        typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z'),
      );
    }
    const radixAggregate = inputFor(
      Array.from(
        { length: 100 },
        (_, index) =>
          [
            `radix-${String(index)}.md`,
            concept(
              '',
              `custom: !!set { ? 0x${'F'.repeat(58_996)}${index.toString(16).padStart(4, '0')} }\n`,
            ),
          ] as const,
      ),
      'fixture:/yaml-resource-parity/radix-aggregate',
    );
    expect(core.inspect(radixAggregate, '2026-07-22T12:00:00Z')).toEqual(
      typescriptOkfCore.inspect(radixAggregate, '2026-07-22T12:00:00Z'),
    );
  }, 30_000);

  test('matches aggregate Markdown and YAML bundle work limits', () => {
    const markdownInput = inputFor(
      Array.from({ length: 81 }, (_, index) => [
        `syntax-${String(index).padStart(3, '0')}.md`,
        concept('!'.repeat(1_000)),
      ]),
      'fixture:/aggregate-markdown-work',
    );
    const frontmatterInput = inputFor(
      Array.from({ length: 129 }, (_, index) => [
        `frontmatter-${String(index).padStart(3, '0')}.md`,
        concept('', `custom: "${'a'.repeat(65_500)}"\n`),
      ]),
      'fixture:/aggregate-frontmatter-work',
    );
    const attentionInput = inputFor(
      Array.from({ length: 5 }, (_, index) => [
        `attention-${String(index)}.md`,
        concept(`${'*a*\n'.repeat(512)}${'x\n'.repeat(7_680)}`),
      ]),
      'fixture:/aggregate-markdown-attention-work',
    );
    const containerInput = inputFor(
      Array.from({ length: 5 }, (_, index) => [
        `container-${String(index)}.md`,
        concept(`${'- '.repeat(64)}item\n${`${' '.repeat(128)}continued\n`.repeat(1_022)}`),
      ]),
      'fixture:/aggregate-markdown-container-work',
    );
    const labelEndInput = inputFor(
      Array.from({ length: 5 }, (_, index) => [
        `label-end-${String(index)}.md`,
        concept(`${']'.repeat(2_896)}\n\n${']'.repeat(68)}\n\n${']'.repeat(12)}`),
      ]),
      'fixture:/aggregate-markdown-label-end-work',
    );
    const linkCandidateInput = inputFor(
      Array.from({ length: 4 }, (_, index) => [
        `link-candidate-${String(index)}.md`,
        concept(`${'![x]\n'.repeat(5_000)}\n[x]: i\n`),
      ]),
      'fixture:/aggregate-markdown-link-candidates',
    );
    for (const input of [
      markdownInput,
      frontmatterInput,
      attentionInput,
      containerInput,
      labelEndInput,
      linkCandidateInput,
    ]) {
      let expected: unknown;
      let actual: unknown;
      try {
        typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z');
      } catch (error: unknown) {
        expected = error;
      }
      try {
        core.inspect(input, '2026-07-22T12:00:00Z');
      } catch (error: unknown) {
        actual = error;
      }
      expect(actual).toBeInstanceOf(GraphResourceLimitError);
      expect(expected).toBeInstanceOf(GraphResourceLimitError);
      expect((actual as Error).message).toBe((expected as Error).message);
    }
  }, 60_000);

  test('enforces graph revision and root URI boundaries before publication', () => {
    const exactRevision = { ...inputFor([], ''), revision: Number.MAX_SAFE_INTEGER };
    expect(core.inspect(exactRevision, '2026-07-22T12:00:00Z')).toEqual(
      typescriptOkfCore.inspect(exactRevision, '2026-07-22T12:00:00Z'),
    );

    const unsafeRevision = { ...exactRevision, revision: Number.MAX_SAFE_INTEGER + 1 };
    expectGraphLimitParity(unsafeRevision);

    const exactRoot = inputFor([], 'r'.repeat(OKF_SEMANTIC_LIMITS.maxSourceUriCodeUnits));
    expect(core.inspect(exactRoot, '2026-07-22T12:00:00Z')).toEqual(
      typescriptOkfCore.inspect(exactRoot, '2026-07-22T12:00:00Z'),
    );
    expectGraphLimitParity(inputFor([], 'r'.repeat(OKF_SEMANTIC_LIMITS.maxSourceUriCodeUnits + 1)));
  });

  test('enforces exact and one-over failure count and identity graph budgets', () => {
    const input = inputFor([], '');
    const failure = (uri: string): ParseFailure => ({
      kind: 'parse-failure',
      uri,
      bundlePath: '',
      reason: 'read',
      message: '',
    });
    const exactCount = Array.from({ length: OKF_SEMANTIC_LIMITS.maxFindings }, (_, index) =>
      failure(`u${String(index)}`),
    );
    expect(core.inspect(input, '2026-07-22T12:00:00Z', exactCount).findings).toHaveLength(
      OKF_SEMANTIC_LIMITS.maxFindings,
    );
    expect(
      typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z', exactCount).findings,
    ).toHaveLength(OKF_SEMANTIC_LIMITS.maxFindings);
    expectGraphLimitParity(input, [...exactCount, failure('one-over')]);

    const maximalUri = (index: number): string => {
      const suffix = String(index);
      return `${'u'.repeat(OKF_SEMANTIC_LIMITS.maxSourceUriBytes - suffix.length)}${suffix}`;
    };
    const exactIdentityCount =
      OKF_SEMANTIC_LIMITS.maxGraphIdentityBytes / (OKF_SEMANTIC_LIMITS.maxSourceUriBytes * 2);
    const exactIdentity = Array.from({ length: exactIdentityCount }, (_, index) =>
      failure(maximalUri(index)),
    );
    expect(core.inspect(input, '2026-07-22T12:00:00Z', exactIdentity).graph.nodes).toEqual([]);
    expect(
      typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z', exactIdentity).graph.nodes,
    ).toEqual([]);
    expectGraphLimitParity(input, [...exactIdentity, failure(maximalUri(exactIdentityCount))]);

    const documentIdentityUnits =
      OKF_SEMANTIC_LIMITS.maxSourceUriBytes * 3 +
      OKF_SEMANTIC_LIMITS.maxProviderPathBytes * 2 +
      (OKF_SEMANTIC_LIMITS.maxProviderPathBytes - '.md'.length);
    const exactDocumentCount = Math.floor(
      OKF_SEMANTIC_LIMITS.maxGraphIdentityBytes / documentIdentityUnits,
    );
    const documentIdentityInput = (count: number): readonly [ParseBundleInput, ParseFailure[]] => {
      const entries = Array.from({ length: count }, (_, index) => {
        const suffix = `-${String(index)}.md`;
        const bundlePath = `${'p'.repeat(
          OKF_SEMANTIC_LIMITS.maxProviderPathBytes - suffix.length,
        )}${suffix}`;
        const uriSuffix = String(index);
        const uri = `${'u'.repeat(
          OKF_SEMANTIC_LIMITS.maxSourceUriBytes - uriSuffix.length,
        )}${uriSuffix}`;
        return { bundlePath, uri };
      });
      return [
        {
          rootUri: '',
          revision: 7,
          documents: entries.map(({ bundlePath, uri }) => ({
            bundlePath,
            uri,
            content: concept(''),
          })),
        },
        entries.map(({ bundlePath, uri }) => ({ ...failure(uri), bundlePath })),
      ];
    };
    const [exactDocuments, exactDocumentFailures] = documentIdentityInput(exactDocumentCount);
    expect(
      core.inspect(exactDocuments, '2026-07-22T12:00:00Z', exactDocumentFailures).graph.nodes,
    ).toHaveLength(exactDocumentCount);
    expect(
      typescriptOkfCore.inspect(exactDocuments, '2026-07-22T12:00:00Z', exactDocumentFailures).graph
        .nodes,
    ).toHaveLength(exactDocumentCount);
    const [oneOverDocuments, oneOverDocumentFailures] = documentIdentityInput(
      exactDocumentCount + 1,
    );
    expectGraphLimitParity(oneOverDocuments, oneOverDocumentFailures);
  }, 60_000);

  test('enforces the escaped 16 MiB graph JSON cap at the Wasm boundary', () => {
    const payloadInput = (count: number): ParseBundleInput =>
      inputFor(
        Array.from({ length: count }, (_, index) => [
          `payload-${String(index).padStart(3, '0')}.md`,
          concept(
            '',
            `description: "${'\t'.repeat(OKF_SEMANTIC_LIMITS.maxDescriptionCodeUnits)}"\n`,
          ),
        ]),
        'fixture:/graph-payload-cap',
      );
    const exact = payloadInput(509);
    expect(core.inspect(exact, '2026-07-22T12:00:00Z').graph.nodes).toHaveLength(509);
    expect(typescriptOkfCore.inspect(exact, '2026-07-22T12:00:00Z').graph.nodes).toHaveLength(509);
    expectGraphLimitParity(payloadInput(510));
  }, 60_000);

  test('matches aggregate graph metadata exact and one-over parser limits', () => {
    const uniqueTypes = (count: number): ParseBundleInput =>
      inputFor(
        Array.from({ length: count }, (_, index) => [
          `type-${String(index).padStart(3, '0')}.md`,
          concept('', '', `type-${String(index)}`),
        ]),
        'fixture:/aggregate-unique-types',
      );
    const exactTypes = uniqueTypes(OKF_SEMANTIC_LIMITS.maxUniqueGraphTypes);
    expect(core.inspect(exactTypes, '2026-07-22T12:00:00Z').graph.nodes).toHaveLength(
      OKF_SEMANTIC_LIMITS.maxUniqueGraphTypes,
    );
    expect(typescriptOkfCore.inspect(exactTypes, '2026-07-22T12:00:00Z').graph.nodes).toHaveLength(
      OKF_SEMANTIC_LIMITS.maxUniqueGraphTypes,
    );
    expectGraphLimitParity(uniqueTypes(OKF_SEMANTIC_LIMITS.maxUniqueGraphTypes + 1));

    const uniqueTags = (oneOver: boolean): ParseBundleInput => {
      const documents = Array.from(
        { length: OKF_SEMANTIC_LIMITS.maxUniqueGraphTags / OKF_SEMANTIC_LIMITS.maxTagsPerConcept },
        (_, documentIndex) => {
          const tags = Array.from(
            { length: OKF_SEMANTIC_LIMITS.maxTagsPerConcept },
            (_, tagIndex) =>
              `tag-${String(documentIndex * OKF_SEMANTIC_LIMITS.maxTagsPerConcept + tagIndex)}`,
          );
          return [
            `tags-${String(documentIndex).padStart(2, '0')}.md`,
            concept('', `tags: [${tags.join(', ')}]\n`),
          ] as const;
        },
      );
      if (oneOver) documents.push(['tags-over.md', concept('', 'tags: [tag-over]\n')]);
      return inputFor(documents, 'fixture:/aggregate-unique-tags');
    };
    const exactUniqueTags = uniqueTags(false);
    expect(
      Object.keys(core.inspect(exactUniqueTags, '2026-07-22T12:00:00Z').graph.statistics.tagCounts),
    ).toHaveLength(OKF_SEMANTIC_LIMITS.maxUniqueGraphTags);
    expect(
      Object.keys(
        typescriptOkfCore.inspect(exactUniqueTags, '2026-07-22T12:00:00Z').graph.statistics
          .tagCounts,
      ),
    ).toHaveLength(OKF_SEMANTIC_LIMITS.maxUniqueGraphTags);
    expectGraphLimitParity(uniqueTags(true));

    const sharedTags = Array.from(
      { length: OKF_SEMANTIC_LIMITS.maxTagsPerConcept },
      (_, index) => `shared-${String(index)}`,
    );
    const tagAssignments = (lastCount: number): ParseBundleInput =>
      inputFor(
        [
          ...Array.from(
            { length: 156 },
            (_, index) =>
              [
                `assignment-${String(index).padStart(3, '0')}.md`,
                concept('', `tags: [${sharedTags.join(', ')}]\n`),
              ] as const,
          ),
          [
            'assignment-last.md',
            concept('', `tags: [${sharedTags.slice(0, lastCount).join(', ')}]\n`),
          ] as const,
        ],
        'fixture:/aggregate-tag-assignments',
      );
    const exactAssignments = tagAssignments(32);
    expect(core.inspect(exactAssignments, '2026-07-22T12:00:00Z').graph.nodes).toHaveLength(157);
    expect(
      typescriptOkfCore.inspect(exactAssignments, '2026-07-22T12:00:00Z').graph.nodes,
    ).toHaveLength(157);
    expectGraphLimitParity(tagAssignments(33));
  }, 60_000);

  test('matches the exact and one-over aggregate retained-link-text limit', () => {
    const maximalLabel = 'l'.repeat(OKF_SEMANTIC_LIMITS.maxLinkLabelBytes);
    const maximalTarget = `${'t'.repeat(OKF_SEMANTIC_LIMITS.maxLinkTargetBytes - 3)}.md`;
    const exactFullLinks = Math.floor(
      OKF_SEMANTIC_LIMITS.maxBundleLinkTextUnits /
        (OKF_SEMANTIC_LIMITS.maxLinkLabelBytes + OKF_SEMANTIC_LIMITS.maxLinkTargetBytes),
    );
    const remainder =
      OKF_SEMANTIC_LIMITS.maxBundleLinkTextUnits -
      exactFullLinks *
        (OKF_SEMANTIC_LIMITS.maxLinkLabelBytes + OKF_SEMANTIC_LIMITS.maxLinkTargetBytes);
    const linksInput = (oneOver: boolean): ParseBundleInput => {
      const documents: [string, string][] = Array.from({ length: exactFullLinks }, (_, index) => [
        `link-${String(index).padStart(4, '0')}.md`,
        concept(`[${maximalLabel}](${maximalTarget})\n`),
      ]);
      documents.push([
        'link-remainder.md',
        concept(`[${maximalLabel}](${'r'.repeat(remainder - maximalLabel.length - 3)}.md)\n`),
      ]);
      if (oneOver) documents.push(['link-over.md', concept('[x](x)\n')]);
      return inputFor(documents, 'fixture:/aggregate-link-text');
    };
    const exactLinks = linksInput(false);
    expect(core.inspect(exactLinks, '2026-07-22T12:00:00Z').graph.nodes).toHaveLength(
      exactFullLinks + 1,
    );
    expect(typescriptOkfCore.inspect(exactLinks, '2026-07-22T12:00:00Z').graph.nodes).toHaveLength(
      exactFullLinks + 1,
    );
    expectGraphLimitParity(linksInput(true));
  }, 60_000);

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
              'sources: [{ resource: https://example.com/source, author: "team:" }]',
              '',
            ].join('\n'),
            'Reference',
          ),
        ],
        [
          'canonical-source-author.md',
          concept(
            '',
            [
              'sources:',
              '  - resource: https://developers.google.com/analytics/bigquery/export-schema',
              '    author: team:ga4-docs',
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

  test('extra root-index frontmatter has exact conformance URI and field-range parity', () => {
    const rootUri = 'fixture:/validation-root-index';
    const input = inputFor(
      [['index.md', '---\nokf_version: "0.2"\ntitle: extra\n---\n# Root\n']],
      rootUri,
    );
    const expectedFinding = {
      code: 'okf.conformance.reserved-frontmatter',
      category: 'conformance',
      severity: 'error',
      uri: `${rootUri}/index.md`,
      range: {
        start: { offset: 23, line: 2, character: 0 },
        end: { offset: 35, line: 2, character: 12 },
      },
      message:
        'OKF conformance: bundle-root index.md frontmatter may contain only `okf_version`; unexpected field "title" is not allowed.',
      correctiveAction:
        'Remove the extra root-index frontmatter field. Workbench retains it until you explicitly repair the document.',
    };

    const oracle = typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z');
    expect(oracle.bundle.reservedDocuments[0]?.frontmatter?.raw.title).toBe('extra');
    expect(oracle.findings).toEqual([expectedFinding]);
    expect(core.inspect(input, '2026-07-22T12:00:00Z')).toEqual(oracle);
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

function expectGraphLimitParity(
  input: ParseBundleInput,
  failures: readonly ParseFailure[] = [],
): void {
  let expected: unknown;
  let actual: unknown;
  try {
    typescriptOkfCore.inspect(input, '2026-07-22T12:00:00Z', failures);
  } catch (error: unknown) {
    expected = error;
  }
  try {
    core.inspect(input, '2026-07-22T12:00:00Z', failures);
  } catch (error: unknown) {
    actual = error;
  }
  expect(actual).toBeInstanceOf(GraphResourceLimitError);
  expect(expected).toBeInstanceOf(GraphResourceLimitError);
  expect((actual as Error).message).toBe((expected as Error).message);
}

function rawWasmRequest(request: unknown): {
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
} {
  return rawWasmRequestJson(JSON.stringify(request));
}

function rawRevisionRequest(operation: 'graph' | 'inspect', revision: string): string {
  const bundle = `{"rootUri":"fixture:/revision-lexeme","revision":${revision},"documents":[]}`;
  return operation === 'graph'
    ? `{"operation":"graph","input":${bundle}}`
    : `{"operation":"inspect","input":{"bundle":${bundle},"now":"2026-07-22T12:00:00Z","failures":[]}}`;
}

function rawWasmRequestJson(request: string): {
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
} {
  const instance = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {});
  const exports = instance.exports as unknown as {
    readonly memory: WebAssembly.Memory;
    readonly okf_alloc: (length: number) => number;
    readonly okf_call: (pointer: number, length: number) => bigint;
    readonly okf_dealloc: (pointer: number, length: number) => void;
  };
  const bytes = new TextEncoder().encode(request);
  const pointer = exports.okf_alloc(bytes.byteLength);
  new Uint8Array(exports.memory.buffer, pointer, bytes.byteLength).set(bytes);
  const packed = exports.okf_call(pointer, bytes.byteLength);
  const responsePointer = Number(packed >> 32n);
  const responseLength = Number(packed & 0xffff_ffffn);
  const response = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(
      new Uint8Array(exports.memory.buffer, responsePointer, responseLength),
    ),
  ) as {
    readonly result?: unknown;
    readonly error?: { readonly code: string; readonly message: string };
  };
  exports.okf_dealloc(responsePointer, responseLength);
  return response;
}
