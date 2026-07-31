import type {
  Concept,
  Finding,
  FindingCategory,
  ParsedBundle,
  ParseFailure,
  ReservedDocument,
  SourcePosition,
  SourceRange,
} from '../model/index.js';
import { OKF_SEMANTIC_LIMITS } from '../model/resource-limits.js';
import {
  countFencedCodeBlocksInTopLevelSection,
  extractMarkdownHeadings,
} from '../parser/markdown.js';
import { isValidActor, semanticFrontmatterStringAt } from '../parser/frontmatter.js';
import { SourceRangeIndex } from '../parser/source-range.js';

export interface ValidationOptions {
  /** Reference time for future-time and staleness checks. Every caller must inject it. */
  readonly now: Date | string;
}

export const VALIDATION_CODES = {
  decode: 'okf.conformance.utf8-decode',
  frontmatter: 'okf.conformance.frontmatter',
  markdown: 'okf.conformance.markdown',
  read: 'okf.conformance.read',
  resourceLimit: 'okf.conformance.resource-limit',
  conceptType: 'okf.conformance.concept-type',
  reservedFrontmatter: 'okf.conformance.reserved-frontmatter',
  indexStructure: 'okf.conformance.index-structure',
  logStructure: 'okf.conformance.log-structure',
  brokenLink: 'okf.curation.broken-link',
  invalidLink: 'okf.curation.invalid-link',
  outOfBundleLink: 'okf.curation.out-of-bundle-link',
  orphanConcept: 'okf.curation.orphan-concept',
  missingTitle: 'okf.curation.missing-title',
  missingDescription: 'okf.curation.missing-description',
  invalidTimestamp: 'okf.curation.invalid-timestamp',
  futureTimestamp: 'okf.curation.future-timestamp',
  invalidGenerated: 'okf.curation.invalid-generated',
  futureGeneratedAt: 'okf.curation.future-generated-at',
  invalidVerified: 'okf.curation.invalid-verified',
  futureVerifiedAt: 'okf.curation.future-verified-at',
  invalidStatus: 'okf.curation.invalid-status',
  invalidStaleAfter: 'okf.curation.invalid-stale-after',
  staleConcept: 'okf.curation.stale-concept',
  invalidSources: 'okf.curation.invalid-sources',
  invalidUsageWindow: 'okf.curation.invalid-usage-window',
  invalidAttestedComputation: 'okf.curation.invalid-attested-computation',
  duplicateResource: 'okf.curation.duplicate-resource',
  futureMinorVersion: 'okf.compatibility.future-minor-version',
  unsupportedVersion: 'okf.compatibility.unsupported-version',
} as const;

const FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;

const categoryOrder: Readonly<Record<FindingCategory, number>> = {
  conformance: 0,
  curation: 1,
  compatibility: 2,
};

/**
 * Validates a parsed bundle without mutating it.
 *
 * Parser findings are retained, then de-duplicated with findings derived here.
 * The required `options.now` keeps time and staleness evaluation deterministic.
 */
export function validateBundle(
  bundle: ParsedBundle,
  options: ValidationOptions,
): readonly Finding[] {
  const findings: Finding[] = [...bundle.findings];
  const nowMs = parseReferenceTime(options.now);
  const concepts = [...bundle.concepts].sort(compareConcepts);
  const failedConceptSources = indexFailedSources(bundle.failures);
  const failedConceptIds = new Set(
    concepts
      .filter(
        (concept) =>
          failedConceptSources
            .get(concept.source.uri)
            ?.has(normalizeBundlePath(concept.source.bundlePath)) === true,
      )
      .map((concept) => concept.id),
  );
  const fullyParsedConcepts = concepts.filter((concept) => !failedConceptIds.has(concept.id));

  for (const failure of bundle.failures) {
    findings.push(findingForParseFailure(failure));
  }

  for (const concept of fullyParsedConcepts) {
    validateConceptConformance(concept, findings);
    validateConceptLinks(concept, findings);
    validateRecommendedMetadata(concept, nowMs, findings);
    validateV02Metadata(concept, nowMs, findings);
  }

  validateOrphans(concepts, failedConceptIds, findings);
  validateDuplicateResources(fullyParsedConcepts, findings);

  for (const reserved of [...bundle.reservedDocuments].sort(compareReservedDocuments)) {
    validateReservedDocument(reserved, findings);
  }

  return sortAndDedupeFindings(findings);
}

