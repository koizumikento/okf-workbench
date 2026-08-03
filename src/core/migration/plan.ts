import { isValidActor, parseBundle } from '../parser/index.js';
import type { ParsedFrontmatter } from '../model/index.js';
import type { RenderedTemplateFile } from '../templates/index.js';
import type { MigrationDocumentResult, MigrationInput, MigrationPlan } from './types.js';

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

interface CitationAnalysis {
  readonly resources: readonly string[];
  readonly ambiguous: boolean;
}

const encoder = new TextEncoder();

function compareRelativePath(
  left: { readonly relativePath: string },
  right: { readonly relativePath: string },
): number {
  const leftBytes = encoder.encode(left.relativePath);
  const rightBytes = encoder.encode(right.relativePath);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function compareMigrationPath(
  left: { readonly relativePath: string },
  right: { readonly relativePath: string },
): number {
  if (left.relativePath === 'index.md') return right.relativePath === 'index.md' ? 0 : 1;
  if (right.relativePath === 'index.md') return -1;
  return compareRelativePath(left, right);
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function planMigration(input: MigrationInput): MigrationPlan {
  const plan = planMigrationWithCitations(input, true);
  if (renderedPlanIsParseable(input.bundle, plan)) return plan;
  if (plan.documents.some(({ actions }) => actions.includes('citations-to-sources'))) {
    const fallback = planMigrationWithCitations(input, false);
    if (renderedPlanIsParseable(input.bundle, fallback)) return fallback;
  }
  throw new Error('Migration rendered output is outside the canonical parser safety envelope.');
}

function planMigrationWithCitations(
  input: MigrationInput,
  allowCitationInsertions: boolean,
): MigrationPlan {
  validateActor(input.actor);
  const texts = decodedDocuments(input);
  const bundle = parseBundle(input.bundle);
  const failure = bundle.failures[0];
  if (failure !== undefined) {
    throw new Error(
      `Migration requires a completely parseable bundle; ${failure.bundlePath}: ${failure.message}`,
    );
  }
  const rootIndex = bundle.reservedDocuments.find(
    (document) => document.source.bundlePath === 'index.md',
  );
  if (rootIndex === undefined) throw new Error('Migration requires a bundle-root index.md.');
  const fromVersion = rootIndex.okfVersion;
  if (fromVersion === undefined)
    throw new Error('Migration requires a string okf_version declaration.');
  if (fromVersion !== '0.1' && fromVersion !== '0.2') {
    throw new Error(
      `Migration supports only declared OKF 0.1 or 0.2 bundles, not ${JSON.stringify(fromVersion)}.`,
    );
  }

  const files: RenderedTemplateFile[] = [];
  const documents: MigrationDocumentResult[] = [];
  const rootText = requiredText(texts, 'index.md');
  const rootActions: string[] = [];
  if (fromVersion === '0.1') {
    if (rootIndex.frontmatter === undefined)
      throw new Error('The v0.1 root index has no frontmatter.');
    const range = simpleFieldRange(rootText, rootIndex.frontmatter, 'okf_version');
    if (range === undefined) {
      throw new Error('Migration requires a single-line, unanchored okf_version declaration.');
    }
    const field = rootText.slice(range.start, range.end);
    const output = applyEdits(rootText, [
      {
        start: range.start,
        end: range.end,
        replacement: `okf_version: "0.2"${inlineComment(field)}`,
      },
    ]);
    rootActions.push('root-version-to-0.2');
    files.push(rendered('index.md', output));
  }
  documents.push({
    relativePath: 'index.md',
    changed: rootActions.length > 0,
    manualFollowUp: false,
    manualReasons: [],
    actions: rootActions,
    citationCandidates: [],
  });

  for (const concept of bundle.concepts) {
    const path = concept.source.bundlePath;
    const text = requiredText(texts, path);
    const eol = lineEnding(text);
    const edits: Edit[] = [];
    const actions: string[] = [];
    let manualFollowUp = false;
    const manualReasons: MigrationDocumentResult['manualReasons'][number][] = [];
    let citationCandidates: readonly string[] = [];

    if (
      Object.hasOwn(concept.frontmatter.raw, 'timestamp') &&
      !Object.hasOwn(concept.frontmatter.raw, 'generated')
    ) {
      if (concept.timestamp !== undefined && isRfc3339(concept.timestamp)) {
        const range = simpleFieldRange(text, concept.frontmatter, 'timestamp');
        if (range === undefined) {
          manualFollowUp = true;
          manualReasons.push('timestamp-requires-manual-migration');
        } else {
          const field = text.slice(range.start, range.end);
          edits.push({
            start: range.start,
            end: range.end,
            replacement: `generated:${eol}  by: ${yamlQuote(input.actor)}${eol}  at: ${yamlQuote(concept.timestamp)}${inlineComment(field)}`,
          });
          actions.push('timestamp-to-generated');
        }
      } else {
        manualFollowUp = true;
        manualReasons.push('timestamp-requires-manual-migration');
      }
    }

    const analysis = analyzeCitations(concept.body);
    if (analysis !== undefined) {
      citationCandidates = analysis.resources;
      if (analysis.ambiguous || analysis.resources.length === 0) {
        manualFollowUp = true;
        manualReasons.push('citations-require-manual-review');
      } else if (!Object.hasOwn(concept.frontmatter.raw, 'sources') && allowCitationInsertions) {
        const closing = frontmatterClosingStart(text);
        const block = `sources:${eol}${analysis.resources
          .map((resource) => `  - resource: ${yamlQuote(resource)}${eol}`)
          .join('')}`;
        const citationEdit = { start: closing, end: closing, replacement: block };
        const proposal = applyEdits(text, [...edits, citationEdit]);
        if (renderedConceptIsParseable(path, concept.source.uri, proposal)) {
          edits.push(citationEdit);
          actions.push('citations-to-sources');
        } else {
          manualFollowUp = true;
          manualReasons.push('citations-require-manual-review');
        }
      } else if (!Object.hasOwn(concept.frontmatter.raw, 'sources')) {
        manualFollowUp = true;
        manualReasons.push('citations-require-manual-review');
      }
    }

    const changed = edits.length > 0;
    if (changed) files.push(rendered(path, applyEdits(text, edits)));
    documents.push({
      relativePath: path,
      changed,
      manualFollowUp,
      manualReasons,
      actions,
      citationCandidates,
    });
  }

  files.sort(compareMigrationPath);
  documents.sort(compareRelativePath);
  return { fromVersion, toVersion: '0.2', files, documents };
}

function decodedDocuments(input: MigrationInput): ReadonlyMap<string, string> {
  const texts = new Map<string, string>();
  for (const document of input.bundle.documents) {
    if (document.identityOnlyFailure !== undefined) {
      throw new Error(`Migration cannot read ${document.bundlePath} completely.`);
    }
    let text: string;
    try {
      text =
        typeof document.content === 'string' ? document.content : decoder.decode(document.content);
    } catch {
      throw new Error(`Migration requires valid UTF-8 in ${document.bundlePath}.`);
    }
    if (texts.has(document.bundlePath)) {
      throw new Error(`Migration found duplicate document path ${document.bundlePath}.`);
    }
    texts.set(document.bundlePath, text);
  }
  return texts;
}

function requiredText(texts: ReadonlyMap<string, string>, path: string): string {
  const text = texts.get(path);
  if (text === undefined) throw new Error(`The source bytes for ${path} are unavailable.`);
  return text;
}

function validateActor(actor: string): void {
  if (!isValidActor(actor)) {
    throw new Error('Migration actor must use human:<id>, process:<id>, or <producer>/<version>.');
  }
}

function simpleFieldRange(
  text: string,
  frontmatter: ParsedFrontmatter,
  field: string,
): { readonly start: number; readonly end: number } | undefined {
  const sourceOffset = text.startsWith('\uFEFF') ? 1 : 0;
  let offset = 0;
  for (const line of frontmatter.source.split(/\r\n?|\n/gu)) {
    const prefixes = [field, `'${field}'`, `"${field}"`];
    const prefix = prefixes.find(
      (candidate) => line.startsWith(candidate) && /^[ \t]*:/u.test(line.slice(candidate.length)),
    );
    if (prefix !== undefined) {
      const colon = prefix.length + (/^[ \t]*/u.exec(line.slice(prefix.length))?.[0].length ?? 0);
      const value = line.slice(colon + 1).trimStart();
      if (!isSingleLineUnanchoredScalar(value)) {
        return undefined;
      }
      const canonicalStart = frontmatter.range.start.offset + offset;
      const canonicalEnd = canonicalStart + line.length;
      const fieldRange = frontmatter.fields[field];
      if (fieldRange === undefined || fieldRange.end.offset > canonicalEnd) {
        return undefined;
      }
      const start = canonicalStart + sourceOffset;
      const end = canonicalEnd + sourceOffset;
      if (text.slice(start, end) !== line) {
        throw new Error(`The ${field} source range does not match the document.`);
      }
      return { start, end };
    }
    offset += line.length;
    const separator = frontmatter.source.slice(offset).match(/^(?:\r\n?|\n)/u)?.[0];
    if (separator !== undefined) offset += separator.length;
  }
  throw new Error(`The ${field} source range is unavailable.`);
}

function isSingleLineUnanchoredScalar(source: string): boolean {
  let value = source;
  while (true) {
    if (value.startsWith('&')) return false;
    if (value.startsWith('!<')) {
      const end = value.indexOf('>');
      if (end === -1) return false;
      value = value.slice(end + 1).trimStart();
      continue;
    }
    if (!value.startsWith('!')) break;
    const separator = value.search(/[ \t]/u);
    value = (separator === -1 ? '' : value.slice(separator)).trimStart();
  }
  return value.length > 0 && !/^[|>&*]/u.test(value);
}

function applyEdits(text: string, edits: readonly Edit[]): string {
  const sorted = [...edits].sort((left, right) => right.start - left.start || right.end - left.end);
  let output = text;
  let priorStart = Number.POSITIVE_INFINITY;
  for (const edit of sorted) {
    if (edit.start > edit.end || edit.end > priorStart) {
      throw new Error('Migration produced overlapping source edits.');
    }
    output = `${output.slice(0, edit.start)}${edit.replacement}${output.slice(edit.end)}`;
    priorStart = edit.start;
  }
  return output;
}

function frontmatterClosingStart(text: string): number {
  let offset = 0;
  let openingSeen = false;
  while (offset <= text.length) {
    let end = offset;
    while (end < text.length && text[end] !== '\r' && text[end] !== '\n') end += 1;
    const content = text.slice(offset, end);
    if (!openingSeen) {
      if (content.replace(/^\uFEFF/u, '') === '---') openingSeen = true;
    } else if (content === '---') {
      return offset;
    }
    if (end >= text.length) break;
    offset = end + (text[end] === '\r' && text[end + 1] === '\n' ? 2 : 1);
  }
  throw new Error('Migration could not locate the frontmatter closing delimiter.');
}

function analyzeCitations(body: string): CitationAnalysis | undefined {
  const normalized = body.replace(/\r\n?/gu, '\n');
  let inCitations = false;
  let found = false;
  let ambiguous = false;
  const resources: string[] = [];
  const seen = new Set<string>();
  let fence: { readonly marker: '`' | '~'; readonly length: number } | undefined;
  let htmlBlock: HtmlBlock | undefined;
  for (const rawLine of normalized.split('\n')) {
    const { columns: indent, content: line } = markdownIndent(rawLine);
    if (fence !== undefined) {
      const run = line.match(fence.marker === '`' ? /^`+/u : /^~+/u)?.[0] ?? '';
      if (indent <= 3 && run.length >= fence.length && line.slice(run.length).trim().length === 0) {
        fence = undefined;
      }
      continue;
    }
    if (htmlBlock !== undefined) {
      if (line.includes('Citations')) {
        found = true;
        ambiguous = true;
      }
      if (htmlBlockEnds(htmlBlock, line)) htmlBlock = undefined;
      continue;
    }
    if (indent > 3) {
      continue;
    }
    const opening = /^(`{3,}|~{3,})(.*)$/u.exec(line);
    if (
      opening !== null &&
      (opening[1]?.startsWith('~') === true || !(opening[2] ?? '').includes('`'))
    ) {
      if (inCitations) ambiguous = true;
      const run = opening[1] ?? '';
      fence = { marker: run[0] as '`' | '~', length: run.length };
      continue;
    }
    const htmlOpening = htmlBlockOpening(line);
    if (htmlOpening !== undefined) {
      if (inCitations || line.includes('Citations')) {
        found = true;
        ambiguous = true;
      }
      if (!htmlBlockEnds(htmlOpening, line)) htmlBlock = htmlOpening;
      continue;
    }
    const heading = /^#(?:[ \t]+|$)(.*)$/u.exec(line);
    if (heading !== null) {
      const title = (heading[1] ?? '').replace(/[ \t]+#+[ \t]*$/u, '').trim();
      inCitations = title === 'Citations';
      if (inCitations) {
        found = true;
      }
      continue;
    }
    if (!inCitations || line.trim().length === 0) continue;
    const candidate = /^(?:-|\*) (.+)$/u.exec(line.trim())?.[1];
    if (candidate !== undefined && isSimpleUrl(candidate)) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        resources.push(candidate);
      }
    } else {
      ambiguous = true;
    }
  }
  return found ? { resources, ambiguous } : undefined;
}

function markdownIndent(line: string): { readonly columns: number; readonly content: string } {
  let columns = 0;
  let offset = 0;
  while (offset < line.length) {
    const character = line[offset];
    if (character === ' ') {
      columns += 1;
    } else if (character === '\t') {
      columns += 4 - (columns % 4);
    } else {
      break;
    }
    offset += 1;
  }
  return { columns, content: line.slice(offset) };
}

function isSimpleUrl(value: string): boolean {
  return /^(?:https?):\/\/[^\s\p{Cc}]+$/u.test(value);
}

type HtmlBlock =
  | 'comment'
  | 'processing'
  | 'declaration'
  | 'cdata'
  | 'script'
  | 'pre'
  | 'style'
  | 'textarea'
  | 'until-blank';

function htmlBlockOpening(line: string): HtmlBlock | undefined {
  if (line.startsWith('<!--')) return 'comment';
  if (line.startsWith('<?')) return 'processing';
  if (line.startsWith('<![CDATA[')) return 'cdata';
  if (/^<![A-Z]/u.test(line)) return 'declaration';
  const raw = /^<\/?(script|pre|style|textarea)(?:[\s/>]|$)/iu.exec(line)?.[1]?.toLowerCase();
  if (raw === 'script' || raw === 'pre' || raw === 'style' || raw === 'textarea') return raw;
  if (
    /^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[\s/>]|$)/iu.test(
      line,
    ) ||
    (/^<[^<>]+>[ \t]*$/u.test(line) && !/^<https?:\/\//u.test(line))
  ) {
    return 'until-blank';
  }
  return undefined;
}

function htmlBlockEnds(block: HtmlBlock, line: string): boolean {
  switch (block) {
    case 'comment':
      return line.includes('-->');
    case 'processing':
      return line.includes('?>');
    case 'declaration':
      return line.includes('>');
    case 'cdata':
      return line.includes(']]>');
    case 'script':
      return /<\/script>/iu.test(line);
    case 'pre':
      return /<\/pre>/iu.test(line);
    case 'style':
      return /<\/style>/iu.test(line);
    case 'textarea':
      return /<\/textarea>/iu.test(line);
    case 'until-blank':
      return line.trim().length === 0;
  }
}

function renderedConceptIsParseable(path: string, uri: string, content: string): boolean {
  return (
    parseBundle({
      rootUri: 'fixture:/migration-proposal',
      revision: 1,
      documents: [
        {
          uri,
          bundlePath: path,
          content,
        },
      ],
    }).failures.length === 0
  );
}

function renderedPlanIsParseable(input: MigrationInput['bundle'], plan: MigrationPlan): boolean {
  const outputs = new Map(plan.files.map((file) => [file.relativePath, file.content]));
  return (
    parseBundle({
      ...input,
      documents: input.documents.map((document) => {
        const content = outputs.get(document.bundlePath);
        return content === undefined
          ? document
          : { uri: document.uri, bundlePath: document.bundlePath, content };
      }),
    }).failures.length === 0
  );
}

function isRfc3339(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/u.exec(
      value,
    );
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[7] ?? '';
  const days =
    month === 2
      ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
        ? 29
        : 28
      : [4, 6, 9, 11].includes(month)
        ? 30
        : 31;
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 60 &&
    (zone.toUpperCase() === 'Z' ||
      (Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4, 6)) <= 59))
  );
}

function inlineComment(field: string): string {
  const match = /(\s+#.*)$/u.exec(field);
  return match?.[1] ?? '';
}

function lineEnding(text: string): '\r\n' | '\r' | '\n' {
  if (text.includes('\r\n')) return '\r\n';
  if (text.includes('\n')) return '\n';
  if (text.includes('\r')) return '\r';
  return '\n';
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

function rendered(relativePath: string, content: string): RenderedTemplateFile {
  return { relativePath, encoding: 'utf8', content };
}
