import remarkParse from 'remark-parse';
import { unified } from 'unified';

import type { SourceRange } from '../model/index.js';
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
  | { readonly ok: true; readonly links: readonly MarkdownLinkCandidate[] }
  | { readonly ok: false; readonly message: string; readonly range: SourceRange };

export type MarkdownHeadingResult =
  | { readonly ok: true; readonly headings: readonly MarkdownHeadingCandidate[] }
  | { readonly ok: false; readonly message: string; readonly range: SourceRange };

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

const markdownParser = unified().use(remarkParse);

export function extractMarkdownLinks(
  markdown: string,
  bodyStart: number,
  ranges: SourceRangeIndex,
): MarkdownLinkResult {
  try {
    const root = markdownParser.parse(markdown) as AstNode;
    const definitions = new Map<string, string>();

    visit(root, (node) => {
      if (
        node.type !== 'definition' ||
        typeof node.identifier !== 'string' ||
        typeof node.url !== 'string'
      ) {
        return;
      }
      const identifier = normalizeIdentifier(node.identifier);
      if (!definitions.has(identifier)) {
        definitions.set(identifier, node.url);
      }
    });

    const links: MarkdownLinkCandidate[] = [];
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

      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) {
        return;
      }
      links.push({
        rawTarget,
        label: readableText(node).trim(),
        range: ranges.range(bodyStart + start, bodyStart + end),
      });
    });

    links.sort(
      (left, right) =>
        left.range.start.offset - right.range.start.offset ||
        compareStrings(left.rawTarget, right.rawTarget) ||
        compareStrings(left.label, right.label),
    );
    return { ok: true, links };
  } catch (error: unknown) {
    return {
      ok: false,
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
  try {
    const root = markdownParser.parse(markdown) as AstNode;
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

function visit(node: AstNode, visitor: (node: AstNode) => void): void {
  visitor(node);
  if (node.children === undefined) {
    return;
  }
  for (const child of node.children) {
    visit(child, visitor);
  }
}

function readableText(node: AstNode): string {
  if (
    (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') &&
    typeof node.value === 'string'
  ) {
    return node.value;
  }
  if ((node.type === 'image' || node.type === 'imageReference') && typeof node.alt === 'string') {
    return node.alt;
  }
  if (node.type === 'break') {
    return ' ';
  }
  return node.children?.map(readableText).join('') ?? '';
}

function normalizeIdentifier(identifier: string): string {
  return identifier.trim().replace(/\s+/gu, ' ').toLowerCase();
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