function parseReferenceTime(now: Date | string): number {
  const value = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(value)) {
    throw new TypeError('ValidationOptions.now must be a valid Date or ISO date-time string.');
  }
  return value;
}

function findingForParseFailure(failure: ParseFailure): Finding {
  const details: Readonly<Record<ParseFailure['reason'], { code: string; action: string }>> = {
    decode: {
      code: VALIDATION_CODES.decode,
      action: 'Save the document as valid UTF-8 and validate the bundle again.',
    },
    frontmatter: {
      code: VALIDATION_CODES.frontmatter,
      action: 'Add or repair the YAML frontmatter block at the start of the concept document.',
    },
    markdown: {
      code: VALIDATION_CODES.markdown,
      action: 'Repair the Markdown so the document can be consumed.',
    },
    read: {
      code: VALIDATION_CODES.read,
      action: 'Make the document readable and validate the bundle again.',
    },
    'resource-limit': {
      code: VALIDATION_CODES.resourceLimit,
      action: 'Reduce or split the document or bundle, then validate it again.',
    },
  };
  const detail = details[failure.reason];

  return {
    code: detail.code,
    category: 'conformance',
    severity: 'error',
    uri: failure.uri,
    ...(failure.range === undefined ? {} : { range: failure.range }),
    message: `OKF conformance: ${failure.message}`,
    correctiveAction: detail.action,
  };
}

function validateConceptConformance(concept: Concept, findings: Finding[]): void {
  if (concept.type.trim().length > 0) {
    return;
  }

  findings.push({
    code: VALIDATION_CODES.conceptType,
    category: 'conformance',
    severity: 'error',
    uri: concept.source.uri,
    range: concept.frontmatter.fields.type ?? concept.frontmatter.range,
    message: 'OKF conformance: concept frontmatter must contain a non-empty string `type` field.',
    correctiveAction:
      'Set `type` to a descriptive, non-empty string. Custom type values are allowed.',
  });
}

function validateConceptLinks(concept: Concept, findings: Finding[]): void {
  for (const link of concept.links) {
    if (link.classification === 'broken') {
      findings.push({
        code: VALIDATION_CODES.brokenLink,
        category: 'curation',
        severity: 'warning',
        uri: concept.source.uri,
        range: link.range,
        message: `OKF curation: internal link target ${quote(link.rawTarget)} does not resolve to a concept.`,
        correctiveAction: 'Create the target concept or update the Markdown link target.',
      });
    } else if (link.classification === 'invalid') {
      findings.push({
        code: VALIDATION_CODES.invalidLink,
        category: 'curation',
        severity: 'warning',
        uri: concept.source.uri,
        range: link.range,
        message: `OKF curation: link target ${quote(link.rawTarget)} cannot be decoded or normalized safely.`,
        correctiveAction:
          'Use a valid Markdown URL with each path segment percent-encoded at most once.',
      });
    } else if (link.classification === 'out-of-bundle') {
      findings.push({
        code: VALIDATION_CODES.outOfBundleLink,
        category: 'curation',
        severity: 'warning',
        uri: concept.source.uri,
        range: link.range,
        message: `OKF curation: link target ${quote(link.rawTarget)} resolves outside the selected bundle.`,
        correctiveAction:
          'Point the link at a concept inside the selected bundle or use an explicit external URL.',
      });
    }
  }
}

