import {
  CST,
  isAlias,
  isMap,
  isNode,
  isPair,
  isScalar,
  isSeq,
  Parser,
  parseDocument,
  type Document,
  type Node,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';

import type {
  JsonObject,
  JsonValue,
  NormalizedFrontmatter,
  ParsedFrontmatter,
  SourceRange,
} from '../model/index.js';
import { OKF_SEMANTIC_LIMITS } from '../model/resource-limits.js';
import type { SourceRangeIndex } from './source-range.js';

export type FrontmatterResult =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'success';
      readonly frontmatter: ParsedFrontmatter;
      readonly body: string;
      readonly bodyStart: number;
    }
  | {
      readonly kind: 'failure';
      readonly message: string;
      readonly range: SourceRange;
      readonly resourceLimit?: true;
    };

/**
 * JSON object key used when an exact YAML integer cannot be represented safely by a JavaScript
 * number. The decimal string retains the value without exposing `bigint` at serialization
 * boundaries.
 */
export const EXACT_YAML_INTEGER_KEY = '$okf-workbench:yaml-integer' as const;

/**
 * JSON object key used for an explicitly tagged YAML value. The nested object retains the
 * canonical tag name, a JSON-safe semantic value, and the exact lexical value source following
 * the tag. The complete frontmatter source remains available on `ParsedFrontmatter.source`.
 */
export const YAML_TAGGED_VALUE_KEY = '$okf-workbench:yaml-tag' as const;

const YAML_BINARY_TAG = 'tag:yaml.org,2002:binary';
const YAML_BOOL_TAG = 'tag:yaml.org,2002:bool';
const YAML_FLOAT_TAG = 'tag:yaml.org,2002:float';
const YAML_INT_TAG = 'tag:yaml.org,2002:int';
const YAML_MAP_TAG = 'tag:yaml.org,2002:map';
const YAML_NULL_TAG = 'tag:yaml.org,2002:null';
const YAML_OMAP_TAG = 'tag:yaml.org,2002:omap';
const YAML_PAIRS_TAG = 'tag:yaml.org,2002:pairs';
const YAML_SEQ_TAG = 'tag:yaml.org,2002:seq';
const YAML_SET_TAG = 'tag:yaml.org,2002:set';
const YAML_STR_TAG = 'tag:yaml.org,2002:str';
const YAML_TIMESTAMP_TAG = 'tag:yaml.org,2002:timestamp';
const SUPPORTED_EXPLICIT_YAML_TAGS = new Set([
  YAML_BINARY_TAG,
  YAML_BOOL_TAG,
  YAML_FLOAT_TAG,
  YAML_INT_TAG,
  YAML_MAP_TAG,
  YAML_NULL_TAG,
  YAML_OMAP_TAG,
  YAML_PAIRS_TAG,
  YAML_SEQ_TAG,
  YAML_SET_TAG,
  YAML_STR_TAG,
  YAML_TIMESTAMP_TAG,
]);
const MAX_ALIAS_EXPANSIONS = 100;
const utf8Encoder = new TextEncoder();

export type FrontmatterPreparseInspection =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'failure';
      readonly message: string;
      readonly start: number;
      readonly end: number;
      readonly resourceLimit?: true;
      readonly sourceCodeUnits?: number;
      readonly structuralTokens?: number;
    }
  | {
      readonly kind: 'success';
      readonly yamlStart: number;
      readonly yamlEnd: number;
      readonly bodyStart: number;
      readonly sourceCodeUnits: number;
      readonly structuralTokens: number;
    };

/** Performs all YAML amplification checks without constructing a source-range index or YAML AST. */
export function inspectFrontmatterPreparse(text: string): FrontmatterPreparseInspection {
  const region = findFrontmatterRegion(text);
  if (region.kind !== 'success') {
    return region;
  }
  const source = text.slice(region.yamlStart, region.yamlEnd);
  const sourceCodeUnits = source.length;
  const structuralTokens = frontmatterWorkTokens(source);
  const complexityFailure = frontmatterComplexityFailure(source);
  if (complexityFailure === undefined) {
    return {
      ...region,
      sourceCodeUnits,
      structuralTokens,
    };
  }
  return {
    kind: 'failure',
    message: complexityFailure,
    start: region.yamlStart,
    end: region.yamlEnd,
    resourceLimit: true,
    sourceCodeUnits,
    structuralTokens,
  };
}

