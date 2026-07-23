import { describe, expect, it } from 'vitest';

import { OKF_SEMANTIC_LIMITS, type OperationResult } from '../../../src/core/model/index.js';
import { parseBundle } from '../../../src/core/parser/index.js';
import {
  parseConceptTagsInput,
  renderConceptTemplate,
  type ConceptTemplateInput,
  type RenderedTemplateFile,
} from '../../../src/core/templates/index.js';
import { validateBundle } from '../../../src/core/validation/index.js';

const ROOT_URI = 'memfs:/workspace/generated-concept-limits';
const VALIDATION_NOW = '2026-07-23T00:00:00Z';

function render(
  overrides: Partial<ConceptTemplateInput> = {},
): OperationResult<RenderedTemplateFile> {
  return renderConceptTemplate({
    template: 'generic-concept',
    relativePath: 'bounded.md',
    type: 'concept',
    title: 'Bounded concept',
    ...overrides,
  });
}

function valueOf<T>(result: OperationResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.problems.map(({ message }) => message).join('\n'));
  }
  return result.value;
}

function expectFailureCode(result: OperationResult<unknown>, code: string): void {
  expect(result).toMatchObject({ ok: false, problems: [{ code }] });
}

function parseGeneratedConcept(file: RenderedTemplateFile) {
  return parseBundle({
    rootUri: ROOT_URI,
    revision: 1,
    documents: [
      {
        uri: `${ROOT_URI}/index.md`,
        bundlePath: 'index.md',
        content: '---\nokf_version: "0.1"\n---\n# Knowledge\n',
      },
      {
        uri: `${ROOT_URI}/${file.relativePath}`,
        bundlePath: file.relativePath,
        content: file.content,
      },
    ],
  });
}

function exactMultibyteUtf8(byteLength: number): string {
  return `${'界'.repeat(Math.floor(byteLength / 3))}${'a'.repeat(byteLength % 3)}`;
}

