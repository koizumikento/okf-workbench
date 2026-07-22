import type {
  Concept,
  ConceptLink,
  ParseFailure,
  ParsedBundle,
  ReservedDocument,
  SourceDocument,
} from '../model/index.js';
import { parseFrontmatter } from './frontmatter.js';
import { extractMarkdownLinks, type MarkdownLinkCandidate } from './markdown.js';
import {
  canonicalizeBundlePath,
  conceptIdFromBundlePath,
  directoryPathsForDocument,
  resolveLinkTarget,
} from './paths.js';
import { SourceRangeIndex } from './source-range.js';
import type { BundleDocumentInput, ParseBundleInput } from './types.js';

interface PendingConcept {
  readonly concept: Omit<Concept, 'links'>;
  readonly candidates: readonly MarkdownLinkCandidate[];
}

interface CanonicalInput {
  readonly input: BundleDocumentInput;
  readonly bundlePath: string;
}

/** Parse an enumerated logical bundle without accessing a filesystem or editor API. */
export function parseBundle(input: ParseBundleInput): ParsedBundle {
  const failures: ParseFailure[] = [];
  const pendingConcepts: PendingConcept[] = [];
  const reservedDocuments: ReservedDocument[] = [];
  const reservedPaths = new Set<string>();
  const directories = new Set<string>(['']);
  const canonicalInputs: CanonicalInput[] = [];

  for (const document of input.documents) {
    if (!document.bundlePath.replace(/\\/gu, '/').endsWith('.md')) {
      continue;
    }
    const canonical = canonicalizeBundlePath(document.bundlePath);
    if (!canonical.ok) {
      failures.push({
        kind: 'parse-failure',
        uri: document.uri,
        bundlePath: document.bundlePath,
        reason: 'read',
        message: canonical.message,
      });
      continue;
    }
    canonicalInputs.push({ input: document, bundlePath: canonical.path });
    for (const directory of directoryPathsForDocument(canonical.path)) {
      directories.add(directory);
    }
  }

  canonicalInputs.sort(
    (left, right) =>
      compareStrings(left.bundlePath, right.bundlePath) ||
      compareStrings(left.input.uri, right.input.uri),
  );

  const seenPaths = new Set<string>();
  for (const canonical of canonicalInputs) {
    if (seenPaths.has(canonical.bundlePath)) {
      failures.push({
        kind: 'parse-failure',
        uri: canonical.input.uri,
        bundlePath: canonical.bundlePath,
        reason: 'read',
        message: 'Multiple enumerated documents normalize to the same bundle path.',
      });
      continue;
    }
    seenPaths.add(canonical.bundlePath);

    const source: SourceDocument = {
      uri: canonical.input.uri,
      bundlePath: canonical.bundlePath,
      contentHash: canonical.input.contentHash ?? fallbackContentHash(canonical.input.content),
    };
    const reservedKind = classifyReservedDocument(canonical.bundlePath);
    if (reservedKind !== undefined) {
      reservedPaths.add(canonical.bundlePath);
    }
    const conceptId =
      reservedKind === undefined ? conceptIdFromBundlePath(canonical.bundlePath) : undefined;

    if (reservedKind === undefined && conceptId === undefined) {
      failures.push({
        kind: 'parse-failure',
        uri: source.uri,
        bundlePath: source.bundlePath,
        reason: 'read',
        message:
          'Concept Markdown filename must have a non-empty stem before `.md`; rename the document.',
      });
      continue;
    }

    const decoded = decodeDocument(canonical.input.content);
    if (!decoded.ok) {
      failures.push({
        kind: 'parse-failure',
        uri: source.uri,
        bundlePath: source.bundlePath,
        reason: 'decode',
        message: decoded.message,
      });
      if (conceptId !== undefined) {
        pendingConcepts.push(partialPendingConcept(conceptId, source, new SourceRangeIndex('')));
      }
      continue;
    }

    const text = decoded.text.startsWith('\uFEFF') ? decoded.text.slice(1) : decoded.text;
    const ranges = new SourceRangeIndex(text);

    if (reservedKind !== undefined) {
      const parsed = parseFrontmatter(text, ranges);
      if (parsed.kind === 'failure') {
        failures.push({
          kind: 'parse-failure',
          uri: source.uri,
          bundlePath: source.bundlePath,
          reason: 'frontmatter',
          message: parsed.message,
          range: parsed.range,
        });
        continue;
      }
      if (parsed.kind === 'success') {
        const declaredVersion = parsed.frontmatter.raw.okf_version;
        reservedDocuments.push({
          kind: 'reserved',
          reservedKind,
          source,
          body: parsed.body,
          bodyRange: ranges.range(parsed.bodyStart, text.length),
          frontmatter: parsed.frontmatter,
          ...(canonical.bundlePath === 'index.md' && typeof declaredVersion === 'string'
            ? { okfVersion: declaredVersion }
            : {}),
        });
        continue;
      }

      reservedDocuments.push({
        kind: 'reserved',
        reservedKind,
        source,
        body: text,
        bodyRange: ranges.range(0, text.length),
      });
      continue;
    }

    if (conceptId === undefined) {
      continue;
    }

    const parsed = parseFrontmatter(text, ranges);
    if (parsed.kind !== 'success') {
      failures.push({
        kind: 'parse-failure',
        uri: source.uri,
        bundlePath: source.bundlePath,
        reason: 'frontmatter',
        message:
          parsed.kind === 'failure'
            ? parsed.message
            : 'Concept Markdown requires YAML frontmatter.',
        ...(parsed.kind === 'failure'
          ? { range: parsed.range }
          : { range: ranges.range(0, firstLineEnd(text)) }),
      });
      pendingConcepts.push(partialPendingConcept(conceptId, source, ranges));
      continue;
    }

    const markdown = extractMarkdownLinks(parsed.body, parsed.bodyStart, ranges);
    if (!markdown.ok) {
      failures.push({
        kind: 'parse-failure',
        uri: source.uri,
        bundlePath: source.bundlePath,
        reason: 'markdown',
        message: markdown.message,
        range: markdown.range,
      });
      pendingConcepts.push(partialPendingConcept(conceptId, source, ranges));
      continue;
    }

    const normalized = parsed.frontmatter.normalized;
    pendingConcepts.push({
      concept: {
        kind: 'concept',
        id: conceptId,
        source,
        frontmatter: parsed.frontmatter,
        type: normalized.type ?? '',
        ...(normalized.title === undefined ? {} : { title: normalized.title }),
        ...(normalized.description === undefined ? {} : { description: normalized.description }),
        ...(normalized.resource === undefined ? {} : { resource: normalized.resource }),
        tags: normalized.tags,
        ...(normalized.timestamp === undefined ? {} : { timestamp: normalized.timestamp }),
        body: parsed.body,
        bodyRange: ranges.range(parsed.bodyStart, text.length),
      },
      candidates: markdown.links,
    });
  }

  const conceptIdsByPath = new Map(
    pendingConcepts.map(({ concept }) => [concept.source.bundlePath, concept.id] as const),
  );
  const inventory = { conceptIdsByPath, directories, reservedPaths };
  const concepts: Concept[] = pendingConcepts.map(({ concept, candidates }) => ({
    ...concept,
    links: candidates.map((candidate): ConceptLink => {
      const resolved = resolveLinkTarget(candidate.rawTarget, concept.source.bundlePath, inventory);
      return {
        sourceId: concept.id,
        rawTarget: candidate.rawTarget,
        label: candidate.label,
        classification: resolved.classification,
        range: candidate.range,
        ...(resolved.targetId === undefined ? {} : { targetId: resolved.targetId }),
        ...(resolved.fragment === undefined ? {} : { fragment: resolved.fragment }),
        ...(resolved.query === undefined ? {} : { query: resolved.query }),
      };
    }),
  }));

  concepts.sort((left, right) => compareStrings(left.id, right.id));
  reservedDocuments.sort((left, right) =>
    compareStrings(left.source.bundlePath, right.source.bundlePath),
  );
  failures.sort(
    (left, right) =>
      compareStrings(left.bundlePath, right.bundlePath) ||
      compareStrings(left.uri, right.uri) ||
      compareStrings(left.reason, right.reason),
  );

  return {
    rootUri: input.rootUri,
    revision: input.revision,
    concepts,
    reservedDocuments,
    failures,
    findings: [],
  };
}