function frontmatterWorkTokens(source: string): number {
  let tokens = 0;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (
      (code > 0 && code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      (code >= 0x21 && code <= 0x2f) ||
      (code >= 0x3a && code <= 0x40) ||
      (code >= 0x5b && code <= 0x60) ||
      (code >= 0x7b && code <= 0x7e)
    ) {
      tokens += 1;
    }
  }
  return tokens;
}

export function parseFrontmatter(text: string, ranges: SourceRangeIndex): FrontmatterResult {
  const region = inspectFrontmatterPreparse(text);
  if (region.kind !== 'success') {
    if (region.kind === 'absent') {
      return region;
    }
    return {
      kind: 'failure',
      message: region.message,
      range: ranges.range(region.start, region.end),
      ...(region.resourceLimit === true ? { resourceLimit: true as const } : {}),
    };
  }

  const source = text.slice(region.yamlStart, region.yamlEnd);
  // yaml's lexer accepts LF and CRLF, while CommonMark also treats a lone CR as a line ending.
  // Replacing only lone CR characters preserves every UTF-16 offset used by diagnostics.
  const parserSource = normalizeYamlLineEndings(source);
  try {
    const document = parseDocument(parserSource, {
      intAsBigInt: true,
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });

    const firstError = document.errors[0];
    if (firstError !== undefined) {
      const errorStart = firstError.pos[0] ?? 0;
      const errorEnd = firstError.pos[1] ?? errorStart + 1;
      return {
        kind: 'failure',
        message: `Invalid YAML frontmatter: ${firstError.message}`,
        range: ranges.range(region.yamlStart + errorStart, region.yamlStart + errorEnd),
      };
    }

    if (!isMap(document.contents)) {
      return {
        kind: 'failure',
        message: 'YAML frontmatter must be a mapping with string field names.',
        range: ranges.range(region.yamlStart, region.yamlEnd),
      };
    }

    const nonStringKeyRange = findNonStringMappingKey(document.contents);
    if (nonStringKeyRange !== undefined) {
      return {
        kind: 'failure',
        message: 'YAML frontmatter mappings must use string field names at every level.',
        range: ranges.range(
          region.yamlStart + nonStringKeyRange.start,
          region.yamlStart + nonStringKeyRange.end,
        ),
      };
    }

    const converted = toJsonObject(document.contents, document, source);
    if (!converted.ok) {
      const resourceLimit = converted.message.startsWith('semantic output exceeds');
      return {
        kind: 'failure',
        message: `YAML frontmatter is not JSON-safe: ${converted.message}`,
        range: ranges.range(region.yamlStart, region.yamlEnd),
        ...(resourceLimit ? { resourceLimit: true as const } : {}),
      };
    }

    const explicitTags = collectTopLevelExplicitTags(document.contents, document);

    const fields: Record<string, SourceRange> = Object.create(null) as Record<string, SourceRange>;
    for (const pair of document.contents.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
        continue;
      }
      const keyRange = pair.key.range;
      const valueRange = pair.value?.range;
      if (keyRange === undefined) {
        continue;
      }
      const start = region.yamlStart + keyRange[0];
      const end = region.yamlStart + (valueRange?.[1] ?? keyRange[1]);
      fields[pair.key.value] = ranges.range(start, end);
    }

    const frontmatter: ParsedFrontmatter = {
      raw: converted.value,
      explicitTags,
      source,
      range: ranges.range(region.yamlStart, region.yamlEnd),
      fields,
      normalized: normalizeFrontmatter(converted.value, explicitTags),
    };

    return {
      kind: 'success',
      frontmatter,
      body: text.slice(region.bodyStart),
      bodyStart: region.bodyStart,
    };
  } catch (error: unknown) {
    return {
      kind: 'failure',
      message: `Invalid YAML frontmatter: ${errorMessage(error)}`,
      range: ranges.range(region.yamlStart, region.yamlEnd),
    };
  }
}

type FrontmatterRegion =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'failure';
      readonly message: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: 'success';
      readonly yamlStart: number;
      readonly yamlEnd: number;
      readonly bodyStart: number;
    };

