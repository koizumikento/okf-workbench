import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';

import { OKF_SEMANTIC_LIMITS } from '../../../src/core/model/index.js';
import { parseBundle, YAML_TAGGED_VALUE_KEY } from '../../../src/core/parser/index.js';
import { inspectFrontmatterPreparse } from '../../../src/core/parser/frontmatter.js';
import { inspectMarkdownComplexity } from '../../../src/core/parser/markdown.js';
import type { BundleDocumentInput } from '../../../src/core/parser/index.js';

const rootUri = 'memfs://workspace/knowledge';

function document(bundlePath: string, content: string): BundleDocumentInput {
  return {
    uri: `${rootUri}/${bundlePath}`,
    bundlePath,
    content,
  };
}

function concept(body = '', metadata = ''): string {
  return `---\ntype: concept\n${metadata}---\n${body}`;
}

describe('parser semantic resource limits', () => {
  it('turns a provider resource failure into exactly one identity-only partial concept', () => {
    const message = 'provider resource failure '.repeat(1_000);
    const identityOnlyDocument = {
      uri: `${rootUri}/unavailable.md`,
      bundlePath: 'unavailable.md',
      // Defensive runtime input: typed producers cannot attach a hash to an
      // identity-only source, and the parser must ignore one supplied by JS.
      contentHash: 'x'.repeat(OKF_SEMANTIC_LIMITS.maxContentHashCodeUnits + 1),
      identityOnlyFailure: { reason: 'resource-limit', message },
    } as unknown as BundleDocumentInput;
    const parsed = parseBundle({
      rootUri,
      revision: 1,
      documents: [identityOnlyDocument, document('valid.md', concept('# Valid\n'))],
    });

    expect(parsed.failures).toEqual([
      {
        kind: 'parse-failure',
        uri: `${rootUri}/unavailable.md`,
        bundlePath: 'unavailable.md',
        reason: 'resource-limit',
        scope: 'document',
        message: expect.stringMatching(/…$/u),
      },
    ]);
    expect(parsed.failures[0]?.message.length).toBeLessThanOrEqual(
      OKF_SEMANTIC_LIMITS.maxFailureDetailCodeUnits,
    );
    expect(
      parsed.concepts.map(({ id, type, body, source }) => ({
        id,
        type,
        body,
        contentHash: source.contentHash,
      })),
    ).toEqual([
      {
        id: 'unavailable',
        type: '',
        body: '',
        contentHash: 'resource-limit:unparsed',
      },
      {
        id: 'valid',
        type: 'concept',
        body: '# Valid\n',
        contentHash: expect.any(String),
      },
    ]);
  });

  it('accepts the compact block-sequence depth boundary and rejects +1 before YAML AST parsing', () => {
    const nested = (depth: number): string => `producer:\n  ${'- '.repeat(depth)}leaf\n`;
    const exact = parseBundle({
      rootUri,
      revision: 1,
      documents: [
        document('exact.md', concept('', nested(OKF_SEMANTIC_LIMITS.maxFrontmatterNestingDepth))),
      ],
    });

    expect(exact.failures).toEqual([]);
    expect(exact.concepts[0]?.type).toBe('concept');

    const exceeded = parseBundle({
      rootUri,
      revision: 2,
      documents: [
        document(
          'a-exceeded.md',
          concept('', nested(OKF_SEMANTIC_LIMITS.maxFrontmatterNestingDepth + 1)),
        ),
        document('z-valid.md', concept('# Valid\n')),
      ],
    });

    expect(exceeded.failures).toEqual([
      expect.objectContaining({
        bundlePath: 'a-exceeded.md',
        reason: 'resource-limit',
        scope: 'document',
        message: expect.stringContaining('collection nesting'),
      }),
    ]);
    expect(exceeded.concepts.map(({ id, type }) => [id, type])).toEqual([
      ['a-exceeded', ''],
      ['z-valid', 'concept'],
    ]);
  });

  it('accepts indented block collection depth 64 and rejects mapping and sequence depth 65', () => {
    const nestedMapping = (depth: number): string =>
      [
        'producer:',
        ...Array.from({ length: depth }, (_, index) => {
          const level = index + 1;
          return `${' '.repeat(level)}level-${String(level)}:${level === depth ? ' leaf' : ''}`;
        }),
        '',
      ].join('\n');
    const nestedSequence = (depth: number): string =>
      [
        'producer:',
        ...Array.from({ length: depth }, (_, index) => `${' '.repeat(index + 1)}-`),
        `${' '.repeat(depth + 1)}leaf`,
        '',
      ].join('\n');

    for (const [kind, metadata] of [
      ['mapping', nestedMapping(OKF_SEMANTIC_LIMITS.maxFrontmatterNestingDepth)],
      ['sequence', nestedSequence(OKF_SEMANTIC_LIMITS.maxFrontmatterNestingDepth)],
    ] as const) {
      const exact = parseBundle({
        rootUri,
        revision: 1,
        documents: [document(`${kind}-exact.md`, concept('', metadata))],
      });
      expect(exact.failures, kind).toEqual([]);
      expect(exact.concepts[0]?.frontmatter.raw.producer, kind).toBeDefined();
    }

    for (const [kind, metadata] of [
      ['mapping', nestedMapping(OKF_SEMANTIC_LIMITS.maxFrontmatterNestingDepth + 1)],
      ['sequence', nestedSequence(OKF_SEMANTIC_LIMITS.maxFrontmatterNestingDepth + 1)],
    ] as const) {
      const exceeded = parseBundle({
        rootUri,
        revision: 2,
        documents: [
          document(`a-${kind}-exceeded.md`, concept('', metadata)),
          document('z-valid.md', concept('# Valid\n')),
        ],
      });
      expect(exceeded.failures, kind).toEqual([
        expect.objectContaining({
          bundlePath: `a-${kind}-exceeded.md`,
          reason: 'resource-limit',
          scope: 'document',
          message: expect.stringContaining('collection nesting'),
        }),
      ]);
      expect(
        exceeded.concepts.map(({ id, type }) => [id, type]),
        kind,
      ).toEqual([
        [`a-${kind}-exceeded`, ''],
        ['z-valid', 'concept'],
      ]);
    }
  });

  it('uses the semantic lone-CR line model for exact YAML nesting and +1', () => {
    const nestedMapping = (depth: number): string =>
      [
        'producer:',
        ...Array.from({ length: depth }, (_, index) => {
          const level = index + 1;
          return `${' '.repeat(level)}level-${String(level)}:${level === depth ? ' leaf' : ''}`;
        }),
        '',
      ].join('\r');
    const nestedSequence = (depth: number): string =>
      [
        'producer:',
        ...Array.from({ length: depth }, (_, index) => `${' '.repeat(index + 1)}-`),
        `${' '.repeat(depth + 1)}leaf`,
        '',
      ].join('\r');
    const crConcept = (metadata: string): string => `---\rtype: concept\r${metadata}---\r`;

    for (const [kind, metadata] of [
      ['mapping', nestedMapping(OKF_SEMANTIC_LIMITS.maxFrontmatterNestingDepth)],
      ['sequence', nestedSequence(OKF_SEMANTIC_LIMITS.maxFrontmatterNestingDepth)],
    ] as const) {
      const exact = parseBundle({
        rootUri,
        revision: 1,
        documents: [document(`${kind}-cr-exact.md`, crConcept(metadata))],
      });
      expect(exact.failures, kind).toEqual([]);
    }

    for (const [kind, metadata] of [
      ['mapping', nestedMapping(OKF_SEMANTIC_LIMITS.maxFrontmatterNestingDepth + 1)],
      ['sequence', nestedSequence(OKF_SEMANTIC_LIMITS.maxFrontmatterNestingDepth + 1)],
    ] as const) {
      const exceeded = parseBundle({
        rootUri,
        revision: 2,
        documents: [document(`${kind}-cr-exceeded.md`, crConcept(metadata))],
      });
      expect(exceeded.failures, kind).toEqual([
        expect.objectContaining({
          reason: 'resource-limit',
          message: expect.stringContaining('collection nesting'),
        }),
      ]);
    }
  });

  it('charges implicit flow-sequence maps at exact depth 64 and rejects +1', () => {
    const nestedFlowEntry = (sequenceDepth: number, entry: string): string =>
      `---\ntype: concept\nproducer: ${'['.repeat(sequenceDepth)}${entry}${']'.repeat(sequenceDepth)}\n---\n`;

    for (const entry of ['key: value', '? key: value', ': value']) {
      expect(
        inspectFrontmatterPreparse(
          nestedFlowEntry(OKF_SEMANTIC_LIMITS.maxFrontmatterNestingDepth - 1, entry),
        ),
        entry,
      ).toMatchObject({ kind: 'success' });
      expect(
        inspectFrontmatterPreparse(
          nestedFlowEntry(OKF_SEMANTIC_LIMITS.maxFrontmatterNestingDepth, entry),
        ),
        entry,
      ).toMatchObject({
        kind: 'failure',
        resourceLimit: true,
        message: expect.stringContaining('collection nesting'),
      });
    }
  });

  it('does not treat block-scalar content as YAML collection nesting', () => {
    const structuralLookingScalar = Array.from(
      { length: OKF_SEMANTIC_LIMITS.maxFrontmatterNestingDepth + 1 },
      (_, index) => `${' '.repeat(index + 2)}level-${String(index)}: scalar text`,
    ).join('\n');
    const parsed = parseBundle({
      rootUri,
      revision: 1,
      documents: [
        document(
          'scalar.md',
          concept('', `producer:\n description: |\n${structuralLookingScalar}\n`),
        ),
      ],
    });

    expect(parsed.failures).toEqual([]);
    expect(parsed.concepts[0]?.frontmatter.raw.producer).toEqual({
      description: expect.stringContaining('level-64: scalar text'),
    });
  });

  it('tracks flow, quoted, and indentless collection context across YAML lines', () => {
    const shallowFlow = [
      'producer: {',
      ...Array.from(
        { length: OKF_SEMANTIC_LIMITS.maxFrontmatterNestingDepth + 1 },
        (_, index) => `${' '.repeat(index + 1)}key${String(index)}: value,`,
      ),
      '}',
      '',
    ].join('\n');
    const flowParsed = parseBundle({
      rootUri,
      revision: 1,
      documents: [document('flow.md', concept('', shallowFlow))],
    });
    expect(flowParsed.failures).toEqual([]);

    const alternating = (lines: number): string =>
      [
        'producer:',
        ...Array.from({ length: lines }, (_, index) => {
          const final = index === lines - 1;
          return `${' '.repeat(index * 2)}- level${String(index)}:${final ? ' leaf' : ''}`;
        }),
        '',
      ].join('\n');
    const exactAlternating = parseBundle({
      rootUri,
      revision: 2,
      documents: [
        document(
          'alternating-exact.md',
          concept('', alternating(OKF_SEMANTIC_LIMITS.maxFrontmatterNestingDepth / 2)),
        ),
      ],
    });
    expect(exactAlternating.failures).toEqual([]);

    const exceededAlternating = parseBundle({
      rootUri,
      revision: 3,
      documents: [
        document(
          'alternating-exceeded.md',
          concept('', alternating(OKF_SEMANTIC_LIMITS.maxFrontmatterNestingDepth / 2 + 1)),
        ),
      ],
    });
    expect(exceededAlternating.failures).toEqual([
      expect.objectContaining({
        reason: 'resource-limit',
        message: expect.stringContaining('collection nesting'),
      }),
    ]);

    const nestedAfterMultilineQuote = [
      'producer: "hello',
      ' # "',
      'nested:',
      ...Array.from(
        { length: OKF_SEMANTIC_LIMITS.maxFrontmatterNestingDepth + 1 },
        (_, index) =>
          `${' '.repeat(index + 1)}level-${String(index)}:${index === OKF_SEMANTIC_LIMITS.maxFrontmatterNestingDepth ? ' leaf' : ''}`,
      ),
      '',
    ].join('\n');
    const quoteExceeded = parseBundle({
      rootUri,
      revision: 4,
      documents: [document('quote-exceeded.md', concept('', nestedAfterMultilineQuote))],
    });
    expect(quoteExceeded.failures).toEqual([
      expect.objectContaining({
        reason: 'resource-limit',
        message: expect.stringContaining('collection nesting'),
      }),
    ]);
  });

  it('accepts exactly 4,000 terminated YAML lines and rejects line 4,001', () => {
    const metadata = (additionalLines: number): string =>
      `${Array.from({ length: additionalLines }, (_, index) => `k${index.toString(36)}: v`).join(
        '\n',
      )}\n`;
    const exact = parseBundle({
      rootUri,
      revision: 1,
      documents: [
        document(
          'yaml-lines-exact.md',
          concept('', metadata(OKF_SEMANTIC_LIMITS.maxFrontmatterLines - 1)),
        ),
      ],
    });
    expect(exact.failures).toEqual([]);

    const exceeded = parseBundle({
      rootUri,
      revision: 2,
      documents: [
        document(
          'yaml-lines-exceeded.md',
          concept('', metadata(OKF_SEMANTIC_LIMITS.maxFrontmatterLines)),
        ),
      ],
    });
    expect(exceeded.failures).toEqual([
      expect.objectContaining({
        reason: 'resource-limit',
        message: expect.stringContaining('line pre-parse safety limit'),
      }),
    ]);
  });

  it('keeps canonical YAML binary semantics as a budgeted octet array', () => {
    const parsed = parseBundle({
      rootUri,
      revision: 1,
      documents: [document('binary.md', concept('', 'payload: !!binary SGVsbG8=\n'))],
    });

    expect(parsed.failures).toEqual([]);
    expect(parsed.concepts[0]?.frontmatter.raw.payload).toEqual({
      [YAML_TAGGED_VALUE_KEY]: {
        tag: 'tag:yaml.org,2002:binary',
        value: [72, 101, 108, 108, 111],
        source: 'SGVsbG8=',
      },
    });
  });

  it('isolates a +1 Markdown body while retaining its partial concept and valid sibling', () => {
    const exceeded = parseBundle({
      rootUri,
      revision: 1,
      documents: [
        document(
          'a-large.md',
          concept('a'.repeat(OKF_SEMANTIC_LIMITS.maxMarkdownBodyCodeUnits + 1)),
        ),
        document('z-valid.md', concept('# Valid\n')),
      ],
    });

    expect(exceeded.failures).toEqual([
      expect.objectContaining({
        bundlePath: 'a-large.md',
        reason: 'resource-limit',
        scope: 'document',
      }),
    ]);
    expect(exceeded.concepts.map(({ id, type, body }) => [id, type, body])).toEqual([
      ['a-large', '', ''],
      ['z-valid', 'concept', '# Valid\n'],
    ]);

    const exact = parseBundle({
      rootUri,
      revision: 2,
      documents: [
        document('exact.md', concept('a'.repeat(OKF_SEMANTIC_LIMITS.maxMarkdownBodyCodeUnits))),
      ],
    });
    expect(exact.failures).toEqual([]);
    expect(exact.concepts[0]?.body).toHaveLength(OKF_SEMANTIC_LIMITS.maxMarkdownBodyCodeUnits);
  });

  it('bounds aggregate Markdown pre-AST work and retains later identities without more ASTs', () => {
    const denseBody = '[x][missing]\n'.repeat(OKF_SEMANTIC_LIMITS.maxMarkdownLinksPerDocument);
    const exactDocuments = Array.from({ length: 4 }, (_, index) =>
      document(`a-${String(index)}.md`, concept(denseBody)),
    );
    const exact = parseBundle({
      rootUri,
      revision: 1,
      documents: exactDocuments,
    });
    expect(exact.failures).toEqual([]);

    const exceeded = parseBundle({
      rootUri,
      revision: 2,
      documents: [
        ...exactDocuments,
        document('b-exceeded.md', concept('[x][missing]\n')),
        document('z-tail.md', concept('# Must not enter remark\n')),
      ],
    });
    expect(exceeded.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bundlePath: 'b-exceeded.md',
          reason: 'resource-limit',
          scope: 'bundle',
          message: expect.stringContaining('pre-AST work limit'),
        }),
        expect.objectContaining({
          bundlePath: 'z-tail.md',
          reason: 'resource-limit',
          scope: 'document',
          message: expect.stringContaining('Semantic parsing was skipped'),
        }),
      ]),
    );
    expect(exceeded.concepts.find(({ id }) => id === 'z-tail')).toMatchObject({
      type: '',
      body: '',
      links: [],
    });
  });

  it('charges aggregate Markdown body code units at exact and +1 boundaries with zero syntax', () => {
    const body = 'a'.repeat(OKF_SEMANTIC_LIMITS.maxMarkdownBodyCodeUnits);
    const exactDocuments = Array.from(
      {
        length:
          OKF_SEMANTIC_LIMITS.maxBundleMarkdownBodyCodeUnits /
          OKF_SEMANTIC_LIMITS.maxMarkdownBodyCodeUnits,
      },
      (_, index) => document(`a-body-${String(index).padStart(2, '0')}/index.md`, body),
    );
    const exact = parseBundle({
      rootUri,
      revision: 1,
      documents: exactDocuments,
    });
    expect(exact.failures).toEqual([]);
    expect(exact.reservedDocuments).toHaveLength(exactDocuments.length);

    const exceeded = parseBundle({
      rootUri,
      revision: 2,
      documents: [
        ...exactDocuments,
        document('b-body-exceeded/index.md', 'a'),
        document('z-tail.md', concept('# Must not be inspected\n')),
      ],
    });
    const aggregateFailure = exceeded.failures.find(
      ({ bundlePath }) => bundlePath === 'b-body-exceeded/index.md',
    );
    expect(aggregateFailure).toMatchObject({
      reason: 'resource-limit',
      scope: 'bundle',
      message: expect.stringContaining('pre-AST work limit'),
    });
    for (const limit of [
      OKF_SEMANTIC_LIMITS.maxBundleMarkdownBodyCodeUnits,
      OKF_SEMANTIC_LIMITS.maxBundleMarkdownLines,
      OKF_SEMANTIC_LIMITS.maxBundleMarkdownAttentionWorkUnits,
      OKF_SEMANTIC_LIMITS.maxBundleMarkdownContainerWorkUnits,
      OKF_SEMANTIC_LIMITS.maxBundleMarkdownLabelEndWorkUnits,
      OKF_SEMANTIC_LIMITS.maxBundleMarkdownSyntaxCandidates,
      OKF_SEMANTIC_LIMITS.maxBundleMarkdownLinkCandidates,
    ]) {
      expect(aggregateFailure?.message).toContain(String(limit));
    }
    expect(exceeded.failures).toContainEqual(
      expect.objectContaining({
        bundlePath: 'z-tail.md',
        reason: 'resource-limit',
        scope: 'document',
        message: expect.stringContaining('Semantic parsing was skipped'),
      }),
    );
    expect(exceeded.concepts.find(({ id }) => id === 'z-tail')).toMatchObject({
      type: '',
      body: '',
      links: [],
      source: { contentHash: 'resource-limit:unparsed' },
    });
  });

  it('charges aggregate Markdown lines at exact and +1 boundaries with zero syntax', () => {
    const body = `${'a\n'.repeat(OKF_SEMANTIC_LIMITS.maxMarkdownLines - 1)}a`;
    const exactDocuments = Array.from(
      {
        length: OKF_SEMANTIC_LIMITS.maxBundleMarkdownLines / OKF_SEMANTIC_LIMITS.maxMarkdownLines,
      },
      (_, index) => document(`a-lines-${String(index).padStart(2, '0')}/index.md`, body),
    );
    const exact = parseBundle({
      rootUri,
      revision: 1,
      documents: exactDocuments,
    });
    expect(exact.failures).toEqual([]);

    const exceeded = parseBundle({
      rootUri,
      revision: 2,
      documents: [
        ...exactDocuments,
        document('b-lines-exceeded/index.md', 'a'),
        document('z-tail.md', concept('# Must not be inspected\n')),
      ],
    });
    expect(exceeded.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bundlePath: 'b-lines-exceeded/index.md',
          reason: 'resource-limit',
          scope: 'bundle',
          message: expect.stringContaining('pre-AST work limit'),
        }),
        expect.objectContaining({
          bundlePath: 'z-tail.md',
          reason: 'resource-limit',
          scope: 'document',
          message: expect.stringContaining('Semantic parsing was skipped'),
        }),
      ]),
    );
    expect(exceeded.concepts.find(({ id }) => id === 'z-tail')).toMatchObject({
      type: '',
      body: '',
      links: [],
      source: { contentHash: 'resource-limit:unparsed' },
    });
  });

  it('charges aggregate Markdown attention grammar-event work at exact and one-more-source boundaries', () => {
    const body = `${'*a\n\n'.repeat(512)}${'z\n'.repeat(1_024)}`;
    const inspection = inspectMarkdownComplexity(body);
    expect(inspection.attentionWorkUnits).toBe(1_048_576);
    expect(inspection.containerWorkUnits).toBe(512);
    expect(inspection.failure).toBeUndefined();
    const documentCount =
      OKF_SEMANTIC_LIMITS.maxBundleMarkdownAttentionWorkUnits / inspection.attentionWorkUnits;
    expect(documentCount).toBe(32);
    const exactDocuments = Array.from({ length: documentCount }, (_, index) =>
      document(`a-attention-${String(index)}/index.md`, body),
    );
    const exact = parseBundle({
      rootUri,
      revision: 1,
      documents: exactDocuments,
    });
    expect(exact.failures).toEqual([]);

    const exceeded = parseBundle({
      rootUri,
      revision: 2,
      documents: [
        ...exactDocuments,
        document('b-attention-exceeded/index.md', '*a'),
        document('z-tail.md', concept('# Must not be inspected\n')),
      ],
    });
    expect(exceeded.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bundlePath: 'b-attention-exceeded/index.md',
          reason: 'resource-limit',
          scope: 'bundle',
          message: expect.stringContaining('pre-AST work limit'),
        }),
        expect.objectContaining({
          bundlePath: 'z-tail.md',
          reason: 'resource-limit',
          scope: 'document',
          message: expect.stringContaining('Semantic parsing was skipped'),
        }),
      ]),
    );
    expect(exceeded.concepts.find(({ id }) => id === 'z-tail')).toMatchObject({
      type: '',
      body: '',
      links: [],
      source: { contentHash: 'resource-limit:unparsed' },
    });
  });

  it('charges aggregate Markdown container work at exact and +1 boundaries', () => {
    const depth = OKF_SEMANTIC_LIMITS.maxMarkdownContainerNestingDepth;
    const baseWorkUnits = depth * 2;
    const continuationLines =
      (OKF_SEMANTIC_LIMITS.maxMarkdownContainerWorkUnitsPerDocument - baseWorkUnits) / depth;
    expect(Number.isInteger(continuationLines)).toBe(true);
    const continuation = `${' '.repeat(depth * 2)}continued\n`;
    const body = `${'- '.repeat(depth)}item\n${continuation.repeat(continuationLines)}`;
    const inspection = inspectMarkdownComplexity(body);
    expect(inspection.containerWorkUnits).toBe(
      OKF_SEMANTIC_LIMITS.maxMarkdownContainerWorkUnitsPerDocument,
    );
    expect(inspection.failure).toBeUndefined();
    const documentCount =
      OKF_SEMANTIC_LIMITS.maxBundleMarkdownContainerWorkUnits / inspection.containerWorkUnits;
    expect(documentCount).toBe(4);
    const exactDocuments = Array.from({ length: documentCount }, (_, index) =>
      document(`a-container-${String(index)}/index.md`, body),
    );
    const exact = parseBundle({
      rootUri,
      revision: 1,
      documents: exactDocuments,
    });
    expect(exact.failures).toEqual([]);

    const exceeded = parseBundle({
      rootUri,
      revision: 2,
      documents: [
        ...exactDocuments,
        document('b-container-exceeded/index.md', '- item'),
        document('z-tail.md', concept('# Must not be inspected\n')),
      ],
    });
    expect(exceeded.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bundlePath: 'b-container-exceeded/index.md',
          reason: 'resource-limit',
          scope: 'bundle',
          message: expect.stringContaining('pre-AST work limit'),
        }),
        expect.objectContaining({
          bundlePath: 'z-tail.md',
          reason: 'resource-limit',
          scope: 'document',
          message: expect.stringContaining('Semantic parsing was skipped'),
        }),
      ]),
    );
    expect(exceeded.concepts.find(({ id }) => id === 'z-tail')).toMatchObject({
      type: '',
      body: '',
      links: [],
      source: { contentHash: 'resource-limit:unparsed' },
    });
  });

  it('charges aggregate Markdown label-end work at exact and +1 boundaries', () => {
    const body = [']'.repeat(2_896), ']'.repeat(68), ']'.repeat(12)].join('\n\n');
    const inspection = inspectMarkdownComplexity(body);
    expect(inspection.failure).toBeUndefined();
    expect(inspection.labelEndWorkUnits).toBe(
      OKF_SEMANTIC_LIMITS.maxMarkdownLabelEndWorkUnitsPerDocument,
    );
    const documentCount =
      OKF_SEMANTIC_LIMITS.maxBundleMarkdownLabelEndWorkUnits / inspection.labelEndWorkUnits;
    expect(documentCount).toBe(4);
    const exactDocuments = Array.from({ length: documentCount }, (_, index) =>
      document(`a-label-end-${String(index)}/index.md`, concept(body)),
    );
    const exact = parseBundle({
      rootUri,
      revision: 1,
      documents: exactDocuments,
    });
    expect(exact.failures).toEqual([]);

    const exceeded = parseBundle({
      rootUri,
      revision: 2,
      documents: [
        ...exactDocuments,
        document('b-label-end-exceeded/index.md', concept(']]')),
        document('z-tail.md', concept('# Must not be inspected\n')),
      ],
    });
    expect(exceeded.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bundlePath: 'b-label-end-exceeded/index.md',
          reason: 'resource-limit',
          scope: 'bundle',
          message: expect.stringContaining('pre-AST work limit'),
        }),
        expect.objectContaining({
          bundlePath: 'z-tail.md',
          reason: 'resource-limit',
          scope: 'document',
          message: expect.stringContaining('Semantic parsing was skipped'),
        }),
      ]),
    );
    expect(exceeded.concepts.find(({ id }) => id === 'z-tail')).toMatchObject({
      type: '',
      body: '',
      links: [],
      source: { contentHash: 'resource-limit:unparsed' },
    });
  });

  it('rejects multiline unmatched label ends before the Markdown AST path', () => {
    const body = `${']\n\ta'.repeat(19_999)}]`;
    const startedAt = performance.now();
    const parsed = parseBundle({
      rootUri,
      revision: 1,
      documents: [document('adversarial.md', concept(body))],
    });
    const elapsedMilliseconds = performance.now() - startedAt;

    expect(parsed.failures).toEqual([
      expect.objectContaining({
        bundlePath: 'adversarial.md',
        reason: 'resource-limit',
        scope: 'document',
        message: expect.stringContaining('link-label closing work'),
      }),
    ]);
    expect(elapsedMilliseconds).toBeLessThan(1_000);
  });

  it('charges failed and reserved Markdown label-end inspections to the bundle limit', () => {
    const exactBody = [']'.repeat(2_896), ']'.repeat(68), ']'.repeat(12)].join('\n\n');
    const failedBody = `${exactBody}]`;
    const failed = parseBundle({
      rootUri,
      revision: 1,
      documents: [
        ...Array.from({ length: 4 }, (_, index) =>
          document(`a-failed-label-end-${String(index)}/index.md`, concept(failedBody)),
        ),
        document('z-failed-tail.md', concept('# Must not enter an AST\n')),
      ],
    });
    expect(failed.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: 'bundle',
          reason: 'resource-limit',
          message: expect.stringContaining('Bundle Markdown'),
        }),
        expect.objectContaining({
          bundlePath: 'z-failed-tail.md',
          message: expect.stringContaining('Semantic parsing was skipped'),
        }),
      ]),
    );

    const reserved = parseBundle({
      rootUri,
      revision: 2,
      documents: [
        ...['a/index.md', 'b/log.md', 'c/index.md', 'd/log.md'].map((path) =>
          document(path, exactBody),
        ),
        document('e/index.md', ']]'),
        document('z-reserved-tail.md', concept('# Must not enter an AST\n')),
      ],
    });
    expect(reserved.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bundlePath: 'e/index.md',
          scope: 'bundle',
          reason: 'resource-limit',
          message: expect.stringContaining('Bundle Markdown'),
        }),
        expect.objectContaining({
          bundlePath: 'z-reserved-tail.md',
          message: expect.stringContaining('Semantic parsing was skipped'),
        }),
      ]),
    );
    expect(reserved.reservedDocuments).toHaveLength(4);
  });

  it('charges reserved index and log bodies to the aggregate Markdown pre-AST limits', () => {
    const denseBody = '[x][missing]\n'.repeat(OKF_SEMANTIC_LIMITS.maxMarkdownLinksPerDocument);
    const exactDocuments = ['a/index.md', 'b/log.md', 'c/index.md', 'd/log.md'].map((path) =>
      document(path, denseBody),
    );
    const exact = parseBundle({
      rootUri,
      revision: 1,
      documents: exactDocuments,
    });
    expect(exact.failures).toEqual([]);
    expect(exact.reservedDocuments).toHaveLength(exactDocuments.length);

    const exceeded = parseBundle({
      rootUri,
      revision: 2,
      documents: [
        ...exactDocuments,
        document('e/index.md', '[x][missing]\n'),
        document('z-tail.md', concept('# Must not be parsed\n')),
      ],
    });
    expect(exceeded.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bundlePath: 'e/index.md',
          reason: 'resource-limit',
          scope: 'bundle',
          message: expect.stringContaining('pre-AST work limit'),
        }),
        expect.objectContaining({
          bundlePath: 'z-tail.md',
          reason: 'resource-limit',
          scope: 'document',
          message: expect.stringContaining('Semantic parsing was skipped'),
        }),
      ]),
    );
    expect(exceeded.reservedDocuments).toHaveLength(exactDocuments.length);
    expect(exceeded.concepts[0]).toMatchObject({ id: 'z-tail', type: '', body: '', links: [] });
  });

  it('charges failed Markdown inspections before enforcing the bundle work limit', () => {
    const failedBody = [
      `[bad](${'é'.repeat(OKF_SEMANTIC_LIMITS.maxLinkTargetBytes / 2 + 1)})`,
      '[shortcut]\n'.repeat(OKF_SEMANTIC_LIMITS.maxMarkdownLinksPerDocument),
      '[shortcut]: target.md',
    ].join('\n');
    const parsed = parseBundle({
      rootUri,
      revision: 1,
      documents: [
        ...Array.from({ length: 4 }, (_, index) =>
          document(`failed-${String(index)}/index.md`, failedBody),
        ),
        document('z-tail.md', concept('# Must not enter an AST\n')),
      ],
    });

    expect(parsed.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'resource-limit',
          scope: 'bundle',
          message: expect.stringContaining('Markdown'),
        }),
        expect.objectContaining({
          bundlePath: 'z-tail.md',
          reason: 'resource-limit',
          message: expect.stringContaining('Semantic parsing was skipped'),
        }),
      ]),
    );
    expect(parsed.concepts[0]).toMatchObject({ id: 'z-tail', type: '', body: '', links: [] });
  });

  it('counts reference definitions and rejects definition +1 before Markdown AST parsing', () => {
    const definitions = (count: number): string =>
      Array.from({ length: count }, () => '[d]: x').join('\n');
    const exact = inspectMarkdownComplexity(
      definitions(OKF_SEMANTIC_LIMITS.maxMarkdownDefinitionsPerDocument),
    );
    expect(exact.failure).toBeUndefined();
    expect(exact.linkCandidates).toBe(OKF_SEMANTIC_LIMITS.maxMarkdownDefinitionsPerDocument);

    const exceeded = inspectMarkdownComplexity(
      definitions(OKF_SEMANTIC_LIMITS.maxMarkdownDefinitionsPerDocument + 1),
    );
    expect(exceeded.failure).toContain('link definitions');
    expect(exceeded.linkCandidates).toBe(OKF_SEMANTIC_LIMITS.maxMarkdownDefinitionsPerDocument + 1);
    expect(
      inspectMarkdownComplexity(
        `[d]:\n  ${'é'.repeat(OKF_SEMANTIC_LIMITS.maxLinkTargetBytes / 2 + 1)}`,
      ).failure,
    ).toContain('link target');
  });

  it('counts resolved CommonMark shortcuts at the exact link boundary and rejects +1', () => {
    const shortcuts = (count: number): string =>
      `${'[shortcut]\n'.repeat(count)}\n[shortcut]: target.md\n`;
    const exact = inspectMarkdownComplexity(
      shortcuts(OKF_SEMANTIC_LIMITS.maxMarkdownLinksPerDocument),
    );
    expect(exact.failure).toBeUndefined();
    expect(exact.linkCandidates).toBe(OKF_SEMANTIC_LIMITS.maxMarkdownLinksPerDocument + 1);

    const exceeded = inspectMarkdownComplexity(
      shortcuts(OKF_SEMANTIC_LIMITS.maxMarkdownLinksPerDocument + 1),
    );
    expect(exceeded.failure).toContain('links');
    expect(exceeded.linkCandidates).toBe(OKF_SEMANTIC_LIMITS.maxMarkdownLinksPerDocument + 2);
  });

  it('counts resolved shortcut images at the exact parser-work boundary and rejects +1', () => {
    const images = (count: number): string => `${'![image]\n'.repeat(count)}\n[image]: image.png\n`;
    const exact = inspectMarkdownComplexity(
      images(OKF_SEMANTIC_LIMITS.maxMarkdownLinksPerDocument),
    );
    expect(exact.failure).toBeUndefined();
    expect(exact.linkCandidates).toBe(OKF_SEMANTIC_LIMITS.maxMarkdownLinksPerDocument + 1);

    const exceeded = inspectMarkdownComplexity(
      images(OKF_SEMANTIC_LIMITS.maxMarkdownLinksPerDocument + 1),
    );
    expect(exceeded.failure).toContain('links and images');
    expect(exceeded.linkCandidates).toBe(OKF_SEMANTIC_LIMITS.maxMarkdownLinksPerDocument + 2);
  });

  it('freezes trusted Markdown inspections so callers cannot retarget parser-work metadata', () => {
    const inspected = inspectMarkdownComplexity('[safe](target.md)');

    expect(Object.isFrozen(inspected)).toBe(true);
    expect(() => {
      Object.assign(inspected, {
        inspectedSource: '[unsafe](target.md)',
        linkCandidates: 0,
        syntaxCandidates: 0,
      });
    }).toThrow(TypeError);
    expect(inspected).toMatchObject({
      inspectedSource: '[safe](target.md)',
      linkCandidates: 1,
    });
  });

  it('bounds nested link and image collector work at depth 64 and rejects +1', () => {
    const nestedImages = (depth: number): string =>
      `${'!['.repeat(depth)}label${'](image.png)'.repeat(depth)}`;
    const exact = inspectMarkdownComplexity(
      nestedImages(OKF_SEMANTIC_LIMITS.maxMarkdownMediaNestingDepth),
    );
    expect(exact.failure).toBeUndefined();
    expect(exact.linkCandidates).toBe(OKF_SEMANTIC_LIMITS.maxMarkdownMediaNestingDepth);

    const exceeded = inspectMarkdownComplexity(
      nestedImages(OKF_SEMANTIC_LIMITS.maxMarkdownMediaNestingDepth + 1),
    );
    expect(exceeded.failure).toContain('nesting');
    expect(exceeded.linkCandidates).toBe(0);
  });

  it('rejects deeply nested image amplification before full inline postprocessing', () => {
    const depth = 4_000;
    const adversarial = `${'!['.repeat(depth)}x${'](i)'.repeat(depth)}`;
    const startedAt = performance.now();
    const inspected = inspectMarkdownComplexity(adversarial);
    const elapsedMilliseconds = performance.now() - startedAt;

    expect(inspected.failure).toContain('link and image label nesting');
    expect(inspected.syntaxCandidates).toBe(OKF_SEMANTIC_LIMITS.maxMarkdownSyntaxCandidates);
    expect(inspected.linkCandidates).toBe(0);
    expect(elapsedMilliseconds).toBeLessThan(1_000);
  });

  it('ignores opaque flow blocks, matched code spans, and escaped brackets in the cheap guard', () => {
    const nested = `${'!['.repeat(OKF_SEMANTIC_LIMITS.maxMarkdownMediaNestingDepth + 1)}x${'](i)'.repeat(OKF_SEMANTIC_LIMITS.maxMarkdownMediaNestingDepth + 1)}`;
    for (const markdown of [
      `\`${nested}\``,
      `~~~md\n${nested}\n~~~\n`,
      `    ${nested}\n`,
      `<div>\n${nested}\n</div>\n`,
      `${'\\['.repeat(OKF_SEMANTIC_LIMITS.maxMarkdownMediaNestingDepth + 1)}x`,
    ]) {
      expect(inspectMarkdownComplexity(markdown).failure, markdown.slice(0, 24)).toBeUndefined();
    }

    expect(
      inspectMarkdownComplexity(
        `${'\\\\['.repeat(OKF_SEMANTIC_LIMITS.maxMarkdownMediaNestingDepth + 1)}x`,
      ).failure,
    ).toContain('link and image label nesting');
  });

  it('uses CommonMark contexts for definitions, references, autolinks, code, and HTML', () => {
    const inspected = inspectMarkdownComplexity(
      [
        '[unclosed',
        '',
        '`[inline-code](target)`',
        '',
        '```md',
        '[fenced]: target',
        '[fenced](target)',
        '```',
        '',
        '    [indented]: target',
        '',
        '<div>',
        '[html-block]: target',
        '[html-block](target)',
        '</div>',
        '',
        '<span title="[attribute](target)">text</span>',
        '',
        '![image](image.png)',
        '[full][missing]',
        '[collapsed][]',
        '[shortcut]',
        '',
        '> [quoted]: target.md',
        '> ',
        '> [quoted]',
        '',
        '<span>[actual](target.md)</span>',
      ].join('\n'),
    );

    expect(inspected.failure).toBeUndefined();
    // One image, one blockquote definition, its resolved shortcut, and the inline-HTML child link.
    expect(inspected.linkCandidates).toBe(4);
  });

  it('bounds protocol and email autolinks including the semantic mailto prefix', () => {
    const exactProtocol = inspectMarkdownComplexity(`<xx:${'é'.repeat(254)}a>`);
    expect(exactProtocol.failure).toBeUndefined();
    expect(exactProtocol.linkCandidates).toBe(1);
    expect(inspectMarkdownComplexity(`<xx:${'é'.repeat(254)}ab>`).failure).toContain('link label');

    const exactEmail = inspectMarkdownComplexity(`<${'a'.repeat(508)}@x.y>`);
    expect(exactEmail.failure).toBeUndefined();
    expect(exactEmail.linkCandidates).toBe(1);
    expect(inspectMarkdownComplexity(`<${'a'.repeat(509)}@x.y>`).failure).toContain('link label');

    const exactNestedAutolinks = inspectMarkdownComplexity(
      `[<xx:${'a'.repeat(251)}> <xx:${'b'.repeat(254)}>](target.md)`,
    );
    expect(exactNestedAutolinks.failure).toBeUndefined();
    expect(exactNestedAutolinks.linkCandidates).toBe(3);
    expect(
      inspectMarkdownComplexity(`[<xx:${'a'.repeat(251)}> <xx:${'b'.repeat(255)}>](target.md)`)
        .failure,
    ).toContain('link label');
  });

  it('enforces UTF-8 byte boundaries and ignores escaped Markdown delimiters pre-AST', () => {
    const exactLabel = inspectMarkdownComplexity(
      `[${'é'.repeat(OKF_SEMANTIC_LIMITS.maxLinkLabelBytes / 2)}](target.md)`,
    );
    expect(exactLabel.failure).toBeUndefined();
    expect(
      inspectMarkdownComplexity(
        `[${'é'.repeat(OKF_SEMANTIC_LIMITS.maxLinkLabelBytes / 2 + 1)}](target.md)`,
      ).failure,
    ).toContain('link label');

    const exactTarget = inspectMarkdownComplexity(
      `[label](${'é'.repeat(OKF_SEMANTIC_LIMITS.maxLinkTargetBytes / 2)})`,
    );
    expect(exactTarget.failure).toBeUndefined();
    expect(
      inspectMarkdownComplexity(
        `[label](${'é'.repeat(OKF_SEMANTIC_LIMITS.maxLinkTargetBytes / 2 + 1)})`,
      ).failure,
    ).toContain('link target');

    const escapedLabelClose = inspectMarkdownComplexity(
      `[${'a'.repeat(OKF_SEMANTIC_LIMITS.maxLinkLabelCodeUnits - 2)}\\](x)[q]](target.md)`,
    );
    expect(escapedLabelClose.failure).toContain('link label');

    const escapedTargetClose = inspectMarkdownComplexity(
      `[label](a\\)${'b'.repeat(OKF_SEMANTIC_LIMITS.maxLinkTargetCodeUnits)})`,
    );
    expect(escapedTargetClose.failure).toContain('link target');

    expect(
      inspectMarkdownComplexity(
        `[label](a\\)${'b'.repeat(OKF_SEMANTIC_LIMITS.maxLinkTargetCodeUnits - 2)})`,
      ).failure,
    ).toBeUndefined();
    expect(
      inspectMarkdownComplexity(
        `[label](${'a'.repeat(OKF_SEMANTIC_LIMITS.maxLinkTargetCodeUnits - 1)}&amp;)`,
      ).failure,
    ).toBeUndefined();
    expect(
      inspectMarkdownComplexity(
        `[label](${'a'.repeat(OKF_SEMANTIC_LIMITS.maxLinkTargetCodeUnits)}&amp;)`,
      ).failure,
    ).toContain('link target');

    expect(
      inspectMarkdownComplexity(
        `[a\\]${'b'.repeat(OKF_SEMANTIC_LIMITS.maxLinkLabelCodeUnits - 2)}](target.md)`,
      ).failure,
    ).toBeUndefined();
    expect(
      inspectMarkdownComplexity(
        `[${'a'.repeat(OKF_SEMANTIC_LIMITS.maxLinkLabelCodeUnits - 1)}&amp;](target.md)`,
      ).failure,
    ).toBeUndefined();
    expect(
      inspectMarkdownComplexity(
        `[${'a'.repeat(OKF_SEMANTIC_LIMITS.maxLinkLabelCodeUnits)}&amp;](target.md)`,
      ).failure,
    ).toContain('link label');

    const expandingEntity = '&nGt;';
    expect(
      inspectMarkdownComplexity(`[${expandingEntity.repeat(85)}aa](target.md)`).failure,
    ).toBeUndefined();
    expect(
      inspectMarkdownComplexity(`[${expandingEntity.repeat(85)}aaa](target.md)`).failure,
    ).toContain('link label');
    expect(
      inspectMarkdownComplexity(`[label](${expandingEntity.repeat(341)}aa)`).failure,
    ).toBeUndefined();
    expect(
      inspectMarkdownComplexity(`[label](${expandingEntity.repeat(341)}aaa)`).failure,
    ).toContain('link target');

    expect(
      inspectMarkdownComplexity(`[${'a'.repeat(509)}\r\nb](target.md)`).failure,
    ).toBeUndefined();
    expect(inspectMarkdownComplexity(`[${'a'.repeat(510)}\r\nb](target.md)`).failure).toContain(
      'link label',
    );

    expect(
      inspectMarkdownComplexity(
        `[*${'a'.repeat(OKF_SEMANTIC_LIMITS.maxLinkLabelCodeUnits)}*](target.md)`,
      ).failure,
    ).toBeUndefined();
    expect(
      inspectMarkdownComplexity(
        `[*${'a'.repeat(OKF_SEMANTIC_LIMITS.maxLinkLabelCodeUnits + 1)}*](target.md)`,
      ).failure,
    ).toContain('link label');
    expect(
      inspectMarkdownComplexity(
        '[`' + 'a'.repeat(OKF_SEMANTIC_LIMITS.maxLinkLabelCodeUnits) + '`](target.md)',
      ).failure,
    ).toBeUndefined();
    expect(
      inspectMarkdownComplexity(
        '[`' + 'a'.repeat(OKF_SEMANTIC_LIMITS.maxLinkLabelCodeUnits + 1) + '`](target.md)',
      ).failure,
    ).toContain('link label');

    const exactAngleTarget = inspectMarkdownComplexity(`[label](<${'é'.repeat(1_023)}(a>)`);
    expect(exactAngleTarget.failure).toBeUndefined();
    expect(inspectMarkdownComplexity(`[label](\n<${'é'.repeat(1_023)}(ab>)`).failure).toContain(
      'link target',
    );

    const codeSpanClose = inspectMarkdownComplexity(
      '[a `]` ' + 'b'.repeat(OKF_SEMANTIC_LIMITS.maxLinkLabelCodeUnits) + '](target.md)',
    );
    expect(codeSpanClose.failure).toContain('link label');

    const htmlClose = inspectMarkdownComplexity(
      `[a <i title="]">x</i> ${'b'.repeat(OKF_SEMANTIC_LIMITS.maxLinkLabelCodeUnits)}](target.md)`,
    );
    expect(htmlClose.failure).toContain('link label');

    expect(
      inspectMarkdownComplexity(`[${'a'.repeat(256)}<i\nx>${'b'.repeat(256)}](target.md)`).failure,
    ).toBeUndefined();
    expect(
      inspectMarkdownComplexity(`[${'a'.repeat(256)}<i\nx>${'b'.repeat(257)}](target.md)`).failure,
    ).toContain('link label');

    expect(
      inspectMarkdownComplexity(`[![${'<i>'.repeat(170)}xx](image.png)](target.md)`).failure,
    ).toBeUndefined();
    expect(
      inspectMarkdownComplexity(`[![${'<i>'.repeat(171)}](image.png)](target.md)`).failure,
    ).toContain('link label');
    expect(
      inspectMarkdownComplexity(
        `[![${'a'.repeat(256)}  \n${'b'.repeat(256)}](image.png)](target.md)`,
      ).failure,
    ).toBeUndefined();
    expect(
      inspectMarkdownComplexity(
        `[![${'a'.repeat(256)}  \n${'b'.repeat(257)}](image.png)](target.md)`,
      ).failure,
    ).toContain('link label');
    expect(
      inspectMarkdownComplexity(
        `> [![<i\n>  class=x>x</i>${'a'.repeat(496)}](image.png)](target.md)`,
      ).failure,
    ).toBeUndefined();
    expect(
      inspectMarkdownComplexity(
        `> [![<i\n>  class=x>x</i>${'a'.repeat(497)}](image.png)](target.md)`,
      ).failure,
    ).toContain('link label');
    expect(
      inspectMarkdownComplexity(`![[<i>x</i>${'a'.repeat(504)}](target.md)](image.png)`).failure,
    ).toBeUndefined();
    expect(
      inspectMarkdownComplexity(`![[<i>x</i>${'a'.repeat(505)}](target.md)](image.png)`).failure,
    ).toContain('link label');
    expect(
      inspectMarkdownComplexity(`![${'<xx:a>'.repeat(128)}](image.png)`).failure,
    ).toBeUndefined();
    expect(inspectMarkdownComplexity(`![${'<xx:a>'.repeat(129)}](image.png)`).failure).toContain(
      'link label',
    );

    expect(
      inspectMarkdownComplexity(`> [${'a'.repeat(256)}\n> ${'b'.repeat(255)}](target.md)`).failure,
    ).toBeUndefined();
    expect(
      inspectMarkdownComplexity(`> [${'a'.repeat(256)}\n> ${'b'.repeat(256)}](target.md)`).failure,
    ).toContain('link label');
  });

  it('enforces aggregate YAML structural work at the exact boundary before later ASTs', () => {
    const punctuationCount = OKF_SEMANTIC_LIMITS.maxFrontmatterStructuralTokens - 4;
    const denseMetadata = `producer: "${'!'.repeat(punctuationCount)}"\n`;
    const exactDocuments = Array.from({ length: 32 }, (_, index) =>
      document(`f-${String(index).padStart(2, '0')}.md`, concept('', denseMetadata)),
    );
    const exact = parseBundle({
      rootUri,
      revision: 1,
      documents: exactDocuments,
    });
    expect(exact.failures).toEqual([]);

    const exceeded = parseBundle({
      rootUri,
      revision: 2,
      documents: [
        ...exactDocuments,
        document('g-exceeded.md', concept()),
        document('z-tail.md', concept('# Must not enter YAML or remark\n')),
      ],
    });
    expect(exceeded.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bundlePath: 'g-exceeded.md',
          reason: 'resource-limit',
          scope: 'bundle',
          message: expect.stringContaining('pre-AST work limit'),
        }),
        expect.objectContaining({
          bundlePath: 'z-tail.md',
          reason: 'resource-limit',
          scope: 'document',
        }),
      ]),
    );
    expect(exceeded.concepts.find(({ id }) => id === 'z-tail')?.type).toBe('');
  });

  it('charges failed YAML inspections before enforcing the bundle work limit', () => {
    const failedMetadata = `producer: "${'!'.repeat(
      OKF_SEMANTIC_LIMITS.maxFrontmatterStructuralTokens,
    )}"\n`;
    const parsed = parseBundle({
      rootUri,
      revision: 1,
      documents: [
        ...Array.from({ length: 32 }, (_, index) =>
          document(`failed-yaml-${String(index).padStart(2, '0')}.md`, concept('', failedMetadata)),
        ),
        document('z-tail.md', concept('# Must not enter an AST\n')),
      ],
    });

    expect(parsed.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'resource-limit',
          scope: 'bundle',
          message: expect.stringContaining('YAML frontmatter'),
        }),
        expect.objectContaining({
          bundlePath: 'z-tail.md',
          reason: 'resource-limit',
          message: expect.stringContaining('Semantic parsing was skipped'),
        }),
      ]),
    );
    expect(parsed.concepts.find(({ id }) => id === 'z-tail')).toMatchObject({
      type: '',
      body: '',
      links: [],
    });
  });

  it('bounds per-concept tags without suppressing a valid sibling', () => {
    const tags = Array.from(
      { length: OKF_SEMANTIC_LIMITS.maxTagsPerConcept + 1 },
      (_, index) => `tag-${String(index)}`,
    );
    const parsed = parseBundle({
      rootUri,
      revision: 1,
      documents: [
        document('a-tags.md', concept('', `tags: [${tags.join(', ')}]\n`)),
        document('z-valid.md', concept()),
      ],
    });

    expect(parsed.failures).toEqual([
      expect.objectContaining({
        bundlePath: 'a-tags.md',
        reason: 'resource-limit',
        scope: 'document',
        message: expect.stringContaining('per-concept safety limit'),
      }),
    ]);
    expect(parsed.concepts.map(({ id, type }) => [id, type])).toEqual([
      ['a-tags', ''],
      ['z-valid', 'concept'],
    ]);
  });

  it('rejects an unpaired surrogate restored from an ASCII YAML escape', () => {
    const parsed = parseBundle({
      rootUri,
      revision: 1,
      documents: [
        document('a-escaped.md', '---\ntype: "a\\uD800b"\n---\n# Unsafe metadata\n'),
        document('z-valid.md', concept('# Valid\n')),
      ],
    });

    expect(parsed.failures).toEqual([
      expect.objectContaining({
        bundlePath: 'a-escaped.md',
        reason: 'resource-limit',
        scope: 'document',
        message: expect.stringContaining('unpaired UTF-16 surrogate'),
      }),
    ]);
    expect(parsed.concepts.map(({ id, type }) => [id, type])).toEqual([
      ['a-escaped', ''],
      ['z-valid', 'concept'],
    ]);
  });
});
