import { describe, expect, it } from 'vitest';

import type {
  Concept,
  ConceptLink,
  Finding,
  JsonObject,
  JsonValue,
  ParsedBundle,
  ParsedFrontmatter,
  ParseFailure,
  ReservedDocument,
  SourceRange,
} from '../../../src/core/model/index.js';
import {
  parseBundle,
  YAML_TAGGED_VALUE_KEY,
  type BundleDocumentInput,
} from '../../../src/core/parser/index.js';
import { VALIDATION_CODES, validateBundle } from '../../../src/core/validation/index.js';

const rootUri = 'vscode-remote://ssh-remote+example/workspace/knowledge';

function range(start: number, end = start + 1): SourceRange {
  return {
    start: { offset: start, line: 0, character: start },
    end: { offset: end, line: 0, character: end },
  };
}

function link(
  sourceId: string,
  classification: ConceptLink['classification'],
  rawTarget: string,
  start: number,
  targetId?: string,
): ConceptLink {
  return {
    sourceId,
    classification,
    rawTarget,
    label: rawTarget,
    range: range(start, start + rawTarget.length),
    ...(targetId === undefined ? {} : { targetId }),
  };
}

interface ConceptOptions {
  readonly id: string;
  readonly type?: string;
  readonly rawType?: JsonValue;
  readonly title?: string | null;
  readonly description?: string | null;
  readonly resource?: string;
  readonly timestamp?: string;
  readonly rawTimestamp?: JsonValue;
  readonly tags?: readonly string[];
  readonly links?: readonly ConceptLink[];
  readonly extraRaw?: JsonObject;
}

function concept(options: ConceptOptions): Concept {
  const type = options.type ?? 'Producer Custom Type';
  const title = options.title === null ? undefined : (options.title ?? `Title ${options.id}`);
  const description =
    options.description === null ? undefined : (options.description ?? `Description ${options.id}`);
  const frontmatterRange = range(0, 80);
  const fields: Record<string, SourceRange> = { type: range(4, 20) };
  const raw: Record<string, JsonValue> = {
    type: options.rawType ?? type,
    ...(options.extraRaw ?? {}),
  };

  if (title !== undefined) {
    raw.title = title;
    fields.title = range(21, 35);
  }
  if (description !== undefined) {
    raw.description = description;
    fields.description = range(36, 55);
  }
  if (options.resource !== undefined) {
    raw.resource = options.resource;
    fields.resource = range(56, 65);
  }
  const rawTimestamp = Object.hasOwn(options, 'rawTimestamp')
    ? options.rawTimestamp
    : options.timestamp;
  if (rawTimestamp !== undefined) {
    raw.timestamp = rawTimestamp;
    fields.timestamp = range(66, 79);
  }

  const frontmatter: ParsedFrontmatter = {
    raw,
    explicitTags: {},
    source: 'type: Producer Custom Type\n',
    range: frontmatterRange,
    fields,
    normalized: {
      type,
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
      ...(options.resource === undefined ? {} : { resource: options.resource }),
      tags: options.tags ?? [],
      ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
    },
  };

  return {
    kind: 'concept',
    id: options.id,
    source: {
      uri: `${rootUri}/${options.id}.md`,
      bundlePath: `${options.id}.md`,
      contentHash: `hash:${options.id}`,
    },
    frontmatter,
    type,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(options.resource === undefined ? {} : { resource: options.resource }),
    tags: options.tags ?? [],
    ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
    body: '',
    bodyRange: range(81, 81),
    links: options.links ?? [],
  };
}

function rootIndex(okfVersion: JsonValue = '0.1'): ReservedDocument {
  return {
    kind: 'reserved',
    reservedKind: 'index',
    source: {
      uri: `${rootUri}/index.md`,
      bundlePath: 'index.md',
      contentHash: 'hash:index',
    },
    frontmatter: {
      raw: { okf_version: okfVersion },
      explicitTags: {},
      source: `okf_version: ${okfVersion}\n`,
      range: range(0, 24),
      fields: { okf_version: range(4, 20) },
      normalized: { tags: [] },
    },
    ...(typeof okfVersion === 'string' ? { okfVersion } : {}),
    body: '# Contents\n',
    bodyRange: range(25, 36),
  };
}

function bundle(
  concepts: readonly Concept[],
  options: {
    readonly reservedDocuments?: readonly ReservedDocument[];
    readonly failures?: readonly ParseFailure[];
    readonly findings?: readonly Finding[];
  } = {},
): ParsedBundle {
  return {
    rootUri,
    revision: 7,
    concepts,
    reservedDocuments: options.reservedDocuments ?? [rootIndex()],
    failures: options.failures ?? [],
    findings: options.findings ?? [],
  };
}

function codes(findings: readonly Finding[]): readonly string[] {
  return findings.map((finding) => finding.code);
}