function findFrontmatterRegion(text: string): FrontmatterRegion {
  const opening = readLine(text, 0);
  if (opening.text !== '---') {
    return { kind: 'absent' };
  }

  let cursor = opening.next;
  while (cursor <= text.length) {
    const line = readLine(text, cursor);
    if (line.text === '---') {
      return {
        kind: 'success',
        yamlStart: opening.next,
        yamlEnd: cursor,
        bodyStart: line.next,
      };
    }
    if (line.next <= cursor || line.next > text.length) {
      break;
    }
    cursor = line.next;
  }

  return {
    kind: 'failure',
    message: 'YAML frontmatter has no closing delimiter.',
    start: 0,
    end: Math.min(text.length, opening.next),
  };
}

function readLine(text: string, start: number): { readonly text: string; readonly next: number } {
  let end = start;
  while (end < text.length) {
    const code = text.charCodeAt(end);
    if (code === 0x0a || code === 0x0d) {
      break;
    }
    end += 1;
  }

  const hasLineEnding = end < text.length;
  const isCrLf =
    hasLineEnding && text.charCodeAt(end) === 0x0d && text.charCodeAt(end + 1) === 0x0a;
  return {
    text: text.slice(start, end),
    next: hasLineEnding ? end + (isCrLf ? 2 : 1) : text.length,
  };
}

/** Rejects YAML parser-amplification inputs before the yaml package builds an AST. */
function frontmatterComplexityFailure(source: string): string | undefined {
  if (source.length > OKF_SEMANTIC_LIMITS.maxFrontmatterSourceCodeUnits) {
    return `YAML frontmatter exceeds the ${String(OKF_SEMANTIC_LIMITS.maxFrontmatterSourceCodeUnits)}-code-unit pre-parse safety limit. Reduce the metadata, then retry.`;
  }
  if (utf8Length(source) > OKF_SEMANTIC_LIMITS.maxFrontmatterSourceBytes) {
    return `YAML frontmatter exceeds the ${String(OKF_SEMANTIC_LIMITS.maxFrontmatterSourceBytes)}-byte pre-parse safety limit. Reduce the metadata, then retry.`;
  }

  let lineCount = source.length === 0 ? 0 : 1;
  let structuralTokens = 0;
  let atLineStart = true;
  let indent = 0;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code === 0x0a || (code === 0x0d && source.charCodeAt(index + 1) !== 0x0a)) {
      // A final line ending terminates the current line; it does not create an additional empty
      // source line. This keeps the inclusive 4,000-line boundary usable for normal YAML, whose
      // closing frontmatter delimiter requires the preceding content line to be terminated.
      if (index + 1 < source.length) {
        lineCount += 1;
      }
      if (lineCount > OKF_SEMANTIC_LIMITS.maxFrontmatterLines) {
        return `YAML frontmatter exceeds the ${String(OKF_SEMANTIC_LIMITS.maxFrontmatterLines)}-line pre-parse safety limit. Reduce the metadata, then retry.`;
      }
      atLineStart = true;
      indent = 0;
      continue;
    }
    if (atLineStart && code === 0x20) {
      indent += 1;
      if (indent > OKF_SEMANTIC_LIMITS.maxFrontmatterIndentColumns) {
        return `YAML frontmatter indentation exceeds the ${String(OKF_SEMANTIC_LIMITS.maxFrontmatterIndentColumns)}-column pre-parse safety limit. Reduce nesting, then retry.`;
      }
      continue;
    }
    if (code !== 0x09) {
      atLineStart = false;
    }
    if (
      (code > 0 && code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      (code >= 0x21 && code <= 0x2f) ||
      (code >= 0x3a && code <= 0x40) ||
      (code >= 0x5b && code <= 0x60) ||
      (code >= 0x7b && code <= 0x7e)
    ) {
      structuralTokens += 1;
    }
    if (structuralTokens > OKF_SEMANTIC_LIMITS.maxFrontmatterStructuralTokens) {
      return `YAML frontmatter exceeds the ${String(OKF_SEMANTIC_LIMITS.maxFrontmatterStructuralTokens)}-token pre-parse complexity limit. Reduce the metadata, then retry.`;
    }
  }
  return yamlCstNestingFailure(normalizeYamlLineEndings(source));
}

/**
 * The yaml composer normalizes a lone CR as a line ending. Keep the pre-AST CST inspection on the
 * same length-preserving input so it cannot observe a shallower structure than semantic parsing.
 */
function normalizeYamlLineEndings(source: string): string {
  return source.replace(/\r(?!\n)/gu, '\n');
}

