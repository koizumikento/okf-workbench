import { parse, postprocess, preprocess } from 'micromark';
import {
  attention,
  blockQuote,
  labelEnd,
  labelStartImage,
  labelStartLink,
  list,
} from 'micromark-core-commonmark';
import { decodeString } from 'micromark-util-decode-string';
import { subtokenize } from 'micromark-util-subtokenize';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import type { SourceRange } from '../model/index.js';
import { OKF_SEMANTIC_LIMITS } from '../model/resource-limits.js';
import type { SourceRangeIndex } from './source-range.js';

export interface MarkdownLinkCandidate {
  readonly rawTarget: string;
  readonly label: string;
  readonly range: SourceRange;
}

export interface MarkdownHeadingCandidate {
  readonly depth: number;
  readonly text: string;
  readonly range: SourceRange;
}

export type MarkdownLinkResult =
  | {
      readonly ok: true;
      readonly links: readonly MarkdownLinkCandidate[];
      readonly retainedTextUnits: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'parse' | 'resource-limit';
      readonly message: string;
      readonly range: SourceRange;
    };

export type MarkdownHeadingResult =
  | { readonly ok: true; readonly headings: readonly MarkdownHeadingCandidate[] }
  | { readonly ok: false; readonly message: string; readonly range: SourceRange };

/**
 * Counts actual CommonMark fenced code blocks under an actual top-level heading.
 *
 * Parsing the block structure first prevents headings written inside code samples from opening a
 * section and excludes indented code blocks from the v0.2 inline-computation form.
 */