function decodeDocument(
  content: string | Uint8Array,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string } {
  if (typeof content === 'string') {
    return { ok: true, text: content };
  }
  try {
    return {
      ok: true,
      text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(content),
    };
  } catch {
    return {
      ok: false,
      message: 'Document bytes are not valid UTF-8.',
    };
  }
}

function fallbackContentHash(content: string | Uint8Array): string {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function classifyReservedDocument(bundlePath: string): 'index' | 'log' | undefined {
  const separator = bundlePath.lastIndexOf('/');
  const name = separator < 0 ? bundlePath : bundlePath.slice(separator + 1);
  return name === 'index.md' ? 'index' : name === 'log.md' ? 'log' : undefined;
}

/** Retains source identity after a source-scoped failure without presenting unparsed data as valid. */
function partialPendingConcept(
  id: string,
  source: SourceDocument,
  ranges: SourceRangeIndex,
): PendingConcept {
  const emptyRange = ranges.range(0, 0);
  return {
    concept: {
      kind: 'concept',
      id,
      source,
      frontmatter: {
        raw: {},
        source: '',
        range: emptyRange,
        fields: {},
        normalized: { tags: [] },
      },
      type: '',
      tags: [],
      body: '',
      bodyRange: emptyRange,
    },
    candidates: [],
  };
}

function firstLineEnd(text: string): number {
  for (let offset = 0; offset < text.length; offset += 1) {
    const code = text.charCodeAt(offset);
    if (code === 0x0a) {
      return offset + 1;
    }
    if (code === 0x0d) {
      return offset + (text.charCodeAt(offset + 1) === 0x0a ? 2 : 1);
    }
  }
  return text.length;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