/**
 * Uses yaml's concrete-syntax parser, but not its semantic AST composer, so comments, scalar
 * styles, node properties, flow collections, and indentless sequences share the package's grammar
 * rather than a second handwritten YAML lexer.
 */
function yamlCstNestingFailure(source: string): string | undefined {
  const pending: Array<{ readonly token: CST.Token; readonly parentDepth: number }> = [];
  try {
    for (const token of new Parser().parse(source)) {
      pending.push({ token, parentDepth: -1 });
    }
  } catch {
    return 'YAML frontmatter could not be inspected safely before semantic parsing. Reduce the metadata, then retry.';
  }

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    const { token, parentDepth } = current;
    const depth = CST.isCollection(token) ? parentDepth + 1 : parentDepth;
    if (depth > OKF_SEMANTIC_LIMITS.maxFrontmatterNestingDepth) {
      return `YAML frontmatter collection nesting exceeds the ${String(OKF_SEMANTIC_LIMITS.maxFrontmatterNestingDepth)}-level pre-parse safety limit. Reduce nesting, then retry.`;
    }
    if (token.type === 'document') {
      if (token.value !== undefined) {
        pending.push({ token: token.value, parentDepth: depth });
      }
    } else if (token.type === 'block-map' || token.type === 'flow-collection') {
      for (const item of token.items) {
        // In a flow sequence, a keyed entry is composed as an implicit YAMLMap even though the CST
        // does not expose a collection token for that map. This includes explicit and null keys.
        const itemParentDepth =
          token.type === 'flow-collection' &&
          token.start.type === 'flow-seq-start' &&
          item.key !== undefined
            ? depth + 1
            : depth;
        if (itemParentDepth > OKF_SEMANTIC_LIMITS.maxFrontmatterNestingDepth) {
          return `YAML frontmatter collection nesting exceeds the ${String(OKF_SEMANTIC_LIMITS.maxFrontmatterNestingDepth)}-level pre-parse safety limit. Reduce nesting, then retry.`;
        }
        if (item.key !== undefined && item.key !== null) {
          pending.push({ token: item.key, parentDepth: itemParentDepth });
        }
        if (item.value !== undefined) {
          pending.push({ token: item.value, parentDepth: itemParentDepth });
        }
      }
    } else if (token.type === 'block-seq') {
      for (const item of token.items) {
        if (item.value !== undefined) {
          pending.push({ token: item.value, parentDepth: depth });
        }
      }
    }
  }
  return undefined;
}

interface RelativeYamlRange {
  readonly start: number;
  readonly end: number;
}

/** Finds a mapping key that cannot be represented without coercion in a JSON object. */
function findNonStringMappingKey(node: unknown): RelativeYamlRange | undefined {
  if (isMap(node)) {
    for (const pair of node.items) {
      // `!!set` is represented by the YAML library as a mapping, but its keys are semantic set
      // members rather than JSON object field names. They are converted to a JSON array below.
      if (
        node.tag !== YAML_SET_TAG &&
        (!isScalar(pair.key) || typeof pair.key.value !== 'string')
      ) {
        const range = isNode(pair.key) ? pair.key.range : undefined;
        return {
          start: range?.[0] ?? node.range?.[0] ?? 0,
          end: range?.[1] ?? node.range?.[1] ?? 0,
        };
      }

      if (node.tag === YAML_SET_TAG) {
        const nestedKey = findNonStringMappingKey(pair.key);
        if (nestedKey !== undefined) {
          return nestedKey;
        }
      }

      const nested = findNonStringMappingKey(pair.value);
      if (nested !== undefined) {
        return nested;
      }
    }
  } else if (isSeq(node)) {
    for (const item of node.items) {
      if (isPair(item)) {
        if (!isScalar(item.key) || typeof item.key.value !== 'string') {
          const range = isNode(item.key) ? item.key.range : undefined;
          return {
            start: range?.[0] ?? node.range?.[0] ?? 0,
            end: range?.[1] ?? node.range?.[1] ?? 0,
          };
        }
        const nestedPairValue = findNonStringMappingKey(item.value);
        if (nestedPairValue !== undefined) {
          return nestedPairValue;
        }
        continue;
      }
      const nested = findNonStringMappingKey(item);
      if (nested !== undefined) {
        return nested;
      }
    }
  }

  return undefined;
}

