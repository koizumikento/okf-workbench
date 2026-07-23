import { describe, expect, it } from 'vitest';

import { buildGraphPayload } from '../../../src/core/graph/index.js';
import {
  EXACT_YAML_INTEGER_KEY,
  parseBundle,
  YAML_TAGGED_VALUE_KEY,
} from '../../../src/core/parser/index.js';
import type { BundleDocumentInput } from '../../../src/core/parser/index.js';
import { VALIDATION_CODES, validateBundle } from '../../../src/core/validation/index.js';

const rootUri = 'vscode-remote://ssh-remote+example/workspace/knowledge';

function document(
  bundlePath: string,
  content: string | Uint8Array,
  contentHash?: string,
): BundleDocumentInput {
  return {
    uri: `${rootUri}/${bundlePath.replaceAll('\\', '/')}`,
    bundlePath,
    content,
    ...(contentHash === undefined ? {} : { contentHash }),
  };
}

function concept(type: string, body = '', additional = ''): string {
  return `---\ntype: ${type}\n${additional}---\n${body}`;
}

describe('OKF bundle parser', () => {
  it('classifies reserved documents, canonicalizes IDs, and preserves JSON-safe producer fields', () => {
    const customConcept = [
      '---',
      'type: custom-kind',
      'title: Unicode 知識',
      'description: A producer-owned concept',
      'tags: [alpha, 日本語]',
      'producer:',
      '  enabled: true',
      '  threshold: 0.75',
      '  values: [null, one]',
      '---',
      '# Body',
      '',
    ].join('\n');

    const bundle = parseBundle({
      rootUri,
      revision: 4,
      documents: [
        document('topic\\Unicode 知識.md', customConcept, 'sha256:producer'),
        document('history\\log.md', '# History\n'),
        document('metadata\\index.md', '---\ntitle: Invalid nested frontmatter\n---\n# Metadata\n'),
        document('topic\\index.md', '# Topic\n'),
        document('index.md', '---\nokf_version: "0.1"\nproducer_flag: true\n---\n# Root\n'),
        document('ignored.bin', new Uint8Array([0xff, 0xfe])),
      ],
    });

    expect(bundle.revision).toBe(4);
    expect(bundle.failures).toEqual([]);
    expect(bundle.concepts.map(({ id }) => id)).toEqual(['topic/Unicode 知識']);
    expect(bundle.reservedDocuments.map(({ source }) => source.bundlePath)).toEqual([
      'history/log.md',
      'index.md',
      'metadata/index.md',
      'topic/index.md',
    ]);

    const parsed = bundle.concepts[0];
    expect(parsed).toBeDefined();
    expect(parsed?.source.contentHash).toBe('sha256:producer');
    expect(parsed?.type).toBe('custom-kind');
    expect(parsed?.title).toBe('Unicode 知識');
    expect(parsed?.tags).toEqual(['alpha', '日本語']);
    expect(parsed?.frontmatter.raw.producer).toEqual({
      enabled: true,
      threshold: 0.75,
      values: [null, 'one'],
    });
    expect(parsed?.frontmatter.source).toContain('producer:');

    const typeRange = parsed?.frontmatter.fields.type;
    expect(typeRange).toBeDefined();
    if (typeRange !== undefined) {
      expect(customConcept.slice(typeRange.start.offset, typeRange.end.offset)).toBe(
        'type: custom-kind',
      );
    }

    const rootIndex = bundle.reservedDocuments.find(
      ({ source }) => source.bundlePath === 'index.md',
    );
    expect(rootIndex?.reservedKind).toBe('index');
    expect(rootIndex?.okfVersion).toBe('0.1');
    expect(rootIndex?.frontmatter?.raw.producer_flag).toBe(true);
    expect(rootIndex?.body).toBe('# Root\n');

    const nestedIndex = bundle.reservedDocuments.find(
      ({ source }) => source.bundlePath === 'metadata/index.md',
    );
    expect(nestedIndex?.frontmatter?.raw.title).toBe('Invalid nested frontmatter');
    expect(nestedIndex?.okfVersion).toBeUndefined();
    expect(nestedIndex?.body).toBe('# Metadata\n');
  });

  it('strictly decodes UTF-8 and continues after decode and YAML failures', () => {
    const invalidYaml = '---\ntype: [unterminated\n---\n# Broken\n';
    const bundle = parseBundle({
      rootUri,
      revision: 1,
      documents: [
        document('index.md', '# Root\n'),
        document('bad-bytes.md', Uint8Array.from([0xc3, 0x28])),
        document('bad-yaml.md', invalidYaml),
        document(
          'valid.md',
          new TextEncoder().encode(
            concept('reference', '# Valid\n[Broken source](./bad-yaml.md)\n'),
          ),
        ),
      ],
    });

    expect(bundle.concepts.map(({ id }) => id)).toEqual(['bad-bytes', 'bad-yaml', 'valid']);
    expect(bundle.failures.map(({ bundlePath, reason }) => [bundlePath, reason])).toEqual([
      ['bad-bytes.md', 'decode'],
      ['bad-yaml.md', 'frontmatter'],
    ]);

    const invalidBytesConcept = bundle.concepts.find(({ id }) => id === 'bad-bytes');
    expect(invalidBytesConcept).toMatchObject({
      id: 'bad-bytes',
      source: {
        uri: `${rootUri}/bad-bytes.md`,
        bundlePath: 'bad-bytes.md',
      },
      frontmatter: { raw: {}, source: '', fields: {}, normalized: { tags: [] } },
      type: '',
      tags: [],
      body: '',
      links: [],
    });
    expect(invalidBytesConcept?.source.contentHash).toBe('fnv1a32:9d9d1dae');

    const invalidYamlConcept = bundle.concepts.find(({ id }) => id === 'bad-yaml');
    expect(invalidYamlConcept).toMatchObject({
      source: {
        uri: `${rootUri}/bad-yaml.md`,
        bundlePath: 'bad-yaml.md',
        contentHash: 'fnv1a32:72917190',
      },
      type: '',
      tags: [],
      body: '',
      links: [],
    });
    const invalidYamlFailure = bundle.failures.find(
      ({ bundlePath }) => bundlePath === 'bad-yaml.md',
    );
    expect(invalidYamlFailure?.range).toEqual({
      start: { offset: 24, line: 2, character: 0 },
      end: { offset: 25, line: 2, character: 1 },
    });

    const graph = buildGraphPayload(bundle);
    expect(graph.nodes.map(({ id, type }) => [id, type])).toEqual([
      ['bad-bytes', ''],
      ['bad-yaml', ''],
      ['valid', 'reference'],
    ]);
    expect(graph.edges).toMatchObject([{ source: 'valid', target: 'bad-yaml' }]);
    expect(JSON.parse(JSON.stringify(graph))).toEqual(graph);

    const findings = validateBundle(bundle, { now: '2026-07-22T00:00:00Z' });
    expect(
      findings.filter(({ uri }) => uri === `${rootUri}/bad-bytes.md`).map(({ code }) => code),
    ).toEqual([VALIDATION_CODES.decode]);
    expect(
      findings.filter(({ uri }) => uri === `${rootUri}/bad-yaml.md`).map(({ code }) => code),
    ).toEqual([VALIDATION_CODES.frontmatter]);
  });

  it('applies one-BOM and well-formed Unicode rules identically to text and bytes', () => {
    const validSource = `\uFEFF${concept('reference', '# Unicode 😀\n', 'title: Unicode 😀\n')}`;
    const parsedText = parseBundle({
      rootUri,
      revision: 1,
      documents: [document('unicode.md', validSource)],
    });
    const parsedBytes = parseBundle({
      rootUri,
      revision: 1,
      documents: [document('unicode.md', new TextEncoder().encode(validSource))],
    });

    expect(parsedText).toEqual(parsedBytes);
    expect(parsedText.failures).toEqual([]);
    expect(parsedText.concepts[0]).toMatchObject({
      type: 'reference',
      title: 'Unicode 😀',
      body: '# Unicode 😀\n',
    });

    const doubleBomSource = `\uFEFF\uFEFF${concept('reference', '# Rejected\n')}`;
    const rejectedText = parseBundle({
      rootUri,
      revision: 2,
      documents: [document('double-bom.md', doubleBomSource)],
    });
    const rejectedBytes = parseBundle({
      rootUri,
      revision: 2,
      documents: [document('double-bom.md', new TextEncoder().encode(doubleBomSource))],
    });

    expect(rejectedText).toEqual(rejectedBytes);
    expect(rejectedText.failures).toMatchObject([
      {
        bundlePath: 'double-bom.md',
        reason: 'decode',
        message: 'Document text must contain at most one leading byte-order mark.',
      },
    ]);

    const unpairedSource = concept('reference', '# Invalid Unicode\n', 'title: "\uD800"\n');
    const rejectedSurrogate = parseBundle({
      rootUri,
      revision: 3,
      documents: [document('unpaired.md', unpairedSource)],
    });
    const replacementBytes = parseBundle({
      rootUri,
      revision: 3,
      documents: [document('unpaired.md', new TextEncoder().encode(unpairedSource))],
    });

    expect(rejectedSurrogate.failures).toMatchObject([
      {
        bundlePath: 'unpaired.md',
        reason: 'decode',
        message: 'Already-decoded document text contains an unpaired UTF-16 surrogate.',
      },
    ]);
    expect(rejectedSurrogate.concepts[0]?.source.contentHash).toMatch(/^fnv1a32-utf16:/u);
    expect(replacementBytes.failures).toEqual([]);
    expect(replacementBytes.concepts[0]?.title).toBe('�');
    expect(rejectedSurrogate.concepts[0]?.source.contentHash).not.toBe(
      replacementBytes.concepts[0]?.source.contentHash,
    );

    const rejectedLowSurrogate = parseBundle({
      rootUri,
      revision: 4,
      documents: [
        document(
          'unpaired-low.md',
          concept('reference', '# Invalid Unicode\n', 'title: "\uDC00"\n'),
        ),
      ],
    });
    expect(rejectedLowSurrogate.failures).toMatchObject([
      {
        bundlePath: 'unpaired-low.md',
        reason: 'decode',
        message: 'Already-decoded document text contains an unpaired UTF-16 surrogate.',
      },
    ]);
  });

  it('isolates empty Markdown filename stems while accepting dot-prefixed concept names', () => {
    const bundle = parseBundle({
      rootUri,
      revision: 1,
      documents: [
        document('index.md', '# Root\n'),
        document('.md', concept('invalid-root-name')),
        document('nested/.md', concept('invalid-nested-name')),
        document('.notes.md', concept('note', '# Dot-prefixed concept\n')),
        document('sibling.md', concept('reference', '# Readable sibling\n')),
      ],
    });

    expect(bundle.concepts.map(({ id }) => id)).toEqual(['.notes', 'sibling']);
    expect(bundle.failures).toEqual([
      {
        kind: 'parse-failure',
        uri: `${rootUri}/.md`,
        bundlePath: '.md',
        reason: 'read',
        message:
          'Concept Markdown filename must have a non-empty stem before `.md`; rename the document.',
      },
      {
        kind: 'parse-failure',
        uri: `${rootUri}/nested/.md`,
        bundlePath: 'nested/.md',
        reason: 'read',
        message:
          'Concept Markdown filename must have a non-empty stem before `.md`; rename the document.',
      },
    ]);

    const graph = buildGraphPayload(bundle);
    expect(graph.nodes.map(({ id }) => id)).toEqual(['.notes', 'sibling']);
  });

  it('reports missing, unterminated, and non-mapping frontmatter without losing other files', () => {
    const bundle = parseBundle({
      rootUri,
      revision: 2,
      documents: [
        document('missing.md', '# No frontmatter\n'),
        document('unterminated.md', '---\ntype: reference\n'),
        document('sequence.md', '---\n- not\n- a mapping\n---\n'),
        document('empty-type.md', concept('""')),
      ],
    });

    expect(bundle.concepts.map(({ id, type }) => [id, type])).toEqual([
      ['empty-type', ''],
      ['missing', ''],
      ['sequence', ''],
      ['unterminated', ''],
    ]);
    expect(bundle.failures.map(({ bundlePath }) => bundlePath)).toEqual([
      'missing.md',
      'sequence.md',
      'unterminated.md',
    ]);

    const missingFailure = bundle.failures.find(({ bundlePath }) => bundlePath === 'missing.md');
    expect(missingFailure).toMatchObject({
      reason: 'frontmatter',
      message: 'Concept Markdown requires YAML frontmatter.',
      range: {
        start: { offset: 0, line: 0, character: 0 },
        end: { offset: 17, line: 1, character: 0 },
      },
    });
    const sequenceFailure = bundle.failures.find(({ bundlePath }) => bundlePath === 'sequence.md');
    expect(sequenceFailure).toMatchObject({
      reason: 'frontmatter',
      message: 'YAML frontmatter must be a mapping with string field names.',
      range: {
        start: { offset: 4, line: 1, character: 0 },
        end: { offset: 22, line: 3, character: 0 },
      },
    });
    const unterminatedFailure = bundle.failures.find(
      ({ bundlePath }) => bundlePath === 'unterminated.md',
    );
    expect(unterminatedFailure).toMatchObject({
      reason: 'frontmatter',
      message: 'YAML frontmatter has no closing delimiter.',
      range: {
        start: { offset: 0, line: 0, character: 0 },
        end: { offset: 4, line: 1, character: 0 },
      },
    });
    for (const id of ['missing', 'sequence', 'unterminated']) {
      expect(bundle.concepts.find((candidate) => candidate.id === id)).toMatchObject({
        frontmatter: { raw: {}, source: '', fields: {}, normalized: { tags: [] } },
        type: '',
        tags: [],
        body: '',
        links: [],
      });
    }
  });

  it('retains unsafe YAML integers exactly in an explicit JSON-safe representation', () => {
    const bundle = parseBundle({
      rootUri,
      revision: 3,
      documents: [
        document(
          'exact-integers.md',
          [
            '---',
            'type: producer-extension',
            'producer:',
            '  safe_max: 9007199254740991',
            '  unsafe_positive: 9007199254740993',
            '  unsafe_negative: -9007199254740993',
            '---',
            '# Exact integers',
            '',
          ].join('\n'),
        ),
      ],
    });

    expect(bundle.failures).toEqual([]);
    expect(bundle.concepts[0]?.frontmatter.raw.producer).toEqual({
      safe_max: 9007199254740991,
      unsafe_positive: { [EXACT_YAML_INTEGER_KEY]: '9007199254740993' },
      unsafe_negative: { [EXACT_YAML_INTEGER_KEY]: '-9007199254740993' },
    });
    expect(JSON.parse(JSON.stringify(bundle))).toEqual(bundle);
  });

  it('retains standard YAML tags as JSON-safe semantic and lexical representations', () => {
    const tagged = (tag: string, value: unknown, source: string) => ({
      [YAML_TAGGED_VALUE_KEY]: { tag, value, source },
    });
    const bundle = parseBundle({
      rootUri,
      revision: 4,
      documents: [
        document('index.md', '---\nokf_version: "0.1"\n---\n# Root\n'),
        document(
          'tagged-values.md',
          [
            '---',
            'type: !!str producer-extension',
            'title: Tagged values',
            'description: Unknown tagged metadata remains consumable.',
            'timestamp: "2026-07-22T09:30:00Z"',
            'producer:',
            '  captured_at: !!timestamp 2001-12-15T02:59:43.1Z',
            '  payload: !!binary SGVsbG8=',
            '  labels: !!set {alpha: null, beta: null}',
            '  ordered: !!omap [{first: 1}, {second: 2}]',
            '  pairs: !!pairs [{left: one}, {right: two}]',
            '  exact: !!int 9007199254740993',
            '  text: !!str 001',
            '  infinite: !!float .inf',
            '  safe_mapping: !!map {__proto__: retained, constructor: retained}',
            '---',
            '# Tagged values',
            '',
          ].join('\n'),
        ),
      ],
    });

    expect(bundle.failures).toEqual([]);
    const concept = bundle.concepts[0];
    expect(concept).toMatchObject({ id: 'tagged-values', type: 'producer-extension' });
    expect(concept?.timestamp).toBe('2026-07-22T09:30:00Z');
    expect(concept?.frontmatter.raw.type).toEqual(
      tagged('tag:yaml.org,2002:str', 'producer-extension', 'producer-extension'),
    );
    expect(concept?.frontmatter.explicitTags).toEqual({
      type: 'tag:yaml.org,2002:str',
    });
    expect(concept?.frontmatter.raw.producer).toEqual({
      captured_at: tagged(
        'tag:yaml.org,2002:timestamp',
        '2001-12-15T02:59:43.100Z',
        '2001-12-15T02:59:43.1Z',
      ),
      payload: tagged('tag:yaml.org,2002:binary', [72, 101, 108, 108, 111], 'SGVsbG8='),
      labels: tagged('tag:yaml.org,2002:set', ['alpha', 'beta'], '{alpha: null, beta: null}'),
      ordered: tagged(
        'tag:yaml.org,2002:omap',
        [{ first: 1 }, { second: 2 }],
        '[{first: 1}, {second: 2}]',
      ),
      pairs: tagged(
        'tag:yaml.org,2002:pairs',
        [{ left: 'one' }, { right: 'two' }],
        '[{left: one}, {right: two}]',
      ),
      exact: tagged(
        'tag:yaml.org,2002:int',
        { [EXACT_YAML_INTEGER_KEY]: '9007199254740993' },
        '9007199254740993',
      ),
      text: tagged('tag:yaml.org,2002:str', '001', '001'),
      infinite: tagged('tag:yaml.org,2002:float', 'Infinity', '.inf'),
      safe_mapping: tagged(
        'tag:yaml.org,2002:map',
        { ['__proto__']: 'retained', constructor: 'retained' },
        '{__proto__: retained, constructor: retained}',
      ),
    });
    expect(Object.getPrototypeOf(concept?.frontmatter.raw)).toBeNull();
    expect(({} as { readonly polluted?: unknown }).polluted).toBeUndefined();
    expect(JSON.parse(JSON.stringify(bundle))).toEqual(bundle);

    const findings = validateBundle(bundle, { now: '2026-07-22T12:00:00Z' });
    expect(findings.map(({ code }) => code)).not.toContain(VALIDATION_CODES.frontmatter);
    expect(findings.map(({ code }) => code)).not.toContain(VALIDATION_CODES.conceptType);
    expect(buildGraphPayload({ ...bundle, findings }).statistics.conceptCount).toBe(1);
  });

  it('tracks explicit tag aliases without trusting structurally similar producer mappings', () => {
    const aliased = parseBundle({
      rootUri,
      revision: 5,
      documents: [
        document(
          'index.md',
          [
            '---',
            'version_source: &supported-version !!str 0.1',
            'okf_version: *supported-version',
            '---',
            '# Root',
            '',
          ].join('\n'),
        ),
        document(
          'aliased-type.md',
          [
            '---',
            'type_source: &supported-type !!str reference',
            'type: *supported-type',
            'title: Aliased type',
            '---',
            '# Aliased type',
            '',
          ].join('\n'),
        ),
      ],
    });

    expect(aliased.failures).toEqual([]);
    expect(aliased.reservedDocuments[0]?.okfVersion).toBe('0.1');
    expect(aliased.reservedDocuments[0]?.frontmatter?.explicitTags).toEqual({
      version_source: 'tag:yaml.org,2002:str',
      okf_version: 'tag:yaml.org,2002:str',
    });
    expect(aliased.concepts[0]).toMatchObject({ type: 'reference' });
    expect(aliased.concepts[0]?.frontmatter.explicitTags).toEqual({
      type_source: 'tag:yaml.org,2002:str',
      type: 'tag:yaml.org,2002:str',
    });

    const spoofed = parseBundle({
      rootUri,
      revision: 6,
      documents: [
        document(
          'index.md',
          [
            '---',
            'fake_version: &fake-version',
            '  $okf-workbench:yaml-tag:',
            '    tag: "tag:yaml.org,2002:str"',
            '    value: "0.1"',
            '    source: "0.1"',
            'okf_version: *fake-version',
            '---',
            '# Spoofed root',
            '',
          ].join('\n'),
        ),
        document(
          'spoofed-type.md',
          [
            '---',
            'fake_type: &fake-type',
            '  $okf-workbench:yaml-tag:',
            '    tag: "tag:yaml.org,2002:str"',
            '    value: "reference"',
            '    source: "reference"',
            'type: *fake-type',
            'title: Spoofed type',
            '---',
            '# Spoofed type',
            '',
          ].join('\n'),
        ),
      ],
    });

    expect(spoofed.failures).toEqual([]);
    expect(spoofed.reservedDocuments[0]?.okfVersion).toBeUndefined();
    expect(spoofed.reservedDocuments[0]?.frontmatter?.explicitTags).toEqual({});
    expect(spoofed.concepts[0]).toMatchObject({ type: '' });
    expect(spoofed.concepts[0]?.frontmatter.explicitTags).toEqual({});
    const findings = validateBundle(spoofed, { now: '2026-07-22T12:00:00Z' });
    expect(findings.map(({ code }) => code)).toContain(VALIDATION_CODES.unsupportedVersion);
    expect(findings.map(({ code }) => code)).toContain(VALIDATION_CODES.conceptType);
  });

  it('fails closed on custom YAML tags without losing the concept identity', () => {
    const bundle = parseBundle({
      rootUri,
      revision: 4,
      documents: [
        document(
          'custom-object.md',
          concept('producer-extension', '# Custom object\n', 'producer: !runtime-object {}\n'),
        ),
      ],
    });

    expect(bundle.concepts).toMatchObject([
      {
        id: 'custom-object',
        type: '',
        frontmatter: { raw: {} },
      },
    ]);
    expect(bundle.failures).toMatchObject([
      {
        bundlePath: 'custom-object.md',
        reason: 'frontmatter',
        message:
          'YAML frontmatter is not JSON-safe: custom YAML tag is not supported: !runtime-object',
      },
    ]);
  });

  it('rejects non-string mapping keys before JSON object coercion can discard producer fields', () => {
    const topLevelText = [
      '---',
      'type: producer-extension',
      '1: numeric key',
      '"1": string key',
      '---',
      '# Top level collision',
      '',
    ].join('\n');
    const nestedText = [
      '---',
      'type: producer-extension',
      'producer:',
      '  1: numeric key',
      '  "1": string key',
      '---',
      '# Nested collision',
      '',
    ].join('\n');
    const bundle = parseBundle({
      rootUri,
      revision: 4,
      documents: [
        document('top-level-non-string-key.md', topLevelText),
        document('nested-non-string-key.md', nestedText),
      ],
    });

    expect(bundle.concepts.map(({ id, type }) => [id, type])).toEqual([
      ['nested-non-string-key', ''],
      ['top-level-non-string-key', ''],
    ]);
    expect(bundle.failures).toHaveLength(2);

    const topLevelFailure = bundle.failures.find(
      ({ bundlePath }) => bundlePath === 'top-level-non-string-key.md',
    );
    expect(topLevelFailure).toMatchObject({
      reason: 'frontmatter',
      message: 'YAML frontmatter mappings must use string field names at every level.',
      range: {
        start: { line: 2, character: 0 },
        end: { line: 2, character: 1 },
      },
    });
    expect(
      topLevelText.slice(topLevelFailure?.range?.start.offset, topLevelFailure?.range?.end.offset),
    ).toBe('1');

    const nestedFailure = bundle.failures.find(
      ({ bundlePath }) => bundlePath === 'nested-non-string-key.md',
    );
    expect(nestedFailure).toMatchObject({
      reason: 'frontmatter',
      message: 'YAML frontmatter mappings must use string field names at every level.',
      range: {
        start: { line: 3, character: 2 },
        end: { line: 3, character: 3 },
      },
    });
    expect(
      nestedText.slice(nestedFailure?.range?.start.offset, nestedFailure?.range?.end.offset),
    ).toBe('1');
  });

  it('parses CR-only frontmatter and keeps field, body, and Markdown ranges aligned', () => {
    const crOnlyText = [
      '---',
      'type: reference',
      'title: CR only',
      '---',
      '# Body',
      '',
      '[Target](./target.md)',
    ].join('\r');
    const bundle = parseBundle({
      rootUri,
      revision: 5,
      documents: [
        document('cr-only.md', crOnlyText),
        document('target.md', concept('reference', '# Target\n')),
      ],
    });

    expect(bundle.failures).toEqual([]);
    const parsed = bundle.concepts.find(({ id }) => id === 'cr-only');
    expect(parsed?.body).toBe('# Body\r\r[Target](./target.md)');
    expect(parsed?.frontmatter.fields.type).toMatchObject({
      start: { line: 1, character: 0 },
      end: { line: 1, character: 15 },
    });
    expect(
      crOnlyText.slice(
        parsed?.frontmatter.fields.type?.start.offset,
        parsed?.frontmatter.fields.type?.end.offset,
      ),
    ).toBe('type: reference');
    expect(parsed?.bodyRange.start).toMatchObject({ line: 4, character: 0 });
    expect(parsed?.links).toHaveLength(1);
    expect(parsed?.links[0]).toMatchObject({
      targetId: 'target',
      range: {
        start: { line: 6, character: 0 },
        end: { line: 6, character: 21 },
      },
    });
    expect(
      crOnlyText.slice(parsed?.links[0]?.range.start.offset, parsed?.links[0]?.range.end.offset),
    ).toBe('[Target](./target.md)');
  });

  it('accepts only the canonical frontmatter closing delimiter', () => {
    const bundle = parseBundle({
      rootUri,
      revision: 4,
      documents: [
        document('yaml-document-end.md', '---\ntype: reference\n...\n# Not a delimiter\n'),
        document('valid.md', concept('reference')),
      ],
    });

    expect(bundle.concepts.map(({ id }) => id)).toEqual(['valid', 'yaml-document-end']);
    expect(bundle.failures).toMatchObject([
      {
        bundlePath: 'yaml-document-end.md',
        reason: 'frontmatter',
        message: 'YAML frontmatter has no closing delimiter.',
      },
    ]);
  });

  it('returns stable document and failure ordering regardless of enumeration order', () => {
    const inputs = [
      document('zeta.md', concept('z')),
      document('area\\alpha.md', concept('a')),
      document('index.md', '# Root\n'),
      document('../escape.md', concept('bad')),
    ];
    const forward = parseBundle({ rootUri, revision: 1, documents: inputs });
    const reverse = parseBundle({ rootUri, revision: 1, documents: [...inputs].reverse() });

    expect(forward).toEqual(reverse);
    expect(forward.concepts.map(({ id }) => id)).toEqual(['area/alpha', 'zeta']);
    expect(forward.failures[0]?.bundlePath).toBe('../escape.md');
  });
});
