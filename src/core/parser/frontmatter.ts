import {
  isAlias,
  isMap,
  isNode,
  isPair,
  isScalar,
  isSeq,
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
import type { SourceRangeIndex } from './source-range.js';

export type FrontmatterResult =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'success';
      readonly frontmatter: ParsedFrontmatter;
      readonly body: string;
      readonly bodyStart: number;
    }
  | { readonly kind: 'failure'; readonly message: string; readonly range: SourceRange };

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

export function parseFrontmatter(text: string, ranges: SourceRangeIndex): FrontmatterResult {
  const region = findFrontmatterRegion(text);
  if (region.kind !== 'success') {
    if (region.kind === 'absent') {
      return region;
    }
    return {
      kind: 'failure',
      message: region.message,
      range: ranges.range(region.start, region.end),
    };
  }

  const source = text.slice(region.yamlStart, region.yamlEnd);
  // yaml's lexer accepts LF and CRLF, while CommonMark also treats a lone CR as a line ending.
  // Replacing only lone CR characters preserves every UTF-16 offset used by diagnostics.
  const parserSource = source.replace(/\r(?!\n)/gu, '\n');
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
      return {
        kind: 'failure',
        message: `YAML frontmatter is not JSON-safe: ${converted.message}`,
        range: ranges.range(region.yamlStart, region.yamlEnd),
      };
    }

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
      source,
      range: ranges.range(region.yamlStart, region.yamlEnd),
      fields,
      normalized: normalizeFrontmatter(converted.value),
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

function normalizeFrontmatter(raw: JsonObject): NormalizedFrontmatter {
  const tags = semanticValue(raw.tags);
  return {
    ...optionalString('type', raw.type),
    ...optionalString('title', raw.title),
    ...optionalString('description', raw.description),
    ...optionalString('resource', raw.resource),
    tags: Array.isArray(tags) && tags.every((tag) => typeof tag === 'string') ? [...tags] : [],
    ...optionalString('timestamp', raw.timestamp),
  };
}

function optionalString<Key extends 'type' | 'title' | 'description' | 'resource' | 'timestamp'>(
  key: Key,
  value: JsonValue | undefined,
): Partial<Record<Key, string>> {
  const semantic = semanticValue(value);
  return typeof semantic === 'string' ? ({ [key]: semantic } as Record<Key, string>) : {};
}

function semanticValue(value: JsonValue | undefined): JsonValue | undefined {
  if (value === undefined || value === null || Array.isArray(value) || typeof value !== 'object') {
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
  return typeof detailsObject.tag === 'string' && typeof detailsObject.source === 'string'
    ? detailsObject.value
    : value;
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
  readonly ancestors: Set<object>;
  readonly document: Document;
  readonly source: string;
}

function toJsonValue(value: unknown, context: YamlConversionContext): JsonConversion<JsonValue> {
  if (value === null) {
    return { ok: true, value: null };
  }

  if (!isNode(value)) {
    return { ok: false, message: 'custom YAML object types are not supported' };
  }

  if (isAlias(value)) {
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

  return {
    ok: true,
    value: {
      [YAML_TAGGED_VALUE_KEY]: {
        tag: value.tag,
        value: converted.value,
        source: originalNodeSource(value, context.source),
      },
    },
  };
}

function convertNodeContent(
  value: Node,
  context: YamlConversionContext,
): JsonConversion<JsonValue> {
  if (isScalar(value)) {
    return toJsonScalar(value.value, value.tag);
  }
  if (isMap(value)) {
    return value.tag === YAML_SET_TAG ? toJsonSet(value, context) : toJsonMapping(value, context);
  }
  if (isSeq(value)) {
    return toJsonSequence(value, context);
  }
  return { ok: false, message: 'custom YAML object types are not supported' };
}

function toJsonScalar(value: unknown, tag: string | undefined): JsonConversion<JsonValue> {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return { ok: true, value };
  }
  if (typeof value === 'number') {
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
    if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return { ok: true, value: Number(value) };
    }
    return {
      ok: true,
      value: { [EXACT_YAML_INTEGER_KEY]: value.toString(10) },
    };
  }

  if (value instanceof Date) {
    if (tag !== YAML_TIMESTAMP_TAG || !Number.isFinite(value.getTime())) {
      return { ok: false, message: 'custom YAML object types are not supported' };
    }
    return { ok: true, value: value.toISOString() };
  }

  if (value instanceof Uint8Array) {
    if (tag !== YAML_BINARY_TAG) {
      return { ok: false, message: 'custom YAML object types are not supported' };
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