function normalizeFrontmatter(
  raw: JsonObject,
  explicitTags: Readonly<Record<string, string>>,
): NormalizedFrontmatter {
  const tags = semanticValue(raw.tags, explicitTags.tags);
  return {
    ...optionalString('type', raw.type, explicitTags.type),
    ...optionalString('title', raw.title, explicitTags.title),
    ...optionalString('description', raw.description, explicitTags.description),
    ...optionalString('resource', raw.resource, explicitTags.resource),
    tags: Array.isArray(tags) && tags.every((tag) => typeof tag === 'string') ? [...tags] : [],
    ...optionalString('timestamp', raw.timestamp, explicitTags.timestamp),
  };
}

function optionalString<Key extends 'type' | 'title' | 'description' | 'resource' | 'timestamp'>(
  key: Key,
  value: JsonValue | undefined,
  explicitTag: string | undefined,
): Partial<Record<Key, string>> {
  const semantic = semanticValue(value, explicitTag);
  return typeof semantic === 'string' ? ({ [key]: semantic } as Record<Key, string>) : {};
}

function semanticValue(
  value: JsonValue | undefined,
  explicitTag: string | undefined,
): JsonValue | undefined {
  if (value === undefined || value === null || Array.isArray(value) || typeof value !== 'object') {
    return value;
  }
  if (explicitTag === undefined) {
    return value;
  }
  const objectValue = value as JsonObject;
  if (Object.keys(objectValue).length !== 1 || !Object.hasOwn(objectValue, YAML_TAGGED_VALUE_KEY)) {
    return value;
  }
  const details = objectValue[YAML_TAGGED_VALUE_KEY];
  if (details === null || Array.isArray(details) || typeof details !== 'object') {
    return value;
  }
  const detailsObject = details as JsonObject;
  return detailsObject.tag === explicitTag && typeof detailsObject.source === 'string'
    ? detailsObject.value
    : value;
}

/** Returns a semantic string only for a plain string or a parser-proven explicit `!!str`. */
export function semanticFrontmatterString(
  frontmatter: ParsedFrontmatter,
  field: string,
): string | undefined {
  const value = frontmatter.raw[field];
  if (typeof value === 'string') {
    return value;
  }
  if (frontmatter.explicitTags[field] !== YAML_STR_TAG) {
    return undefined;
  }
  const semantic = semanticValue(value, YAML_STR_TAG);
  return typeof semantic === 'string' ? semantic : undefined;
}

function collectTopLevelExplicitTags(
  mapping: YAMLMap,
  document: Document,
): Readonly<Record<string, string>> {
  const tags: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const pair of mapping.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
      continue;
    }
    const tag = explicitTag(pair.value, document);
    if (tag !== undefined) {
      tags[pair.key.value] = tag;
    }
  }
  return tags;
}

function explicitTag(value: unknown, document: Document): string | undefined {
  let current = value;
  const aliases = new Set<object>();
  for (let depth = 0; depth <= MAX_ALIAS_EXPANSIONS; depth += 1) {
    if (!isNode(current)) {
      return undefined;
    }
    if (!isAlias(current)) {
      return current.tag;
    }
    if (aliases.has(current)) {
      return undefined;
    }
    aliases.add(current);
    current = current.resolve(document);
  }
  return undefined;
}

type JsonConversion<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

function toJsonObject(
  value: unknown,
  document: Document,
  source: string,
): JsonConversion<JsonObject> {
  const converted = toJsonValue(value, {
    aliasExpansions: 0,
    outputUnits: 0,
    ancestors: new Set<object>(),
    document,
    source,
  });
  if (!converted.ok) {
    return converted;
  }
  if (
    converted.value === null ||
    Array.isArray(converted.value) ||
    typeof converted.value !== 'object'
  ) {
    return { ok: false, message: 'the document root is not a mapping' };
  }
  return { ok: true, value: converted.value as JsonObject };
}

interface YamlConversionContext {
  aliasExpansions: number;
  outputUnits: number;
  readonly ancestors: Set<object>;
  readonly document: Document;
  readonly source: string;
}

