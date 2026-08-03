import { isMap, parseDocument } from 'yaml';

import type { OperationProblem, OperationResult } from '../model/index.js';
import { parseBundle } from '../parser/index.js';
import {
  normalizeConceptPath,
  normalizeIndexPath,
  preserveProviderConceptPath,
  preserveProviderIndexPath,
} from '../templates/path.js';
import { mergeManagedRegion } from './managed-region.js';
import {
  INDEX_END_MARKER,
  INDEX_START_MARKER,
  type IndexEntry,
  renderManagedIndexRegion,
  renderNewIndexDocument,
} from './render.js';

export type IndexGenerationMode = 'missing-indexes-only' | 'update-all';

export interface IndexConceptInput {
  readonly relativePath: string;
  readonly title?: string;
  readonly description?: string;
}

export interface ExistingIndexInput {
  readonly relativePath: string;
  readonly content: string;
}

export interface IndexPlanInput {
  readonly mode: IndexGenerationMode;
  readonly concepts: readonly IndexConceptInput[];
  readonly existingIndexes: readonly ExistingIndexInput[];
}

export interface IndexChange {
  readonly relativePath: string;
  readonly operation: 'create' | 'update';
  readonly encoding: 'utf8';
  readonly proposedText: string;
  readonly previousText?: string;
}

export interface IndexPlan {
  readonly mode: IndexGenerationMode;
  readonly changes: readonly IndexChange[];
}

interface NormalizedConcept extends IndexConceptInput {
  readonly relativePath: string;
}

interface IndexPathNormalizers {
  readonly concept: typeof normalizeConceptPath;
  readonly index: typeof normalizeIndexPath;
}

function failure(code: string, message: string, correctiveAction: string): OperationResult<never> {
  const item: OperationProblem = { code, message, correctiveAction };
  return { ok: false, problems: [item] };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function preferredTextNewline(text: string): '\n' | '\r\n' | '\r' {
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\n') {
      return '\n';
    }
    if (character === '\r') {
      return text[index + 1] === '\n' ? '\r\n' : '\r';
    }
  }
  return '\n';
}

function openingDelimiterEnd(text: string): number | undefined {
  const start = text.startsWith('\uFEFF') ? 1 : 0;
  if (text.slice(start, start + 3) !== '---') {
    return undefined;
  }
  const lineEnd = start + 3;
  if (text.startsWith('\r\n', lineEnd)) {
    return lineEnd + 2;
  }
  const terminator = text[lineEnd];
  return terminator === '\n' || terminator === '\r' ? lineEnd + 1 : undefined;
}

function parseRootIndex(text: string) {
  return parseBundle({
    rootUri: 'okf-workbench://index-planner',
    revision: 0,
    documents: [
      {
        uri: 'okf-workbench://index-planner/index.md',
        bundlePath: 'index.md',
        content: text,
      },
    ],
  });
}

function synthesisFailure(message: string): OperationResult<never> {
  return failure(
    'root-version-synthesis-refused',
    `index.md: ${message}`,
    'Repair the root index frontmatter, validate the bundle, and regenerate indexes again.',
  );
}