function validateRecommendedMetadata(concept: Concept, nowMs: number, findings: Finding[]): void {
  if (!hasNonEmptyText(concept.title)) {
    findings.push({
      code: VALIDATION_CODES.missingTitle,
      category: 'curation',
      severity: 'warning',
      uri: concept.source.uri,
      range: concept.frontmatter.fields.title ?? concept.frontmatter.range,
      message: 'OKF curation: concept is missing the recommended non-empty `title` field.',
      correctiveAction:
        'Add a concise human-readable `title`, or keep the filename fallback intentionally.',
    });
  }

  if (!hasNonEmptyText(concept.description)) {
    findings.push({
      code: VALIDATION_CODES.missingDescription,
      category: 'curation',
      severity: 'warning',
      uri: concept.source.uri,
      range: concept.frontmatter.fields.description ?? concept.frontmatter.range,
      message: 'OKF curation: concept is missing the recommended non-empty `description` field.',
      correctiveAction:
        'Add a one-sentence `description` to improve indexes, search, and previews.',
    });
  }

  if (
    !Object.hasOwn(concept.frontmatter.raw, 'timestamp') ||
    Object.hasOwn(concept.frontmatter.raw, 'generated')
  ) {
    return;
  }

  // Validate the parser's semantic field rather than its source-preserving raw representation.
  // A real explicit YAML tag is retained as a JSON-safe wrapper in `raw`, while non-string
  // mappings, sequences, and unproven wrapper lookalikes are not exposed on the concept.
  const timestampMs =
    concept.timestamp === undefined ? undefined : parseExplicitZoneTimestamp(concept.timestamp);
  if (timestampMs === undefined) {
    findings.push({
      code: VALIDATION_CODES.invalidTimestamp,
      category: 'curation',
      severity: 'warning',
      uri: concept.source.uri,
      range: concept.frontmatter.fields.timestamp ?? concept.frontmatter.range,
      message:
        'OKF curation: `timestamp` must be a valid ISO 8601 date-time with `Z` or a numeric offset.',
      correctiveAction: 'Use an explicit-zone value such as `2026-07-22T09:30:00Z`.',
    });
    return;
  }

  if (timestampMs > nowMs + FUTURE_TOLERANCE_MS) {
    findings.push({
      code: VALIDATION_CODES.futureTimestamp,
      category: 'curation',
      severity: 'warning',
      uri: concept.source.uri,
      range: concept.frontmatter.fields.timestamp ?? concept.frontmatter.range,
      message:
        'OKF curation: `timestamp` is more than five minutes after the validation reference time.',
      correctiveAction:
        'Correct the timestamp or the system clock, then validate the bundle again.',
    });
  }
}