function toJsonValue(value: unknown, context: YamlConversionContext): JsonConversion<JsonValue> {
  const nodeBudgetFailure = chargeSemanticOutput(context, 1);
  if (nodeBudgetFailure !== undefined) {
    return { ok: false, message: nodeBudgetFailure };
  }
  if (value === null) {
    return { ok: true, value: null };
  }

  if (!isNode(value)) {
    return { ok: false, message: 'custom YAML object types are not supported' };
  }

  if (isAlias(value)) {
    const aliasBudgetFailure = chargeSemanticOutput(context, 1);
    if (aliasBudgetFailure !== undefined) {
      return { ok: false, message: aliasBudgetFailure };
    }
    context.aliasExpansions += 1;
    if (context.aliasExpansions > MAX_ALIAS_EXPANSIONS) {
      return {
        ok: false,
        message: `more than ${String(MAX_ALIAS_EXPANSIONS)} alias expansions are not supported`,
      };
    }
    const resolved = value.resolve(context.document);
    return resolved === undefined
      ? { ok: false, message: `unresolved YAML alias: ${value.source}` }
      : toJsonValue(resolved, context);
  }

  if (value.tag !== undefined && !SUPPORTED_EXPLICIT_YAML_TAGS.has(value.tag)) {
    return { ok: false, message: `custom YAML tag is not supported: ${value.tag}` };
  }

  const converted = convertNodeContent(value, context);
  if (!converted.ok || value.tag === undefined) {
    return converted;
  }

  const originalSource = originalNodeSource(value, context.source);
  const wrapperBudgetFailure = chargeSemanticOutput(
    context,
    3 + utf8Length(value.tag) + utf8Length(originalSource),
  );
  if (wrapperBudgetFailure !== undefined) {
    return { ok: false, message: wrapperBudgetFailure };
  }
  return {
    ok: true,
    value: {
      [YAML_TAGGED_VALUE_KEY]: {
        tag: value.tag,
        value: converted.value,
        source: originalSource,
      },
    },
  };
}

function convertNodeContent(
  value: Node,
  context: YamlConversionContext,
): JsonConversion<JsonValue> {
  if (isScalar(value)) {
    return toJsonScalar(value.value, value.tag, context);
  }
  if (isMap(value)) {
    return value.tag === YAML_SET_TAG ? toJsonSet(value, context) : toJsonMapping(value, context);
  }
  if (isSeq(value)) {
    return toJsonSequence(value, context);
  }
  return { ok: false, message: 'custom YAML object types are not supported' };
}

function toJsonScalar(
  value: unknown,
  tag: string | undefined,
  context: YamlConversionContext,
): JsonConversion<JsonValue> {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    const failure = chargeSemanticOutput(
      context,
      typeof value === 'string' ? utf8Length(value) : 1,
    );
    if (failure !== undefined) {
      return { ok: false, message: failure };
    }
    return { ok: true, value };
  }
  if (typeof value === 'number') {
    const failure = chargeSemanticOutput(context, 8);
    if (failure !== undefined) {
      return { ok: false, message: failure };
    }
    if (Number.isFinite(value)) {
      return { ok: true, value };
    }
    if (tag === YAML_FLOAT_TAG) {
      return {
        ok: true,
        value: Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity',
      };
    }
    return { ok: false, message: 'non-finite numbers are not supported' };
  }
  if (typeof value === 'bigint') {
    const decimal = value.toString(10);
    const failure = chargeSemanticOutput(context, 2 + utf8Length(decimal));
    if (failure !== undefined) {
      return { ok: false, message: failure };
    }
    if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return { ok: true, value: Number(value) };
    }
    return {
      ok: true,
      value: { [EXACT_YAML_INTEGER_KEY]: decimal },
    };
  }

  if (value instanceof Date) {
    if (tag !== YAML_TIMESTAMP_TAG || !Number.isFinite(value.getTime())) {
      return { ok: false, message: 'custom YAML object types are not supported' };
    }
    const iso = value.toISOString();
    const failure = chargeSemanticOutput(context, utf8Length(iso));
    return failure === undefined ? { ok: true, value: iso } : { ok: false, message: failure };
  }

  if (value instanceof Uint8Array) {
    if (tag !== YAML_BINARY_TAG) {
      return { ok: false, message: 'custom YAML object types are not supported' };
    }
    // A JSON number is charged at eight units plus one array slot. Budget the complete octet
    // array before spreading so a compact base64 scalar cannot amplify into an unbounded array.
    const failure = chargeSemanticOutput(context, 1 + value.byteLength * 9);
    if (failure !== undefined) {
      return { ok: false, message: failure };
    }
    return { ok: true, value: [...value] };
  }

  return { ok: false, message: `unsupported ${typeof value} value` };
}