function insertVersionIntoExistingFrontmatter(
  existingText: string,
  source: string,
): OperationResult<string> {
  const yamlStart = openingDelimiterEnd(existingText);
  if (yamlStart === undefined) {
    return synthesisFailure(
      'The root frontmatter opening delimiter could not be preserved safely.',
    );
  }

  const parserSource = source.replace(/\r(?!\n)/gu, '\n');
  const document = parseDocument(parserSource, {
    intAsBigInt: true,
    keepSourceTokens: true,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  const map = document.contents;
  const token = isMap(map) ? map.srcToken : undefined;
  if (document.errors.length > 0 || token === undefined) {
    return synthesisFailure('The root frontmatter layout could not be preserved safely.');
  }

  let offset: number;
  let insertion: string;
  if (token.type === 'block-map') {
    offset = token.offset;
    const newline = preferredTextNewline(source);
    insertion = `okf_version: "0.2"${newline}${' '.repeat(token.indent)}`;
  } else if (token.type === 'flow-collection' && token.start.type === 'flow-map-start') {
    const flowEnd = token.end.find((item) => item.type === 'flow-map-end');
    if (flowEnd === undefined) {
      return synthesisFailure('The root flow mapping has no safe closing boundary.');
    }
    offset = token.start.offset + token.start.source.length;
    const retainedContent = source.slice(offset, flowEnd.offset);
    const separator =
      retainedContent.trim().length === 0 ? '' : retainedContent.startsWith('#') ? ', ' : ',';
    insertion = `okf_version: "0.2"${separator}`;
  } else {
    return synthesisFailure('The root frontmatter mapping style is not safely editable.');
  }

  if (offset < 0 || offset > source.length) {
    return synthesisFailure('The root frontmatter source boundary is invalid.');
  }
  const insertAt = yamlStart + offset;
  const proposedText = `${existingText.slice(0, insertAt)}${insertion}${existingText.slice(insertAt)}`;
  const verified = parseRootIndex(proposedText);
  const verifiedRoot = verified.reservedDocuments.find(
    (document) => document.source.bundlePath === 'index.md',
  );
  if (verified.failures.length > 0 || verifiedRoot?.frontmatter?.raw.okf_version !== '0.2') {
    return synthesisFailure('The proposed root declaration did not pass validation.');
  }
  return { ok: true, value: proposedText, warnings: [] };
}

/** Adds only the missing root declaration while preserving all existing source text verbatim. */
function synthesizeRootOkfVersion(existingText: string): OperationResult<string> {
  const parsed = parseRootIndex(existingText);
  const parseFailure = parsed.failures[0];
  if (parseFailure !== undefined) {
    return synthesisFailure(parseFailure.message);
  }

  const rootIndex = parsed.reservedDocuments.find(
    (document) => document.source.bundlePath === 'index.md',
  );
  if (rootIndex === undefined) {
    return synthesisFailure('The existing root index could not be inspected safely.');
  }

  if (rootIndex.frontmatter !== undefined) {
    if (Object.hasOwn(rootIndex.frontmatter.raw, 'okf_version')) {
      return { ok: true, value: existingText, warnings: [] };
    }
    return insertVersionIntoExistingFrontmatter(existingText, rootIndex.frontmatter.source);
  }

  const bom = existingText.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom.length === 0 ? existingText : existingText.slice(1);
  const newline = preferredTextNewline(body);
  const frontmatter = `---${newline}okf_version: "0.2"${newline}---${newline}`;
  const proposedText = `${bom}${frontmatter}${body}`;
  const verified = parseRootIndex(proposedText);
  const verifiedRoot = verified.reservedDocuments.find(
    (document) => document.source.bundlePath === 'index.md',
  );
  if (verified.failures.length > 0 || verifiedRoot?.frontmatter?.raw.okf_version !== '0.2') {
    return synthesisFailure('The proposed root declaration did not pass validation.');
  }
  return { ok: true, value: proposedText, warnings: [] };
}

function directoryOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/');
  return slash === -1 ? '' : relativePath.slice(0, slash);
}

function filenameOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/');
  return slash === -1 ? relativePath : relativePath.slice(slash + 1);
}

function indexPathFor(directoryPath: string): string {
  return directoryPath.length === 0 ? 'index.md' : `${directoryPath}/index.md`;
}

function addDirectoryAndAncestors(directories: Set<string>, directoryPath: string): void {
  directories.add('');
  if (directoryPath.length === 0) {
    return;
  }

  const segments = directoryPath.split('/');
  for (let index = 1; index <= segments.length; index += 1) {
    directories.add(segments.slice(0, index).join('/'));
  }
}

function entriesByDirectory(
  concepts: readonly NormalizedConcept[],
  directories: ReadonlySet<string>,
): ReadonlyMap<string, readonly IndexEntry[]> {
  const conceptEntries = new Map<string, NormalizedConcept[]>();
  for (const concept of concepts) {
    const directory = directoryOf(concept.relativePath);
    const current = conceptEntries.get(directory);
    if (current === undefined) {
      conceptEntries.set(directory, [concept]);
    } else {
      current.push(concept);
    }
  }

  const childDirectories = new Map<string, string[]>();
  for (const directory of directories) {
    if (directory.length === 0) {
      continue;
    }
    const parent = directoryOf(directory);
    const name = filenameOf(directory);
    const current = childDirectories.get(parent);
    if (current === undefined) {
      childDirectories.set(parent, [name]);
    } else {
      current.push(name);
    }
  }

  const indexed = new Map<string, readonly IndexEntry[]>();
  for (const directory of directories) {
    const conceptsInDirectory = conceptEntries.get(directory) ?? [];
    conceptsInDirectory.sort((left, right) => compareText(left.relativePath, right.relativePath));
    const directConcepts: IndexEntry[] = conceptsInDirectory.map((concept) => ({
      kind: 'concept',
      filename: filenameOf(concept.relativePath),
      ...(concept.title === undefined ? {} : { title: concept.title }),
      ...(concept.description === undefined ? {} : { description: concept.description }),
    }));
    const directDirectories: IndexEntry[] = (childDirectories.get(directory) ?? [])
      .sort(compareText)
      .map((name) => ({ kind: 'directory', name }));
    indexed.set(directory, [...directConcepts, ...directDirectories]);
  }
  return indexed;
}

