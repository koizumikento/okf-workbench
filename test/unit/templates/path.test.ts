import { describe, expect, it } from 'vitest';

import { OKF_SEMANTIC_LIMITS } from '../../../src/core/model/index.js';
import {
  normalizeBundleDirectory,
  normalizeConceptPath,
  normalizeIndexPath,
  normalizeTemplateOutputPath,
  preserveProviderBundleDirectory,
  preserveProviderConceptPath,
  preserveProviderIndexPath,
  renderConceptTemplate,
} from '../../../src/core/templates/index.js';

describe('template output path safety', () => {
  it.each([
    ['知識/実験 結果.md', '知識/実験 結果.md'],
    ['%E7%9F%A5%E8%AD%98/%E5%AE%9F%E9%A8%93%20%E7%B5%90%E6%9E%9C.md', '知識/実験 結果.md'],
    [
      '%25E7%259F%25A5%25E8%25AD%2598/%25E5%25AE%259F%25E9%25A8%2593%2520%25E7%25B5%2590%25E6%259E%259C.md',
      '知識/実験 結果.md',
    ],
    ['architecture/system%20overview.md', 'architecture/system overview.md'],
  ])('preserves safe Unicode and spaces in %s', (input, expected) => {
    expect(normalizeConceptPath(input)).toEqual({ ok: true, value: expected, warnings: [] });
  });

  it.each([
    ['.notes.md', '.notes.md'],
    ['nested/.notes.md', 'nested/.notes.md'],
    ['ordinary.md', 'ordinary.md'],
  ])('keeps a non-empty concept stem valid for %s', (input, expected) => {
    expect(normalizeConceptPath(input)).toEqual({ ok: true, value: expected, warnings: [] });
  });

  it.each(['.md', 'nested/.md', '%2emd', 'nested/%252emd', '.MD'])(
    'rejects a concept path without a non-empty filename stem: %s',
    (input) => {
      expect(normalizeConceptPath(input)).toMatchObject({
        ok: false,
        problems: [{ code: 'unsafe-relative-path' }],
      });
    },
  );

  it.each([
    '../escape.md',
    '%2e%2e/escape.md',
    '%252e%252e/escape.md',
    '%25252e%25252e/escape.md',
    'safe/%252e%252e/escape.md',
    '%252e%252e%252fescape.md',
    '%252fabsolute.md',
    'C%253A%255Coutside.md',
    'safe/file.md:payload',
    'safe/file%3Astream.md',
    '%2568%2574%2574%2570%2573%253A%252F%252Fexample.test%252Fconcept.md',
  ])('rejects encoded or repeatedly encoded containment escape %s', (input) => {
    expect(normalizeConceptPath(input)).toMatchObject({ ok: false });
  });

  it.each([
    'CON.md',
    'aux.md',
    'COM1.md',
    'folder/Lpt9.md',
    'folder/name?.md',
    'folder/a|b.md',
    'folder/a<b>.md',
    'folder/quote"name.md',
    'folder/name%3F.md',
    'folder/trailing .md ',
    'folder/trailing.',
  ])('rejects a generated path with a non-portable Windows component: %s', (input) => {
    expect(normalizeConceptPath(input)).toMatchObject({
      ok: false,
      problems: [{ code: 'unsafe-relative-path' }],
    });
  });

  it.each(['COM0.md', 'COM10.md', 'console.md', '.CON.md'])(
    'keeps a non-device Windows-compatible filename valid: %s',
    (input) => {
      expect(normalizeConceptPath(input)).toMatchObject({ ok: true, value: input });
    },
  );

  it('refuses an unsafe target in the pure renderer before a workspace proposal exists', () => {
    expect(
      renderConceptTemplate({
        template: 'generic-concept',
        relativePath: '%252e%252e/escape.md',
        type: 'concept',
        title: 'Must not render',
      }),
    ).toMatchObject({
      ok: false,
      problems: [{ code: 'unsafe-relative-path' }],
    });
  });

  it.each([
    'safe/\0name.md',
    'safe/\u001fname.md',
    'safe/\u007fname.md',
    'safe/\u0080name.md',
    'safe/\u009fname.md',
    'safe/%00name.md',
    'safe/%1fname.md',
    'safe/%7fname.md',
    'safe/%C2%80name.md',
    'safe/%C2%9Fname.md',
    'safe/%2500name.md',
    'safe/%25C2%2580name.md',
  ])('rejects raw, encoded, or repeatedly encoded C0/C1 control input %s', (input) => {
    const result = normalizeConceptPath(input);

    expect(result).toMatchObject({
      ok: false,
      problems: [{ code: 'unsafe-relative-path' }],
    });
  });

  it.each([
    ['%252e%252e/index.md', normalizeIndexPath],
    ['%252e%252e/bundle', normalizeBundleDirectory],
    ['bundle/%2500', normalizeBundleDirectory],
  ])('applies the same stable rule to every generated path for %s', (input, normalize) => {
    expect(normalize(input)).toMatchObject({ ok: false });
  });

  it('rejects excessive percent-encoding depth deterministically', () => {
    let path = '../escape.md';
    for (let round = 0; round < 17; round += 1) {
      path = encodeURIComponent(path);
    }

    expect(normalizeConceptPath(path)).toMatchObject({
      ok: false,
      problems: [
        {
          code: 'unsafe-relative-path',
          message: expect.stringContaining('excessive nested percent encoding'),
        },
      ],
    });
  });

  it.each([
    'literal%.md',
    'encoded%2Fsegment.md',
    'encoded%252Fsegment.md',
    'space dir/日本 語.md',
    '%2e%2e/literal-provider-name.md',
  ])('preserves the provider concept identity %s without percent decoding', (input) => {
    expect(preserveProviderConceptPath(input)).toEqual({ ok: true, value: input, warnings: [] });
  });

  it.each(['.md', 'nested/.md'])(
    'rejects a provider concept path without a non-empty filename stem: %s',
    (input) => {
      expect(preserveProviderConceptPath(input)).toMatchObject({
        ok: false,
        problems: [{ code: 'unsafe-relative-path' }],
      });
    },
  );

  it('keeps user-input decoding separate from provider identity preservation', () => {
    expect(normalizeConceptPath('encoded%2Fsegment.md')).toEqual({
      ok: true,
      value: 'encoded/segment.md',
      warnings: [],
    });
    expect(preserveProviderConceptPath('encoded%2Fsegment.md')).toEqual({
      ok: true,
      value: 'encoded%2Fsegment.md',
      warnings: [],
    });
    expect(normalizeConceptPath('literal%.md')).toMatchObject({ ok: false });
    expect(preserveProviderConceptPath('literal%.md')).toMatchObject({ ok: true });
  });

  it.each(['docs:knowledge', 'literal%2Fsegment/知識', '%2e%2e/literal-provider-name'])(
    'preserves the provider bundle directory identity %s without decoding',
    (input) => {
      expect(preserveProviderBundleDirectory(input)).toEqual({
        ok: true,
        value: { pathIdentity: 'provider', relativePath: input },
        warnings: [],
      });
    },
  );

  it('keeps provider identities outside generated-filesystem component policy', () => {
    for (const input of ['docs:knowledge', 'folder/CON', 'folder/name?', 'folder/trailing.']) {
      expect(preserveProviderBundleDirectory(input)).toEqual({
        ok: true,
        value: { pathIdentity: 'provider', relativePath: input },
        warnings: [],
      });
    }
  });

  it('does not weaken URI-like or percent-encoded user bundle path validation', () => {
    expect(normalizeBundleDirectory('docs:knowledge')).toMatchObject({ ok: false });
    expect(normalizeBundleDirectory('literal%2Fsegment/知識')).toEqual({
      ok: true,
      value: 'literal/segment/知識',
      warnings: [],
    });
  });

  it.each([
    '',
    '../escape',
    'safe/../escape',
    'safe/./same',
    'safe//empty',
    '/absolute',
    'C:/absolute',
    'wrong\\separator',
    'safe/\0control',
  ])('rejects structurally unsafe provider bundle directory %s', (input) => {
    expect(preserveProviderBundleDirectory(input)).toMatchObject({ ok: false });
  });

  it.each(['../escape.md', '/absolute.md', 'nested\\wrong.md', 'safe/./same.md', 'safe/\0.md'])(
    'rejects structurally unsafe provider concept path %s',
    (input) => {
      expect(preserveProviderConceptPath(input)).toMatchObject({ ok: false });
    },
  );

  it('preserves percent-bearing provider directory index identities', () => {
    expect(preserveProviderIndexPath('encoded%2Fsegment/index.md')).toEqual({
      ok: true,
      value: 'encoded%2Fsegment/index.md',
      warnings: [],
    });
    expect(preserveProviderIndexPath('encoded%2Fsegment/not-index.md')).toMatchObject({
      ok: false,
    });
  });

  it('accepts exact relative-path code-unit and UTF-8 boundaries and rejects +1', () => {
    const exactAscii = `${`${'a'.repeat(255)}/`.repeat(15)}a/${'a'.repeat(251)}.md`;
    expect(exactAscii).toHaveLength(OKF_SEMANTIC_LIMITS.maxProviderPathCodeUnits);
    expect(normalizeConceptPath(exactAscii)).toMatchObject({ ok: true, value: exactAscii });
    expect(normalizeConceptPath(`a${exactAscii}`)).toMatchObject({
      ok: false,
      problems: [{ message: expect.stringContaining('UTF-16 code units') }],
    });

    const exactUtf8 = `${`${'雪'.repeat(85)}/`.repeat(15)}雪/${'雪'.repeat(83)}.md`;
    expect(new TextEncoder().encode(exactUtf8)).toHaveLength(
      OKF_SEMANTIC_LIMITS.maxProviderPathBytes,
    );
    expect(normalizeConceptPath(exactUtf8)).toMatchObject({ ok: true, value: exactUtf8 });
    expect(normalizeConceptPath(`雪${exactUtf8}`)).toMatchObject({
      ok: false,
      problems: [{ message: expect.stringContaining('UTF-8 bytes') }],
    });
    expect(preserveProviderConceptPath(exactUtf8)).toMatchObject({
      ok: true,
      value: exactUtf8,
    });
    expect(preserveProviderConceptPath(`雪${exactUtf8}`)).toMatchObject({
      ok: false,
      problems: [{ message: expect.stringContaining('UTF-8 bytes') }],
    });
  });

  it('accepts a 255-byte generated component and rejects 256 bytes', () => {
    expect(normalizeConceptPath(`${'a'.repeat(252)}.md`)).toMatchObject({ ok: true });
    expect(normalizeConceptPath(`${'a'.repeat(253)}.md`)).toMatchObject({
      ok: false,
      problems: [{ code: 'unsafe-relative-path' }],
    });
  });

  it('accepts exactly 64 path segments and rejects a decoded or literal 65th segment', () => {
    const exact = `${'a/'.repeat(OKF_SEMANTIC_LIMITS.maxProviderPathSegments - 1)}a.md`;
    expect(exact.split('/')).toHaveLength(OKF_SEMANTIC_LIMITS.maxProviderPathSegments);
    expect(normalizeTemplateOutputPath(exact)).toMatchObject({ ok: true, value: exact });
    expect(normalizeTemplateOutputPath(`a/${exact}`)).toMatchObject({
      ok: false,
      problems: [{ message: expect.stringContaining('segments') }],
    });
    const encoded = `${'%2F'.repeat(OKF_SEMANTIC_LIMITS.maxProviderPathSegments)}a.md`;
    expect(normalizeTemplateOutputPath(encoded)).toMatchObject({
      ok: false,
      problems: [{ message: expect.stringContaining('segments') }],
    });
  });

  it('applies the same exact bounds to provider path identities before splitting', () => {
    const exact = `${'p/'.repeat(OKF_SEMANTIC_LIMITS.maxProviderPathSegments - 1)}index.md`;
    expect(preserveProviderIndexPath(exact)).toMatchObject({ ok: true, value: exact });
    expect(preserveProviderIndexPath(`p/${exact}`)).toMatchObject({
      ok: false,
      problems: [{ message: expect.stringContaining('segments') }],
    });
    expect(
      preserveProviderBundleDirectory('x'.repeat(OKF_SEMANTIC_LIMITS.maxProviderPathCodeUnits + 1)),
    ).toMatchObject({
      ok: false,
      problems: [{ message: expect.stringContaining('UTF-16 code units') }],
    });
  });

  it('rejects unpaired surrogates through every generated and provider path API', () => {
    for (const result of [
      normalizeConceptPath('bad\ud800.md'),
      normalizeIndexPath('bad\ud800/index.md'),
      normalizeTemplateOutputPath('bad\ud800/output.txt'),
      normalizeBundleDirectory('bad\ud800'),
      preserveProviderConceptPath('bad\ud800.md'),
      preserveProviderIndexPath('bad\ud800/index.md'),
      preserveProviderBundleDirectory('bad\ud800'),
    ]) {
      expect(result).toMatchObject({
        ok: false,
        problems: [{ message: expect.stringContaining('unpaired UTF-16 surrogate') }],
      });
    }
  });
});