function toJsonMapping(value: YAMLMap, context: YamlConversionContext): JsonConversion<JsonObject> {
  if (context.ancestors.has(value)) {
    return { ok: false, message: 'recursive aliases are not supported' };
  }
  context.ancestors.add(value);
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const pair of value.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
      context.ancestors.delete(value);
      return { ok: false, message: 'mapping keys must be strings' };
    }
    const keyBudgetFailure = chargeSemanticOutput(context, 1 + utf8Length(pair.key.value));
    if (keyBudgetFailure !== undefined) {
      context.ancestors.delete(value);
      return { ok: false, message: keyBudgetFailure };
    }
    const converted = toJsonValue(pair.value, context);
    if (!converted.ok) {
      context.ancestors.delete(value);
      return converted;
    }
    result[pair.key.value] = converted.value;
  }
  context.ancestors.delete(value);
  return { ok: true, value: result };
}

function toJsonSequence(
  value: YAMLSeq,
  context: YamlConversionContext,
): JsonConversion<readonly JsonValue[]> {
  if (context.ancestors.has(value)) {
    return { ok: false, message: 'recursive aliases are not supported' };
  }
  context.ancestors.add(value);
  const result: JsonValue[] = [];
  for (const item of value.items) {
    const entryBudgetFailure = chargeSemanticOutput(context, 1);
    if (entryBudgetFailure !== undefined) {
      context.ancestors.delete(value);
      return { ok: false, message: entryBudgetFailure };
    }
    const converted = isPair(item)
      ? toJsonPairAsObject(item.key, item.value, context)
      : toJsonValue(item, context);
    if (!converted.ok) {
      context.ancestors.delete(value);
      return converted;
    }
    result.push(converted.value);
  }
  context.ancestors.delete(value);
  return { ok: true, value: result };
}

function toJsonPairAsObject(
  key: unknown,
  value: unknown,
  context: YamlConversionContext,
): JsonConversion<JsonObject> {
  if (!isScalar(key) || typeof key.value !== 'string') {
    return { ok: false, message: 'ordered mapping keys must be strings' };
  }
  const keyBudgetFailure = chargeSemanticOutput(context, 1 + utf8Length(key.value));
  if (keyBudgetFailure !== undefined) {
    return { ok: false, message: keyBudgetFailure };
  }
  const converted = toJsonValue(value, context);
  if (!converted.ok) {
    return converted;
  }
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  result[key.value] = converted.value;
  return { ok: true, value: result };
}

function toJsonSet(
  value: YAMLMap,
  context: YamlConversionContext,
): JsonConversion<readonly JsonValue[]> {
  if (context.ancestors.has(value)) {
    return { ok: false, message: 'recursive aliases are not supported' };
  }
  context.ancestors.add(value);
  const result: JsonValue[] = [];
  for (const pair of value.items) {
    const entryBudgetFailure = chargeSemanticOutput(context, 1);
    if (entryBudgetFailure !== undefined) {
      context.ancestors.delete(value);
      return { ok: false, message: entryBudgetFailure };
    }
    const convertedKey = toJsonValue(pair.key, context);
    if (!convertedKey.ok) {
      context.ancestors.delete(value);
      return convertedKey;
    }
    const convertedValue = toJsonValue(pair.value, context);
    if (!convertedValue.ok) {
      context.ancestors.delete(value);
      return convertedValue;
    }
    if (convertedValue.value !== null) {
      context.ancestors.delete(value);
      return { ok: false, message: 'YAML set entries must have null values' };
    }
    result.push(convertedKey.value);
  }
  context.ancestors.delete(value);
  return { ok: true, value: result };
}

function chargeSemanticOutput(
  context: YamlConversionContext,
  additionalUnits: number,
): string | undefined {
  if (
    !Number.isSafeInteger(additionalUnits) ||
    additionalUnits < 0 ||
    context.outputUnits > OKF_SEMANTIC_LIMITS.maxFrontmatterOutputUnits - additionalUnits
  ) {
    return `semantic output exceeds the ${String(OKF_SEMANTIC_LIMITS.maxFrontmatterOutputUnits)}-unit per-document safety limit`;
  }
  context.outputUnits += additionalUnits;
  return undefined;
}

function utf8Length(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

function originalNodeSource(
  value: { readonly range?: readonly number[] | null },
  source: string,
): string {
  const range = value.range;
  return range === undefined || range === null ? '' : source.slice(range[0], range[1]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown YAML parser failure';
}