function normalizeInputs(
  input: IndexPlanInput,
  paths: IndexPathNormalizers,
): OperationResult<{
  readonly concepts: readonly NormalizedConcept[];
  readonly indexes: ReadonlyMap<string, ExistingIndexInput>;
  readonly directories: ReadonlySet<string>;
}> {
  if (input.mode !== 'missing-indexes-only' && input.mode !== 'update-all') {
    return failure(
      'unknown-index-mode',
      `Unknown index generation mode: ${JSON.stringify(input.mode)}.`,
      'Choose missing-indexes-only or update-all.',
    );
  }

  const concepts: NormalizedConcept[] = [];
  const conceptPaths = new Set<string>();
  const directories = new Set<string>();
  for (const concept of input.concepts) {
    const path = paths.concept(concept.relativePath);
    if (!path.ok) {
      return path;
    }

    if (conceptPaths.has(path.value)) {
      return failure(
        'duplicate-concept-path',
        `The concept path ${JSON.stringify(path.value)} appears more than once.`,
        'Supply each concept file once before planning indexes.',
      );
    }

    conceptPaths.add(path.value);
    const normalized: NormalizedConcept = {
      relativePath: path.value,
      ...(concept.title === undefined ? {} : { title: concept.title }),
      ...(concept.description === undefined ? {} : { description: concept.description }),
    };
    concepts.push(normalized);
    addDirectoryAndAncestors(directories, directoryOf(path.value));
  }

  const indexes = new Map<string, ExistingIndexInput>();
  for (const index of input.existingIndexes) {
    const path = paths.index(index.relativePath);
    if (!path.ok) {
      return path;
    }

    if (indexes.has(path.value)) {
      return failure(
        'duplicate-index-path',
        `The index path ${JSON.stringify(path.value)} appears more than once.`,
        'Supply each existing index once before planning changes.',
      );
    }

    indexes.set(path.value, { relativePath: path.value, content: index.content });
    addDirectoryAndAncestors(directories, directoryOf(path.value));
  }

  addDirectoryAndAncestors(directories, '');
  return { ok: true, value: { concepts, indexes, directories }, warnings: [] };
}

function compareIndexPath(left: string, right: string): number {
  const leftDepth = left.split('/').length;
  const rightDepth = right.split('/').length;
  return leftDepth - rightDepth || compareText(left, right);
}

function planWithPaths(
  input: IndexPlanInput,
  paths: IndexPathNormalizers,
): OperationResult<IndexPlan> {
  const normalized = normalizeInputs(input, paths);
  if (!normalized.ok) {
    return normalized;
  }

  const changes: IndexChange[] = [];
  const directoryPaths = [...normalized.value.directories].sort(compareIndexPath);
  const indexedEntries = entriesByDirectory(
    normalized.value.concepts,
    normalized.value.directories,
  );
  for (const directoryPath of directoryPaths) {
    const relativePath = indexPathFor(directoryPath);
    const entries = indexedEntries.get(directoryPath) ?? [];
    const existing = normalized.value.indexes.get(relativePath);
    if (existing === undefined) {
      changes.push({
        relativePath,
        operation: 'create',
        encoding: 'utf8',
        proposedText: renderNewIndexDocument(directoryPath, entries),
      });
      continue;
    }

    let preparedText = existing.content;
    if (relativePath === 'index.md') {
      const versioned = synthesizeRootOkfVersion(preparedText);
      if (!versioned.ok) {
        return versioned;
      }
      preparedText = versioned.value;
    }

    if (input.mode === 'missing-indexes-only') {
      if (preparedText !== existing.content) {
        changes.push({
          relativePath,
          operation: 'update',
          encoding: 'utf8',
          proposedText: preparedText,
          previousText: existing.content,
        });
      }
      continue;
    }

    const merged = mergeManagedRegion({
      existingText: preparedText,
      renderedRegion: renderManagedIndexRegion(entries),
      markers: {
        start: INDEX_START_MARKER,
        end: INDEX_END_MARKER,
        name: 'OKF index',
      },
      appendWhenMissing: true,
    });
    if (!merged.ok) {
      return {
        ok: false,
        problems: merged.problems.map((item) => ({
          ...item,
          message: `${relativePath}: ${item.message}`,
        })),
      };
    }

    if (merged.value !== existing.content) {
      changes.push({
        relativePath,
        operation: 'update',
        encoding: 'utf8',
        proposedText: merged.value,
        previousText: existing.content,
      });
    }
  }

  return { ok: true, value: { mode: input.mode, changes }, warnings: [] };
}

/** Produces a plan from generated or user-normalized paths. Encoded input is decoded and checked. */
export function planIndexes(input: IndexPlanInput): OperationResult<IndexPlan> {
  return planWithPaths(input, { concept: normalizeConceptPath, index: normalizeIndexPath });
}

/** Produces a plan from provider enumeration while preserving literal percent-bearing names. */
export function planProviderIndexes(input: IndexPlanInput): OperationResult<IndexPlan> {
  return planWithPaths(input, {
    concept: preserveProviderConceptPath,
    index: preserveProviderIndexPath,
  });
}
