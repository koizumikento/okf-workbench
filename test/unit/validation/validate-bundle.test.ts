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
        reservedDocuments: [rootIndex('0.3')],
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
        reservedDocuments: [rootIndex('0.3')],
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

  it('allows an indexless bundle because the v0.2 root index is optional', () => {
    const findings = validateBundle(bundle([], { reservedDocuments: [] }), {
      now: '2026-07-22T00:00:00Z',
    });

    expect(findings).toEqual([]);
  });

  it('validates actor conventions, computation exclusivity, and safe usage counts', () => {
    const parsed = parseBundle({
      rootUri,
      revision: 9,
      documents: [
        document(
          'invalid-actors.md',
          [
            '---',
            'type: Reference',
            'title: Invalid actors',
            'description: Invalid actor forms must not elevate trust.',
            'generated: { by: bogus }',
            'verified: { by: "human:", at: 2026-07-30T02:00:00Z }',
            'sources:',
            '  - resource: https://example.com/source',
            '    author: team:finance',
            '---',
            '# Invalid actors',
            '',
          ].join('\n'),
        ),
        document(
          'both-computations.md',
          [
            '---',
            'type: Attested Computation',
            'title: Ambiguous computation',
            'description: Both sanctioned forms are present.',
            'runtime: local',
            'computation: scripts/run.sh',
            '---',
            '# Computation',
            '',
            '```sh',
            'true',
            '```',
            '',
          ].join('\n'),
        ),
        document(
          'safe-count.md',
          [
            '---',
            'type: Reference',
            'title: Safe count',
            'description: Integral YAML floats remain portable.',
            'sources: [{ resource: https://example.com/safe, usage_count: 42.0 }]',
            '---',
            '# Safe count',
            '',
          ].join('\n'),
        ),
        document(
          'unsafe-count.md',
          [
            '---',
            'type: Reference',
            'title: Unsafe count',
            'description: Integers beyond the JSON safe range are rejected.',
            'sources: [{ resource: https://example.com/unsafe, usage_count: 9007199254740993 }]',
            '---',
            '# Unsafe count',
            '',
          ].join('\n'),
        ),
        document(
          'tagged-fields.md',
          [
            '---',
            'type: Attested Computation',
            'title: Tagged fields',
            'description: Explicit standard tags preserve their semantic values.',
            'status: !!str stable',
            'stale_after: !!str 2026-09-23',
            'usage_window:',
            '  from: !!str 2026-07-01',
            '  to: !!str 2026-07-31',
            'sources:',
            '  - resource: !!str https://example.com/tagged',
            '    usage_count: !!int 42',
            'runtime: !!str local',
            'parameters:',
            '  - name: !!str input',
            '    type: !!str string',
            '    required: !!bool true',
            'computation: !!str scripts/run.sh',
            'executor:',
            '  resource: !!str references/run.md',
            '  receipt: [!!str job_id, !!str result]',
            'attester:',
            '  resource: !!str references/attest.md',
            '---',
            '# Tagged fields',
            '',
          ].join('\n'),
        ),
        document(
          'invalid-generated-at.md',
          [
            '---',
            'type: Reference',
            'title: Invalid generated time',
            'description: A present non-string at is malformed.',
            'generated: { by: process:test, at: null }',
            '---',
            '# Invalid generated time',
            '',
          ].join('\n'),
        ),
        document(
          'malformed-file-with-inline.md',
          [
            '---',
            'type: Attested Computation',
            'title: Malformed computation file',
            'description: A malformed present file cannot fall back to inline.',
            'runtime: local',
            'computation: 5',
            '---',
            '# Computation',
            '',
            '```sh',
            'true',
            '```',
            '',
          ].join('\n'),
        ),
        document(
          'multiple-inline.md',
          [
            '---',
            'type: Attested Computation',
            'title: Multiple inline computations',
            'description: Exactly one inline fence is sanctioned.',
            'runtime: local',
            '---',
            '# Computation',
            '',
            '```sh',
            'true',
            '```',
            '',
            '```sh',
            'false',
            '```',
            '',
          ].join('\n'),
        ),
        document(
          'fake-inline-heading.md',
          [
            '---',
            'type: Attested Computation',
            'title: Fake inline heading',
            'description: A heading inside a sample is not a computation section.',
            'runtime: local',
            '---',
            '```md',
            '# Computation',
            '```',
            '',
          ].join('\n'),
        ),
        document(
          'attached-closing-hashes.md',
          [
            '---',
            'type: Attested Computation',
            'title: Attached hashes',
            'description: Closing hashes require preceding whitespace.',
            'runtime: local',
            '---',
            '# Computation###',
            '',
            '```sh',
            'true',
            '```',
            '',
          ].join('\n'),
        ),
        document(
          'cr-only-inline.md',
          [
            '---',
            'type: Attested Computation',
            'title: CR only',
            'description: CommonMark recognizes CR line endings.',
            'runtime: local',
            '---',
            '# Computation',
            '',
            '```sh',
            'true',
            '```',
            '',
          ].join('\r'),
        ),
      ],
    });

    expect(parsed.failures).toEqual([]);
    expect(parsed.concepts.find(({ id }) => id === 'invalid-actors')?.trustTier).toBe('unverified');
    expect(parsed.concepts.find(({ id }) => id === 'safe-count')?.sources?.[0]?.usageCount).toBe(
      42,
    );
    const findings = validateBundle(parsed, { now: '2026-07-31T00:00:00Z' });
    const findingsFor = (id: string): readonly string[] =>
      findings.filter(({ uri }) => uri === `${rootUri}/${id}.md`).map(({ code }) => code);

    expect(findingsFor('invalid-actors')).toEqual(
      expect.arrayContaining([
        VALIDATION_CODES.invalidGenerated,
        VALIDATION_CODES.invalidVerified,
        VALIDATION_CODES.invalidSources,
      ]),
    );
    expect(findingsFor('both-computations')).toContain(VALIDATION_CODES.invalidAttestedComputation);
    expect(findingsFor('safe-count')).not.toContain(VALIDATION_CODES.invalidSources);
    expect(findingsFor('unsafe-count')).toContain(VALIDATION_CODES.invalidSources);
    for (const code of [
      VALIDATION_CODES.invalidStatus,
      VALIDATION_CODES.invalidStaleAfter,
      VALIDATION_CODES.invalidUsageWindow,
      VALIDATION_CODES.invalidSources,
      VALIDATION_CODES.invalidAttestedComputation,
    ]) {
      expect(findingsFor('tagged-fields')).not.toContain(code);
    }
    expect(findingsFor('invalid-generated-at')).toContain(VALIDATION_CODES.invalidGenerated);
    expect(findingsFor('malformed-file-with-inline')).toContain(
      VALIDATION_CODES.invalidAttestedComputation,
    );
    expect(findingsFor('multiple-inline')).toContain(VALIDATION_CODES.invalidAttestedComputation);
    expect(findingsFor('fake-inline-heading')).toContain(
      VALIDATION_CODES.invalidAttestedComputation,
    );
    expect(findingsFor('attached-closing-hashes')).toContain(
      VALIDATION_CODES.invalidAttestedComputation,
    );
    expect(findingsFor('cr-only-inline')).not.toContain(
      VALIDATION_CODES.invalidAttestedComputation,
    );
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

  it('keeps malformed optional v0.2 families in curation and prefers generated over legacy timestamp', () => {
    const parsed = parseBundle({
      rootUri,
      revision: 2,
      documents: [
        document('index.md', '---\nokf_version: "0.2"\n---\n# Root\n'),
        document(
          'malformed.md',
          [
            '---',
            'type: Attested Computation',
            'title: Malformed optional metadata',
            'description: Remains conformant while curation reports repairs.',
            'timestamp: not-a-date',
            'generated: { at: not-a-date }',
            'verified: [{ by: "", at: not-a-date }]',
            'status: archived',
            'stale_after: 2026-02-30',
            'sources: [{ title: Missing resource }]',
            'parameters: [{ name: year, type: integer, required: yes }]',
            '---',
            '# Computation',
            '',
          ].join('\n'),
        ),
        document(
          'stale.md',
          [
            '---',
            'type: Reference',
            'title: Stale concept',
            'description: Explicitly stale.',
            'stale_after: 2026-07-30',
            'generated: { by: process:future, at: 2026-08-01T00:10:00Z }',
            'verified: { by: process:future, at: 2026-08-01T00:10:00Z }',
            '---',
            '# Details',
            '',
          ].join('\n'),
        ),
        document(
          'invalid-provenance.md',
          [
            '---',
            'type: Reference',
            'title: Invalid provenance signals',
            'description: Optional credibility signals need repair.',
            'usage_window: { from: 2026-08-01, to: 2026-07-01 }',
            'sources:',
            '  - resource: https://example.com/source',
            '    usage_count: -1',
            '    last_modified: 2026-02-30',
            '    usage_window: { from: 2026-07-31, to: 2026-07-01 }',
            '---',
            '# Reference',
            '',
          ].join('\n'),
        ),
        document(
          'incomplete-computation.md',
          [
            '---',
            'type: Attested Computation',
            'title: Incomplete computation',
            'description: Has no sanctioned computation.',
            'runtime: bigquery',
            'executor: invalid',
            'attester: { resource: "" }',
            '---',
            '# Notes',
            '',
          ].join('\n'),
        ),
      ],
    });
    const findings = validateBundle(parsed, { now: '2026-07-31T00:00:00Z' });

    expect(findings.filter(({ category }) => category === 'conformance')).toEqual([]);
    expect(codes(findings)).toEqual(
      expect.arrayContaining([
        VALIDATION_CODES.invalidGenerated,
        VALIDATION_CODES.invalidVerified,
        VALIDATION_CODES.invalidStatus,
        VALIDATION_CODES.invalidStaleAfter,
        VALIDATION_CODES.invalidSources,
        VALIDATION_CODES.invalidUsageWindow,
        VALIDATION_CODES.invalidAttestedComputation,
        VALIDATION_CODES.staleConcept,
        VALIDATION_CODES.futureGeneratedAt,
        VALIDATION_CODES.futureVerifiedAt,
      ]),
    );
    expect(codes(findings)).not.toContain(VALIDATION_CODES.invalidTimestamp);
    expect(
      findings.find(
        ({ code, uri }) =>
          code === VALIDATION_CODES.invalidSources && uri === `${rootUri}/invalid-provenance.md`,
      ),
    ).toBeDefined();
    expect(
      findings.find(
        ({ code, uri }) =>
          code === VALIDATION_CODES.invalidAttestedComputation &&
          uri === `${rootUri}/incomplete-computation.md`,
      ),
    ).toBeDefined();
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
