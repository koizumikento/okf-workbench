import type {
  Concept,
  ConceptLink,
  JsonValue,
  NormalizedFrontmatter,
  ParseFailure,
  ParsedBundle,
  ReservedDocument,
  SourceDocument,
  SourceRange,
} from '../model/index.js';
import { OKF_SEMANTIC_LIMITS } from '../model/resource-limits.js';
import {
  inspectFrontmatterPreparse,
  parseFrontmatter,
  semanticFrontmatterString,
} from './frontmatter.js';
import {
  extractMarkdownLinks,
  inspectMarkdownComplexity,
  type MarkdownComplexityInspection,
  type MarkdownLinkCandidate,
} from './markdown.js';
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
  readonly contentHashSafe: boolean;
}

const utf8Encoder = new TextEncoder();

/** Parse an enumerated logical bundle without accessing a filesystem or editor API. */
export function parseBundle(input: ParseBundleInput): ParsedBundle {
  const invalidRootUriUnicode = hasUnpairedUtf16Surrogate(input.rootUri);
  const rootUriFailure = invalidRootUriUnicode
    ? 'Bundle root URI contains an unpaired UTF-16 surrogate.'
    : boundedIdentityFailure(
        input.rootUri,
        OKF_SEMANTIC_LIMITS.maxSourceUriCodeUnits,
        OKF_SEMANTIC_LIMITS.maxSourceUriBytes,
        'Bundle root URI',
      );
  if (rootUriFailure !== undefined) {
    return resourceLimitBundle(
      input,
      invalidRootUriUnicode
        ? '<bundle-root-uri-invalid-unicode>'
        : '<bundle-root-uri-exceeds-limit>',
      rootUriFailure,
    );
  }
  if (input.documents.length > OKF_SEMANTIC_LIMITS.maxRuntimeDocuments) {
    return resourceLimitBundle(
      input,
      input.rootUri,
      `Bundle parsing refused more than ${String(OKF_SEMANTIC_LIMITS.maxRuntimeDocuments)} Markdown documents. Reduce or split the bundle, then retry.`,
    );
  }
  const failures: ParseFailure[] = [];
  const pendingConcepts: PendingConcept[] = [];
  const reservedDocuments: ReservedDocument[] = [];
  const reservedPaths = new Set<string>();
  const directories = new Set<string>(['']);
  const canonicalInputs: CanonicalInput[] = [];
  let retainedLinkCount = 0;
  let retainedLinkTextUnits = 0;
  let retainedFrontmatterUnits = 0;
  let inspectedFrontmatterSourceCodeUnits = 0;
  let inspectedFrontmatterStructuralTokens = 0;
  let inspectedMarkdownBodyCodeUnits = 0;
  let inspectedMarkdownLines = 0;
  let inspectedMarkdownAttentionWorkUnits = 0;
  let inspectedMarkdownContainerWorkUnits = 0;
  let inspectedMarkdownLabelEndWorkUnits = 0;
  let inspectedMarkdownSyntaxCandidates = 0;
  let inspectedMarkdownLinkCandidates = 0;
  let retainedTagAssignments = 0;
  const retainedTypes = new Set<string>();
  const retainedTags = new Set<string>();
  let bundleLimitReached = false;

  for (const document of input.documents) {
    const invalidProviderPathUnicode = hasUnpairedUtf16Surrogate(document.bundlePath);
    const invalidUriUnicode = hasUnpairedUtf16Surrogate(document.uri);
    const providerPathFailure = invalidProviderPathUnicode
      ? 'Provider-relative path contains an unpaired UTF-16 surrogate.'
      : boundedIdentityFailure(
          document.bundlePath,
          OKF_SEMANTIC_LIMITS.maxProviderPathCodeUnits,
          OKF_SEMANTIC_LIMITS.maxProviderPathBytes,
          'Provider-relative path',
        );
    const uriFailure = invalidUriUnicode
      ? 'Source URI contains an unpaired UTF-16 surrogate.'
      : boundedIdentityFailure(
          document.uri,
          OKF_SEMANTIC_LIMITS.maxSourceUriCodeUnits,
          OKF_SEMANTIC_LIMITS.maxSourceUriBytes,
          'Source URI',
        );
    if (providerPathFailure !== undefined || uriFailure !== undefined) {
      failures.push({
        kind: 'parse-failure',
        uri:
          uriFailure === undefined
            ? document.uri
            : invalidUriUnicode
              ? '<provider-uri-invalid-unicode>'
              : '<provider-uri-exceeds-limit>',
        bundlePath:
          providerPathFailure === undefined
            ? document.bundlePath
            : invalidProviderPathUnicode
              ? '<provider-path-invalid-unicode>'
              : '<provider-path-exceeds-limit>',
        reason: 'resource-limit',
        scope: 'document',
        message: providerPathFailure ?? uriFailure ?? 'Provider identity exceeds a safety limit.',
      });
      continue;
    }
    if (!document.bundlePath.replace(/\\/gu, '/').endsWith('.md')) {
      continue;
    }
    const canonical = canonicalizeBundlePath(document.bundlePath);
    if (!canonical.ok) {
      failures.push({
        kind: 'parse-failure',
        uri: document.uri,
        bundlePath:
          canonical.resourceLimit === true ? '<provider-path-exceeds-limit>' : document.bundlePath,
        reason: canonical.resourceLimit === true ? 'resource-limit' : 'read',
        ...(canonical.resourceLimit === true ? { scope: 'document' as const } : {}),
        message: canonical.message,
      });
      continue;
    }
    const invalidContentHashUnicode =
      document.contentHash !== undefined && hasUnpairedUtf16Surrogate(document.contentHash);
    const contentHashSafe =
      document.identityOnlyFailure !== undefined ||
      !(
        document.contentHash !== undefined &&
        (invalidContentHashUnicode ||
          document.contentHash.length > OKF_SEMANTIC_LIMITS.maxContentHashCodeUnits)
      );
    if (!contentHashSafe) {
      failures.push({
        kind: 'parse-failure',
        uri: document.uri,
        bundlePath: canonical.path,
        reason: 'resource-limit',
        scope: 'document',
        message: invalidContentHashUnicode
          ? 'Content identity contains an unpaired UTF-16 surrogate. Refresh the bundle from a conforming provider, then retry.'
          : `Content identity exceeds the ${String(OKF_SEMANTIC_LIMITS.maxContentHashCodeUnits)}-code-unit safety limit. Refresh the bundle from a conforming provider, then retry.`,
      });
    }
    canonicalInputs.push({ input: document, bundlePath: canonical.path, contentHashSafe });
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

    const reservedKind = classifyReservedDocument(canonical.bundlePath);
    if (reservedKind !== undefined) {
      reservedPaths.add(canonical.bundlePath);
    }
    const conceptId =
      reservedKind === undefined ? conceptIdFromBundlePath(canonical.bundlePath) : undefined;

    const identityOnlyFailure = canonical.input.identityOnlyFailure;
    const sourceSizeFailure =
      bundleLimitReached || identityOnlyFailure !== undefined
        ? undefined
        : semanticDocumentSourceFailure(canonical.input.content);
    const safeProvidedHash =
      identityOnlyFailure === undefined && canonical.contentHashSafe
        ? canonical.input.contentHash
        : undefined;
    const source: SourceDocument = {
      uri: canonical.input.uri,
      bundlePath: canonical.bundlePath,
      contentHash:
        safeProvidedHash ??
        (bundleLimitReached ||
        identityOnlyFailure !== undefined ||
        sourceSizeFailure !== undefined ||
        !canonical.contentHashSafe
          ? 'resource-limit:unparsed'
          : fallbackContentHash(canonical.input.content)),
    };

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

    if (identityOnlyFailure !== undefined) {
      failures.push({
        kind: 'parse-failure',
        uri: source.uri,
        bundlePath: source.bundlePath,
        reason: identityOnlyFailure.reason,
        scope: 'document',
        message: boundedFailureMessage(identityOnlyFailure.message),
      });
      if (conceptId !== undefined) {
        pendingConcepts.push(partialPendingConcept(conceptId, source));
      }
      continue;
    }

    if (bundleLimitReached) {
      failures.push({
        kind: 'parse-failure',
        uri: source.uri,
        bundlePath: source.bundlePath,
        reason: 'resource-limit',
        scope: 'document',
        message:
          'Semantic parsing was skipped after the bundle exceeded an aggregate parser-work safety limit.',
      });
      if (conceptId !== undefined) {
        pendingConcepts.push(partialPendingConcept(conceptId, source));
      }
      continue;
    }
    if (!canonical.contentHashSafe) {
      if (conceptId !== undefined) {
        pendingConcepts.push(partialPendingConcept(conceptId, source));
      }
      continue;
    }
    if (sourceSizeFailure !== undefined) {
      failures.push({
        kind: 'parse-failure',
        uri: source.uri,
        bundlePath: source.bundlePath,
        reason: 'resource-limit',
        scope: 'document',
        message: sourceSizeFailure,
      });
      if (conceptId !== undefined) {
        pendingConcepts.push(partialPendingConcept(conceptId, source));
      }
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
        pendingConcepts.push(partialPendingConcept(conceptId, source));
      }
      continue;
    }

    const text = decoded.text;
    const documentComplexityFailure = semanticDocumentTextFailure(text);
    if (documentComplexityFailure !== undefined) {
      failures.push({
        kind: 'parse-failure',
        uri: source.uri,
        bundlePath: source.bundlePath,
        reason: 'resource-limit',
        scope: 'document',
        message: documentComplexityFailure,
        range: rangeWithoutIndex(text, 0, text.length),
      });
      if (conceptId !== undefined) {
        pendingConcepts.push(partialPendingConcept(conceptId, source));
      }
      continue;
    }

    const frontmatterPreparse = inspectFrontmatterPreparse(text);
    const frontmatterWork =
      frontmatterPreparse.kind === 'success'
        ? {
            sourceCodeUnits: frontmatterPreparse.sourceCodeUnits,
            structuralTokens: frontmatterPreparse.structuralTokens,
            start: frontmatterPreparse.yamlStart,
            end: frontmatterPreparse.yamlEnd,
          }
        : frontmatterPreparse.kind === 'failure' &&
            frontmatterPreparse.resourceLimit === true &&
            frontmatterPreparse.sourceCodeUnits !== undefined &&
            frontmatterPreparse.structuralTokens !== undefined
          ? {
              sourceCodeUnits: frontmatterPreparse.sourceCodeUnits,
              structuralTokens: frontmatterPreparse.structuralTokens,
              start: frontmatterPreparse.start,
              end: frontmatterPreparse.end,
            }
          : undefined;
    if (frontmatterWork !== undefined) {
      if (
        inspectedFrontmatterSourceCodeUnits >
          OKF_SEMANTIC_LIMITS.maxBundleFrontmatterSourceCodeUnits -
            frontmatterWork.sourceCodeUnits ||
        inspectedFrontmatterStructuralTokens >
          OKF_SEMANTIC_LIMITS.maxBundleFrontmatterStructuralTokens -
            frontmatterWork.structuralTokens
      ) {
        failures.push({
          kind: 'parse-failure',
          uri: source.uri,
          bundlePath: source.bundlePath,
          reason: 'resource-limit',
          scope: 'bundle',
          message: `Bundle YAML frontmatter exceeds the ${String(OKF_SEMANTIC_LIMITS.maxBundleFrontmatterSourceCodeUnits)}-code-unit or ${String(OKF_SEMANTIC_LIMITS.maxBundleFrontmatterStructuralTokens)}-token pre-AST work limit. Reduce or split the bundle, then retry.`,
          range: rangeWithoutIndex(text, frontmatterWork.start, frontmatterWork.end),
        });
        if (conceptId !== undefined) {
          pendingConcepts.push(partialPendingConcept(conceptId, source));
        }
        bundleLimitReached = true;
        continue;
      }
      inspectedFrontmatterSourceCodeUnits += frontmatterWork.sourceCodeUnits;
      inspectedFrontmatterStructuralTokens += frontmatterWork.structuralTokens;
    }
    if (frontmatterPreparse.kind === 'failure' && frontmatterPreparse.resourceLimit === true) {
      failures.push({
        kind: 'parse-failure',
        uri: source.uri,
        bundlePath: source.bundlePath,
        reason: 'resource-limit',
        scope: 'document',
        message: frontmatterPreparse.message,
        range: rangeWithoutIndex(text, frontmatterPreparse.start, frontmatterPreparse.end),
      });
      if (conceptId !== undefined) {
        pendingConcepts.push(partialPendingConcept(conceptId, source));
      }
      continue;
    }
    const preparseMarkdown =
      frontmatterPreparse.kind === 'success'
        ? text.slice(frontmatterPreparse.bodyStart)
        : frontmatterPreparse.kind === 'absent'
          ? text
          : undefined;
    let markdownInspection: MarkdownComplexityInspection | undefined;
    if (preparseMarkdown !== undefined) {
      markdownInspection = inspectMarkdownComplexity(preparseMarkdown);
      const markdownStart =
        frontmatterPreparse.kind === 'success' ? frontmatterPreparse.bodyStart : 0;
      if (
        inspectedMarkdownBodyCodeUnits >
          OKF_SEMANTIC_LIMITS.maxBundleMarkdownBodyCodeUnits - markdownInspection.sourceCodeUnits ||
        inspectedMarkdownLines >
          OKF_SEMANTIC_LIMITS.maxBundleMarkdownLines - markdownInspection.lines ||
        inspectedMarkdownAttentionWorkUnits >
          OKF_SEMANTIC_LIMITS.maxBundleMarkdownAttentionWorkUnits -
            markdownInspection.attentionWorkUnits ||
        inspectedMarkdownContainerWorkUnits >
          OKF_SEMANTIC_LIMITS.maxBundleMarkdownContainerWorkUnits -
            markdownInspection.containerWorkUnits ||
        inspectedMarkdownLabelEndWorkUnits >
          OKF_SEMANTIC_LIMITS.maxBundleMarkdownLabelEndWorkUnits -
            markdownInspection.labelEndWorkUnits ||
        inspectedMarkdownSyntaxCandidates >
          OKF_SEMANTIC_LIMITS.maxBundleMarkdownSyntaxCandidates -
            markdownInspection.syntaxCandidates ||
        inspectedMarkdownLinkCandidates >
          OKF_SEMANTIC_LIMITS.maxBundleMarkdownLinkCandidates - markdownInspection.linkCandidates
      ) {
        failures.push({
          kind: 'parse-failure',
          uri: source.uri,
          bundlePath: source.bundlePath,
          reason: 'resource-limit',
          scope: 'bundle',
          message: `Bundle Markdown exceeds one of the pre-AST work limits: ${String(OKF_SEMANTIC_LIMITS.maxBundleMarkdownBodyCodeUnits)} body code units, ${String(OKF_SEMANTIC_LIMITS.maxBundleMarkdownLines)} lines, ${String(OKF_SEMANTIC_LIMITS.maxBundleMarkdownAttentionWorkUnits)} attention grammar-event work units, ${String(OKF_SEMANTIC_LIMITS.maxBundleMarkdownContainerWorkUnits)} list/blockquote continuation work units, ${String(OKF_SEMANTIC_LIMITS.maxBundleMarkdownLabelEndWorkUnits)} link-label closing work units, ${String(OKF_SEMANTIC_LIMITS.maxBundleMarkdownSyntaxCandidates)} syntax candidates, or ${String(OKF_SEMANTIC_LIMITS.maxBundleMarkdownLinkCandidates)} link candidates. Reduce or split the bundle, then retry.`,
          range: rangeWithoutIndex(text, markdownStart, text.length),
        });
        if (conceptId !== undefined) {
          pendingConcepts.push(partialPendingConcept(conceptId, source));
        }
        bundleLimitReached = true;
        continue;
      }
      inspectedMarkdownBodyCodeUnits += markdownInspection.sourceCodeUnits;
      inspectedMarkdownLines += markdownInspection.lines;
      inspectedMarkdownAttentionWorkUnits += markdownInspection.attentionWorkUnits;
      inspectedMarkdownContainerWorkUnits += markdownInspection.containerWorkUnits;
      inspectedMarkdownLabelEndWorkUnits += markdownInspection.labelEndWorkUnits;
      inspectedMarkdownSyntaxCandidates += markdownInspection.syntaxCandidates;
      inspectedMarkdownLinkCandidates += markdownInspection.linkCandidates;
      if (markdownInspection.failure !== undefined) {
        failures.push({
          kind: 'parse-failure',
          uri: source.uri,
          bundlePath: source.bundlePath,
          reason: 'resource-limit',
          scope: 'document',
          message: markdownInspection.failure,
          range: rangeWithoutIndex(text, markdownStart, text.length),
        });
        if (conceptId !== undefined) {
          pendingConcepts.push(partialPendingConcept(conceptId, source));
        }
        continue;
      }
    }
    const ranges = new SourceRangeIndex(text);

    if (reservedKind !== undefined) {
      const parsed = parseFrontmatter(text, ranges);
      if (parsed.kind === 'failure') {
        failures.push({
          kind: 'parse-failure',
          uri: source.uri,
          bundlePath: source.bundlePath,
          reason: parsed.resourceLimit === true ? 'resource-limit' : 'frontmatter',
          ...(parsed.resourceLimit === true ? { scope: 'document' as const } : {}),
          message: parsed.message,
          range: parsed.range,
        });
        continue;
      }
      if (parsed.kind === 'success') {
        const frontmatterUnits = jsonOutputUnits(parsed.frontmatter.raw);
        if (
          retainedFrontmatterUnits >
          OKF_SEMANTIC_LIMITS.maxBundleFrontmatterOutputUnits - frontmatterUnits
        ) {
          failures.push({
            kind: 'parse-failure',
            uri: source.uri,
            bundlePath: source.bundlePath,
            reason: 'resource-limit',
            scope: 'bundle',
            message: `Bundle frontmatter exceeds the ${String(OKF_SEMANTIC_LIMITS.maxBundleFrontmatterOutputUnits)}-unit aggregate safety limit. Reduce or split the bundle, then retry.`,
            range: parsed.frontmatter.range,
          });
          bundleLimitReached = true;
          continue;
        }
        retainedFrontmatterUnits += frontmatterUnits;
        const declaredVersion = semanticFrontmatterString(parsed.frontmatter, 'okf_version');
        reservedDocuments.push({
          kind: 'reserved',
          reservedKind,
          source,
          body: parsed.body,
          bodyRange: ranges.range(parsed.bodyStart, text.length),
          frontmatter: parsed.frontmatter,
          ...(canonical.bundlePath === 'index.md' && declaredVersion !== undefined
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
        reason:
          parsed.kind === 'failure' && parsed.resourceLimit === true
            ? 'resource-limit'
            : 'frontmatter',
        ...(parsed.kind === 'failure' && parsed.resourceLimit === true
          ? { scope: 'document' as const }
          : {}),
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

    const frontmatterUnits = jsonOutputUnits(parsed.frontmatter.raw);
    if (
      retainedFrontmatterUnits >
      OKF_SEMANTIC_LIMITS.maxBundleFrontmatterOutputUnits - frontmatterUnits
    ) {
      failures.push({
        kind: 'parse-failure',
        uri: source.uri,
        bundlePath: source.bundlePath,
        reason: 'resource-limit',
        scope: 'bundle',
        message: `Bundle frontmatter exceeds the ${String(OKF_SEMANTIC_LIMITS.maxBundleFrontmatterOutputUnits)}-unit aggregate safety limit. Reduce or split the bundle, then retry.`,
        range: parsed.frontmatter.range,
      });
      pendingConcepts.push(partialPendingConcept(conceptId, source, ranges));
      bundleLimitReached = true;
      continue;
    }
    const previousFrontmatterUnits = retainedFrontmatterUnits;
    retainedFrontmatterUnits += frontmatterUnits;
    const normalized = parsed.frontmatter.normalized;
    const metadataFailure = conceptMetadataFailure(normalized);
    if (metadataFailure !== undefined) {
      retainedFrontmatterUnits = previousFrontmatterUnits;
      failures.push({
        kind: 'parse-failure',
        uri: source.uri,
        bundlePath: source.bundlePath,
        reason: 'resource-limit',
        scope: 'document',
        message: metadataFailure,
        range: parsed.frontmatter.range,
      });
      pendingConcepts.push(partialPendingConcept(conceptId, source, ranges));
      continue;
    }
    const markdown = extractMarkdownLinks(
      parsed.body,
      parsed.bodyStart,
      ranges,
      markdownInspection,
    );
    if (!markdown.ok) {
      retainedFrontmatterUnits = previousFrontmatterUnits;
      failures.push({
        kind: 'parse-failure',
        uri: source.uri,
        bundlePath: source.bundlePath,
        reason: markdown.reason === 'resource-limit' ? 'resource-limit' : 'markdown',
        ...(markdown.reason === 'resource-limit' ? { scope: 'document' as const } : {}),
        message: markdown.message,
        range: markdown.range,
      });
      pendingConcepts.push(partialPendingConcept(conceptId, source, ranges));
      continue;
    }
    if (retainedLinkCount > OKF_SEMANTIC_LIMITS.maxBundleLinks - markdown.links.length) {
      failures.push({
        kind: 'parse-failure',
        uri: source.uri,
        bundlePath: source.bundlePath,
        reason: 'resource-limit',
        scope: 'bundle',
        message: `Bundle parsing refused more than ${String(OKF_SEMANTIC_LIMITS.maxBundleLinks)} Markdown relationships. Reduce or split the document or bundle, then retry.`,
        range: ranges.range(parsed.bodyStart, text.length),
      });
      pendingConcepts.push(partialPendingConcept(conceptId, source, ranges));
      bundleLimitReached = true;
      continue;
    }
    if (
      retainedLinkTextUnits >
      OKF_SEMANTIC_LIMITS.maxBundleLinkTextUnits - markdown.retainedTextUnits
    ) {
      failures.push({
        kind: 'parse-failure',
        uri: source.uri,
        bundlePath: source.bundlePath,
        reason: 'resource-limit',
        scope: 'bundle',
        message: `Bundle Markdown link targets and labels exceed the ${String(OKF_SEMANTIC_LIMITS.maxBundleLinkTextUnits)}-unit aggregate safety limit. Reduce or split the bundle, then retry.`,
        range: ranges.range(parsed.bodyStart, text.length),
      });
      pendingConcepts.push(partialPendingConcept(conceptId, source, ranges));
      bundleLimitReached = true;
      continue;
    }

    const uniqueDocumentTags = new Set(normalized.tags);
    const newTypeCount = retainedTypes.has(normalized.type ?? '') ? 0 : 1;
    let newUniqueTagCount = 0;
    for (const tag of uniqueDocumentTags) {
      if (!retainedTags.has(tag)) {
        newUniqueTagCount += 1;
      }
    }
    if (
      retainedTagAssignments >
        OKF_SEMANTIC_LIMITS.maxBundleTagAssignments - normalized.tags.length ||
      retainedTypes.size > OKF_SEMANTIC_LIMITS.maxUniqueGraphTypes - newTypeCount ||
      retainedTags.size > OKF_SEMANTIC_LIMITS.maxUniqueGraphTags - newUniqueTagCount
    ) {
      retainedFrontmatterUnits = previousFrontmatterUnits;
      failures.push({
        kind: 'parse-failure',
        uri: source.uri,
        bundlePath: source.bundlePath,
        reason: 'resource-limit',
        scope: 'bundle',
        message: `Bundle graph metadata exceeds the ${String(OKF_SEMANTIC_LIMITS.maxBundleTagAssignments)} tag-assignment, ${String(OKF_SEMANTIC_LIMITS.maxUniqueGraphTags)} unique-tag, or ${String(OKF_SEMANTIC_LIMITS.maxUniqueGraphTypes)} unique-type safety limit. Reduce or split the bundle, then retry.`,
        range: parsed.frontmatter.range,
      });
      pendingConcepts.push(partialPendingConcept(conceptId, source, ranges));
      bundleLimitReached = true;
      continue;
    }

    retainedLinkCount += markdown.links.length;
    retainedLinkTextUnits += markdown.retainedTextUnits;
    retainedTagAssignments += normalized.tags.length;
    retainedTypes.add(normalized.type ?? '');
    for (const tag of uniqueDocumentTags) {
      retainedTags.add(tag);
    }
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
        ...(normalized.generated === undefined ? {} : { generated: normalized.generated }),
        verified: normalized.verified ?? [],
        trustTier: normalized.trustTier ?? 'unverified',
        ...(normalized.status === undefined ? {} : { status: normalized.status }),
        ...(normalized.staleAfter === undefined ? {} : { staleAfter: normalized.staleAfter }),
        sources: normalized.sources ?? [],
        ...(normalized.usageWindow === undefined ? {} : { usageWindow: normalized.usageWindow }),
        ...(normalized.runtime === undefined ? {} : { runtime: normalized.runtime }),
        parameters: normalized.parameters ?? [],
        ...(normalized.computation === undefined ? {} : { computation: normalized.computation }),
        ...(normalized.executor === undefined ? {} : { executor: normalized.executor }),
        ...(normalized.attester === undefined ? {} : { attester: normalized.attester }),
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

function jsonOutputUnits(value: JsonValue): number {
  const pending: JsonValue[] = [value];
  let units = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    units += 1;
    if (typeof current === 'string') {
      units += utf8StringLength(current);
    } else if (typeof current === 'number') {
      units += 8;
    } else if (Array.isArray(current)) {
      units += current.length;
      for (const item of current) {
        pending.push(item);
      }
    } else if (current !== null && typeof current === 'object') {
      for (const [key, item] of Object.entries(current)) {
        units += 1 + utf8StringLength(key);
        pending.push(item);
      }
    }
    if (units > OKF_SEMANTIC_LIMITS.maxBundleFrontmatterOutputUnits) {
      return units;
    }
  }
  return units;
}

function utf8StringLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

function decodeDocument(
  content: string | Uint8Array,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string } {
  let text: string;
  if (typeof content === 'string') {
    if (hasUnpairedUtf16Surrogate(content)) {
      return {
        ok: false,
        message: 'Already-decoded document text contains an unpaired UTF-16 surrogate.',
      };
    }
    text = content;
  } else {
    try {
      // Preserve the BOM in decoded text so both input forms pass through the same policy below.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
    } catch {
      return {
        ok: false,
        message: 'Document bytes are not valid UTF-8.',
      };
    }
  }

  if (text.startsWith('\uFEFF\uFEFF')) {
    return {
      ok: false,
      message: 'Document text must contain at most one leading byte-order mark.',
    };
  }

  return { ok: true, text: text.startsWith('\uFEFF') ? text.slice(1) : text };
}

function fallbackContentHash(content: string | Uint8Array): string {
  if (typeof content === 'string' && hasUnpairedUtf16Surrogate(content)) {
    // TextEncoder replaces unpaired surrogates with U+FFFD. Hash the original UTF-16 code units in
    // a separate domain so rejected text cannot share the fallback identity of replacement bytes.
    let hash = 0x811c9dc5;
    for (let offset = 0; offset < content.length; offset += 1) {
      const codeUnit = content.charCodeAt(offset);
      hash ^= codeUnit & 0xff;
      hash = Math.imul(hash, 0x01000193);
      hash ^= codeUnit >>> 8;
      hash = Math.imul(hash, 0x01000193);
    }
    return `fnv1a32-utf16:${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }

  const bytes = typeof content === 'string' ? utf8Encoder.encode(content) : content;
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function hasUnpairedUtf16Surrogate(text: string): boolean {
  for (let offset = 0; offset < text.length; offset += 1) {
    const codeUnit = text.charCodeAt(offset);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = text.charCodeAt(offset + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        offset += 1;
        continue;
      }
      return true;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
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
  ranges?: SourceRangeIndex,
): PendingConcept {
  const emptyRange = ranges?.range(0, 0) ?? rangeWithoutIndex('', 0, 0);
  return {
    concept: {
      kind: 'concept',
      id,
      source,
      frontmatter: {
        raw: {},
        explicitTags: {},
        source: '',
        range: emptyRange,
        fields: {},
        normalized: {
          tags: [],
          verified: [],
          trustTier: 'unverified',
          sources: [],
          parameters: [],
        },
      },
      type: '',
      tags: [],
      verified: [],
      trustTier: 'unverified',
      sources: [],
      parameters: [],
      body: '',
      bodyRange: emptyRange,
    },
    candidates: [],
  };
}

function resourceLimitBundle(
  input: ParseBundleInput,
  safeRootUri: string,
  message: string,
): ParsedBundle {
  return {
    rootUri: safeRootUri,
    revision: input.revision,
    concepts: [],
    reservedDocuments: [],
    failures: [
      {
        kind: 'parse-failure',
        uri: safeRootUri,
        bundlePath: '',
        reason: 'resource-limit',
        scope: 'bundle',
        message,
      },
    ],
    findings: [],
  };
}

function boundedIdentityFailure(
  value: string,
  maxCodeUnits: number,
  maxBytes: number,
  subject: string,
): string | undefined {
  if (value.length > maxCodeUnits) {
    return `${subject} exceeds the ${String(maxCodeUnits)}-code-unit identity safety limit. Shorten the identifier, then retry.`;
  }
  if (utf8StringLength(value) > maxBytes) {
    return `${subject} exceeds the ${String(maxBytes)}-byte identity safety limit. Shorten the identifier, then retry.`;
  }
  return undefined;
}

function boundedFailureMessage(message: string): string {
  if (hasUnpairedUtf16Surrogate(message)) {
    return 'Provider failure detail contains an unpaired UTF-16 surrogate.';
  }
  const limit = OKF_SEMANTIC_LIMITS.maxFailureDetailCodeUnits;
  if (message.length <= limit) {
    return message;
  }
  let end = limit - 1;
  const finalCodeUnit = message.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    end -= 1;
  }
  return `${message.slice(0, end)}…`;
}

function conceptMetadataFailure(metadata: NormalizedFrontmatter): string | undefined {
  const unicodeValues = [
    metadata.type,
    metadata.title,
    metadata.description,
    metadata.resource,
    metadata.timestamp,
    metadata.generated?.by,
    metadata.generated?.at,
    metadata.status,
    metadata.staleAfter,
    metadata.runtime,
    metadata.computation,
    ...metadata.tags,
  ];
  if (unicodeValues.some((value) => value !== undefined && hasUnpairedUtf16Surrogate(value))) {
    return 'Concept metadata contains an unpaired UTF-16 surrogate that is unsafe for graph publication.';
  }
  if (hasGraphIdentityControl(metadata.type ?? '')) {
    return 'Concept type contains a control character that is unsafe for graph filters.';
  }
  const typeFailure = boundedIdentityFailure(
    metadata.type ?? '',
    OKF_SEMANTIC_LIMITS.maxTypeCodeUnits,
    OKF_SEMANTIC_LIMITS.maxTypeBytes,
    'Concept type',
  );
  if (typeFailure !== undefined) {
    return typeFailure;
  }
  if (metadata.tags.length > OKF_SEMANTIC_LIMITS.maxTagsPerConcept) {
    return `Concept metadata contains more than ${String(OKF_SEMANTIC_LIMITS.maxTagsPerConcept)} tags, exceeding the per-concept safety limit. Reduce the tag list, then retry.`;
  }
  for (const tag of metadata.tags) {
    if (hasGraphIdentityControl(tag)) {
      return 'Concept tag contains a control character that is unsafe for graph filters.';
    }
    const tagFailure = boundedIdentityFailure(
      tag,
      OKF_SEMANTIC_LIMITS.maxTagCodeUnits,
      OKF_SEMANTIC_LIMITS.maxTagBytes,
      'Concept tag',
    );
    if (tagFailure !== undefined) {
      return tagFailure;
    }
  }

  const boundedFields: readonly [string, string | undefined, number][] = [
    ['Concept title', metadata.title, OKF_SEMANTIC_LIMITS.maxTitleCodeUnits],
    ['Concept description', metadata.description, OKF_SEMANTIC_LIMITS.maxDescriptionCodeUnits],
    ['Concept resource', metadata.resource, OKF_SEMANTIC_LIMITS.maxResourceCodeUnits],
    ['Concept timestamp', metadata.timestamp, OKF_SEMANTIC_LIMITS.maxTimestampCodeUnits],
    ['Concept generator actor', metadata.generated?.by, OKF_SEMANTIC_LIMITS.maxResourceCodeUnits],
    ['Concept generation time', metadata.generated?.at, OKF_SEMANTIC_LIMITS.maxTimestampCodeUnits],
    ['Concept lifecycle status', metadata.status, OKF_SEMANTIC_LIMITS.maxTypeCodeUnits],
    ['Concept stale-after date', metadata.staleAfter, OKF_SEMANTIC_LIMITS.maxTimestampCodeUnits],
    ['Concept computation runtime', metadata.runtime, OKF_SEMANTIC_LIMITS.maxTypeCodeUnits],
    ['Concept computation path', metadata.computation, OKF_SEMANTIC_LIMITS.maxResourceCodeUnits],
  ];
  for (const [subject, value, limit] of boundedFields) {
    if (value !== undefined && value.length > limit) {
      return `${subject} exceeds the ${String(limit)}-code-unit graph metadata safety limit. Shorten the value, then retry.`;
    }
  }
  if (
    (metadata.resource !== undefined && hasGraphIdentityControl(metadata.resource)) ||
    (metadata.timestamp !== undefined && hasGraphIdentityControl(metadata.timestamp)) ||
    (metadata.generated?.by !== undefined && hasGraphIdentityControl(metadata.generated.by)) ||
    (metadata.generated?.at !== undefined && hasGraphIdentityControl(metadata.generated.at)) ||
    (metadata.status !== undefined && hasGraphIdentityControl(metadata.status)) ||
    (metadata.staleAfter !== undefined && hasGraphIdentityControl(metadata.staleAfter)) ||
    (metadata.runtime !== undefined && hasGraphIdentityControl(metadata.runtime)) ||
    (metadata.computation !== undefined && hasGraphIdentityControl(metadata.computation))
  ) {
    return 'Concept scalar metadata contains a control character that is unsafe for graph metadata.';
  }
  return undefined;
}

function hasGraphIdentityControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function semanticDocumentSourceFailure(content: string | Uint8Array): string | undefined {
  if (
    typeof content === 'string' &&
    content.length > OKF_SEMANTIC_LIMITS.maxSemanticDocumentCodeUnits
  ) {
    return `Decoded Markdown exceeds the ${String(OKF_SEMANTIC_LIMITS.maxSemanticDocumentCodeUnits)}-code-unit pre-parse safety limit. Reduce or split the document, then retry.`;
  }
  const bytes = typeof content === 'string' ? utf8StringLength(content) : content.byteLength;
  if (bytes > OKF_SEMANTIC_LIMITS.maxSemanticDocumentBytes) {
    return `Markdown source exceeds the ${String(OKF_SEMANTIC_LIMITS.maxSemanticDocumentBytes)}-byte pre-parse safety limit. Reduce or split the document, then retry.`;
  }
  return undefined;
}

function semanticDocumentTextFailure(text: string): string | undefined {
  if (text.length > OKF_SEMANTIC_LIMITS.maxSemanticDocumentCodeUnits) {
    return `Decoded Markdown exceeds the ${String(OKF_SEMANTIC_LIMITS.maxSemanticDocumentCodeUnits)}-code-unit pre-parse safety limit. Reduce or split the document, then retry.`;
  }
  let lines = text.length === 0 ? 0 : 1;
  for (let offset = 0; offset < text.length; offset += 1) {
    const code = text.charCodeAt(offset);
    if (code === 0x0d) {
      if (text.charCodeAt(offset + 1) === 0x0a) {
        offset += 1;
      }
      lines += 1;
    } else if (code === 0x0a) {
      lines += 1;
    }
    if (lines > OKF_SEMANTIC_LIMITS.maxSemanticDocumentLines) {
      return `Markdown source exceeds the ${String(OKF_SEMANTIC_LIMITS.maxSemanticDocumentLines)}-line pre-index safety limit. Reduce or split the document, then retry.`;
    }
  }
  return undefined;
}

/** Builds one diagnostic range in O(text length) space without retaining a line-start index. */
function rangeWithoutIndex(
  text: string,
  requestedStart: number,
  requestedEnd: number,
): SourceRange {
  const start = Math.max(0, Math.min(text.length, requestedStart));
  const end = Math.max(start, Math.min(text.length, requestedEnd));
  let line = 0;
  let lineStart = 0;
  let startPosition = { offset: start, line: 0, character: start };
  let capturedStart = start === 0;
  for (let offset = 0; offset <= end; offset += 1) {
    if (!capturedStart && offset === start) {
      startPosition = { offset: start, line, character: start - lineStart };
      capturedStart = true;
    }
    if (offset === end) {
      return {
        start: startPosition,
        end: { offset: end, line, character: end - lineStart },
      };
    }
    const code = text.charCodeAt(offset);
    if (code === 0x0d) {
      if (text.charCodeAt(offset + 1) === 0x0a && offset + 1 < end) {
        offset += 1;
      }
      line += 1;
      lineStart = offset + 1;
    } else if (code === 0x0a) {
      line += 1;
      lineStart = offset + 1;
    }
  }
  return { start: startPosition, end: startPosition };
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