export function countFencedCodeBlocksInTopLevelSection(
  markdown: string,
  headingText: string,
): number {
  const inspection = inspectMarkdownComplexity(markdown);
  if (inspection.failure !== undefined) return 0;
  const root = parseMarkdownAst(markdown, inspection.lines);
  const children = root.children ?? [];
  let inSection = false;
  let count = 0;
  for (const child of children) {
    if (child.type === 'heading' && child.depth === 1) {
      inSection = readableText(child).trim() === headingText;
      continue;
    }
    if (!inSection) continue;
    visit(child, (node) => {
      if (node.type !== 'code') return;
      const start = node.position?.start.offset;
      if (start === undefined) return;
      const openingLine = markdown.slice(start).split(/\r\n?|\n/u, 1)[0] ?? '';
      if (/^ {0,3}(?:`{3,}|~{3,})/u.test(openingLine)) {
        count += 1;
      }
    });
  }
  return count;
}

interface AstPoint {
  readonly offset?: number;
}

interface AstPosition {
  readonly start: AstPoint;
  readonly end: AstPoint;
}

interface AstNode {
  readonly type: string;
  readonly position?: AstPosition;
  readonly children?: readonly AstNode[];
  readonly value?: unknown;
  readonly alt?: unknown;
  readonly url?: unknown;
  readonly identifier?: unknown;
  readonly depth?: unknown;
}

interface SemanticLabelCollector {
  readonly chunks: string[];
  readonly end: number;
  excludedDepth: number;
  htmlTextDepth: number;
  readonly kind: 'image' | 'link';
  nestedImageDepth: number;
  skipNextLineEnding: boolean;
  readonly start: number;
}

type MicromarkTokenizer = typeof labelStartImage.tokenize;
type MicromarkTokenizeContext = ThisParameterType<MicromarkTokenizer>;
type MicromarkEffects = Parameters<MicromarkTokenizer>[0];
type MicromarkState = Parameters<MicromarkTokenizer>[1];
type MicromarkCode = Parameters<MicromarkState>[0];
type MicromarkToken = ReturnType<MicromarkEffects['enter']>;

class MarkdownWorkLimitError extends Error {}

const trustedMarkdownInspections = new WeakSet<MarkdownComplexityInspection>();

export function extractMarkdownLinks(
  markdown: string,
  bodyStart: number,
  ranges: SourceRangeIndex,
  preinspection?: MarkdownComplexityInspection,
): MarkdownLinkResult {
  const inspection =
    preinspection !== undefined &&
    trustedMarkdownInspections.has(preinspection) &&
    preinspection.inspectedSource === markdown
      ? preinspection
      : inspectMarkdownComplexity(markdown);
  if (inspection.failure !== undefined) {
    return {
      ok: false,
      reason: 'resource-limit',
      message: inspection.failure,
      range: ranges.range(bodyStart, bodyStart + markdown.length),
    };
  }
  try {
    const root = parseMarkdownAst(markdown, inspection.lines);
    const definitions = new Map<string, string>();
    let definitionsExceeded = false;
    let retainedTextFailure: string | undefined;

    visit(root, (node) => {
      if (
        node.type !== 'definition' ||
        typeof node.identifier !== 'string' ||
        typeof node.url !== 'string'
      ) {
        return;
      }
      const identifier = normalizeIdentifier(node.identifier);
      retainedTextFailure ??= boundedLinkTextFailure(
        node.url,
        OKF_SEMANTIC_LIMITS.maxLinkTargetCodeUnits,
        OKF_SEMANTIC_LIMITS.maxLinkTargetBytes,
        'link target',
      );
      if (retainedTextFailure !== undefined) {
        return;
      }
      if (!definitions.has(identifier)) {
        if (definitions.size >= OKF_SEMANTIC_LIMITS.maxMarkdownDefinitionsPerDocument) {
          definitionsExceeded = true;
          return;
        }
        definitions.set(identifier, node.url);
      }
    });
    if (retainedTextFailure !== undefined) {
      return {
        ok: false,
        reason: 'resource-limit',
        message: retainedTextFailure,
        range: ranges.range(bodyStart, bodyStart + markdown.length),
      };
    }
    if (definitionsExceeded) {
      return {
        ok: false,
        reason: 'resource-limit',
        message: `Markdown contains more than ${String(OKF_SEMANTIC_LIMITS.maxMarkdownDefinitionsPerDocument)} link definitions, exceeding the per-document safety limit. Reduce or split the document, then retry.`,
        range: ranges.range(bodyStart, bodyStart + markdown.length),
      };
    }

    const links: MarkdownLinkCandidate[] = [];
    let linksExceeded = false;
    let retainedTextUnits = 0;
    visit(root, (node) => {
      let rawTarget: string | undefined;
      if (node.type === 'link' && typeof node.url === 'string') {
        rawTarget = node.url;
      } else if (node.type === 'linkReference' && typeof node.identifier === 'string') {
        rawTarget = definitions.get(normalizeIdentifier(node.identifier));
      }
      if (rawTarget === undefined) {
        return;
      }
      retainedTextFailure ??= boundedLinkTextFailure(
        rawTarget,
        OKF_SEMANTIC_LIMITS.maxLinkTargetCodeUnits,
        OKF_SEMANTIC_LIMITS.maxLinkTargetBytes,
        'link target',
      );
      if (retainedTextFailure !== undefined) {
        return;
      }

      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) {
        return;
      }
      if (links.length >= OKF_SEMANTIC_LIMITS.maxMarkdownLinksPerDocument) {
        linksExceeded = true;
        return;
      }
      const label = readableText(node).trim();
      retainedTextFailure ??= boundedLinkTextFailure(
        label,
        OKF_SEMANTIC_LIMITS.maxLinkLabelCodeUnits,
        OKF_SEMANTIC_LIMITS.maxLinkLabelBytes,
        'link label',
      );
      if (retainedTextFailure !== undefined) {
        return;
      }
      const additionalTextUnits = utf8ByteLength(rawTarget) + utf8ByteLength(label);
      if (
        retainedTextUnits >
        OKF_SEMANTIC_LIMITS.maxLinkTextUnitsPerDocument - additionalTextUnits
      ) {
        retainedTextFailure = `Retained Markdown link targets and labels exceed the ${String(OKF_SEMANTIC_LIMITS.maxLinkTextUnitsPerDocument)}-unit per-document safety limit. Reduce or split the document, then retry.`;
        return;
      }
      retainedTextUnits += additionalTextUnits;
      links.push({
        rawTarget,
        label,
        range: ranges.range(bodyStart + start, bodyStart + end),
      });
    });
    if (retainedTextFailure !== undefined) {
      return {
        ok: false,
        reason: 'resource-limit',
        message: retainedTextFailure,
        range: ranges.range(bodyStart, bodyStart + markdown.length),
      };
    }
    if (linksExceeded) {
      return {
        ok: false,
        reason: 'resource-limit',
        message: `Markdown contains more than ${String(OKF_SEMANTIC_LIMITS.maxMarkdownLinksPerDocument)} links, exceeding the per-document safety limit. Reduce or split the document, then retry.`,
        range: ranges.range(bodyStart, bodyStart + markdown.length),
      };
    }

    links.sort(
      (left, right) =>
        left.range.start.offset - right.range.start.offset ||
        compareStrings(left.rawTarget, right.rawTarget) ||
        compareStrings(left.label, right.label),
    );
    return { ok: true, links, retainedTextUnits };
  } catch (error: unknown) {
    return {
      ok: false,
      reason: error instanceof MarkdownWorkLimitError ? 'resource-limit' : 'parse',
      message: error instanceof Error ? error.message : 'unknown Markdown parser failure',
      range: ranges.range(bodyStart, bodyStart + markdown.length),
    };
  }
}

/** Extract CommonMark headings, including Setext headings, using the same parser as links. */
export function extractMarkdownHeadings(
  markdown: string,
  bodyStart: number,
  ranges: SourceRangeIndex,
): MarkdownHeadingResult {
  const inspection = inspectMarkdownComplexity(markdown);
  if (inspection.failure !== undefined) {
    return {
      ok: false,
      message: inspection.failure,
      range: ranges.range(bodyStart, bodyStart + markdown.length),
    };
  }
  try {
    const root = parseMarkdownAst(markdown, inspection.lines);
    const headings: MarkdownHeadingCandidate[] = [];

    visit(root, (node) => {
      if (
        node.type !== 'heading' ||
        typeof node.depth !== 'number' ||
        !Number.isInteger(node.depth) ||
        node.depth < 1 ||
        node.depth > 6
      ) {
        return;
      }
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) {
        return;
      }
      headings.push({
        depth: node.depth,
        text: readableText(node).trim(),
        range: ranges.range(bodyStart + start, bodyStart + end),
      });
    });

    headings.sort(
      (left, right) =>
        left.range.start.offset - right.range.start.offset ||
        left.depth - right.depth ||
        compareStrings(left.text, right.text),
    );
    return { ok: true, headings };
  } catch (error: unknown) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'unknown Markdown parser failure',
      range: ranges.range(bodyStart, bodyStart + markdown.length),
    };
  }
}

export interface MarkdownComplexityInspection {
  readonly attentionWorkUnits: number;
  readonly containerWorkUnits: number;
  readonly failure?: string;
  /** Exact source inspected, used to avoid repeating the event tokenizer before the same AST. */
  readonly inspectedSource: string;
  readonly labelEndWorkUnits: number;
  readonly lines: number;
  readonly linkCandidates: number;
  readonly sourceCodeUnits: number;
  readonly syntaxCandidates: number;
}

/**
 * Builds mdast with the same bounded CommonMark constructs used by preinspection.
 *
 * `remark-parse` reads `micromarkExtensions` from processor data. A fresh extension is required
 * for each document because its work counters and opener stack are parse-local.
 */
function parseMarkdownAst(markdown: string, lines: number): AstNode {
  const extension = createMarkdownWorkGuardExtension(
    markdown,
    lines,
    { resolutionWorkUnits: 0, runs: 0 },
    { units: 0 },
    { units: 0 },
  );
  return unified()
    .data('micromarkExtensions', [extension])
    .use(remarkParse)
    .parse(markdown) as AstNode;
}

/** Inspects compact parser-amplification inputs before remark materializes an AST. */
export function inspectMarkdownComplexity(markdown: string): MarkdownComplexityInspection {
  let lines = markdown.length === 0 ? 0 : 1;
  let syntaxCandidates = 0;
  for (let index = 0; index < markdown.length; index += 1) {
    const code = markdown.charCodeAt(index);
    if (code === 0x0a || (code === 0x0d && markdown.charCodeAt(index + 1) !== 0x0a)) {
      if (index + 1 < markdown.length) {
        lines += 1;
      }
    }

    // Conservatively count all ASCII punctuation/control triggers rather than
    // trying to predict every CommonMark tokenizer amplification pattern.
    if (
      (code > 0 && code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      (code >= 0x21 && code <= 0x2f) ||
      (code >= 0x3a && code <= 0x40) ||
      (code >= 0x5b && code <= 0x60) ||
      (code >= 0x7b && code <= 0x7e)
    ) {
      syntaxCandidates += 1;
    }
  }

  const attentionWork = { resolutionWorkUnits: 0, runs: 0 };
  const containerWork = { units: 0 };
  const labelEndWork = { units: 0 };
  const attentionWorkUnits = (): number =>
    Math.max(attentionWork.runs * lines, attentionWork.resolutionWorkUnits);
  const failed = (failure: string, linkCandidates = 0): MarkdownComplexityInspection =>
    trustMarkdownInspection({
      attentionWorkUnits: attentionWorkUnits(),
      containerWorkUnits: containerWork.units,
      failure,
      inspectedSource: markdown,
      labelEndWorkUnits: labelEndWork.units,
      lines,
      linkCandidates,
      sourceCodeUnits: markdown.length,
      syntaxCandidates,
    });
  if (markdown.length > OKF_SEMANTIC_LIMITS.maxMarkdownBodyCodeUnits) {
    return failed(
      `Markdown body exceeds the ${String(OKF_SEMANTIC_LIMITS.maxMarkdownBodyCodeUnits)}-code-unit pre-parse safety limit. Reduce or split the document, then retry.`,
    );
  }
  const byteLength = utf8ByteLength(markdown);
  if (byteLength > OKF_SEMANTIC_LIMITS.maxMarkdownBodyBytes) {
    return failed(
      `Markdown body exceeds the ${String(OKF_SEMANTIC_LIMITS.maxMarkdownBodyBytes)}-byte pre-parse safety limit. Reduce or split the document, then retry.`,
    );
  }
  if (lines > OKF_SEMANTIC_LIMITS.maxMarkdownLines) {
    return failed(
      `Markdown body exceeds the ${String(OKF_SEMANTIC_LIMITS.maxMarkdownLines)}-line pre-parse safety limit. Reduce or split the document, then retry.`,
    );
  }
  if (syntaxCandidates > OKF_SEMANTIC_LIMITS.maxMarkdownSyntaxCandidates) {
    return failed(
      `Markdown body exceeds the ${String(OKF_SEMANTIC_LIMITS.maxMarkdownSyntaxCandidates)}-token pre-parse complexity limit. Reduce or split the document, then retry.`,
    );
  }

  // micromark's public event pipeline applies CommonMark tokenization without constructing an
  // mdast tree. Using its grammar here keeps brackets in code/HTML, escaped delimiters, multiline
  // destinations, block containers, and shortcut references out of a second handwritten parser.
  let events: ReturnType<typeof postprocess>;
  try {
    const eventParser = parse({
      extensions: [
        createMarkdownWorkGuardExtension(
          markdown,
          lines,
          attentionWork,
          containerWork,
          labelEndWork,
        ),
      ],
    });
    removeShadowedCoreConstructs(eventParser);
    events = eventParser.document().write(preprocess()(markdown, 'utf8', true));
    // Expand just the flow layer so actual list/blockquote nesting is bounded before inline
    // resolution and mdast construction. The extension above also aborts same-line container
    // amplification while the document tokenizer is still running.
    subtokenize(events);
    const containerFailure = markdownContainerNestingFailure(events);
    if (containerFailure !== undefined) {
      return failed(containerFailure);
    }
    events = postprocess(events);
  } catch (error: unknown) {
    if (error instanceof MarkdownWorkLimitError) {
      return failed(error.message);
    }
    return failed(
      'Markdown could not be inspected safely before AST parsing. Reduce or split the document, then retry.',
    );
  }

  let linkSyntaxCandidates = 0;
  let definitionSyntaxCandidates = 0;
  const mediaStack: Array<'image' | 'link'> = [];
  const labelCollectors: SemanticLabelCollector[] = [];
  let labelTrackingDisabled = false;
  let eventFailure: string | undefined;
  const totalLinkCandidates = (): number => linkSyntaxCandidates + definitionSyntaxCandidates;
  for (const [eventKind, token, context] of events) {
    if (eventKind === 'exit') {
      if (token.type === 'labelText') {
        for (let index = labelCollectors.length - 1; index >= 0; index -= 1) {
          const collector = labelCollectors[index];
          if (collector?.start === token.start.offset && collector.end === token.end.offset) {
            labelCollectors.splice(index, 1);
            const labelFailure = boundedMarkdownValueFailure(
              collector.chunks.join('').trim(),
              OKF_SEMANTIC_LIMITS.maxLinkLabelCodeUnits,
              OKF_SEMANTIC_LIMITS.maxLinkLabelBytes,
              'link label',
            );
            if (labelFailure !== undefined) {
              eventFailure ??= labelFailure;
            }
            break;
          }
        }
      } else if (token.type === 'resource' || token.type === 'reference') {
        for (const collector of labelCollectors) {
          if (collector.excludedDepth > 0) {
            collector.excludedDepth -= 1;
          }
        }
      } else if (token.type === 'htmlText') {
        for (const collector of labelCollectors) {
          if (collector.htmlTextDepth > 0) {
            collector.htmlTextDepth -= 1;
          }
        }
      }
      if (token.type === 'link' || token.type === 'image') {
        if (token.type === 'image') {
          for (const collector of labelCollectors) {
            if (collector.nestedImageDepth > 0) {
              collector.nestedImageDepth -= 1;
            }
          }
        }
        mediaStack.pop();
      }
      continue;
    }

    if (token.type === 'link' || token.type === 'image') {
      linkSyntaxCandidates += 1;
      if (linkSyntaxCandidates > OKF_SEMANTIC_LIMITS.maxMarkdownLinksPerDocument) {
        eventFailure ??= `Markdown contains more than ${String(OKF_SEMANTIC_LIMITS.maxMarkdownLinksPerDocument)} links and images, exceeding the pre-parse safety limit. Reduce or split the document, then retry.`;
      }
      if (mediaStack.length >= OKF_SEMANTIC_LIMITS.maxMarkdownMediaNestingDepth) {
        eventFailure ??= `Markdown link and image nesting exceeds the ${String(OKF_SEMANTIC_LIMITS.maxMarkdownMediaNestingDepth)}-level pre-parse safety limit. Reduce nesting, then retry.`;
        labelTrackingDisabled = true;
        labelCollectors.length = 0;
      } else if (!labelTrackingDisabled && token.type === 'image') {
        for (const collector of labelCollectors) {
          collector.nestedImageDepth += 1;
        }
      }
      mediaStack.push(token.type);
    } else if (token.type === 'definition') {
      definitionSyntaxCandidates += 1;
      if (definitionSyntaxCandidates > OKF_SEMANTIC_LIMITS.maxMarkdownDefinitionsPerDocument) {
        eventFailure ??= `Markdown contains more than ${String(OKF_SEMANTIC_LIMITS.maxMarkdownDefinitionsPerDocument)} link definitions, exceeding the pre-parse safety limit. Reduce or split the document, then retry.`;
      }
    } else if (token.type === 'autolink') {
      linkSyntaxCandidates += 1;
      if (linkSyntaxCandidates > OKF_SEMANTIC_LIMITS.maxMarkdownLinksPerDocument) {
        eventFailure ??= `Markdown contains more than ${String(OKF_SEMANTIC_LIMITS.maxMarkdownLinksPerDocument)} links and images, exceeding the pre-parse safety limit. Reduce or split the document, then retry.`;
      }
    }

    const activeMedia = mediaStack.at(-1);
    if (
      !labelTrackingDisabled &&
      token.type === 'labelText' &&
      (activeMedia === 'link' || activeMedia === 'image')
    ) {
      const kind = activeMedia;
      const start = token.start.offset;
      const end = token.end.offset;
      if (
        start === undefined ||
        end === undefined ||
        start < 0 ||
        end < start ||
        end > markdown.length
      ) {
        eventFailure ??=
          'Markdown link or image label could not be bounded safely before AST parsing. Reduce or split the document, then retry.';
      } else {
        labelCollectors.push({
          chunks: [],
          end,
          excludedDepth: 0,
          htmlTextDepth: 0,
          kind,
          nestedImageDepth: 0,
          skipNextLineEnding: false,
          start,
        });
      }
    } else if (token.type === 'resource' || token.type === 'reference') {
      for (const collector of labelCollectors) {
        collector.excludedDepth += 1;
      }
    } else {
      const start = token.start.offset;
      const end = token.end.offset;
      const isTextToken =
        token.type === 'data' ||
        token.type === 'codeTextData' ||
        token.type === 'characterEscape' ||
        token.type === 'characterReference';
      let serializedText: string | undefined;
      if (isTextToken) {
        if (
          start === undefined ||
          end === undefined ||
          start < 0 ||
          end < start ||
          end > markdown.length
        ) {
          eventFailure ??=
            'Markdown link or image label text could not be bounded safely before AST parsing. Reduce or split the document, then retry.';
        } else {
          const source = context.sliceSerialize(token);
          serializedText =
            token.type === 'characterEscape' || token.type === 'characterReference'
              ? decodeString(source)
              : source;
        }
      }
      for (const collector of labelCollectors) {
        if (collector.excludedDepth > 0) {
          continue;
        }
        const usesImageAltSemantics = collector.kind === 'image' || collector.nestedImageDepth > 0;
        if (serializedText !== undefined) {
          collector.chunks.push(serializedText);
        } else if (token.type === 'autolinkProtocol' || token.type === 'autolinkEmail') {
          collector.chunks.push(context.sliceSerialize(token));
        } else if (token.type === 'htmlText') {
          collector.htmlTextDepth += 1;
        } else if (
          token.type === 'htmlTextData' &&
          collector.htmlTextDepth > 0 &&
          usesImageAltSemantics
        ) {
          collector.chunks.push(context.sliceSerialize(token));
        } else if (token.type === 'hardBreakEscape' || token.type === 'hardBreakTrailing') {
          if (!usesImageAltSemantics) {
            collector.chunks.push(' ');
          }
          collector.skipNextLineEnding = true;
        } else if (token.type === 'lineEnding') {
          if (collector.skipNextLineEnding) {
            collector.skipNextLineEnding = false;
          } else if (collector.htmlTextDepth === 0 || usesImageAltSemantics) {
            collector.chunks.push(context.sliceSerialize(token));
          }
        }
      }
    }

    let spanFailure: string | undefined;
    if (token.type === 'resourceDestinationString' && mediaStack.at(-1) !== undefined) {
      spanFailure = boundedMarkdownSerializedTokenFailure(
        context.sliceSerialize(token),
        OKF_SEMANTIC_LIMITS.maxLinkTargetCodeUnits,
        OKF_SEMANTIC_LIMITS.maxLinkTargetBytes,
        'link target',
      );
    } else if (token.type === 'referenceString' && mediaStack.at(-1) !== undefined) {
      spanFailure = boundedMarkdownSerializedTokenFailure(
        context.sliceSerialize(token),
        OKF_SEMANTIC_LIMITS.maxLinkLabelCodeUnits,
        OKF_SEMANTIC_LIMITS.maxLinkLabelBytes,
        'link label',
      );
    } else if (token.type === 'definitionLabelString') {
      spanFailure = boundedMarkdownSerializedTokenFailure(
        context.sliceSerialize(token),
        OKF_SEMANTIC_LIMITS.maxLinkLabelCodeUnits,
        OKF_SEMANTIC_LIMITS.maxLinkLabelBytes,
        'link label',
      );
    } else if (token.type === 'definitionDestinationString') {
      spanFailure = boundedMarkdownSerializedTokenFailure(
        context.sliceSerialize(token),
        OKF_SEMANTIC_LIMITS.maxLinkTargetCodeUnits,
        OKF_SEMANTIC_LIMITS.maxLinkTargetBytes,
        'link target',
      );
    } else if (token.type === 'autolinkProtocol' || token.type === 'autolinkEmail') {
      spanFailure =
        boundedMarkdownSerializedTokenFailure(
          context.sliceSerialize(token),
          OKF_SEMANTIC_LIMITS.maxLinkLabelCodeUnits,
          OKF_SEMANTIC_LIMITS.maxLinkLabelBytes,
          'link label',
          0,
          0,
          false,
        ) ??
        boundedMarkdownSerializedTokenFailure(
          context.sliceSerialize(token),
          OKF_SEMANTIC_LIMITS.maxLinkTargetCodeUnits,
          OKF_SEMANTIC_LIMITS.maxLinkTargetBytes,
          'link target',
          token.type === 'autolinkEmail' ? 'mailto:'.length : 0,
          token.type === 'autolinkEmail' ? 'mailto:'.length : 0,
          false,
        );
    }
    if (spanFailure !== undefined) {
      eventFailure ??= spanFailure;
    }
  }

  if (eventFailure !== undefined) {
    return failed(eventFailure, totalLinkCandidates());
  }
  return trustMarkdownInspection({
    attentionWorkUnits: attentionWorkUnits(),
    containerWorkUnits: containerWork.units,
    inspectedSource: markdown,
    labelEndWorkUnits: labelEndWork.units,
    lines,
    linkCandidates: totalLinkCandidates(),
    sourceCodeUnits: markdown.length,
    syntaxCandidates,
  });
}

function createMarkdownWorkGuardExtension(
  markdown: string,
  lines: number,
  attentionWork: { resolutionWorkUnits: number; runs: number },
  containerWork: { units: number },
  labelEndWork: { units: number },
) {
  interface ContainerLineState {
    continuedDepth: number;
    lastDepth: number;
    lastOffset: number;
    line: number;
  }

  interface LabelNestingState {
    readonly openers: Array<{
      readonly eventIndex: number;
      readonly token: MicromarkToken;
    }>;
  }

  const containerDepths = new WeakMap<object, number>();
  const containerLineStates = new WeakMap<MicromarkTokenizeContext, ContainerLineState>();
  const labelNestingStates = new WeakMap<MicromarkTokenizeContext, LabelNestingState>();
  const attentionOffsets = new Set<number>();
  let attentionMarkerCodeUnits = 0;

  const labelNestingMessage = (): string =>
    `Markdown link and image label nesting exceeds the ${String(OKF_SEMANTIC_LIMITS.maxMarkdownMediaNestingDepth)}-level pre-parse safety limit. Reduce nesting, then retry.`;
  const containerNestingMessage = (): string =>
    `Markdown list and blockquote nesting exceeds the ${String(OKF_SEMANTIC_LIMITS.maxMarkdownContainerNestingDepth)}-level pre-parse safety limit. Reduce nesting, then retry.`;
  const attentionRunsMessage = (): string =>
    `Markdown emphasis delimiter work exceeds the ${String(OKF_SEMANTIC_LIMITS.maxMarkdownAttentionRunsPerDocument)}-run pre-parse safety limit. Reduce or split the document, then retry.`;
  const attentionMarkersMessage = (): string =>
    `Markdown emphasis delimiter work exceeds the ${String(OKF_SEMANTIC_LIMITS.maxMarkdownAttentionMarkerCodeUnitsPerDocument)}-marker-code-unit pre-parse safety limit. Reduce or split the document, then retry.`;
  const attentionResolutionMessage = (): string =>
    `Markdown emphasis resolution work exceeds the ${String(OKF_SEMANTIC_LIMITS.maxMarkdownAttentionWorkUnitsPerDocument)}-unit per-document pre-parse safety limit. Reduce or split the document, then retry.`;
  const containerWorkMessage = (): string =>
    `Markdown list and blockquote continuation work exceeds the ${String(OKF_SEMANTIC_LIMITS.maxMarkdownContainerWorkUnitsPerDocument)}-unit per-document pre-parse safety limit. Reduce or split the document, then retry.`;
  const labelEndWorkMessage = (): string =>
    `Markdown link-label closing work exceeds the ${String(OKF_SEMANTIC_LIMITS.maxMarkdownLabelEndWorkUnitsPerDocument)}-unit per-document pre-parse safety limit. Reduce or split the document, then retry.`;

  const chargeContainerWork = (): void => {
    containerWork.units += 1;
    if (containerWork.units > OKF_SEMANTIC_LIMITS.maxMarkdownContainerWorkUnitsPerDocument) {
      containerWork.units = OKF_SEMANTIC_LIMITS.maxMarkdownContainerWorkUnitsPerDocument + 1;
      throw new MarkdownWorkLimitError(containerWorkMessage());
    }
  };

  const chargeLabelEndWork = (units: number): void => {
    if (units > OKF_SEMANTIC_LIMITS.maxMarkdownLabelEndWorkUnitsPerDocument - labelEndWork.units) {
      labelEndWork.units = OKF_SEMANTIC_LIMITS.maxMarkdownLabelEndWorkUnitsPerDocument + 1;
      throw new MarkdownWorkLimitError(labelEndWorkMessage());
    }
    labelEndWork.units += units;
  };

  const containerLineState = (context: MicromarkTokenizeContext): ContainerLineState => {
    const line = context.now().line;
    let state = containerLineStates.get(context);
    if (state === undefined) {
      state = { continuedDepth: 0, lastDepth: 0, lastOffset: -1, line };
      containerLineStates.set(context, state);
    } else if (state.line !== line) {
      state.continuedDepth = 0;
      state.lastDepth = 0;
      state.lastOffset = -1;
      state.line = line;
    }
    return state;
  };

  const wrapContainer = <ContainerConstruct extends typeof list>(
    construct: ContainerConstruct,
  ): ContainerConstruct => {
    const continuation = construct.continuation;
    if (continuation === undefined) {
      throw new Error('micromark container continuation invariant failed');
    }
    return {
      ...construct,
      add: 'before' as const,
      name: `okf${construct.name ?? 'Container'}Guard`,
      continuation: {
        ...continuation,
        tokenize(
          this: MicromarkTokenizeContext,
          effects: MicromarkEffects,
          ok: MicromarkState,
          nok: MicromarkState,
        ) {
          chargeContainerWork();
          return continuation.tokenize.call(
            this,
            effects,
            (code) => {
              const lineState = containerLineState(this);
              const state = this.containerState;
              const depth = state === undefined ? undefined : containerDepths.get(state);
              if (depth !== undefined) {
                lineState.continuedDepth = Math.max(lineState.continuedDepth, depth);
              }
              return ok(code);
            },
            nok,
          );
        },
      },
      tokenize(
        this: MicromarkTokenizeContext,
        effects: MicromarkEffects,
        ok: MicromarkState,
        nok: MicromarkState,
      ) {
        chargeContainerWork();
        return construct.tokenize.call(
          this,
          effects,
          (code) => {
            const lineState = containerLineState(this);
            const offset = this.now().offset;
            if (lineState.lastOffset !== offset) {
              lineState.lastOffset = offset;
              lineState.lastDepth = lineState.continuedDepth + 1;
              if (lineState.lastDepth > OKF_SEMANTIC_LIMITS.maxMarkdownContainerNestingDepth) {
                throw new MarkdownWorkLimitError(containerNestingMessage());
              }
            }
            const state = this.containerState;
            if (state !== undefined) {
              // The document tokenizer first checks and then attempts the same container with
              // distinct state objects. Reusing the successful end offset gives both the exact
              // same depth without charging the container twice.
              containerDepths.set(state, lineState.lastDepth);
            }
            lineState.continuedDepth = Math.max(lineState.continuedDepth, lineState.lastDepth);
            return ok(code);
          },
          nok,
        );
      },
    } as ContainerConstruct;
  };

  const labelNestingState = (context: MicromarkTokenizeContext): LabelNestingState => {
    let state = labelNestingStates.get(context);
    if (state === undefined) {
      state = { openers: [] };
      labelNestingStates.set(context, state);
    }
    return state;
  };

  const wrapLabelStart = (
    construct: typeof labelStartImage,
    tokenType: 'labelImage' | 'labelLink',
  ): typeof labelStartImage => ({
    ...construct,
    add: 'before' as const,
    name: `okf${construct.name ?? 'LabelStart'}Guard`,
    tokenize(
      this: MicromarkTokenizeContext,
      effects: MicromarkEffects,
      ok: MicromarkState,
      nok: MicromarkState,
    ) {
      let opener:
        | {
            readonly eventIndex: number;
            readonly token: MicromarkToken;
          }
        | undefined;
      const guardedEffects: MicromarkEffects = {
        ...effects,
        enter: (type, fields) => {
          const token = effects.enter(type, fields);
          if (type === tokenType) {
            opener = { eventIndex: this.events.length - 1, token };
          }
          return token;
        },
      };
      return construct.tokenize.call(
        this,
        guardedEffects,
        (code) => {
          if (opener === undefined) {
            throw new Error('micromark label opener tracking invariant failed');
          }
          const state = labelNestingState(this);
          state.openers.push(opener);
          if (state.openers.length > OKF_SEMANTIC_LIMITS.maxMarkdownMediaNestingDepth) {
            throw new MarkdownWorkLimitError(labelNestingMessage());
          }
          return ok(code);
        },
        nok,
      );
    },
  });

  const guardedLabelEnd = {
    add: 'before' as const,
    name: 'okfLabelEndGuard',
    resolveAll: labelEnd.resolveAll,
    tokenize(this: MicromarkTokenizeContext, effects: MicromarkEffects, ok: MicromarkState) {
      const state = labelNestingState(this);
      const opener = state.openers.at(-1);
      chargeLabelEndWork(this.events.length - (opener === undefined ? 0 : opener.eventIndex));

      const consumeAsData: MicromarkState = (code) => {
        if (code === null) {
          throw new Error('micromark label-end data fallback invariant failed');
        }
        effects.enter('data');
        effects.consume(code);
        effects.exit('data');
        return ok;
      };
      if (opener === undefined) {
        return consumeAsData;
      }
      let removed = false;
      const removeOpener = (): void => {
        if (removed) {
          return;
        }
        const index = state.openers.lastIndexOf(opener);
        if (index >= 0) {
          state.openers.splice(index, 1);
        }
        removed = true;
      };

      // Run the CommonMark construct as a nested attempt so a failed resource/reference rolls
      // back before `]` is emitted as ordinary data. The outer wrapper always succeeds, which
      // prevents the configured built-in `labelEnd` from repeating the same backward scan.
      return effects.attempt(
        labelEnd,
        (code) => {
          removeOpener();
          return ok(code);
        },
        (code) => {
          removeOpener();
          return consumeAsData(code);
        },
      );
    },
  };

  const chargeAttentionRun = (context: MicromarkTokenizeContext, code: MicromarkCode): void => {
    const offset = context.now().offset;
    if (attentionOffsets.has(offset) || code === null) {
      return;
    }
    attentionOffsets.add(offset);
    attentionWork.runs += 1;
    if (attentionWork.runs > OKF_SEMANTIC_LIMITS.maxMarkdownAttentionRunsPerDocument) {
      throw new MarkdownWorkLimitError(attentionRunsMessage());
    }
    if (attentionWork.runs * lines > OKF_SEMANTIC_LIMITS.maxMarkdownAttentionWorkUnitsPerDocument) {
      attentionWork.resolutionWorkUnits =
        OKF_SEMANTIC_LIMITS.maxMarkdownAttentionWorkUnitsPerDocument + 1;
      throw new MarkdownWorkLimitError(attentionResolutionMessage());
    }

    let index = offset;
    while (markdown.charCodeAt(index) === code) {
      attentionMarkerCodeUnits += 1;
      if (
        attentionMarkerCodeUnits >
        OKF_SEMANTIC_LIMITS.maxMarkdownAttentionMarkerCodeUnitsPerDocument
      ) {
        throw new MarkdownWorkLimitError(attentionMarkersMessage());
      }
      index += 1;
    }
  };

  const chargeAttentionResolution = (events: ReturnType<typeof postprocess>): void => {
    let sequences = 0;
    for (const [eventKind, token] of events) {
      if (eventKind === 'enter' && token.type === 'attentionSequence') {
        sequences += 1;
      }
    }
    if (sequences === 0) {
      return;
    }
    const remaining =
      OKF_SEMANTIC_LIMITS.maxMarkdownAttentionWorkUnitsPerDocument -
      attentionWork.resolutionWorkUnits;
    if (events.length > Math.floor(remaining / sequences)) {
      attentionWork.resolutionWorkUnits =
        OKF_SEMANTIC_LIMITS.maxMarkdownAttentionWorkUnitsPerDocument + 1;
      throw new MarkdownWorkLimitError(attentionResolutionMessage());
    }
    attentionWork.resolutionWorkUnits += sequences * events.length;
  };

  const guardedAttention = {
    ...attention,
    add: 'before' as const,
    name: 'okfAttentionGuard',
    resolveAll(
      events: ReturnType<typeof postprocess>,
      context: MicromarkTokenizeContext,
    ): ReturnType<typeof postprocess> {
      chargeAttentionResolution(events);
      if (attention.resolveAll === undefined) {
        throw new Error('micromark attention resolver invariant failed');
      }
      return attention.resolveAll(events, context);
    },
    tokenize(
      this: MicromarkTokenizeContext,
      effects: MicromarkEffects,
      ok: MicromarkState,
      nok: MicromarkState,
    ) {
      chargeAttentionRun(
        this,
        this.now().offset < markdown.length ? markdown.charCodeAt(this.now().offset) : null,
      );
      return attention.tokenize.call(this, effects, ok, nok);
    },
  };

  const recursiveAttentionGuard = {
    add: 'before' as const,
    resolveAll(events: ReturnType<typeof postprocess>): ReturnType<typeof postprocess> {
      chargeAttentionResolution(events);
      return events;
    },
  };

  const guardedImageStart = wrapLabelStart(labelStartImage, 'labelImage');
  const guardedLabelStart = wrapLabelStart(labelStartLink, 'labelLink');
  const guardedList = wrapContainer(list);
  const guardedBlockQuote = wrapContainer(blockQuote);
  return {
    document: {
      42: guardedList,
      43: guardedList,
      45: guardedList,
      48: guardedList,
      49: guardedList,
      50: guardedList,
      51: guardedList,
      52: guardedList,
      53: guardedList,
      54: guardedList,
      55: guardedList,
      56: guardedList,
      57: guardedList,
      62: guardedBlockQuote,
    },
    insideSpan: {
      null: [recursiveAttentionGuard],
    },
    text: {
      33: guardedImageStart,
      42: guardedAttention,
      91: guardedLabelStart,
      93: guardedLabelEnd,
      95: guardedAttention,
    },
  };
}

/**
 * An extension precedes, but does not replace, a built-in construct. These wrappers delegate the
 * corresponding public CommonMark construct, so remove only the shadowed built-in entries from
 * this fresh parser context. That preserves one grammar attempt per trigger instead of retrying
 * the same tokenizer after a delegated `nok`.
 */
function removeShadowedCoreConstructs(parser: ReturnType<typeof parse>): void {
  const removeNamedConstruct = (
    record: (typeof parser.constructs)['text'],
    code: number,
    name: string,
  ): void => {
    const configured = record[code];
    if (configured === undefined) {
      return;
    }
    const constructs = Array.isArray(configured) ? configured : [configured];
    record[code] = constructs.filter((construct) => construct.name !== name);
  };

  for (const code of [42, 43, 45, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57]) {
    removeNamedConstruct(parser.constructs.document, code, 'list');
  }
  removeNamedConstruct(parser.constructs.document, 62, 'blockQuote');
  removeNamedConstruct(parser.constructs.text, 33, 'labelStartImage');
  removeNamedConstruct(parser.constructs.text, 42, 'attention');
  removeNamedConstruct(parser.constructs.text, 91, 'labelStartLink');
  removeNamedConstruct(parser.constructs.text, 93, 'labelEnd');
  removeNamedConstruct(parser.constructs.text, 95, 'attention');
}

function markdownContainerNestingFailure(
  events: ReturnType<typeof postprocess>,
): string | undefined {
  let depth = 0;
  for (const [eventKind, token] of events) {
    if (
      token.type !== 'listOrdered' &&
      token.type !== 'listUnordered' &&
      token.type !== 'blockQuote'
    ) {
      continue;
    }
    if (eventKind === 'enter') {
      depth += 1;
      if (depth > OKF_SEMANTIC_LIMITS.maxMarkdownContainerNestingDepth) {
        return `Markdown list and blockquote nesting exceeds the ${String(OKF_SEMANTIC_LIMITS.maxMarkdownContainerNestingDepth)}-level pre-parse safety limit. Reduce nesting, then retry.`;
      }
    } else {
      depth = Math.max(0, depth - 1);
    }
  }
  return undefined;
}

function trustMarkdownInspection(
  inspection: MarkdownComplexityInspection,
): MarkdownComplexityInspection {
  const trusted = Object.freeze(inspection);
  trustedMarkdownInspections.add(trusted);
  return trusted;
}

/** Rejects compact parser-amplification inputs before remark materializes an AST. */
export function markdownComplexityFailure(markdown: string): string | undefined {
  return inspectMarkdownComplexity(markdown).failure;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function boundedMarkdownSerializedTokenFailure(
  serialized: string,
  maxCodeUnits: number,
  maxBytes: number,
  subject: string,
  additionalCodeUnits = 0,
  additionalBytes = 0,
  decode = true,
): string | undefined {
  const value = decode ? decodeString(serialized) : serialized;
  return boundedMarkdownValueFailure(
    value,
    maxCodeUnits,
    maxBytes,
    subject,
    additionalCodeUnits,
    additionalBytes,
  );
}

function boundedMarkdownValueFailure(
  value: string,
  maxCodeUnits: number,
  maxBytes: number,
  subject: string,
  additionalCodeUnits = 0,
  additionalBytes = 0,
): string | undefined {
  if (
    value.length > maxCodeUnits - additionalCodeUnits ||
    utf8ByteLength(value) > maxBytes - additionalBytes
  ) {
    return `Markdown ${subject} exceeds the ${String(maxCodeUnits)}-code-unit / ${String(maxBytes)}-byte pre-parse safety limit. Shorten it, then retry.`;
  }
  return undefined;
}

function visit(node: AstNode, visitor: (node: AstNode) => void): void {
  const pending = [node];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    visitor(current);
    const children = current.children;
    if (children === undefined) {
      continue;
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) {
        pending.push(child);
      }
    }
  }
}

function readableText(node: AstNode): string {
  const chunks: string[] = [];
  let retainedCodeUnits = 0;
  let overflow = false;
  const append = (value: string): void => {
    if (overflow) {
      return;
    }
    retainedCodeUnits += value.length;
    if (retainedCodeUnits > OKF_SEMANTIC_LIMITS.maxLinkLabelCodeUnits) {
      overflow = true;
      chunks.length = 0;
      return;
    }
    chunks.push(value);
  };
  visit(node, (current) => {
    if (
      (current.type === 'text' || current.type === 'inlineCode' || current.type === 'code') &&
      typeof current.value === 'string'
    ) {
      append(current.value);
    } else if (
      (current.type === 'image' || current.type === 'imageReference') &&
      typeof current.alt === 'string'
    ) {
      append(current.alt);
    } else if (current.type === 'break') {
      append(' ');
    }
  });
  return overflow ? 'x'.repeat(OKF_SEMANTIC_LIMITS.maxLinkLabelCodeUnits + 1) : chunks.join('');
}

function boundedLinkTextFailure(
  value: string,
  maxCodeUnits: number,
  maxBytes: number,
  subject: string,
): string | undefined {
  if (value.length > maxCodeUnits || utf8ByteLength(value) > maxBytes) {
    return `Markdown ${subject} exceeds the ${String(maxCodeUnits)}-code-unit / ${String(maxBytes)}-byte safety limit. Shorten it, then retry.`;
  }
  return undefined;
}

function normalizeIdentifier(identifier: string): string {
  return identifier.trim().replace(/\s+/gu, ' ').toLowerCase();
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
