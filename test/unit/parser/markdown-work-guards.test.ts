import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';

import { OKF_SEMANTIC_LIMITS } from '../../../src/core/model/index.js';
import { inspectMarkdownComplexity } from '../../../src/core/parser/markdown.js';

describe('Markdown pre-AST work guards', () => {
  it('accepts container depth 64 and rejects 65 across CommonMark marker forms', () => {
    const cases = [
      ['dash', (depth: number) => `${'- '.repeat(depth)}x`],
      ['asterisk', (depth: number) => `${'* '.repeat(depth)}x`],
      ['plus', (depth: number) => `${'+ '.repeat(depth)}x`],
      ['ordered-dot', (depth: number) => `${'1. '.repeat(depth)}x`],
      ['ordered-paren', (depth: number) => `${'1) '.repeat(depth)}x`],
    ] as const;

    for (const [name, markdown] of cases) {
      expect(
        inspectMarkdownComplexity(markdown(OKF_SEMANTIC_LIMITS.maxMarkdownContainerNestingDepth))
          .failure,
        name,
      ).toBeUndefined();
      expect(
        inspectMarkdownComplexity(
          markdown(OKF_SEMANTIC_LIMITS.maxMarkdownContainerNestingDepth + 1),
        ).failure,
        name,
      ).toContain('list and blockquote nesting');
    }

    const mixedExact = `${'> + '.repeat(
      OKF_SEMANTIC_LIMITS.maxMarkdownContainerNestingDepth / 2,
    )}x`;
    expect(inspectMarkdownComplexity(mixedExact).failure).toBeUndefined();
    expect(inspectMarkdownComplexity(`${mixedExact.slice(0, -1)}> x`).failure).toContain(
      'list and blockquote nesting',
    );
  });

  it('guards gradual multiline and prior-list container nesting before flow expansion', () => {
    const gradual = (depth: number, indentation: (level: number) => string): string =>
      Array.from(
        { length: depth },
        (_, level) => `${indentation(level)}- item-${String(level)}`,
      ).join('\n');

    for (const [name, indentation] of [
      ['spaces', (level: number) => ' '.repeat(level * 2)],
      ['tabs', (level: number) => '\t'.repeat(level)],
    ] as const) {
      expect(
        inspectMarkdownComplexity(
          gradual(OKF_SEMANTIC_LIMITS.maxMarkdownContainerNestingDepth, indentation),
        ).failure,
        name,
      ).toBeUndefined();
      expect(
        inspectMarkdownComplexity(
          gradual(OKF_SEMANTIC_LIMITS.maxMarkdownContainerNestingDepth + 1, indentation),
        ).failure,
        name,
      ).toContain('list and blockquote nesting');
    }

    const nestedAfterBlank = (innerDepth: number): string =>
      `- outer\n\n    ${'- '.repeat(innerDepth)}x`;
    expect(
      inspectMarkdownComplexity(
        nestedAfterBlank(OKF_SEMANTIC_LIMITS.maxMarkdownContainerNestingDepth - 1),
      ).failure,
    ).toBeUndefined();
    expect(
      inspectMarkdownComplexity(
        nestedAfterBlank(OKF_SEMANTIC_LIMITS.maxMarkdownContainerNestingDepth),
      ).failure,
    ).toContain('list and blockquote nesting');

    expect(inspectMarkdownComplexity('- item\n'.repeat(10_000)).failure).toBeUndefined();
  });

  it('keeps container-looking text opaque in code and HTML and accepts thematic breaks', () => {
    const compact = `${'- '.repeat(OKF_SEMANTIC_LIMITS.maxMarkdownContainerNestingDepth + 1)}x`;
    for (const markdown of [
      `~~~md\n${compact}\n~~~\n`,
      `    ${compact}\n`,
      `<div>\n${compact}\n</div>\n`,
      `- outer\n\n      ~~~md\n      ${compact}\n      ~~~\n`,
      `\\- ${compact}`,
      '*'.repeat(10_000),
      '_'.repeat(10_000),
      '- '.repeat(OKF_SEMANTIC_LIMITS.maxMarkdownContainerNestingDepth + 1),
    ]) {
      expect(inspectMarkdownComplexity(markdown).failure, markdown.slice(0, 32)).toBeUndefined();
    }
  });

  it('rejects compact container amplification within the pre-AST timing envelope', () => {
    const cases = [
      '- '.repeat(19_999) + 'x',
      '* '.repeat(19_999) + 'x',
      '+ '.repeat(19_999) + 'x',
      '1. '.repeat(6_666) + 'x',
      '> + '.repeat(9_999) + 'x',
    ];

    for (const markdown of cases) {
      const startedAt = performance.now();
      const inspected = inspectMarkdownComplexity(markdown);
      const elapsedMilliseconds = performance.now() - startedAt;
      expect(inspected.failure).toContain('list and blockquote nesting');
      expect(elapsedMilliseconds).toBeLessThan(1_000);
    }
  });

  it('bounds cumulative container continuation work at the exact limit', () => {
    const prefix = `${'- '.repeat(OKF_SEMANTIC_LIMITS.maxMarkdownContainerNestingDepth)}x\n`;
    const continuation = `${'\t'.repeat(
      OKF_SEMANTIC_LIMITS.maxMarkdownContainerNestingDepth / 2,
    )}\n`;
    const exact = inspectMarkdownComplexity(`${prefix}${continuation.repeat(1_022)}`);
    expect(exact.failure).toBeUndefined();
    expect(exact.containerWorkUnits).toBe(
      OKF_SEMANTIC_LIMITS.maxMarkdownContainerWorkUnitsPerDocument,
    );

    const startedAt = performance.now();
    const exceeded = inspectMarkdownComplexity(`${prefix}${continuation.repeat(7_939)}`);
    const elapsedMilliseconds = performance.now() - startedAt;
    expect(exceeded.failure).toContain('continuation work');
    expect(exceeded.containerWorkUnits).toBe(
      OKF_SEMANTIC_LIMITS.maxMarkdownContainerWorkUnitsPerDocument + 1,
    );
    expect(elapsedMilliseconds).toBeLessThan(1_000);
  });

  it('keeps label nesting context-local and opaque CommonMark spans uncharged', () => {
    const nestedImages = (depth: number): string =>
      `${'!['.repeat(depth)}x${'](image.png)'.repeat(depth)}`;
    expect(
      inspectMarkdownComplexity(nestedImages(OKF_SEMANTIC_LIMITS.maxMarkdownMediaNestingDepth))
        .failure,
    ).toBeUndefined();
    expect(
      inspectMarkdownComplexity(nestedImages(OKF_SEMANTIC_LIMITS.maxMarkdownMediaNestingDepth + 1))
        .failure,
    ).toContain('link and image label nesting');

    expect(
      inspectMarkdownComplexity(
        '[unclosed paragraph\n\n'.repeat(OKF_SEMANTIC_LIMITS.maxMarkdownMediaNestingDepth + 1),
      ).failure,
    ).toBeUndefined();

    const brackets = '['.repeat(OKF_SEMANTIC_LIMITS.maxMarkdownMediaNestingDepth + 1);
    for (const markdown of [
      `\`${brackets}\``,
      `<span title="${brackets}">x</span>`,
      `<!-- ${brackets} -->`,
      `<![CDATA[${brackets}]]>`,
      `<?okf ${brackets}?>`,
      `<!OKF ${brackets}>`,
      `<xx:${brackets}>`,
      `[x](<${brackets}>)`,
      `[x](a${brackets})`,
      `[x](a "${brackets}")`,
      `\\\\\`${brackets}\``,
    ]) {
      expect(inspectMarkdownComplexity(markdown).failure, markdown.slice(0, 32)).toBeUndefined();
    }

    // A close bracket inside an opaque span must not reduce the surrounding label depth.
    for (const opaqueClose of ['<span title="]">', '`]`']) {
      expect(
        inspectMarkdownComplexity(
          `[${opaqueClose}${'['.repeat(OKF_SEMANTIC_LIMITS.maxMarkdownMediaNestingDepth)}x`,
        ).failure,
      ).toContain('link and image label nesting');
    }

    // A backtick consumed by another CommonMark construct must not make later labels look like
    // code, while an actually escaped opening backtick must leave later brackets visible.
    for (const prefix of ['<span title="`">x</span>', '[x](a`b)', '<xx:a`b>', '\\`']) {
      expect(
        inspectMarkdownComplexity(
          `${prefix}${'['.repeat(OKF_SEMANTIC_LIMITS.maxMarkdownMediaNestingDepth + 1)}x`,
        ).failure,
        prefix,
      ).toContain('link and image label nesting');
    }
  });

  it('rejects nested-label and unmatched-close amplification without quadratic scans', () => {
    const nestedDepth = 4_000;
    const nested = `${'!['.repeat(nestedDepth)}x${'](i)'.repeat(nestedDepth)}`;
    let startedAt = performance.now();
    expect(inspectMarkdownComplexity(nested).failure).toContain('link and image label nesting');
    expect(performance.now() - startedAt).toBeLessThan(1_000);

    startedAt = performance.now();
    expect(inspectMarkdownComplexity(']'.repeat(20_000)).failure).toContain(
      'link-label closing work',
    );
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it('charges prospective label-end backward scans at the exact work boundary', () => {
    // With no opener, CommonMark's stock label-end tokenizer scans every prior inline event.
    // Runs of 2,896, 68, and 12 unmatched closers contribute n * (n - 1) work units:
    // 8,383,920 + 4,556 + 132 = 8,388,608.
    const exact = [']'.repeat(2_896), ']'.repeat(68), ']'.repeat(12)].join('\n\n');
    const inspectedExact = inspectMarkdownComplexity(exact);
    expect(inspectedExact.failure).toBeUndefined();
    expect(inspectedExact.labelEndWorkUnits).toBe(
      OKF_SEMANTIC_LIMITS.maxMarkdownLabelEndWorkUnitsPerDocument,
    );

    const exceeded = inspectMarkdownComplexity(`${exact}]`);
    expect(exceeded.failure).toContain('link-label closing work');
    expect(exceeded.labelEndWorkUnits).toBe(
      OKF_SEMANTIC_LIMITS.maxMarkdownLabelEndWorkUnitsPerDocument + 1,
    );
  });

  it('rejects the multiline unmatched-label AST amplifier within the timing envelope', () => {
    const adversarial = `${']\n\ta'.repeat(19_999)}]`;
    const startedAt = performance.now();
    const inspected = inspectMarkdownComplexity(adversarial);
    const elapsedMilliseconds = performance.now() - startedAt;

    expect(inspected).toMatchObject({
      lines: OKF_SEMANTIC_LIMITS.maxMarkdownLines,
      syntaxCandidates: OKF_SEMANTIC_LIMITS.maxMarkdownSyntaxCandidates,
      labelEndWorkUnits: OKF_SEMANTIC_LIMITS.maxMarkdownLabelEndWorkUnitsPerDocument + 1,
    });
    expect(inspected.failure).toContain('link-label closing work');
    expect(elapsedMilliseconds).toBeLessThan(1_000);
  });

  it('enforces attention run and marker-code-unit boundaries in text contexts', () => {
    const exactRuns = inspectMarkdownComplexity(
      '*a '.repeat(OKF_SEMANTIC_LIMITS.maxMarkdownAttentionRunsPerDocument),
    );
    expect(exactRuns.failure).toBeUndefined();
    expect(
      inspectMarkdownComplexity(
        '*a '.repeat(OKF_SEMANTIC_LIMITS.maxMarkdownAttentionRunsPerDocument + 1),
      ).failure,
    ).toContain('run pre-parse safety limit');

    const markers = (count: number): string => `a${'*'.repeat(count)}b`;
    expect(
      inspectMarkdownComplexity(
        markers(OKF_SEMANTIC_LIMITS.maxMarkdownAttentionMarkerCodeUnitsPerDocument),
      ).failure,
    ).toBeUndefined();
    expect(
      inspectMarkdownComplexity(
        markers(OKF_SEMANTIC_LIMITS.maxMarkdownAttentionMarkerCodeUnitsPerDocument + 1),
      ).failure,
    ).toContain('marker-code-unit');

    const opaqueRun = '*'.repeat(
      OKF_SEMANTIC_LIMITS.maxMarkdownAttentionMarkerCodeUnitsPerDocument + 1,
    );
    for (const markdown of [
      `\`${opaqueRun}\``,
      `~~~md\n${opaqueRun}\n~~~\n`,
      `<span title="${opaqueRun}">x</span>`,
      '*'.repeat(10_000),
    ]) {
      expect(inspectMarkdownComplexity(markdown).failure, markdown.slice(0, 32)).toBeUndefined();
    }
  });

  it('rejects attention event-distance amplification before the core resolver', () => {
    const nestedRuns = 512;
    const escapedPairs = Math.floor(
      (OKF_SEMANTIC_LIMITS.maxMarkdownSyntaxCandidates - nestedRuns * 2) / 2,
    );
    const denseEvents = `${'*a '.repeat(nestedRuns)}${'\\!'.repeat(
      escapedPairs,
    )}${' a*'.repeat(nestedRuns)}`;
    let startedAt = performance.now();
    const eventExceeded = inspectMarkdownComplexity(denseEvents);
    let elapsedMilliseconds = performance.now() - startedAt;
    expect(eventExceeded.failure).toContain('emphasis resolution work');
    expect(eventExceeded.attentionWorkUnits).toBe(
      OKF_SEMANTIC_LIMITS.maxMarkdownAttentionWorkUnitsPerDocument + 1,
    );
    expect(elapsedMilliseconds).toBeLessThan(1_000);

    const distantLines = `${'*a '.repeat(64)}${'z\n'.repeat(19_999)}z${' a*'.repeat(64)}`;
    startedAt = performance.now();
    const lineExceeded = inspectMarkdownComplexity(distantLines);
    elapsedMilliseconds = performance.now() - startedAt;
    expect(lineExceeded.failure).toContain('emphasis resolution work');
    expect(lineExceeded.attentionWorkUnits).toBe(
      OKF_SEMANTIC_LIMITS.maxMarkdownAttentionWorkUnitsPerDocument + 1,
    );
    expect(elapsedMilliseconds).toBeLessThan(1_000);
  });
});