describe('generated concept semantic limits', () => {
  it('accepts every inclusive metadata boundary and remains parseable and conformant', () => {
    const file = valueOf(
      render({
        type: 't'.repeat(OKF_SEMANTIC_LIMITS.maxTypeCodeUnits),
        title: 'a'.repeat(OKF_SEMANTIC_LIMITS.maxTitleCodeUnits),
        description: 'd'.repeat(OKF_SEMANTIC_LIMITS.maxDescriptionCodeUnits),
        tags: Array.from({ length: OKF_SEMANTIC_LIMITS.maxTagsPerConcept }, () =>
          'g'.repeat(OKF_SEMANTIC_LIMITS.maxTagCodeUnits),
        ),
        timestamp: 'z'.repeat(OKF_SEMANTIC_LIMITS.maxTimestampCodeUnits),
      }),
    );
    const bundle = parseGeneratedConcept(file);

    expect(bundle.failures).toEqual([]);
    expect(
      validateBundle(bundle, { now: VALIDATION_NOW }).filter(
        ({ category }) => category === 'conformance',
      ),
    ).toEqual([]);
    expect(bundle.concepts).toHaveLength(1);
    expect(bundle.concepts[0]).toMatchObject({
      type: 't'.repeat(OKF_SEMANTIC_LIMITS.maxTypeCodeUnits),
      title: 'a'.repeat(OKF_SEMANTIC_LIMITS.maxTitleCodeUnits),
      description: 'd'.repeat(OKF_SEMANTIC_LIMITS.maxDescriptionCodeUnits),
      tags: Array.from({ length: OKF_SEMANTIC_LIMITS.maxTagsPerConcept }, () =>
        'g'.repeat(OKF_SEMANTIC_LIMITS.maxTagCodeUnits),
      ),
      timestamp: 'z'.repeat(OKF_SEMANTIC_LIMITS.maxTimestampCodeUnits),
    });
  });

  it.each([
    {
      name: 'type code units',
      overrides: { type: 't'.repeat(OKF_SEMANTIC_LIMITS.maxTypeCodeUnits + 1) },
      code: 'concept-type-code-unit-limit',
    },
    {
      name: 'title code units after normalization',
      overrides: { title: `  ${'a'.repeat(OKF_SEMANTIC_LIMITS.maxTitleCodeUnits + 1)}\n` },
      code: 'concept-title-code-unit-limit',
    },
    {
      name: 'description code units after newline normalization',
      overrides: {
        description: 'd'.repeat(OKF_SEMANTIC_LIMITS.maxDescriptionCodeUnits + 1),
      },
      code: 'concept-description-code-unit-limit',
    },
    {
      name: 'tag count',
      overrides: {
        tags: Array.from({ length: OKF_SEMANTIC_LIMITS.maxTagsPerConcept + 1 }, () => 'tag'),
      },
      code: 'concept-tag-count-limit',
    },
    {
      name: 'tag code units',
      overrides: { tags: ['g'.repeat(OKF_SEMANTIC_LIMITS.maxTagCodeUnits + 1)] },
      code: 'concept-tag-code-unit-limit',
    },
    {
      name: 'timestamp code units',
      overrides: {
        timestamp: 'z'.repeat(OKF_SEMANTIC_LIMITS.maxTimestampCodeUnits + 1),
      },
      code: 'concept-timestamp-code-unit-limit',
    },
  ])('refuses the first value outside the $name limit', ({ overrides, code }) => {
    expectFailureCode(render(overrides), code);
  });

  it('measures multibyte type and tag identities by UTF-8 bytes', () => {
    const exactBytes = `${'界'.repeat(85)}a`;
    const overBytes = `${exactBytes}a`;
    const exactFile = valueOf(render({ type: exactBytes, tags: [exactBytes] }));

    expect(exactFile.content).toContain(`type: "${exactBytes}"`);
    expect(exactFile.content).toContain(`  - "${exactBytes}"`);
    expect(parseGeneratedConcept(exactFile).failures).toEqual([]);
    expectFailureCode(render({ type: overBytes }), 'concept-type-utf8-limit');
    expectFailureCode(render({ tags: [overBytes] }), 'concept-tag-utf8-limit');
  });

  it('applies title and description normalization before their inclusive limits', () => {
    const title = ` \r\n ${'a'.repeat(OKF_SEMANTIC_LIMITS.maxTitleCodeUnits)} \t`;
    const description = `${'d'.repeat(OKF_SEMANTIC_LIMITS.maxDescriptionCodeUnits - 1)}\r\n`;
    const file = valueOf(render({ title, description }));

    expect(file.content).toContain(`title: "${'a'.repeat(OKF_SEMANTIC_LIMITS.maxTitleCodeUnits)}"`);
    expect(file.content).toContain(
      `description: "${'d'.repeat(OKF_SEMANTIC_LIMITS.maxDescriptionCodeUnits - 1)}\\n"`,
    );
    expect(parseGeneratedConcept(file).failures).toEqual([]);
  });

  it('refuses metadata whose YAML escaping would exceed the parser envelope', () => {
    expectFailureCode(
      render({
        tags: Array.from({ length: OKF_SEMANTIC_LIMITS.maxTagsPerConcept }, () =>
          '\\'.repeat(OKF_SEMANTIC_LIMITS.maxTagCodeUnits),
        ),
      }),
      'generated-concept-frontmatter-limit',
    );
  });

  it('refuses title and description punctuation at the first parser work envelope', () => {
    expectFailureCode(
      render({
        title: '\\'.repeat(OKF_SEMANTIC_LIMITS.maxTitleCodeUnits),
        description: '\\'.repeat(OKF_SEMANTIC_LIMITS.maxDescriptionCodeUnits),
      }),
      'generated-concept-frontmatter-limit',
    );
  });

  it('mirrors post-AST UTF-8 bounds for generated Markdown links', () => {
    const exactLabel = exactMultibyteUtf8(OKF_SEMANTIC_LIMITS.maxLinkLabelBytes);
    const exactTarget = exactMultibyteUtf8(OKF_SEMANTIC_LIMITS.maxLinkTargetBytes);
    const exactFile = valueOf(render({ description: `[${exactLabel}](${exactTarget})` }));

    expect(parseGeneratedConcept(exactFile).failures).toEqual([]);
    expectFailureCode(
      render({ description: `[${exactLabel}a](${exactTarget})` }),
      'generated-concept-markdown-limit',
    );
    expectFailureCode(
      render({ description: `[${exactLabel}](${exactTarget}a)` }),
      'generated-concept-markdown-limit',
    );
  });

  it('normalizes comma-separated command tags without retaining empty segments', () => {
    expect(valueOf(parseConceptTagsInput(' architecture, , decision ,, '))).toEqual([
      'architecture',
      'decision',
    ]);

    const tooMany = Array.from(
      { length: OKF_SEMANTIC_LIMITS.maxTagsPerConcept + 1 },
      (_, index) => `tag-${String(index)}`,
    ).join(',');
    expectFailureCode(parseConceptTagsInput(tooMany), 'concept-tag-count-limit');
  });

  it.each([
    ['type', { type: 'unsafe\nvalue' }, 'unsafe-concept-type-control'],
    ['tag', { tags: ['unsafe\u0085value'] }, 'unsafe-concept-tag-control'],
    ['timestamp', { timestamp: 'unsafe\tvalue' }, 'unsafe-concept-timestamp-control'],
  ])('refuses a control character in %s metadata', (_field, overrides, code) => {
    expectFailureCode(render(overrides), code);
  });

  it('refuses an unpaired UTF-16 surrogate in every generated metadata field', () => {
    const malformed = `unsafe${String.fromCharCode(0xd800)}`;

    expectFailureCode(render({ type: malformed }), 'concept-type-unicode-scalar');
    expectFailureCode(render({ title: malformed }), 'concept-title-unicode-scalar');
    expectFailureCode(render({ description: malformed }), 'concept-description-unicode-scalar');
    expectFailureCode(render({ tags: [malformed] }), 'concept-tag-unicode-scalar');
    expectFailureCode(render({ timestamp: malformed }), 'concept-timestamp-unicode-scalar');
  });
});