function validateV02Metadata(concept: Concept, nowMs: number, findings: Finding[]): void {
  const raw = concept.frontmatter.raw;
  const generated = raw.generated;
  if (generated !== undefined) {
    const object = asRecord(generated);
    const by = semanticFrontmatterStringAt(concept.frontmatter, ['generated', 'by']);
    const at = semanticFrontmatterStringAt(concept.frontmatter, ['generated', 'at']);
    const atMs = typeof at === 'string' ? parseExplicitZoneTimestamp(at) : undefined;
    if (
      object === undefined ||
      by === undefined ||
      !isValidActor(by) ||
      (Object.hasOwn(object, 'at') && atMs === undefined)
    ) {
      findings.push(
        metadataCuration(
          concept,
          VALIDATION_CODES.invalidGenerated,
          'generated',
          'OKF curation: `generated` must be a mapping with non-empty `by` and an optional explicit-zone `at` date-time.',
          'Use `generated: { by: process:producer, at: 2026-07-31T00:00:00Z }` or remove the malformed optional family.',
        ),
      );
    } else if (atMs !== undefined && atMs > nowMs + FUTURE_TOLERANCE_MS) {
      findings.push(
        metadataCuration(
          concept,
          VALIDATION_CODES.futureGeneratedAt,
          'generated',
          'OKF curation: `generated.at` is more than five minutes after the validation reference time.',
          'Correct the generation time or the system clock, then validate the bundle again.',
        ),
      );
    }
  }

  if (Object.hasOwn(raw, 'verified')) {
    const values = Array.isArray(raw.verified) ? raw.verified : [raw.verified];
    let invalid = values.length === 0;
    let future = false;
    for (const [index, value] of values.entries()) {
      const event = asRecord(value);
      const prefix = Array.isArray(raw.verified) ? ['verified', index] : ['verified'];
      const by = semanticFrontmatterStringAt(concept.frontmatter, [...prefix, 'by']);
      const at = semanticFrontmatterStringAt(concept.frontmatter, [...prefix, 'at']);
      const atMs = typeof at === 'string' ? parseExplicitZoneTimestamp(at) : undefined;
      if (event === undefined || by === undefined || !isValidActor(by) || atMs === undefined) {
        invalid = true;
      } else if (atMs > nowMs + FUTURE_TOLERANCE_MS) {
        future = true;
      }
    }
    if (invalid) {
      findings.push(
        metadataCuration(
          concept,
          VALIDATION_CODES.invalidVerified,
          'verified',
          'OKF curation: `verified` must be one verification mapping or a list of mappings with non-empty `by` and explicit-zone `at`.',
          'Record each verification as `{ by: <actor>, at: <ISO 8601 date-time> }`.',
        ),
      );
    } else if (future) {
      findings.push(
        metadataCuration(
          concept,
          VALIDATION_CODES.futureVerifiedAt,
          'verified',
          'OKF curation: a `verified.at` value is more than five minutes after the validation reference time.',
          'Correct the verification time or the system clock, then validate the bundle again.',
        ),
      );
    }
  }

  if (
    Object.hasOwn(raw, 'status') &&
    concept.status !== 'draft' &&
    concept.status !== 'stable' &&
    concept.status !== 'deprecated'
  ) {
    findings.push(
      metadataCuration(
        concept,
        VALIDATION_CODES.invalidStatus,
        'status',
        'OKF curation: `status` must be `draft`, `stable`, or `deprecated`.',
        'Choose a defined lifecycle status or remove the optional field.',
      ),
    );
  }

  if (Object.hasOwn(raw, 'stale_after')) {
    const staleAfter = concept.staleAfter;
    if (staleAfter === undefined || !isIsoDate(staleAfter)) {
      findings.push(
        metadataCuration(
          concept,
          VALIDATION_CODES.invalidStaleAfter,
          'stale_after',
          'OKF curation: `stale_after` must be an absolute `YYYY-MM-DD` date.',
          'Use a valid absolute date such as `2026-09-23`.',
        ),
      );
    } else if (staleAfter <= new Date(nowMs).toISOString().slice(0, 10)) {
      findings.push(
        metadataCuration(
          concept,
          VALIDATION_CODES.staleConcept,
          'stale_after',
          `OKF curation: concept is stale on or after ${quote(staleAfter)}.`,
          'Review and regenerate or re-verify the concept, then move `stale_after` forward when justified.',
        ),
      );
    }
  }

  if (Object.hasOwn(raw, 'sources')) {
    const sources = raw.sources;
    const valid =
      Array.isArray(sources) &&
      sources.every((source, index) => {
        const object = asRecord(source);
        const normalized = concept.sources?.[index];
        const author = normalized?.author;
        return (
          object !== undefined &&
          typeof normalized?.resource === 'string' &&
          normalized.resource.trim().length > 0 &&
          (!Object.hasOwn(object, 'id') || normalized.id !== undefined) &&
          (!Object.hasOwn(object, 'title') || normalized.title !== undefined) &&
          (author === undefined || isValidActor(author)) &&
          (!Object.hasOwn(object ?? {}, 'author') || author !== undefined) &&
          (!Object.hasOwn(object, 'usage_count') || normalized.usageCount !== undefined) &&
          (!Object.hasOwn(object, 'usage_count') ||
            (Object.hasOwn(object, 'usage_window')
              ? normalized.usageWindow !== undefined && isUsageWindow(normalized.usageWindow)
              : concept.usageWindow !== undefined && isUsageWindow(concept.usageWindow))) &&
          (!Object.hasOwn(object, 'last_modified') ||
            (normalized.lastModified !== undefined && isIsoDate(normalized.lastModified))) &&
          (!Object.hasOwn(object, 'usage_window') ||
            (normalized.usageWindow !== undefined && isUsageWindow(normalized.usageWindow)))
        );
      });
    if (!valid) {
      findings.push(
        metadataCuration(
          concept,
          VALIDATION_CODES.invalidSources,
          'sources',
          'OKF curation: `sources` must be a list whose entries each contain a non-empty `resource`.',
          'Repair the source entries or remove the malformed optional provenance family.',
        ),
      );
    }
  }

  if (
    Object.hasOwn(raw, 'usage_window') &&
    (concept.usageWindow === undefined || !isUsageWindow(concept.usageWindow))
  ) {
    findings.push(
      metadataCuration(
        concept,
        VALIDATION_CODES.invalidUsageWindow,
        'usage_window',
        'OKF curation: `usage_window` must contain valid `from` and `to` dates in ascending order.',
        'Use `{ from: YYYY-MM-DD, to: YYYY-MM-DD }`, or remove the malformed optional window.',
      ),
    );
  }

  if (concept.type === 'Attested Computation') {
    const parameters = raw.parameters;
    const parametersValid =
      parameters === undefined ||
      (Array.isArray(parameters) &&
        parameters.length === (concept.parameters?.length ?? 0) &&
        parameters.every((parameter, index) => {
          const object = asRecord(parameter);
          const normalized = concept.parameters?.[index];
          return (
            object !== undefined &&
            typeof normalized?.name === 'string' &&
            normalized.name.trim().length > 0 &&
            typeof normalized.type === 'string' &&
            normalized.type.trim().length > 0 &&
            Object.hasOwn(object, 'required') &&
            typeof normalized.required === 'boolean'
          );
        }));
    const fileComputation =
      typeof concept.computation === 'string' && concept.computation.trim().length > 0;
    const inlineComputations = inlineComputationCount(concept.body);
    const computationValid = Object.hasOwn(raw, 'computation')
      ? fileComputation && inlineComputations === 0
      : inlineComputations === 1;
    const executorValid = optionalComputationEndpoint(raw.executor, concept.executor, true);
    const attesterValid = optionalComputationEndpoint(raw.attester, concept.attester, false);
    if (
      !hasNonEmptyText(concept.runtime) ||
      !parametersValid ||
      !computationValid ||
      !executorValid ||
      !attesterValid
    ) {
      const field = !hasNonEmptyText(concept.runtime)
        ? 'runtime'
        : !parametersValid
          ? 'parameters'
          : !computationValid
            ? 'computation'
            : !executorValid
              ? 'executor'
              : 'attester';
      findings.push(
        metadataCuration(
          concept,
          VALIDATION_CODES.invalidAttestedComputation,
          field,
          'OKF curation: an Attested Computation needs a runtime, a file or inline fenced computation, valid typed parameters, and well-formed optional executor and attester mappings.',
          'Repair the declarative computation contract before relying on attestation.',
        ),
      );
    }
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function isUsageWindow(value: unknown): boolean {
  const object = asRecord(value);
  return (
    typeof object?.from === 'string' &&
    isIsoDate(object.from) &&
    typeof object.to === 'string' &&
    isIsoDate(object.to) &&
    object.from <= object.to
  );
}

function optionalComputationEndpoint(
  value: unknown,
  normalized: Concept['executor'],
  allowReceipt: boolean,
): boolean {
  if (value === undefined) return true;
  const object = asRecord(value);
  if (
    object === undefined ||
    typeof normalized?.resource !== 'string' ||
    normalized.resource.trim().length === 0
  ) {
    return false;
  }
  if (!allowReceipt) return true;
  return (
    !Object.hasOwn(object, 'receipt') ||
    (Array.isArray(object.receipt) &&
      object.receipt.length === normalized.receipt.length &&
      normalized.receipt.every((field) => field.trim().length > 0))
  );
}

function inlineComputationCount(body: string): number {
  return countFencedCodeBlocksInTopLevelSection(body, 'Computation');
}

function metadataCuration(
  concept: Concept,
  code: string,
  field: string,
  message: string,
  correctiveAction: string,
): Finding {
  return {
    code,
    category: 'curation',
    severity: 'warning',
    uri: concept.source.uri,
    range: concept.frontmatter.fields[field] ?? concept.frontmatter.range,
    message,
    correctiveAction,
  };
}

function validateOrphans(
  concepts: readonly Concept[],
  suppressedConceptIds: ReadonlySet<string>,
  findings: Finding[],
): void {
  const conceptIds = new Set(concepts.map((concept) => concept.id));
  const connectedIds = new Set<string>();

  for (const concept of concepts) {
    if (suppressedConceptIds.has(concept.id)) {
      continue;
    }
    for (const link of concept.links) {
      if (
        link.classification === 'internal' &&
        link.targetId !== undefined &&
        conceptIds.has(link.targetId)
      ) {
        connectedIds.add(concept.id);
        connectedIds.add(link.targetId);
      }
    }
  }

  for (const concept of concepts) {
    if (!connectedIds.has(concept.id) && !suppressedConceptIds.has(concept.id)) {
      findings.push({
        code: VALIDATION_CODES.orphanConcept,
        category: 'curation',
        severity: 'warning',
        uri: concept.source.uri,
        range: concept.frontmatter.fields.type ?? concept.frontmatter.range,
        message: `OKF curation: concept ${quote(concept.id)} has no resolvable incoming or outgoing internal links.`,
        correctiveAction:
          'Link this concept to related bundle knowledge, or keep it isolated intentionally.',
      });
    }
  }
}

function validateDuplicateResources(concepts: readonly Concept[], findings: Finding[]): void {
  const groups = new Map<string, Concept[]>();

  for (const concept of concepts) {
    const resource = concept.resource?.trim();
    if (resource === undefined || resource.length === 0) {
      continue;
    }
    const group = groups.get(resource);
    if (group === undefined) {
      groups.set(resource, [concept]);
    } else {
      group.push(concept);
    }
  }

  for (const [resource, group] of [...groups.entries()].sort(([left], [right]) =>
    compareText(left, right),
  )) {
    if (group.length < 2) {
      continue;
    }
    const sortedGroup = [...group].sort(compareConcepts);
    for (let conceptIndex = 0; conceptIndex < sortedGroup.length; conceptIndex += 1) {
      const concept = sortedGroup[conceptIndex];
      if (concept === undefined) {
        continue;
      }
      const peerIds: string[] = [];
      for (
        let peerIndex = 0;
        peerIndex < sortedGroup.length &&
        peerIds.length < OKF_SEMANTIC_LIMITS.maxDuplicateResourcePeerIds;
        peerIndex += 1
      ) {
        if (peerIndex === conceptIndex) {
          continue;
        }
        const peer = sortedGroup[peerIndex];
        if (peer !== undefined) {
          peerIds.push(boundedDiagnosticText(peer.id));
        }
      }
      const omitted = sortedGroup.length - 1 - peerIds.length;
      const peers = `${peerIds.join(', ')}${omitted > 0 ? `, and ${String(omitted)} more` : ''}`;
      findings.push({
        code: VALIDATION_CODES.duplicateResource,
        category: 'curation',
        severity: 'warning',
        uri: concept.source.uri,
        range: concept.frontmatter.fields.resource ?? concept.frontmatter.range,
        message: `OKF curation: resource ${quote(boundedDiagnosticText(resource))} is also declared by ${peers}.`,
        correctiveAction:
          'Confirm whether these concepts intentionally describe the same exact resource identifier.',
      });
    }
  }
}

function boundedDiagnosticText(value: string): string {
  const maximumCodeUnits = 160;
  if (value.length <= maximumCodeUnits) {
    return value;
  }
  let end = maximumCodeUnits - 1;
  const finalUnit = value.charCodeAt(end - 1);
  if (finalUnit >= 0xd800 && finalUnit <= 0xdbff) {
    end -= 1;
  }
  return `${value.slice(0, end)}…`;
}

function validateReservedDocument(reserved: ReservedDocument, findings: Finding[]): void {
  const isRootIndex = normalizeBundlePath(reserved.source.bundlePath) === 'index.md';

  if (reserved.frontmatter !== undefined && !(reserved.reservedKind === 'index' && isRootIndex)) {
    findings.push({
      code: VALIDATION_CODES.reservedFrontmatter,
      category: 'conformance',
      severity: 'error',
      uri: reserved.source.uri,
      range: reserved.frontmatter.range,
      message: `OKF conformance: ${reserved.reservedKind}.md may not contain YAML frontmatter at this location.`,
      correctiveAction:
        'Remove the frontmatter. Only the bundle-root index.md may declare `okf_version`.',
    });
  }

  if (reserved.reservedKind === 'index') {
    const firstHeading = findFirstMarkdownHeading(reserved.body);
    if (firstHeading === undefined) {
      findings.push({
        code: VALIDATION_CODES.indexStructure,
        category: 'conformance',
        severity: 'error',
        uri: reserved.source.uri,
        range: reserved.bodyRange,
        message: 'OKF conformance: index.md must contain at least one Markdown section heading.',
        correctiveAction:
          "Add a heading and list the directory's concepts or subdirectories beneath it.",
      });
    }
  } else {
    const dateHeadings = findLevelTwoHeadings(reserved.body);
    const invalidDateHeading = dateHeadings.find((heading) => !isIsoDate(heading.text));
    if (dateHeadings.length === 0 || invalidDateHeading !== undefined) {
      const relativeRange = invalidDateHeading?.range;
      findings.push({
        code: VALIDATION_CODES.logStructure,
        category: 'conformance',
        severity: 'error',
        uri: reserved.source.uri,
        range:
          relativeRange === undefined
            ? reserved.bodyRange
            : translateBodyRange(reserved.bodyRange.start, relativeRange),
        message:
          dateHeadings.length === 0
            ? 'OKF conformance: log.md must group entries under `## YYYY-MM-DD` date headings.'
            : `OKF conformance: log.md date heading ${quote(invalidDateHeading?.text ?? '')} is not YYYY-MM-DD.`,
        correctiveAction: 'Use ISO 8601 date headings such as `## 2026-07-22`.',
      });
    }
  }

  if (reserved.reservedKind === 'index' && isRootIndex) {
    validateDeclaredVersion(reserved, findings);
  }
}

function validateDeclaredVersion(reserved: ReservedDocument, findings: Finding[]): void {
  const raw = reserved.frontmatter?.raw;
  if (raw === undefined || !Object.hasOwn(raw, 'okf_version')) {
    return;
  }

  const range = reserved.frontmatter?.fields.okf_version ?? reserved.frontmatter?.range;
  const declaredValue = raw.okf_version;
  const declared = reserved.okfVersion;
  if (declared === undefined) {
    findings.push({
      code: VALIDATION_CODES.unsupportedVersion,
      category: 'compatibility',
      severity: 'warning',
      uri: reserved.source.uri,
      ...(range === undefined ? {} : { range }),
      message: `OKF compatibility: bundle declares a non-string \`okf_version\` (${jsonValueKind(declaredValue)}); reading continues on a best-effort basis.`,
      correctiveAction: 'Declare a supported version as the string `okf_version: "0.2"`.',
    });
    return;
  }

  if (declared === '0.1' || declared === '0.2') {
    return;
  }

  const match = /^(\d+)\.(\d+)$/.exec(declared);
  if (match !== null && Number(match[1]) === 0 && Number(match[2]) > 2) {
    findings.push({
      code: VALIDATION_CODES.futureMinorVersion,
      category: 'compatibility',
      severity: 'information',
      uri: reserved.source.uri,
      ...(range === undefined ? {} : { range }),
      message: `OKF compatibility: bundle declares future minor version ${quote(declared)}; reading continues on a best-effort basis.`,
      correctiveAction:
        'Review producer changes before relying on fields introduced after OKF 0.2.',
    });
    return;
  }

  findings.push({
    code: VALIDATION_CODES.unsupportedVersion,
    category: 'compatibility',
    severity: 'warning',
    uri: reserved.source.uri,
    ...(range === undefined ? {} : { range }),
    message: `OKF compatibility: bundle declares unsupported version ${quote(declared)}; reading continues on a best-effort basis.`,
    correctiveAction:
      'Review the declared OKF version before applying Workbench-generated changes.',
  });
}

function sortAndDedupeFindings(findings: readonly Finding[]): readonly Finding[] {
  const sorted = [...findings].sort(compareFindings);
  const deduped: Finding[] = [];
  let previousKey: string | undefined;

  for (const finding of sorted) {
    const key = findingKey(finding);
    if (key !== previousKey) {
      deduped.push(finding);
      previousKey = key;
    }
  }
  return deduped;
}

function compareFindings(left: Finding, right: Finding): number {
  return (
    compareText(left.uri, right.uri) ||
    compareNumber(left.range?.start.offset, right.range?.start.offset) ||
    compareNumber(left.range?.end.offset, right.range?.end.offset) ||
    categoryOrder[left.category] - categoryOrder[right.category] ||
    compareText(left.code, right.code) ||
    compareText(left.message, right.message)
  );
}

function findingKey(finding: Finding): string {
  return JSON.stringify([
    finding.uri,
    finding.range?.start.offset ?? null,
    finding.range?.end.offset ?? null,
    finding.category,
    finding.severity,
    finding.code,
    finding.message,
    finding.correctiveAction ?? null,
  ]);
}

function parseExplicitZoneTimestamp(value: string): number | undefined {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (match === null) {
    return undefined;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[8] ?? '';
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return undefined;
  }

  if (zone !== 'Z') {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) {
      return undefined;
    }
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

interface RelativeHeading {
  readonly text: string;
  readonly range: SourceRange;
}

function findFirstMarkdownHeading(body: string): RelativeHeading | undefined {
  const ranges = new SourceRangeIndex(body);
  const result = extractMarkdownHeadings(body, 0, ranges);
  return result.ok ? result.headings.at(0) : undefined;
}

function findLevelTwoHeadings(body: string): readonly RelativeHeading[] {
  const ranges = new SourceRangeIndex(body);
  const result = extractMarkdownHeadings(body, 0, ranges);
  return result.ok
    ? result.headings
        .filter((heading) => heading.depth === 2)
        .map(({ text, range }) => ({ text, range }))
    : [];
}

function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function translateBodyRange(bodyStart: SourcePosition, relative: SourceRange): SourceRange {
  return {
    start: translatePosition(bodyStart, relative.start),
    end: translatePosition(bodyStart, relative.end),
  };
}

function translatePosition(bodyStart: SourcePosition, relative: SourcePosition): SourcePosition {
  return {
    offset: bodyStart.offset + relative.offset,
    line: bodyStart.line + relative.line,
    character: relative.line === 0 ? bodyStart.character + relative.character : relative.character,
  };
}

function hasNonEmptyText(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function jsonValueKind(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  return Array.isArray(value) ? 'array' : typeof value;
}

function normalizeBundlePath(bundlePath: string): string {
  return bundlePath.replaceAll('\\', '/').replace(/^\.\//, '');
}

function indexFailedSources(
  failures: readonly ParseFailure[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const index = new Map<string, Set<string>>();
  for (const failure of failures) {
    const path = normalizeBundlePath(failure.bundlePath);
    const paths = index.get(failure.uri);
    if (paths === undefined) {
      index.set(failure.uri, new Set([path]));
    } else {
      paths.add(path);
    }
  }
  return index;
}

function compareConcepts(left: Concept, right: Concept): number {
  return compareText(left.id, right.id) || compareText(left.source.uri, right.source.uri);
}

function compareReservedDocuments(left: ReservedDocument, right: ReservedDocument): number {
  return (
    compareText(
      normalizeBundlePath(left.source.bundlePath),
      normalizeBundlePath(right.source.bundlePath),
    ) || compareText(left.source.uri, right.source.uri)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNumber(left: number | undefined, right: number | undefined): number {
  return (left ?? Number.MAX_SAFE_INTEGER) - (right ?? Number.MAX_SAFE_INTEGER);
}