function document(bundlePath: string, content: string): BundleDocumentInput {
  return {
    uri: `${rootUri}/${bundlePath}`,
    bundlePath,
    content,
  };
}

describe('validateBundle', () => {
  it('separates conformance, curation, and compatibility findings with precise ranges', () => {
    const alpha = concept({
      id: 'alpha',
      resource: ' exact://Resource ',
      timestamp: '2026-07-22T00:05:00Z',
      links: [
        link('alpha', 'internal', './beta.md', 100, 'beta'),
        link('alpha', 'broken', './missing.md', 120),
        link('alpha', 'invalid', './bad%ZZ.md', 140),
        link('alpha', 'out-of-bundle', '../../outside.md', 160),
      ],
      extraRaw: { producer_extension: { enabled: true } },
    });
    const beta = concept({
      id: 'beta',
      resource: 'exact://Resource',
      timestamp: '2026-07-22T00:05:00.001Z',
    });
    const orphan = concept({
      id: 'orphan',
      title: null,
      description: null,
      resource: 'exact://resource',
      timestamp: '2026-07-22T00:00:00',
      links: [link('orphan', 'external', 'https://example.com', 200)],
    });
    const decodeFailure: ParseFailure = {
      kind: 'parse-failure',
      uri: `${rootUri}/bad-bytes.md`,
      bundlePath: 'bad-bytes.md',
      reason: 'decode',
      message: 'Document is not valid UTF-8.',
      range: range(3, 4),
    };

    const findings = validateBundle(
      bundle([orphan, beta, alpha], {
        reservedDocuments: [rootIndex('0.2')],
        failures: [decodeFailure],
      }),
      { now: '2026-07-22T00:00:00Z' },
    );

    expect(codes(findings)).toEqual(
      expect.arrayContaining([
        VALIDATION_CODES.decode,
        VALIDATION_CODES.brokenLink,
        VALIDATION_CODES.invalidLink,
        VALIDATION_CODES.outOfBundleLink,
        VALIDATION_CODES.orphanConcept,
        VALIDATION_CODES.missingTitle,
        VALIDATION_CODES.missingDescription,
        VALIDATION_CODES.invalidTimestamp,
        VALIDATION_CODES.futureTimestamp,
        VALIDATION_CODES.duplicateResource,
        VALIDATION_CODES.futureMinorVersion,
      ]),
    );
    expect(
      codes(findings).filter((code) => code === VALIDATION_CODES.futureTimestamp),
    ).toHaveLength(1);
    expect(
      codes(findings).filter((code) => code === VALIDATION_CODES.duplicateResource),
    ).toHaveLength(2);
    expect(codes(findings).filter((code) => code === VALIDATION_CODES.orphanConcept)).toHaveLength(
      1,
    );
    expect(codes(findings)).not.toContain(VALIDATION_CODES.conceptType);

    const broken = findings.find((finding) => finding.code === VALIDATION_CODES.brokenLink);
    expect(broken).toMatchObject({
      category: 'curation',
      severity: 'warning',
      uri: `${rootUri}/alpha.md`,
      range: range(120, 132),
    });
    expect(findings.find((finding) => finding.code === VALIDATION_CODES.decode)).toMatchObject({
      category: 'conformance',
      severity: 'error',
      range: range(3, 4),
    });
    expect(
      findings.find((finding) => finding.code === VALIDATION_CODES.futureMinorVersion),
    ).toMatchObject({
      category: 'compatibility',
      severity: 'information',
    });
    expect(JSON.parse(JSON.stringify(findings))).toEqual(findings);

    const reordered = validateBundle(
      bundle([alpha, beta, orphan], {
        reservedDocuments: [rootIndex('0.2')],
        failures: [decodeFailure],
      }),
      { now: '2026-07-22T00:00:00Z' },
    );
    expect(reordered).toEqual(findings);
  });

  it('reports empty types and invalid reserved structures while isolating parse failures', () => {
    const emptyType = concept({ id: 'empty-type', type: '', rawType: '' });
    const nestedIndex: ReservedDocument = {
      ...rootIndex(),
      source: {
        uri: `${rootUri}/area/index.md`,
        bundlePath: 'area/index.md',
        contentHash: 'hash:nested-index',
      },
    };
    const emptyIndex: ReservedDocument = {
      kind: 'reserved',
      reservedKind: 'index',
      source: {
        uri: `${rootUri}/empty/index.md`,
        bundlePath: 'empty/index.md',
        contentHash: 'hash:empty-index',
      },
      body: 'No heading here.\n',
      bodyRange: range(0, 17),
    };
    const invalidLog: ReservedDocument = {
      kind: 'reserved',
      reservedKind: 'log',
      source: {
        uri: `${rootUri}/log.md`,
        bundlePath: 'log.md',
        contentHash: 'hash:log',
      },
      body: '# History\n## 2026-02-30\n- Entry\n',
      bodyRange: range(0, 36),
    };
    const frontmatterFailure: ParseFailure = {
      kind: 'parse-failure',
      uri: `${rootUri}/invalid-yaml.md`,
      bundlePath: 'invalid-yaml.md',
      reason: 'frontmatter',
      message: 'YAML frontmatter is invalid.',
      range: range(9, 12),
    };

    const findings = validateBundle(
      bundle([emptyType], {
        reservedDocuments: [rootIndex('1.0'), nestedIndex, emptyIndex, invalidLog],
        failures: [frontmatterFailure],
      }),
      { now: '2026-07-22T00:00:00Z' },
    );

    expect(codes(findings)).toEqual(
      expect.arrayContaining([
        VALIDATION_CODES.frontmatter,
        VALIDATION_CODES.conceptType,
        VALIDATION_CODES.reservedFrontmatter,
        VALIDATION_CODES.indexStructure,
        VALIDATION_CODES.logStructure,
        VALIDATION_CODES.unsupportedVersion,
      ]),
    );
    expect(
      findings.find((finding) => finding.code === VALIDATION_CODES.conceptType)?.range,
    ).toEqual(range(4, 20));
    expect(
      findings.find((finding) => finding.code === VALIDATION_CODES.frontmatter)?.range,
    ).toEqual(range(9, 12));
    expect(
      findings.find((finding) => finding.code === VALIDATION_CODES.unsupportedVersion),
    ).toMatchObject({
      category: 'compatibility',
      severity: 'warning',
    });
  });

  it('does not derive valid-sibling connectivity from a failed source', () => {
    const failed = concept({
      id: 'failed',
      links: [link('failed', 'internal', './valid.md', 100, 'valid')],
    });
    const valid = concept({ id: 'valid' });
    const failedSource: ParseFailure = {
      kind: 'parse-failure',
      uri: failed.source.uri,
      bundlePath: failed.source.bundlePath,
      reason: 'frontmatter',
      message: 'YAML frontmatter is invalid.',
    };

    const findings = validateBundle(bundle([failed, valid], { failures: [failedSource] }), {
      now: '2026-07-22T00:00:00Z',
    });

    expect(findings.filter(({ code }) => code === VALIDATION_CODES.orphanConcept)).toEqual([
      expect.objectContaining({
        uri: valid.source.uri,
        message: expect.stringContaining('"valid"'),
      }),
    ]);
    expect(
      findings.some(({ uri, category }) => uri === failed.source.uri && category === 'curation'),
    ).toBe(false);
  });

  it('does not report unknown producer fields or custom types solely for being unknown', () => {
    const first = concept({
      id: 'custom/first',
      type: 'Never Registered',
      extraRaw: { vendor: { nested: ['preserved', 1] } },
      links: [link('custom/first', 'internal', './second.md', 90, 'custom/second')],
    });
    const second = concept({ id: 'custom/second', type: 'Another Future Type' });

    expect(validateBundle(bundle([first, second]), { now: '2026-07-22T00:00:00Z' })).toEqual([]);
  });

  it('rejects an invalid injected reference time instead of producing misleading timestamp findings', () => {
    expect(() => validateBundle(bundle([]), { now: 'not-a-date' })).toThrow(TypeError);
  });

  it('reports a missing root index without hiding other readable bundle content', () => {
    const findings = validateBundle(bundle([], { reservedDocuments: [] }), {
      now: '2026-07-22T00:00:00Z',
    });

    expect(findings).toContainEqual({
      code: VALIDATION_CODES.rootIndex,
      category: 'conformance',
      severity: 'error',
      uri: rootUri,
      message: 'OKF conformance: the selected bundle root is missing index.md.',
      correctiveAction:
        'Run OKF: Regenerate Indexes to synthesize the missing root index, or create index.md with an OKF version declaration.',
    });
  });

  it('reports present non-string timestamp and okf_version values deterministically', () => {
    const nonStringTimestamp = concept({ id: 'numeric-timestamp', rawTimestamp: 20260722 });
    const findings = validateBundle(
      bundle([nonStringTimestamp], { reservedDocuments: [rootIndex(1)] }),
      { now: '2026-07-22T00:00:00Z' },
    );

    expect(
      findings.find((finding) => finding.code === VALIDATION_CODES.invalidTimestamp),
    ).toMatchObject({
      category: 'curation',
      severity: 'warning',
      uri: `${rootUri}/numeric-timestamp.md`,
      range: range(66, 79),
    });
    expect(
      findings.find((finding) => finding.code === VALIDATION_CODES.unsupportedVersion),
    ).toMatchObject({
      category: 'compatibility',
      severity: 'warning',
      uri: `${rootUri}/index.md`,
      range: range(4, 20),
      message: expect.stringContaining('non-string `okf_version` (number)'),
    });

    expect(
      validateBundle(bundle([nonStringTimestamp], { reservedDocuments: [rootIndex(1)] }), {
        now: '2026-07-22T00:00:00Z',
      }),
    ).toEqual(findings);
  });

  it('validates parser-proven explicit timestamps while rejecting non-string lookalikes', () => {
    const parsed = parseBundle({
      rootUri,
      revision: 8,
      documents: [
        document('index.md', '---\nokf_version: "0.1"\n---\n# Root\n'),
        document(
          'explicit-timestamp.md',
          [
            '---',
            'type: reference',
            'title: Explicit timestamp',
            'description: Uses a standard YAML timestamp tag.',
            'timestamp: !!timestamp 2026-07-22T09:30:00.1Z',
            '---',
            '# Explicit timestamp',
            '',
          ].join('\n'),
        ),
        document(
          'numeric-timestamp.md',
          [
            '---',
            'type: reference',
            'title: Numeric timestamp',
            'description: Keeps a non-string producer value.',
            'timestamp: 20260722',
            '---',
            '# Numeric timestamp',
            '',
          ].join('\n'),
        ),
        document(
          'mapping-timestamp.md',
          [
            '---',
            'type: reference',
            'title: Mapping timestamp',
            'description: Keeps a non-string producer mapping.',
            'timestamp:',
            '  value: 2026-07-22T09:30:00Z',
            '---',
            '# Mapping timestamp',
            '',
          ].join('\n'),
        ),
        document(
          'lookalike-timestamp.md',
          [
            '---',
            'type: reference',
            'title: Lookalike timestamp',
            'description: Keeps an unproven serialization lookalike.',
            'timestamp:',
            `  ${YAML_TAGGED_VALUE_KEY}:`,
            '    tag: tag:yaml.org,2002:timestamp',
            '    value: 2026-07-22T09:30:00.100Z',
            '    source: 2026-07-22T09:30:00.1Z',
            '---',
            '# Lookalike timestamp',
            '',
          ].join('\n'),
        ),
      ],
    });

    expect(parsed.failures).toEqual([]);
    const explicit = parsed.concepts.find(({ id }) => id === 'explicit-timestamp');
    expect(explicit).toBeDefined();
    expect(explicit?.timestamp).toBe('2026-07-22T09:30:00.100Z');
    expect(explicit?.frontmatter.explicitTags.timestamp).toBe('tag:yaml.org,2002:timestamp');
    expect(explicit?.frontmatter.raw.timestamp).toEqual({
      [YAML_TAGGED_VALUE_KEY]: {
        tag: 'tag:yaml.org,2002:timestamp',
        value: '2026-07-22T09:30:00.100Z',
        source: '2026-07-22T09:30:00.1Z',
      },
    });

    const findings = validateBundle(parsed, { now: '2026-07-22T12:00:00Z' });
    const invalidTimestampUris = findings
      .filter(({ code }) => code === VALIDATION_CODES.invalidTimestamp)
      .map(({ uri }) => uri);

    expect(invalidTimestampUris).toHaveLength(3);
    expect(invalidTimestampUris).toEqual(
      expect.arrayContaining([
        `${rootUri}/numeric-timestamp.md`,
        `${rootUri}/mapping-timestamp.md`,
        `${rootUri}/lookalike-timestamp.md`,
      ]),
    );
    expect(invalidTimestampUris).not.toContain(`${rootUri}/explicit-timestamp.md`);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
    expect(JSON.parse(JSON.stringify(findings))).toEqual(findings);
  });

  it('recognizes CommonMark Setext headings in reserved index and log documents', () => {
    const setextIndex: ReservedDocument = {
      kind: 'reserved',
      reservedKind: 'index',
      source: {
        uri: `${rootUri}/setext/index.md`,
        bundlePath: 'setext/index.md',
        contentHash: 'hash:setext-index',
      },
      body: 'Contents\n========\n',
      bodyRange: range(0, 18),
    };
    const setextLog: ReservedDocument = {
      kind: 'reserved',
      reservedKind: 'log',
      source: {
        uri: `${rootUri}/setext/log.md`,
        bundlePath: 'setext/log.md',
        contentHash: 'hash:setext-log',
      },
      body: '2026-07-22\n----------\n\n- Entry\n',
      bodyRange: range(0, 33),
    };

    const findings = validateBundle(bundle([], { reservedDocuments: [setextIndex, setextLog] }), {
      now: '2026-07-22T00:00:00Z',
    });

    expect(codes(findings)).not.toContain(VALIDATION_CODES.indexStructure);
    expect(codes(findings)).not.toContain(VALIDATION_CODES.logStructure);
  });
});
