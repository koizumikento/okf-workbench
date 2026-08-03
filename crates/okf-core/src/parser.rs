use crate::{
    BundleDocumentInput, ComputationEndpoint, ComputationParameter, Concept, ConceptLink,
    DocumentContent, GeneratedMetadata, KnowledgeSource, LinkClassification, NormalizedFrontmatter,
    ParseBundleInput, ParseFailure, ParseFailureReason, ParsedBundle, ParsedFrontmatter,
    ReservedDocument, SourceDocument, SourcePosition, SourceRange, UsageWindow, VerificationEvent,
};
use chrono::{DateTime, Duration, FixedOffset, NaiveDate, SecondsFormat};
use pulldown_cmark::{Event, Options, Parser, Tag};
use serde_json::{Map, Number, Value};
use std::collections::BTreeSet;

const MAX_DOCUMENTS: usize = 2_000;
const MAX_DOCUMENT_BYTES: usize = 320 * 1024 + 16;
const MAX_DOCUMENT_CODE_UNITS: usize = 320 * 1024 + 16;
const MAX_DOCUMENT_LINES: usize = 24_002;
const MAX_LINKS: usize = 10_000;
const MAX_BUNDLE_LINK_TEXT_UNITS: usize = 4 * 1024 * 1024;
const MAX_BUNDLE_TAG_ASSIGNMENTS: usize = 20_000;
const MAX_UNIQUE_GRAPH_TYPES: usize = 512;
const MAX_UNIQUE_GRAPH_TAGS: usize = 4_096;
pub(crate) const MAX_PROVIDER_PATH_CODE_UNITS: usize = 4_096;
pub(crate) const MAX_PROVIDER_PATH_BYTES: usize = 4_096;
pub(crate) const MAX_PROVIDER_PATH_SEGMENTS: usize = 64;
const MAX_SOURCE_URI_CODE_UNITS: usize = 16 * 1024;
const MAX_SOURCE_URI_BYTES: usize = 16 * 1024;
const MAX_CONTENT_HASH_CODE_UNITS: usize = 256;
const MAX_FRONTMATTER_SOURCE_BYTES: usize = 64 * 1024;
const MAX_FRONTMATTER_SOURCE_CODE_UNITS: usize = 64 * 1024;
const MAX_FRONTMATTER_LINES: usize = 4_000;
const MAX_FRONTMATTER_STRUCTURAL_TOKENS: usize = 8_000;
const MAX_BUNDLE_FRONTMATTER_SOURCE_CODE_UNITS: usize = 8 * 1024 * 1024;
const MAX_BUNDLE_FRONTMATTER_STRUCTURAL_TOKENS: usize = 256_000;
const MAX_FRONTMATTER_INDENT_COLUMNS: usize = 128;
const MAX_FRONTMATTER_OUTPUT_UNITS: usize = 128 * 1024;
const MAX_BUNDLE_FRONTMATTER_OUTPUT_UNITS: usize = 16 * 1024 * 1024;
const MAX_FRONTMATTER_NESTING_DEPTH: usize = 64;
const MAX_ALIAS_EXPANSIONS: usize = 100;
const MAX_MARKDOWN_BODY_BYTES: usize = 256 * 1024;
const MAX_MARKDOWN_BODY_CODE_UNITS: usize = 256 * 1024;
const MAX_MARKDOWN_LINES: usize = 20_000;
const MAX_MARKDOWN_SYNTAX_CANDIDATES: usize = 20_000;
const MAX_BUNDLE_MARKDOWN_BODY_CODE_UNITS: usize = 8 * 1024 * 1024;
const MAX_BUNDLE_MARKDOWN_LINES: usize = 100_000;
const MAX_BUNDLE_MARKDOWN_ATTENTION_WORK_UNITS: usize = 32 * 1024 * 1024;
const MAX_BUNDLE_MARKDOWN_CONTAINER_WORK_UNITS: usize = 262_144;
const MAX_BUNDLE_MARKDOWN_LABEL_END_WORK_UNITS: usize = 32 * 1024 * 1024;
const MAX_BUNDLE_MARKDOWN_SYNTAX_CANDIDATES: usize = 80_000;
const MAX_BUNDLE_MARKDOWN_LINK_CANDIDATES: usize = 20_000;
const MAX_MARKDOWN_LINKS_PER_DOCUMENT: usize = 5_000;
const MAX_MARKDOWN_DEFINITIONS_PER_DOCUMENT: usize = 5_000;
const MAX_MARKDOWN_ATTENTION_RUNS_PER_DOCUMENT: usize = 1_024;
const MAX_MARKDOWN_ATTENTION_MARKERS_PER_DOCUMENT: usize = 1_024;
const MAX_MARKDOWN_ATTENTION_WORK_UNITS_PER_DOCUMENT: usize = 8 * 1024 * 1024;
const MAX_MARKDOWN_CONTAINER_NESTING_DEPTH: usize = 64;
const MAX_MARKDOWN_CONTAINER_WORK_UNITS_PER_DOCUMENT: usize = 65_536;
const MAX_MARKDOWN_MEDIA_NESTING_DEPTH: usize = 64;
const MAX_MARKDOWN_LABEL_END_WORK_UNITS_PER_DOCUMENT: usize = 8 * 1024 * 1024;
const MAX_LINK_TEXT_UNITS_PER_DOCUMENT: usize = 1024 * 1024;
const MAX_MARKDOWN_REFERENCE_EXPANSION_BYTES: usize = 2 * 1024 * 1024;
const MAX_LINK_TARGET_BYTES: usize = 2_048;
const MAX_LINK_TARGET_CODE_UNITS: usize = 2_048;
const MAX_LINK_LABEL_BYTES: usize = 512;
const MAX_LINK_LABEL_CODE_UNITS: usize = 512;
const MAX_TYPE_BYTES: usize = 256;
const MAX_TYPE_CODE_UNITS: usize = 256;
const MAX_TAGS_PER_CONCEPT: usize = 128;
const MAX_TAG_BYTES: usize = 256;
const MAX_TAG_CODE_UNITS: usize = 256;
const MAX_TITLE_CODE_UNITS: usize = 4_096;
const MAX_DESCRIPTION_CODE_UNITS: usize = 16_384;
const MAX_RESOURCE_CODE_UNITS: usize = 4_096;
const MAX_TIMESTAMP_CODE_UNITS: usize = 256;
const TAGGED_KEY: &str = "$okf-workbench:yaml-tag";
const EXACT_INTEGER_KEY: &str = "$okf-workbench:yaml-integer";
const SET_SOURCE_RESERVED_KEY: &str = "$okf-workbench:set-source-reserved";

#[derive(Debug)]
struct DecodedDocument {
    uri: String,
    path: String,
    text: String,
    hash: String,
    identity_only: bool,
}

#[derive(Debug)]
struct PendingConcept {
    concept: Concept,
    candidates: Vec<LinkCandidate>,
}

#[derive(Debug)]
struct LinkCandidate {
    label: String,
    target: String,
    range: SourceRange,
}

#[derive(Clone, Debug, Default)]
struct MarkdownWorkInspection {
    attention_work_units: usize,
    container_work_units: usize,
    failure: Option<String>,
    label_end_work_units: usize,
    link_candidates: usize,
}

#[derive(Debug)]
struct FrontmatterError {
    message: String,
    range: Option<SourceRange>,
    resource_limit: bool,
}

struct FrontmatterWork {
    start: usize,
    end: usize,
    source_code_units: usize,
    structural_tokens: usize,
}

pub fn parse_bundle(mut input: ParseBundleInput) -> ParsedBundle {
    if input.invalid_root_uri_utf16 == Some(true) {
        return ParsedBundle {
            root_uri: "<bundle-root-uri-invalid-unicode>".to_owned(),
            revision: input.revision,
            concepts: Vec::new(),
            reserved_documents: Vec::new(),
            failures: vec![failure(
                "<bundle-root-uri-invalid-unicode>",
                "",
                ParseFailureReason::ResourceLimit,
                "Bundle root URI contains an unpaired UTF-16 surrogate.",
                Some("bundle"),
            )],
            findings: Vec::new(),
        };
    }
    if let Some(message) = bounded_identity_failure(
        &input.root_uri,
        MAX_SOURCE_URI_CODE_UNITS,
        MAX_SOURCE_URI_BYTES,
        "Bundle root URI",
    ) {
        return ParsedBundle {
            root_uri: "<bundle-root-uri-exceeds-limit>".to_owned(),
            revision: input.revision,
            concepts: Vec::new(),
            reserved_documents: Vec::new(),
            failures: vec![failure(
                "<bundle-root-uri-exceeds-limit>",
                "",
                ParseFailureReason::ResourceLimit,
                &message,
                Some("bundle"),
            )],
            findings: Vec::new(),
        };
    }
    if input.documents.len() > MAX_DOCUMENTS {
        return ParsedBundle {
            root_uri: input.root_uri.clone(),
            revision: input.revision,
            concepts: Vec::new(),
            reserved_documents: Vec::new(),
            failures: vec![failure(
                &input.root_uri,
                "",
                ParseFailureReason::ResourceLimit,
                "Bundle parsing refused more than 2000 Markdown documents. Reduce or split the bundle, then retry.",
                Some("bundle"),
            )],
            findings: Vec::new(),
        };
    }

    input.documents.sort_by(|left, right| {
        compare_utf16(
            &normalized_path(&left.bundle_path),
            &normalized_path(&right.bundle_path),
        )
        .then_with(|| compare_utf16(&left.uri, &right.uri))
    });

    let mut failures = Vec::new();
    let mut decoded = Vec::new();
    let mut seen = BTreeSet::new();
    for document in input.documents {
        let invalid_utf16_uri = document
            .invalid_utf16_fields
            .as_ref()
            .is_some_and(|fields| fields.uri);
        let invalid_utf16_path = document
            .invalid_utf16_fields
            .as_ref()
            .is_some_and(|fields| fields.bundle_path);
        let invalid_utf16_content_hash = document
            .invalid_utf16_fields
            .as_ref()
            .is_some_and(|fields| fields.content_hash);
        if invalid_utf16_uri || invalid_utf16_path {
            failures.push(failure(
                if invalid_utf16_uri {
                    "<provider-uri-invalid-unicode>"
                } else {
                    &document.uri
                },
                if invalid_utf16_path {
                    "<provider-path-invalid-unicode>"
                } else {
                    &document.bundle_path
                },
                ParseFailureReason::ResourceLimit,
                if invalid_utf16_path {
                    "Provider-relative path contains an unpaired UTF-16 surrogate."
                } else {
                    "Source URI contains an unpaired UTF-16 surrogate."
                },
                Some("document"),
            ));
            continue;
        }
        let provider_path_failure = bounded_identity_failure(
            &document.bundle_path,
            MAX_PROVIDER_PATH_CODE_UNITS,
            MAX_PROVIDER_PATH_BYTES,
            "Provider-relative path",
        );
        let uri_failure = bounded_identity_failure(
            &document.uri,
            MAX_SOURCE_URI_CODE_UNITS,
            MAX_SOURCE_URI_BYTES,
            "Source URI",
        );
        if provider_path_failure.is_some() || uri_failure.is_some() {
            failures.push(failure(
                if uri_failure.is_some() {
                    "<provider-uri-exceeds-limit>"
                } else {
                    &document.uri
                },
                if provider_path_failure.is_some() {
                    "<provider-path-exceeds-limit>"
                } else {
                    &document.bundle_path
                },
                ParseFailureReason::ResourceLimit,
                provider_path_failure
                    .as_deref()
                    .or(uri_failure.as_deref())
                    .unwrap_or("Provider identity exceeds a safety limit."),
                Some("document"),
            ));
            continue;
        }
        if !normalized_path(&document.bundle_path).ends_with(".md") {
            continue;
        }
        let path = match canonical_path(&document.bundle_path) {
            Ok(path) => path,
            Err(CanonicalPathError::Read(message)) => {
                failures.push(failure(
                    &document.uri,
                    &document.bundle_path,
                    ParseFailureReason::Read,
                    message,
                    None,
                ));
                continue;
            }
            Err(CanonicalPathError::ResourceLimit) => {
                failures.push(failure(
                    &document.uri,
                    "<provider-path-exceeds-limit>",
                    ParseFailureReason::ResourceLimit,
                    "Bundle path exceeds the 64-segment identity safety limit. Reduce directory nesting, then retry.",
                    Some("document"),
                ));
                continue;
            }
        };
        if !seen.insert(path.clone()) {
            failures.push(failure(
                &document.uri,
                &path,
                ParseFailureReason::Read,
                "Multiple enumerated documents normalize to the same bundle path.",
                None,
            ));
            continue;
        }
        if document.identity_only_failure.is_none()
            && (invalid_utf16_content_hash
                || document
                    .content_hash
                    .as_deref()
                    .is_some_and(|hash| hash.encode_utf16().count() > MAX_CONTENT_HASH_CODE_UNITS))
        {
            failures.push(failure(
                &document.uri,
                &path,
                ParseFailureReason::ResourceLimit,
                if invalid_utf16_content_hash {
                    "Content identity contains an unpaired UTF-16 surrogate. Refresh the bundle from a conforming provider, then retry."
                } else {
                    "Content identity exceeds the 256-code-unit safety limit. Refresh the bundle from a conforming provider, then retry."
                },
                Some("document"),
            ));
            if !is_reserved(&path) {
                decoded.push(DecodedDocument {
                    uri: document.uri,
                    path,
                    text: String::new(),
                    hash: "resource-limit:unparsed".to_owned(),
                    identity_only: true,
                });
            }
            continue;
        }
        if let Some(ref identity_failure) = document.identity_only_failure {
            failures.push(failure(
                &document.uri,
                &path,
                identity_failure.reason.clone(),
                &identity_failure.message,
                Some("document"),
            ));
            if !is_reserved(&path) {
                decoded.push(identity_only_document(document, path));
            }
            continue;
        }
        match decode_document(document.clone(), path.clone()) {
            Ok(document) => decoded.push(document),
            Err(item) => {
                if !is_reserved(&path) {
                    decoded.push(failed_document(&document, path.clone(), &item));
                }
                failures.push(*item);
            }
        }
    }

    let all_paths = decoded
        .iter()
        .map(|document| document.path.clone())
        .collect::<BTreeSet<_>>();
    let concept_paths = all_paths
        .iter()
        .filter(|path| !is_reserved(path))
        .cloned()
        .collect::<BTreeSet<_>>();
    let reserved_paths = all_paths
        .iter()
        .filter(|path| is_reserved(path))
        .cloned()
        .collect::<BTreeSet<_>>();
    let directories = directory_set(&all_paths);

    let mut pending = Vec::new();
    let mut reserved_documents = Vec::new();
    let mut total_links = 0usize;
    let mut retained_link_text_units = 0usize;
    let mut retained_tag_assignments = 0usize;
    let mut retained_types = BTreeSet::new();
    let mut retained_tags = BTreeSet::new();
    let mut retained_frontmatter_units = 0usize;
    let mut inspected_frontmatter_source_code_units = 0usize;
    let mut inspected_frontmatter_structural_tokens = 0usize;
    let mut inspected_markdown_body_code_units = 0usize;
    let mut inspected_markdown_lines = 0usize;
    let mut inspected_markdown_attention_work_units = 0usize;
    let mut inspected_markdown_container_work_units = 0usize;
    let mut inspected_markdown_label_end_work_units = 0usize;
    let mut inspected_markdown_syntax_candidates = 0usize;
    let mut inspected_markdown_link_candidates = 0usize;
    let mut bundle_limit_reached = false;
    for mut document in decoded {
        if document.identity_only {
            pending.push(PendingConcept {
                concept: partial_concept(&document),
                candidates: Vec::new(),
            });
            continue;
        }

        if bundle_limit_reached {
            failures.push(failure(
                &document.uri,
                &document.path,
                ParseFailureReason::ResourceLimit,
                "Semantic parsing was skipped after the bundle exceeded an aggregate parser-work safety limit.",
                Some("document"),
            ));
            if !is_reserved(&document.path) {
                document.hash = "resource-limit:unparsed".to_owned();
                pending.push(PendingConcept {
                    concept: partial_concept(&document),
                    candidates: Vec::new(),
                });
            }
            continue;
        }

        let (frontmatter_work, markdown_start) = frontmatter_work(&document.text);
        if let Some(work) = frontmatter_work.as_ref() {
            if inspected_frontmatter_source_code_units
                > MAX_BUNDLE_FRONTMATTER_SOURCE_CODE_UNITS.saturating_sub(work.source_code_units)
                || inspected_frontmatter_structural_tokens
                    > MAX_BUNDLE_FRONTMATTER_STRUCTURAL_TOKENS
                        .saturating_sub(work.structural_tokens)
            {
                let mut item = failure(
                    &document.uri,
                    &document.path,
                    ParseFailureReason::ResourceLimit,
                    &format!(
                        "Bundle YAML frontmatter exceeds the {MAX_BUNDLE_FRONTMATTER_SOURCE_CODE_UNITS}-code-unit or {MAX_BUNDLE_FRONTMATTER_STRUCTURAL_TOKENS}-token pre-AST work limit. Reduce or split the bundle, then retry."
                    ),
                    Some("bundle"),
                );
                item.range = Some(range_for(&document.text, work.start, work.end));
                failures.push(item);
                if !is_reserved(&document.path) {
                    pending.push(PendingConcept {
                        concept: partial_concept(&document),
                        candidates: Vec::new(),
                    });
                }
                bundle_limit_reached = true;
                continue;
            }
            inspected_frontmatter_source_code_units += work.source_code_units;
            inspected_frontmatter_structural_tokens += work.structural_tokens;
        }
        if let Some(markdown_start) = markdown_start {
            let body = &document.text[markdown_start..];
            let body_code_units = body.encode_utf16().count();
            let body_lines = preparse_line_count(body);
            let syntax_candidates = markdown_syntax_candidate_count(body);
            let markdown_work = markdown_work_inspection(body);
            if inspected_markdown_body_code_units
                > MAX_BUNDLE_MARKDOWN_BODY_CODE_UNITS.saturating_sub(body_code_units)
                || inspected_markdown_lines > MAX_BUNDLE_MARKDOWN_LINES.saturating_sub(body_lines)
                || inspected_markdown_attention_work_units
                    > MAX_BUNDLE_MARKDOWN_ATTENTION_WORK_UNITS
                        .saturating_sub(markdown_work.attention_work_units)
                || inspected_markdown_container_work_units
                    > MAX_BUNDLE_MARKDOWN_CONTAINER_WORK_UNITS
                        .saturating_sub(markdown_work.container_work_units)
                || inspected_markdown_label_end_work_units
                    > MAX_BUNDLE_MARKDOWN_LABEL_END_WORK_UNITS
                        .saturating_sub(markdown_work.label_end_work_units)
                || inspected_markdown_syntax_candidates
                    > MAX_BUNDLE_MARKDOWN_SYNTAX_CANDIDATES.saturating_sub(syntax_candidates)
                || inspected_markdown_link_candidates
                    > MAX_BUNDLE_MARKDOWN_LINK_CANDIDATES
                        .saturating_sub(markdown_work.link_candidates)
            {
                let mut item = failure(
                    &document.uri,
                    &document.path,
                    ParseFailureReason::ResourceLimit,
                    &format!(
                        "Bundle Markdown exceeds one of the pre-AST work limits: {MAX_BUNDLE_MARKDOWN_BODY_CODE_UNITS} body code units, {MAX_BUNDLE_MARKDOWN_LINES} lines, {MAX_BUNDLE_MARKDOWN_ATTENTION_WORK_UNITS} attention grammar-event work units, {MAX_BUNDLE_MARKDOWN_CONTAINER_WORK_UNITS} list/blockquote continuation work units, {MAX_BUNDLE_MARKDOWN_LABEL_END_WORK_UNITS} link-label closing work units, {MAX_BUNDLE_MARKDOWN_SYNTAX_CANDIDATES} syntax candidates, or {MAX_BUNDLE_MARKDOWN_LINK_CANDIDATES} link candidates. Reduce or split the bundle, then retry."
                    ),
                    Some("bundle"),
                );
                item.range = Some(range_for(
                    &document.text,
                    markdown_start,
                    document.text.len(),
                ));
                failures.push(item);
                if !is_reserved(&document.path) {
                    pending.push(PendingConcept {
                        concept: partial_concept(&document),
                        candidates: Vec::new(),
                    });
                }
                bundle_limit_reached = true;
                continue;
            }
            inspected_markdown_body_code_units += body_code_units;
            inspected_markdown_lines += body_lines;
            inspected_markdown_attention_work_units += markdown_work.attention_work_units;
            inspected_markdown_container_work_units += markdown_work.container_work_units;
            inspected_markdown_label_end_work_units += markdown_work.label_end_work_units;
            inspected_markdown_syntax_candidates += syntax_candidates;
            inspected_markdown_link_candidates += markdown_work.link_candidates;
        }

        let parsed = parse_frontmatter(&document.text);
        if is_reserved(&document.path) {
            let (frontmatter, body, body_range) = match parsed {
                Ok(value) => value,
                Err(error) => {
                    let mut item = failure(
                        &document.uri,
                        &document.path,
                        if error.resource_limit {
                            ParseFailureReason::ResourceLimit
                        } else {
                            ParseFailureReason::Frontmatter
                        },
                        &error.message,
                        error.resource_limit.then_some("document"),
                    );
                    item.range = error.range;
                    failures.push(item);
                    continue;
                }
            };
            let reserved_kind = if file_name(&document.path) == "index.md" {
                "index"
            } else {
                "log"
            };
            if let Some(frontmatter) = frontmatter.as_ref() {
                let frontmatter_units = semantic_mapping_output_units(&frontmatter.raw);
                if retained_frontmatter_units
                    > MAX_BUNDLE_FRONTMATTER_OUTPUT_UNITS.saturating_sub(frontmatter_units)
                {
                    let mut item = failure(
                        &document.uri,
                        &document.path,
                        ParseFailureReason::ResourceLimit,
                        &format!(
                            "Bundle frontmatter exceeds the {MAX_BUNDLE_FRONTMATTER_OUTPUT_UNITS}-unit aggregate safety limit. Reduce or split the bundle, then retry."
                        ),
                        Some("bundle"),
                    );
                    item.range = Some(frontmatter.range.clone());
                    failures.push(item);
                    bundle_limit_reached = true;
                    continue;
                }
                retained_frontmatter_units += frontmatter_units;
            }
            let okf_version = frontmatter.as_ref().and_then(|frontmatter| {
                normalized_string(&frontmatter.raw, &frontmatter.explicit_tags, "okf_version")
                    .map(str::to_owned)
            });
            reserved_documents.push(ReservedDocument {
                kind: "reserved".to_owned(),
                reserved_kind: reserved_kind.to_owned(),
                source: source_document(&document),
                body,
                body_range,
                frontmatter,
                okf_version,
            });
            continue;
        }

        let concept_id = document.path.trim_end_matches(".md").to_owned();
        let (frontmatter, body, body_range) = match parsed {
            Ok((Some(frontmatter), body, body_range)) => (frontmatter, body, body_range),
            Ok((None, _, _)) => {
                failures.push(failure(
                    &document.uri,
                    &document.path,
                    ParseFailureReason::Frontmatter,
                    "Concept Markdown must begin with a YAML frontmatter block.",
                    None,
                ));
                pending.push(PendingConcept {
                    concept: partial_concept(&document),
                    candidates: Vec::new(),
                });
                continue;
            }
            Err(error) => {
                let mut item = failure(
                    &document.uri,
                    &document.path,
                    if error.resource_limit {
                        ParseFailureReason::ResourceLimit
                    } else {
                        ParseFailureReason::Frontmatter
                    },
                    &error.message,
                    error.resource_limit.then_some("document"),
                );
                item.range = error.range;
                failures.push(item);
                pending.push(PendingConcept {
                    concept: partial_concept(&document),
                    candidates: Vec::new(),
                });
                continue;
            }
        };
        let frontmatter_units = semantic_mapping_output_units(&frontmatter.raw);
        if retained_frontmatter_units
            > MAX_BUNDLE_FRONTMATTER_OUTPUT_UNITS.saturating_sub(frontmatter_units)
        {
            let mut item = failure(
                &document.uri,
                &document.path,
                ParseFailureReason::ResourceLimit,
                &format!(
                    "Bundle frontmatter exceeds the {MAX_BUNDLE_FRONTMATTER_OUTPUT_UNITS}-unit aggregate safety limit. Reduce or split the bundle, then retry."
                ),
                Some("bundle"),
            );
            item.range = Some(frontmatter.range.clone());
            failures.push(item);
            pending.push(PendingConcept {
                concept: partial_concept(&document),
                candidates: Vec::new(),
            });
            bundle_limit_reached = true;
            continue;
        }
        let previous_frontmatter_units = retained_frontmatter_units;
        retained_frontmatter_units += frontmatter_units;
        if let Some(message) = concept_metadata_failure(&frontmatter.normalized) {
            retained_frontmatter_units = previous_frontmatter_units;
            let mut item = failure(
                &document.uri,
                &document.path,
                ParseFailureReason::ResourceLimit,
                &message,
                Some("document"),
            );
            item.range = Some(frontmatter.range.clone());
            failures.push(item);
            pending.push(PendingConcept {
                concept: partial_concept(&document),
                candidates: Vec::new(),
            });
            continue;
        }
        let body_start = document.text.len().saturating_sub(body.len());
        let candidates = match markdown_links(&body, body_start, &document.text) {
            Ok(candidates) => candidates,
            Err(message) => {
                retained_frontmatter_units = previous_frontmatter_units;
                let mut item = failure(
                    &document.uri,
                    &document.path,
                    ParseFailureReason::ResourceLimit,
                    &message,
                    Some("document"),
                );
                item.range = Some(body_range);
                failures.push(item);
                pending.push(PendingConcept {
                    concept: partial_concept(&document),
                    candidates: Vec::new(),
                });
                continue;
            }
        };
        if total_links > MAX_LINKS.saturating_sub(candidates.len()) {
            let mut item = failure(
                &document.uri,
                &document.path,
                ParseFailureReason::ResourceLimit,
                &format!(
                    "Bundle parsing refused more than {MAX_LINKS} Markdown relationships. Reduce or split the document or bundle, then retry."
                ),
                Some("bundle"),
            );
            item.range = Some(body_range.clone());
            failures.push(item);
            pending.push(PendingConcept {
                concept: partial_concept(&document),
                candidates: Vec::new(),
            });
            bundle_limit_reached = true;
            continue;
        }
        let normalized = &frontmatter.normalized;
        let retained_text_units = candidates.iter().fold(0usize, |total, candidate| {
            total.saturating_add(candidate.target.len() + candidate.label.len())
        });
        if retained_link_text_units > MAX_BUNDLE_LINK_TEXT_UNITS.saturating_sub(retained_text_units)
        {
            let mut item = failure(
                &document.uri,
                &document.path,
                ParseFailureReason::ResourceLimit,
                &format!(
                    "Bundle Markdown link targets and labels exceed the {MAX_BUNDLE_LINK_TEXT_UNITS}-unit aggregate safety limit. Reduce or split the bundle, then retry."
                ),
                Some("bundle"),
            );
            item.range = Some(body_range.clone());
            failures.push(item);
            pending.push(PendingConcept {
                concept: partial_concept(&document),
                candidates: Vec::new(),
            });
            bundle_limit_reached = true;
            continue;
        }

        let unique_document_tags = normalized.tags.iter().collect::<BTreeSet<_>>();
        let new_type_count =
            usize::from(!retained_types.contains(normalized.r#type.as_deref().unwrap_or_default()));
        let new_unique_tag_count = unique_document_tags
            .iter()
            .filter(|tag| !retained_tags.contains(tag.as_str()))
            .count();
        if retained_tag_assignments
            > MAX_BUNDLE_TAG_ASSIGNMENTS.saturating_sub(normalized.tags.len())
            || retained_types.len() > MAX_UNIQUE_GRAPH_TYPES.saturating_sub(new_type_count)
            || retained_tags.len() > MAX_UNIQUE_GRAPH_TAGS.saturating_sub(new_unique_tag_count)
        {
            retained_frontmatter_units = previous_frontmatter_units;
            let mut item = failure(
                &document.uri,
                &document.path,
                ParseFailureReason::ResourceLimit,
                &format!(
                    "Bundle graph metadata exceeds the {MAX_BUNDLE_TAG_ASSIGNMENTS} tag-assignment, {MAX_UNIQUE_GRAPH_TAGS} unique-tag, or {MAX_UNIQUE_GRAPH_TYPES} unique-type safety limit. Reduce or split the bundle, then retry."
                ),
                Some("bundle"),
            );
            item.range = Some(frontmatter.range.clone());
            failures.push(item);
            pending.push(PendingConcept {
                concept: partial_concept(&document),
                candidates: Vec::new(),
            });
            bundle_limit_reached = true;
            continue;
        }

        total_links += candidates.len();
        retained_link_text_units += retained_text_units;
        retained_tag_assignments += normalized.tags.len();
        retained_types.insert(normalized.r#type.clone().unwrap_or_default());
        retained_tags.extend(unique_document_tags.into_iter().cloned());
        pending.push(PendingConcept {
            concept: Concept {
                kind: "concept".to_owned(),
                id: concept_id,
                source: source_document(&document),
                frontmatter: frontmatter.clone(),
                r#type: normalized.r#type.clone().unwrap_or_default(),
                title: normalized.title.clone(),
                description: normalized.description.clone(),
                resource: normalized.resource.clone(),
                tags: normalized.tags.clone(),
                timestamp: normalized.timestamp.clone(),
                generated: normalized.generated.clone(),
                verified: normalized.verified.clone(),
                trust_tier: normalized.trust_tier.clone(),
                status: normalized.status.clone(),
                stale_after: normalized.stale_after.clone(),
                sources: normalized.sources.clone(),
                usage_window: normalized.usage_window.clone(),
                runtime: normalized.runtime.clone(),
                parameters: normalized.parameters.clone(),
                computation: normalized.computation.clone(),
                executor: normalized.executor.clone(),
                attester: normalized.attester.clone(),
                body,
                body_range,
                links: Vec::new(),
            },
            candidates,
        });
    }

    let mut concepts = Vec::with_capacity(pending.len());
    for mut item in pending {
        item.concept.links = item
            .candidates
            .into_iter()
            .map(|candidate| {
                resolve_link(
                    &item.concept.id,
                    &item.concept.source.bundle_path,
                    candidate,
                    &concept_paths,
                    &directories,
                    &reserved_paths,
                )
            })
            .collect();
        concepts.push(item.concept);
    }
    concepts.sort_by(|left, right| {
        compare_utf16(&left.id, &right.id)
            .then_with(|| compare_utf16(&left.source.uri, &right.source.uri))
    });
    reserved_documents.sort_by(|left, right| {
        compare_utf16(&left.source.bundle_path, &right.source.bundle_path)
            .then_with(|| compare_utf16(&left.source.uri, &right.source.uri))
    });
    failures.sort_by(|left, right| {
        compare_utf16(&left.bundle_path, &right.bundle_path)
            .then_with(|| compare_utf16(&left.uri, &right.uri))
    });

    ParsedBundle {
        root_uri: input.root_uri,
        revision: input.revision,
        concepts,
        reserved_documents,
        failures,
        findings: Vec::new(),
    }
}

fn decode_document(
    document: BundleDocumentInput,
    path: String,
) -> Result<DecodedDocument, Box<ParseFailure>> {
    let content = document.content.ok_or_else(|| {
        Box::new(failure(
            &document.uri,
            &path,
            ParseFailureReason::Read,
            "The workspace adapter did not supply readable content.",
            None,
        ))
    })?;
    let (mut text, fallback_hash, source_was_text, source_bytes) = match content {
        DocumentContent::Text(text) => {
            let hash = fallback_content_hash(text.as_bytes());
            let bytes = text.len();
            (text, hash, true, bytes)
        }
        DocumentContent::Bytes(bytes) => {
            let hash = fallback_content_hash(&bytes);
            let source_bytes = bytes.len();
            let text = String::from_utf8(bytes).map_err(|_| {
                Box::new(failure(
                    &document.uri,
                    &path,
                    ParseFailureReason::Decode,
                    "Document bytes are not valid UTF-8.",
                    None,
                ))
            })?;
            (text, hash, false, source_bytes)
        }
        DocumentContent::InvalidUtf16 { .. } => {
            return Err(Box::new(failure(
                &document.uri,
                &path,
                ParseFailureReason::Decode,
                "Already-decoded document text contains an unpaired UTF-16 surrogate.",
                None,
            )));
        }
    };
    if source_was_text && text.encode_utf16().count() > MAX_DOCUMENT_CODE_UNITS {
        return Err(Box::new(failure(
            &document.uri,
            &path,
            ParseFailureReason::ResourceLimit,
            "Decoded Markdown exceeds the 327696-code-unit pre-parse safety limit. Reduce or split the document, then retry.",
            Some("document"),
        )));
    }
    if source_bytes > MAX_DOCUMENT_BYTES {
        return Err(Box::new(failure(
            &document.uri,
            &path,
            ParseFailureReason::ResourceLimit,
            "Markdown source exceeds the 327696-byte pre-parse safety limit. Reduce or split the document, then retry.",
            Some("document"),
        )));
    }
    let bom_count = text
        .chars()
        .take_while(|character| *character == '\u{feff}')
        .count();
    if bom_count > 1 {
        return Err(Box::new(failure(
            &document.uri,
            &path,
            ParseFailureReason::Decode,
            "Document begins with more than one UTF-8 byte-order mark.",
            None,
        )));
    }
    if bom_count == 1 {
        text = text.trim_start_matches('\u{feff}').to_owned();
    }
    if text.encode_utf16().count() > MAX_DOCUMENT_CODE_UNITS {
        let mut item = failure(
            &document.uri,
            &path,
            ParseFailureReason::ResourceLimit,
            "Decoded Markdown exceeds the 327696-code-unit pre-parse safety limit. Reduce or split the document, then retry.",
            Some("document"),
        );
        item.range = Some(range_for(&text, 0, text.len()));
        return Err(Box::new(item));
    }
    if semantic_line_count(&text) > MAX_DOCUMENT_LINES {
        let mut item = failure(
            &document.uri,
            &path,
            ParseFailureReason::ResourceLimit,
            "Markdown source exceeds the 24002-line pre-index safety limit. Reduce or split the document, then retry.",
            Some("document"),
        );
        item.range = Some(range_for(&text, 0, text.len()));
        return Err(Box::new(item));
    }
    let hash = document.content_hash.unwrap_or(fallback_hash);
    Ok(DecodedDocument {
        uri: document.uri,
        path,
        text,
        hash,
        identity_only: false,
    })
}

fn identity_only_document(document: BundleDocumentInput, path: String) -> DecodedDocument {
    DecodedDocument {
        uri: document.uri,
        path,
        text: String::new(),
        hash: "resource-limit:unparsed".to_owned(),
        identity_only: true,
    }
}

fn failed_document(
    document: &BundleDocumentInput,
    path: String,
    parse_failure: &ParseFailure,
) -> DecodedDocument {
    let hash = if parse_failure.reason == ParseFailureReason::Decode
        || (parse_failure.reason == ParseFailureReason::ResourceLimit
            && parse_failure.range.is_some())
    {
        document.content_hash.clone().unwrap_or_else(|| {
            document.content.as_ref().map_or_else(
                || "resource-limit:unparsed".to_owned(),
                |content| match content {
                    DocumentContent::Text(text) => fallback_content_hash(text.as_bytes()),
                    DocumentContent::Bytes(bytes) => fallback_content_hash(bytes),
                    DocumentContent::InvalidUtf16 { .. } => "resource-limit:unparsed".to_owned(),
                },
            )
        })
    } else {
        "resource-limit:unparsed".to_owned()
    };
    DecodedDocument {
        uri: document.uri.clone(),
        path,
        text: String::new(),
        hash,
        identity_only: true,
    }
}

fn source_document(document: &DecodedDocument) -> SourceDocument {
    SourceDocument {
        uri: document.uri.clone(),
        bundle_path: document.path.clone(),
        content_hash: document.hash.clone(),
    }
}

fn partial_concept(document: &DecodedDocument) -> Concept {
    Concept {
        kind: "concept".to_owned(),
        id: document.path.trim_end_matches(".md").to_owned(),
        source: source_document(document),
        frontmatter: ParsedFrontmatter {
            normalized: NormalizedFrontmatter {
                trust_tier: "unverified".to_owned(),
                ..NormalizedFrontmatter::default()
            },
            ..ParsedFrontmatter::default()
        },
        r#type: String::new(),
        title: None,
        description: None,
        resource: None,
        tags: Vec::new(),
        timestamp: None,
        generated: None,
        verified: Vec::new(),
        trust_tier: "unverified".to_owned(),
        status: None,
        stale_after: None,
        sources: Vec::new(),
        usage_window: None,
        runtime: None,
        parameters: Vec::new(),
        computation: None,
        executor: None,
        attester: None,
        body: String::new(),
        body_range: SourceRange::default(),
        links: Vec::new(),
    }
}

fn frontmatter_work(text: &str) -> (Option<FrontmatterWork>, Option<usize>) {
    let lines = line_spans(text);
    let Some(opening) = lines.first() else {
        return (None, Some(0));
    };
    if &text[opening.start..opening.content_end] != "---" {
        return (None, Some(0));
    }
    let Some(closing) = lines
        .iter()
        .skip(1)
        .find(|line| &text[line.start..line.content_end] == "---")
    else {
        return (None, None);
    };
    let source = &text[opening.end..closing.start];
    (
        Some(FrontmatterWork {
            start: opening.end,
            end: closing.start,
            source_code_units: source.encode_utf16().count(),
            structural_tokens: yaml_structural_token_count(source),
        }),
        Some(closing.end),
    )
}

fn yaml_structural_token_count(source: &str) -> usize {
    source
        .chars()
        .filter(|character| {
            let code = u32::from(*character);
            (code > 0 && code < 0x20 && !matches!(character, '\t' | '\n' | '\r'))
                || (0x21..=0x2f).contains(&code)
                || (0x3a..=0x40).contains(&code)
                || (0x5b..=0x60).contains(&code)
                || (0x7b..=0x7e).contains(&code)
        })
        .count()
}

fn parse_frontmatter(
    text: &str,
) -> Result<(Option<ParsedFrontmatter>, String, SourceRange), FrontmatterError> {
    let lines = line_spans(text);
    let Some(opening) = lines.first() else {
        return Ok((None, text.to_owned(), range_for(text, 0, text.len())));
    };
    if &text[opening.start..opening.content_end] != "---" {
        return Ok((None, text.to_owned(), range_for(text, 0, text.len())));
    }
    let opening_end = opening.end;
    let closing = lines
        .iter()
        .skip(1)
        .find(|line| &text[line.start..line.content_end] == "---")
        .ok_or_else(|| FrontmatterError {
            message: "YAML frontmatter has no closing delimiter.".to_owned(),
            range: Some(range_for(text, 0, opening_end)),
            resource_limit: false,
        })?;
    let closing_start = closing.start;
    let closing_line_end = closing.end;
    let yaml_source = &text[opening_end..closing_start];
    let yaml_range = Some(range_for(text, opening_end, closing_start));
    let yaml_code_units = yaml_source.encode_utf16().count();
    if yaml_code_units > MAX_FRONTMATTER_SOURCE_CODE_UNITS {
        return Err(FrontmatterError {
            message: format!(
                "YAML frontmatter exceeds the {MAX_FRONTMATTER_SOURCE_CODE_UNITS}-code-unit pre-parse safety limit. Reduce the metadata, then retry."
            ),
            range: yaml_range,
            resource_limit: true,
        });
    }
    if yaml_source.len() > MAX_FRONTMATTER_SOURCE_BYTES {
        return Err(FrontmatterError {
            message: format!(
                "YAML frontmatter exceeds the {MAX_FRONTMATTER_SOURCE_BYTES}-byte pre-parse safety limit. Reduce the metadata, then retry."
            ),
            range: yaml_range,
            resource_limit: true,
        });
    }
    if let Some(message) = frontmatter_complexity_failure(yaml_source) {
        return Err(FrontmatterError {
            message,
            range: yaml_range,
            resource_limit: true,
        });
    }
    let (lexical_alias_count, expanded_alias_count, expanded_alias_scalar_units) =
        yaml_alias_occurrence_count(yaml_source);
    let deferred_flat_alias_limit =
        expanded_alias_count > MAX_ALIAS_EXPANSIONS && expanded_alias_count == lexical_alias_count;
    if expanded_alias_count > MAX_ALIAS_EXPANSIONS && !deferred_flat_alias_limit {
        return Err(FrontmatterError {
            message: format!(
                "YAML frontmatter is not JSON-safe: more than {MAX_ALIAS_EXPANSIONS} alias expansions are not supported"
            ),
            range: yaml_range,
            resource_limit: false,
        });
    }
    if let Some((relative_start, relative_end)) = multiple_yaml_document_range(yaml_source) {
        return Err(FrontmatterError {
            message: "Invalid YAML frontmatter: Source contains multiple documents; please use YAML.parseAllDocuments()".to_owned(),
            range: Some(range_for(
                text,
                opening_end + relative_start,
                opening_end + relative_end,
            )),
            resource_limit: false,
        });
    }
    if let Some(tag) = reserved_internal_tag(yaml_source) {
        return Err(FrontmatterError {
            message: format!(
                "YAML frontmatter is not JSON-safe: custom YAML tag is not supported: {tag}"
            ),
            range: yaml_range,
            resource_limit: false,
        });
    }
    if let Some((relative_start, relative_end)) = invalid_comment_separator_range(yaml_source) {
        return Err(FrontmatterError {
            message: "Invalid YAML frontmatter: Comments must be separated from other tokens by white space characters".to_owned(),
            range: Some(range_for(
                text,
                opening_end + relative_start,
                opening_end + relative_end,
            )),
            resource_limit: false,
        });
    }
    if let Some((_, _, tag)) = unsupported_yaml_2002_tag_range(yaml_source) {
        return Err(FrontmatterError {
            message: format!(
                "YAML frontmatter is not JSON-safe: custom YAML tag is not supported: {tag}"
            ),
            range: yaml_range,
            resource_limit: false,
        });
    }
    if let Some(alias) = unresolved_tight_alias_name(yaml_source) {
        return Err(FrontmatterError {
            message: format!("YAML frontmatter is not JSON-safe: unresolved YAML alias: {alias}"),
            range: yaml_range,
            resource_limit: false,
        });
    }
    if let Some((relative_start, relative_end)) = multiline_implicit_key_range(yaml_source) {
        return Err(FrontmatterError {
            message: "Invalid YAML frontmatter: Implicit keys need to be on a single line"
                .to_owned(),
            range: Some(range_for(
                text,
                opening_end + relative_start,
                opening_end + relative_end,
            )),
            resource_limit: false,
        });
    }
    if let Some((relative_start, relative_end)) = compact_nested_mapping_range(yaml_source) {
        return Err(FrontmatterError {
            message:
                "Invalid YAML frontmatter: Nested mappings are not allowed in compact mappings"
                    .to_owned(),
            range: Some(range_for(
                text,
                opening_end + relative_start,
                opening_end + relative_end,
            )),
            resource_limit: false,
        });
    }
    if let Some((relative_start, relative_end)) = invalid_explicit_timestamp_range(yaml_source) {
        return Err(FrontmatterError {
            message:
                "Invalid YAML frontmatter: !!timestamp expects a date, starting with yyyy-mm-dd"
                    .to_owned(),
            range: Some(range_for(
                text,
                opening_end + relative_start,
                opening_end + relative_end,
            )),
            resource_limit: false,
        });
    }
    if let Some((relative_start, relative_end, indicator)) =
        invalid_flow_block_scalar_range(yaml_source)
    {
        return Err(FrontmatterError {
            message: format!(
                "Invalid YAML frontmatter: Plain value cannot start with block scalar indicator {indicator}"
            ),
            range: Some(range_for(
                text,
                opening_end + relative_start,
                opening_end + relative_end,
            )),
            resource_limit: false,
        });
    }
    if let Some((relative_start, relative_end)) = missing_flow_map_comma_range(yaml_source) {
        return Err(FrontmatterError {
            message: "Invalid YAML frontmatter: Missing , between flow map items".to_owned(),
            range: Some(range_for(
                text,
                opening_end + relative_start,
                opening_end + relative_end,
            )),
            resource_limit: false,
        });
    }
    if let Some((relative_start, relative_end)) =
        invalid_deferred_flow_property_key_range(yaml_source)
    {
        return Err(FrontmatterError {
            message: "Invalid YAML frontmatter: Anchors and tags must be after the ? indicator"
                .to_owned(),
            range: Some(range_for(
                text,
                opening_end + relative_start,
                opening_end + relative_end,
            )),
            resource_limit: false,
        });
    }
    if let Some((relative_start, relative_end, closing)) = under_indented_flow_range(yaml_source) {
        return Err(FrontmatterError {
            message: format!(
                "Invalid YAML frontmatter: Flow {} in block collection must be sufficiently indented and end with a {closing}",
                if closing == ']' { "sequence" } else { "map" }
            ),
            range: Some(range_for(
                text,
                opening_end + relative_start,
                opening_end + relative_end,
            )),
            resource_limit: false,
        });
    }
    if let Some((relative_start, relative_end)) = non_null_standard_set_value_range(yaml_source) {
        return Err(FrontmatterError {
            message: "Invalid YAML frontmatter: Set items must all have null values".to_owned(),
            range: Some(range_for(
                text,
                opening_end + relative_start,
                opening_end + relative_end,
            )),
            resource_limit: false,
        });
    }
    if let Some((relative_start, relative_end)) = duplicate_empty_explicit_key_range(yaml_source) {
        return Err(FrontmatterError {
            message: "Invalid YAML frontmatter: Map keys must be unique".to_owned(),
            range: Some(range_for(
                text,
                opening_end + relative_start,
                opening_end + relative_end,
            )),
            resource_limit: false,
        });
    }
    if let Some((relative_start, relative_end)) =
        duplicate_flow_mapping_key_range_anywhere(yaml_source)
    {
        return Err(FrontmatterError {
            message: "Invalid YAML frontmatter: Map keys must be unique".to_owned(),
            range: Some(range_for(
                text,
                opening_end + relative_start,
                opening_end + relative_end,
            )),
            resource_limit: false,
        });
    }
    let empty_string_key_safe_yaml = rewrite_empty_standard_string_keys(yaml_source);
    let yaml_for_key_checks = empty_string_key_safe_yaml.as_deref().unwrap_or(yaml_source);
    if let Some((relative_start, relative_end)) =
        duplicate_semantic_tagged_mapping_key_range(yaml_source)
    {
        return Err(FrontmatterError {
            message: "Invalid YAML frontmatter: Map keys must be unique".to_owned(),
            range: Some(range_for(
                text,
                opening_end + relative_start,
                opening_end + relative_end,
            )),
            resource_limit: false,
        });
    }
    let duplicate_tag = multiple_block_node_property_range(yaml_source, NodePropertyKind::Tag);
    let duplicate_anchor =
        multiple_block_node_property_range(yaml_source, NodePropertyKind::Anchor);
    if let Some((relative_start, relative_end, property)) = match (duplicate_tag, duplicate_anchor)
    {
        (Some(tag), Some(anchor)) if anchor.0 < tag.0 => {
            Some((anchor.0, anchor.1, NodePropertyKind::Anchor))
        }
        (Some(tag), _) => Some((tag.0, tag.1, NodePropertyKind::Tag)),
        (None, Some(anchor)) => Some((anchor.0, anchor.1, NodePropertyKind::Anchor)),
        (None, None) => None,
    } {
        return Err(FrontmatterError {
            message: format!(
                "Invalid YAML frontmatter: A node can have at most one {}",
                match property {
                    NodePropertyKind::Tag => "tag",
                    NodePropertyKind::Anchor => "anchor",
                }
            ),
            range: Some(range_for(
                text,
                opening_end + relative_start,
                opening_end + relative_end,
            )),
            resource_limit: false,
        });
    }
    if let Some((relative_start, relative_end)) = non_string_mapping_key_range(yaml_for_key_checks)
    {
        return Err(FrontmatterError {
            message: "YAML frontmatter mappings must use string field names at every level."
                .to_owned(),
            range: Some(range_for(
                text,
                opening_end + relative_start,
                opening_end + relative_end,
            )),
            resource_limit: false,
        });
    }
    if radix_set_output_lower_bound_exceeded(yaml_source) {
        return Err(FrontmatterError {
            message: format!(
                "YAML frontmatter is not JSON-safe: semantic output exceeds the {MAX_FRONTMATTER_OUTPUT_UNITS}-unit per-document safety limit"
            ),
            range: yaml_range,
            resource_limit: true,
        });
    }
    if let Some((relative_start, relative_end)) = duplicate_block_set_member_range(yaml_source) {
        return Err(FrontmatterError {
            message: "Invalid YAML frontmatter: Map keys must be unique".to_owned(),
            range: Some(range_for(
                text,
                opening_end + relative_start,
                opening_end + relative_end,
            )),
            resource_limit: false,
        });
    }
    if contains_untagged_nonfinite_number(yaml_source) {
        return Err(FrontmatterError {
            message: "YAML frontmatter is not JSON-safe: non-finite numbers are not supported"
                .to_owned(),
            range: yaml_range,
            resource_limit: false,
        });
    }
    if let Some((relative_start, relative_end)) = duplicate_standard_set_map_key_range(yaml_source)
    {
        return Err(FrontmatterError {
            message: "Invalid YAML frontmatter: Map keys must be unique".to_owned(),
            range: Some(range_for(
                text,
                opening_end + relative_start,
                opening_end + relative_end,
            )),
            resource_limit: false,
        });
    }
    if yaml_source.contains('\u{0085}')
        && let Some((relative_start, relative_end)) = duplicate_mapping_key_range(yaml_source)
    {
        return Err(FrontmatterError {
            message: "Invalid YAML frontmatter: Map keys must be unique".to_owned(),
            range: Some(range_for(
                text,
                opening_end + relative_start,
                opening_end + relative_end,
            )),
            resource_limit: false,
        });
    }
    if let Some((relative_start, relative_end)) = nested_compact_literal_nel_range(yaml_source) {
        return Err(FrontmatterError {
            message:
                "Invalid YAML frontmatter: Nested mappings are not allowed in compact mappings"
                    .to_owned(),
            range: Some(range_for(
                text,
                opening_end + relative_start,
                opening_end + relative_end,
            )),
            resource_limit: false,
        });
    }
    if let Some((relative_start, relative_end)) = invalid_root_type_literal_nel_range(yaml_source) {
        return Err(FrontmatterError {
            message: "YAML frontmatter must be a mapping with string field names.".to_owned(),
            range: Some(range_for(
                text,
                opening_end + relative_start,
                opening_end + relative_end,
            )),
            resource_limit: false,
        });
    }
    if let Some((relative_start, relative_end)) = invalid_structural_literal_nel_range(yaml_source)
    {
        return Err(FrontmatterError {
            message:
                "Invalid YAML frontmatter: Implicit map keys need to be followed by map values"
                    .to_owned(),
            range: Some(range_for(
                text,
                opening_end + relative_start,
                opening_end + relative_end,
            )),
            resource_limit: false,
        });
    }
    let (nel_safe_yaml, literal_nel_marker) = mask_literal_nel(yaml_source);
    let (separator_safe_yaml, literal_separator_markers) =
        mask_literal_yaml_separators(&nel_safe_yaml);
    let normalized_yaml = normalize_line_breaks(&separator_safe_yaml);
    let (plain_safe_yaml, plain_continuation_marker) =
        mask_plain_scalar_continuation_indicators(&normalized_yaml);
    let empty_key_safe_yaml =
        rewrite_empty_standard_string_keys(&plain_safe_yaml).unwrap_or(plain_safe_yaml);
    let set_safe_yaml = rewrite_standard_sets_for_serde(&empty_key_safe_yaml);
    let multiline_flow_key_safe_yaml = normalize_multiline_quoted_flow_keys(&set_safe_yaml);
    let anchor_safe_yaml = normalize_hash_anchor_names(&multiline_flow_key_safe_yaml);
    let flow_plain_safe_yaml = normalize_tight_flow_plain_keys(&anchor_safe_yaml);
    let parser_yaml =
        mask_large_yaml_integers(&mask_invalid_standard_scalar_tags(&flow_plain_safe_yaml));
    let parser_yaml = parser_yaml.strip_prefix('\u{feff}').unwrap_or(&parser_yaml);
    let yaml: serde_yaml::Value = serde_yaml::from_str(parser_yaml).map_err(|error| {
        let error_text = error.to_string();
        let recursive_alias = error_text.contains("recursion limit exceeded");
        let range = if recursive_alias {
            Some(range_for(text, opening_end, closing_start))
        } else if error_text.contains("duplicate entry with key") {
            duplicate_mapping_key_range(yaml_source).map(|(relative_start, relative_end)| {
                range_for(
                    text,
                    opening_end + relative_start,
                    opening_end + relative_end,
                )
            })
        } else {
            error.location().map(|location| {
                let relative_line = location.line().saturating_sub(1);
                let source_lines = line_spans(yaml_source);
                let line = source_lines
                    .get(relative_line)
                    .or_else(|| source_lines.last());
                let start = opening_end + line.map_or(0, |line| line.start);
                range_for(text, start, one_character_end(text, start, closing_start))
            })
        };
        let message = if recursive_alias {
            "YAML frontmatter is not JSON-safe: recursive aliases are not supported".to_owned()
        } else if error_text.contains("expected ',' or ']'") {
            "Invalid YAML frontmatter: Flow sequence in block collection must be sufficiently indented and end with a ]".to_owned()
        } else if error_text.contains("duplicate entry with key") {
            "Invalid YAML frontmatter: Map keys must be unique".to_owned()
        } else if error_text.contains("did not find expected key")
            && has_misaligned_plain_scalar_property(yaml_source)
        {
            "Invalid YAML frontmatter: All mapping items must start at the same column".to_owned()
        } else {
            format!("Invalid YAML frontmatter: {error}")
        };
        FrontmatterError {
            message,
            range,
            resource_limit: false,
        }
    })?;
    let mut explicit_tags = collect_yaml_explicit_tags(&yaml);
    let mut raw = match yaml_to_json(yaml).map_err(|message| FrontmatterError {
        message,
        range: Some(range_for(text, opening_end, closing_start)),
        resource_limit: false,
    })? {
        Value::Object(map) => map,
        _ => {
            return Err(FrontmatterError {
                message: "YAML frontmatter must be a mapping with string field names.".to_owned(),
                range: Some(range_for(text, opening_end, closing_start)),
                resource_limit: false,
            });
        }
    };
    if let Some(marker) = literal_nel_marker.as_deref() {
        if literal_nel_key_collision_in_map(&raw, marker) {
            let (relative_start, relative_end) =
                duplicate_mapping_key_range(yaml_source).unwrap_or((0, yaml_source.len()));
            return Err(FrontmatterError {
                message: "Invalid YAML frontmatter: Map keys must be unique".to_owned(),
                range: Some(range_for(
                    text,
                    opening_end + relative_start,
                    opening_end + relative_end,
                )),
                resource_limit: false,
            });
        }
        restore_literal_nel_in_map(&mut raw, marker);
        restore_literal_nel_in_map(&mut explicit_tags, marker);
    }
    for (marker, separator) in &literal_separator_markers {
        if literal_character_key_collision_in_map(&raw, marker, *separator) {
            let (relative_start, relative_end) =
                duplicate_mapping_key_range(yaml_source).unwrap_or((0, yaml_source.len()));
            return Err(FrontmatterError {
                message: "Invalid YAML frontmatter: Map keys must be unique".to_owned(),
                range: Some(range_for(
                    text,
                    opening_end + relative_start,
                    opening_end + relative_end,
                )),
                resource_limit: false,
            });
        }
        restore_literal_character_in_map(&mut raw, marker, *separator);
        restore_literal_character_in_map(&mut explicit_tags, marker, *separator);
    }
    if let Some(marker) = plain_continuation_marker.as_deref() {
        remove_marker_in_map(&mut raw, marker);
        remove_marker_in_map(&mut explicit_tags, marker);
    }
    if semantic_mapping_output_units(&raw).max(expanded_alias_scalar_units)
        > MAX_FRONTMATTER_OUTPUT_UNITS
    {
        return Err(FrontmatterError {
            message: format!(
                "YAML frontmatter is not JSON-safe: semantic output exceeds the {MAX_FRONTMATTER_OUTPUT_UNITS}-unit per-document safety limit"
            ),
            range: yaml_range,
            resource_limit: true,
        });
    }
    if deferred_flat_alias_limit {
        return Err(FrontmatterError {
            message: format!(
                "YAML frontmatter is not JSON-safe: more than {MAX_ALIAS_EXPANSIONS} alias expansions are not supported"
            ),
            range: yaml_range,
            resource_limit: false,
        });
    }
    let empty_preserved_anchors = std::collections::BTreeMap::new();
    let empty_value_anchors = std::collections::BTreeMap::new();
    let (pre_preserved_tags, pre_preserved_anchors) = preserve_standard_yaml_tags(
        yaml_source,
        &mut raw,
        &explicit_tags,
        &empty_preserved_anchors,
        &[],
    );
    explicit_tags = pre_preserved_tags;
    let initial_set_anchors = pre_preserved_anchors
        .into_iter()
        .filter_map(|(name, anchor)| {
            let value = match anchor {
                PreservedAnchor::Path(path) => {
                    let borrowed = path.iter().map(String::as_str).collect::<Vec<_>>();
                    value_at_path(&raw, &borrowed, &explicit_tags).cloned()
                }
                PreservedAnchor::Scalar { value, .. } => Some(value),
            }?;
            Some((name, value))
        })
        .collect();
    let set_member_anchors =
        restore_standard_set_sources(yaml_source, &mut raw, true, &initial_set_anchors);
    let (preserved_tags, _) = preserve_standard_yaml_tags(
        yaml_source,
        &mut raw,
        &explicit_tags,
        &empty_preserved_anchors,
        &set_member_anchors,
    );
    explicit_tags = preserved_tags;
    restore_standard_set_sources(yaml_source, &mut raw, false, &empty_value_anchors);
    if semantic_mapping_output_units(&raw) > MAX_FRONTMATTER_OUTPUT_UNITS {
        return Err(FrontmatterError {
            message: format!(
                "YAML frontmatter is not JSON-safe: semantic output exceeds the {MAX_FRONTMATTER_OUTPUT_UNITS}-unit per-document safety limit"
            ),
            range: yaml_range,
            resource_limit: true,
        });
    }
    if normalized_tags_contain_literal_nel(&raw, &explicit_tags) {
        return Err(FrontmatterError {
            message: "Concept tag contains a control character that is unsafe for graph filters."
                .to_owned(),
            range: yaml_range,
            resource_limit: true,
        });
    }
    if let Some(message) = normalized_scalar_literal_nel_message(&raw, &explicit_tags) {
        return Err(FrontmatterError {
            message,
            range: yaml_range,
            resource_limit: true,
        });
    }
    let explicit_tag_snapshot = explicit_tags.clone();
    explicit_tags.retain(|key, _| {
        if raw.contains_key(key) {
            return true;
        }
        let segments = explicit_tag_segments(key);
        if (1..segments.len()).any(|length| {
            let borrowed = segments[..length]
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>();
            value_at_path(&raw, &borrowed, &explicit_tag_snapshot)
                .and_then(|value| value.get(TAGGED_KEY))
                .and_then(Value::as_object)
                .and_then(|tagged| tagged.get("tag"))
                .and_then(Value::as_str)
                .is_some_and(|tag| {
                    matches!(
                        tag,
                        "tag:yaml.org,2002:set"
                            | "tag:yaml.org,2002:omap"
                            | "tag:yaml.org,2002:pairs"
                    )
                })
        }) {
            return false;
        }
        let borrowed = segments.iter().map(String::as_str).collect::<Vec<_>>();
        value_at_path(&raw, &borrowed, &explicit_tag_snapshot).is_some()
    });
    let fields = top_level_field_ranges(text, opening_end, closing_start);
    let verified = normalized_verifications(raw.get("verified"), &explicit_tags);
    let normalized = NormalizedFrontmatter {
        r#type: normalized_string(&raw, &explicit_tags, "type").map(str::to_owned),
        title: normalized_string(&raw, &explicit_tags, "title").map(str::to_owned),
        description: normalized_string(&raw, &explicit_tags, "description").map(str::to_owned),
        resource: normalized_string(&raw, &explicit_tags, "resource").map(str::to_owned),
        tags: raw
            .get("tags")
            .map(|value| {
                if explicit_tags.contains_key("tags") {
                    semantic_value(value)
                } else {
                    value
                }
            })
            .and_then(Value::as_array)
            .map(|tags| {
                tags.iter()
                    .enumerate()
                    .map(|(index, value)| {
                        let value = if explicit_tags.contains_key(&format!("/tags/{index}")) {
                            semantic_value(value)
                        } else {
                            value
                        };
                        value.as_str().map(str::to_owned)
                    })
                    .collect::<Option<Vec<_>>>()
                    .unwrap_or_default()
            })
            .unwrap_or_default(),
        timestamp: normalized_string(&raw, &explicit_tags, "timestamp").map(str::to_owned),
        generated: normalized_generated(raw.get("generated"), &explicit_tags),
        trust_tier: trust_tier(&verified).to_owned(),
        verified,
        status: normalized_string(&raw, &explicit_tags, "status").map(str::to_owned),
        stale_after: normalized_string(&raw, &explicit_tags, "stale_after").map(str::to_owned),
        sources: normalized_sources(raw.get("sources"), &explicit_tags),
        usage_window: normalized_usage_window(
            raw.get("usage_window"),
            &explicit_tags,
            "/usage_window",
        ),
        runtime: normalized_string(&raw, &explicit_tags, "runtime").map(str::to_owned),
        parameters: normalized_parameters(raw.get("parameters"), &explicit_tags),
        computation: normalized_string(&raw, &explicit_tags, "computation").map(str::to_owned),
        executor: normalized_endpoint(raw.get("executor"), &explicit_tags, "/executor"),
        attester: normalized_endpoint(raw.get("attester"), &explicit_tags, "/attester"),
    };
    let frontmatter = ParsedFrontmatter {
        raw,
        explicit_tags,
        source: yaml_source.to_owned(),
        range: range_for(text, opening_end, closing_start),
        fields,
        normalized,
    };
    Ok((
        Some(frontmatter),
        text[closing_line_end..].to_owned(),
        range_for(text, closing_line_end, text.len()),
    ))
}

#[derive(Clone, Copy)]
enum NodePropertyKind {
    Tag,
    Anchor,
}

fn multiple_block_node_property_range(
    source: &str,
    property: NodePropertyKind,
) -> Option<(usize, usize)> {
    let spans = line_spans(source);
    let mut excluded_ranges = block_scalar_body_ranges(source);
    excluded_ranges.extend(multiline_quoted_scalar_ranges(source));
    excluded_ranges.extend(plain_scalar_value_ranges(source));
    normalize_ranges(&mut excluded_ranges);
    for (line_index, line) in spans.iter().enumerate() {
        if sorted_range_contains(&excluded_ranges, line.start) {
            continue;
        }
        let body = &source[line.start..line.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = body.len() - trimmed.len();
        let Some(colon) = mapping_key_colon(trimmed) else {
            continue;
        };
        let value_source = trimmed[colon + 1..].trim_start();
        let (parent_remainder, parent_anchor, parent_tag) = split_node_properties(value_source);
        if !(parent_remainder.is_empty() || parent_remainder.starts_with('#'))
            || (parent_anchor.is_none() && parent_tag.is_none())
        {
            continue;
        }
        let mut property_count = usize::from(match property {
            NodePropertyKind::Tag => parent_tag.is_some(),
            NodePropertyKind::Anchor => parent_anchor.is_some(),
        });
        for candidate in spans.iter().skip(line_index + 1) {
            if sorted_range_contains(&excluded_ranges, candidate.start) {
                continue;
            }
            let child_body = &source[candidate.start..candidate.content_end];
            let child_trimmed = child_body.trim_start_matches([' ', '\t']);
            if child_trimmed.is_empty() || child_trimmed.starts_with('#') {
                continue;
            }
            let child_indent = child_body.len() - child_trimmed.len();
            if child_indent <= indent {
                break;
            }
            if child_trimmed.starts_with(['?', '-', ':']) {
                break;
            }
            let property_source = if let Some(child_colon) = mapping_key_colon(child_trimmed) {
                let key_source = child_trimmed[..child_colon].trim_end_matches([' ', '\t']);
                let (remainder, anchor, tag) = split_node_properties(key_source);
                if !remainder.is_empty() || (anchor.is_none() && tag.is_none()) {
                    break;
                }
                key_source
            } else {
                child_trimmed
            };
            let (remainder, anchor, tag) = split_node_properties(property_source);
            if anchor.is_none() && tag.is_none() {
                break;
            }
            let leading = child_body.len().saturating_sub(child_trimmed.len());
            let start = candidate.start + leading;
            let property_spans = match property {
                NodePropertyKind::Tag => node_tag_spans(property_source),
                NodePropertyKind::Anchor => node_anchor_spans(property_source),
            };
            for (property_start, property_end) in property_spans {
                if property_count > 0 {
                    return Some((start + property_start, start + property_end));
                }
                property_count += 1;
            }
            if !remainder.is_empty() && !remainder.starts_with('#') {
                break;
            }
        }
    }
    for line in &spans {
        if sorted_range_contains(&excluded_ranges, line.start) {
            continue;
        }
        let body = &source[line.start..line.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let leading = body.len() - trimmed.len();
        let mut candidates = Vec::new();
        if let Some(colon) = mapping_key_colon(trimmed) {
            let key = trimmed[..colon]
                .strip_prefix('?')
                .map(str::trim_start)
                .unwrap_or(&trimmed[..colon]);
            let key_offset = trimmed[..colon].len() - key.len();
            candidates.push((key, line.start + leading + key_offset));
            let value = trimmed[colon + 1..].trim_start();
            let value_offset = colon + 1 + trimmed[colon + 1..].len() - value.len();
            candidates.push((value, line.start + leading + value_offset));
        } else {
            let node = trimmed
                .strip_prefix(['?', '-', ':'])
                .filter(|_| trimmed[1..].chars().next().is_none_or(char::is_whitespace))
                .map(str::trim_start)
                .unwrap_or(trimmed);
            candidates.push((node, line.start + leading + trimmed.len() - node.len()));
        }
        for (candidate, start) in candidates {
            let duplicate = match property {
                NodePropertyKind::Tag => duplicate_node_tag_span(candidate),
                NodePropertyKind::Anchor => duplicate_node_anchor_span(candidate),
            }
            .or_else(|| duplicate_flow_node_property_span(candidate, property));
            if let Some((property_start, property_end)) = duplicate {
                return Some((start + property_start, start + property_end));
            }
        }
    }
    None
}

fn node_tag_spans(source: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut cursor = source.len() - source.trim_start().len();
    while cursor < source.len() {
        let token_length = match node_property_token_length(&source[cursor..]) {
            Some(length) => length,
            None => break,
        };
        let token = &source[cursor..cursor + token_length];
        if token.starts_with('&') {
            // Anchors may appear before or after a tag on the same node.
        } else if token.starts_with('!') {
            spans.push((cursor, cursor + token_length));
        } else {
            break;
        }
        cursor += token_length;
        cursor += source[cursor..].len() - source[cursor..].trim_start().len();
    }
    spans
}

fn node_anchor_spans(source: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut cursor = source.len() - source.trim_start().len();
    while cursor < source.len() {
        let token_length = match node_property_token_length(&source[cursor..]) {
            Some(length) => length,
            None => break,
        };
        let token = &source[cursor..cursor + token_length];
        if token.starts_with('&') {
            spans.push((cursor, cursor + token_length));
        } else if token.starts_with('!') {
            // Tags may appear before or after an anchor on the same node.
        } else {
            break;
        }
        cursor += token_length;
        cursor += source[cursor..].len() - source[cursor..].trim_start().len();
    }
    spans
}

fn duplicate_node_tag_span(source: &str) -> Option<(usize, usize)> {
    node_tag_spans(source).into_iter().nth(1)
}

fn duplicate_node_anchor_span(source: &str) -> Option<(usize, usize)> {
    node_anchor_spans(source).into_iter().nth(1)
}

fn duplicate_flow_node_property_span(
    source: &str,
    property: NodePropertyKind,
) -> Option<(usize, usize)> {
    let mut node_boundary = false;
    let mut quote = None;
    let mut escaped = false;
    let mut comment = false;
    let mut flow_depth = 0usize;
    let mut characters = source.char_indices().peekable();
    while let Some((offset, character)) = characters.next() {
        if comment {
            if matches!(character, '\r' | '\n') {
                comment = false;
            }
            continue;
        }
        if let Some(active_quote) = quote {
            if active_quote == '"' && character == '\\' && !escaped {
                escaped = true;
                continue;
            }
            if character == active_quote && !escaped {
                if active_quote == '\'' && characters.peek().is_some_and(|(_, next)| *next == '\'')
                {
                    characters.next();
                } else {
                    quote = None;
                }
            }
            escaped = false;
            continue;
        }
        match character {
            '#' if offset == 0
                || source[..offset]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_whitespace) =>
            {
                comment = true;
            }
            '"' | '\'' => {
                quote = Some(character);
                node_boundary = false;
            }
            '[' | '{' => {
                flow_depth += 1;
                node_boundary = true;
            }
            ']' | '}' => {
                flow_depth = flow_depth.saturating_sub(1);
                node_boundary = false;
            }
            ',' | ':' | '?' if flow_depth > 0 => node_boundary = true,
            character if character.is_whitespace() => {}
            '&' | '!' if flow_depth > 0 && node_boundary => {
                let duplicate = match property {
                    NodePropertyKind::Tag => duplicate_node_tag_span(&source[offset..]),
                    NodePropertyKind::Anchor => duplicate_node_anchor_span(&source[offset..]),
                };
                if let Some((start, end)) = duplicate {
                    return Some((offset + start, offset + end));
                }
            }
            _ => node_boundary = false,
        }
    }
    None
}

fn mask_literal_nel(source: &str) -> (String, Option<String>) {
    if !source.contains('\u{0085}') {
        return (source.to_owned(), None);
    }
    let marker = (0_u32..)
        .map(|index| format!("\u{e000}OKF-NEL-{index}\u{e001}"))
        .find(|candidate| !source.contains(candidate))
        .expect("an absent literal-NEL marker always exists");
    (source.replace('\u{0085}', &marker), Some(marker))
}

fn mask_literal_yaml_separators(source: &str) -> (String, Vec<(String, char)>) {
    let mut masked = source.to_owned();
    let mut markers = Vec::new();
    for (separator, label) in [('\u{2028}', "LS"), ('\u{2029}', "PS")] {
        if !masked.contains(separator) {
            continue;
        }
        let marker = (0_u32..)
            .map(|index| format!("\u{e000}OKF-{label}-{index}\u{e001}"))
            .find(|candidate| !masked.contains(candidate))
            .expect("an absent literal YAML-separator marker always exists");
        masked = masked.replace(separator, &marker);
        markers.push((marker, separator));
    }
    (masked, markers)
}

fn mask_plain_scalar_continuation_indicators(source: &str) -> (String, Option<String>) {
    let ranges = plain_scalar_continuation_ranges(source);
    if ranges.is_empty() {
        return (source.to_owned(), None);
    }
    let marker = (0_u32..)
        .map(|index| format!("\u{e000}OKF-PLAIN-{index}\u{e001}"))
        .find(|candidate| !source.contains(candidate))
        .expect("an absent plain-scalar marker always exists");
    let mut insertions = Vec::new();
    for line in line_spans(source) {
        if !sorted_range_contains(&ranges, line.start) {
            continue;
        }
        let body = &source[line.start..line.content_end];
        let leading = body.len() - body.trim_start_matches([' ', '\t']).len();
        let start = line.start + leading;
        if source[start..line.content_end].starts_with(['*', '!', '&']) {
            insertions.push(start);
        }
    }
    if insertions.is_empty() {
        return (source.to_owned(), None);
    }
    let mut masked = source.to_owned();
    for start in insertions.into_iter().rev() {
        masked.insert_str(start, &marker);
    }
    (masked, Some(marker))
}

fn restore_literal_nel_in_map(map: &mut Map<String, Value>, marker: &str) {
    restore_literal_character_in_map(map, marker, '\u{0085}');
}

fn restore_literal_character_in_map(map: &mut Map<String, Value>, marker: &str, character: char) {
    let mut restored = Map::with_capacity(map.len());
    for (key, mut value) in std::mem::take(map) {
        restore_literal_character_in_value(&mut value, marker, character);
        restored.insert(key.replace(marker, &character.to_string()), value);
    }
    *map = restored;
}

fn restore_literal_nel_in_value(value: &mut Value, marker: &str) {
    restore_literal_character_in_value(value, marker, '\u{0085}');
}

fn restore_literal_character_in_value(value: &mut Value, marker: &str, character: char) {
    match value {
        Value::String(text) => {
            if text.contains(marker) {
                *text = text.replace(marker, &character.to_string());
            }
        }
        Value::Array(values) => {
            for nested in values {
                restore_literal_character_in_value(nested, marker, character);
            }
        }
        Value::Object(map) => restore_literal_character_in_map(map, marker, character),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn remove_marker_in_map(map: &mut Map<String, Value>, marker: &str) {
    let mut restored = Map::with_capacity(map.len());
    for (key, mut value) in std::mem::take(map) {
        remove_marker_in_value(&mut value, marker);
        restored.insert(key.replace(marker, ""), value);
    }
    *map = restored;
}

fn remove_marker_in_value(value: &mut Value, marker: &str) {
    match value {
        Value::String(text) => {
            if text.contains(marker) {
                *text = text.replace(marker, "");
            }
        }
        Value::Array(values) => {
            for nested in values {
                remove_marker_in_value(nested, marker);
            }
        }
        Value::Object(map) => remove_marker_in_map(map, marker),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn semantic_mapping_output_units(map: &Map<String, Value>) -> usize {
    1usize.saturating_add(
        map.iter()
            .map(|(key, value)| {
                1usize
                    .saturating_add(key.len())
                    .saturating_add(semantic_value_output_units(value))
            })
            .fold(0usize, usize::saturating_add),
    )
}

fn semantic_value_output_units(value: &Value) -> usize {
    if let Some(exact) = value
        .as_object()
        .and_then(|map| (map.len() == 1).then_some(map))
        .and_then(|map| map.get(EXACT_INTEGER_KEY))
        .and_then(Value::as_str)
    {
        return 3usize.saturating_add(exact.len());
    }
    if let Some(tagged) = value
        .as_object()
        .and_then(|map| (map.len() == 1).then_some(map))
        .and_then(|map| map.get(TAGGED_KEY))
        .and_then(Value::as_object)
    {
        let tag = tagged
            .get("tag")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let source = tagged
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let semantic = tagged.get("value").unwrap_or(&Value::Null);
        let semantic_units = if tag == "tag:yaml.org,2002:binary" {
            semantic.as_array().map_or_else(
                || semantic_content_output_units(semantic),
                |bytes| 1usize.saturating_add(bytes.len().saturating_mul(9)),
            )
        } else {
            semantic_content_output_units(semantic)
        };
        return 4usize
            .saturating_add(tag.len())
            .saturating_add(source.len())
            .saturating_add(semantic_units);
    }
    1usize.saturating_add(semantic_content_output_units(value))
}

fn semantic_content_output_units(value: &Value) -> usize {
    if let Some(exact) = value
        .as_object()
        .and_then(|map| (map.len() == 1).then_some(map))
        .and_then(|map| map.get(EXACT_INTEGER_KEY))
        .and_then(Value::as_str)
    {
        return 2usize.saturating_add(exact.len());
    }
    match value {
        Value::Null | Value::Bool(_) => 1,
        Value::Number(_) => 8,
        Value::String(value) => value.len(),
        Value::Array(values) => values
            .iter()
            .map(|value| 1usize.saturating_add(semantic_value_output_units(value)))
            .fold(0usize, usize::saturating_add),
        Value::Object(map) => map
            .iter()
            .map(|(key, value)| {
                1usize
                    .saturating_add(key.len())
                    .saturating_add(semantic_value_output_units(value))
            })
            .fold(0usize, usize::saturating_add),
    }
}

fn literal_nel_key_collision_in_map(map: &Map<String, Value>, marker: &str) -> bool {
    literal_character_key_collision_in_map(map, marker, '\u{0085}')
}

fn literal_character_key_collision_in_map(
    map: &Map<String, Value>,
    marker: &str,
    character: char,
) -> bool {
    let mut restored_keys = std::collections::BTreeSet::new();
    map.iter().any(|(key, value)| {
        !restored_keys.insert(key.replace(marker, &character.to_string()))
            || literal_character_key_collision_in_value(value, marker, character)
    })
}

fn literal_character_key_collision_in_value(value: &Value, marker: &str, character: char) -> bool {
    match value {
        Value::Array(values) => values
            .iter()
            .any(|value| literal_character_key_collision_in_value(value, marker, character)),
        Value::Object(map) => literal_character_key_collision_in_map(map, marker, character),
        _ => false,
    }
}

fn normalized_tags_contain_literal_nel(
    raw: &Map<String, Value>,
    explicit_tags: &Map<String, Value>,
) -> bool {
    let Some(tags) = raw.get("tags") else {
        return false;
    };
    let tags = if explicit_tags.contains_key("tags") {
        semantic_value(tags)
    } else {
        tags
    };
    tags.as_array()
        .and_then(|values| {
            values
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    let tagged_source = value
                        .get(TAGGED_KEY)
                        .and_then(Value::as_object)
                        .and_then(|tagged| tagged.get("source"))
                        .and_then(Value::as_str);
                    let semantic = if explicit_tags.contains_key(&format!("/tags/{index}")) {
                        semantic_value(value)
                    } else {
                        value
                    };
                    semantic.as_str().map(|semantic| (semantic, tagged_source))
                })
                .collect::<Option<Vec<_>>>()
        })
        .is_some_and(|values| {
            values.iter().any(|(semantic, tagged_source)| {
                semantic.contains('\u{0085}')
                    || tagged_source.is_some_and(|source| source.contains('\u{0085}'))
            })
        })
}

fn normalized_scalar_literal_nel_message(
    raw: &Map<String, Value>,
    explicit_tags: &Map<String, Value>,
) -> Option<String> {
    if normalized_string(raw, explicit_tags, "type").is_some_and(|value| value.contains('\u{0085}'))
    {
        return Some(
            "Concept type contains a control character that is unsafe for graph filters."
                .to_owned(),
        );
    }
    [
        "resource",
        "timestamp",
        "status",
        "stale_after",
        "runtime",
        "computation",
    ]
    .iter()
    .any(|key| {
        normalized_string(raw, explicit_tags, key).is_some_and(|value| value.contains('\u{0085}'))
    })
    .then(|| {
        "Concept scalar metadata contains a control character that is unsafe for graph metadata."
            .to_owned()
    })
}

fn object_string(
    object: &Map<String, Value>,
    key: &str,
    explicit_tags: &Map<String, Value>,
    path: &str,
) -> Option<String> {
    let value = object.get(key)?;
    let value = if explicit_tags.contains_key(path) {
        semantic_value(value)
    } else {
        value
    };
    value.as_str().map(str::to_owned)
}

fn normalized_generated(
    value: Option<&Value>,
    explicit_tags: &Map<String, Value>,
) -> Option<GeneratedMetadata> {
    let object = value?.as_object()?;
    Some(GeneratedMetadata {
        by: object_string(object, "by", explicit_tags, "/generated/by"),
        at: object_string(object, "at", explicit_tags, "/generated/at"),
    })
}

fn normalized_verifications(
    value: Option<&Value>,
    explicit_tags: &Map<String, Value>,
) -> Vec<VerificationEvent> {
    let is_array = value.is_some_and(Value::is_array);
    let values = match value {
        Some(Value::Array(values)) => values.iter().collect::<Vec<_>>(),
        Some(value @ Value::Object(_)) => vec![value],
        _ => Vec::new(),
    };
    values
        .into_iter()
        .enumerate()
        .filter_map(|(index, value)| {
            let object = value.as_object()?;
            let prefix = if is_array {
                format!("/verified/{index}")
            } else {
                "/verified".to_owned()
            };
            Some(VerificationEvent {
                by: object_string(object, "by", explicit_tags, &format!("{prefix}/by")),
                at: object_string(object, "at", explicit_tags, &format!("{prefix}/at")),
            })
        })
        .collect()
}

fn trust_tier(events: &[VerificationEvent]) -> &'static str {
    let valid_events = events.iter().filter(|event| {
        event.by.as_deref().is_some_and(is_valid_actor)
            && event
                .at
                .as_deref()
                .is_some_and(|at| parse_explicit_zone_timestamp(at).is_some())
    });
    if valid_events.clone().any(|event| {
        event
            .by
            .as_deref()
            .is_some_and(|by| by.starts_with("human:"))
    }) {
        "human-reviewed"
    } else if valid_events.count() > 0 {
        "machine-confirmed"
    } else {
        "unverified"
    }
}

fn is_valid_actor_token(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'@' | b':' | b'-' | b'/')
        })
}

pub(crate) fn is_valid_actor(value: &str) -> bool {
    if value.is_empty() || value.len() > 256 || value.trim() != value {
        return false;
    }
    if let Some(actor) = value
        .strip_prefix("human:")
        .or_else(|| value.strip_prefix("process:"))
    {
        return is_valid_actor_token(actor);
    }
    let mut parts = value.split('/');
    matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some(producer), Some(version), None)
            if is_valid_actor_token(producer) && is_valid_actor_token(version)
    )
}

pub(crate) fn is_valid_source_author(value: &str) -> bool {
    is_valid_actor(value)
        || (value.len() <= 256
            && value.trim() == value
            && value
                .strip_prefix("team:")
                .is_some_and(is_valid_actor_token))
}

pub(crate) fn parse_explicit_zone_timestamp(value: &str) -> Option<DateTime<FixedOffset>> {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || !value.is_ascii()
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return None;
    }
    let zone_start = if bytes.last() == Some(&b'Z') {
        bytes.len() - 1
    } else {
        let start = bytes.len().checked_sub(6)?;
        if !matches!(bytes.get(start), Some(b'+' | b'-')) || bytes.get(start + 3) != Some(&b':') {
            return None;
        }
        start
    };
    if zone_start < 19 {
        return None;
    }
    let fixed_digits = [0..4, 5..7, 8..10, 11..13, 14..16, 17..19];
    if fixed_digits
        .iter()
        .any(|range| !bytes[range.clone()].iter().all(u8::is_ascii_digit))
    {
        return None;
    }
    let fraction = &bytes[19..zone_start];
    if !fraction.is_empty()
        && (fraction.first() != Some(&b'.')
            || fraction.len() == 1
            || !fraction[1..].iter().all(u8::is_ascii_digit))
    {
        return None;
    }
    if bytes.last() != Some(&b'Z')
        && (!bytes[zone_start + 1..zone_start + 3]
            .iter()
            .all(u8::is_ascii_digit)
            || !bytes[zone_start + 4..zone_start + 6]
                .iter()
                .all(u8::is_ascii_digit))
    {
        return None;
    }
    let field = |range: std::ops::Range<usize>| {
        std::str::from_utf8(&bytes[range]).ok()?.parse::<u32>().ok()
    };
    if field(11..13)? > 23 || field(14..16)? > 59 || field(17..19)? > 59 {
        return None;
    }
    if bytes.last() != Some(&b'Z')
        && (field(zone_start + 1..zone_start + 3)? > 23
            || field(zone_start + 4..zone_start + 6)? > 59)
    {
        return None;
    }
    DateTime::parse_from_rfc3339(value).ok()
}

fn normalized_usage_window(
    value: Option<&Value>,
    explicit_tags: &Map<String, Value>,
    path: &str,
) -> Option<UsageWindow> {
    let object = value?.as_object()?;
    Some(UsageWindow {
        from: object_string(object, "from", explicit_tags, &format!("{path}/from")),
        to: object_string(object, "to", explicit_tags, &format!("{path}/to")),
    })
}

fn normalized_sources(
    value: Option<&Value>,
    explicit_tags: &Map<String, Value>,
) -> Vec<KnowledgeSource> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, value)| {
            let object = value.as_object()?;
            let path = format!("/sources/{index}");
            Some(KnowledgeSource {
                id: object_string(object, "id", explicit_tags, &format!("{path}/id")),
                resource: object_string(
                    object,
                    "resource",
                    explicit_tags,
                    &format!("{path}/resource"),
                ),
                title: object_string(object, "title", explicit_tags, &format!("{path}/title")),
                author: object_string(object, "author", explicit_tags, &format!("{path}/author")),
                usage_count: object.get("usage_count").and_then(|value| {
                    let value = if explicit_tags.contains_key(&format!("{path}/usage_count")) {
                        semantic_value(value)
                    } else {
                        value
                    };
                    json_safe_nonnegative_integer(value)
                }),
                last_modified: object_string(
                    object,
                    "last_modified",
                    explicit_tags,
                    &format!("{path}/last_modified"),
                ),
                usage_window: normalized_usage_window(
                    object.get("usage_window"),
                    explicit_tags,
                    &format!("{path}/usage_window"),
                ),
            })
        })
        .collect()
}

fn normalized_parameters(
    value: Option<&Value>,
    explicit_tags: &Map<String, Value>,
) -> Vec<ComputationParameter> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, value)| {
            let object = value.as_object()?;
            let path = format!("/parameters/{index}");
            let required = object.get("required").and_then(|value| {
                let value = if explicit_tags.contains_key(&format!("{path}/required")) {
                    semantic_value(value)
                } else {
                    value
                };
                value.as_bool()
            });
            Some(ComputationParameter {
                name: object_string(object, "name", explicit_tags, &format!("{path}/name")),
                r#type: object_string(object, "type", explicit_tags, &format!("{path}/type")),
                required,
            })
        })
        .collect()
}

fn normalized_endpoint(
    value: Option<&Value>,
    explicit_tags: &Map<String, Value>,
    path: &str,
) -> Option<ComputationEndpoint> {
    let object = value?.as_object()?;
    let receipt = object
        .get("receipt")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, value)| {
            let value = if explicit_tags.contains_key(&format!("{path}/receipt/{index}")) {
                semantic_value(value)
            } else {
                value
            };
            value.as_str().map(str::to_owned)
        })
        .collect();
    Some(ComputationEndpoint {
        resource: object_string(
            object,
            "resource",
            explicit_tags,
            &format!("{path}/resource"),
        ),
        receipt,
    })
}

fn json_safe_nonnegative_integer(value: &Value) -> Option<u64> {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    let integer = if let Some(value) = value.as_u64() {
        value
    } else {
        let value = value.as_f64()?;
        if !value.is_finite() || value < 0.0 || value.fract() != 0.0 {
            return None;
        }
        value as u64
    };
    (integer <= MAX_SAFE_INTEGER).then_some(integer)
}

fn collect_yaml_explicit_tags(value: &serde_yaml::Value) -> Map<String, Value> {
    fn escape(segment: &str) -> String {
        segment.replace('~', "~0").replace('/', "~1")
    }

    fn visit(value: &serde_yaml::Value, path: &mut Vec<String>, tags: &mut Map<String, Value>) {
        match value {
            serde_yaml::Value::Tagged(tagged) => {
                let raw_tag = tagged.tag.to_string();
                if !path.is_empty() && raw_tag != "!obigint" {
                    let tag = if let Some(tag) = internal_standard_tag(&raw_tag) {
                        tag.to_owned()
                    } else {
                        raw_tag
                            .strip_prefix("!!")
                            .and_then(standard_tag_uri)
                            .unwrap_or(&raw_tag)
                            .to_owned()
                    };
                    let key = if path.len() == 1 {
                        path[0].clone()
                    } else {
                        format!("/{}", path.join("/"))
                    };
                    tags.insert(key, Value::String(tag));
                }
                visit(&tagged.value, path, tags);
            }
            serde_yaml::Value::Mapping(mapping) => {
                for (key, nested) in mapping {
                    if let Some(key) = yaml_string_mapping_key(key) {
                        path.push(escape(&key));
                        visit(nested, path, tags);
                        path.pop();
                    }
                }
            }
            serde_yaml::Value::Sequence(sequence) => {
                for (index, nested) in sequence.iter().enumerate() {
                    path.push(index.to_string());
                    visit(nested, path, tags);
                    path.pop();
                }
            }
            _ => {}
        }
    }

    let mut tags = Map::new();
    visit(value, &mut Vec::new(), &mut tags);
    tags
}

fn canonical_timestamp(value: &str) -> Option<String> {
    let value = value.trim();
    let bytes = value.as_bytes();
    if bytes.len() < 8 || bytes.get(4) != Some(&b'-') || !bytes[..4].iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    let year = value[..4].parse::<i32>().ok()?;
    let month_start = 5;
    let month_end = bytes[month_start..]
        .iter()
        .position(|byte| *byte == b'-')
        .map(|offset| month_start + offset)?;
    if !(1..=2).contains(&(month_end - month_start))
        || !bytes[month_start..month_end].iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    let month = value[month_start..month_end].parse::<i32>().ok()?;
    let day_start = month_end + 1;
    let day_end = bytes[day_start..]
        .iter()
        .position(|byte| matches!(*byte, b'T' | b't' | b' ' | b'\t'))
        .map_or(bytes.len(), |offset| day_start + offset);
    if !(1..=2).contains(&(day_end - day_start))
        || !bytes[day_start..day_end].iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    let day = value[day_start..day_end].parse::<i64>().ok()?;

    let mut hour = 0_i64;
    let mut minute = 0_i64;
    let mut second = 0_i64;
    let mut milliseconds = 0_i64;
    let mut timezone_minutes = 0_i64;
    if day_end < bytes.len() {
        let mut cursor = day_end;
        if matches!(bytes[cursor], b'T' | b't') {
            cursor += 1;
        } else {
            while bytes
                .get(cursor)
                .is_some_and(|byte| matches!(*byte, b' ' | b'\t'))
            {
                cursor += 1;
            }
        }
        let hour_end = bytes[cursor..]
            .iter()
            .position(|byte| *byte == b':')
            .map(|offset| cursor + offset)?;
        if !(1..=2).contains(&(hour_end - cursor))
            || !bytes[cursor..hour_end].iter().all(u8::is_ascii_digit)
        {
            return None;
        }
        hour = value[cursor..hour_end].parse::<i64>().ok()?;
        cursor = hour_end + 1;
        let minute_end = bytes[cursor..]
            .iter()
            .position(|byte| *byte == b':')
            .map(|offset| cursor + offset)?;
        if !(1..=2).contains(&(minute_end - cursor))
            || !bytes[cursor..minute_end].iter().all(u8::is_ascii_digit)
        {
            return None;
        }
        minute = value[cursor..minute_end].parse::<i64>().ok()?;
        cursor = minute_end + 1;
        let second_end = bytes[cursor..]
            .iter()
            .position(|byte| matches!(*byte, b' ' | b'\t' | b'Z' | b'+' | b'-'))
            .map_or(bytes.len(), |offset| cursor + offset);
        let second_source = &value[cursor..second_end];
        let (whole_seconds, fraction) = second_source
            .split_once('.')
            .map_or((second_source, None), |(whole, fraction)| {
                (whole, Some(fraction))
            });
        if !(1..=2).contains(&whole_seconds.len())
            || !whole_seconds.bytes().all(|byte| byte.is_ascii_digit())
        {
            return None;
        }
        second = whole_seconds.parse::<i64>().ok()?;
        if let Some(fraction) = fraction {
            if fraction.is_empty() || !fraction.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            let mut millis = fraction.bytes().take(3).collect::<Vec<_>>();
            while millis.len() < 3 {
                millis.push(b'0');
            }
            milliseconds = std::str::from_utf8(&millis).ok()?.parse::<i64>().ok()?;
        }
        cursor = second_end;
        while bytes
            .get(cursor)
            .is_some_and(|byte| matches!(*byte, b' ' | b'\t'))
        {
            cursor += 1;
        }
        if cursor < bytes.len() {
            if bytes[cursor] == b'Z' {
                cursor += 1;
            } else {
                let sign = match bytes[cursor] {
                    b'+' => 1_i64,
                    b'-' => -1_i64,
                    _ => return None,
                };
                cursor += 1;
                let zone = &value[cursor..];
                let (hours, minutes) = zone
                    .split_once(':')
                    .map_or((zone, None), |(hours, minutes)| (hours, Some(minutes)));
                if !(1..=2).contains(&hours.len())
                    || !hours.bytes().all(|byte| byte.is_ascii_digit())
                    || (hours.len() == 2 && !matches!(hours.as_bytes()[0], b'0' | b'1' | b'2'))
                {
                    return None;
                }
                let hours = hours.parse::<i64>().ok()?;
                timezone_minutes = if let Some(minutes) = minutes {
                    if minutes.len() != 2 || !minutes.bytes().all(|byte| byte.is_ascii_digit()) {
                        return None;
                    }
                    sign * (hours * 60 + minutes.parse::<i64>().ok()?)
                } else {
                    sign * hours * 60
                };
                cursor = bytes.len();
            }
        }
        if cursor != bytes.len() {
            return None;
        }
    }

    let javascript_year = if (0..=99).contains(&year) {
        year + 1900
    } else {
        year
    };
    let total_months = i64::from(javascript_year) * 12 + i64::from(month - 1);
    let normalized_year = i32::try_from(total_months.div_euclid(12)).ok()?;
    let normalized_month = u32::try_from(total_months.rem_euclid(12) + 1).ok()?;
    let base =
        NaiveDate::from_ymd_opt(normalized_year, normalized_month, 1)?.and_hms_opt(0, 0, 0)?;
    let normalized = base
        .checked_add_signed(Duration::days(day - 1))?
        .checked_add_signed(Duration::hours(hour))?
        .checked_add_signed(Duration::minutes(minute - timezone_minutes))?
        .checked_add_signed(Duration::seconds(second))?
        .checked_add_signed(Duration::milliseconds(milliseconds))?;
    Some(
        normalized
            .and_utc()
            .to_rfc3339_opts(SecondsFormat::Millis, true),
    )
}

fn decoded_binary(value: &str) -> Option<Value> {
    let mut accumulator = 0_u32;
    let mut bits = 0_u8;
    let mut bytes = Vec::new();
    for code_unit in value.encode_utf16() {
        let byte = (code_unit & 0xff) as u8;
        let sextet = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        accumulator = (accumulator << 6) | u32::from(sextet);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push(((accumulator >> bits) & 0xff) as u8);
        }
    }
    Some(Value::Array(
        bytes
            .into_iter()
            .map(|byte| Value::Number(Number::from(byte)))
            .collect(),
    ))
}

fn yaml_to_json(value: serde_yaml::Value) -> Result<Value, String> {
    Ok(match value {
        serde_yaml::Value::Null => Value::Null,
        serde_yaml::Value::Bool(value) => Value::Bool(value),
        serde_yaml::Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                if value.unsigned_abs() > 9_007_199_254_740_991 {
                    let mut exact = Map::new();
                    exact.insert(
                        EXACT_INTEGER_KEY.to_owned(),
                        Value::String(value.to_string()),
                    );
                    Value::Object(exact)
                } else {
                    Value::Number(Number::from(value))
                }
            } else if let Some(value) = value.as_u64() {
                if value > 9_007_199_254_740_991 {
                    let mut exact = Map::new();
                    exact.insert(
                        EXACT_INTEGER_KEY.to_owned(),
                        Value::String(value.to_string()),
                    );
                    Value::Object(exact)
                } else {
                    Value::Number(Number::from(value))
                }
            } else {
                value
                    .as_f64()
                    .and_then(Number::from_f64)
                    .map(Value::Number)
                    .unwrap_or(Value::Null)
            }
        }
        serde_yaml::Value::String(value) => Value::String(value),
        serde_yaml::Value::Sequence(values) => Value::Array(
            values
                .into_iter()
                .map(yaml_to_json)
                .collect::<Result<Vec<_>, _>>()?,
        ),
        serde_yaml::Value::Mapping(values) => {
            if values
                .keys()
                .any(|key| yaml_string_mapping_key(key).is_none())
            {
                if values
                    .values()
                    .all(|value| matches!(value, serde_yaml::Value::Null))
                {
                    return Ok(Value::Array(
                        values
                            .into_keys()
                            .map(yaml_to_json)
                            .collect::<Result<Vec<_>, _>>()?,
                    ));
                }
                return Err(
                    "YAML frontmatter mappings must use string field names at every level."
                        .to_owned(),
                );
            }
            let mut result = Map::new();
            for (key, value) in values {
                let key = yaml_string_mapping_key(&key).ok_or_else(|| {
                    "YAML frontmatter mappings must use string field names at every level."
                        .to_owned()
                })?;
                result.insert(key, yaml_to_json(value)?);
            }
            Value::Object(result)
        }
        serde_yaml::Value::Tagged(tagged) => {
            let raw_tag = tagged.tag.to_string();
            if raw_tag == "!obigint" {
                let serde_yaml::Value::String(value) = tagged.value else {
                    return Err(
                        "YAML frontmatter is not JSON-safe: malformed exact integer".to_owned()
                    );
                };
                let mut exact = Map::new();
                exact.insert(EXACT_INTEGER_KEY.to_owned(), Value::String(value));
                return Ok(Value::Object(exact));
            }
            let canonical_tag = if let Some(tag) = internal_standard_tag(&raw_tag) {
                tag.to_owned()
            } else {
                raw_tag
                    .strip_prefix("!!")
                    .and_then(standard_tag_uri)
                    .unwrap_or(&raw_tag)
                    .to_owned()
            };
            if !canonical_tag.starts_with("tag:yaml.org,2002:") && !canonical_tag.starts_with("!!")
            {
                return Err(format!(
                    "YAML frontmatter is not JSON-safe: custom YAML tag is not supported: {canonical_tag}"
                ));
            }
            let source = match &tagged.value {
                serde_yaml::Value::String(value) => Some(value.clone()),
                serde_yaml::Value::Bool(value) => Some(value.to_string()),
                serde_yaml::Value::Number(value) => Some(value.to_string()),
                serde_yaml::Value::Null => Some("null".to_owned()),
                _ => None,
            };
            let converted = if raw_tag == "!oset" {
                match tagged.value {
                    serde_yaml::Value::Sequence(entries) => {
                        let mut members = Vec::with_capacity(entries.len());
                        for entry in entries {
                            let serde_yaml::Value::Mapping(entry) = entry else {
                                return Err(
                                    "Invalid YAML frontmatter: malformed internal set entry"
                                        .to_owned(),
                                );
                            };
                            if entry.len() != 1 {
                                return Err(
                                    "Invalid YAML frontmatter: malformed internal set entry"
                                        .to_owned(),
                                );
                            }
                            let (member, value) = entry.into_iter().next().expect("length checked");
                            if !matches!(value, serde_yaml::Value::Null) {
                                return Err(
                                    "Invalid YAML frontmatter: Set items must all have null values"
                                        .to_owned(),
                                );
                            }
                            members.push(yaml_to_json(member)?);
                        }
                        Value::Array(members)
                    }
                    _ => {
                        return Err(
                            "Invalid YAML frontmatter: malformed internal set representation"
                                .to_owned(),
                        );
                    }
                }
            } else if canonical_tag == "tag:yaml.org,2002:set" {
                match tagged.value {
                    serde_yaml::Value::Mapping(values) => Value::Array(
                        values
                            .into_iter()
                            .map(|(member, _)| yaml_to_json(member))
                            .collect::<Result<Vec<_>, _>>()?,
                    ),
                    value => yaml_to_json(value)?,
                }
            } else {
                yaml_to_json(tagged.value)?
            };
            let semantic = match canonical_tag.as_str() {
                "tag:yaml.org,2002:str" if raw_tag == "!ostr" => source
                    .as_deref()
                    .map(|value| Value::String(value.to_owned()))
                    .unwrap_or(converted),
                "tag:yaml.org,2002:bool" if raw_tag == "!obool" => {
                    match source.as_deref().map(str::to_ascii_lowercase).as_deref() {
                        Some("true") => Value::Bool(true),
                        Some("false") => Value::Bool(false),
                        _ => converted,
                    }
                }
                "tag:yaml.org,2002:int" if raw_tag == "!oint" => {
                    let exact = source.as_deref().and_then(|value| {
                        canonical_set_integer(value, true).filter(|canonical| {
                            if canonical.starts_with('-') {
                                canonical.parse::<i64>().is_err()
                            } else {
                                canonical.parse::<u64>().is_err()
                            }
                        })
                    });
                    if let Some(canonical) = exact {
                        let mut exact = Map::new();
                        exact.insert(EXACT_INTEGER_KEY.to_owned(), Value::String(canonical));
                        Value::Object(exact)
                    } else if source.as_deref().is_some_and(yaml_schema_integer_string) {
                        Value::String(source.clone().expect("checked as present"))
                    } else {
                        source
                            .as_deref()
                            .and_then(|value| serde_yaml::from_str::<serde_yaml::Value>(value).ok())
                            .filter(|value| matches!(value, serde_yaml::Value::Number(_)))
                            .map(yaml_to_json)
                            .transpose()?
                            .unwrap_or(converted)
                    }
                }
                "tag:yaml.org,2002:null" if raw_tag == "!onull" => source
                    .as_deref()
                    .and_then(|value| serde_yaml::from_str::<serde_yaml::Value>(value).ok())
                    .filter(|value| matches!(value, serde_yaml::Value::Null))
                    .map(|_| Value::Null)
                    .unwrap_or(converted),
                "tag:yaml.org,2002:float" if raw_tag == "!ofloat" => {
                    match source.as_deref().map(str::to_ascii_lowercase) {
                        Some(value) if plain_nonfinite_kind(&value) == Some("inf") => {
                            Value::String("Infinity".to_owned())
                        }
                        Some(value) if plain_nonfinite_kind(&value) == Some("-inf") => {
                            Value::String("-Infinity".to_owned())
                        }
                        Some(value) if plain_nonfinite_kind(&value) == Some("nan") => {
                            Value::String("NaN".to_owned())
                        }
                        Some(value) if canonical_set_integer(value.as_str(), true).is_some() => {
                            Value::String(value)
                        }
                        _ => source
                            .as_deref()
                            .and_then(|value| serde_yaml::from_str::<serde_yaml::Value>(value).ok())
                            .filter(|value| matches!(value, serde_yaml::Value::Number(_)))
                            .map(yaml_to_json)
                            .transpose()?
                            .unwrap_or(converted),
                    }
                }
                "tag:yaml.org,2002:timestamp" => source
                    .as_deref()
                    .and_then(canonical_timestamp)
                    .map(Value::String)
                    .unwrap_or(converted),
                "tag:yaml.org,2002:binary" => source
                    .as_deref()
                    .and_then(decoded_binary)
                    .unwrap_or(converted),
                "tag:yaml.org,2002:set" => converted
                    .as_object()
                    .map(|set| {
                        Value::Array(set.keys().cloned().map(Value::String).collect::<Vec<_>>())
                    })
                    .unwrap_or(converted),
                "tag:yaml.org,2002:float" => match source.as_deref().map(str::to_ascii_lowercase) {
                    Some(value) if matches!(value.as_str(), ".inf" | "+.inf") => {
                        Value::String("Infinity".to_owned())
                    }
                    Some(value) if value == "-.inf" => Value::String("-Infinity".to_owned()),
                    Some(value) if matches!(value.as_str(), ".nan" | "+.nan" | "-.nan") => {
                        Value::String("NaN".to_owned())
                    }
                    _ => converted,
                },
                _ => converted,
            };
            let mut tagged_body = Map::new();
            tagged_body.insert("tag".to_owned(), Value::String(canonical_tag));
            tagged_body.insert("value".to_owned(), semantic);
            if let Some(source) = source {
                tagged_body.insert("source".to_owned(), Value::String(source));
            }
            let mut wrapper = Map::new();
            wrapper.insert(TAGGED_KEY.to_owned(), Value::Object(tagged_body));
            Value::Object(wrapper)
        }
    })
}

fn yaml_string_mapping_key(value: &serde_yaml::Value) -> Option<String> {
    match value {
        serde_yaml::Value::String(key) => Some(key.clone()),
        serde_yaml::Value::Tagged(tagged) => {
            let tag = tagged.tag.to_string();
            if let Some(key) = internal_scalar_tagged_string_key(&tag, &tagged.value) {
                return Some(key);
            }
            let is_string = tag == "tag:yaml.org,2002:str"
                || internal_standard_tag(&tag) == Some("tag:yaml.org,2002:str")
                || tag
                    .strip_prefix("!!")
                    .and_then(standard_tag_uri)
                    .is_some_and(|tag| tag == "tag:yaml.org,2002:str");
            if !is_string {
                return None;
            }
            match &tagged.value {
                serde_yaml::Value::String(key) => Some(key.clone()),
                serde_yaml::Value::Bool(key) => Some(key.to_string()),
                serde_yaml::Value::Number(key) => Some(key.to_string()),
                serde_yaml::Value::Null => Some("null".to_owned()),
                _ => None,
            }
        }
        _ => None,
    }
}

fn internal_scalar_tagged_string_key(tag: &str, value: &serde_yaml::Value) -> Option<String> {
    let source = match value {
        serde_yaml::Value::String(value) => value.clone(),
        serde_yaml::Value::Bool(value) => value.to_string(),
        serde_yaml::Value::Number(value) => value.to_string(),
        serde_yaml::Value::Null => "null".to_owned(),
        _ => return None,
    };
    match tag {
        "!ostr" => {
            let (remainder, _, nested_tag) = split_node_properties(&source);
            if nested_tag == Some("str") && !remainder.is_empty() {
                parsed_string_mapping_key(remainder, Some("str"))
            } else {
                Some(source)
            }
        }
        "!oint" => (yaml_schema_integer_string(&source)
            || canonical_set_integer(&source, true).is_none())
        .then_some(source),
        "!ofloat" => (plain_nonfinite_kind(&source).is_some()
            || canonical_set_integer(&source, true).is_some()
            || source.parse::<f64>().is_err())
        .then_some(source),
        "!obool" => {
            (!matches!(source.to_ascii_lowercase().as_str(), "true" | "false")).then_some(source)
        }
        "!onull" => {
            (!matches!(source.as_str(), "" | "~" | "null" | "Null" | "NULL")).then_some(source)
        }
        _ => None,
    }
}

fn parsed_string_mapping_key(source: &str, tag_name: Option<&str>) -> Option<String> {
    if tag_name == Some("str") && source.trim().is_empty() {
        return Some(String::new());
    }
    let (masked, marker) = mask_literal_nel(source);
    let parsed = if tag_name != Some("str") {
        serde_yaml::from_str::<String>(&masked).ok()
    } else {
        serde_yaml::from_str::<serde_yaml::Value>(&masked)
            .ok()
            .and_then(|value| match value {
                serde_yaml::Value::String(value) => Some(value),
                serde_yaml::Value::Bool(value) => Some(value.to_string()),
                serde_yaml::Value::Number(value) => Some(value.to_string()),
                serde_yaml::Value::Null => Some("null".to_owned()),
                _ => None,
            })
    };
    parsed.map(|key| marker.map_or(key.clone(), |marker| key.replace(&marker, "\u{0085}")))
}

fn multiline_mapping_key_parts(
    source: &str,
) -> Option<(&str, usize, Option<String>, Option<&str>)> {
    let mut key_anchor = None;
    let mut key_tag = None;
    let mut empty_key_position = None;
    let parsed = line_spans(source).into_iter().find_map(|line| {
        let body = &source[line.start..line.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            return None;
        }
        let comment = yaml_comment_start(trimmed);
        let property_boundary = comment.unwrap_or(trimmed.len());
        let syntax = comment.map_or(trimmed, |comment| &trimmed[..comment]);
        let syntax = syntax.trim_end_matches([' ', '\t']);
        let (remainder, line_anchor, line_tag) = split_node_properties(syntax);
        if key_anchor.is_none() {
            key_anchor = line_anchor;
        }
        if key_tag.is_none() {
            key_tag = line_tag;
        }
        if remainder.is_empty() {
            empty_key_position =
                Some(line.start + body.len().saturating_sub(trimmed.len()) + property_boundary);
            return None;
        }
        let relative = line.start
            + body.len().saturating_sub(trimmed.len())
            + syntax.len().saturating_sub(remainder.len());
        Some((&source[relative..], relative, key_anchor.clone(), key_tag))
    });
    parsed.or_else(|| {
        (key_anchor.is_some() || key_tag.is_some()).then(|| {
            let position = empty_key_position.unwrap_or(source.len());
            (
                &source[position..position],
                position,
                key_anchor.clone(),
                key_tag,
            )
        })
    })
}

fn flow_mapping_key_parts(source: &str) -> (&str, Option<String>, Option<&str>) {
    if source.contains(['\r', '\n'])
        && let Some((plain, _, anchor, tag)) = multiline_mapping_key_parts(source)
    {
        return (plain, anchor, tag);
    }
    let (plain, anchor, tag) = split_node_properties(source);
    (plain, anchor, tag)
}

fn yaml_comment_start(source: &str) -> Option<usize> {
    let mut quote = None;
    let mut escaped = false;
    let mut characters = source.char_indices().peekable();
    while let Some((offset, character)) = characters.next() {
        if let Some(active_quote) = quote {
            if active_quote == '"' && character == '\\' && !escaped {
                escaped = true;
                continue;
            }
            if character == active_quote && !escaped {
                if active_quote == '\'' && characters.peek().is_some_and(|(_, next)| *next == '\'')
                {
                    characters.next();
                } else {
                    quote = None;
                }
            }
            escaped = false;
            continue;
        }
        match character {
            '"' | '\'' => quote = Some(character),
            '#' if offset == 0
                || source[..offset]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_whitespace) =>
            {
                return Some(offset);
            }
            _ => {}
        }
    }
    None
}

fn invalid_root_type_literal_nel_range(source: &str) -> Option<(usize, usize)> {
    line_spans(source).into_iter().find_map(|line| {
        let body = &source[line.start..line.content_end];
        body.strip_prefix("type:")
            .and_then(|value| value.strip_prefix('\u{0085}'))
            .filter(|value| !value.trim().is_empty())
            .map(|_| (line.start, line.end))
    })
}

fn invalid_structural_literal_nel_range(source: &str) -> Option<(usize, usize)> {
    let block_scalar_ranges = block_scalar_body_ranges(source);
    let spans = line_spans(source);
    for (line_index, line) in spans.iter().copied().enumerate() {
        if sorted_range_contains(&block_scalar_ranges, line.start) {
            continue;
        }
        let body = &source[line.start..line.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        let indent = body.len() - trimmed.len();
        let mapping_colon = mapping_key_colon(trimmed);
        let mut quote = None;
        let mut escaped = false;
        for (offset, character) in trimmed.char_indices() {
            if let Some(active_quote) = quote {
                if active_quote == '"' && character == '\\' && !escaped {
                    escaped = true;
                    continue;
                }
                if character == active_quote && !escaped {
                    quote = None;
                }
                escaped = false;
                continue;
            }
            match character {
                '#' if offset == 0
                    || trimmed[..offset]
                        .chars()
                        .next_back()
                        .is_some_and(char::is_whitespace) =>
                {
                    break;
                }
                '"' | '\'' => quote = Some(character),
                '\u{0085}'
                    if mapping_colon == offset.checked_sub(1)
                        && !trimmed[offset + character.len_utf8()..].trim().is_empty()
                        && !trimmed.starts_with(['?', '-'])
                        && (indent == 0
                            || !trimmed[offset + character.len_utf8()..]
                                .starts_with(char::is_whitespace)
                                && has_sibling_mapping_line(
                                    source, &spans, line_index, indent,
                                )) =>
                {
                    let end = if indent == 0 && trimmed.starts_with("type:") {
                        line.end
                    } else {
                        line.content_end
                    };
                    return Some((line.start + indent, end));
                }
                '\u{0085}'
                    if indent == 0
                        && mapping_colon.is_none()
                        && trimmed[offset + character.len_utf8()..].starts_with(':')
                        && !trimmed[offset + character.len_utf8() + 1..]
                            .starts_with(char::is_whitespace) =>
                {
                    return Some((line.start + indent, line.content_end));
                }
                _ => {}
            }
        }
    }
    None
}

fn has_sibling_mapping_line(
    source: &str,
    spans: &[LineSpan],
    line_index: usize,
    indent: usize,
) -> bool {
    let is_mapping_peer = |line: LineSpan| {
        let body = &source[line.start..line.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        let peer_indent = body.len() - trimmed.len();
        peer_indent == indent
            && !trimmed.starts_with(['#', '?', '-'])
            && mapping_key_colon(trimmed).is_some()
            && !trimmed.contains('\u{0085}')
    };

    spans[..line_index]
        .iter()
        .rev()
        .copied()
        .take_while(|line| {
            let body = &source[line.start..line.content_end];
            let trimmed = body.trim_start_matches([' ', '\t']);
            trimmed.is_empty() || trimmed.starts_with('#') || body.len() - trimmed.len() >= indent
        })
        .any(is_mapping_peer)
        || spans[line_index + 1..]
            .iter()
            .copied()
            .take_while(|line| {
                let body = &source[line.start..line.content_end];
                let trimmed = body.trim_start_matches([' ', '\t']);
                trimmed.is_empty()
                    || trimmed.starts_with('#')
                    || body.len() - trimmed.len() >= indent
            })
            .any(is_mapping_peer)
}

fn nested_compact_literal_nel_range(source: &str) -> Option<(usize, usize)> {
    let block_scalar_ranges = block_scalar_body_ranges(source);
    for line in line_spans(source) {
        if sorted_range_contains(&block_scalar_ranges, line.start) {
            continue;
        }
        let body = &source[line.start..line.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        let indent = body.len() - trimmed.len();
        let Some(colon) = mapping_key_colon(trimmed) else {
            continue;
        };
        let after_colon = &trimmed[colon + 1..];
        let leading = after_colon.len() - after_colon.trim_start().len();
        let value = after_colon.trim_start();
        let (plain_value, _, _) = split_node_properties(value);
        if matches!(
            plain_value.chars().next(),
            Some('"' | '\'' | '|' | '>' | '{' | '[')
        ) {
            continue;
        }
        let Some(nel) = plain_value.find('\u{0085}') else {
            continue;
        };
        let suffix = &plain_value[nel + '\u{0085}'.len_utf8()..];
        if suffix.strip_prefix(':').is_some_and(|rest| {
            rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
        }) {
            let start = line.start + indent + colon + 1 + leading;
            return Some((start, one_character_end(source, start, line.content_end)));
        }
    }
    None
}

fn yaml_prefix_ends_outside_quotes(source: &str) -> bool {
    let mut quote = None;
    let mut escaped = false;
    let mut characters = source.chars().peekable();
    while let Some(character) = characters.next() {
        if let Some(active_quote) = quote {
            if active_quote == '"' && character == '\\' && !escaped {
                escaped = true;
                continue;
            }
            if character == active_quote && !escaped {
                if active_quote == '\'' && characters.peek() == Some(&'\'') {
                    characters.next();
                } else {
                    quote = None;
                }
            }
            escaped = false;
            continue;
        }
        if matches!(character, '"' | '\'') {
            quote = Some(character);
        }
    }
    quote.is_none()
}

fn invalid_comment_separator_range(source: &str) -> Option<(usize, usize)> {
    let excluded_ranges = block_scalar_body_ranges(source);
    let mut quote = None;
    let mut escaped = false;
    let mut valid_comment = false;
    let mut flow_stack = Vec::new();
    let mut closed_quoted_scalar = false;
    let mut closed_flow_collection = false;
    let mut characters = source.char_indices().peekable();
    while let Some((offset, character)) = characters.next() {
        if sorted_range_contains(&excluded_ranges, offset) {
            continue;
        }
        if valid_comment {
            if matches!(character, '\r' | '\n') {
                valid_comment = false;
                closed_quoted_scalar = false;
                closed_flow_collection = false;
            }
            continue;
        }
        if let Some(active_quote) = quote {
            if active_quote == '"' && character == '\\' && !escaped {
                escaped = true;
                continue;
            }
            if character == active_quote && !escaped {
                if active_quote == '\'' && characters.peek().is_some_and(|(_, next)| *next == '\'')
                {
                    characters.next();
                } else {
                    quote = None;
                    closed_quoted_scalar = true;
                }
            }
            escaped = false;
            continue;
        }
        match character {
            '"' | '\'' => {
                quote = Some(character);
                closed_quoted_scalar = false;
                closed_flow_collection = false;
            }
            '[' | '{' => {
                let prefix = &source[..offset];
                let line_start = prefix.rfind(['\r', '\n']).map_or(0, |newline| newline + 1);
                let before = prefix[line_start..].trim_end();
                let previous = before.chars().next_back();
                let property_start = before
                    .char_indices()
                    .rev()
                    .find_map(|(position, character)| {
                        matches!(character, ':' | ',' | '[' | '{' | '?').then_some(position + 1)
                    })
                    .unwrap_or(0);
                let property_source = before[property_start..].trim();
                let (property_remainder, property_anchor, property_tag) =
                    split_node_properties(property_source);
                let follows_properties = property_remainder.is_empty()
                    && (property_anchor.is_some() || property_tag.is_some());
                if before.is_empty()
                    || previous.is_some_and(|character| {
                        matches!(character, ':' | ',' | '?' | '-' | '[' | '{')
                    })
                    || follows_properties
                {
                    flow_stack.push(character);
                }
                closed_quoted_scalar = false;
                closed_flow_collection = false;
            }
            ']' | '}' => {
                let opening = if character == ']' { '[' } else { '{' };
                closed_flow_collection = flow_stack.last() == Some(&opening);
                if closed_flow_collection {
                    flow_stack.pop();
                }
                closed_quoted_scalar = false;
            }
            '#' => {
                let previous = source[..offset].chars().next_back();
                if offset == 0 || previous.is_some_and(char::is_whitespace) {
                    valid_comment = true;
                    continue;
                }
                let line_start = source[..offset]
                    .rfind(['\r', '\n'])
                    .map_or(0, |newline| newline + 1);
                let token = source[line_start..offset]
                    .rsplit_once(|character: char| character.is_whitespace() || character == ':')
                    .map_or(&source[line_start..offset], |(_, token)| token);
                let quoted_flow_key_before_colon = previous == Some(':')
                    && !flow_stack.is_empty()
                    && source[line_start..offset]
                        .trim_end_matches(':')
                        .rsplit_once([',', '{'])
                        .map_or(
                            source[line_start..offset].trim_end_matches(':'),
                            |(_, key)| key,
                        )
                        .trim()
                        .starts_with(['"', '\'']);
                if closed_quoted_scalar
                    || closed_flow_collection
                    || (previous == Some(',') && !flow_stack.is_empty())
                    || quoted_flow_key_before_colon
                    || token.starts_with(['|', '>'])
                {
                    let end = offset
                        + source[offset..]
                            .find(['\r', '\n'])
                            .unwrap_or(source.len() - offset);
                    return Some((offset, end));
                }
            }
            '\r' | '\n' => {
                closed_quoted_scalar = false;
                closed_flow_collection = false;
            }
            character if !character.is_whitespace() => {
                closed_quoted_scalar = false;
                closed_flow_collection = false;
            }
            _ => {}
        }
    }
    None
}

fn reserved_internal_tag(source: &str) -> Option<&'static str> {
    let mut excluded_ranges = block_scalar_body_ranges(source);
    excluded_ranges.extend(multiline_quoted_scalar_ranges(source));
    excluded_ranges.extend(plain_scalar_value_ranges(source));
    normalize_ranges(&mut excluded_ranges);
    let flow_ranges = flow_collection_ranges(source);
    for tag in [
        "!oset", "!ostr", "!obool", "!oint", "!ofloat", "!onull", "!obigint",
    ] {
        for (offset, _) in source.match_indices(tag) {
            if sorted_range_contains(&excluded_ranges, offset) {
                continue;
            }
            let line_start = source[..offset]
                .rfind(['\r', '\n'])
                .map_or(0, |newline| newline + 1);
            let prefix = &source[line_start..offset];
            let previous = source[..offset].chars().next_back();
            let following = source[offset + tag.len()..].chars().next();
            let block_comma_prefix = prefix.rfind(',').is_some_and(|comma| {
                prefix.rfind(':').is_none_or(|colon| colon < comma)
                    && !sorted_range_contains(&flow_ranges, offset)
            });
            if yaml_comment_start(prefix).is_none()
                && yaml_prefix_ends_outside_quotes(prefix)
                && yaml_node_property_position(source, offset)
                && !block_comma_prefix
                && previous.is_none_or(|character| {
                    character.is_whitespace()
                        || matches!(character, ':' | ',' | '[' | '{' | '?' | '-')
                })
                && following.is_none_or(|character| {
                    character.is_whitespace() || matches!(character, ',' | ']' | '}' | '[' | '{')
                })
            {
                return Some(tag);
            }
        }
    }
    None
}

fn unsupported_yaml_2002_tag_range(source: &str) -> Option<(usize, usize, String)> {
    let mut excluded_ranges = block_scalar_body_ranges(source);
    excluded_ranges.extend(multiline_quoted_scalar_ranges(source));
    excluded_ranges.extend(plain_scalar_value_ranges(source));
    normalize_ranges(&mut excluded_ranges);
    let mut quote = None;
    let mut escaped = false;
    let mut comment = false;
    for (offset, character) in source.char_indices() {
        if sorted_range_contains(&excluded_ranges, offset) {
            continue;
        }
        if comment {
            if matches!(character, '\r' | '\n') {
                comment = false;
            }
            continue;
        }
        if let Some(active_quote) = quote {
            if active_quote == '"' && character == '\\' && !escaped {
                escaped = true;
                continue;
            }
            if character == active_quote && !escaped {
                quote = None;
            }
            escaped = false;
            continue;
        }
        match character {
            '#' if offset == 0
                || source[..offset]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_whitespace) =>
            {
                comment = true;
            }
            '"' | '\'' => quote = Some(character),
            '!' => {
                let previous = source[..offset].chars().next_back();
                if previous.is_some_and(|character| {
                    !character.is_whitespace() && !matches!(character, '[' | '{' | ',' | ':' | '?')
                }) {
                    continue;
                }
                if let Some(tag_source) = source[offset..].strip_prefix("!!") {
                    let length = tag_source
                        .find(|character: char| {
                            character.is_whitespace() || matches!(character, ',' | ']' | '}')
                        })
                        .unwrap_or(tag_source.len());
                    let name = &tag_source[..length];
                    if standard_tag_uri(name).is_none() {
                        let end = offset + 2 + length;
                        return Some((offset, end, format!("tag:yaml.org,2002:{name}")));
                    }
                } else if let Some(tag_source) =
                    source[offset..].strip_prefix("!<tag:yaml.org,2002:")
                    && let Some(end) = tag_source.find('>')
                {
                    let name = &tag_source[..end];
                    if standard_tag_uri(name).is_none() {
                        let range_end = offset + "!<tag:yaml.org,2002:".len() + end + 1;
                        return Some((offset, range_end, format!("tag:yaml.org,2002:{name}")));
                    }
                }
            }
            _ => {}
        }
    }
    None
}

fn unresolved_tight_alias_name(source: &str) -> Option<String> {
    let mut excluded_ranges = block_scalar_body_ranges(source);
    excluded_ranges.extend(multiline_quoted_scalar_ranges(source));
    excluded_ranges.extend(plain_scalar_value_ranges(source));
    normalize_ranges(&mut excluded_ranges);
    for (offset, _) in source.match_indices('*') {
        if sorted_range_contains(&excluded_ranges, offset) {
            continue;
        }
        let line_start = source[..offset]
            .rfind(['\r', '\n'])
            .map_or(0, |newline| newline + 1);
        let prefix = &source[line_start..offset];
        if yaml_comment_start(prefix).is_some() || !yaml_prefix_ends_outside_quotes(prefix) {
            continue;
        }
        let node_start = prefix
            .char_indices()
            .rev()
            .find_map(|(index, character)| {
                matches!(character, ':' | ',' | '[' | '{').then_some(index + 1)
            })
            .unwrap_or(0);
        let node_prefix = prefix[node_start..].trim();
        if !matches!(node_prefix, "" | "?" | "-") {
            continue;
        }
        let name_start = offset + 1;
        let name_end = yaml_anchor_name_end(source, name_start);
        let name = &source[name_start..name_end];
        if name.is_empty() {
            continue;
        }
        let anchor_defined = yaml_anchor_occurrences_in_ranges(source, &[(0, offset)])
            .into_iter()
            .any(|(anchor_offset, anchor_name)| {
                anchor_name == name && !sorted_range_contains(&excluded_ranges, anchor_offset)
            });
        if !anchor_defined {
            return Some(name.to_owned());
        }
    }
    None
}

fn multiline_implicit_key_range(source: &str) -> Option<(usize, usize)> {
    let flow_ranges = flow_collection_ranges(source);
    for (start, end) in generic_multiline_quoted_scalar_ranges(source) {
        if multiline_quoted_flow_key_colon(source, &flow_ranges, start, end).is_some() {
            continue;
        }
        let line_start = source[..start]
            .rfind(['\r', '\n'])
            .map_or(0, |newline| newline + 1);
        let prefix = source[line_start..start].trim();
        if prefix.ends_with('?') || mapping_key_colon(prefix).is_some() {
            continue;
        }
        let suffix = &source[end..];
        let leading = suffix.len() - suffix.trim_start_matches([' ', '\t']).len();
        if suffix[leading..].starts_with(':') {
            return Some((start, end));
        }
    }
    let spans = line_spans(source);
    let mut excluded_ranges = block_scalar_body_ranges(source);
    excluded_ranges.extend(multiline_quoted_scalar_ranges(source));
    normalize_ranges(&mut excluded_ranges);
    for (line_index, span) in spans.iter().enumerate() {
        if sorted_range_contains(&excluded_ranges, span.start) {
            continue;
        }
        let body = &source[span.start..span.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed == "-"
            || trimmed.starts_with("- ")
            || trimmed == "?"
            || trimmed.starts_with("? ")
        {
            continue;
        }
        let indent = body.len() - trimmed.len();
        let Some(colon) = mapping_key_colon(trimmed) else {
            continue;
        };
        let continued = trimmed[colon + 1..]
            .strip_prefix('\u{0085}')
            .is_some_and(|suffix| !suffix.trim().is_empty());
        if !continued {
            continue;
        }
        let mut sibling = None;
        for candidate in spans.iter().skip(line_index + 1) {
            let candidate_body = &source[candidate.start..candidate.content_end];
            let candidate_trimmed = candidate_body.trim_start_matches([' ', '\t']);
            if candidate_trimmed.is_empty() || candidate_trimmed.starts_with('#') {
                continue;
            }
            let candidate_indent = candidate_body.len() - candidate_trimmed.len();
            if candidate_indent > indent {
                continue;
            }
            if candidate_indent < indent {
                break;
            }
            let Some(candidate_colon) = mapping_key_colon(candidate_trimmed) else {
                break;
            };
            let candidate_continues = candidate_trimmed[candidate_colon + 1..]
                .strip_prefix('\u{0085}')
                .is_some_and(|suffix| !suffix.trim().is_empty());
            if candidate_continues {
                continue;
            }
            sibling = Some(candidate.start + candidate_indent + candidate_colon);
            break;
        }
        if let Some(end) = sibling {
            return Some((span.start + indent, end));
        }
    }
    None
}

fn compact_nested_mapping_range(source: &str) -> Option<(usize, usize)> {
    let spans = line_spans(source);
    let mut scalar_ranges = block_scalar_body_ranges(source);
    scalar_ranges.extend(multiline_quoted_scalar_ranges(source));
    normalize_ranges(&mut scalar_ranges);
    for (line_index, span) in spans.iter().enumerate() {
        if sorted_range_contains(&scalar_ranges, span.start) {
            continue;
        }
        let body = &source[span.start..span.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        if trimmed == "-" || trimmed.starts_with("- ") {
            continue;
        }
        let indent = body.len() - trimmed.len();
        let Some(colon) = mapping_key_colon(trimmed) else {
            continue;
        };
        let after_colon = &trimmed[colon + 1..];
        let leading = after_colon.len() - after_colon.trim_start().len();
        let value = after_colon.trim_start();
        if value.is_empty()
            || value.starts_with(['#', '"', '\'', '[', '{', '|', '>', '&', '!', '*'])
        {
            continue;
        }
        let nested_mapping = spans.iter().skip(line_index + 1).find_map(|candidate| {
            if sorted_range_contains(&scalar_ranges, candidate.start) {
                return None;
            }
            let nested_body = &source[candidate.start..candidate.content_end];
            let nested_trimmed = nested_body.trim_start_matches([' ', '\t']);
            if nested_trimmed.is_empty() || nested_trimmed.starts_with('#') {
                return None;
            }
            let nested_indent = nested_body.len() - nested_trimmed.len();
            let nested_colon = mapping_key_colon(nested_trimmed);
            let literal_nel_continuation = nested_colon.is_some_and(|colon| {
                nested_trimmed[colon + 1..]
                    .strip_prefix('\u{0085}')
                    .is_some_and(|suffix| !suffix.trim().is_empty())
            });
            Some(nested_indent > indent && nested_colon.is_some() && !literal_nel_continuation)
        });
        if nested_mapping == Some(true) {
            let start = span.start + indent + colon + 1 + leading;
            return Some((start, one_character_end(source, start, source.len())));
        }
    }
    None
}

fn invalid_explicit_timestamp_range(source: &str) -> Option<(usize, usize)> {
    let mut excluded_ranges = block_scalar_body_ranges(source);
    excluded_ranges.extend(multiline_quoted_scalar_ranges(source));
    normalize_ranges(&mut excluded_ranges);
    let non_string_key = non_string_mapping_key_range(source);
    let spans = line_spans(source);
    for (line_index, span) in spans.iter().enumerate() {
        let line = &source[span.start..span.content_end];
        for tag in ["!!timestamp", "!<tag:yaml.org,2002:timestamp>"] {
            let mut search_start = 0;
            while let Some(relative) = line[search_start..].find(tag) {
                let offset = search_start + relative;
                let absolute = span.start + offset;
                let prefix = &line[..offset];
                let previous = prefix
                    .chars()
                    .rev()
                    .find(|character| !character.is_whitespace());
                let property_start = prefix
                    .char_indices()
                    .rev()
                    .find_map(|(index, character)| {
                        matches!(character, '[' | '{' | ',' | ':' | '?').then_some(index + 1)
                    })
                    .unwrap_or(0);
                let (property_remainder, property_anchor, _) =
                    split_node_properties(prefix[property_start..].trim_start());
                let follows_anchor_property =
                    property_remainder.is_empty() && property_anchor.is_some();
                let timestamp_mapping_key = non_string_key.is_some_and(|(key_start, key_end)| {
                    absolute < key_start
                        && source[absolute + tag.len()..key_start].trim().is_empty()
                        && source[key_end..].trim_start().starts_with(':')
                });
                if sorted_range_contains(&excluded_ranges, absolute)
                    || yaml_comment_start(prefix).is_some()
                    || timestamp_mapping_key
                    || previous.is_some_and(|character| {
                        !matches!(character, '[' | '{' | ',' | ':' | '?' | '-')
                    }) && !follows_anchor_property
                    || (previous.is_none()
                        && !follows_deferred_block_node(source, &spans, line_index))
                {
                    search_start = offset + tag.len();
                    continue;
                }
                let after_tag = line[offset + tag.len()..].trim_start();
                let (remainder, _, _) = split_node_properties(after_tag);
                if matches!(remainder.chars().next(), Some('{' | '[')) {
                    search_start = offset + tag.len();
                    continue;
                }
                let parent_indent = line.len() - line.trim_start_matches([' ', '\t']).len();
                let lexical = if remainder.is_empty() || remainder.starts_with('#') {
                    tagged_lexical_source(
                        source,
                        &spans,
                        line_index,
                        parent_indent,
                        line,
                        remainder,
                        "timestamp",
                    )
                } else if matches!(remainder.chars().next(), Some('"' | '\'')) {
                    let relative = line
                        .find(remainder)
                        .unwrap_or_else(|| line.len().saturating_sub(remainder.len()));
                    scalar_lexical_source(&source[span.start + relative..]).to_owned()
                } else if matches!(remainder.chars().next(), Some('|' | '>')) {
                    tagged_lexical_source(
                        source,
                        &spans,
                        line_index,
                        parent_indent,
                        line,
                        remainder,
                        "timestamp",
                    )
                } else {
                    let flow_end = remainder.find([',', ']', '}']).unwrap_or(remainder.len());
                    scalar_lexical_source(remainder[..flow_end].trim_end()).to_owned()
                };
                let parsed = serde_yaml::from_str::<serde_yaml::Value>(&lexical).ok();
                if matches!(
                    &parsed,
                    Some(serde_yaml::Value::Mapping(_) | serde_yaml::Value::Sequence(_))
                ) {
                    search_start = offset + tag.len();
                    continue;
                }
                let semantic = match parsed.as_ref() {
                    Some(serde_yaml::Value::String(value)) => value.as_str(),
                    _ => lexical.as_str(),
                };
                if canonical_timestamp(semantic).is_none() {
                    return Some((absolute, absolute + tag.len()));
                }
                search_start = offset + tag.len();
            }
        }
    }
    None
}

fn rewrite_standard_sets_for_serde(source: &str) -> String {
    let spans = line_spans(source);
    let mut excluded_ranges = block_scalar_body_ranges(source);
    excluded_ranges.extend(multiline_quoted_scalar_ranges(source));
    normalize_ranges(&mut excluded_ranges);
    let mut occurrences = source
        .match_indices("!!set")
        .map(|(start, tag)| (start, start + tag.len()))
        .chain(
            source
                .match_indices("!<tag:yaml.org,2002:set>")
                .map(|(start, tag)| (start, start + tag.len())),
        )
        .collect::<Vec<_>>();
    occurrences.sort_unstable();
    let mut edits = Vec::<(usize, usize, String)>::new();
    for (tag_start, tag_end) in occurrences {
        if sorted_range_contains(&excluded_ranges, tag_start) {
            continue;
        }
        let Some((line_index, span)) = spans
            .iter()
            .enumerate()
            .find(|(_, span)| span.start <= tag_start && tag_start < span.content_end)
        else {
            continue;
        };
        let line = &source[span.start..span.content_end];
        let relative_tag_start = tag_start - span.start;
        let prefix = &line[..relative_tag_start];
        if yaml_comment_start(prefix).is_some() || !yaml_prefix_ends_outside_quotes(prefix) {
            continue;
        }
        let node_prefix_start = prefix
            .char_indices()
            .rev()
            .find_map(|(offset, character)| {
                matches!(character, ':' | ',' | '[' | '{' | '?').then_some(offset + 1)
            })
            .or_else(|| {
                prefix
                    .trim_start()
                    .strip_prefix("- ")
                    .map(|_| prefix.find("- ").unwrap_or(0) + 2)
            })
            .unwrap_or(0);
        let node_prefix = prefix[node_prefix_start..].trim();
        if !node_prefix.is_empty()
            && !node_prefix
                .split_whitespace()
                .all(|property| property.starts_with(['&', '!']))
        {
            continue;
        }

        let after_tag = &line[tag_end - span.start..];
        let (remainder, _, _) = split_node_properties(after_tag.trim_start());
        if remainder.starts_with('{') {
            edits.push((tag_start, tag_end, "!oset".to_owned()));
            let leading = after_tag.len() - after_tag.trim_start().len();
            let property_source = after_tag.trim_start();
            let collection_relative = property_source.len().saturating_sub(remainder.len());
            let flow_start = tag_end + leading + collection_relative;
            let flow_end = flow_value_end(source, flow_start);
            if flow_end <= flow_start || !source[flow_start..flow_end].ends_with('}') {
                continue;
            }
            edits.push((flow_start, flow_start + 1, "[".to_owned()));
            edits.push((flow_end - 1, flow_end, "]".to_owned()));
            for (entry_start, entry_end) in top_level_flow_entries(source, flow_start, flow_end) {
                edits.push((entry_start, entry_start, "{ ".to_owned()));
                edits.push((entry_end, entry_end, " }".to_owned()));
            }
            continue;
        }
        if !(remainder.is_empty() || remainder.starts_with('#')) {
            continue;
        }
        let parent_body = &source[span.start..span.content_end];
        let parent_trimmed = parent_body.trim_start_matches([' ', '\t']);
        let parent_indent = parent_body.len() - parent_trimmed.len();
        let block_end = direct_block_node_end(source, &spans, line_index, parent_indent);
        let first_member = spans
            .iter()
            .skip(line_index + 1)
            .take_while(|candidate| candidate.start < block_end)
            .find_map(|candidate| {
                let body = &source[candidate.start..candidate.content_end];
                let trimmed = body.trim_start_matches([' ', '\t']);
                (!trimmed.is_empty() && !trimmed.starts_with('#')).then_some((
                    candidate,
                    body.len() - trimmed.len(),
                    trimmed,
                ))
            });
        let Some((first_member, member_indent, first_trimmed)) = first_member else {
            continue;
        };
        if first_trimmed.starts_with('{') {
            let flow_start = first_member.start + member_indent;
            let flow_end = flow_value_end(source, flow_start);
            if flow_end > flow_start && source[flow_start..flow_end].ends_with('}') {
                edits.push((tag_start, tag_end, "!oset".to_owned()));
                edits.push((flow_start, flow_start + 1, "[".to_owned()));
                edits.push((flow_end - 1, flow_end, "]".to_owned()));
                for (entry_start, entry_end) in top_level_flow_entries(source, flow_start, flow_end)
                {
                    edits.push((entry_start, entry_start, "{ ".to_owned()));
                    edits.push((entry_end, entry_end, " }".to_owned()));
                }
            }
            continue;
        }
        if !(first_trimmed == "?"
            || first_trimmed.starts_with("? ")
            || mapping_key_colon(first_trimmed).is_some())
        {
            continue;
        }
        edits.push((tag_start, tag_end, "!oset".to_owned()));
        for (candidate_index, candidate) in spans
            .iter()
            .enumerate()
            .skip(line_index + 1)
            .take_while(|(_, candidate)| candidate.start < block_end)
        {
            let body = &source[candidate.start..candidate.content_end];
            let trimmed = body.trim_start_matches([' ', '\t']);
            let indent = body.len() - trimmed.len();
            if indent == member_indent && !trimmed.is_empty() && !trimmed.starts_with(['#', ':']) {
                if let Some(member) = trimmed.strip_prefix("? ")
                    && !member.starts_with(['{', '['])
                    && mapping_key_colon(member).is_some()
                {
                    let start = candidate.start + indent;
                    let inherited_indent = edits
                        .iter()
                        .filter(|(edit_start, edit_end, replacement)| {
                            *edit_start == candidate.start
                                && *edit_end == candidate.start
                                && replacement.as_str() == "  "
                        })
                        .count()
                        * 2;
                    edits.push((
                        start,
                        start + 2,
                        format!("- ?\n{}", " ".repeat(member_indent + 4 + inherited_indent)),
                    ));
                    for nested in spans
                        .iter()
                        .skip(candidate_index + 1)
                        .take_while(|nested| nested.start < block_end)
                    {
                        let nested_body = &source[nested.start..nested.content_end];
                        let nested_trimmed = nested_body.trim_start_matches([' ', '\t']);
                        let nested_indent = nested_body.len() - nested_trimmed.len();
                        if !nested_trimmed.is_empty() && nested_indent <= member_indent {
                            break;
                        }
                        if !nested_trimmed.is_empty() {
                            edits.push((nested.start, nested.start, "  ".to_owned()));
                        }
                    }
                } else {
                    edits.push((
                        candidate.start + indent,
                        candidate.start + indent,
                        "- ".to_owned(),
                    ));
                    if trimmed == "?" || trimmed.starts_with("? ") {
                        for nested in spans
                            .iter()
                            .skip(candidate_index + 1)
                            .take_while(|nested| nested.start < block_end)
                        {
                            let nested_body = &source[nested.start..nested.content_end];
                            let nested_trimmed = nested_body.trim_start_matches([' ', '\t']);
                            let nested_indent = nested_body.len() - nested_trimmed.len();
                            if !nested_trimmed.is_empty() && nested_indent <= member_indent {
                                break;
                            }
                            if !nested_trimmed.is_empty() {
                                edits.push((nested.start, nested.start, "  ".to_owned()));
                            }
                        }
                    }
                }
            }
        }
    }
    edits.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));
    let mut rewritten = source.to_owned();
    for (start, end, replacement) in edits {
        rewritten.replace_range(start..end, &replacement);
    }
    rewritten
}

fn top_level_flow_entries(source: &str, start: usize, end: usize) -> Vec<(usize, usize)> {
    let mut entries = Vec::new();
    let mut entry_start = start + 1;
    let mut stack = vec!['{'];
    let mut quote = None;
    let mut escaped = false;
    let mut comment = false;
    let mut entry_has_syntax = false;
    let mut trailing_comment_start = None;
    let mut verbatim_tag = false;
    for (relative, character) in source[start + 1..end].char_indices() {
        let offset = start + 1 + relative;
        if comment {
            if matches!(character, '\r' | '\n') {
                comment = false;
                if !entry_has_syntax {
                    entry_start = offset + character.len_utf8();
                }
            }
            continue;
        }
        if verbatim_tag {
            if character == '>' {
                verbatim_tag = false;
            }
            continue;
        }
        if let Some(active_quote) = quote {
            if active_quote == '"' && character == '\\' && !escaped {
                escaped = true;
                continue;
            }
            if character == active_quote && !escaped {
                quote = None;
            }
            escaped = false;
            continue;
        }
        match character {
            '!' if source[offset..].starts_with("!<") => {
                trailing_comment_start = None;
                entry_has_syntax = true;
                verbatim_tag = true;
            }
            '"' | '\'' => {
                trailing_comment_start = None;
                entry_has_syntax = true;
                quote = Some(character);
            }
            '#' if offset == 0
                || source[..offset]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_whitespace) =>
            {
                trailing_comment_start = entry_has_syntax.then_some(offset);
                comment = true;
            }
            '[' | '{' => {
                trailing_comment_start = None;
                entry_has_syntax = true;
                stack.push(character);
            }
            ']' | '}' => {
                if stack.len() == 1 {
                    let candidate_end = trailing_comment_start.unwrap_or(offset);
                    let candidate = &source[entry_start..candidate_end];
                    if !candidate.trim().is_empty() {
                        entries.push((entry_start, candidate_end));
                    }
                    break;
                }
                trailing_comment_start = None;
                entry_has_syntax = true;
                stack.pop();
            }
            ',' if stack.len() == 1 => {
                let candidate_end = trailing_comment_start.unwrap_or(offset);
                let candidate = &source[entry_start..candidate_end];
                if !candidate.trim().is_empty() {
                    entries.push((entry_start, candidate_end));
                }
                entry_start = offset + 1;
                entry_has_syntax = false;
                trailing_comment_start = None;
            }
            _ if !character.is_whitespace() => {
                trailing_comment_start = None;
                entry_has_syntax = true;
            }
            _ => {}
        }
    }
    entries
}

fn direct_block_node_end(
    source: &str,
    spans: &[LineSpan],
    line_index: usize,
    parent_indent: usize,
) -> usize {
    spans
        .iter()
        .skip(line_index + 1)
        .find_map(|candidate| {
            let body = &source[candidate.start..candidate.content_end];
            let trimmed = body.trim_start_matches([' ', '\t']);
            let indent = body.len() - trimmed.len();
            (!trimmed.is_empty() && !trimmed.starts_with('#') && indent <= parent_indent)
                .then_some(candidate.start)
        })
        .unwrap_or(source.len())
}

fn multiline_quoted_flow_key_colon(
    source: &str,
    flow_ranges: &[(usize, usize)],
    start: usize,
    end: usize,
) -> Option<usize> {
    let (_, flow_end) = flow_ranges
        .iter()
        .filter(|(opening, closing)| *opening < start && end <= *closing)
        .min_by_key(|(opening, closing)| closing.saturating_sub(*opening))?;
    let colon = skip_flow_space_and_comments(source, end, *flow_end);
    source[colon..].starts_with(':').then_some(colon)
}

fn normalize_multiline_quoted_flow_keys(source: &str) -> String {
    let flow_ranges = flow_collection_ranges(source);
    let mut edits = generic_multiline_quoted_scalar_ranges(source)
        .into_iter()
        .filter_map(|(start, end)| {
            let colon = multiline_quoted_flow_key_colon(source, &flow_ranges, start, end)?;
            let key = serde_yaml::from_str::<String>(&source[start..end]).ok()?;
            let replacement = serde_json::to_string(&key).ok()?;
            Some((start, colon, format!("{replacement} ")))
        })
        .collect::<Vec<_>>();
    if edits.is_empty() {
        return source.to_owned();
    }
    edits.sort_unstable_by_key(|(start, _, _)| *start);
    let mut normalized = String::with_capacity(source.len());
    let mut cursor = 0usize;
    for (start, end, replacement) in edits {
        if start < cursor {
            continue;
        }
        normalized.push_str(&source[cursor..start]);
        normalized.push_str(&replacement);
        cursor = end;
    }
    normalized.push_str(&source[cursor..]);
    normalized
}

fn yaml_anchor_name_end(source: &str, start: usize) -> usize {
    let mut end = start;
    while let Some(character) = source[end..].chars().next() {
        if matches!(
            character,
            ' ' | '\t' | '\r' | '\n' | ',' | '[' | ']' | '{' | '}'
        ) {
            break;
        }
        end += character.len_utf8();
    }
    end
}

fn libyaml_safe_anchor_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
}

fn normalize_hash_anchor_names(source: &str) -> String {
    let mut names = std::collections::BTreeMap::<String, String>::new();
    let mut replacements = Vec::new();
    let mut excluded_ranges = block_scalar_body_ranges(source);
    excluded_ranges.extend(multiline_quoted_scalar_ranges(source));
    excluded_ranges.extend(plain_scalar_value_ranges(source));
    normalize_ranges(&mut excluded_ranges);
    let mut quote = None;
    let mut escaped = false;
    let mut comment = false;
    let characters = source.char_indices();
    for (offset, character) in characters {
        if comment {
            if matches!(character, '\r' | '\n') {
                comment = false;
            }
            continue;
        }
        if let Some(active_quote) = quote {
            if active_quote == '"' && character == '\\' && !escaped {
                escaped = true;
                continue;
            }
            if character == active_quote && !escaped {
                quote = None;
            }
            escaped = false;
            continue;
        }
        match character {
            '"' | '\'' => quote = Some(character),
            '#' if offset == 0
                || source[..offset]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_whitespace) =>
            {
                comment = true;
            }
            '&' | '*' => {
                if sorted_range_contains(&excluded_ranges, offset)
                    || !yaml_node_property_position(source, offset)
                {
                    continue;
                }
                let start = offset + 1;
                let end = yaml_anchor_name_end(source, start);
                let name = &source[start..end];
                if !name.is_empty() && !libyaml_safe_anchor_name(name) {
                    let next_index = names.len();
                    let replacement = names.entry(name.to_owned()).or_insert_with(|| {
                        (next_index..)
                            .map(|index| format!("okf_internal_anchor_{index}"))
                            .find(|candidate| !source.contains(candidate))
                            .expect("an absent internal anchor name always exists")
                    });
                    replacements.push((start, end, replacement.clone()));
                }
            }
            _ => {}
        }
    }
    let mut normalized = source.to_owned();
    for (start, end, replacement) in replacements.into_iter().rev() {
        normalized.replace_range(start..end, &replacement);
    }
    normalized
}

fn normalize_tight_flow_plain_keys(source: &str) -> String {
    let spans = line_spans(source);
    let mut replacements = Vec::new();
    let plain_scalar_ranges = plain_scalar_value_ranges(source);
    let mut flow_depth = 0usize;
    let mut quote = None;
    let mut escaped = false;
    let mut comment = false;
    let mut node_boundary = false;
    let mut cursor = 0usize;
    while cursor < source.len() {
        let character = source[cursor..]
            .chars()
            .next()
            .expect("cursor is at a character boundary");
        let width = character.len_utf8();
        if sorted_range_contains(&plain_scalar_ranges, cursor) {
            cursor += width;
            continue;
        }
        if comment {
            if matches!(character, '\r' | '\n') {
                comment = false;
            }
            cursor += width;
            continue;
        }
        if let Some(active_quote) = quote {
            if active_quote == '"' && character == '\\' && !escaped {
                escaped = true;
                cursor += width;
                continue;
            }
            if character == active_quote && !escaped {
                quote = None;
            }
            escaped = false;
            cursor += width;
            continue;
        }
        match character {
            '"' | '\'' => {
                quote = Some(character);
                node_boundary = false;
            }
            '#' if cursor == 0
                || source[..cursor]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_whitespace) =>
            {
                comment = true;
            }
            '[' | '{' => {
                flow_depth += 1;
                node_boundary = true;
            }
            ']' | '}' => {
                flow_depth = flow_depth.saturating_sub(1);
                node_boundary = false;
            }
            ',' => node_boundary = flow_depth > 0,
            ':' => {
                let next = source[cursor + width..].chars().next();
                if flow_depth > 0
                    && node_boundary
                    && next.is_some_and(|value| {
                        !value.is_whitespace() && !matches!(value, ',' | ']' | '}')
                    })
                {
                    let end = cursor
                        + width
                        + source[cursor + width..]
                            .find(|value: char| {
                                value.is_whitespace()
                                    || matches!(value, ',' | ']' | '}' | ':' | '#')
                            })
                            .unwrap_or(source.len() - cursor - width);
                    let token = &source[cursor..end];
                    if let Ok(quoted) = serde_json::to_string(token) {
                        replacements.push((cursor, end, quoted));
                    }
                    cursor = end;
                    node_boundary = false;
                    continue;
                }
                let structural_colon = flow_depth > 0
                    && next.is_none_or(|value| {
                        value.is_whitespace() || matches!(value, ',' | ']' | '}' | '[' | '{')
                    });
                if structural_colon && next.is_some_and(|value| matches!(value, '[' | '{')) {
                    replacements.push((cursor + width, cursor + width, " ".to_owned()));
                }
                node_boundary = structural_colon;
            }
            '?' if flow_depth > 0 && node_boundary => {
                let next = source[cursor + width..].chars().next();
                if next.is_some_and(|value| {
                    !value.is_whitespace() && !matches!(value, ',' | ']' | '}')
                }) {
                    let end = cursor
                        + width
                        + source[cursor + width..]
                            .find(|value: char| {
                                value.is_whitespace()
                                    || matches!(value, ',' | ']' | '}' | ':' | '#')
                            })
                            .unwrap_or(source.len() - cursor - width);
                    let token = &source[cursor..end];
                    if let Ok(quoted) = serde_json::to_string(token) {
                        replacements.push((cursor, end, quoted));
                    }
                    cursor = end;
                    node_boundary = false;
                    continue;
                }
                node_boundary = true;
            }
            value if value.is_whitespace() => {}
            _ => node_boundary = false,
        }
        cursor += width;
    }
    for (line_index, span) in spans.iter().enumerate() {
        let line = &source[span.start..span.content_end];
        let Some(tight_colon) = line.find(":#") else {
            continue;
        };
        let Some(opening) = line[..tight_colon].rfind('{') else {
            continue;
        };
        let key_start = span.start + opening + 1;
        let Some(next) = spans.iter().skip(line_index + 1).find(|candidate| {
            let body = &source[candidate.start..candidate.content_end];
            !body.trim().is_empty() && !body.trim_start().starts_with('#')
        }) else {
            continue;
        };
        let next_body = &source[next.start..next.content_end];
        let next_trimmed = next_body.trim_start_matches([' ', '\t']);
        let Some(colon) = mapping_key_colon(next_trimmed) else {
            continue;
        };
        let key_end = next.start + next_body.len() - next_trimmed.len() + colon;
        let first = source[key_start..span.content_end].trim();
        let second = next_trimmed[..colon].trim();
        let semantic = format!("{first} {second}");
        let Ok(quoted) = serde_json::to_string(&semantic) else {
            continue;
        };
        replacements.push((key_start, key_end, quoted));
    }
    let mut normalized = source.to_owned();
    for (start, end, replacement) in replacements.into_iter().rev() {
        normalized.replace_range(start..end, &replacement);
    }
    normalized
}

fn mask_invalid_standard_scalar_tags(source: &str) -> String {
    let mut replacements = Vec::new();
    let mut excluded_ranges = block_scalar_body_ranges(source);
    excluded_ranges.extend(multiline_quoted_scalar_ranges(source));
    normalize_ranges(&mut excluded_ranges);
    let spans = line_spans(source);
    for (line_index, span) in spans.iter().enumerate() {
        let line = &source[span.start..span.content_end];
        for (tag, replacement) in [
            ("!!str", "!ostr"),
            ("!<tag:yaml.org,2002:str>", "!ostr"),
            ("!!bool", "!obool"),
            ("!<tag:yaml.org,2002:bool>", "!obool"),
            ("!!int", "!oint"),
            ("!<tag:yaml.org,2002:int>", "!oint"),
            ("!!float", "!ofloat"),
            ("!<tag:yaml.org,2002:float>", "!ofloat"),
            ("!!null", "!onull"),
            ("!<tag:yaml.org,2002:null>", "!onull"),
        ] {
            let mut search_start = 0;
            while let Some(relative) = line[search_start..].find(tag) {
                let offset = search_start + relative;
                let absolute = span.start + offset;
                if sorted_range_contains(&excluded_ranges, absolute) {
                    search_start = offset + tag.len();
                    continue;
                }
                let prefix = &line[..offset];
                let quoted = !yaml_prefix_ends_outside_quotes(prefix);
                let previous = prefix
                    .chars()
                    .rev()
                    .find(|character| !character.is_whitespace());
                let property_start = prefix
                    .char_indices()
                    .rev()
                    .find_map(|(index, character)| {
                        matches!(character, '[' | '{' | ',' | ':' | '?').then_some(index + 1)
                    })
                    .unwrap_or(0);
                let (property_remainder, anchor_name, _) =
                    split_node_properties(prefix[property_start..].trim_start());
                let follows_anchor_property =
                    property_remainder.is_empty() && anchor_name.is_some();
                let mask_after_anchor = follows_anchor_property;
                if quoted
                    || yaml_comment_start(prefix).is_some()
                    || previous.is_some_and(|character| {
                        !matches!(character, '[' | '{' | ',' | ':' | '?' | '-')
                    }) && !mask_after_anchor
                    || (previous.is_none()
                        && !follows_deferred_block_node(source, &spans, line_index))
                {
                    search_start = offset + tag.len();
                    continue;
                }
                replacements.push((
                    span.start + offset,
                    span.start + offset + tag.len(),
                    replacement,
                ));
                search_start = offset + tag.len();
            }
        }
    }
    replacements.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));
    let mut result = source.to_owned();
    for (start, end, replacement) in replacements {
        result.replace_range(start..end, replacement);
    }
    result
}

fn mask_large_yaml_integers(source: &str) -> String {
    let mut edits = Vec::new();
    let mut excluded_ranges = block_scalar_body_ranges(source);
    excluded_ranges.extend(multiline_quoted_scalar_ranges(source));
    normalize_ranges(&mut excluded_ranges);
    let spans = line_spans(source);
    for span in &spans {
        let line = &source[span.start..span.content_end];
        let syntax = yaml_comment_start(line).map_or(line, |comment| &line[..comment]);
        let mut quote = None;
        let mut escaped = false;
        for (offset, character) in syntax.char_indices() {
            let absolute = span.start + offset;
            if sorted_range_contains(&excluded_ranges, absolute) {
                continue;
            }
            if let Some(active_quote) = quote {
                if active_quote == '"' && character == '\\' && !escaped {
                    escaped = true;
                    continue;
                }
                if character == active_quote && !escaped {
                    quote = None;
                }
                escaped = false;
                continue;
            }
            if matches!(character, '"' | '\'') {
                quote = Some(character);
                continue;
            }
            if !character.is_ascii_digit() && !matches!(character, '+' | '-') {
                continue;
            }
            let before = syntax[..offset].chars().next_back();
            if before.is_some_and(|value| {
                !value.is_whitespace() && !matches!(value, '[' | '{' | ',' | ':' | '?')
            }) {
                continue;
            }
            if before == Some(':')
                && syntax[..offset.saturating_sub(1)]
                    .chars()
                    .next_back()
                    .is_some_and(|value| value.is_ascii_digit())
            {
                continue;
            }
            let candidate = &syntax[offset..];
            let token_length = candidate
                .find(|value: char| {
                    value.is_whitespace() || matches!(value, ',' | ']' | '}' | ':' | '#')
                })
                .unwrap_or(candidate.len());
            let token = &candidate[..token_length];
            let prefix = syntax[..offset].trim_end();
            let property_start = prefix
                .char_indices()
                .rev()
                .find_map(|(index, value)| {
                    matches!(value, '[' | '{' | ',' | ':' | '?').then_some(index + 1)
                })
                .unwrap_or(0);
            let properties = prefix[property_start..].trim_start();
            let explicit_integer_tag = properties.split_whitespace().find(|property| {
                matches!(*property, "!oint" | "!!int" | "!<tag:yaml.org,2002:int>")
            });
            let explicitly_tagged = explicit_integer_tag.is_some()
                || deferred_standard_tag_name(source, &spans, span.start).as_deref() == Some("int");
            if yaml_schema_integer_string(token) {
                let quoted = serde_json::to_string(token).expect("integer text is JSON-safe");
                edits.push((absolute, absolute + token_length, quoted));
                continue;
            }
            let Some(canonical) = canonical_set_integer(token, explicitly_tagged) else {
                continue;
            };
            let unsigned_decimal = token.strip_prefix(['+', '-']).unwrap_or(token);
            if !explicitly_tagged
                && unsigned_decimal.len() > 1
                && unsigned_decimal.starts_with('0')
                && unsigned_decimal
                    .chars()
                    .all(|character| character.is_ascii_digit())
            {
                edits.push((absolute, absolute + token_length, canonical));
                continue;
            }
            if !explicitly_tagged
                && token.chars().all(|character| character.is_ascii_digit())
                && token.len() > canonical.len()
                && token.len() > 19
            {
                edits.push((absolute, absolute + token_length, canonical));
                continue;
            }
            let too_large = if canonical.starts_with('-') {
                canonical.parse::<i64>().is_err()
            } else {
                canonical.parse::<u64>().is_err()
            };
            if !too_large {
                continue;
            }
            let quoted = serde_json::to_string(&canonical).expect("integer text is JSON-safe");
            let replacement = if explicitly_tagged {
                quoted
            } else {
                format!("!obigint {quoted}")
            };
            edits.push((absolute, absolute + token_length, replacement));
            if let Some(tag) = explicit_integer_tag.filter(|tag| *tag != "!oint")
                && let Some(relative_tag) = prefix[property_start..].find(tag)
            {
                let tag_start = span.start + property_start + relative_tag;
                edits.push((tag_start, tag_start + tag.len(), "!oint".to_owned()));
            }
        }
    }
    edits.sort_by(|left, right| right.0.cmp(&left.0));
    let mut masked = source.to_owned();
    for (start, end, replacement) in edits {
        masked.replace_range(start..end, &replacement);
    }
    masked
}

fn follows_deferred_block_node(source: &str, spans: &[LineSpan], line_index: usize) -> bool {
    let Some(previous) = spans[..line_index].iter().rev().find(|span| {
        let body = &source[span.start..span.content_end];
        let trimmed = body.trim();
        !trimmed.is_empty() && !trimmed.starts_with('#')
    }) else {
        return false;
    };
    let body = &source[previous.start..previous.content_end];
    let syntax = yaml_comment_start(body).map_or(body, |comment| &body[..comment]);
    let trimmed = syntax.trim();
    if matches!(trimmed, "-" | "?") {
        return true;
    }
    let node_source = if let Some(item) = trimmed.strip_prefix("- ") {
        if let Some(colon) = mapping_key_colon(item) {
            item[colon + 1..].trim_start()
        } else {
            item
        }
    } else if let Some(colon) = mapping_key_colon(trimmed) {
        trimmed[colon + 1..].trim_start()
    } else {
        return false;
    };
    let (remainder, anchor, tag) = split_node_properties(node_source);
    remainder.is_empty() && (node_source.is_empty() || anchor.is_some() || tag.is_some())
}

fn under_indented_flow_range(source: &str) -> Option<(usize, usize, char)> {
    let spans = line_spans(source);
    let mut excluded_ranges = block_scalar_body_ranges(source);
    excluded_ranges.extend(multiline_quoted_scalar_ranges(source));
    normalize_ranges(&mut excluded_ranges);
    for (line_index, span) in spans.iter().enumerate() {
        if sorted_range_contains(&excluded_ranges, span.start) {
            continue;
        }
        let body = &source[span.start..span.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        let indent = body.len() - trimmed.len();
        let item = trimmed
            .strip_prefix("- ")
            .or_else(|| (trimmed == "-").then_some(""));
        let mapping_source = item.unwrap_or(trimmed);
        let value_source = if matches!(trimmed.chars().next(), Some('{' | '['))
            && follows_deferred_block_node(source, &spans, line_index)
        {
            trimmed
        } else if item.is_some()
            && (matches!(mapping_source.chars().next(), Some('{' | '['))
                || mapping_key_colon(mapping_source).is_none())
        {
            mapping_source
        } else {
            let Some(colon) = mapping_key_colon(mapping_source) else {
                continue;
            };
            mapping_source[colon + 1..].trim_start()
        };
        let (remainder, _, _) = split_node_properties(value_source);
        let closing = match remainder.chars().next() {
            Some('[') => ']',
            Some('{') => '}',
            _ => continue,
        };
        let relative = body
            .find(value_source)
            .unwrap_or_else(|| body.len().saturating_sub(value_source.len()))
            + value_source.len().saturating_sub(remainder.len());
        let start = span.start + relative;
        let end = flow_value_end(source, start);
        let closed = source[start..end].ends_with(closing);
        if closed && end <= span.end {
            continue;
        }
        for candidate in spans.iter().skip(line_index + 1) {
            if candidate.start >= end {
                break;
            }
            let candidate_body = &source[candidate.start..candidate.content_end];
            let candidate_trimmed = candidate_body.trim_start_matches([' ', '\t']);
            if candidate_trimmed.is_empty() || candidate_trimmed.starts_with('#') {
                continue;
            }
            let candidate_indent = candidate_body.len() - candidate_trimmed.len();
            let candidate_syntax = yaml_comment_start(candidate_trimmed)
                .map_or(candidate_trimmed, |comment| &candidate_trimmed[..comment])
                .trim();
            if candidate_indent <= indent
                && candidate_syntax.trim_end_matches(',').trim() != closing.to_string()
            {
                let start = candidate.start + candidate_indent;
                return Some((
                    start,
                    one_character_end(source, start, candidate.content_end),
                    closing,
                ));
            }
        }
        if !closed {
            return Some((source.len(), source.len() + 1, closing));
        }
    }
    None
}

fn duplicate_empty_explicit_key_range(source: &str) -> Option<(usize, usize)> {
    let spans = line_spans(source);
    let mut excluded_ranges = block_scalar_body_ranges(source);
    excluded_ranges.extend(multiline_quoted_scalar_ranges(source));
    excluded_ranges.extend(plain_scalar_value_ranges(source));
    normalize_ranges(&mut excluded_ranges);
    for (flow_start, flow_end) in flow_collection_ranges(source)
        .into_iter()
        .filter(|(start, _)| source[*start..].starts_with('{'))
    {
        let mut saw_null = false;
        let mut saw_empty_string = false;
        for (entry_start, entry_end) in top_level_flow_entries(source, flow_start, flow_end) {
            let entry = &source[entry_start..entry_end];
            let leading = entry.len() - entry.trim_start().len();
            let trimmed = entry.trim_start();
            let key = trimmed
                .strip_prefix('?')
                .filter(|_| trimmed[1..].chars().next().is_none_or(char::is_whitespace))
                .map(str::trim_start)
                .unwrap_or(trimmed);
            let key_start = entry_start + leading + trimmed.len() - key.len();
            let Some(colon) = flow_top_level_mapping_colon(source, key_start, entry_end) else {
                continue;
            };
            let key_source = source[key_start..colon].trim_end_matches([' ', '\t', '\r', '\n']);
            if yaml_syntax_is_empty(key_source) {
                if saw_null {
                    return Some((colon, one_character_end(source, colon, entry_end)));
                }
                saw_null = true;
                continue;
            }
            let Some((plain_key_source, scalar_relative, _, key_tag)) =
                multiline_mapping_key_parts(key_source)
            else {
                continue;
            };
            let scalar = scalar_lexical_source(plain_key_source);
            if parsed_string_mapping_key(scalar, key_tag).as_deref() != Some("") {
                continue;
            }
            if saw_empty_string {
                if scalar.is_empty() {
                    return Some((colon, one_character_end(source, colon, entry_end)));
                }
                let scalar_start = key_start + scalar_relative;
                return Some((scalar_start, one_character_end(source, scalar_start, colon)));
            }
            saw_empty_string = true;
        }
    }
    let mut implicit_empty_indents = BTreeSet::new();
    for (line_index, line) in spans.iter().enumerate() {
        if sorted_range_contains(&excluded_ranges, line.start) {
            continue;
        }
        let body = &source[line.start..line.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = body.len() - trimmed.len();
        implicit_empty_indents.retain(|seen_indent| *seen_indent <= indent);
        if !trimmed.starts_with(':') || !trimmed[1..].chars().next().is_none_or(char::is_whitespace)
        {
            continue;
        }
        let explicit_value = spans[..line_index].iter().rev().find_map(|candidate| {
            let candidate_body = &source[candidate.start..candidate.content_end];
            let candidate_trimmed = candidate_body.trim_start_matches([' ', '\t']);
            if candidate_trimmed.is_empty() || candidate_trimmed.starts_with('#') {
                return None;
            }
            let candidate_indent = candidate_body.len() - candidate_trimmed.len();
            if candidate_indent > indent {
                return None;
            }
            Some(
                (candidate_indent == indent
                    && candidate_trimmed.strip_prefix('?').is_some_and(|rest| {
                        rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
                    }))
                    || (candidate_indent + 2 == indent
                        && candidate_trimmed.strip_prefix("- ?").is_some_and(|rest| {
                            rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
                        })),
            )
        }) == Some(true);
        if explicit_value {
            continue;
        }
        if !implicit_empty_indents.insert(indent) {
            let colon = line.start + indent;
            return Some((colon, one_character_end(source, colon, line.content_end)));
        }
    }
    let mut seen_indents = BTreeSet::new();
    for (line_index, line) in spans.iter().enumerate() {
        if sorted_range_contains(&excluded_ranges, line.start) {
            continue;
        }
        let body = &source[line.start..line.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = body.len() - trimmed.len();
        let sequence_member = trimmed.strip_prefix("- ");
        let mapping_source = sequence_member.unwrap_or(trimmed);
        let mapping_indent = indent + usize::from(sequence_member.is_some()) * 2;
        seen_indents.retain(|seen_indent| *seen_indent <= mapping_indent);
        if sequence_member.is_some() {
            seen_indents.remove(&mapping_indent);
        }
        let Some(member) = mapping_source.strip_prefix('?').and_then(|remainder| {
            (remainder.is_empty() || remainder.chars().next().is_some_and(char::is_whitespace))
                .then(|| remainder.trim_start())
        }) else {
            continue;
        };
        let syntax = yaml_comment_start(member).map_or(member, |comment| &member[..comment]);
        if !syntax.trim().is_empty() {
            continue;
        }
        let value_marker = spans.iter().skip(line_index + 1).find_map(|candidate| {
            let candidate_body = &source[candidate.start..candidate.content_end];
            let candidate_trimmed = candidate_body.trim_start_matches([' ', '\t']);
            if candidate_trimmed.is_empty() || candidate_trimmed.starts_with('#') {
                return None;
            }
            let candidate_indent = candidate_body.len() - candidate_trimmed.len();
            (candidate_indent == mapping_indent
                && candidate_trimmed.strip_prefix(':').is_some_and(|rest| {
                    rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
                }))
            .then_some(candidate.start + candidate_indent)
        });
        let Some(value_marker) = value_marker else {
            continue;
        };
        if !seen_indents.insert(mapping_indent) {
            return Some((
                value_marker,
                one_character_end(source, value_marker, source.len()),
            ));
        }
    }
    None
}

fn non_string_mapping_key_range(source: &str) -> Option<(usize, usize)> {
    let mut excluded_ranges = block_scalar_body_ranges(source);
    excluded_ranges.extend(multiline_quoted_scalar_ranges(source));
    excluded_ranges.extend(plain_scalar_value_ranges(source));
    normalize_ranges(&mut excluded_ranges);
    if let Some(range) = non_string_flow_mapping_key_range(source, &excluded_ranges) {
        return Some(range);
    }
    let scalar_ranges = excluded_ranges.clone();
    let mut standard_set_ranges = standard_set_body_ranges(source);
    normalize_ranges(&mut standard_set_ranges);
    excluded_ranges.extend(standard_set_ranges.iter().copied());
    normalize_ranges(&mut excluded_ranges);
    if let Some(range) = alias_mapping_key_range(source, &excluded_ranges) {
        return Some(range);
    }
    excluded_ranges.extend(flow_collection_ranges(source));
    normalize_ranges(&mut excluded_ranges);
    let spans = line_spans(source);
    let standard_flow_set_ranges = standard_flow_set_ranges(source);
    let parent_collection_tags = parent_collection_tag_flags(source, &spans);
    for (line_index, line) in spans.iter().enumerate() {
        let body = &source[line.start..line.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        let indent = body.len() - trimmed.len();
        let inside_standard_set = sorted_range_contains(&standard_set_ranges, line.start);
        let inside_scalar = sorted_range_contains(&scalar_ranges, line.start);
        let standard_set_item = inside_standard_set
            .then(|| {
                trimmed
                    .strip_prefix("- ")
                    .or_else(|| (trimmed == "-").then_some(""))
            })
            .flatten();
        let standard_set_mapping_source = standard_set_item.unwrap_or(trimmed);
        if inside_standard_set
            && !inside_scalar
            && let Some(member) = standard_set_mapping_source
                .strip_prefix('?')
                .map(str::trim_start)
        {
            let member_syntax =
                yaml_comment_start(member).map_or(member, |comment| &member[..comment]);
            if let Some(colon) = flow_top_level_mapping_colon(member_syntax, 0, member_syntax.len())
            {
                let key_source = member_syntax[..colon].trim_end();
                let key_start =
                    line.start + body.len().saturating_sub(trimmed.len()) + trimmed.len()
                        - member.len();
                if let Some(range) = non_string_key_source_range(key_source, key_start) {
                    return Some(range);
                }
            }
        }
        let explicit_mapping_value_start = (inside_standard_set
            && standard_set_mapping_source.strip_prefix('?').is_some())
        .then(|| {
            let mut value_start = None;
            let expected_indent = indent + if standard_set_item.is_some() { 2 } else { 0 };
            for candidate in spans.iter().skip(line_index + 1) {
                let candidate_body = &source[candidate.start..candidate.content_end];
                let candidate_trimmed = candidate_body.trim_start_matches([' ', '\t']);
                if candidate_trimmed.is_empty() || candidate_trimmed.starts_with('#') {
                    continue;
                }
                let candidate_indent = candidate_body.len() - candidate_trimmed.len();
                if candidate_indent < expected_indent {
                    break;
                }
                if candidate_indent == expected_indent {
                    value_start = candidate_trimmed
                        .strip_prefix(':')
                        .is_some_and(|rest| {
                            rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
                        })
                        .then_some(candidate.start);
                    break;
                }
            }
            value_start
        })
        .flatten();
        if inside_standard_set
            && !inside_scalar
            && let Some(key_end) = explicit_mapping_value_start
        {
            let key_start = explicit_key_source_start(
                source,
                &spans,
                line_index,
                body,
                standard_set_mapping_source,
            );
            if key_start >= key_end {
                let empty = explicit_empty_key_position(line, body, standard_set_mapping_source);
                return Some((empty, empty));
            }
            let key_source = source[key_start..key_end].trim_end_matches(['\r', '\n']);
            if let Some(range) = non_string_key_source_range(key_source, key_start) {
                return Some(range);
            }
        }
        if inside_standard_set && !inside_scalar && !trimmed.starts_with(['?', '#', ':']) {
            let mapping_source = trimmed
                .strip_prefix("- ")
                .or_else(|| (trimmed == "-").then_some(""))
                .unwrap_or(trimmed);
            if let Some(colon) = mapping_key_colon(mapping_source) {
                let key_source = mapping_source[..colon].trim_end();
                if key_source.is_empty() {
                    continue;
                }
                let key_start = line.start
                    + body.len().saturating_sub(trimmed.len())
                    + trimmed.len().saturating_sub(mapping_source.len());
                if let Some(range) = non_string_key_source_range(key_source, key_start) {
                    return Some(range);
                }
            }
        }
        if sorted_range_contains(&excluded_ranges, line.start)
            || sorted_range_contains(&standard_flow_set_ranges, line.start + indent)
        {
            continue;
        }
        let item = trimmed
            .strip_prefix("- ")
            .or_else(|| (trimmed == "-").then_some(""));
        let mapping_source = item.unwrap_or(trimmed);
        let mapping_offset = body
            .find(mapping_source)
            .unwrap_or_else(|| body.len().saturating_sub(mapping_source.len()));
        if mapping_source.strip_prefix('?').is_some_and(|rest| {
            rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
        }) {
            let key_start =
                explicit_key_source_start(source, &spans, line_index, body, mapping_source);
            let expected_value_indent =
                body.len() - trimmed.len() + if item.is_some() { 2 } else { 0 };
            let key_end = spans
                .iter()
                .skip(line_index + 1)
                .find_map(|candidate| {
                    let candidate_body = &source[candidate.start..candidate.content_end];
                    let candidate_trimmed = candidate_body.trim_start_matches([' ', '\t']);
                    let candidate_indent = candidate_body.len() - candidate_trimmed.len();
                    (candidate_indent == expected_value_indent
                        && candidate_trimmed.strip_prefix(':').is_some_and(|rest| {
                            rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
                        }))
                    .then_some(candidate.start)
                })
                .unwrap_or(line.content_end);
            if key_start >= key_end {
                let empty = explicit_empty_key_position(line, body, mapping_source);
                return Some((empty, empty));
            }
            let candidate = source[key_start..key_end].trim_end_matches(['\r', '\n']);
            if let Some(range) = non_string_key_source_range(candidate, key_start) {
                return Some(range);
            }
            continue;
        }
        let Some(colon) = mapping_key_colon(mapping_source) else {
            continue;
        };
        let key_source = mapping_source[..colon].trim_end_matches([' ', '\t']);
        if key_source.is_empty() {
            if item.is_none() {
                let explicit_value = mapping_source.starts_with(':')
                    && spans[..line_index].iter().rev().find_map(|candidate| {
                        let candidate_body = &source[candidate.start..candidate.content_end];
                        let candidate_trimmed = candidate_body.trim_start_matches([' ', '\t']);
                        if candidate_trimmed.is_empty() || candidate_trimmed.starts_with('#') {
                            return None;
                        }
                        let candidate_indent = candidate_body.len() - candidate_trimmed.len();
                        if candidate_indent > indent {
                            return None;
                        }
                        Some(
                            (candidate_indent == indent
                                && candidate_trimmed.strip_prefix('?').is_some_and(|rest| {
                                    rest.is_empty()
                                        || rest.chars().next().is_some_and(char::is_whitespace)
                                }))
                                || (candidate_indent + 2 == indent
                                    && candidate_trimmed.strip_prefix("- ?").is_some_and(|rest| {
                                        rest.is_empty()
                                            || rest.chars().next().is_some_and(char::is_whitespace)
                                    })),
                        )
                    }) == Some(true);
                if explicit_value {
                    continue;
                }
                let marker = line.start + mapping_offset + colon;
                return Some((marker, marker));
            }
            continue;
        }
        let key_start = line.start + mapping_offset;
        let (plain_key_source, _, key_tag) = split_node_properties(key_source);
        if item.is_none()
            && plain_key_source.is_empty()
            && key_tag == Some("str")
            && parent_collection_tags[line_index] == Some(false)
        {
            let marker = key_start + colon;
            return Some((marker, marker));
        }
        if let Some(range) = non_string_key_source_range(key_source, key_start) {
            return Some(range);
        }
    }
    None
}

fn non_string_key_source_range(key_source: &str, key_start: usize) -> Option<(usize, usize)> {
    let Some((plain_key_source, relative_start, _, key_tag)) =
        multiline_mapping_key_parts(key_source)
    else {
        let leading = key_source.len() - key_source.trim_start_matches([' ', '\t']).len();
        let trimmed = key_source.trim_start_matches([' ', '\t']);
        let syntax = yaml_comment_start(trimmed).map_or(trimmed, |comment| &trimmed[..comment]);
        let syntax = syntax.trim_end_matches([' ', '\t', '\r', '\n']);
        let (remainder, anchor, tag) = split_node_properties(syntax);
        if remainder.is_empty() && (anchor.is_some() || tag.is_some()) {
            if tag == Some("str") {
                return None;
            }
            let empty = key_start + leading + syntax.len();
            return Some((empty, empty));
        }
        return None;
    };
    if key_tag.is_some_and(|tag| standard_tagged_key_has_string_semantic(plain_key_source, tag)) {
        return None;
    }
    if plain_key_source.contains('\u{0085}')
        && parsed_string_mapping_key(plain_key_source, key_tag).is_some()
    {
        return None;
    }
    let plain_trimmed = plain_key_source.trim();
    let unsigned_decimal = plain_trimmed
        .strip_prefix(['+', '-'])
        .unwrap_or(plain_trimmed);
    let yaml_12_leading_zero_integer = unsigned_decimal.len() > 1
        && unsigned_decimal.starts_with('0')
        && unsigned_decimal
            .chars()
            .all(|character| character.is_ascii_digit());
    let non_string = key_tag.is_some()
        || yaml_12_leading_zero_integer
        || serde_yaml::from_str::<serde_yaml::Value>(plain_key_source)
            .is_ok_and(|value| !matches!(value, serde_yaml::Value::String(_)));
    if !non_string {
        return None;
    }
    let start = key_start + relative_start;
    Some((start, start + scalar_lexical_source(plain_key_source).len()))
}

fn standard_tagged_key_has_string_semantic(source: &str, tag_name: &str) -> bool {
    if !matches!(tag_name, "str" | "int" | "float" | "bool" | "null") {
        return false;
    }
    standard_tagged_key_semantic(source, tag_name).is_some_and(|value| value.is_string())
}

fn standard_tagged_key_semantic(source: &str, tag_name: &str) -> Option<Value> {
    let lexical = scalar_lexical_source(source);
    let synthetic = format!("value: !!{tag_name} {lexical}");
    let (parser_source, literal_nel_marker) = mask_literal_nel(&synthetic);
    let parsed = serde_yaml::from_str::<serde_yaml::Value>(&mask_invalid_standard_scalar_tags(
        &parser_source,
    ))
    .ok()
    .and_then(|value| yaml_to_json(value).ok())
    .map(|mut value| {
        if let Some(marker) = literal_nel_marker.as_deref() {
            restore_literal_nel_in_value(&mut value, marker);
        }
        value
    });
    let existing = parsed
        .as_ref()
        .and_then(|value| value.get("value"))
        .map(semantic_value)
        .cloned()
        .unwrap_or_else(|| Value::String(lexical.trim().to_owned()));
    Some(standard_tag_semantic(tag_name, lexical, existing))
}

fn semantic_mapping_key_value(source: &str, tag_name: Option<&str>) -> Option<Value> {
    if let Some(tag_name) = tag_name {
        return standard_tagged_key_semantic(source, tag_name);
    }
    let (masked, marker) = mask_literal_nel(source);
    let parsed = serde_yaml::from_str::<serde_yaml::Value>(&masked).ok()?;
    let mut value = yaml_to_json(parsed).ok()?;
    if let Some(marker) = marker.as_deref() {
        restore_literal_nel_in_value(&mut value, marker);
    }
    Some(value)
}

fn explicit_empty_key_position(line: &LineSpan, body: &str, mapping_source: &str) -> usize {
    let mapping_offset = body
        .find(mapping_source)
        .unwrap_or_else(|| body.len().saturating_sub(mapping_source.len()));
    let question = line.start + mapping_offset;
    let after_question = mapping_source.strip_prefix('?').unwrap_or(mapping_source);
    let leading = after_question.len() - after_question.trim_start().len();
    let remainder = after_question.trim_start();
    if remainder.starts_with('#') {
        question + 1 + leading
    } else {
        line.content_end
    }
}

fn non_string_flow_mapping_key_range(
    source: &str,
    excluded_ranges: &[(usize, usize)],
) -> Option<(usize, usize)> {
    let mut quote = None;
    let mut escaped = false;
    let mut comment = false;
    for (offset, character) in source.char_indices() {
        if sorted_range_contains(excluded_ranges, offset) {
            continue;
        }
        if comment {
            if matches!(character, '\r' | '\n') {
                comment = false;
            }
            continue;
        }
        if let Some(active_quote) = quote {
            if active_quote == '"' && character == '\\' && !escaped {
                escaped = true;
                continue;
            }
            if character == active_quote && !escaped {
                quote = None;
            }
            escaped = false;
            continue;
        }
        match character {
            '#' if offset == 0
                || source[..offset]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_whitespace) =>
            {
                comment = true;
            }
            '"' | '\'' => quote = Some(character),
            '{' => {
                let end = flow_value_end(source, offset);
                for (entry_start, entry_end) in top_level_flow_entries(source, offset, end) {
                    let entry_source = &source[entry_start..entry_end];
                    let leading = entry_source.len() - entry_source.trim_start().len();
                    let entry = entry_source.trim_start();
                    let explicit_key = entry.strip_prefix('?');
                    let key = explicit_key.map(str::trim_start).unwrap_or(entry);
                    let key_start = entry_start + leading + entry.len().saturating_sub(key.len());
                    let Some(colon) = flow_top_level_mapping_colon(source, key_start, entry_end)
                    else {
                        continue;
                    };
                    let key_source = source[key_start..colon].trim_end();
                    if key_source.trim().is_empty()
                        || (explicit_key.is_some() && yaml_syntax_is_empty(key_source))
                    {
                        let marker = if explicit_key.is_some() {
                            yaml_comment_start(&source[entry_start..colon])
                                .map_or(colon, |comment| entry_start + comment)
                        } else {
                            entry_start
                        };
                        return Some((marker, marker));
                    }
                    if let Some(range) = non_string_key_source_range(key_source, key_start) {
                        return Some(range);
                    }
                }
            }
            _ => {}
        }
    }
    None
}

fn yaml_syntax_is_empty(source: &str) -> bool {
    line_spans(source).into_iter().all(|line| {
        let body = &source[line.start..line.content_end];
        yaml_comment_start(body)
            .map_or(body, |comment| &body[..comment])
            .trim()
            .is_empty()
    })
}

fn multiline_quoted_scalar_ranges(source: &str) -> Vec<(usize, usize)> {
    let spans = line_spans(source);
    let mut ranges = spans
        .iter()
        .enumerate()
        .filter_map(|(line_index, span)| {
            let body = &source[span.start..span.content_end];
            let trimmed = body.trim_start_matches([' ', '\t']);
            let item = trimmed
                .strip_prefix("- ")
                .or_else(|| (trimmed == "-").then_some(""));
            let mapping_source = item.unwrap_or(trimmed);
            let node_source = if let Some(colon) = mapping_key_colon(mapping_source) {
                mapping_source[colon + 1..].trim_start()
            } else if item.is_some() {
                mapping_source
            } else if let Some(explicit) = mapping_source.strip_prefix('?') {
                explicit.trim_start()
            } else {
                return None;
            };
            let (remainder, _, tag_name) = split_node_properties(node_source);
            let (start, value_source) = if matches!(remainder.chars().next(), Some('"' | '\'')) {
                let relative = body
                    .find(node_source)
                    .unwrap_or_else(|| body.len().saturating_sub(node_source.len()))
                    + node_source.len().saturating_sub(remainder.len());
                (span.start + relative, remainder)
            } else if (remainder.is_empty() || remainder.starts_with('#'))
                && tag_name
                    .is_some_and(|tag| !matches!(tag, "map" | "seq" | "set" | "omap" | "pairs"))
            {
                let (first_index, first) =
                    spans
                        .iter()
                        .enumerate()
                        .skip(line_index + 1)
                        .find(|(_, candidate)| {
                            let candidate_body = &source[candidate.start..candidate.content_end];
                            !candidate_body.trim().is_empty()
                                && !candidate_body.trim_start().starts_with('#')
                        })?;
                let first_body = &source[first.start..first.content_end];
                let first_trimmed = first_body.trim_start_matches([' ', '\t']);
                if !matches!(first_trimmed.chars().next(), Some('"' | '\'')) {
                    return None;
                }
                let first_indent = first_body.len() - first_trimmed.len();
                let _ = first_index;
                (first.start + first_indent, first_trimmed)
            } else {
                return None;
            };
            let end = start + scalar_lexical_source(&source[start..]).len();
            (end > span.end).then_some((span.end, end.max(start + value_source.len())))
        })
        .collect::<Vec<_>>();
    ranges.extend(generic_multiline_quoted_scalar_ranges(source));
    ranges.sort_unstable();
    ranges.dedup();
    ranges
}

fn generic_multiline_quoted_scalar_ranges(source: &str) -> Vec<(usize, usize)> {
    let excluded = block_scalar_body_ranges(source);
    let mut excluded_index = 0usize;
    let mut ranges = Vec::new();
    let mut quote = None;
    let mut quote_start = 0;
    let mut escaped = false;
    let mut comment = false;
    let mut characters = source.char_indices().peekable();
    while let Some((offset, character)) = characters.next() {
        while excluded
            .get(excluded_index)
            .is_some_and(|(_, end)| *end <= offset)
        {
            excluded_index += 1;
        }
        if excluded
            .get(excluded_index)
            .is_some_and(|(start, end)| *start <= offset && offset < *end)
        {
            continue;
        }
        if comment {
            if matches!(character, '\r' | '\n') {
                comment = false;
            }
            continue;
        }
        if let Some(active_quote) = quote {
            if active_quote == '"' && character == '\\' && !escaped {
                escaped = true;
                continue;
            }
            if character == active_quote && !escaped {
                if active_quote == '\'' && characters.peek().is_some_and(|(_, next)| *next == '\'')
                {
                    characters.next();
                } else {
                    let end = offset + character.len_utf8();
                    if source[quote_start..end].contains(['\r', '\n']) {
                        ranges.push((quote_start, end));
                    }
                    quote = None;
                }
            }
            escaped = false;
            continue;
        }
        match character {
            '#' if offset == 0
                || source[..offset]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_whitespace) =>
            {
                comment = true;
            }
            '"' | '\'' if quoted_scalar_can_start(source, offset) => {
                quote = Some(character);
                quote_start = offset;
            }
            _ => {}
        }
    }
    ranges
}

fn quoted_scalar_can_start(source: &str, offset: usize) -> bool {
    let line_start = source[..offset]
        .rfind(['\r', '\n'])
        .map_or(0, |newline| newline + 1);
    let prefix = &source[line_start..offset];
    if yaml_comment_start(prefix).is_some() {
        return false;
    }
    let node_start = prefix
        .char_indices()
        .rev()
        .find_map(|(position, character)| {
            matches!(character, ':' | ',' | '[' | '{' | '?').then_some(position + 1)
        })
        .unwrap_or(0);
    let candidate = prefix[node_start..].trim();
    if candidate.is_empty() || candidate == "-" {
        return true;
    }
    let (remainder, anchor, tag) = split_node_properties(candidate);
    remainder.is_empty() && (anchor.is_some() || tag.is_some())
}

fn standard_set_body_ranges(source: &str) -> Vec<(usize, usize)> {
    let spans = line_spans(source);
    spans
        .iter()
        .enumerate()
        .filter_map(|(line_index, span)| {
            let body = &source[span.start..span.content_end];
            let trimmed = body.trim_start_matches([' ', '\t']);
            let indent = body.len() - trimmed.len();
            let item = trimmed
                .strip_prefix("- ")
                .or_else(|| (trimmed == "-").then_some(""));
            let mapping_source = item.unwrap_or(trimmed);
            let value_source = if item.is_some() && mapping_key_colon(mapping_source).is_none() {
                mapping_source
            } else {
                let colon = mapping_key_colon(mapping_source)?;
                mapping_source[colon + 1..].trim_start()
            };
            let (remainder, _, tag_name) = split_node_properties(value_source);
            (tag_name == Some("set") && (remainder.is_empty() || remainder.starts_with('#'))).then(
                || {
                    (
                        span.end,
                        direct_block_node_end(source, &spans, line_index, indent),
                    )
                },
            )
        })
        .collect()
}

fn standard_set_tag_occurrences(source: &str) -> Vec<(usize, usize)> {
    let mut excluded_ranges = block_scalar_body_ranges(source);
    excluded_ranges.extend(multiline_quoted_scalar_ranges(source));
    normalize_ranges(&mut excluded_ranges);
    let mut occurrences = source
        .match_indices("!!set")
        .map(|(start, tag)| (start, start + tag.len()))
        .chain(
            source
                .match_indices("!<tag:yaml.org,2002:set>")
                .map(|(start, tag)| (start, start + tag.len())),
        )
        .filter(|(start, _)| {
            if sorted_range_contains(&excluded_ranges, *start) {
                return false;
            }
            let line_start = source[..*start]
                .rfind(['\r', '\n'])
                .map_or(0, |newline| newline + 1);
            let prefix = &source[line_start..*start];
            yaml_comment_start(prefix).is_none()
                && yaml_prefix_ends_outside_quotes(prefix)
                && yaml_node_property_position(source, *start)
        })
        .collect::<Vec<_>>();
    occurrences.sort_unstable();
    occurrences
}

fn invalid_flow_block_scalar_range(source: &str) -> Option<(usize, usize, char)> {
    let mut excluded_ranges = block_scalar_body_ranges(source);
    excluded_ranges.extend(multiline_quoted_scalar_ranges(source));
    normalize_ranges(&mut excluded_ranges);
    let mut flow_depth = 0usize;
    let mut value_start = 0usize;

    for span in line_spans(source) {
        let line = &source[span.start..span.content_end];
        let syntax_end = yaml_comment_start(line).unwrap_or(line.len());
        let syntax = &line[..syntax_end];
        let mut quote = None;
        let mut escaped = false;
        let mut characters = syntax.char_indices().peekable();
        while let Some((relative, character)) = characters.next() {
            let absolute = span.start + relative;
            if sorted_range_contains(&excluded_ranges, absolute) {
                continue;
            }
            if let Some(active_quote) = quote {
                if active_quote == '"' && character == '\\' && !escaped {
                    escaped = true;
                    continue;
                }
                if character == active_quote && !escaped {
                    if active_quote == '\''
                        && characters.peek().is_some_and(|(_, next)| *next == '\'')
                    {
                        characters.next();
                    } else {
                        quote = None;
                    }
                }
                escaped = false;
                continue;
            }
            match character {
                '"' | '\'' => quote = Some(character),
                '{' | '[' => {
                    flow_depth += 1;
                    value_start = absolute + character.len_utf8();
                }
                '}' | ']' => {
                    flow_depth = flow_depth.saturating_sub(1);
                    value_start = absolute + character.len_utf8();
                }
                ':' | ',' | '?' if flow_depth > 0 => {
                    value_start = absolute + character.len_utf8();
                }
                '|' | '>' if flow_depth > 0 => {
                    let candidate = source[value_start..absolute].trim_start();
                    let (remainder, _, _) = split_node_properties(candidate);
                    if remainder.is_empty() {
                        return Some((absolute, absolute + character.len_utf8(), character));
                    }
                }
                _ => {}
            }
        }
    }
    None
}

fn invalid_deferred_flow_property_key_range(source: &str) -> Option<(usize, usize)> {
    let excluded_ranges = block_scalar_body_ranges(source);
    let mut quote = None;
    let mut escaped = false;
    let mut comment = false;
    let mut flow_depth = 0usize;
    let mut line_start = 0usize;
    let mut previous_syntax_line: Option<String> = None;
    for (offset, character) in source.char_indices() {
        if sorted_range_contains(&excluded_ranges, offset) {
            continue;
        }
        if comment {
            if matches!(character, '\r' | '\n') {
                comment = false;
            } else {
                continue;
            }
        }
        if let Some(active_quote) = quote {
            if active_quote == '"' && character == '\\' && !escaped {
                escaped = true;
                continue;
            }
            if character == active_quote && !escaped {
                quote = None;
            }
            escaped = false;
            continue;
        }
        match character {
            '"' | '\'' => quote = Some(character),
            '#' if offset == line_start
                || source[line_start..offset]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_whitespace) =>
            {
                comment = true;
            }
            '[' | '{' => flow_depth += 1,
            ']' | '}' => flow_depth = flow_depth.saturating_sub(1),
            '?' if flow_depth > 0 && matches!(source[line_start..offset].trim(), "" | ",") => {
                if let Some(previous) = previous_syntax_line.as_deref() {
                    let property = previous
                        .char_indices()
                        .rev()
                        .find_map(|(position, character)| {
                            matches!(character, ':' | ',' | '[' | '{' | '?')
                                .then_some((position + character.len_utf8(), character))
                        })
                        .unwrap_or((0, '\0'));
                    if property.1 == ':' {
                        continue;
                    }
                    let property_start = property.0;
                    let node_source = previous[property_start..].trim();
                    let (remainder, anchor, tag) = split_node_properties(node_source);
                    if remainder.is_empty() && (anchor.is_some() || tag.is_some()) {
                        return Some((offset, one_character_end(source, offset, source.len())));
                    }
                }
            }
            '\r' | '\n' => {
                let syntax = yaml_comment_start(&source[line_start..offset])
                    .map_or(&source[line_start..offset], |comment| {
                        &source[line_start..line_start + comment]
                    })
                    .trim();
                if !syntax.is_empty() {
                    previous_syntax_line = Some(syntax.to_owned());
                }
                line_start = offset + character.len_utf8();
            }
            _ => {}
        }
    }
    None
}

fn missing_flow_map_comma_range(source: &str) -> Option<(usize, usize)> {
    let spans = line_spans(source);
    for (tag_start, tag_end) in standard_set_tag_occurrences(source) {
        let (line_index, span) = spans
            .iter()
            .enumerate()
            .find(|(_, span)| span.start <= tag_start && tag_start < span.content_end)?;
        let line = &source[span.start..span.content_end];
        let prefix = &line[..tag_start - span.start];
        let Some(open) = prefix.rfind('{') else {
            continue;
        };
        let Some(colon) = prefix.rfind(':') else {
            continue;
        };
        if colon < open || yaml_comment_start(prefix).is_some() {
            continue;
        }
        let after = &source[tag_end..span.content_end];
        if !after.trim().is_empty() && !after.trim_start().starts_with('#') {
            continue;
        }
        for candidate in spans.iter().skip(line_index + 1) {
            let body = &source[candidate.start..candidate.content_end];
            let trimmed = body.trim_start_matches([' ', '\t']);
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            let Some(member) = trimmed.strip_prefix("? ") else {
                break;
            };
            let leading = body.len() - trimmed.len();
            let member_leading = member.len() - member.trim_start().len();
            let start = candidate.start + leading + 2 + member_leading;
            return Some((start, one_character_end(source, start, source.len())));
        }
    }
    None
}

fn non_null_standard_set_value_range(source: &str) -> Option<(usize, usize)> {
    let spans = line_spans(source);
    for (tag_start, tag_end) in standard_set_tag_occurrences(source) {
        let span = spans
            .iter()
            .find(|span| span.start <= tag_start && tag_start < span.content_end)?;
        let line = &source[span.start..span.content_end];
        if yaml_comment_start(&line[..tag_start - span.start]).is_some() {
            continue;
        }
        let after_tag = line[tag_end - span.start..].trim_start();
        let (remainder, _, _) = split_node_properties(after_tag);
        if !remainder.starts_with('{') {
            continue;
        }
        let relative = line
            .find(remainder)
            .unwrap_or_else(|| line.len().saturating_sub(remainder.len()));
        let flow_start = span.start + relative;
        let flow_end = flow_value_end(source, flow_start);
        for (entry_start, entry_end) in top_level_flow_entries(source, flow_start, flow_end) {
            let entry = source[entry_start..entry_end].trim();
            let mapping = entry
                .strip_prefix('?')
                .map(str::trim_start)
                .unwrap_or(entry);
            let (member, _, tag_name) = split_node_properties(mapping);
            if member.starts_with(['{', '['])
                || matches!(tag_name, Some("set" | "map" | "seq" | "omap" | "pairs"))
            {
                continue;
            }
            if let Some(colon) = mapping_key_colon(mapping)
                && !semantic_null_set_member(mapping[colon + 1..].trim())
            {
                return Some((tag_start, tag_end));
            }
        }
    }
    None
}

fn semantic_null_set_member(member: &str) -> bool {
    let (remainder, _, tag_name) = split_node_properties(member);
    if tag_name == Some("null") {
        return matches!(
            remainder.to_ascii_lowercase().as_str(),
            "" | "~" | "null" | "\"\"" | "''"
        );
    }
    tag_name.is_none() && matches!(remainder.to_ascii_lowercase().as_str(), "" | "~" | "null")
}

fn plain_nonfinite_kind(source: &str) -> Option<&'static str> {
    let lower = source.to_ascii_lowercase();
    match lower.as_str() {
        ".nan" => Some("nan"),
        ".inf" | "+.inf" => Some("inf"),
        "-.inf" => Some("-inf"),
        _ if lower.contains('e')
            && lower.chars().all(|character| {
                character.is_ascii_digit() || matches!(character, '+' | '-' | '.' | 'e')
            }) =>
        {
            lower
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_infinite())
                .map(|value| {
                    if value.is_sign_negative() {
                        "-inf"
                    } else {
                        "inf"
                    }
                })
        }
        _ => None,
    }
}

fn contains_untagged_nonfinite_number(source: &str) -> bool {
    let mut excluded_ranges = block_scalar_body_ranges(source);
    excluded_ranges.extend(multiline_quoted_scalar_ranges(source));
    normalize_ranges(&mut excluded_ranges);
    for span in line_spans(source) {
        let line = &source[span.start..span.content_end];
        let syntax = yaml_comment_start(line).map_or(line, |comment| &line[..comment]);
        let mut quote = None;
        let mut escaped = false;
        for (offset, character) in syntax.char_indices() {
            let absolute = span.start + offset;
            if sorted_range_contains(&excluded_ranges, absolute) {
                continue;
            }
            if let Some(active_quote) = quote {
                if active_quote == '"' && character == '\\' && !escaped {
                    escaped = true;
                    continue;
                }
                if character == active_quote && !escaped {
                    quote = None;
                }
                escaped = false;
                continue;
            }
            if matches!(character, '"' | '\'') {
                quote = Some(character);
                continue;
            }
            if !character.is_ascii_digit() && character != '.' && !matches!(character, '+' | '-') {
                continue;
            }
            let candidate = &syntax[offset..];
            let token_length = candidate
                .find(|value: char| {
                    value.is_whitespace() || matches!(value, ',' | ']' | '}' | ':' | '#')
                })
                .unwrap_or(candidate.len());
            let Some(token) = candidate.get(..token_length) else {
                continue;
            };
            if plain_nonfinite_kind(token).is_none() {
                continue;
            }
            let before = syntax[..offset].chars().next_back();
            let after = syntax[offset + token_length..].chars().next();
            let valid_before = before.is_none_or(|value| {
                value.is_whitespace() || matches!(value, '[' | '{' | ',' | ':' | '?')
            });
            let valid_after = after.is_none_or(|value| {
                value.is_whitespace() || matches!(value, ']' | '}' | ',' | ':' | '#')
            });
            if !valid_before || !valid_after {
                continue;
            }
            let prefix = syntax[..offset].trim_end();
            let property_start = prefix
                .char_indices()
                .rev()
                .find_map(|(index, value)| {
                    matches!(value, '[' | '{' | ',' | ':' | '?').then_some(index + 1)
                })
                .unwrap_or(0);
            let (property_remainder, anchor_name, tag_name) =
                split_node_properties(prefix[property_start..].trim_start());
            if tag_name.is_some()
                || prefix.contains("!<tag:yaml.org,2002:")
                || ((prefix.trim().is_empty()
                    || (property_remainder.is_empty() && anchor_name.is_some()))
                    && deferred_standard_tag_name(source, &line_spans(source), span.start)
                        .as_deref()
                        == Some("float"))
            {
                continue;
            }
            return true;
        }
    }
    false
}

fn deferred_standard_tag_name(
    source: &str,
    spans: &[LineSpan],
    current_start: usize,
) -> Option<String> {
    let line_index = spans.iter().position(|span| span.start == current_start)?;
    for previous in spans[..line_index].iter().rev().filter(|span| {
        let body = &source[span.start..span.content_end];
        let trimmed = body.trim();
        !trimmed.is_empty() && !trimmed.starts_with('#')
    }) {
        let body = &source[previous.start..previous.content_end];
        let syntax = yaml_comment_start(body).map_or(body, |comment| &body[..comment]);
        let trimmed = syntax.trim();
        let node_source = if let Some(item) = trimmed.strip_prefix("- ") {
            if let Some(colon) = mapping_key_colon(item) {
                item[colon + 1..].trim_start()
            } else {
                item
            }
        } else if let Some(colon) = mapping_key_colon(trimmed) {
            trimmed[colon + 1..].trim_start()
        } else {
            trimmed
                .strip_prefix('?')
                .map(str::trim_start)
                .unwrap_or(trimmed)
        };
        let node_source = node_source
            .strip_prefix('?')
            .map(str::trim_start)
            .unwrap_or(node_source);
        let (remainder, anchor, tag) = split_node_properties(node_source);
        if !(remainder.is_empty() || remainder.starts_with('#')) {
            return None;
        }
        if let Some(tag) = tag {
            return Some(tag.to_owned());
        }
        anchor.as_ref()?;
    }
    None
}

fn decimal_from_radix(digits: &str, radix: u32) -> Option<String> {
    const DECIMAL_LIMB_BASE: u64 = 1_000_000_000;
    let mut decimal = vec![0_u32];
    let chunk_digits = match radix {
        16 => 8,
        8 => 11,
        _ => 1,
    };
    let mut cursor = 0usize;
    while cursor < digits.len() {
        let remaining = digits.len() - cursor;
        let width = if cursor == 0 {
            let leading = remaining % chunk_digits;
            if leading == 0 { chunk_digits } else { leading }
        } else {
            chunk_digits.min(remaining)
        };
        let mut chunk = 0_u64;
        for character in digits[cursor..cursor + width].chars() {
            chunk = chunk
                .checked_mul(u64::from(radix))?
                .checked_add(u64::from(character.to_digit(radix)?))?;
        }
        let factor = u64::from(radix).checked_pow(width as u32)?;
        let mut carry = chunk;
        for value in &mut decimal {
            let product = u64::from(*value) * factor + carry;
            *value = (product % DECIMAL_LIMB_BASE) as u32;
            carry = product / DECIMAL_LIMB_BASE;
        }
        while carry > 0 {
            decimal.push((carry % DECIMAL_LIMB_BASE) as u32);
            carry /= DECIMAL_LIMB_BASE;
        }
        cursor += width;
    }
    while decimal.len() > 1 && decimal.last() == Some(&0) {
        decimal.pop();
    }
    let mut limbs = decimal.into_iter().rev();
    let mut value = limbs.next().unwrap_or_default().to_string();
    for limb in limbs {
        use std::fmt::Write as _;
        write!(value, "{limb:09}").expect("writing to a string cannot fail");
    }
    Some(value)
}

fn yaml_schema_integer_string(source: &str) -> bool {
    let unsigned = source.strip_prefix(['+', '-']).unwrap_or(source);
    let lower = unsigned.to_ascii_lowercase();
    lower.starts_with("0b")
        || unsigned.starts_with("0X")
        || unsigned.starts_with("0O")
        || unsigned.starts_with("0B")
        || (source.starts_with(['+', '-']) && (lower.starts_with("0x") || lower.starts_with("0o")))
}

fn canonical_set_integer(source: &str, _explicitly_tagged: bool) -> Option<String> {
    let scalar = source.to_owned();
    if scalar.contains('_') {
        return None;
    }
    let (negative, unsigned) = scalar
        .strip_prefix('-')
        .map_or((false, scalar.as_str()), |value| (true, value));
    let signed = negative || scalar.starts_with('+');
    let unsigned = unsigned.strip_prefix('+').unwrap_or(unsigned);
    let digits = if let Some(value) = unsigned.strip_prefix("0x") {
        if signed {
            return None;
        }
        decimal_from_radix(value, 16)?
    } else if let Some(value) = unsigned.strip_prefix("0o") {
        if signed {
            return None;
        }
        decimal_from_radix(value, 8)?
    } else if !unsigned.is_empty() && unsigned.chars().all(|character| character.is_ascii_digit()) {
        unsigned.trim_start_matches('0').to_owned()
    } else {
        return None;
    };
    let digits = if digits.is_empty() {
        "0".to_owned()
    } else {
        digits
    };
    Some(if negative && digits != "0" {
        format!("-{digits}")
    } else {
        digits
    })
}

fn semantic_set_member_key(member: &str) -> Option<Value> {
    if member.trim_start().starts_with('*') {
        return None;
    }
    let (remainder, _, tag_name) = split_node_properties(member);
    if matches!(remainder.trim_start().chars().next(), Some('[' | '{'))
        || tag_name.is_some_and(|tag| {
            matches!(
                tag,
                "map" | "seq" | "set" | "omap" | "pairs" | "timestamp" | "binary"
            )
        })
    {
        return None;
    }
    let scalar = remainder.trim();
    if tag_name == Some("str") && scalar.is_empty() {
        return Some(Value::String(String::new()));
    }
    if tag_name.is_none() {
        match plain_nonfinite_kind(scalar) {
            Some("inf") => return Some(Value::String("\u{0}okf-float:inf".to_owned())),
            Some("-inf") => return Some(Value::String("\u{0}okf-float:-inf".to_owned())),
            Some("nan") => return None,
            _ => {}
        }
    }
    let integer_source =
        if tag_name == Some("int") && matches!(scalar.chars().next(), Some('"' | '\'')) {
            serde_yaml::from_str::<String>(scalar).ok()
        } else {
            Some(scalar.to_owned())
        };
    if (tag_name.is_none() || tag_name == Some("int"))
        && let Some(canonical) = integer_source
            .as_deref()
            .and_then(|value| canonical_set_integer(value, tag_name == Some("int")))
    {
        return Some(Value::String(format!("\u{0}okf-int:{canonical}")));
    }
    let synthetic = format!("value: {member}");
    let parser_source = mask_large_yaml_integers(&mask_invalid_standard_scalar_tags(&synthetic));
    let parsed = serde_yaml::from_str::<serde_yaml::Value>(&parser_source).ok()?;
    let converted = yaml_to_json(parsed).ok()?.get("value")?.clone();
    let semantic = converted
        .get(TAGGED_KEY)
        .and_then(Value::as_object)
        .and_then(|tagged| tagged.get("value"))
        .cloned()
        .unwrap_or(converted);
    Some(value_without_tag_sources(&semantic))
}

fn dedent_yaml_continuation(source: &str, indent: usize) -> String {
    source
        .split_inclusive('\n')
        .enumerate()
        .map(|(index, line)| {
            if index == 0 {
                return line;
            }
            let remove = line
                .bytes()
                .take(indent)
                .take_while(|byte| *byte == b' ')
                .count();
            &line[remove..]
        })
        .collect()
}

fn duplicate_flow_set_member_range(source: &str) -> Option<(usize, usize)> {
    let spans = line_spans(source);
    for (tag_start, tag_end) in standard_set_tag_occurrences(source) {
        let span = spans
            .iter()
            .find(|span| span.start <= tag_start && tag_start < span.content_end)?;
        let line = &source[span.start..span.content_end];
        let after_tag = line[tag_end - span.start..].trim_start();
        let (remainder, _, _) = split_node_properties(after_tag);
        if !remainder.starts_with('{') {
            continue;
        }
        let relative = line
            .find(remainder)
            .unwrap_or_else(|| line.len().saturating_sub(remainder.len()));
        let flow_start = span.start + relative;
        let flow_end = flow_value_end(source, flow_start);
        let entries = top_level_flow_entries(source, flow_start, flow_end);
        if entries.len() < 2 {
            continue;
        }
        let mut seen = Vec::<Value>::new();
        for (entry_start, entry_end) in entries {
            let entry_source = &source[entry_start..entry_end];
            let leading = entry_source.len() - entry_source.trim_start().len();
            let entry = entry_source.trim();
            let (member, member_start) = if let Some(after_question) = entry.strip_prefix('?') {
                let question_gap = after_question.len() - after_question.trim_start().len();
                (
                    after_question.trim_start(),
                    entry_start + leading + 1 + question_gap,
                )
            } else {
                (entry, entry_start + leading)
            };
            let Some(semantic) = semantic_set_member_key(member) else {
                continue;
            };
            if seen.contains(&semantic) {
                if member.is_empty() {
                    return Some((
                        entry_end,
                        one_character_end(source, entry_end, source.len()),
                    ));
                }
                let (remainder, _, tag_name) = split_node_properties(member);
                if remainder.is_empty() {
                    return Some((
                        entry_end,
                        one_character_end(source, entry_end, source.len()),
                    ));
                }
                let value_offset = if tag_name.is_some() {
                    member.len().saturating_sub(remainder.len())
                } else {
                    0
                };
                let start = member_start + value_offset;
                return Some((start, one_character_end(source, start, source.len())));
            }
            seen.push(semantic);
        }
    }
    None
}

fn duplicate_block_set_member_range(source: &str) -> Option<(usize, usize)> {
    if let Some(range) = duplicate_flow_set_member_range(source) {
        return Some(range);
    }
    let spans = line_spans(source);
    for (line_index, span) in spans.iter().enumerate() {
        let body = &source[span.start..span.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        let parent_indent = body.len() - trimmed.len();
        let mapping_source = trimmed
            .strip_prefix("- ")
            .or_else(|| (trimmed == "-").then_some(""))
            .unwrap_or(trimmed);
        let node_source = if (trimmed == "-" || trimmed.starts_with("- "))
            && mapping_key_colon(mapping_source).is_none()
        {
            mapping_source
        } else if let Some(member) = mapping_source.strip_prefix('?').and_then(|rest| {
            (rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace))
                .then(|| rest.trim_start())
        }) {
            member
        } else {
            let Some(colon) = mapping_key_colon(mapping_source) else {
                continue;
            };
            mapping_source[colon + 1..].trim_start()
        };
        let (remainder, _, tag_name) = split_node_properties(node_source);
        if tag_name != Some("set") || !(remainder.is_empty() || remainder.starts_with('#')) {
            continue;
        }
        let block_end = direct_block_node_end(source, &spans, line_index, parent_indent);
        let member_indent = spans
            .iter()
            .skip(line_index + 1)
            .take_while(|candidate| candidate.start < block_end)
            .find_map(|candidate| {
                let body = &source[candidate.start..candidate.content_end];
                let trimmed = body.trim_start_matches([' ', '\t']);
                (!trimmed.is_empty() && !trimmed.starts_with('#'))
                    .then_some(body.len() - trimmed.len())
            });
        let Some(member_indent) = member_indent else {
            continue;
        };
        let mut seen = Vec::<Value>::new();
        for (candidate_index, candidate) in spans
            .iter()
            .enumerate()
            .skip(line_index + 1)
            .take_while(|(_, candidate)| candidate.start < block_end)
        {
            let candidate_body = &source[candidate.start..candidate.content_end];
            let candidate_trimmed = candidate_body.trim_start_matches([' ', '\t']);
            let indent = candidate_body.len() - candidate_trimmed.len();
            if indent != member_indent {
                continue;
            }
            let syntax = yaml_comment_start(candidate_trimmed)
                .map_or(candidate_trimmed, |comment| &candidate_trimmed[..comment])
                .trim();
            let Some(after_question) = syntax.strip_prefix('?') else {
                continue;
            };
            let leading = after_question.len() - after_question.trim_start().len();
            let member = after_question.trim_start();
            let (remainder, _, _) = split_node_properties(member);
            let member_start = candidate.start
                + indent
                + syntax.len().saturating_sub(after_question.len())
                + leading;
            let deferred = remainder
                .is_empty()
                .then(|| {
                    spans
                        .iter()
                        .skip(candidate_index + 1)
                        .take_while(|nested| nested.start < block_end)
                        .find_map(|nested| {
                            let nested_body = &source[nested.start..nested.content_end];
                            let nested_trimmed = nested_body.trim_start_matches([' ', '\t']);
                            let nested_indent = nested_body.len() - nested_trimmed.len();
                            (!nested_trimmed.is_empty() && nested_indent > member_indent)
                                .then_some((nested_trimmed, nested.start + nested_indent))
                        })
                })
                .flatten();
            if deferred.is_some_and(|(value, _)| {
                let value = value.trim_start();
                value.starts_with(['[', '{', '-']) || mapping_key_colon(value).is_some()
            }) {
                continue;
            }
            let semantic_source = if let Some((value, _)) = deferred {
                format!("{member} {value}")
            } else if matches!(remainder.chars().next(), Some('"' | '\'')) {
                let relative_value = member.len().saturating_sub(remainder.len());
                let scalar_start = member_start + relative_value;
                format!(
                    "{}{}",
                    &member[..relative_value],
                    scalar_lexical_source(&source[scalar_start..block_end])
                )
            } else if matches!(remainder.chars().next(), Some('|' | '>')) {
                let relative_value = member.len().saturating_sub(remainder.len());
                let scalar_start = member_start + relative_value;
                let scalar_end = spans
                    .iter()
                    .skip(candidate_index + 1)
                    .take_while(|nested| nested.start < block_end)
                    .find_map(|nested| {
                        let body = &source[nested.start..nested.content_end];
                        let trimmed = body.trim_start_matches([' ', '\t']);
                        let indent = body.len() - trimmed.len();
                        (indent == member_indent && trimmed.starts_with('?'))
                            .then_some(nested.start)
                    })
                    .unwrap_or(block_end);
                format!(
                    "{}{}",
                    &member[..relative_value],
                    dedent_yaml_continuation(&source[scalar_start..scalar_end], member_indent,)
                )
            } else {
                member.to_owned()
            };
            let Some(semantic) = semantic_set_member_key(&semantic_source) else {
                continue;
            };
            if seen.contains(&semantic) {
                if member.is_empty() && deferred.is_none() {
                    return Some((block_end, block_end + 1));
                }
                if remainder.is_empty() && deferred.is_none() {
                    return Some((candidate.end, candidate.end + 1));
                }
                let (_, _, tag_name) = split_node_properties(member);
                let relative_value = if tag_name.is_some() {
                    member.len().saturating_sub(remainder.len())
                } else {
                    0
                };
                let start = deferred.map_or(member_start + relative_value, |(_, start)| start);
                return Some((start, one_character_end(source, start, source.len())));
            }
            seen.push(semantic);
        }
    }
    None
}

fn standard_flow_set_ranges(source: &str) -> Vec<(usize, usize)> {
    let mut ranges = flow_collection_ranges(source)
        .into_iter()
        .filter(|(opening, _)| {
            if !source[*opening..].starts_with('{') {
                return false;
            }
            let prefix = source[..*opening].trim_end();
            let line_start = prefix.rfind(['\r', '\n']).map_or(0, |newline| newline + 1);
            let line_prefix = &prefix[line_start..];
            let node_start = line_prefix
                .char_indices()
                .rev()
                .find_map(|(position, character)| {
                    matches!(character, ':' | ',' | '[' | '{' | '?').then_some(position + 1)
                })
                .unwrap_or(0);
            let node_source = line_prefix[node_start..]
                .trim()
                .strip_prefix("- ")
                .unwrap_or(line_prefix[node_start..].trim());
            let (_, _, tag_name) = split_node_properties(node_source);
            tag_name == Some("set")
        })
        .collect::<Vec<_>>();
    normalize_ranges(&mut ranges);
    ranges
}

fn radix_set_output_lower_bound_exceeded(source: &str) -> bool {
    standard_flow_set_ranges(source)
        .into_iter()
        .any(|(flow_start, flow_end)| {
            let set_source_units = source[flow_start..flow_end].encode_utf16().count();
            top_level_flow_entries(source, flow_start, flow_end)
                .into_iter()
                .filter_map(|(entry_start, entry_end)| {
                    let entry = source[entry_start..entry_end].trim();
                    let member = entry
                        .strip_prefix('?')
                        .map(str::trim_start)
                        .unwrap_or(entry);
                    let (lexical, _, tag) = standard_set_member_properties(member);
                    if tag.is_some_and(|name| name != "int") {
                        return None;
                    }
                    let scalar = lexical.trim();
                    let (digits, bits_per_digit, radix) = scalar
                        .strip_prefix("0x")
                        .map(|digits| (digits, 4usize, 16u32))
                        .or_else(|| {
                            scalar
                                .strip_prefix("0o")
                                .map(|digits| (digits, 3usize, 8u32))
                        })?;
                    if digits.is_empty()
                        || !digits.chars().all(|character| character.is_digit(radix))
                    {
                        return None;
                    }
                    let significant = digits.trim_start_matches('0');
                    if significant.is_empty() {
                        return Some(1usize);
                    }
                    let first = significant.chars().next()?.to_digit(radix)?;
                    let first_bits = (u32::BITS - first.leading_zeros()) as usize;
                    let bit_length = (significant.len() - 1)
                        .saturating_mul(bits_per_digit)
                        .saturating_add(first_bits);
                    Some(bit_length.saturating_sub(1).saturating_mul(30_102) / 100_000 + 1)
                })
                .any(|decimal_units| {
                    set_source_units.saturating_add(decimal_units) > MAX_FRONTMATTER_OUTPUT_UNITS
                })
        })
}

fn parent_collection_tag_flags(source: &str, spans: &[LineSpan]) -> Vec<Option<bool>> {
    let mut parents = vec![None; spans.len()];
    let mut stack = Vec::<(usize, bool)>::new();
    for (line_index, line) in spans.iter().enumerate() {
        let body = &source[line.start..line.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = body.len() - trimmed.len();
        while stack
            .last()
            .is_some_and(|(parent_indent, _)| *parent_indent >= indent)
        {
            stack.pop();
        }
        parents[line_index] = stack.last().map(|(_, collection)| *collection);
        let mapping_source = trimmed
            .strip_prefix("- ")
            .or_else(|| (trimmed == "-").then_some(""))
            .unwrap_or(trimmed);
        let value_source = mapping_key_colon(mapping_source)
            .map(|colon| mapping_source[colon + 1..].trim_start())
            .unwrap_or(mapping_source);
        let collection = split_node_properties(value_source)
            .2
            .is_some_and(|tag| matches!(tag, "map" | "seq" | "set" | "omap" | "pairs"));
        stack.push((indent, collection));
    }
    parents
}

fn alias_mapping_key_range(
    source: &str,
    excluded_ranges: &[(usize, usize)],
) -> Option<(usize, usize)> {
    let standard_flow_set_ranges = standard_flow_set_ranges(source);
    let mut quote = None;
    let mut escaped = false;
    let mut comment = false;
    let mut characters = source.char_indices().peekable();
    while let Some((offset, character)) = characters.next() {
        if sorted_range_contains(excluded_ranges, offset) {
            continue;
        }
        if comment {
            if matches!(character, '\r' | '\n') {
                comment = false;
            }
            continue;
        }
        if let Some(active_quote) = quote {
            if active_quote == '"' && character == '\\' && !escaped {
                escaped = true;
                continue;
            }
            if character == active_quote && !escaped {
                if active_quote == '\'' && characters.peek().is_some_and(|(_, next)| *next == '\'')
                {
                    characters.next();
                } else {
                    quote = None;
                }
            }
            escaped = false;
            continue;
        }
        match character {
            '#' if offset == 0
                || source[..offset]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_whitespace) =>
            {
                comment = true;
            }
            '"' | '\'' => quote = Some(character),
            '?' => {
                let line_start = source[..offset]
                    .rfind(['\r', '\n'])
                    .map_or(0, |newline| newline + 1);
                let line_prefix = &source[line_start..offset];
                let previous = source[..offset]
                    .chars()
                    .rev()
                    .find(|character| !character.is_whitespace());
                let flow_explicit_key =
                    previous.is_some_and(|character| matches!(character, '{' | ','));
                let starts_explicit_key = line_prefix.trim().is_empty()
                    || line_prefix.trim_end().ends_with('-')
                    || flow_explicit_key;
                if !starts_explicit_key {
                    continue;
                }
                let mut cursor = offset + 1;
                cursor += source[cursor..].len() - source[cursor..].trim_start().len();
                if !source[cursor..].starts_with('*') {
                    continue;
                }
                let alias_start = cursor;
                cursor += 1;
                while let Some(next) = source[cursor..].chars().next() {
                    if next.is_whitespace() || matches!(next, ':' | ',' | '}' | ']') {
                        break;
                    }
                    cursor += next.len_utf8();
                }
                let alias_end = cursor;
                let standard_set_member = sorted_range_contains(&standard_flow_set_ranges, offset)
                    || direct_standard_flow_set_member(source, offset);
                if flow_explicit_key && !standard_set_member {
                    return Some((alias_start, alias_end));
                }
                while source[cursor..].starts_with([' ', '\t']) {
                    cursor += 1;
                }
                if source[cursor..].starts_with('#') {
                    cursor += source[cursor..]
                        .find(['\r', '\n'])
                        .unwrap_or(source.len() - cursor);
                }
                while source[cursor..]
                    .chars()
                    .next()
                    .is_some_and(char::is_whitespace)
                {
                    cursor += source[cursor..].chars().next().map_or(0, char::len_utf8);
                }
                if source[cursor..].starts_with(':') {
                    return Some((alias_start, alias_end));
                }
            }
            '*' => {
                let line_start = source[..offset]
                    .rfind(['\r', '\n'])
                    .map_or(0, |newline| newline + 1);
                let starts_block_key = source[line_start..offset].chars().all(char::is_whitespace);
                let previous = source[..offset]
                    .chars()
                    .rev()
                    .find(|character| !character.is_whitespace());
                if !starts_block_key
                    && previous.is_some_and(|character| !matches!(character, '{' | '[' | ','))
                {
                    continue;
                }
                let alias_start = offset;
                let mut cursor = offset + 1;
                while let Some(next) = source[cursor..].chars().next() {
                    if next.is_whitespace() || matches!(next, ':' | ',' | '}' | ']') {
                        break;
                    }
                    cursor += next.len_utf8();
                }
                let alias_end = cursor;
                while source[cursor..].starts_with([' ', '\t']) {
                    cursor += 1;
                }
                if source[cursor..].starts_with(':') {
                    return Some((alias_start, alias_end));
                }
            }
            _ => {}
        }
    }
    None
}

fn direct_standard_flow_set_member(source: &str, offset: usize) -> bool {
    let Some(opening) = source[..offset].rfind('{') else {
        return false;
    };
    let prefix = source[..opening].trim_end();
    let line_start = prefix.rfind(['\r', '\n']).map_or(0, |newline| newline + 1);
    let line_prefix = &prefix[line_start..];
    let node_start = line_prefix
        .char_indices()
        .rev()
        .find_map(|(position, character)| {
            matches!(character, ':' | ',' | '[' | '{' | '?').then_some(position + 1)
        })
        .unwrap_or(0);
    let node_source = line_prefix[node_start..]
        .trim()
        .strip_prefix("- ")
        .unwrap_or(line_prefix[node_start..].trim());
    split_node_properties(node_source).2 == Some("set")
}

fn duplicate_mapping_key_range(source: &str) -> Option<(usize, usize)> {
    duplicate_mapping_key_range_with_mode(source, false)
}

fn duplicate_semantic_tagged_mapping_key_range(source: &str) -> Option<(usize, usize)> {
    duplicate_mapping_key_range_with_mode(source, true)
}

fn duplicate_mapping_key_range_with_mode(
    source: &str,
    semantic_tagged_only: bool,
) -> Option<(usize, usize)> {
    if let Some(range) = duplicate_flow_mapping_key_range_anywhere(source) {
        return Some(range);
    }
    let mut keys = std::collections::BTreeMap::new();
    let mut containers: Vec<(usize, String, bool)> = Vec::new();
    let mut sequence_indices: std::collections::BTreeMap<String, usize> =
        std::collections::BTreeMap::new();
    let spans = line_spans(source);
    let mut block_scalar_ranges = block_scalar_body_ranges(source);
    block_scalar_ranges.extend(multiline_quoted_scalar_ranges(source));
    block_scalar_ranges.extend(flow_collection_ranges(source));
    normalize_ranges(&mut block_scalar_ranges);
    let mut standard_set_ranges = standard_set_body_ranges(source);
    normalize_ranges(&mut standard_set_ranges);
    for (line_index, line) in spans.iter().enumerate() {
        if sorted_range_contains(&block_scalar_ranges, line.start) {
            continue;
        }
        let body = &source[line.start..line.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = body.len() - trimmed.len();
        let item = trimmed
            .strip_prefix("- ")
            .or_else(|| (trimmed == "-").then_some(""));
        while containers
            .last()
            .is_some_and(|(container_indent, _, sequence_item)| {
                *container_indent > indent
                    || (*container_indent == indent && (*sequence_item || item.is_none()))
            })
        {
            containers.pop();
        }
        let mapping_source = if let Some(item) = item {
            let sequence_key = format!(
                "{indent}/{}",
                containers
                    .iter()
                    .map(|(_, segment, _)| segment.as_str())
                    .collect::<Vec<_>>()
                    .join("/")
            );
            let index = sequence_indices.entry(sequence_key).or_default();
            containers.push((indent, index.to_string(), true));
            *index += 1;
            item
        } else {
            trimmed
        };
        if sorted_range_contains(&standard_set_ranges, line.start)
            && mapping_source.strip_prefix('?').is_some_and(|rest| {
                rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
            })
        {
            continue;
        }
        if let Some(_explicit_key) = mapping_source.strip_prefix('?').and_then(|source| {
            (source.is_empty() || source.chars().next().is_some_and(char::is_whitespace))
                .then_some(source.trim_start())
        }) {
            let key_start =
                explicit_key_source_start(source, &spans, line_index, body, mapping_source);
            let expected_value_indent = indent + if item.is_some() { 2 } else { 0 };
            let key_end = spans
                .iter()
                .skip(line_index + 1)
                .find_map(|candidate| {
                    let candidate_body = &source[candidate.start..candidate.content_end];
                    let candidate_trimmed = candidate_body.trim_start_matches([' ', '\t']);
                    let candidate_indent = candidate_body.len() - candidate_trimmed.len();
                    (candidate_indent == expected_value_indent
                        && candidate_trimmed.strip_prefix(':').is_some_and(|rest| {
                            rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
                        }))
                    .then_some(candidate.start)
                })
                .unwrap_or(line.content_end);
            if key_start > key_end {
                continue;
            }
            let key_source = source[key_start..key_end].trim_end_matches(['\r', '\n']);
            let Some((plain_key_source, scalar_relative, _, key_tag)) =
                multiline_mapping_key_parts(key_source)
            else {
                continue;
            };
            let scalar = scalar_lexical_source(plain_key_source);
            let Some(key) = parsed_string_mapping_key(scalar, key_tag) else {
                continue;
            };
            let semantic_tagged = key_tag
                .is_some_and(|tag| standard_tagged_key_has_string_semantic(plain_key_source, tag));
            let scope = containers
                .iter()
                .map(|(_, segment, _)| segment.clone())
                .collect::<Vec<_>>();
            if let Some(previous_tagged) = keys.insert((scope, key), semantic_tagged) {
                if semantic_tagged_only && !previous_tagged && !semantic_tagged {
                    continue;
                }
                if scalar.is_empty() {
                    let marker = key_end + expected_value_indent;
                    return Some((marker, one_character_end(source, marker, source.len())));
                }
                let scalar_start = key_start + scalar_relative;
                return Some((
                    scalar_start,
                    one_character_end(source, scalar_start, key_end),
                ));
            }
            continue;
        }
        let Some(colon) = mapping_key_colon(mapping_source) else {
            continue;
        };
        let key_source = mapping_source[..colon].trim_end_matches([' ', '\t']);
        let (plain_key_source, _, key_tag) = split_node_properties(key_source);
        let Some(key) = parsed_string_mapping_key(plain_key_source, key_tag) else {
            continue;
        };
        let semantic_tagged = key_tag
            .is_some_and(|tag| standard_tagged_key_has_string_semantic(plain_key_source, tag));
        let scope = containers
            .iter()
            .map(|(_, segment, _)| segment.clone())
            .collect::<Vec<_>>();
        if let Some(previous_tagged) = keys.insert((scope, key.clone()), semantic_tagged) {
            if semantic_tagged_only && !previous_tagged && !semantic_tagged {
                continue;
            }
            let key_source_start = line.start
                + body
                    .find(mapping_source)
                    .unwrap_or_else(|| body.len().saturating_sub(mapping_source.len()));
            let scalar_start =
                key_source_start + key_source.len().saturating_sub(plain_key_source.len());
            return Some((
                scalar_start,
                one_character_end(source, scalar_start, line.content_end),
            ));
        }
        let value_source = mapping_source[colon + 1..].trim();
        let (value_remainder, value_anchor, value_tag) = split_node_properties(value_source);
        if value_source.is_empty()
            || ((value_remainder.is_empty() || value_remainder.starts_with('#'))
                && (value_anchor.is_some() || value_tag.is_some()))
        {
            containers.push((indent + usize::from(item.is_some()), key, false));
        }
    }
    None
}

fn duplicate_standard_set_map_key_range(source: &str) -> Option<(usize, usize)> {
    let spans = line_spans(source);
    for (set_start, set_end) in standard_set_body_ranges(source) {
        let Some(member_indent) = spans
            .iter()
            .filter(|span| set_start <= span.start && span.start < set_end)
            .filter_map(|span| {
                let body = &source[span.start..span.content_end];
                let trimmed = body.trim_start_matches([' ', '\t']);
                trimmed
                    .strip_prefix('?')
                    .filter(|rest| {
                        rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
                    })
                    .map(|_| body.len() - trimmed.len())
            })
            .min()
        else {
            continue;
        };
        for (line_index, line) in spans.iter().enumerate() {
            if line.start < set_start || line.start >= set_end {
                continue;
            }
            let body = &source[line.start..line.content_end];
            let trimmed = body.trim_start_matches([' ', '\t']);
            if body.len() - trimmed.len() != member_indent {
                continue;
            }
            let Some(member) = trimmed.strip_prefix('?').and_then(|rest| {
                (rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace))
                    .then_some(rest.trim_start())
            }) else {
                continue;
            };
            let syntax = yaml_comment_start(member)
                .map_or(member, |comment| &member[..comment])
                .trim_end();
            let (remainder, _, tag_name) = split_node_properties(syntax);
            if tag_name != Some("map") || !remainder.is_empty() {
                continue;
            }
            let block_end = direct_block_node_end(source, &spans, line_index, member_indent);
            let block_start = line.end.min(block_end);
            if let Some((start, end)) = duplicate_mapping_key_range(&source[block_start..block_end])
            {
                return Some((block_start + start, block_start + end));
            }
        }
    }
    None
}

fn duplicate_flow_mapping_key_range_anywhere(source: &str) -> Option<(usize, usize)> {
    let block_scalar_ranges = block_scalar_body_ranges(source);
    let mut quote = None;
    let mut escaped = false;
    let mut comment = false;
    let mut characters = source.char_indices().peekable();
    while let Some((offset, character)) = characters.next() {
        if sorted_range_contains(&block_scalar_ranges, offset) {
            continue;
        }
        if comment {
            if matches!(character, '\r' | '\n') {
                comment = false;
            }
            continue;
        }
        if let Some(active_quote) = quote {
            if active_quote == '"' && character == '\\' && !escaped {
                escaped = true;
                continue;
            }
            if character == active_quote && !escaped {
                if active_quote == '\'' && characters.peek().is_some_and(|(_, next)| *next == '\'')
                {
                    characters.next();
                } else {
                    quote = None;
                }
            }
            escaped = false;
            continue;
        }
        match character {
            '#' if offset == 0
                || source[..offset]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_whitespace) =>
            {
                comment = true;
            }
            '"' | '\'' => quote = Some(character),
            '{' => {
                if let Some(range) = duplicate_flow_mapping_key_range(source, offset) {
                    return Some(range);
                }
            }
            _ => {}
        }
    }
    None
}

fn block_scalar_body_ranges(source: &str) -> Vec<(usize, usize)> {
    let spans = line_spans(source);
    spans
        .iter()
        .enumerate()
        .filter_map(|(line_index, span)| {
            let body = &source[span.start..span.content_end];
            let trimmed = body.trim_start_matches([' ', '\t']);
            let indent = body.len() - trimmed.len();
            let mapping_source = trimmed
                .strip_prefix("- ")
                .or_else(|| (trimmed == "-").then_some(""))
                .unwrap_or(trimmed);
            let explicit_key_source = mapping_source.strip_prefix('?').and_then(|source| {
                (source.is_empty() || source.chars().next().is_some_and(char::is_whitespace))
                    .then_some(source.trim_start())
            });
            let value_source = if explicit_key_source
                .and_then(block_scalar_indicator)
                .is_some()
            {
                explicit_key_source.unwrap_or_default()
            } else if block_scalar_indicator(mapping_source).is_some() {
                mapping_source
            } else {
                let colon = mapping_key_colon(mapping_source)
                    .or_else(|| mapping_source.starts_with(':').then_some(0))?;
                mapping_source[colon + 1..].trim_start()
            };
            let indicator = block_scalar_indicator(value_source)?;
            let explicit_indent = indicator
                .chars()
                .skip(1)
                .find_map(|character| character.to_digit(10))
                .map(|value| value as usize);
            let inferred_indent = spans
                .iter()
                .skip(line_index + 1)
                .find_map(|candidate| {
                    let body = &source[candidate.start..candidate.content_end];
                    let trimmed = body.trim_start_matches([' ', '\t']);
                    if trimmed.is_empty() || trimmed.starts_with('#') {
                        return None;
                    }
                    let candidate_indent = body.len() - trimmed.len();
                    (candidate_indent > indent).then_some(candidate_indent)
                })
                .or_else(|| {
                    spans.iter().skip(line_index + 1).find_map(|candidate| {
                        let body = &source[candidate.start..candidate.content_end];
                        let trimmed = body.trim_start_matches([' ', '\t']);
                        if trimmed.is_empty() {
                            return None;
                        }
                        let candidate_indent = body.len() - trimmed.len();
                        (candidate_indent > indent).then_some(candidate_indent)
                    })
                });
            let content_indent = explicit_indent
                .map(|explicit| indent + explicit)
                .or(inferred_indent)
                .unwrap_or(indent + 1);
            let mut end = span.end;
            let mut saw_content = false;
            let preserve_trailing_blank = indicator.contains('+');
            for candidate in spans.iter().skip(line_index + 1) {
                let body = &source[candidate.start..candidate.content_end];
                let trimmed = body.trim_start_matches([' ', '\t']);
                if trimmed.is_empty() {
                    if preserve_trailing_blank || !saw_content {
                        end = candidate.end;
                    }
                    continue;
                }
                let candidate_indent = body.len() - trimmed.len();
                if candidate_indent < content_indent {
                    break;
                }
                end = candidate.end;
                saw_content = true;
            }
            Some((span.end, end))
        })
        .collect()
}

fn provenance_continuation_ranges(source: &str) -> Vec<(usize, usize)> {
    let spans = line_spans(source);
    let mut ranges = block_scalar_body_ranges(source);
    let block_scalar_ranges = ranges.clone();
    for (line_index, span) in spans.iter().enumerate() {
        if sorted_range_contains(&block_scalar_ranges, span.start) {
            continue;
        }
        let body = &source[span.start..span.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        let indent = body.len() - trimmed.len();
        let item = trimmed
            .strip_prefix("- ")
            .or_else(|| (trimmed == "-").then_some(""));
        let mapping_source = item.unwrap_or(trimmed);
        let value_source = if let Some(colon) = mapping_key_colon(mapping_source) {
            mapping_source[colon + 1..].trim_start()
        } else if item.is_some() {
            mapping_source
        } else if let Some(explicit) = mapping_source.strip_prefix('?') {
            explicit.trim_start()
        } else {
            continue;
        };
        let (remainder, _, tag_name) = split_node_properties(value_source);
        if remainder.is_empty() || remainder.starts_with('#') {
            if tag_name.is_none() {
                continue;
            }
            let Some((first_index, first)) =
                spans
                    .iter()
                    .enumerate()
                    .skip(line_index + 1)
                    .find(|(_, candidate)| {
                        let candidate_body = &source[candidate.start..candidate.content_end];
                        !candidate_body.trim().is_empty()
                            && !candidate_body.trim_start().starts_with('#')
                    })
            else {
                continue;
            };
            let first_body = &source[first.start..first.content_end];
            let first_trimmed = first_body.trim_start_matches([' ', '\t']);
            let first_indent = first_body.len() - first_trimmed.len();
            if first_indent <= indent {
                continue;
            }
            if tag_name.is_some_and(|tag| matches!(tag, "map" | "seq" | "set" | "omap" | "pairs"))
                && !matches!(first_trimmed.chars().next(), Some('{' | '['))
            {
                continue;
            }
            let start = first.start + first_indent;
            let end = if matches!(first_trimmed.chars().next(), Some('{' | '[')) {
                flow_value_end(source, start)
            } else if matches!(first_trimmed.chars().next(), Some('"' | '\'')) {
                start + scalar_lexical_source(&source[start..]).len()
            } else {
                following_block_end(source, &spans, first_index, indent, false, true)
            };
            ranges.push((first.start, end));
            continue;
        }
        let relative = body
            .find(value_source)
            .unwrap_or_else(|| body.len().saturating_sub(value_source.len()))
            + value_source.len().saturating_sub(remainder.len());
        let start = span.start + relative;
        let end = if matches!(remainder.chars().next(), Some('{' | '[')) {
            flow_value_end(source, start)
        } else if matches!(remainder.chars().next(), Some('"' | '\'')) {
            start + scalar_lexical_source(&source[start..]).len()
        } else {
            let mut end = span.content_end;
            for candidate in spans.iter().skip(line_index + 1) {
                let candidate_body = &source[candidate.start..candidate.content_end];
                let candidate_trimmed = candidate_body.trim_start_matches([' ', '\t']);
                let candidate_indent = candidate_body.len() - candidate_trimmed.len();
                if !candidate_trimmed.is_empty()
                    && (candidate_indent <= indent
                        || mapping_key_colon(candidate_trimmed).is_some())
                {
                    break;
                }
                end = candidate.content_end;
            }
            end
        };
        if end > span.end {
            ranges.push((span.end, end));
        }
    }
    ranges
}

fn plain_scalar_continuation_ranges(source: &str) -> Vec<(usize, usize)> {
    let spans = line_spans(source);
    let block_scalar_ranges = block_scalar_body_ranges(source);
    let mut ranges = Vec::new();
    let is_plain_scalar = |value: &str| {
        !value.is_empty()
            && !value.starts_with('#')
            && !matches!(
                value.chars().next(),
                Some('"' | '\'' | '|' | '>' | '{' | '[' | '*' | '&' | '!' | '?' | ':' | '-')
            )
            && mapping_key_colon(value).is_none()
    };
    for (line_index, span) in spans.iter().enumerate() {
        if sorted_range_contains(&block_scalar_ranges, span.start) {
            continue;
        }
        let body = &source[span.start..span.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        let indent = body.len() - trimmed.len();
        let item = trimmed
            .strip_prefix("- ")
            .or_else(|| (trimmed == "-").then_some(""));
        let mapping_source = item.unwrap_or(trimmed);
        let mapping_colon = mapping_key_colon(mapping_source);
        let parent_indent = indent + usize::from(item.is_some() && mapping_colon.is_some()) * 2;
        let value_source = if let Some(colon) = mapping_colon {
            mapping_source[colon + 1..].trim_start()
        } else if item.is_some() {
            mapping_source
        } else {
            continue;
        };
        let (remainder, anchor, tag) = split_node_properties(value_source);
        let (continuation_start, scan_index) = if is_plain_scalar(remainder) {
            (span.end, line_index + 1)
        } else if remainder.is_empty()
            && anchor.is_none()
            && tag.is_none()
            && mapping_colon.is_some()
        {
            let Some((first_index, first)) =
                spans
                    .iter()
                    .enumerate()
                    .skip(line_index + 1)
                    .find(|(_, candidate)| {
                        let body = &source[candidate.start..candidate.content_end];
                        let trimmed = body.trim_start_matches([' ', '\t']);
                        !trimmed.is_empty() && !trimmed.starts_with('#')
                    })
            else {
                continue;
            };
            let first_body = &source[first.start..first.content_end];
            let first_trimmed = first_body.trim_start_matches([' ', '\t']);
            let first_indent = first_body.len() - first_trimmed.len();
            if first_indent <= parent_indent || !is_plain_scalar(first_trimmed) {
                continue;
            }
            (first.end, first_index + 1)
        } else {
            continue;
        };
        let mut end = continuation_start;
        for candidate in spans.iter().skip(scan_index) {
            let candidate_body = &source[candidate.start..candidate.content_end];
            let candidate_trimmed = candidate_body.trim_start_matches([' ', '\t']);
            let candidate_indent = candidate_body.len() - candidate_trimmed.len();
            if !candidate_trimmed.is_empty()
                && (candidate_indent <= parent_indent
                    || mapping_key_colon(candidate_trimmed).is_some()
                    || candidate_trimmed
                        .strip_prefix(['?', ':', '-'])
                        .is_some_and(|rest| {
                            rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
                        }))
            {
                break;
            }
            end = candidate.content_end;
        }
        if end > continuation_start {
            ranges.push((continuation_start, end));
        }
    }
    ranges
}

fn plain_scalar_value_ranges(source: &str) -> Vec<(usize, usize)> {
    let spans = line_spans(source);
    let block_scalar_ranges = block_scalar_body_ranges(source);
    let mut ranges = Vec::new();
    let is_plain_scalar = |value: &str| {
        !value.is_empty()
            && !value.starts_with('#')
            && !matches!(
                value.chars().next(),
                Some('"' | '\'' | '|' | '>' | '{' | '[' | '*' | '&' | '!' | '?' | ':' | '-')
            )
            && mapping_key_colon(value).is_none()
    };
    for (line_index, span) in spans.iter().enumerate() {
        if sorted_range_contains(&block_scalar_ranges, span.start) {
            continue;
        }
        let body = &source[span.start..span.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        let indent = body.len() - trimmed.len();
        let item = trimmed
            .strip_prefix("- ")
            .or_else(|| (trimmed == "-").then_some(""));
        let mapping_source = item.unwrap_or(trimmed);
        let mapping_colon = mapping_key_colon(mapping_source);
        let parent_indent = indent + usize::from(item.is_some() && mapping_colon.is_some()) * 2;
        let value_source = if let Some(colon) = mapping_colon {
            mapping_source[colon + 1..].trim_start()
        } else if item.is_some() {
            mapping_source
        } else {
            continue;
        };
        let (remainder, anchor, tag) = split_node_properties(value_source);
        let (scalar_start, scan_index) = if is_plain_scalar(remainder) {
            let relative = body
                .find(value_source)
                .unwrap_or_else(|| body.len().saturating_sub(value_source.len()))
                + value_source.len().saturating_sub(remainder.len());
            (span.start + relative, line_index + 1)
        } else if remainder.is_empty()
            && mapping_colon.is_some()
            && tag.is_none_or(|name| !matches!(name, "map" | "seq" | "set" | "omap" | "pairs"))
            && (value_source.is_empty() || anchor.is_some() || tag.is_some())
        {
            let Some((first_index, first)) =
                spans
                    .iter()
                    .enumerate()
                    .skip(line_index + 1)
                    .find(|(_, candidate)| {
                        let body = &source[candidate.start..candidate.content_end];
                        let trimmed = body.trim_start_matches([' ', '\t']);
                        !trimmed.is_empty() && !trimmed.starts_with('#')
                    })
            else {
                continue;
            };
            let first_body = &source[first.start..first.content_end];
            let first_trimmed = first_body.trim_start_matches([' ', '\t']);
            let first_indent = first_body.len() - first_trimmed.len();
            if first_indent <= parent_indent || !is_plain_scalar(first_trimmed) {
                continue;
            }
            (first.start + first_indent, first_index + 1)
        } else {
            continue;
        };
        let mut end = spans
            .get(scan_index.saturating_sub(1))
            .map_or(scalar_start, |line| line.content_end);
        for candidate in spans.iter().skip(scan_index) {
            let candidate_body = &source[candidate.start..candidate.content_end];
            let candidate_trimmed = candidate_body.trim_start_matches([' ', '\t']);
            let candidate_indent = candidate_body.len() - candidate_trimmed.len();
            if !candidate_trimmed.is_empty()
                && (candidate_indent <= parent_indent
                    || mapping_key_colon(candidate_trimmed).is_some()
                    || candidate_trimmed
                        .strip_prefix(['?', ':', '-'])
                        .is_some_and(|rest| {
                            rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
                        }))
            {
                break;
            }
            end = candidate.content_end;
        }
        if end > scalar_start {
            ranges.push((scalar_start, end));
        }
    }
    normalize_ranges(&mut ranges);
    ranges
}

fn duplicate_flow_mapping_key_range(source: &str, flow_start: usize) -> Option<(usize, usize)> {
    let mut keys = Vec::new();
    let mut cursor = flow_start + 1;
    while cursor < source.len() {
        cursor = skip_flow_space_and_comments(source, cursor, source.len());
        if source[cursor..].starts_with('}') {
            break;
        }
        if source[cursor..].starts_with('?')
            && source[cursor + 1..]
                .chars()
                .next()
                .is_some_and(char::is_whitespace)
        {
            cursor = skip_flow_space_and_comments(source, cursor + 1, source.len());
        }
        let key_start = cursor;
        let colon = flow_mapping_colon(source, cursor, source.len())?;
        let key_end = key_start
            + source[key_start..colon]
                .trim_end_matches([' ', '\t', '\r', '\n'])
                .len();
        let key_source = &source[key_start..key_end];
        let (plain_key_source, scalar_relative, _, key_tag) =
            multiline_mapping_key_parts(key_source)?;
        let key = semantic_mapping_key_value(plain_key_source, key_tag)?;
        if keys.contains(&key) {
            if plain_key_source.is_empty() {
                return Some((colon, one_character_end(source, colon, source.len())));
            }
            let scalar_start = key_start + scalar_relative;
            return Some((
                scalar_start,
                one_character_end(source, scalar_start, key_end),
            ));
        }
        keys.push(key);
        let value_start = skip_flow_space_and_comments(source, colon + 1, source.len());
        let (_, delimiter) = flow_mapping_value_end(source, value_start, source.len());
        cursor = delimiter;
        if source[cursor..].starts_with(',') {
            cursor += 1;
        } else {
            break;
        }
    }
    None
}

#[derive(Clone)]
enum PreservedAnchor {
    Path(Vec<String>),
    Scalar {
        value: Value,
        explicit_tag: Option<String>,
    },
}

fn preserved_scalar_anchor(value: String, source: &str, tag_name: Option<&str>) -> PreservedAnchor {
    let explicit_tag = tag_name.and_then(standard_tag_uri).map(str::to_owned);
    let mut value = Value::String(value);
    if let Some(tag_uri) = explicit_tag.as_deref() {
        let mut body = Map::new();
        body.insert("tag".to_owned(), Value::String(tag_uri.to_owned()));
        body.insert("value".to_owned(), value);
        body.insert("source".to_owned(), Value::String(source.to_owned()));
        let mut wrapper = Map::new();
        wrapper.insert(TAGGED_KEY.to_owned(), Value::Object(body));
        value = Value::Object(wrapper);
    }
    PreservedAnchor::Scalar {
        value,
        explicit_tag,
    }
}

fn yaml_anchor_occurrences_in_ranges(
    source: &str,
    ranges: &[(usize, usize)],
) -> Vec<(usize, String)> {
    let excluded_ranges = block_scalar_body_ranges(source);
    let mut occurrences = Vec::new();
    let mut quote = None;
    let mut escaped = false;
    let mut comment = false;
    let mut cursor = 0;
    while cursor < source.len() {
        let character = source[cursor..]
            .chars()
            .next()
            .expect("cursor is within source");
        if comment {
            if matches!(character, '\r' | '\n') {
                comment = false;
            }
            cursor += character.len_utf8();
            continue;
        }
        if let Some(active_quote) = quote {
            if active_quote == '"' && character == '\\' && !escaped {
                escaped = true;
                cursor += character.len_utf8();
                continue;
            }
            if character == active_quote && !escaped {
                quote = None;
            }
            escaped = false;
            cursor += character.len_utf8();
            continue;
        }
        match character {
            '"' | '\'' => quote = Some(character),
            '#' if cursor == 0
                || source[..cursor]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_whitespace) =>
            {
                comment = true;
            }
            '&' if sorted_range_contains(ranges, cursor)
                && !sorted_range_contains(&excluded_ranges, cursor)
                && yaml_node_property_position(source, cursor) =>
            {
                let start = cursor + 1;
                let end = yaml_anchor_name_end(source, start);
                if end > start {
                    occurrences.push((cursor, source[start..end].to_owned()));
                }
                cursor = end;
                continue;
            }
            _ => {}
        }
        cursor += character.len_utf8();
    }
    occurrences
}

fn yaml_node_property_position(source: &str, offset: usize) -> bool {
    if sorted_range_contains(&plain_scalar_value_ranges(source), offset) {
        return false;
    }
    let line_start = source[..offset]
        .rfind(['\r', '\n'])
        .map_or(0, |newline| newline + 1);
    let prefix = &source[line_start..offset];
    let mut candidate_starts = prefix
        .char_indices()
        .filter_map(|(position, character)| {
            matches!(character, ':' | ',' | '[' | '{' | '?').then_some(position + 1)
        })
        .collect::<Vec<_>>();
    candidate_starts.push(0);
    if prefix.trim_start().starts_with("- ") {
        candidate_starts.push(prefix.find("- ").unwrap_or(0) + 2);
    }
    candidate_starts.into_iter().any(|node_start| {
        let node_prefix = prefix[node_start..].trim();
        if node_prefix.is_empty() {
            return true;
        }
        let (remainder, anchor, tag) = split_node_properties(node_prefix);
        remainder.is_empty() && (anchor.is_some() || tag.is_some())
    })
}

fn preserve_standard_yaml_tags(
    source: &str,
    raw: &mut Map<String, Value>,
    parser_explicit_tags: &Map<String, Value>,
    initial_anchors: &std::collections::BTreeMap<String, PreservedAnchor>,
    set_member_anchor_events: &[(String, PreservedAnchor)],
) -> (
    Map<String, Value>,
    std::collections::BTreeMap<String, PreservedAnchor>,
) {
    let mut explicit_tags = parser_explicit_tags.clone();
    let mut anchors = initial_anchors.clone();
    let mut containers: Vec<(usize, String, bool)> = Vec::new();
    let mut sequence_indices: std::collections::BTreeMap<String, usize> =
        std::collections::BTreeMap::new();
    let mut explicit_keys: std::collections::BTreeMap<
        usize,
        (String, Option<String>, Option<String>, String),
    > = std::collections::BTreeMap::new();
    let mut claimed_property_lines = std::collections::BTreeSet::new();
    let spans = line_spans(source);
    let mut scanner_excluded_ranges = provenance_continuation_ranges(source);
    scanner_excluded_ranges.extend(plain_scalar_value_ranges(source));
    normalize_ranges(&mut scanner_excluded_ranges);
    let block_set_member_ranges = spans
        .iter()
        .enumerate()
        .filter_map(|(line_index, line)| {
            let body = &source[line.start..line.content_end];
            let trimmed = body.trim_start_matches([' ', '\t']);
            let indent = body.len() - trimmed.len();
            let mapping_source = trimmed
                .strip_prefix("- ")
                .or_else(|| (trimmed == "-").then_some(""))
                .unwrap_or(trimmed);
            let node_source = mapping_key_colon(mapping_source)
                .map(|colon| mapping_source[colon + 1..].trim_start())
                .unwrap_or(mapping_source);
            let (remainder, _, tag_name) = split_node_properties(node_source);
            (tag_name == Some("set") && (remainder.is_empty() || remainder.starts_with('#'))).then(
                || {
                    (
                        line.end,
                        direct_block_node_end(source, &spans, line_index, indent),
                    )
                },
            )
        })
        .collect::<Vec<_>>();
    let mut preservation_excluded_ranges = scanner_excluded_ranges;
    preservation_excluded_ranges.extend(block_set_member_ranges.iter().copied());
    normalize_ranges(&mut preservation_excluded_ranges);
    let mut set_member_ranges = block_set_member_ranges.clone();
    for (tag_start, tag_end) in source
        .match_indices("!!set")
        .map(|(start, tag)| (start, start + tag.len()))
        .chain(
            source
                .match_indices("!<tag:yaml.org,2002:set>")
                .map(|(start, tag)| (start, start + tag.len())),
        )
    {
        let Some(span) = spans
            .iter()
            .find(|span| span.start <= tag_start && tag_start < span.content_end)
        else {
            continue;
        };
        let line = &source[span.start..span.content_end];
        let after_tag = line[tag_end - span.start..].trim_start();
        let (remainder, _, _) = split_node_properties(after_tag);
        if remainder.starts_with('{') {
            let relative = line
                .rfind(remainder)
                .unwrap_or_else(|| line.len().saturating_sub(remainder.len()));
            let start = span.start + relative;
            set_member_ranges.push((start, flow_value_end(source, start)));
        }
    }
    normalize_ranges(&mut set_member_ranges);
    let set_anchor_occurrences = yaml_anchor_occurrences_in_ranges(source, &set_member_ranges);
    let mut event_index = 0;
    let mut positioned_set_anchor_events = Vec::new();
    for (offset, anchor_name) in set_anchor_occurrences {
        let Some((expected_name, anchor)) = set_member_anchor_events.get(event_index) else {
            break;
        };
        if expected_name == &anchor_name {
            positioned_set_anchor_events.push((offset, anchor_name, anchor.clone()));
            event_index += 1;
        }
    }
    let mut positioned_event_index = 0;
    for (line_index, line) in spans.iter().enumerate() {
        while let Some((offset, name, anchor)) =
            positioned_set_anchor_events.get(positioned_event_index)
            && *offset < line.start
        {
            anchors.insert(name.clone(), anchor.clone());
            positioned_event_index += 1;
        }
        if sorted_range_contains(&preservation_excluded_ranges, line.start)
            || claimed_property_lines.contains(&line_index)
        {
            continue;
        }
        let body = &source[line.start..line.content_end];
        let indent = body
            .chars()
            .take_while(|character| *character == ' ')
            .count();
        let trimmed = body.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let item = trimmed
            .strip_prefix("- ")
            .or_else(|| (trimmed == "-").then_some(""));
        while containers
            .last()
            .is_some_and(|(container_indent, _, sequence_item)| {
                *container_indent > indent
                    || (*container_indent == indent && (*sequence_item || item.is_none()))
            })
        {
            containers.pop();
        }
        let mut compact_key_anchor = None;
        let mut compact_key_tag: Option<String> = None;
        let compact_mapping_source: String;
        let compact_mapping_item = item.is_some();
        let mut mapping_source = if let Some(item) = item {
            let sequence_key = format!(
                "{indent}/{}",
                containers
                    .iter()
                    .map(|(_, segment, _)| segment.as_str())
                    .collect::<Vec<_>>()
                    .join("/")
            );
            let index = sequence_indices.entry(sequence_key).or_default();
            containers.push((indent, index.to_string(), true));
            *index += 1;
            item
        } else {
            trimmed
        };
        if item.is_some() {
            let item_path = containers
                .iter()
                .map(|(_, segment, _)| segment.clone())
                .collect::<Vec<_>>();
            let mut property_source = mapping_source.to_owned();
            let mut node_line_index = line_index;
            let mut node_body = body;
            let (initial_remainder, initial_anchor, initial_tag) =
                split_node_properties(mapping_source);
            if (initial_remainder.is_empty() || initial_remainder.starts_with('#'))
                && (initial_anchor.is_some() || initial_tag.is_some())
                && let Some((continued_index, continued_span)) = spans
                    .iter()
                    .enumerate()
                    .skip(line_index + 1)
                    .find(|(_, candidate)| {
                        let candidate_body = &source[candidate.start..candidate.content_end];
                        let candidate_trimmed = candidate_body.trim_start_matches([' ', '\t']);
                        let candidate_indent = candidate_body.len() - candidate_trimmed.len();
                        candidate_indent > indent
                            && !candidate_trimmed.is_empty()
                            && !candidate_trimmed.starts_with('#')
                    })
            {
                let continued_body = &source[continued_span.start..continued_span.content_end];
                let continued = continued_body.trim_start_matches([' ', '\t']);
                let (continued_node, _, _) = split_node_properties(continued);
                let continued_is_flow_collection =
                    matches!(continued_node.chars().next(), Some('{' | '['));
                let continued_is_block_collection = !continued_is_flow_collection
                    && (continued_node == "-"
                        || continued_node.starts_with("- ")
                        || continued_node == "?"
                        || continued_node.starts_with("? ")
                        || structural_mapping_key_colon(continued_node).is_some());
                if !continued_is_block_collection {
                    let current = mapping_source
                        .split_once('#')
                        .map_or(mapping_source, |(properties, _)| properties)
                        .trim_end();
                    property_source = format!("{current} {continued}");
                    node_line_index = continued_index;
                    node_body = continued_body;
                    claimed_property_lines.insert(continued_index);
                }
            }
            let (remainder, anchor_name, tag_name) = split_node_properties(&property_source);
            if let Some(alias) = remainder.strip_prefix('*').map(str::trim) {
                apply_tagged_alias(raw, &mut explicit_tags, &anchors, alias, &item_path);
                continue;
            }
            let explicit_mapping_key = remainder.strip_prefix('?').is_some_and(|source| {
                source.is_empty() || source.chars().next().is_some_and(char::is_whitespace)
            });
            if (matches!(remainder.chars().next(), Some('{' | '['))
                || structural_mapping_key_colon(remainder).is_none())
                && !explicit_mapping_key
            {
                if let Some(anchor_name) = anchor_name {
                    anchors.insert(anchor_name, PreservedAnchor::Path(item_path.clone()));
                }
                let path = item_path.iter().map(String::as_str).collect::<Vec<_>>();
                if matches!(remainder.chars().next(), Some('{' | '['))
                    && needs_flow_provenance_scan(mapping_source)
                {
                    let relative_start = body.find(mapping_source).unwrap_or(0);
                    let flow_relative = mapping_source.len() - remainder.len();
                    let absolute_end =
                        flow_value_end(source, line.start + relative_start + flow_relative);
                    preserve_flow_standard_yaml_tags(
                        &source[line.start + relative_start..absolute_end],
                        line.start + relative_start,
                        &path,
                        raw,
                        &mut explicit_tags,
                        &mut anchors,
                        &positioned_set_anchor_events,
                    );
                }
                if let Some(tag_name) = tag_name {
                    let lexical = tagged_lexical_source(
                        source,
                        &spans,
                        node_line_index,
                        indent,
                        node_body,
                        remainder,
                        tag_name,
                    );
                    preserve_tagged_value(raw, &path, tag_name, &lexical, &mut explicit_tags);
                }
                continue;
            }
            compact_key_anchor = anchor_name;
            compact_key_tag = tag_name.map(str::to_owned);
            compact_mapping_source = remainder.to_owned();
            mapping_source = &compact_mapping_source;
        }
        if item.is_none()
            && structural_mapping_key_colon(mapping_source).is_none()
            && !mapping_source.starts_with(['?', ':'])
            && !containers.is_empty()
            && !explicit_keys
                .keys()
                .any(|explicit_indent| *explicit_indent < indent)
        {
            let item_path = containers
                .iter()
                .map(|(_, segment, _)| segment.clone())
                .collect::<Vec<_>>();
            let (remainder, anchor_name, tag_name) = split_node_properties(mapping_source);
            if let Some(anchor_name) = anchor_name {
                anchors.insert(anchor_name, PreservedAnchor::Path(item_path.clone()));
            }
            if let Some(alias) = remainder.strip_prefix('*').map(str::trim) {
                apply_tagged_alias(raw, &mut explicit_tags, &anchors, alias, &item_path);
                continue;
            }
            if let Some(tag_name) = tag_name {
                let path = item_path.iter().map(String::as_str).collect::<Vec<_>>();
                let lexical = tagged_lexical_source(
                    source,
                    &spans,
                    line_index,
                    indent.saturating_sub(1),
                    body,
                    remainder,
                    tag_name,
                );
                preserve_tagged_value(raw, &path, tag_name, &lexical, &mut explicit_tags);
            }
            continue;
        }
        if let Some(_explicit_key) = mapping_source.strip_prefix('?').and_then(|source| {
            (source.is_empty() || source.chars().next().is_some_and(char::is_whitespace))
                .then_some(source.trim_start())
        }) {
            let key_start =
                explicit_key_source_start(source, &spans, line_index, body, mapping_source);
            let key_end = spans
                .iter()
                .skip(line_index + 1)
                .find_map(|candidate| {
                    let candidate_body = &source[candidate.start..candidate.content_end];
                    let candidate_trimmed = candidate_body.trim_start_matches([' ', '\t']);
                    let candidate_indent = candidate_body.len() - candidate_trimmed.len();
                    let expected_value_indent = indent + if compact_mapping_item { 2 } else { 0 };
                    (candidate_indent == expected_value_indent
                        && candidate_trimmed.strip_prefix(':').is_some_and(|rest| {
                            rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
                        }))
                    .then_some(candidate.start)
                })
                .unwrap_or(line.content_end);
            if key_start > key_end {
                continue;
            }
            let key_source = source[key_start..key_end].trim_end_matches(['\r', '\n']);
            let Some((plain_key_source, _, anchor_name, tag_name)) =
                multiline_mapping_key_parts(key_source)
            else {
                continue;
            };
            let key_lexical = scalar_lexical_source(plain_key_source);
            let key = parsed_string_mapping_key(key_lexical, tag_name)
                .unwrap_or_else(|| key_lexical.trim_matches(['\'', '"']).to_owned());
            explicit_keys.insert(
                indent + if compact_mapping_item { 2 } else { 0 },
                (
                    key,
                    anchor_name,
                    tag_name.map(str::to_owned),
                    key_lexical.to_owned(),
                ),
            );
            continue;
        }
        let explicit_value = mapping_source.strip_prefix(':').and_then(|source| {
            (source.is_empty() || source.chars().next().is_some_and(char::is_whitespace))
                .then_some(source.trim_start())
        });
        let (key, key_anchor, key_tag, key_lexical, value_source) = if let Some(value_source) =
            explicit_value
        {
            let Some((key, anchor_name, tag_name, lexical)) = explicit_keys.remove(&indent) else {
                continue;
            };
            (key, anchor_name, tag_name, lexical, value_source.trim())
        } else {
            let Some(colon) = mapping_key_colon(mapping_source) else {
                continue;
            };
            let key_source = mapping_source[..colon].trim_end_matches([' ', '\t']);
            let (plain_key_source, anchor_name, tag_name) =
                split_node_properties(key_source.trim());
            let key = parsed_string_mapping_key(plain_key_source, tag_name)
                .unwrap_or_else(|| plain_key_source.trim_matches(['\'', '"']).to_owned());
            (
                key,
                compact_key_anchor.or(anchor_name),
                compact_key_tag.or_else(|| tag_name.map(str::to_owned)),
                plain_key_source.trim().to_owned(),
                mapping_source[colon + 1..].trim(),
            )
        };
        if let Some(anchor_name) = key_anchor {
            anchors.insert(
                anchor_name,
                preserved_scalar_anchor(key.clone(), &key_lexical, key_tag.as_deref()),
            );
        };
        if value_source.is_empty() {
            containers.push((indent + usize::from(compact_mapping_item), key, false));
            continue;
        }
        let path = containers
            .iter()
            .map(|(_, segment, _)| segment.as_str())
            .chain(std::iter::once(key.as_str()))
            .collect::<Vec<_>>();
        if matches!(value_source.chars().next(), Some('{' | '[')) {
            let relative_start = body
                .find(value_source)
                .unwrap_or_else(|| body.len().saturating_sub(value_source.len()));
            let absolute_start = line.start + relative_start;
            let absolute_end = flow_value_end(source, absolute_start);
            let flow_source = &source[absolute_start..absolute_end];
            if needs_flow_provenance_scan(flow_source) {
                preserve_flow_standard_yaml_tags(
                    flow_source,
                    absolute_start,
                    &path,
                    raw,
                    &mut explicit_tags,
                    &mut anchors,
                    &positioned_set_anchor_events,
                );
            }
        }
        let mut property_source = value_source.to_owned();
        let mut node_line_index = line_index;
        let mut node_body = body;
        let (initial_remainder, initial_anchor, initial_tag) = split_node_properties(value_source);
        if (initial_remainder.is_empty() || initial_remainder.starts_with('#'))
            && (initial_anchor.is_some() || initial_tag.is_some())
            && let Some((continued_index, continued_span)) = spans
                .iter()
                .enumerate()
                .skip(line_index + 1)
                .find(|(_, candidate)| {
                    let candidate_body = &source[candidate.start..candidate.content_end];
                    let candidate_trimmed = candidate_body.trim_start_matches([' ', '\t']);
                    let candidate_indent = candidate_body.len() - candidate_trimmed.len();
                    candidate_indent > indent
                        && !candidate_trimmed.is_empty()
                        && !candidate_trimmed.starts_with('#')
                })
        {
            let continued_body = &source[continued_span.start..continued_span.content_end];
            let continued = continued_body.trim_start_matches([' ', '\t']);
            let (continued_node, _, _) = split_node_properties(continued);
            let continued_is_flow_collection =
                matches!(continued_node.chars().next(), Some('{' | '['));
            let continued_is_block_collection = !continued_is_flow_collection
                && (continued_node == "-"
                    || continued_node.starts_with("- ")
                    || continued_node == "?"
                    || continued_node.starts_with("? ")
                    || structural_mapping_key_colon(continued_node).is_some());
            if !continued_is_block_collection {
                let current = value_source
                    .split_once('#')
                    .map_or(value_source, |(properties, _)| properties)
                    .trim_end();
                property_source = format!("{current} {continued}");
                node_line_index = continued_index;
                node_body = continued_body;
                claimed_property_lines.insert(continued_index);
            }
        }
        let (remainder, anchor_name, tag_name) = split_node_properties(&property_source);
        if let Some(anchor_name) = anchor_name {
            anchors.insert(
                anchor_name,
                PreservedAnchor::Path(path.iter().map(|segment| (*segment).to_owned()).collect()),
            );
        }
        if node_line_index == line_index
            && matches!(remainder.chars().next(), Some('{' | '['))
            && needs_flow_provenance_scan(value_source)
        {
            let relative_start = body
                .find(value_source)
                .unwrap_or_else(|| body.len().saturating_sub(value_source.len()));
            let absolute_start = line.start + relative_start;
            let flow_relative = value_source.len() - remainder.len();
            let absolute_end = flow_value_end(source, absolute_start + flow_relative);
            preserve_flow_standard_yaml_tags(
                &source[absolute_start..absolute_end],
                absolute_start,
                &path,
                raw,
                &mut explicit_tags,
                &mut anchors,
                &positioned_set_anchor_events,
            );
        }
        if let Some(alias) = remainder.strip_prefix('*').map(str::trim) {
            let owned_path = path
                .iter()
                .map(|segment| (*segment).to_owned())
                .collect::<Vec<_>>();
            apply_tagged_alias(raw, &mut explicit_tags, &anchors, alias, &owned_path);
            continue;
        }

        if let Some(tag_name) = tag_name {
            let lexical = tagged_lexical_source(
                source,
                &spans,
                node_line_index,
                indent,
                node_body,
                remainder,
                tag_name,
            );
            preserve_tagged_value(raw, &path, tag_name, &lexical, &mut explicit_tags);
        }
        if remainder.is_empty() {
            containers.push((indent, key, false));
        }
    }
    (explicit_tags, anchors)
}

fn split_tag_source(source: &str) -> (&str, &str) {
    source
        .split_once(char::is_whitespace)
        .map_or((source, ""), |(tag, value)| (tag, value.trim_start()))
}

fn split_standard_tag_property(source: &str) -> Option<(&str, &str)> {
    if let Some(tag_source) = source.strip_prefix("!!") {
        return Some(split_tag_source(tag_source));
    }
    if source.starts_with('!') && !source.starts_with("!<") {
        let (tag, remainder) = split_tag_source(source);
        if let Some(uri) = internal_standard_tag(tag) {
            return Some((
                uri.strip_prefix("tag:yaml.org,2002:")
                    .expect("internal standard tags use the canonical prefix"),
                remainder,
            ));
        }
    }
    let verbatim = source.strip_prefix("!<")?;
    let end = verbatim.find('>')?;
    let tag_uri = &verbatim[..end];
    let tag_name = tag_uri.strip_prefix("tag:yaml.org,2002:")?;
    Some((tag_name, verbatim[end + 1..].trim_start()))
}

fn node_property_token_length(source: &str) -> Option<usize> {
    if source.starts_with("!<") {
        return source.find('>').map(|end| end + 1);
    }
    source
        .find(char::is_whitespace)
        .or(Some(source.len()))
        .filter(|length| *length > 0)
}

fn split_node_properties(mut source: &str) -> (&str, Option<String>, Option<&str>) {
    let mut anchor_name = None;
    let mut tag_name = None;
    for _ in 0..2 {
        if let Some(anchor) = source.strip_prefix('&') {
            let (name, remainder) = anchor
                .split_once(char::is_whitespace)
                .map_or((anchor, ""), |(name, rest)| (name, rest.trim_start()));
            anchor_name = Some(name.to_owned());
            source = remainder;
            continue;
        }
        if let Some((name, remainder)) = split_standard_tag_property(source) {
            tag_name = Some(name);
            source = remainder;
            continue;
        }
        break;
    }
    (source, anchor_name, tag_name)
}

fn explicit_key_source_start(
    source: &str,
    spans: &[LineSpan],
    line_index: usize,
    body: &str,
    mapping_source: &str,
) -> usize {
    let mapping_offset = body
        .find(mapping_source)
        .unwrap_or_else(|| body.len().saturating_sub(mapping_source.len()));
    let question = spans[line_index].start + mapping_offset;
    let after_question = mapping_source.strip_prefix('?').unwrap_or(mapping_source);
    let leading = after_question.len() - after_question.trim_start().len();
    if !after_question.trim().is_empty() && !after_question.trim_start().starts_with('#') {
        return question + 1 + leading;
    }
    spans
        .iter()
        .skip(line_index + 1)
        .find_map(|span| {
            let candidate = &source[span.start..span.content_end];
            let trimmed = candidate.trim_start_matches([' ', '\t']);
            (!trimmed.is_empty() && !trimmed.starts_with('#'))
                .then_some(span.start + candidate.len().saturating_sub(trimmed.len()))
        })
        .unwrap_or(spans[line_index].content_end)
}

fn contains_standard_tag_property(source: &str) -> bool {
    source.contains("!!") || source.contains("!<tag:yaml.org,2002:")
}

fn needs_flow_provenance_scan(source: &str) -> bool {
    contains_standard_tag_property(source) || source.contains(['&', '*'])
}

fn remove_explicit_tags_at_or_below(
    explicit_tags: &mut Map<String, Value>,
    target_path: &[String],
) {
    explicit_tags.retain(|key, _| {
        let segments = explicit_tag_segments(key);
        !segments.starts_with(target_path)
    });
}

fn collect_value_explicit_tags(
    value: &Value,
    path: &mut Vec<String>,
    explicit_tags: &mut Vec<(String, Value)>,
) {
    if let Some(tagged) = value.get(TAGGED_KEY).and_then(Value::as_object)
        && let Some(tag) = tagged.get("tag").and_then(Value::as_str)
    {
        let borrowed = path.iter().map(String::as_str).collect::<Vec<_>>();
        explicit_tags.push((explicit_tag_path(&borrowed), Value::String(tag.to_owned())));
        if let Some(semantic) = tagged.get("value") {
            collect_value_explicit_tags(semantic, path, explicit_tags);
        }
        return;
    }
    match value {
        Value::Array(values) => {
            for (index, nested) in values.iter().enumerate() {
                path.push(index.to_string());
                collect_value_explicit_tags(nested, path, explicit_tags);
                path.pop();
            }
        }
        Value::Object(values) => {
            for (key, nested) in values {
                path.push(key.clone());
                collect_value_explicit_tags(nested, path, explicit_tags);
                path.pop();
            }
        }
        _ => {}
    }
}

fn apply_tagged_alias(
    raw: &mut Map<String, Value>,
    explicit_tags: &mut Map<String, Value>,
    anchors: &std::collections::BTreeMap<String, PreservedAnchor>,
    alias: &str,
    target_path: &[String],
) {
    let Some(anchor) = anchors.get(alias) else {
        return;
    };
    let target = target_path.iter().map(String::as_str).collect::<Vec<_>>();
    match anchor {
        PreservedAnchor::Path(anchor_path) => {
            let anchor = anchor_path.iter().map(String::as_str).collect::<Vec<_>>();
            let Some(value) = value_at_path(raw, &anchor, explicit_tags).cloned() else {
                return;
            };
            let suppress_descendant_tags = value
                .get(TAGGED_KEY)
                .and_then(Value::as_object)
                .and_then(|tagged| tagged.get("tag"))
                .and_then(Value::as_str)
                .is_some_and(|tag| {
                    matches!(
                        tag,
                        "tag:yaml.org,2002:set"
                            | "tag:yaml.org,2002:omap"
                            | "tag:yaml.org,2002:pairs"
                    )
                });
            let copied = explicit_tags
                .iter()
                .filter_map(|(key, tag)| {
                    let segments = explicit_tag_segments(key);
                    segments
                        .strip_prefix(anchor_path.as_slice())
                        .and_then(|suffix| {
                            if suppress_descendant_tags && !suffix.is_empty() {
                                return None;
                            }
                            let mut translated = target_path.to_vec();
                            translated.extend_from_slice(suffix);
                            let borrowed =
                                translated.iter().map(String::as_str).collect::<Vec<_>>();
                            Some((explicit_tag_path(&borrowed), tag.clone()))
                        })
                })
                .collect::<Vec<_>>();
            let root_tag = (anchor_path.len() == 1)
                .then(|| explicit_tags.get(&anchor_path[0]).cloned())
                .flatten();
            remove_explicit_tags_at_or_below(explicit_tags, target_path);
            set_value_at_path(raw, &target, value, explicit_tags);
            if let Some(tag) = root_tag {
                explicit_tags.insert(explicit_tag_path(&target), tag);
            }
            for (key, tag) in copied {
                explicit_tags.insert(key, tag);
            }
        }
        PreservedAnchor::Scalar {
            value,
            explicit_tag,
        } => {
            remove_explicit_tags_at_or_below(explicit_tags, target_path);
            set_value_at_path(raw, &target, value.clone(), explicit_tags);
            if explicit_tag
                .as_deref()
                .is_none_or(|tag| matches!(tag, "tag:yaml.org,2002:map" | "tag:yaml.org,2002:seq"))
            {
                let mut copied = Vec::new();
                collect_value_explicit_tags(value, &mut target_path.to_vec(), &mut copied);
                for (key, tag) in copied {
                    explicit_tags.insert(key, tag);
                }
            }
            if let Some(tag) = explicit_tag
                && !explicit_tags.contains_key(&explicit_tag_path(&target))
            {
                explicit_tags.insert(explicit_tag_path(&target), Value::String(tag.to_owned()));
            }
        }
    }
}

fn explicit_tag_segments(path: &str) -> Vec<String> {
    if let Some(pointer) = path.strip_prefix('/') {
        pointer
            .split('/')
            .map(|segment| segment.replace("~1", "/").replace("~0", "~"))
            .collect()
    } else {
        vec![path.to_owned()]
    }
}

fn preserve_tagged_value(
    raw: &mut Map<String, Value>,
    path: &[&str],
    tag_name: &str,
    lexical: &str,
    explicit_tags: &mut Map<String, Value>,
) -> Option<(Value, String)> {
    let tag_uri = standard_tag_uri(tag_name)?.to_owned();
    let existing = value_at_path(raw, path, explicit_tags)?.clone();
    let restored_set_source = (tag_name == "set")
        .then(|| {
            existing
                .get(TAGGED_KEY)?
                .as_object()?
                .get("source")?
                .as_str()
                .map(restored_standard_set_source)
        })
        .flatten();
    let already_wrapped = existing
        .get(TAGGED_KEY)
        .and_then(Value::as_object)
        .and_then(|tagged| tagged.get("tag"))
        .and_then(Value::as_str)
        == Some(tag_uri.as_str());
    let existing = if already_wrapped || explicit_tags.contains_key(&explicit_tag_path(path)) {
        semantic_value(&existing).clone()
    } else {
        existing
    };
    let semantic = standard_tag_semantic(tag_name, lexical, existing);
    let mut body = Map::new();
    body.insert("tag".to_owned(), Value::String(tag_uri.clone()));
    body.insert("value".to_owned(), semantic);
    body.insert(
        "source".to_owned(),
        Value::String(restored_set_source.unwrap_or_else(|| lexical.to_owned())),
    );
    let mut wrapper = Map::new();
    wrapper.insert(TAGGED_KEY.to_owned(), Value::Object(body));
    let wrapped = Value::Object(wrapper);
    set_value_at_path(raw, path, wrapped.clone(), explicit_tags);
    explicit_tags.insert(explicit_tag_path(path), Value::String(tag_uri.clone()));
    Some((wrapped, tag_uri))
}

fn restored_standard_set_source(source: &str) -> String {
    let block_scalar_ranges = block_scalar_body_ranges(source);
    let mut syntactic_lines = line_spans(source).into_iter().filter_map(|line| {
        if sorted_range_contains(&block_scalar_ranges, line.start) {
            return None;
        }
        let body = source[line.start..line.content_end].trim();
        (!body.is_empty()).then_some(body)
    });
    let mut last = syntactic_lines.next();
    for line in syntactic_lines {
        last = Some(line);
    }
    let terminal_bare = last == Some("?");
    let terminal_property_only = last.is_some_and(|body| {
        let Some(member) = body.strip_prefix('?').map(str::trim_start) else {
            return false;
        };
        let (remainder, anchor, tag) = split_node_properties(member);
        remainder.is_empty() && (anchor.is_some() || tag.is_some())
    });
    if source.trim() == "?"
        || source.trim_start().starts_with('{')
        || terminal_bare
        || terminal_property_only
    {
        source.trim_end().to_owned()
    } else {
        source.to_owned()
    }
}

fn tagged_lexical_source(
    source: &str,
    spans: &[LineSpan],
    line_index: usize,
    parent_indent: usize,
    body: &str,
    remainder: &str,
    tag_name: &str,
) -> String {
    if remainder.is_empty() || remainder.starts_with('#') {
        let lexical = following_indented_source(source, spans, line_index, parent_indent, tag_name);
        let first_node = lexical
            .lines()
            .find(|line| !line.trim().is_empty() && !line.trim_start().starts_with('#'))
            .map(str::trim_start)
            .unwrap_or_default();
        return if matches!(lexical.chars().next(), Some('|' | '>'))
            || first_node == "-"
            || first_node.starts_with("- ")
            || first_node == "?"
            || first_node.starts_with("? ")
            || mapping_key_colon(first_node).is_some()
        {
            lexical
        } else {
            scalar_lexical_source(&lexical).to_owned()
        };
    }
    let relative_start = body
        .rfind(remainder)
        .unwrap_or_else(|| body.len().saturating_sub(remainder.len()));
    let absolute_start = spans[line_index].start + relative_start;
    if remainder.starts_with('|') || remainder.starts_with('>') {
        let end = block_scalar_body_ranges(source)
            .into_iter()
            .find_map(|(start, end)| (start == spans[line_index].end).then_some(end))
            .unwrap_or(spans[line_index].end);
        return source[absolute_start..end].to_owned();
    }
    if matches!(remainder.chars().next(), Some('{' | '[')) {
        let end = flow_value_end(source, absolute_start);
        return source[absolute_start..end].to_owned();
    }
    if matches!(remainder.chars().next(), Some('"' | '\'')) {
        return scalar_lexical_source(&source[absolute_start..]).to_owned();
    }
    let mut end = spans[line_index].content_end;
    for span in spans.iter().skip(line_index + 1) {
        let continuation = &source[span.start..span.content_end];
        let trimmed = continuation.trim_start_matches([' ', '\t']);
        let indent = continuation.len() - trimmed.len();
        if !trimmed.is_empty() && (indent <= parent_indent || mapping_key_colon(trimmed).is_some())
        {
            break;
        }
        end = span.content_end;
    }
    scalar_lexical_source(&source[absolute_start..end]).to_owned()
}

fn following_indented_source(
    source: &str,
    spans: &[LineSpan],
    line_index: usize,
    parent_indent: usize,
    tag_name: &str,
) -> String {
    let mut search_index = line_index + 1;
    let first_index = loop {
        let Some(candidate_index) = (search_index..spans.len()).find(|index| {
            let body = &source[spans[*index].start..spans[*index].content_end];
            !body.trim().is_empty() && !body.trim_start().starts_with('#')
        }) else {
            return String::new();
        };
        let candidate = &spans[candidate_index];
        let candidate_body = &source[candidate.start..candidate.content_end];
        let candidate_trimmed = candidate_body.trim_start_matches([' ', '\t']);
        let candidate_indent = candidate_body.len() - candidate_trimmed.len();
        if candidate_indent <= parent_indent {
            return String::new();
        }
        let (candidate_remainder, candidate_anchor, candidate_tag) =
            split_node_properties(candidate_trimmed);
        if (candidate_remainder.is_empty() || candidate_remainder.starts_with('#'))
            && (candidate_anchor.is_some() || candidate_tag.is_some())
        {
            search_index = candidate_index + 1;
            continue;
        }
        break candidate_index;
    };
    let first = &spans[first_index];
    let first_body = &source[first.start..first.content_end];
    let first_indent = first_body
        .chars()
        .take_while(|character| *character == ' ')
        .count();
    if first_indent <= parent_indent {
        return String::new();
    }
    let start = first.start + first_indent;
    let value_source = &source[start..first.content_end];
    if matches!(value_source.chars().next(), Some('{' | '[')) {
        return source[start..flow_value_end(source, start)].to_owned();
    }
    if matches!(value_source.chars().next(), Some('"' | '\'')) {
        let lexical = scalar_lexical_source(&source[start..]);
        return lexical.to_owned();
    }
    if matches!(value_source.chars().next(), Some('|' | '>')) {
        let end = block_scalar_body_ranges(source)
            .into_iter()
            .find_map(|(start, end)| (start == spans[first_index].end).then_some(end))
            .unwrap_or(spans[first_index].end);
        return source[start..end].to_owned();
    }
    if value_source == "-"
        || value_source.starts_with("- ")
        || value_source == "?"
        || value_source.starts_with("? ")
        || mapping_key_colon(value_source).is_some()
    {
        let collection_parent_indent = parent_indent.max(first_indent.saturating_sub(2));
        let boundary_end =
            direct_block_node_end(source, spans, first_index, collection_parent_indent);
        let syntactic_end = spans
            .iter()
            .skip(first_index)
            .take_while(|span| span.start < boundary_end)
            .filter(|span| {
                let trimmed = source[span.start..span.content_end].trim_start_matches([' ', '\t']);
                !trimmed.is_empty() && !trimmed.starts_with('#')
            })
            .map(|span| span.end)
            .last()
            .unwrap_or(spans[first_index].end);
        let includes_intervening_comment = spans.iter().any(|span| {
            syntactic_end <= span.start
                && span.start < boundary_end
                && source[span.start..span.content_end]
                    .trim_start_matches([' ', '\t'])
                    .starts_with('#')
        });
        let preserve_set_boundary = tag_name == "set" && includes_intervening_comment;
        let end = if preserve_set_boundary {
            boundary_end
        } else {
            syntactic_end
        };
        let mut lexical = source[start..end].to_owned();
        if tag_name == "map" {
            lexical = strip_block_mapping_key_properties(&lexical);
        }
        if preserve_set_boundary
            && let Some(boundary) = spans.iter().find(|span| span.start == boundary_end)
        {
            let boundary_body = &source[boundary.start..boundary.content_end];
            let boundary_indent =
                boundary_body.len() - boundary_body.trim_start_matches([' ', '\t']).len();
            lexical.push_str(&boundary_body[..boundary_indent]);
        }
        return lexical;
    }
    let mut end = first.content_end;
    for span in spans.iter().skip(first_index + 1) {
        let continuation = &source[span.start..span.content_end];
        let trimmed = continuation.trim_start_matches([' ', '\t']);
        let indent = continuation.len() - trimmed.len();
        if !trimmed.is_empty() && indent <= parent_indent {
            break;
        }
        end = span.content_end;
    }
    scalar_lexical_source(&source[start..end]).to_owned()
}

fn strip_block_mapping_key_properties(source: &str) -> String {
    for line in line_spans(source) {
        let body = &source[line.start..line.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let leading = body.len() - trimmed.len();
        let Some(colon) = mapping_key_colon(trimmed) else {
            return source.to_owned();
        };
        let key_source = trimmed[..colon].trim_end_matches([' ', '\t']);
        let (plain_key, anchor, tag) = split_node_properties(key_source);
        if plain_key.is_empty() && tag == Some("str") {
            let start = line.start + leading;
            let end = start + colon;
            let mut stripped = source.to_owned();
            stripped.replace_range(start..end, "");
            return stripped;
        }
        if plain_key.is_empty() || (anchor.is_none() && tag.is_none()) {
            return source.to_owned();
        }
        let property_length = key_source.len() - plain_key.len();
        let start = line.start + leading;
        let end = start + property_length;
        let mut stripped = source.to_owned();
        stripped.replace_range(start..end, "");
        return stripped;
    }
    source.to_owned()
}

fn following_block_end(
    source: &str,
    spans: &[LineSpan],
    first_index: usize,
    parent_indent: usize,
    preserve_trailing_blank: bool,
    preserve_empty_scalar_line: bool,
) -> usize {
    let mut end = spans[first_index].end;
    let first_body = &source[spans[first_index].start..spans[first_index].content_end];
    let mut saw_nonblank_content = !preserve_empty_scalar_line && !first_body.trim().is_empty();
    let mut preserved_empty_line = false;
    for span in &spans[first_index + 1..] {
        let body = &source[span.start..span.content_end];
        let indent = body
            .chars()
            .take_while(|character| *character == ' ')
            .count();
        if !body.trim().is_empty() && indent <= parent_indent {
            break;
        }
        if body.trim().is_empty() {
            if preserve_trailing_blank
                || (preserve_empty_scalar_line && !saw_nonblank_content && !preserved_empty_line)
            {
                end = span.end;
                preserved_empty_line = true;
            }
        } else {
            end = span.end;
            saw_nonblank_content = true;
        }
    }
    end
}

fn scalar_lexical_source(source: &str) -> &str {
    let source = source.trim_end_matches(|character: char| {
        character.is_whitespace() && !matches!(character, '\u{0085}' | '\u{2028}' | '\u{2029}')
    });
    let Some(quote) = source
        .chars()
        .next()
        .filter(|quote| matches!(quote, '"' | '\''))
    else {
        let comment = source.char_indices().find_map(|(offset, character)| {
            (character == '#'
                && (offset == 0
                    || source[..offset]
                        .chars()
                        .next_back()
                        .is_some_and(char::is_whitespace)))
            .then_some(offset)
        });
        return comment.map_or(source, |offset| source[..offset].trim_end());
    };
    let mut escaped = false;
    let mut characters = source.char_indices().peekable();
    characters.next();
    while let Some((offset, character)) = characters.next() {
        if quote == '"' && character == '\\' && !escaped {
            escaped = true;
            continue;
        }
        if character == quote && !escaped {
            let end = offset + character.len_utf8();
            if quote == '\'' && characters.peek().is_some_and(|(_, next)| *next == '\'') {
                characters.next();
                escaped = false;
                continue;
            }
            return &source[..end];
        }
        escaped = false;
    }
    source
}

fn flow_value_end(source: &str, start: usize) -> usize {
    let mut stack = Vec::new();
    let mut quote = None;
    let mut escaped = false;
    let mut comment = false;
    let mut characters = source[start..].char_indices().peekable();
    while let Some((relative, character)) = characters.next() {
        let absolute = start + relative;
        if comment {
            if matches!(character, '\r' | '\n') {
                comment = false;
            }
            continue;
        }
        if let Some(active_quote) = quote {
            if active_quote == '"' && character == '\\' && !escaped {
                escaped = true;
                continue;
            }
            if character == active_quote && !escaped {
                if active_quote == '\'' && characters.peek().is_some_and(|(_, next)| *next == '\'')
                {
                    characters.next();
                } else {
                    quote = None;
                }
            }
            escaped = false;
            continue;
        }
        match character {
            '#' if absolute == start
                || source[..absolute]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_whitespace) =>
            {
                comment = true;
            }
            '"' | '\'' => quote = Some(character),
            '{' => stack.push('}'),
            '[' => stack.push(']'),
            '}' | ']' if stack.last() == Some(&character) => {
                stack.pop();
                if stack.is_empty() {
                    return start + relative + character.len_utf8();
                }
            }
            _ => {}
        }
    }
    source.len()
}

fn flow_collection_ranges(source: &str) -> Vec<(usize, usize)> {
    let mut excluded = block_scalar_body_ranges(source);
    excluded.extend(plain_scalar_value_ranges(source));
    normalize_ranges(&mut excluded);
    let mut excluded_index = 0usize;
    let mut ranges = Vec::new();
    let mut stack = Vec::new();
    let mut quote = None;
    let mut escaped = false;
    let mut comment = false;
    let mut characters = source.char_indices().peekable();
    while let Some((offset, character)) = characters.next() {
        while excluded
            .get(excluded_index)
            .is_some_and(|(_, end)| *end <= offset)
        {
            excluded_index += 1;
        }
        if excluded
            .get(excluded_index)
            .is_some_and(|(start, end)| *start <= offset && offset < *end)
        {
            continue;
        }
        if comment {
            if matches!(character, '\r' | '\n') {
                comment = false;
            }
            continue;
        }
        if let Some(active_quote) = quote {
            if active_quote == '"' && character == '\\' && !escaped {
                escaped = true;
                continue;
            }
            if character == active_quote && !escaped {
                if active_quote == '\'' && characters.peek().is_some_and(|(_, next)| *next == '\'')
                {
                    characters.next();
                } else {
                    quote = None;
                }
            }
            escaped = false;
            continue;
        }
        match character {
            '#' if offset == 0
                || source[..offset]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_whitespace) =>
            {
                comment = true;
            }
            '"' | '\'' => quote = Some(character),
            '{' => {
                stack.push(('}', offset));
            }
            '[' => {
                stack.push((']', offset));
            }
            '}' | ']'
                if stack
                    .last()
                    .is_some_and(|(closing, _)| *closing == character) =>
            {
                let (_, start) = stack.pop().expect("matching flow start exists");
                ranges.push((start, offset + character.len_utf8()));
            }
            _ => {}
        }
    }
    for (_, start) in stack {
        ranges.push((start, source.len()));
    }
    ranges.sort_unstable();
    ranges
}

fn standard_tag_semantic(tag_name: &str, source_value: &str, existing: Value) -> Value {
    if matches!(tag_name, "str" | "timestamp" | "binary" | "int" | "float")
        && matches!(existing, Value::Array(_) | Value::Object(_))
    {
        return existing;
    }
    let scalar_text = || {
        if matches!(source_value.trim_start().chars().next(), Some('|' | '>'))
            && let Some(value) = existing.as_str()
        {
            return value.to_owned();
        }
        let lexical = source_value.trim();
        if !lexical.contains(['\r', '\n']) && !matches!(lexical.chars().next(), Some('"' | '\'')) {
            let syntax = yaml_comment_start(lexical).map_or(lexical, |comment| &lexical[..comment]);
            return syntax.trim_end().to_owned();
        }
        let (parser_source, literal_nel_marker) = mask_literal_nel(source_value);
        let mut scalar = serde_yaml::from_str::<serde_yaml::Value>(&parser_source)
            .ok()
            .and_then(|value| match value {
                serde_yaml::Value::String(value) => Some(value),
                serde_yaml::Value::Bool(value) => Some(value.to_string()),
                serde_yaml::Value::Number(value) => Some(value.to_string()),
                serde_yaml::Value::Null => Some("null".to_owned()),
                _ => None,
            })
            .unwrap_or_else(|| source_value.trim().to_owned());
        if let Some(marker) = literal_nel_marker {
            scalar = scalar.replace(&marker, "\u{0085}");
        }
        scalar
    };
    match tag_name {
        "str" => Value::String(if source_value.trim().is_empty() {
            String::new()
        } else {
            scalar_text()
        }),
        "timestamp" => canonical_timestamp(&scalar_text())
            .map(Value::String)
            .unwrap_or(existing),
        "binary" => decoded_binary(&scalar_text()).unwrap_or(existing),
        "bool" => {
            let scalar = scalar_text();
            match scalar.to_ascii_lowercase().as_str() {
                "true" => Value::Bool(true),
                "false" => Value::Bool(false),
                _ => Value::String(scalar),
            }
        }
        "null" => {
            let scalar = scalar_text();
            if matches!(scalar.as_str(), "" | "~" | "null" | "Null" | "NULL") {
                Value::Null
            } else {
                Value::String(scalar)
            }
        }
        "int" => {
            let scalar = scalar_text();
            if yaml_schema_integer_string(&scalar) {
                Value::String(scalar)
            } else if let Some(canonical) = canonical_set_integer(&scalar, true) {
                let too_large = if canonical.starts_with('-') {
                    canonical.parse::<i64>().is_err()
                } else {
                    canonical.parse::<u64>().is_err()
                };
                if too_large {
                    let mut exact = Map::new();
                    exact.insert(EXACT_INTEGER_KEY.to_owned(), Value::String(canonical));
                    Value::Object(exact)
                } else {
                    canonical
                        .parse::<i64>()
                        .ok()
                        .map(Number::from)
                        .or_else(|| canonical.parse::<u64>().ok().map(Number::from))
                        .map(Value::Number)
                        .unwrap_or(existing)
                }
            } else {
                Value::String(scalar)
            }
        }
        "float" => {
            let scalar = scalar_text();
            match plain_nonfinite_kind(&scalar) {
                Some("inf") => Value::String("Infinity".to_owned()),
                Some("-inf") => Value::String("-Infinity".to_owned()),
                Some("nan") => Value::String("NaN".to_owned()),
                _ if canonical_set_integer(&scalar, true).is_some() => Value::String(scalar),
                _ if existing.is_number() => existing,
                _ => Value::String(scalar),
            }
        }
        "set" => existing
            .as_object()
            .map(|set| Value::Array(set.keys().cloned().map(Value::String).collect::<Vec<_>>()))
            .unwrap_or(existing),
        "map" => {
            let rewritten = rewrite_empty_standard_string_keys(source_value)
                .unwrap_or_else(|| source_value.to_owned());
            let repaired = serde_yaml::from_str::<serde_yaml::Value>(&rewritten)
                .ok()
                .and_then(|parsed| yaml_to_json(parsed).ok())
                .map(normalize_deferred_tagged_mapping_keys);
            normalize_deferred_tagged_mapping_keys(repaired.unwrap_or(existing))
        }
        _ => existing,
    }
}

fn normalize_deferred_tagged_mapping_keys(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut normalized = Map::with_capacity(map.len());
            for (key, value) in map {
                let key = key
                    .strip_prefix("!!str ")
                    .and_then(|source| parsed_string_mapping_key(source, Some("str")))
                    .unwrap_or(key);
                normalized.insert(key, normalize_deferred_tagged_mapping_keys(value));
            }
            Value::Object(normalized)
        }
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(normalize_deferred_tagged_mapping_keys)
                .collect(),
        ),
        value => value,
    }
}

fn rewrite_empty_standard_string_keys(source: &str) -> Option<String> {
    let mut replacements = Vec::new();
    let spans = line_spans(source);
    let parent_collection_tags = parent_collection_tag_flags(source, &spans);
    let block_scalar_ranges = block_scalar_body_ranges(source);
    let quoted_scalar_ranges = multiline_quoted_scalar_ranges(source);
    let plain_scalar_ranges = plain_scalar_value_ranges(source);
    let mut scanner_excluded_ranges = block_scalar_ranges.clone();
    scanner_excluded_ranges.extend(quoted_scalar_ranges);
    scanner_excluded_ranges.extend(plain_scalar_ranges);
    normalize_ranges(&mut scanner_excluded_ranges);
    for (line_index, line) in spans.iter().enumerate() {
        if sorted_range_contains(&scanner_excluded_ranges, line.start) {
            continue;
        }
        let body = &source[line.start..line.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        let indent = body.len() - trimmed.len();
        let sequence_item = trimmed.strip_prefix("- ");
        if let Some(sequence_item) = sequence_item
            && let Some(colon) = mapping_key_colon(sequence_item)
        {
            let syntax = sequence_item[..colon].trim_end_matches([' ', '\t']);
            let (remainder, anchor, tag) = split_node_properties(syntax);
            if remainder.is_empty() && tag == Some("str") {
                let start = line.start + indent + 2;
                let replacement =
                    anchor.map_or_else(|| "\"\"".to_owned(), |name| format!("&{name} \"\""));
                let value = if replacement.len() < syntax.len() {
                    format!(
                        "{replacement}{}",
                        " ".repeat(syntax.len() - replacement.len())
                    )
                } else {
                    replacement
                };
                replacements.push((start, start + syntax.len(), value));
                continue;
            }
        }
        let node = sequence_item.unwrap_or(trimmed);
        if parent_collection_tags[line_index] == Some(true)
            && let Some(colon) = mapping_key_colon(node)
        {
            let syntax = node[..colon].trim_end_matches([' ', '\t']);
            let (remainder, anchor, tag) = split_node_properties(syntax);
            if remainder.is_empty() && tag == Some("str") {
                let node_offset = body.len() - node.len();
                let start = line.start + node_offset;
                let replacement =
                    anchor.map_or_else(|| "\"\"".to_owned(), |name| format!("&{name} \"\""));
                let value = if replacement.len() < syntax.len() {
                    format!(
                        "{replacement}{}",
                        " ".repeat(syntax.len() - replacement.len())
                    )
                } else {
                    replacement
                };
                replacements.push((start, start + syntax.len(), value));
                continue;
            }
        }
        let Some(member) = node.strip_prefix('?').and_then(|remainder| {
            (remainder.is_empty() || remainder.chars().next().is_some_and(char::is_whitespace))
                .then(|| remainder.trim_start())
        }) else {
            continue;
        };
        let syntax = yaml_comment_start(member).map_or(member, |comment| &member[..comment]);
        let syntax = syntax.trim_end_matches([' ', '\t']);
        let member_offset = body.len() - trimmed.len() + trimmed.len() - member.len();
        let mut properties = Vec::new();
        let (remainder, anchor, tag) = split_node_properties(syntax);
        let property_length = syntax.len().saturating_sub(remainder.len());
        if property_length > 0 {
            let start = line.start + member_offset;
            properties.push((
                start,
                start + property_length,
                anchor,
                tag.map(str::to_owned),
            ));
        }
        let inline_value = remainder.strip_prefix(':').is_some_and(|rest| {
            rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
        });
        if !remainder.is_empty() && !inline_value {
            continue;
        }
        let expected_value_indent = indent + if sequence_item.is_some() { 2 } else { 0 };
        let mut value_line = inline_value.then_some((line, expected_value_indent));
        for candidate in spans.iter().skip(line_index + 1) {
            if value_line.is_some() {
                break;
            }
            let candidate_body = &source[candidate.start..candidate.content_end];
            let candidate_trimmed = candidate_body.trim_start_matches([' ', '\t']);
            if candidate_trimmed.is_empty() || candidate_trimmed.starts_with('#') {
                continue;
            }
            if candidate_trimmed.strip_prefix(':').is_some_and(|rest| {
                rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
            }) {
                let candidate_indent = candidate_body.len() - candidate_trimmed.len();
                if candidate_indent >= expected_value_indent {
                    value_line = Some((candidate, candidate_indent));
                }
                break;
            }
            let candidate_syntax = yaml_comment_start(candidate_trimmed)
                .map_or(candidate_trimmed, |comment| &candidate_trimmed[..comment])
                .trim_end_matches([' ', '\t']);
            let (candidate_remainder, candidate_anchor, candidate_tag) =
                split_node_properties(candidate_syntax);
            if !candidate_remainder.is_empty()
                || (candidate_anchor.is_none() && candidate_tag.is_none())
            {
                break;
            }
            let property_start = candidate.start + candidate_body.len() - candidate_trimmed.len();
            properties.push((
                property_start,
                property_start + candidate_syntax.len(),
                candidate_anchor,
                candidate_tag.map(str::to_owned),
            ));
        }
        let Some((candidate, candidate_indent)) = value_line else {
            continue;
        };
        let tag_index = properties
            .iter()
            .position(|(_, _, _, tag)| tag.as_deref() == Some("str"));
        let Some(tag_index) = tag_index else {
            continue;
        };
        let anchor = properties
            .iter()
            .find_map(|(_, _, anchor, _)| anchor.clone());
        let replacement = anchor.map_or_else(|| "\"\"".to_owned(), |name| format!("&{name} \"\""));
        for (index, (start, end, _, _)) in properties.into_iter().enumerate() {
            let width = end - start;
            let value = if index == tag_index {
                if replacement.len() < width {
                    format!("{replacement}{}", " ".repeat(width - replacement.len()))
                } else {
                    replacement.clone()
                }
            } else {
                " ".repeat(width)
            };
            replacements.push((start, end, value));
        }
        if candidate.start != line.start && candidate_indent > expected_value_indent {
            replacements.push((
                candidate.start + expected_value_indent,
                candidate.start + candidate_indent,
                String::new(),
            ));
        }
    }
    for (flow_start, flow_end) in flow_collection_ranges(source)
        .into_iter()
        .filter(|(start, _)| source[*start..].starts_with('{'))
    {
        for (entry_start, entry_end) in top_level_flow_entries(source, flow_start, flow_end) {
            let entry = &source[entry_start..entry_end];
            let leading = entry.len() - entry.trim_start().len();
            let trimmed_entry = entry.trim_start();
            let (key_source, key_offset, explicit_key) = if let Some(remainder) =
                trimmed_entry.strip_prefix('?').and_then(|remainder| {
                    (remainder.is_empty()
                        || remainder.chars().next().is_some_and(char::is_whitespace))
                    .then_some(remainder)
                }) {
                let key_source = remainder.trim_start();
                (
                    key_source,
                    trimmed_entry.len().saturating_sub(key_source.len()),
                    true,
                )
            } else {
                (trimmed_entry, 0, false)
            };
            if key_source.is_empty() {
                continue;
            };
            let Some(colon) = flow_top_level_mapping_colon(key_source, 0, key_source.len()) else {
                continue;
            };
            let syntax = &key_source[..colon];
            let Some(EmptyStringKeyProperties {
                tag_start,
                tag_end,
                anchor,
            }) = multiline_empty_standard_string_key_properties(syntax)
            else {
                continue;
            };
            let absolute = entry_start + leading + key_offset;
            let (property_start, property_end, anchor_name) = anchor.map_or(
                (tag_start, tag_end, None),
                |(anchor_start, anchor_end, name)| {
                    (
                        tag_start.min(anchor_start),
                        tag_end.max(anchor_end),
                        Some(name),
                    )
                },
            );
            let mut replacement = if explicit_key {
                String::new()
            } else {
                "? ".to_owned()
            };
            if let Some(name) = anchor_name {
                replacement.push_str(&format!("&{name} \"\""));
            } else {
                replacement.push_str("\"\"");
            }
            let width = property_end - property_start;
            debug_assert!(replacement.len() <= width);
            replacement.push_str(&" ".repeat(width.saturating_sub(replacement.len())));
            replacements.push((
                absolute + property_start,
                absolute + property_end,
                replacement,
            ));
        }
    }
    if replacements.is_empty() {
        return None;
    }
    replacements.sort_by_key(|(start, end, _)| (*start, *end));
    replacements.dedup_by(|left, right| left.0 == right.0 && left.1 == right.1);
    let mut rewritten = source.to_owned();
    for (start, end, replacement) in replacements.into_iter().rev() {
        rewritten.replace_range(start..end, &replacement);
    }
    Some(rewritten)
}

struct EmptyStringKeyProperties {
    tag_start: usize,
    tag_end: usize,
    anchor: Option<(usize, usize, String)>,
}

fn multiline_empty_standard_string_key_properties(
    source: &str,
) -> Option<EmptyStringKeyProperties> {
    let mut anchor = None;
    let mut tag_span = None;
    for (line_index, line) in line_spans(source).into_iter().enumerate() {
        let body = &source[line.start..line.content_end];
        let syntax_end = yaml_comment_start(body).unwrap_or(body.len());
        let mut cursor = body.len() - body.trim_start_matches([' ', '\t']).len();
        if line_index == 0
            && body[cursor..syntax_end].starts_with('?')
            && body[cursor + 1..syntax_end]
                .chars()
                .next()
                .is_none_or(char::is_whitespace)
        {
            cursor += 1;
        }
        while cursor < syntax_end {
            let whitespace = body[cursor..syntax_end]
                .len()
                .saturating_sub(body[cursor..syntax_end].trim_start().len());
            cursor += whitespace;
            if cursor >= syntax_end {
                break;
            }
            let token_length = node_property_token_length(&body[cursor..syntax_end])?;
            let token = &body[cursor..cursor + token_length];
            if let Some(name) = token.strip_prefix('&') {
                if anchor.is_some() || name.is_empty() {
                    return None;
                }
                anchor = Some((
                    line.start + cursor,
                    line.start + cursor + token_length,
                    name.to_owned(),
                ));
            } else if let Some((name, remainder)) = split_standard_tag_property(token) {
                if !remainder.is_empty() || tag_span.is_some() || name != "str" {
                    return None;
                }
                tag_span = Some((line.start + cursor, line.start + cursor + token_length));
            } else {
                return None;
            }
            cursor += token_length;
        }
    }
    tag_span.map(|(tag_start, tag_end)| EmptyStringKeyProperties {
        tag_start,
        tag_end,
        anchor,
    })
}

fn empty_standard_string_key_anchors(source: &str) -> Vec<String> {
    let spans = line_spans(source);
    spans
        .iter()
        .enumerate()
        .filter_map(|(line_index, line)| {
            let body = &source[line.start..line.content_end];
            let trimmed = body.trim_start_matches([' ', '\t']);
            let indent = body.len() - trimmed.len();
            let member = trimmed.strip_prefix('?').and_then(|remainder| {
                (remainder.is_empty() || remainder.chars().next().is_some_and(char::is_whitespace))
                    .then(|| remainder.trim_start())
            })?;
            let syntax = yaml_comment_start(member).map_or(member, |comment| &member[..comment]);
            let (remainder, mut anchor, initial_tag) = split_node_properties(syntax.trim_end());
            if !remainder.is_empty() {
                return None;
            }
            let mut tag = initial_tag.map(str::to_owned);
            let mut has_value = false;
            for candidate in spans.iter().skip(line_index + 1) {
                let candidate_body = &source[candidate.start..candidate.content_end];
                let candidate_trimmed = candidate_body.trim_start_matches([' ', '\t']);
                if candidate_trimmed.is_empty() || candidate_trimmed.starts_with('#') {
                    continue;
                }
                let candidate_indent = candidate_body.len() - candidate_trimmed.len();
                if candidate_indent == indent
                    && candidate_trimmed.strip_prefix(':').is_some_and(|rest| {
                        rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
                    })
                {
                    has_value = true;
                    break;
                }
                let candidate_syntax = yaml_comment_start(candidate_trimmed)
                    .map_or(candidate_trimmed, |comment| &candidate_trimmed[..comment])
                    .trim_end();
                let (candidate_remainder, candidate_anchor, candidate_tag) =
                    split_node_properties(candidate_syntax);
                if !candidate_remainder.is_empty()
                    || (candidate_anchor.is_none() && candidate_tag.is_none())
                {
                    break;
                }
                if anchor.is_none() {
                    anchor = candidate_anchor;
                }
                if tag.is_none() {
                    tag = candidate_tag.map(str::to_owned);
                }
            }
            (has_value && tag.as_deref() == Some("str"))
                .then_some(anchor)
                .flatten()
        })
        .collect()
}

fn value_without_tag_sources(value: &Value) -> Value {
    match value {
        Value::Array(array) => Value::Array(array.iter().map(value_without_tag_sources).collect()),
        Value::Object(object) => {
            let mut normalized = object
                .iter()
                .map(|(key, value)| (key.clone(), value_without_tag_sources(value)))
                .collect::<Map<_, _>>();
            if object.len() == 1
                && let Some(Value::Object(tagged)) = normalized.get_mut(TAGGED_KEY)
            {
                tagged.remove("source");
            }
            Value::Object(normalized)
        }
        _ => value.clone(),
    }
}

fn value_without_tag_wrappers(value: &Value) -> Value {
    if let Value::Object(object) = value
        && object.len() == 1
        && let Some(Value::Object(tagged)) = object.get(TAGGED_KEY)
        && let Some(semantic) = tagged.get("value")
    {
        return value_without_tag_wrappers(semantic);
    }
    match value {
        Value::Array(array) => Value::Array(array.iter().map(value_without_tag_wrappers).collect()),
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, nested)| (key.clone(), value_without_tag_wrappers(nested)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn semantic_for_standard_set_source(source: &str) -> Option<Value> {
    let synthetic = if source.trim_start().starts_with('{') {
        format!("value: !!set {source}")
    } else {
        let spans = line_spans(source);
        let scalar_ranges = block_scalar_body_ranges(source);
        let following_member_indent = spans
            .iter()
            .enumerate()
            .filter(|(_, line)| !sorted_range_contains(&scalar_ranges, line.start))
            .filter_map(|(index, line)| {
                let body = &source[line.start..line.content_end];
                let trimmed = body.trim_start_matches([' ', '\t']);
                let indent = body.len() - trimmed.len();
                (index > 0
                    && trimmed.strip_prefix('?').is_some_and(|rest| {
                        rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
                    })
                    && spans[1..index].iter().any(|previous| {
                        let previous_body = &source[previous.start..previous.content_end];
                        let previous_trimmed = previous_body.trim_start_matches([' ', '\t']);
                        previous_trimmed.starts_with('#')
                            && previous_body.len() - previous_trimmed.len() < indent
                    }))
                .then_some(indent)
            })
            .min();
        let shift = following_member_indent
            .map(|indent| indent.saturating_sub(2))
            .unwrap_or(0);
        let mut normalized = String::with_capacity(source.len());
        for (index, line) in spans.into_iter().enumerate() {
            let body = &source[line.start..line.content_end];
            let trimmed = body.trim_start_matches([' ', '\t']);
            let indent = body.len() - trimmed.len();
            let remove = if index > 0 && indent >= shift {
                shift
            } else {
                0
            };
            normalized.push_str(&body[remove..]);
            normalized.push_str(&source[line.content_end..line.end]);
        }
        format!("value: !!set\n  {normalized}")
    };
    let rewritten = rewrite_standard_sets_for_serde(&synthetic);
    let parsed = serde_yaml::from_str::<serde_yaml::Value>(&rewritten).ok()?;
    let converted = yaml_to_json(parsed).ok()?;
    converted
        .get("value")?
        .get(TAGGED_KEY)?
        .get("value")
        .map(value_without_tag_sources)
}

fn direct_standard_set_member_sources(source: &str, expected_members: usize) -> Vec<String> {
    if source.trim_start().starts_with('{') {
        let flow_start = source.find('{').unwrap_or(0);
        let flow_end = flow_value_end(source, flow_start);
        return top_level_flow_entries(source, flow_start, flow_end)
            .into_iter()
            .filter_map(|(start, end)| {
                source[start..end]
                    .trim()
                    .strip_prefix('?')
                    .map(|member| member.trim_start().to_owned())
            })
            .take(expected_members)
            .collect();
    }
    let spans = line_spans(source);
    let mut members = spans
        .iter()
        .enumerate()
        .filter_map(|(index, span)| {
            let body = &source[span.start..span.content_end];
            let trimmed = body.trim_start_matches([' ', '\t']);
            let indent = body.len() - trimmed.len();
            trimmed
                .strip_prefix('?')
                .filter(|rest| rest.is_empty() || rest.starts_with(char::is_whitespace))
                .map(|rest| {
                    (
                        index,
                        span.start
                            + indent
                            + 1
                            + rest.len().saturating_sub(rest.trim_start().len()),
                        indent,
                    )
                })
        })
        .collect::<Vec<_>>();
    if let Some((first_line, _, first_indent)) = members.first().copied() {
        let following_indent = (expected_members > 1)
            .then(|| {
                members
                    .iter()
                    .filter(|(line, _, _)| *line != first_line)
                    .map(|(_, _, indent)| *indent)
                    .min()
            })
            .flatten();
        members.retain(|(line, _, indent)| {
            (*line == first_line && *indent == first_indent) || following_indent == Some(*indent)
        });
        members.truncate(expected_members);
    }
    members
        .iter()
        .enumerate()
        .map(|(member_index, (line_index, start, member_indent))| {
            let next = members.get(member_index + 1);
            let mut end = next.map_or(source.len(), |(next_index, _, _)| spans[*next_index].start);
            let separator_indent = next.map_or(*member_indent, |(_, _, indent)| *indent);
            let first_source = &source[*start..spans[*line_index].content_end];
            let (first_remainder, _, _) = split_node_properties(first_source.trim());
            if block_scalar_indicator(first_remainder).is_some()
                && let Some(comment_start) = spans
                    .iter()
                    .skip(*line_index + 1)
                    .take_while(|span| span.start < end)
                    .find_map(|span| {
                        let body = &source[span.start..span.content_end];
                        let trimmed = body.trim_start_matches([' ', '\t']);
                        (trimmed.starts_with('#') && body.len() - trimmed.len() <= separator_indent)
                            .then_some(span.start)
                    })
            {
                end = comment_start;
            }
            let mut member = source[*start..end].to_owned();
            if let Some((next_index, _, _)) = next {
                let next_body = &source[spans[*next_index].start..spans[*next_index].content_end];
                let indentation = next_body.len() - next_body.trim_start_matches([' ', '\t']).len();
                member.push_str(&next_body[..indentation]);
            }
            member
        })
        .collect()
}

fn standard_set_member_properties(member_source: &str) -> (String, Option<String>, Option<String>) {
    let mut anchor_name = None;
    let mut tag_name = None;
    let block_scalar_ranges = block_scalar_body_ranges(member_source);
    for line in line_spans(member_source) {
        if sorted_range_contains(&block_scalar_ranges, line.start) {
            continue;
        }
        let body = &member_source[line.start..line.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.strip_prefix('?').is_some_and(|rest| {
            rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
        }) {
            let lexical_start = line.start + body.len() - trimmed.len();
            return (
                member_source[lexical_start..].to_owned(),
                anchor_name,
                tag_name,
            );
        }
        let (remainder, anchor, tag) = split_node_properties(trimmed);
        if anchor_name.is_none() {
            anchor_name = anchor;
        }
        if tag_name.is_none() {
            tag_name = tag.map(str::to_owned);
        }
        if remainder.is_empty() || remainder.starts_with('#') {
            continue;
        }
        let lexical_start =
            line.start + body.len() - trimmed.len() + trimmed.len() - remainder.len();
        let lexical = if tag_name.as_deref() == Some("set") {
            if remainder.starts_with('{') {
                member_source[lexical_start..flow_value_end(member_source, lexical_start)]
                    .to_owned()
            } else {
                member_source[lexical_start..].to_owned()
            }
        } else if matches!(remainder.chars().next(), Some('|' | '>')) {
            collection_lexical_source(&member_source[lexical_start..])
        } else if matches!(remainder.chars().next(), Some('{' | '[')) {
            member_source[lexical_start..flow_value_end(member_source, lexical_start)].to_owned()
        } else {
            scalar_lexical_source(&member_source[lexical_start..]).to_owned()
        };
        return (lexical, anchor_name, tag_name);
    }
    (String::new(), anchor_name, tag_name)
}

fn indent_yaml_block(source: &str, first_line_indent: usize) -> String {
    let mut indented = String::with_capacity(source.len() + line_spans(source).len() * 2);
    for (index, line) in line_spans(source).into_iter().enumerate() {
        if index == 0 {
            indented.push_str(&" ".repeat(first_line_indent.max(2)));
        }
        indented.push_str(&source[line.start..line.content_end]);
        indented.push_str(&source[line.content_end..line.end]);
    }
    indented
}

fn collection_lexical_source(source: &str) -> String {
    if matches!(source.chars().next(), Some('{' | '[')) {
        return source[..flow_value_end(source, 0)].to_owned();
    }
    let block_scalar_ranges = block_scalar_body_ranges(source);
    let mut last_syntactic_end = 0usize;
    for line in line_spans(source) {
        let in_block_scalar = sorted_range_contains(&block_scalar_ranges, line.start);
        let trimmed = source[line.start..line.content_end].trim_start_matches([' ', '\t']);
        if in_block_scalar || (!trimmed.is_empty() && !trimmed.starts_with('#')) {
            last_syntactic_end = line.end;
        }
    }
    source[..last_syntactic_end]
        .trim_end_matches([' ', '\t'])
        .to_owned()
}

fn restore_deferred_map_member_source(member_source: &str, member: &mut Value) {
    let deferred_map_property = line_spans(member_source).into_iter().any(|line| {
        let body = &member_source[line.start..line.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        let node = trimmed
            .strip_prefix('?')
            .map(str::trim_start)
            .unwrap_or(trimmed);
        let syntax = yaml_comment_start(node)
            .map_or(node, |comment| &node[..comment])
            .trim_end();
        let (remainder, _, tag) = split_node_properties(syntax);
        tag == Some("map") && remainder.is_empty()
    });
    if !deferred_map_property {
        return;
    }
    let excluded_ranges = block_scalar_body_ranges(member_source);
    let mut explicit_key_start = None;
    let Some(source_start) = line_spans(member_source).into_iter().find_map(|line| {
        if sorted_range_contains(&excluded_ranges, line.start) {
            return None;
        }
        let body = &member_source[line.start..line.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            return None;
        }
        let leading = body.len() - trimmed.len();
        if trimmed.starts_with('?') && trimmed[1..].chars().next().is_none_or(char::is_whitespace) {
            let node = trimmed[1..].trim_start();
            let syntax = yaml_comment_start(node).map_or(node, |comment| &node[..comment]);
            let (remainder, _, tag) = split_node_properties(syntax.trim_end());
            if tag == Some("map") && remainder.is_empty() {
                explicit_key_start = None;
            } else {
                explicit_key_start = Some(line.start + leading);
            }
            return None;
        }
        if trimmed.starts_with(':') && trimmed[1..].chars().next().is_none_or(char::is_whitespace) {
            return Some(explicit_key_start.take().unwrap_or(line.start + leading));
        }
        mapping_key_colon(trimmed).map(|colon| {
            explicit_key_start
                .take()
                .unwrap_or(line.start + leading + colon)
        })
    }) else {
        return;
    };
    if let Some(Value::Object(tagged)) = member.get_mut(TAGGED_KEY)
        && tagged.get("tag").and_then(Value::as_str) == Some("tag:yaml.org,2002:map")
    {
        tagged.insert(
            "source".to_owned(),
            Value::String(collection_lexical_source(&member_source[source_start..])),
        );
    }
}

fn tagged_collection_node_location(member_source: &str) -> (usize, usize) {
    line_spans(member_source)
        .into_iter()
        .find_map(|line| {
            let body = &member_source[line.start..line.content_end];
            let trimmed = body.trim_start_matches([' ', '\t']);
            if trimmed.is_empty() || trimmed.starts_with('#') {
                return None;
            }
            let leading = body.len() - trimmed.len();
            let node = trimmed
                .strip_prefix('?')
                .filter(|remainder| {
                    remainder.is_empty()
                        || remainder.chars().next().is_some_and(char::is_whitespace)
                })
                .map(str::trim_start)
                .unwrap_or(trimmed);
            if node.is_empty() || node.starts_with('#') {
                return None;
            }
            let syntax = yaml_comment_start(node)
                .map_or(node, |comment| &node[..comment])
                .trim_end();
            let (remainder, anchor, tag) = split_node_properties(syntax);
            if remainder.is_empty() && (anchor.is_some() || tag.is_some()) {
                return None;
            }
            Some((
                line.start + body.len() - trimmed.len() + trimmed.len() - node.len() + syntax.len()
                    - remainder.len(),
                leading,
            ))
        })
        .unwrap_or_default()
}

fn restore_tagged_collection_member_source(member_source: &str, member: &mut Value) {
    let collection = member
        .get(TAGGED_KEY)
        .and_then(Value::as_object)
        .and_then(|tagged| tagged.get("tag"))
        .and_then(Value::as_str)
        .is_some_and(|tag| {
            matches!(
                tag,
                "tag:yaml.org,2002:map"
                    | "tag:yaml.org,2002:seq"
                    | "tag:yaml.org,2002:omap"
                    | "tag:yaml.org,2002:pairs"
            )
        });
    if collection {
        let (nested_start, _) = tagged_collection_node_location(member_source);
        if let Some(Value::Object(tagged)) = member.get_mut(TAGGED_KEY) {
            tagged.insert(
                "source".to_owned(),
                Value::String(collection_lexical_source(&member_source[nested_start..])),
            );
        }
        restore_deferred_map_member_source(member_source, member);
    }
}

fn restore_collection_set_member_provenance(
    member_source: &str,
    member: &mut Value,
    active_anchors: &std::collections::BTreeMap<String, Value>,
    first_line_indent: usize,
) -> Vec<(String, Value)> {
    if let Some(Value::Object(tagged)) = member.get_mut(TAGGED_KEY)
        && tagged
            .get("tag")
            .and_then(Value::as_str)
            .is_some_and(|tag| {
                matches!(
                    tag,
                    "tag:yaml.org,2002:map"
                        | "tag:yaml.org,2002:seq"
                        | "tag:yaml.org,2002:omap"
                        | "tag:yaml.org,2002:pairs"
                )
            })
    {
        let (nested_start, nested_indent) = tagged_collection_node_location(member_source);
        let lexical = collection_lexical_source(&member_source[nested_start..]);
        let mut restored = if let Some(semantic) = tagged.get_mut("value")
            && matches!(semantic, Value::Array(_) | Value::Object(_))
        {
            restore_collection_set_member_provenance(
                &lexical,
                semantic,
                active_anchors,
                nested_indent,
            )
        } else {
            Vec::new()
        };
        restored.extend(
            empty_standard_string_key_anchors(member_source)
                .into_iter()
                .map(|anchor| {
                    let PreservedAnchor::Scalar { value, .. } =
                        preserved_scalar_anchor(String::new(), "", Some("str"))
                    else {
                        unreachable!("scalar anchor constructor returns a scalar anchor")
                    };
                    (anchor, value)
                }),
        );
        tagged.insert("source".to_owned(), Value::String(lexical));
        restore_deferred_map_member_source(member_source, member);
        return restored;
    }
    if !matches!(member, Value::Array(_) | Value::Object(_))
        || member.get(TAGGED_KEY).is_some()
        || !(member_source.contains(['&', '*']) || contains_standard_tag_property(member_source))
    {
        return Vec::new();
    }
    let mut deferred_properties = Vec::new();
    let mut node_location = None;
    for line in line_spans(member_source) {
        let body = &member_source[line.start..line.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let leading = body.len() - trimmed.len();
        let starts_explicit_key = trimmed.strip_prefix('?').is_some_and(|rest| {
            rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
        });
        let explicit_mapping = starts_explicit_key
            && line_spans(member_source)
                .into_iter()
                .filter(|candidate| candidate.start > line.start)
                .any(|candidate| {
                    let candidate_body = &member_source[candidate.start..candidate.content_end];
                    let candidate_trimmed = candidate_body.trim_start_matches([' ', '\t']);
                    let candidate_indent = candidate_body.len() - candidate_trimmed.len();
                    candidate_indent == leading
                        && candidate_trimmed.strip_prefix(':').is_some_and(|rest| {
                            rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
                        })
                });
        if explicit_mapping {
            node_location = Some((line.start + leading, leading));
            break;
        }
        let mut node = trimmed;
        if let Some(after_question) = node.strip_prefix('?')
            && (after_question.is_empty()
                || after_question
                    .chars()
                    .next()
                    .is_some_and(char::is_whitespace))
        {
            node = after_question.trim_start();
        }
        if node.is_empty() || node.starts_with('#') {
            continue;
        }
        let syntax = yaml_comment_start(node)
            .map_or(node, |comment| &node[..comment])
            .trim_end();
        let (remainder, anchor, tag) = split_node_properties(syntax);
        if remainder.is_empty() && (anchor.is_some() || tag.is_some()) {
            deferred_properties.push(syntax.to_owned());
            continue;
        }
        let start = line.start + leading + trimmed.len() - node.len();
        let indent = leading;
        node_location = Some((start, indent));
        break;
    }
    let (node_start, node_indent) = node_location.unwrap_or((0, 0));
    let trimmed = member_source[node_start..].trim_start();
    let (property_remainder, _, _) = split_node_properties(trimmed);
    let properties = deferred_properties.join(" ");
    let node_source = &member_source[node_start..];
    let node_first_indent = node_indent.max(first_line_indent);
    let synthetic = if matches!(property_remainder.chars().next(), Some('{' | '['))
        || (!properties.is_empty() && matches!(trimmed.chars().next(), Some('{' | '[')))
    {
        format!(
            "member: {}{}",
            if properties.is_empty() {
                String::new()
            } else {
                format!("{properties} ")
            },
            trimmed
        )
    } else {
        format!(
            "member:{}\n{}",
            if properties.is_empty() {
                String::new()
            } else {
                format!(" {properties}")
            },
            indent_yaml_block(node_source, node_first_indent),
        )
    };
    let mut local_raw = Map::new();
    local_raw.insert("member".to_owned(), member.clone());
    fn collect_existing_tags(value: &Value, path: &mut Vec<String>, tags: &mut Map<String, Value>) {
        if let Some(tagged) = value.get(TAGGED_KEY).and_then(Value::as_object)
            && let Some(tag) = tagged.get("tag").and_then(Value::as_str)
        {
            let borrowed = path.iter().map(String::as_str).collect::<Vec<_>>();
            tags.insert(explicit_tag_path(&borrowed), Value::String(tag.to_owned()));
            if let Some(semantic) = tagged.get("value") {
                collect_existing_tags(semantic, path, tags);
            }
            return;
        }
        match value {
            Value::Array(values) => {
                for (index, nested) in values.iter().enumerate() {
                    path.push(index.to_string());
                    collect_existing_tags(nested, path, tags);
                    path.pop();
                }
            }
            Value::Object(values) => {
                for (key, nested) in values {
                    path.push(key.clone());
                    collect_existing_tags(nested, path, tags);
                    path.pop();
                }
            }
            _ => {}
        }
    }
    let mut initial_tags = Map::new();
    collect_existing_tags(
        local_raw.get("member").expect("member inserted"),
        &mut vec!["member".to_owned()],
        &mut initial_tags,
    );
    let initial_anchors = active_anchors
        .iter()
        .map(|(name, value)| {
            let explicit_tag = value
                .get(TAGGED_KEY)
                .and_then(Value::as_object)
                .and_then(|tagged| tagged.get("tag"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            (
                name.clone(),
                PreservedAnchor::Scalar {
                    value: value.clone(),
                    explicit_tag,
                },
            )
        })
        .collect();
    let mut local_tags = initial_tags;
    let mut local_anchors = initial_anchors;
    if !properties.is_empty() {
        let nested_synthetic = if matches!(trimmed.chars().next(), Some('{' | '[')) {
            format!("member: {trimmed}")
        } else {
            format!(
                "member:\n{}",
                indent_yaml_block(node_source, node_first_indent)
            )
        };
        let (nested_tags, nested_anchors) = preserve_standard_yaml_tags(
            &nested_synthetic,
            &mut local_raw,
            &local_tags,
            &local_anchors,
            &[],
        );
        for (path, tag) in nested_tags {
            local_tags.insert(path, tag);
        }
        for (name, anchor) in nested_anchors {
            local_anchors.insert(name, anchor);
        }
    }
    let (_, deferred_anchor, deferred_tag) = split_node_properties(&properties);
    let manually_restored_deferred_properties = !properties.is_empty();
    if let Some(tag_name) = deferred_tag
        && let Some(tag_uri) = standard_tag_uri(tag_name)
        && let Some(existing) = local_raw.remove("member")
    {
        let lexical = if matches!(trimmed.chars().next(), Some('{' | '[')) {
            trimmed[..flow_value_end(trimmed, 0)].to_owned()
        } else {
            collection_lexical_source(&member_source[node_start..])
        };
        let mut body = Map::new();
        body.insert("tag".to_owned(), Value::String(tag_uri.to_owned()));
        body.insert(
            "value".to_owned(),
            standard_tag_semantic(tag_name, &lexical, existing),
        );
        body.insert("source".to_owned(), Value::String(lexical));
        let mut wrapper = Map::new();
        wrapper.insert(TAGGED_KEY.to_owned(), Value::Object(body));
        local_raw.insert("member".to_owned(), Value::Object(wrapper));
        local_tags.insert("member".to_owned(), Value::String(tag_uri.to_owned()));
    }
    if let Some(anchor) = deferred_anchor {
        local_anchors.insert(anchor, PreservedAnchor::Path(vec!["member".to_owned()]));
    }
    if let Some(member) = local_raw.get_mut("member") {
        restore_deferred_map_member_source(member_source, member);
    }
    if !manually_restored_deferred_properties {
        let (first_tags, first_anchors) = preserve_standard_yaml_tags(
            &synthetic,
            &mut local_raw,
            &local_tags,
            &local_anchors,
            &[],
        );
        for (path, tag) in first_tags {
            local_tags.insert(path, tag);
        }
        for (name, anchor) in first_anchors {
            local_anchors.insert(name, anchor);
        }
        let (nested_tags, nested_anchors) = preserve_standard_yaml_tags(
            &synthetic,
            &mut local_raw,
            &local_tags,
            &local_anchors,
            &[],
        );
        for (path, tag) in nested_tags {
            local_tags.insert(path, tag);
        }
        for (name, anchor) in nested_anchors {
            local_anchors.insert(name, anchor);
        }
    }
    for anchor in empty_standard_string_key_anchors(member_source) {
        local_anchors.insert(
            anchor,
            preserved_scalar_anchor(String::new(), "", Some("str")),
        );
    }
    let occurrences = yaml_anchor_occurrences_in_ranges(member_source, &[(0, member_source.len())]);
    let mut restored_anchors = Vec::new();
    for (_, name) in occurrences {
        let Some(anchor) = local_anchors.get(&name) else {
            continue;
        };
        let value = match anchor {
            PreservedAnchor::Path(path) => {
                let borrowed = path.iter().map(String::as_str).collect::<Vec<_>>();
                value_at_path(&local_raw, &borrowed, &local_tags).cloned()
            }
            PreservedAnchor::Scalar { value, .. } => Some(value.clone()),
        };
        if let Some(value) = value {
            restored_anchors.push((name, value));
        }
    }
    if let Some(restored) = local_raw.remove("member") {
        *member = restored;
    }
    restored_anchors
}

fn restore_direct_standard_set_member_source(member_source: &str, value: &mut Value) {
    let (lexical, _, tag_name) = standard_set_member_properties(member_source);
    if tag_name.is_none() {
        if value.as_object().is_some_and(|object| {
            object.len() == 1
                && object
                    .get(EXACT_INTEGER_KEY)
                    .and_then(Value::as_str)
                    .is_some()
        }) {
            return;
        }
        let scalar = lexical.trim();
        if let Some(canonical) = canonical_set_integer(scalar, false)
            && canonical != scalar
            && !yaml_schema_integer_string(scalar)
        {
            let already_exact = value.as_object().is_some_and(|object| {
                object.len() == 1
                    && object.get(EXACT_INTEGER_KEY).and_then(Value::as_str)
                        == Some(canonical.as_str())
            });
            if !already_exact && let Ok(normalized) = serde_json::from_str::<Value>(&canonical) {
                *value = normalized;
            }
        }
        return;
    }
    if tag_name.as_deref() == Some("set")
        && let Some(Value::Object(tagged)) = value.get_mut(TAGGED_KEY)
        && tagged.get("tag").and_then(Value::as_str) == Some("tag:yaml.org,2002:set")
    {
        if !lexical.is_empty() {
            tagged.insert("source".to_owned(), Value::String(lexical));
        }
        return;
    }
    if value.is_object()
        && !matches!(tag_name.as_deref(), Some("map" | "seq" | "omap" | "pairs"))
        && standard_set_member_tag_is_mapping_key(member_source)
    {
        // In `? !!str key: value`, the scalar tag belongs to the mapping key. The set member is
        // the mapping itself, so wrapping the whole object would change its semantics.
        return;
    }
    let Some(tag_name) = tag_name else {
        return;
    };
    let Some(tag_uri) = standard_tag_uri(&tag_name) else {
        return;
    };
    if let Some(Value::Object(tagged)) = value.get_mut(TAGGED_KEY)
        && tagged.get("tag").and_then(Value::as_str) == Some(tag_uri)
    {
        if tag_name == "str" && lexical.trim().is_empty() {
            tagged.insert("value".to_owned(), Value::String(String::new()));
        }
        tagged.insert("source".to_owned(), Value::String(lexical));
        return;
    }
    let semantic = standard_tag_semantic(&tag_name, &lexical, value.clone());
    let mut body = Map::new();
    body.insert("tag".to_owned(), Value::String(tag_uri.to_owned()));
    body.insert("value".to_owned(), semantic);
    body.insert("source".to_owned(), Value::String(lexical));
    let mut wrapper = Map::new();
    wrapper.insert(TAGGED_KEY.to_owned(), Value::Object(body));
    *value = Value::Object(wrapper);
}

fn standard_set_member_tag_is_mapping_key(member_source: &str) -> bool {
    let block_scalar_ranges = block_scalar_body_ranges(member_source);
    let spans = line_spans(member_source);
    spans.iter().enumerate().any(|(line_index, line)| {
        if sorted_range_contains(&block_scalar_ranges, line.start) {
            return false;
        }
        let body = &member_source[line.start..line.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            return false;
        }
        let indent = body.len() - trimmed.len();
        let (remainder, _, tag) = split_node_properties(trimmed);
        if tag.is_none() || remainder.starts_with(['{', '[']) {
            return false;
        }
        if mapping_key_colon(remainder).is_some() {
            return true;
        }
        let explicit_key_indent = spans[..line_index]
            .iter()
            .rev()
            .filter_map(|candidate| {
                let candidate_body = &member_source[candidate.start..candidate.content_end];
                let candidate_trimmed = candidate_body.trim_start_matches([' ', '\t']);
                if candidate_trimmed.is_empty() || candidate_trimmed.starts_with('#') {
                    return None;
                }
                let candidate_indent = candidate_body.len() - candidate_trimmed.len();
                (candidate_indent < indent
                    && candidate_trimmed.strip_prefix('?').is_some_and(|rest| {
                        rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
                    }))
                .then_some(candidate_indent)
            })
            .next();
        explicit_key_indent.is_some_and(|key_indent| {
            spans[line_index + 1..].iter().find_map(|candidate| {
                let candidate_body = &member_source[candidate.start..candidate.content_end];
                let candidate_trimmed = candidate_body.trim_start_matches([' ', '\t']);
                if candidate_trimmed.is_empty() || candidate_trimmed.starts_with('#') {
                    return None;
                }
                let candidate_indent = candidate_body.len() - candidate_trimmed.len();
                if candidate_indent < key_indent {
                    return Some(false);
                }
                (candidate_indent == key_indent).then(|| {
                    candidate_trimmed.strip_prefix(':').is_some_and(|rest| {
                        rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
                    })
                })
            }) == Some(true)
        })
    })
}

fn restore_nested_standard_set_member_sources(
    value: &mut Value,
    anchors: &mut std::collections::BTreeMap<String, Value>,
    anchor_events: &mut Vec<(String, Value)>,
    restore_collection_provenance: bool,
) {
    if let Value::Object(object) = value {
        if object.len() == 1
            && let Some(Value::Object(body)) = object.get_mut(TAGGED_KEY)
            && body.get("tag").and_then(Value::as_str) == Some("tag:yaml.org,2002:set")
        {
            let expected_members = body
                .get("value")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            let sources = body
                .get("source")
                .and_then(Value::as_str)
                .map(|source| direct_standard_set_member_sources(source, expected_members))
                .unwrap_or_default();
            if let Some(Value::Array(members)) = body.get_mut("value") {
                for (index, member) in members.iter_mut().enumerate() {
                    let mut member_anchor = None;
                    let mut member_anchor_event_index = None;
                    let mut nested_member_anchors = Vec::new();
                    let mut restored_from_alias = false;
                    let nested_member_anchor_event_index = anchor_events.len();
                    if let Some(source) = sources.get(index) {
                        let (lexical, anchor, _) = standard_set_member_properties(source);
                        if let Some(alias) = lexical.strip_prefix('*').map(str::trim)
                            && let Some(anchored) = anchors.get(alias)
                        {
                            *member = anchored.clone();
                            restored_from_alias = true;
                        } else {
                            restore_direct_standard_set_member_source(source, member);
                            if restore_collection_provenance {
                                nested_member_anchors = restore_collection_set_member_provenance(
                                    source, member, anchors, 0,
                                );
                            }
                            member_anchor_event_index =
                                anchor.as_ref().map(|_| anchor_events.len());
                            member_anchor = anchor;
                        }
                    }
                    restore_nested_standard_set_member_sources(
                        member,
                        anchors,
                        anchor_events,
                        restore_collection_provenance,
                    );
                    if !restored_from_alias && let Some(source) = sources.get(index) {
                        restore_tagged_collection_member_source(source, member);
                    }
                    for (event_offset, (anchor, value)) in
                        nested_member_anchors.into_iter().enumerate()
                    {
                        anchors.insert(anchor.clone(), value.clone());
                        anchor_events.insert(
                            nested_member_anchor_event_index + event_offset,
                            (anchor, value),
                        );
                    }
                    if let Some(anchor) = member_anchor {
                        anchors.insert(anchor.clone(), member.clone());
                        anchor_events.insert(
                            member_anchor_event_index.unwrap_or(anchor_events.len()),
                            (anchor, member.clone()),
                        );
                    }
                }
            }
            return;
        }
        for nested in object.values_mut() {
            restore_nested_standard_set_member_sources(
                nested,
                anchors,
                anchor_events,
                restore_collection_provenance,
            );
        }
    } else if let Value::Array(array) = value {
        for nested in array {
            restore_nested_standard_set_member_sources(
                nested,
                anchors,
                anchor_events,
                restore_collection_provenance,
            );
        }
    }
}

fn restore_standard_set_sources(
    source: &str,
    raw: &mut Map<String, Value>,
    restore_collection_provenance: bool,
    initial_anchors: &std::collections::BTreeMap<String, Value>,
) -> Vec<(String, PreservedAnchor)> {
    let spans = line_spans(source);
    let mut excluded_ranges = block_scalar_body_ranges(source);
    excluded_ranges.extend(multiline_quoted_scalar_ranges(source));
    normalize_ranges(&mut excluded_ranges);
    let mut occurrences = source
        .match_indices("!!set")
        .map(|(start, tag)| (start, start + tag.len()))
        .chain(
            source
                .match_indices("!<tag:yaml.org,2002:set>")
                .map(|(start, tag)| (start, start + tag.len())),
        )
        .collect::<Vec<_>>();
    occurrences.sort_unstable();
    let mut lexical_sources = Vec::new();
    for (tag_start, tag_end) in occurrences {
        if sorted_range_contains(&excluded_ranges, tag_start) {
            continue;
        }
        let Some((line_index, span)) = spans
            .iter()
            .enumerate()
            .find(|(_, span)| span.start <= tag_start && tag_start < span.content_end)
        else {
            continue;
        };
        let line = &source[span.start..span.content_end];
        let prefix = &line[..tag_start - span.start];
        if yaml_comment_start(prefix).is_some() || !yaml_prefix_ends_outside_quotes(prefix) {
            continue;
        }
        let node_start = prefix
            .char_indices()
            .rev()
            .find_map(|(position, character)| {
                matches!(character, ':' | ',' | '[' | '{' | '?').then_some(position + 1)
            })
            .or_else(|| {
                prefix
                    .trim_start()
                    .strip_prefix("- ")
                    .map(|_| prefix.find("- ").unwrap_or(0) + 2)
            })
            .unwrap_or(0);
        let node_prefix = prefix[node_start..].trim();
        if !node_prefix.is_empty()
            && !node_prefix
                .split_whitespace()
                .all(|property| property.starts_with(['&', '!']))
        {
            continue;
        }
        let after_tag = line[tag_end - span.start..].trim_start();
        let (remainder, _, _) = split_node_properties(after_tag);
        let mut parent_indent = line.len() - line.trim_start_matches([' ', '\t']).len();
        let trimmed_line = line.trim_start_matches([' ', '\t']);
        if trimmed_line
            .strip_prefix("- ")
            .and_then(mapping_key_colon)
            .is_some()
        {
            parent_indent += 2;
        }
        if prefix.trim().is_empty()
            && (remainder.is_empty() || remainder.starts_with('#'))
            && let Some(deferred_parent_indent) =
                spans[..line_index].iter().rev().find_map(|previous| {
                    let body = &source[previous.start..previous.content_end];
                    let syntax = yaml_comment_start(body).map_or(body, |comment| &body[..comment]);
                    let trimmed = syntax.trim();
                    if trimmed.is_empty() || trimmed.starts_with('#') {
                        return None;
                    }
                    let node_source = if let Some(item) = trimmed.strip_prefix("- ") {
                        if let Some(colon) = mapping_key_colon(item) {
                            item[colon + 1..].trim_start()
                        } else {
                            item
                        }
                    } else if let Some(colon) = mapping_key_colon(trimmed) {
                        trimmed[colon + 1..].trim_start()
                    } else {
                        trimmed
                            .strip_prefix('?')
                            .map(str::trim_start)
                            .unwrap_or(trimmed)
                    };
                    let (property_remainder, anchor, tag) = split_node_properties(node_source);
                    if property_remainder.is_empty() && (anchor.is_some() || tag.is_some()) {
                        Some(body.len() - body.trim_start_matches([' ', '\t']).len())
                    } else {
                        None
                    }
                })
        {
            parent_indent = deferred_parent_indent;
        }
        let lexical = if remainder.is_empty() || remainder.starts_with('#') {
            let end = direct_block_node_end(source, &spans, line_index, parent_indent);
            spans
                .iter()
                .skip(line_index + 1)
                .take_while(|candidate| candidate.start < end)
                .find_map(|candidate| {
                    let body = &source[candidate.start..candidate.content_end];
                    let trimmed = body.trim_start_matches([' ', '\t']);
                    if trimmed.is_empty() || trimmed.starts_with('#') {
                        return None;
                    }
                    let (deferred_remainder, _, _) = split_node_properties(trimmed);
                    if deferred_remainder.is_empty() || deferred_remainder.starts_with('#') {
                        return None;
                    }
                    Some({
                        let base_start = candidate.start + body.len() - trimmed.len()
                            + trimmed.len()
                            - deferred_remainder.len();
                        if deferred_remainder.starts_with('{') {
                            let start = base_start;
                            return Some(source[start..flow_value_end(source, start)].to_owned());
                        }
                        let start = base_start;
                        let mut lexical = source[start..end].to_owned();
                        if lexical.trim() != "?"
                            && let Some(boundary) = spans.iter().find(|span| span.start == end)
                        {
                            let boundary_body = &source[boundary.start..boundary.content_end];
                            let boundary_indent = boundary_body.len()
                                - boundary_body.trim_start_matches([' ', '\t']).len();
                            lexical.push_str(&boundary_body[..boundary_indent]);
                        }
                        lexical
                    })
                })
                .unwrap_or_default()
        } else if remainder.starts_with('{') {
            let relative = line
                .find(remainder)
                .unwrap_or_else(|| line.len().saturating_sub(remainder.len()));
            let start = span.start + relative;
            source[start..flow_value_end(source, start)].to_owned()
        } else if matches!(remainder.chars().next(), Some('"' | '\'')) {
            let relative = line
                .find(remainder)
                .unwrap_or_else(|| line.len().saturating_sub(remainder.len()));
            scalar_lexical_source(&source[span.start + relative..]).to_owned()
        } else {
            scalar_lexical_source(remainder).to_owned()
        };
        lexical_sources.push(lexical);
    }
    let lexical_semantics = lexical_sources
        .iter()
        .map(|source| semantic_for_standard_set_source(source))
        .collect::<Vec<_>>();

    fn source_matches_with_boundary(restored: &str, existing: &str) -> bool {
        if restored == existing || restored.trim_end() == existing.trim_end() {
            return true;
        }
        if existing.trim() == "?"
            && restored
                .trim_start()
                .strip_prefix('?')
                .is_some_and(|remainder| remainder.starts_with(['\r', '\n']))
        {
            return true;
        }
        let Some(boundary) = restored.strip_prefix(existing) else {
            return false;
        };
        let significant = boundary
            .lines()
            .find(|line| !line.trim().is_empty() && !line.trim_start().starts_with('#'));
        significant.is_none_or(|line| line.trim_start().starts_with(':'))
    }

    fn reserve_existing_sources(
        value: &mut Value,
        sources: &[String],
        semantics: &[Option<Value>],
        used: &mut [bool],
    ) {
        if let Value::Object(object) = value {
            if object.len() == 1
                && let Some(Value::Object(body)) = object.get_mut(TAGGED_KEY)
                && body.get("tag").and_then(Value::as_str) == Some("tag:yaml.org,2002:set")
            {
                if let Some(existing) = body
                    .get("source")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    && let Some(index) = sources.iter().enumerate().position(|(index, source)| {
                        let restored = restored_standard_set_source(source);
                        let target = body.get("value").map(value_without_tag_sources);
                        !used[index]
                            && (target
                                .as_ref()
                                .is_some_and(|target| semantics[index].as_ref() == Some(target))
                                || semantics[index].is_none()
                                || (existing.trim() == "?"
                                    && target.as_ref().is_some_and(|target| {
                                        semantics[index].as_ref().is_some_and(|semantic| {
                                            value_without_tag_wrappers(target)
                                                == value_without_tag_wrappers(semantic)
                                        })
                                    }))
                                || contains_standard_tag_property(&existing))
                            && source_matches_with_boundary(&restored, &existing)
                    })
                {
                    used[index] = true;
                    let source = restored_standard_set_source(&sources[index]);
                    if source != existing {
                        body.insert("source".to_owned(), Value::String(source));
                    }
                    body.insert(SET_SOURCE_RESERVED_KEY.to_owned(), Value::Bool(true));
                }
                if let Some(semantic) = body.get_mut("value") {
                    reserve_existing_sources(semantic, sources, semantics, used);
                }
                return;
            }
            for nested in object.values_mut() {
                reserve_existing_sources(nested, sources, semantics, used);
            }
        } else if let Value::Array(array) = value {
            for nested in array {
                reserve_existing_sources(nested, sources, semantics, used);
            }
        }
    }

    fn fill_missing_sources(
        value: &mut Value,
        sources: &[String],
        semantics: &[Option<Value>],
        used: &mut [bool],
    ) {
        if let Value::Object(object) = value {
            if object.len() == 1
                && let Some(Value::Object(body)) = object.get_mut(TAGGED_KEY)
                && body.get("tag").and_then(Value::as_str) == Some("tag:yaml.org,2002:set")
            {
                let source_reserved = body.remove(SET_SOURCE_RESERVED_KEY).is_some();
                if !source_reserved
                    && let Some((index, source)) = {
                        let target = body.get("value").map(value_without_tag_sources);
                        sources.iter().enumerate().find(|(index, _)| {
                            !used[*index]
                                && target.as_ref().is_some_and(|target| {
                                    semantics[*index].as_ref() == Some(target)
                                })
                        })
                    }
                {
                    used[index] = true;
                    let source = restored_standard_set_source(source);
                    body.insert("source".to_owned(), Value::String(source));
                }
                if let Some(semantic) = body.get_mut("value") {
                    fill_missing_sources(semantic, sources, semantics, used);
                }
                return;
            }
            for nested in object.values_mut() {
                fill_missing_sources(nested, sources, semantics, used);
            }
        } else if let Value::Array(array) = value {
            for nested in array {
                fill_missing_sources(nested, sources, semantics, used);
            }
        }
    }

    let mut used = vec![false; lexical_sources.len()];
    for value in raw.values_mut() {
        reserve_existing_sources(value, &lexical_sources, &lexical_semantics, &mut used);
    }
    for value in raw.values_mut() {
        fill_missing_sources(value, &lexical_sources, &lexical_semantics, &mut used);
    }
    let mut member_anchors = initial_anchors.clone();
    let mut member_anchor_events = Vec::new();
    for value in raw.values_mut() {
        restore_nested_standard_set_member_sources(
            value,
            &mut member_anchors,
            &mut member_anchor_events,
            restore_collection_provenance,
        );
    }
    member_anchor_events
        .into_iter()
        .map(|(name, value)| {
            let explicit_tag = value
                .get(TAGGED_KEY)
                .and_then(Value::as_object)
                .and_then(|tagged| tagged.get("tag"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            (
                name,
                PreservedAnchor::Scalar {
                    value,
                    explicit_tag,
                },
            )
        })
        .collect()
}

fn preserve_flow_standard_yaml_tags(
    source: &str,
    absolute_start: usize,
    base_path: &[&str],
    raw: &mut Map<String, Value>,
    explicit_tags: &mut Map<String, Value>,
    anchors: &mut std::collections::BTreeMap<String, PreservedAnchor>,
    set_anchor_events: &[(usize, String, PreservedAnchor)],
) {
    let event_index = set_anchor_events.partition_point(|(offset, _, _)| *offset < absolute_start);
    let mut scanner = FlowTagScanner {
        source,
        absolute_start,
        cursor: 0,
        set_anchor_events,
        event_index,
        raw,
        explicit_tags,
        anchors,
        recovering_set_member: false,
    };
    let mut path = base_path
        .iter()
        .map(|segment| (*segment).to_owned())
        .collect::<Vec<_>>();
    scanner.parse_value(&mut path);
}

struct FlowTagScanner<'source, 'model> {
    source: &'source str,
    absolute_start: usize,
    cursor: usize,
    set_anchor_events: &'source [(usize, String, PreservedAnchor)],
    event_index: usize,
    raw: &'model mut Map<String, Value>,
    explicit_tags: &'model mut Map<String, Value>,
    anchors: &'model mut std::collections::BTreeMap<String, PreservedAnchor>,
    recovering_set_member: bool,
}

impl FlowTagScanner<'_, '_> {
    fn activate_set_anchors_before(&mut self, relative_offset: usize) {
        let absolute_offset = self.absolute_start + relative_offset;
        while let Some((offset, name, anchor)) = self.set_anchor_events.get(self.event_index)
            && *offset < absolute_offset
        {
            self.anchors.insert(name.clone(), anchor.clone());
            self.event_index += 1;
        }
    }

    fn parse_value(&mut self, path: &mut Vec<String>) {
        self.skip_whitespace();
        self.activate_set_anchors_before(self.cursor);
        let mut tag_name = None;
        let mut anchor_name = None;
        for _ in 0..2 {
            if let Some(name) = self.consume_standard_tag_property() {
                tag_name = Some(name);
                self.skip_whitespace();
                continue;
            }
            if self.peek() == Some('&') {
                self.advance();
                let anchor_start = self.cursor;
                self.consume_while(|character| {
                    !character.is_whitespace() && !matches!(character, ',' | '}' | ']')
                });
                anchor_name = Some(self.source[anchor_start..self.cursor].to_owned());
                self.skip_whitespace();
                continue;
            }
            break;
        }
        if let Some(anchor_name) = anchor_name {
            self.anchors
                .insert(anchor_name, PreservedAnchor::Path(path.clone()));
        }
        if let Some(tag_name) = tag_name {
            self.skip_whitespace();
            let value_start = self.cursor;
            if tag_name == "set" && self.peek() == Some('{') {
                self.parse_set(path);
            } else {
                self.parse_untagged_value(path);
            }
            let source_value = self.source[value_start..self.cursor].trim().to_owned();
            if self.recovering_set_member {
                return;
            }
            let borrowed = path.iter().map(String::as_str).collect::<Vec<_>>();
            let Some(existing) = value_at_path(self.raw, &borrowed, self.explicit_tags).cloned()
            else {
                return;
            };
            let Some(tag_uri) = standard_tag_uri(&tag_name) else {
                return;
            };
            let already_wrapped = existing
                .get(TAGGED_KEY)
                .and_then(Value::as_object)
                .and_then(|tagged| tagged.get("tag"))
                .and_then(Value::as_str)
                == Some(tag_uri);
            let existing = if already_wrapped
                || self
                    .explicit_tags
                    .contains_key(&explicit_tag_path(&borrowed))
            {
                semantic_value(&existing).clone()
            } else {
                existing
            };
            let semantic = standard_tag_semantic(&tag_name, &source_value, existing);
            let mut body = Map::new();
            body.insert("tag".to_owned(), Value::String(tag_uri.to_owned()));
            body.insert("value".to_owned(), semantic);
            body.insert("source".to_owned(), Value::String(source_value));
            let mut wrapper = Map::new();
            wrapper.insert(TAGGED_KEY.to_owned(), Value::Object(body));
            let wrapped = Value::Object(wrapper);
            set_value_at_path(self.raw, &borrowed, wrapped.clone(), self.explicit_tags);
            self.explicit_tags.insert(
                explicit_tag_path(&borrowed),
                Value::String(tag_uri.to_owned()),
            );
            return;
        }
        if self.remaining().starts_with('*') {
            let alias_start = self.cursor + 1;
            let alias_end = yaml_anchor_name_end(self.source, alias_start);
            let alias_name = self.source[alias_start..alias_end].to_owned();
            apply_tagged_alias(
                self.raw,
                self.explicit_tags,
                self.anchors,
                &alias_name,
                path,
            );
            self.cursor = alias_end;
            return;
        }
        self.parse_untagged_value(path);
    }

    fn parse_set(&mut self, path: &mut Vec<String>) {
        let start = self.cursor;
        let end = flow_value_end(self.source, start);
        for (index, (entry_start, entry_end)) in top_level_flow_entries(self.source, start, end)
            .into_iter()
            .enumerate()
        {
            self.activate_set_anchors_before(entry_start);
            let entry_source = &self.source[entry_start..entry_end];
            let leading = entry_source.len() - entry_source.trim_start().len();
            let entry = entry_source.trim_start();
            let member = entry
                .strip_prefix('?')
                .map(str::trim_start)
                .unwrap_or(entry);
            let member_offset = entry_start + leading + entry.len().saturating_sub(member.len());
            path.push(index.to_string());
            let (remainder, _, _) = split_node_properties(member);
            let collection_wraps_set = matches!(remainder.chars().next(), Some('[' | '{'))
                && (remainder.contains("!!set") || remainder.contains("!<tag:yaml.org,2002:set>"));
            if collection_wraps_set {
                self.cursor = member_offset;
                let previous_recovery = self.recovering_set_member;
                self.recovering_set_member = true;
                self.parse_value(path);
                self.recovering_set_member = previous_recovery;
            } else if let Some(alias) = remainder.strip_prefix('*').map(str::trim) {
                apply_tagged_alias(self.raw, self.explicit_tags, self.anchors, alias, path);
            }
            let member_path =
                explicit_tag_path(&path.iter().map(String::as_str).collect::<Vec<_>>());
            self.explicit_tags.remove(&member_path);
            path.pop();
            self.activate_set_anchors_before(entry_end);
        }
        self.activate_set_anchors_before(end);
        self.cursor = end;
    }

    fn parse_untagged_value(&mut self, path: &mut Vec<String>) {
        self.skip_whitespace();
        match self.peek() {
            Some('{') => self.parse_mapping(path),
            Some('[') => self.parse_sequence(path),
            Some('"' | '\'') => self.consume_quoted(),
            Some(_) => self.consume_plain_scalar(),
            None => {}
        }
    }

    fn consume_plain_scalar(&mut self) {
        let start = self.cursor;
        while let Some(character) = self.peek() {
            if matches!(character, ',' | '}' | ']') {
                return;
            }
            if character == '#'
                && (self.cursor == start
                    || self.source[..self.cursor]
                        .chars()
                        .next_back()
                        .is_some_and(char::is_whitespace))
            {
                return;
            }
            self.advance();
        }
    }

    fn parse_mapping(&mut self, path: &mut Vec<String>) {
        self.advance();
        loop {
            self.skip_whitespace();
            if self.peek() == Some('}') {
                self.advance();
                return;
            }
            if self.peek() == Some('?')
                && self.source[self.cursor + 1..]
                    .chars()
                    .next()
                    .is_some_and(char::is_whitespace)
            {
                self.advance();
                self.skip_whitespace();
            }
            let key_start = self.cursor;
            let Some(colon) = flow_mapping_colon(self.source, key_start, self.source.len()) else {
                return;
            };
            let key_source = self.source[key_start..colon].trim();
            let (plain_key_source, anchor_name, tag_name) = flow_mapping_key_parts(key_source);
            let key = parsed_string_mapping_key(plain_key_source, tag_name)
                .unwrap_or_else(|| plain_key_source.trim_matches(['\'', '"']).to_owned());
            if let Some(anchor_name) = anchor_name {
                self.anchors.insert(
                    anchor_name,
                    preserved_scalar_anchor(key.clone(), plain_key_source.trim(), tag_name),
                );
            }
            self.cursor = colon + 1;
            path.push(key);
            self.parse_value(path);
            path.pop();
            self.skip_whitespace();
            match self.peek() {
                Some(',') => {
                    self.advance();
                }
                Some('}') => {
                    self.advance();
                    return;
                }
                _ => return,
            }
        }
    }

    fn parse_sequence(&mut self, path: &mut Vec<String>) {
        self.advance();
        let mut index = 0usize;
        loop {
            self.skip_whitespace();
            if self.peek() == Some(']') {
                self.advance();
                return;
            }
            path.push(index.to_string());
            let (item_end, _) = flow_mapping_value_end(self.source, self.cursor, self.source.len());
            let compact_mapping_colon = (!matches!(self.peek(), Some('{' | '[')))
                .then(|| flow_top_level_mapping_colon(self.source, self.cursor, item_end))
                .flatten();
            if let Some(colon) = compact_mapping_colon {
                let key_source = self.source[self.cursor..colon].trim();
                let (plain_key_source, anchor_name, tag_name) = flow_mapping_key_parts(key_source);
                let key = parsed_string_mapping_key(plain_key_source, tag_name)
                    .unwrap_or_else(|| plain_key_source.trim_matches(['\'', '"']).to_owned());
                if let Some(anchor_name) = anchor_name {
                    self.anchors.insert(
                        anchor_name,
                        preserved_scalar_anchor(key.clone(), plain_key_source.trim(), tag_name),
                    );
                }
                self.cursor = colon + 1;
                path.push(key);
                self.parse_value(path);
                path.pop();
            } else {
                self.parse_value(path);
            }
            path.pop();
            index += 1;
            self.skip_whitespace();
            match self.peek() {
                Some(',') => {
                    self.advance();
                }
                Some(']') => {
                    self.advance();
                    return;
                }
                _ => return,
            }
        }
    }

    fn consume_quoted(&mut self) {
        let Some(quote) = self.advance() else {
            return;
        };
        let mut escaped = false;
        while let Some(character) = self.advance() {
            if quote == '"' && character == '\\' && !escaped {
                escaped = true;
                continue;
            }
            if character == quote && !escaped {
                if quote == '\'' && self.peek() == Some('\'') {
                    self.advance();
                    continue;
                }
                return;
            }
            escaped = false;
        }
    }

    fn consume_standard_tag_property(&mut self) -> Option<String> {
        if self.remaining().starts_with("!!") {
            self.cursor += 2;
            let tag_start = self.cursor;
            self.consume_while(|character| {
                !character.is_whitespace() && !matches!(character, ',' | '}' | ']')
            });
            return Some(self.source[tag_start..self.cursor].to_owned());
        }
        let verbatim = self.remaining().strip_prefix("!<")?;
        let end = verbatim.find('>')?;
        let tag_uri = &verbatim[..end];
        let tag_name = tag_uri.strip_prefix("tag:yaml.org,2002:")?.to_owned();
        self.cursor += 2 + end + 1;
        Some(tag_name)
    }

    fn consume_while(&mut self, predicate: impl Fn(char) -> bool) {
        while let Some(character) = self.peek() {
            if !predicate(character) {
                break;
            }
            self.advance();
        }
    }

    fn skip_whitespace(&mut self) {
        loop {
            self.consume_while(char::is_whitespace);
            if self.peek() != Some('#') {
                return;
            }
            self.consume_while(|character| !matches!(character, '\r' | '\n'));
        }
    }

    fn remaining(&self) -> &str {
        &self.source[self.cursor..]
    }

    fn peek(&self) -> Option<char> {
        self.remaining().chars().next()
    }

    fn advance(&mut self) -> Option<char> {
        let character = self.peek()?;
        self.cursor += character.len_utf8();
        Some(character)
    }
}

fn explicit_tag_path(path: &[&str]) -> String {
    if path.len() == 1 {
        return path[0].to_owned();
    }
    format!(
        "/{}",
        path.iter()
            .map(|segment| segment.replace('~', "~0").replace('/', "~1"))
            .collect::<Vec<_>>()
            .join("/")
    )
}

fn standard_tag_uri(tag_name: &str) -> Option<&'static str> {
    Some(match tag_name {
        "str" => "tag:yaml.org,2002:str",
        "int" => "tag:yaml.org,2002:int",
        "float" => "tag:yaml.org,2002:float",
        "bool" => "tag:yaml.org,2002:bool",
        "null" => "tag:yaml.org,2002:null",
        "seq" => "tag:yaml.org,2002:seq",
        "map" => "tag:yaml.org,2002:map",
        "timestamp" => "tag:yaml.org,2002:timestamp",
        "binary" => "tag:yaml.org,2002:binary",
        "set" => "tag:yaml.org,2002:set",
        "omap" => "tag:yaml.org,2002:omap",
        "pairs" => "tag:yaml.org,2002:pairs",
        _ => return None,
    })
}

fn internal_standard_tag(tag: &str) -> Option<&'static str> {
    Some(match tag {
        "!oset" => "tag:yaml.org,2002:set",
        "!ostr" => "tag:yaml.org,2002:str",
        "!obool" => "tag:yaml.org,2002:bool",
        "!oint" => "tag:yaml.org,2002:int",
        "!ofloat" => "tag:yaml.org,2002:float",
        "!onull" => "tag:yaml.org,2002:null",
        _ => return None,
    })
}

fn semantic_value(value: &Value) -> &Value {
    value
        .as_object()
        .and_then(|wrapper| wrapper.get(TAGGED_KEY))
        .and_then(Value::as_object)
        .and_then(|body| body.get("value"))
        .unwrap_or(value)
}

fn normalized_string<'a>(
    raw: &'a Map<String, Value>,
    explicit_tags: &Map<String, Value>,
    key: &str,
) -> Option<&'a str> {
    let value = raw.get(key)?;
    if explicit_tags.contains_key(key) {
        semantic_value(value).as_str()
    } else {
        value.as_str()
    }
}

fn value_at_path<'a>(
    root: &'a Map<String, Value>,
    path: &[&str],
    explicit_tags: &Map<String, Value>,
) -> Option<&'a Value> {
    let (first, rest) = path.split_first()?;
    let mut value = root.get(*first)?;
    let mut current_path = vec![*first];
    for segment in rest {
        if explicit_tags.contains_key(&explicit_tag_path(&current_path)) {
            value = semantic_value(value);
        }
        value = if let Some(object) = value.as_object() {
            object.get(*segment)?
        } else {
            value.as_array()?.get(segment.parse::<usize>().ok()?)?
        };
        current_path.push(*segment);
    }
    Some(value)
}

fn set_value_at_path(
    root: &mut Map<String, Value>,
    path: &[&str],
    value: Value,
    explicit_tags: &Map<String, Value>,
) {
    let Some((first, rest)) = path.split_first() else {
        return;
    };
    let Some(current) = root.get_mut(*first) else {
        return;
    };
    set_nested_value(current, rest, value, explicit_tags, &mut vec![*first], true);
}

fn set_nested_value<'path>(
    current: &mut Value,
    path: &[&'path str],
    value: Value,
    explicit_tags: &Map<String, Value>,
    current_path: &mut Vec<&'path str>,
    allow_unwrap: bool,
) {
    let Some((segment, rest)) = path.split_first() else {
        *current = value;
        return;
    };
    if allow_unwrap
        && explicit_tags.contains_key(&explicit_tag_path(current_path))
        && let Some(tagged_value) = current
            .as_object_mut()
            .and_then(|wrapper| wrapper.get_mut(TAGGED_KEY))
            .and_then(Value::as_object_mut)
            .and_then(|body| body.get_mut("value"))
    {
        set_nested_value(
            tagged_value,
            path,
            value,
            explicit_tags,
            current_path,
            false,
        );
        return;
    }
    current_path.push(*segment);
    match current {
        Value::Object(object) => {
            if let Some(next) = object.get_mut(*segment) {
                set_nested_value(next, rest, value, explicit_tags, current_path, true);
            }
        }
        Value::Array(array) => {
            if let Some(next) = segment
                .parse::<usize>()
                .ok()
                .and_then(|index| array.get_mut(index))
            {
                set_nested_value(next, rest, value, explicit_tags, current_path, true);
            }
        }
        _ => {}
    }
    current_path.pop();
}

fn top_level_field_ranges(text: &str, start: usize, end: usize) -> Map<String, Value> {
    let source = &text[start..end];
    if let Some(flow_start) = root_flow_mapping_start(source) {
        return flow_field_ranges(text, start + flow_start, end);
    }

    let spans = line_spans(source);
    let mut starts = Vec::new();
    let mut root_indent = None;
    for (line_index, line) in spans.iter().enumerate() {
        let body = &source[line.start..line.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        if trimmed.is_empty() || trimmed.starts_with(['#', '-']) {
            continue;
        }
        let indent = body.len() - trimmed.len();
        if let Some(_explicit_key) = trimmed.strip_prefix('?') {
            let expected_indent = *root_indent.get_or_insert(indent);
            let Some((value_index, value_line)) = spans
                .iter()
                .enumerate()
                .skip(line_index + 1)
                .find(|(_, candidate)| {
                    let body = &source[candidate.start..candidate.content_end];
                    let trimmed = body.trim_start_matches([' ', '\t']);
                    let candidate_indent = body.len() - trimmed.len();
                    candidate_indent == expected_indent
                        && trimmed.strip_prefix(':').is_some_and(|rest| {
                            rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
                        })
                })
            else {
                continue;
            };
            let value_body = &source[value_line.start..value_line.content_end];
            let value_trimmed = value_body.trim_start_matches([' ', '\t']);
            let value_indent = value_body.len() - value_trimmed.len();
            if indent != expected_indent || value_indent != expected_indent {
                continue;
            }
            let Some(after_colon) = value_trimmed.strip_prefix(':') else {
                continue;
            };
            let key_start = explicit_key_source_start(source, &spans, line_index, body, trimmed);
            let full_key_source =
                source[key_start..value_line.start].trim_end_matches(['\r', '\n']);
            let Some((plain_key_source, scalar_relative, _, key_tag)) =
                multiline_mapping_key_parts(full_key_source)
            else {
                continue;
            };
            let scalar = scalar_lexical_source(plain_key_source);
            let Some(name) = parsed_string_mapping_key(scalar, key_tag) else {
                continue;
            };
            let leading_whitespace =
                after_colon.len() - after_colon.trim_start_matches([' ', '\t']).len();
            let field_start = start + key_start + scalar_relative;
            let value_start = start + value_line.start + value_indent + 1 + leading_whitespace;
            let value_source = after_colon.trim_start_matches([' ', '\t']);
            let inline_end = if scalar_has_indented_continuation(
                source,
                &spans,
                value_index,
                expected_indent,
                value_source,
            ) {
                multiline_quoted_value_end(text, value_start, end, value_source)
            } else {
                inline_field_value_end(text, value_start, start + value_line.content_end)
            };
            starts.push((
                name,
                field_start,
                value_index,
                inline_end,
                value_source.to_owned(),
                expected_indent,
            ));
            continue;
        }
        let Some(colon) = mapping_key_colon(trimmed) else {
            continue;
        };
        let expected_indent = *root_indent.get_or_insert(indent);
        if indent != expected_indent {
            continue;
        }
        let key_source = trimmed[..colon].trim_end_matches([' ', '\t']);
        let (plain_key_source, _, key_tag) = split_node_properties(key_source);
        let (plain_key_source, bom_width) = plain_key_source
            .strip_prefix('\u{feff}')
            .map_or((plain_key_source, 0), |plain| {
                (plain, '\u{feff}'.len_utf8())
            });
        let Some(name) = parsed_string_mapping_key(plain_key_source, key_tag) else {
            continue;
        };
        let after_colon = &trimmed[colon + 1..];
        let leading_whitespace =
            after_colon.len() - after_colon.trim_start_matches([' ', '\t']).len();
        let line_start = start + line.start + indent;
        let field_start = if plain_key_source.is_empty() && key_tag == Some("str") {
            line_start + colon
        } else {
            line_start
                + key_source
                    .len()
                    .saturating_sub(plain_key_source.len() + bom_width)
                + bom_width
        };
        let value_start = line_start + colon + 1 + leading_whitespace;
        let value_source = after_colon.trim_start_matches([' ', '\t']);
        let inline_end = if scalar_has_indented_continuation(
            source,
            &spans,
            line_index,
            expected_indent,
            value_source,
        ) {
            multiline_quoted_value_end(text, value_start, end, value_source)
        } else {
            inline_field_value_end(text, value_start, start + line.content_end)
        };
        starts.push((
            name,
            field_start,
            line_index,
            inline_end,
            value_source.to_owned(),
            expected_indent,
        ));
    }
    let positions = source_position_index(text);
    let mut fields = Map::new();
    for (index, (name, field_start, line_index, inline_end, value_source, field_indent)) in
        starts.iter().enumerate()
    {
        let next_start = starts
            .get(index + 1)
            .map_or(end, |(_, field_start, _, _, _, _)| *field_start);
        let field_end = inline_end.unwrap_or_else(|| {
            block_field_value_end(
                text,
                start + spans[*line_index].end,
                next_start,
                value_source,
                start + spans[*line_index].content_end,
                *field_indent,
                index + 1 == starts.len(),
            )
        });
        fields.insert(
            name.clone(),
            serde_json::to_value(range_for_with_position_index(
                text,
                *field_start,
                field_end,
                &positions,
            ))
            .unwrap_or(Value::Null),
        );
    }
    fields
}

fn root_flow_mapping_start(source: &str) -> Option<usize> {
    let mut cursor = 0usize;
    loop {
        if source[cursor..].starts_with('\u{feff}') {
            cursor += '\u{feff}'.len_utf8();
        }
        while let Some(character) = source[cursor..].chars().next() {
            if character.is_whitespace() {
                cursor += character.len_utf8();
            } else {
                break;
            }
        }
        if source[cursor..].starts_with('#') {
            cursor += source[cursor..]
                .find(['\r', '\n'])
                .unwrap_or(source.len() - cursor);
            continue;
        }
        if source[cursor..].starts_with('{') {
            return Some(cursor);
        }
        if source[cursor..].starts_with('&') || source[cursor..].starts_with('!') {
            cursor += source[cursor..]
                .find(char::is_whitespace)
                .unwrap_or(source.len() - cursor);
            continue;
        }
        return None;
    }
}

fn mapping_key_colon(source: &str) -> Option<usize> {
    let mut quote = None;
    let mut escaped = false;
    let mut characters = source.char_indices().peekable();
    while let Some((offset, character)) = characters.next() {
        if let Some(active_quote) = quote {
            if active_quote == '"' && character == '\\' && !escaped {
                escaped = true;
                continue;
            }
            if character == active_quote && !escaped {
                if active_quote == '\'' && characters.peek().is_some_and(|(_, next)| *next == '\'')
                {
                    characters.next();
                } else {
                    quote = None;
                }
            }
            escaped = false;
            continue;
        }
        match character {
            '"' | '\'' => quote = Some(character),
            ':' => {
                let next = characters.peek().map(|(_, character)| *character);
                if next.is_none_or(char::is_whitespace) {
                    return Some(offset);
                }
            }
            _ => {}
        }
    }
    None
}

fn structural_mapping_key_colon(source: &str) -> Option<usize> {
    mapping_key_colon(source).filter(|colon| {
        source[colon + 1..]
            .strip_prefix('\u{0085}')
            .is_none_or(|suffix| suffix.trim().is_empty())
    })
}

fn multiline_quoted_value_end(
    text: &str,
    value_start: usize,
    boundary: usize,
    value_source: &str,
) -> Option<usize> {
    let (remainder, anchor_name, tag_name) = split_node_properties(value_source);
    let start = if matches!(remainder.chars().next(), Some('"' | '\'')) {
        value_start + value_source.len().saturating_sub(remainder.len())
    } else {
        if !(remainder.is_empty() || remainder.starts_with('#'))
            || (anchor_name.is_none() && tag_name.is_none())
        {
            return None;
        }
        let tail = &text[value_start..boundary];
        let spans = line_spans(tail);
        let span = spans.iter().skip(1).find(|span| {
            let body = &tail[span.start..span.content_end];
            let trimmed = body.trim_start_matches([' ', '\t']);
            !trimmed.is_empty() && !trimmed.starts_with('#')
        })?;
        let body = &tail[span.start..span.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        let (continued_remainder, _, _) = split_node_properties(trimmed);
        if !matches!(continued_remainder.chars().next(), Some('"' | '\'')) {
            return None;
        }
        value_start
            + span.start
            + body.len().saturating_sub(trimmed.len())
            + trimmed.len().saturating_sub(continued_remainder.len())
    };
    if start >= boundary {
        return None;
    }
    Some(start + scalar_lexical_source(&text[start..boundary]).len())
}

fn scalar_has_indented_continuation(
    source: &str,
    spans: &[LineSpan],
    line_index: usize,
    parent_indent: usize,
    value_source: &str,
) -> bool {
    let (remainder, _, _) = split_node_properties(value_source);
    if remainder.is_empty() || matches!(remainder.chars().next(), Some('{' | '[' | '|' | '>')) {
        return false;
    }
    spans.iter().skip(line_index + 1).find_map(|span| {
        let body = &source[span.start..span.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            return None;
        }
        let indent = body.len() - trimmed.len();
        Some(indent > parent_indent)
    }) == Some(true)
}

fn inline_field_value_end(text: &str, mut start: usize, line_end: usize) -> Option<usize> {
    for _ in 0..2 {
        let value = &text[start..line_end];
        let token_end = if value.starts_with('&') || value.starts_with('!') {
            value.find(char::is_whitespace).unwrap_or(value.len())
        } else {
            break;
        };
        start += token_end;
        start += text[start..line_end].len() - text[start..line_end].trim_start().len();
    }
    let value = &text[start..line_end];
    if value.is_empty() || matches!(value.chars().next(), Some('|' | '>')) {
        return None;
    }
    if matches!(value.chars().next(), Some('{' | '[')) {
        return Some(flow_value_end(text, start));
    }
    Some(start + scalar_lexical_source(value).len())
}

fn block_field_value_end(
    text: &str,
    content_start: usize,
    boundary: usize,
    value_source: &str,
    fallback: usize,
    field_indent: usize,
    preserve_trailing_collection_boundary: bool,
) -> usize {
    if preserve_trailing_collection_boundary && value_source.is_empty() && content_start >= boundary
    {
        return fallback;
    }
    let indicator = block_scalar_indicator(value_source);
    let (remainder, explicit_anchor, explicit_tag) = split_node_properties(value_source);
    let deferred_properties = (remainder.is_empty() || remainder.starts_with('#'))
        && (explicit_anchor.is_some() || explicit_tag.is_some());
    let mut deferred_tag = explicit_tag.map(str::to_owned);
    let deferred_value = deferred_properties
        .then(|| {
            line_spans(&text[content_start..boundary])
                .into_iter()
                .find_map(|line| {
                    let body = &text[content_start + line.start..content_start + line.content_end];
                    let trimmed = body.trim_start_matches([' ', '\t']);
                    if trimmed.is_empty() || trimmed.starts_with('#') {
                        return None;
                    }
                    let (continued_remainder, _, continued_tag) = split_node_properties(trimmed);
                    if deferred_tag.is_none() {
                        deferred_tag = continued_tag.map(str::to_owned);
                    }
                    (!continued_remainder.is_empty() && !continued_remainder.starts_with('#'))
                        .then_some(continued_remainder.to_owned())
                })
        })
        .flatten();
    let effective_tag = explicit_tag.or(deferred_tag.as_deref());
    let deferred_indicator = deferred_value.as_deref().and_then(block_scalar_indicator);
    let block_scalar = indicator.is_some() || deferred_indicator.is_some();
    let nested_keep_chomp = line_spans(&text[content_start..boundary])
        .into_iter()
        .any(|line| {
            let body = &text[content_start + line.start..content_start + line.content_end];
            let trimmed = body.trim_start_matches([' ', '\t']);
            let nested = trimmed
                .strip_prefix("? ")
                .or_else(|| trimmed.strip_prefix("- "))
                .unwrap_or(trimmed);
            let nested_value = mapping_key_colon(nested)
                .map(|colon| nested[colon + 1..].trim_start())
                .unwrap_or(nested);
            block_scalar_indicator(nested_value).is_some_and(|value| value.contains('+'))
        });
    let nested_set_excluded_ranges = block_scalar_body_ranges(&text[content_start..boundary]);
    let mut nested_set_ranges = standard_set_body_ranges(&text[content_start..boundary]);
    normalize_ranges(&mut nested_set_ranges);
    let nested_set_collection =
        line_spans(&text[content_start..boundary])
            .into_iter()
            .any(|line| {
                if sorted_range_contains(&nested_set_excluded_ranges, line.start) {
                    return false;
                }
                let body = &text[content_start + line.start..content_start + line.content_end];
                let trimmed = body.trim_start_matches([' ', '\t']);
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    return false;
                }
                let node = trimmed
                    .strip_prefix("- ")
                    .or_else(|| trimmed.strip_prefix("? "))
                    .unwrap_or(trimmed);
                let value = mapping_key_colon(node)
                    .map(|colon| node[colon + 1..].trim_start())
                    .unwrap_or(node);
                let (_, _, tag) = split_node_properties(value);
                tag == Some("set")
            });
    let continued_lines = line_spans(&text[content_start..boundary])
        .into_iter()
        .filter_map(|line| {
            let body = &text[content_start + line.start..content_start + line.content_end];
            let trimmed = body.trim_start_matches([' ', '\t']);
            (!trimmed.is_empty() && !trimmed.starts_with('#'))
                .then_some((body.len() - trimmed.len(), trimmed))
        })
        .collect::<Vec<_>>();
    let first_continuation_is_collection = continued_lines.first().is_some_and(|(_, trimmed)| {
        trimmed.starts_with('?') || *trimmed == "-" || trimmed.starts_with("- ")
    });
    let first_continuation_indent = continued_lines.first().map(|(indent, _)| *indent);
    let deferred_literal_nel_scalar = (value_source.is_empty() || deferred_properties)
        && !first_continuation_is_collection
        && continued_lines.iter().any(|(indent, trimmed)| {
            if Some(*indent) != first_continuation_indent {
                return false;
            }
            trimmed.char_indices().any(|(offset, character)| {
                if character != '\u{0085}' {
                    return false;
                }
                let suffix = &trimmed[offset + character.len_utf8()..];
                (mapping_key_colon(trimmed) == offset.checked_sub(1) && !suffix.trim().is_empty())
                    || (mapping_key_colon(trimmed).is_none()
                        && suffix.strip_prefix(':').is_some_and(|value| {
                            !value.is_empty()
                                && !value.chars().next().is_some_and(char::is_whitespace)
                        }))
            })
        });
    let deferred_plain_scalar = value_source.is_empty()
        && continued_lines.first().is_some_and(|(_, trimmed)| {
            !first_continuation_is_collection
                && mapping_key_colon(trimmed).is_none()
                && block_scalar_indicator(trimmed).is_none()
        });
    let deferred_marker_has_nested_value = {
        let mut marker_indent = None;
        line_spans(&text[content_start..boundary])
            .into_iter()
            .filter_map(|line| {
                let body = &text[content_start + line.start..content_start + line.content_end];
                let trimmed = body.trim_start_matches([' ', '\t']);
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    return None;
                }
                Some(body.len() - trimmed.len())
            })
            .any(|indent| {
                if let Some(marker_indent) = marker_indent {
                    indent > marker_indent
                } else {
                    marker_indent = Some(indent);
                    false
                }
            })
    };
    let deferred_block_collection = deferred_value.as_deref().is_some_and(|value| {
        !matches!(value.chars().next(), Some('{' | '['))
            && (value.starts_with("- ")
                || (value == "-" && deferred_marker_has_nested_value)
                || value.starts_with("? ")
                || (value == "?" && deferred_marker_has_nested_value)
                || mapping_key_colon(value).is_some())
    });
    let tagged_scalar = effective_tag.is_some_and(|tag| {
        !matches!(tag, "map" | "seq" | "set" | "omap" | "pairs") && !deferred_block_collection
    });
    let deferred_non_block_node = deferred_properties
        && deferred_indicator.is_none()
        && !deferred_block_collection
        && deferred_value.is_some();
    let inline_node = !remainder.is_empty() && !remainder.starts_with('#');
    let mut non_block_scalar = tagged_scalar
        || inline_node
        || deferred_non_block_node
        || deferred_literal_nel_scalar
        || deferred_plain_scalar;
    let indentationless_sequence = value_source.is_empty();
    let set_field = effective_tag == Some("set")
        || value_source.trim_start().starts_with("!!set")
        || value_source
            .trim_start()
            .starts_with("!<tag:yaml.org,2002:set>");
    if set_field
        && !deferred_value
            .as_deref()
            .is_some_and(|value| matches!(value.chars().next(), Some('{' | '[')))
    {
        non_block_scalar = false;
    }
    if block_scalar {
        let scalar_line_start = text[..fallback]
            .rfind(['\r', '\n'])
            .map_or(0, |newline| newline + 1);
        if let Some((_, scalar_end)) = block_scalar_body_ranges(&text[scalar_line_start..boundary])
            .into_iter()
            .next()
        {
            return scalar_line_start + scalar_end;
        }
    }
    let nested_block_scalar_ranges = block_scalar_body_ranges(&text[content_start..boundary]);
    let terminal_set_has_trailing_comment = set_field && {
        let mut set_content = false;
        let mut trailing_comment = false;
        for line in line_spans(&text[content_start..boundary]) {
            if sorted_range_contains(&nested_block_scalar_ranges, line.start) {
                continue;
            }
            let body = &text[content_start + line.start..content_start + line.content_end];
            let trimmed = body.trim();
            if trimmed.starts_with('#') {
                if set_content {
                    trailing_comment = true;
                }
            } else if !trimmed.is_empty() {
                set_content = true;
                trailing_comment = false;
            }
        }
        trailing_comment
    };
    if !block_scalar && terminal_set_has_trailing_comment {
        return boundary;
    }
    let mut first_content = None;
    let mut last_content = None;
    let mut last_nonblank = None;
    for line in line_spans(&text[content_start..boundary]) {
        let body = &text[content_start + line.start..content_start + line.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        let indent = body.len() - trimmed.len();
        if !trimmed.is_empty()
            && indent <= field_indent
            && !(indentationless_sequence
                && indent == field_indent
                && (trimmed == "-" || trimmed.starts_with("- ")))
        {
            break;
        }
        if trimmed.is_empty() {
            if block_scalar || nested_keep_chomp {
                let range = (content_start + line.content_end, content_start + line.end);
                first_content.get_or_insert(range);
                last_content = Some(range);
            }
            continue;
        }
        if !block_scalar && trimmed.starts_with('#') {
            continue;
        }
        let range = (content_start + line.content_end, content_start + line.end);
        first_content.get_or_insert(range);
        last_content = Some(range);
        last_nonblank = Some(range);
    }
    if !block_scalar
        && set_field
        && let Some((content_end, _)) = last_nonblank
    {
        let line_start = text[..content_end]
            .rfind(['\r', '\n'])
            .map_or(0, |newline| newline + 1);
        let terminal = text[line_start..content_end].trim();
        let terminal_in_block_scalar = sorted_range_contains(
            &nested_block_scalar_ranges,
            line_start.saturating_sub(content_start),
        );
        let terminal_member_property =
            terminal
                .strip_prefix('?')
                .map(str::trim_start)
                .is_some_and(|member| {
                    let (remainder, anchor, tag) = split_node_properties(member);
                    remainder.is_empty() && (anchor.is_some() || tag.is_some())
                });
        if !terminal_in_block_scalar && (terminal == "?" || terminal_member_property) {
            return content_end;
        }
    }
    if (preserve_trailing_collection_boundary || set_field) && !block_scalar && !non_block_scalar {
        if let Some((content_end, _)) = last_nonblank {
            let line_start = text[..content_end]
                .rfind(['\r', '\n'])
                .map_or(0, |newline| newline + 1);
            let terminal = text[line_start..content_end].trim();
            let terminal_in_block_scalar = sorted_range_contains(
                &nested_block_scalar_ranges,
                line_start.saturating_sub(content_start),
            );
            let terminal_member_property = terminal
                .strip_prefix('?')
                .map(str::trim_start)
                .is_some_and(|member| {
                    let (remainder, anchor, tag) = split_node_properties(member);
                    remainder.is_empty() && (anchor.is_some() || tag.is_some())
                });
            if !terminal_in_block_scalar
                && (value_source.is_empty() || effective_tag == Some("set"))
                && (terminal == "?" || terminal_member_property)
            {
                return content_end;
            }
        }
        if !set_field
            && !nested_keep_chomp
            && let Some((content_end, line_end)) = last_nonblank
        {
            let line_start = text[..content_end]
                .rfind(['\r', '\n'])
                .map_or(0, |newline| newline + 1);
            let relative_line_start = line_start.saturating_sub(content_start);
            let terminal_in_nested_set =
                sorted_range_contains(&nested_set_ranges, relative_line_start);
            if nested_set_collection && terminal_in_nested_set {
                return boundary;
            }
            let terminal_line = &text[line_start..content_end];
            let terminal_trimmed = terminal_line.trim_start_matches([' ', '\t']);
            if structural_mapping_key_colon(terminal_trimmed)
                .is_some_and(|colon| terminal_trimmed[colon + 1..].trim().is_empty())
            {
                return content_end;
            }
            let terminal_indent = terminal_line.len() - terminal_trimmed.len();
            let trailing_lines = line_spans(&text[line_end..boundary])
                .into_iter()
                .filter_map(|line| {
                    let body = &text[line_end + line.start..line_end + line.content_end];
                    let trimmed = body.trim_start_matches([' ', '\t']);
                    if trimmed.is_empty() {
                        return None;
                    }
                    let indent = body.len() - trimmed.len();
                    Some((trimmed.starts_with('#'), indent))
                })
                .collect::<Vec<_>>();
            let has_mapping_parent = continued_lines.iter().any(|(indent, trimmed)| {
                *indent < terminal_indent && structural_mapping_key_colon(trimmed).is_some()
            });
            let terminal_is_nested_node = structural_mapping_key_colon(terminal_trimmed).is_some()
                || terminal_trimmed == "-"
                || terminal_trimmed.starts_with("- ");
            let trailing_deep_comment = terminal_is_nested_node
                && has_mapping_parent
                && !trailing_lines.is_empty()
                && trailing_lines[0].1 >= terminal_indent
                && trailing_lines
                    .into_iter()
                    .all(|(comment, indent)| comment && indent > field_indent);
            if trailing_deep_comment && line_end < boundary {
                return boundary;
            }
            return line_end;
        }
        return boundary;
    }
    if block_scalar
        && indicator
            .or(deferred_indicator)
            .is_some_and(|value| value.contains('+'))
    {
        return last_content.map_or(fallback, |(_, end)| end);
    }
    if nested_keep_chomp {
        return last_content.map_or(fallback, |(_, end)| end);
    }
    if block_scalar && last_nonblank.is_none() {
        return first_content.map_or(fallback, |(_, end)| end);
    }
    last_nonblank.map_or(fallback, |(content_end, line_end)| {
        if non_block_scalar && !block_scalar {
            let line_start = text[..content_end]
                .rfind(['\r', '\n'])
                .map_or(0, |newline| newline + 1);
            let line = &text[line_start..content_end];
            let leading = line.len() - line.trim_start_matches([' ', '\t']).len();
            let trimmed = &line[leading..];
            let (scalar, _, _) = split_node_properties(trimmed);
            let scalar = if scalar.is_empty() || scalar.starts_with('#') {
                trimmed
            } else {
                scalar
            };
            line_start
                + leading
                + trimmed.len().saturating_sub(scalar.len())
                + scalar_lexical_source(scalar).len()
        } else {
            let line_start = text[..content_end]
                .rfind(['\r', '\n'])
                .map_or(0, |newline| newline + 1);
            let terminal = text[line_start..content_end].trim_start_matches([' ', '\t']);
            if structural_mapping_key_colon(terminal)
                .is_some_and(|colon| terminal[colon + 1..].trim().is_empty())
                || (effective_tag.is_none() && value_source.is_empty() && terminal.trim() == "?")
            {
                content_end
            } else {
                line_end
            }
        }
    })
}

fn block_scalar_indicator(mut source: &str) -> Option<&str> {
    for _ in 0..2 {
        let Some((_, remainder)) = split_standard_tag_property(source).or_else(|| {
            let anchor = source.strip_prefix('&')?;
            Some(
                anchor
                    .split_once(char::is_whitespace)
                    .map_or((anchor, ""), |(name, rest)| (name, rest.trim_start())),
            )
        }) else {
            break;
        };
        source = remainder;
    }
    let indicator = source.split_whitespace().next().unwrap_or(source);
    matches!(indicator.chars().next(), Some('|' | '>')).then_some(indicator)
}

fn flow_field_ranges(text: &str, flow_start: usize, end: usize) -> Map<String, Value> {
    let mut fields = Map::new();
    let positions = source_position_index(text);
    let mut cursor = flow_start + 1;
    while cursor < end {
        cursor = skip_flow_space_and_comments(text, cursor, end);
        if text[cursor..].starts_with('}') {
            break;
        }
        let explicit = text[cursor..].starts_with('?')
            && text[cursor + 1..]
                .chars()
                .next()
                .is_some_and(char::is_whitespace);
        if explicit {
            cursor = skip_flow_space_and_comments(text, cursor + 1, end);
        }
        let key_start = cursor;
        let Some(colon) = flow_mapping_colon(text, cursor, end) else {
            break;
        };
        let key_end = text[key_start..colon].trim_end().len() + key_start;
        let Ok(name) = serde_yaml::from_str::<String>(&text[key_start..key_end]) else {
            break;
        };
        cursor = skip_flow_space_and_comments(text, colon + 1, end);
        let (value_end, delimiter) = flow_mapping_value_end(text, cursor, end);
        fields.insert(
            name,
            serde_json::to_value(range_for_with_position_index(
                text, key_start, value_end, &positions,
            ))
            .unwrap_or(Value::Null),
        );
        cursor = delimiter;
        if text[cursor..].starts_with(',') {
            cursor += 1;
        } else {
            break;
        }
    }
    fields
}

fn skip_flow_space_and_comments(text: &str, mut cursor: usize, end: usize) -> usize {
    loop {
        while cursor < end
            && text[cursor..]
                .chars()
                .next()
                .is_some_and(char::is_whitespace)
        {
            cursor += text[cursor..].chars().next().unwrap_or_default().len_utf8();
        }
        if cursor >= end || !text[cursor..].starts_with('#') {
            return cursor;
        }
        cursor += text[cursor..].find(['\r', '\n']).unwrap_or(end - cursor);
    }
}

fn flow_mapping_colon(text: &str, start: usize, end: usize) -> Option<usize> {
    let mut quote = None;
    let mut escaped = false;
    let mut characters = text[start..end].char_indices().peekable();
    while let Some((relative, character)) = characters.next() {
        if let Some(active_quote) = quote {
            if active_quote == '"' && character == '\\' && !escaped {
                escaped = true;
                continue;
            }
            if character == active_quote && !escaped {
                if active_quote == '\'' && characters.peek().is_some_and(|(_, next)| *next == '\'')
                {
                    characters.next();
                } else {
                    quote = None;
                }
            }
            escaped = false;
            continue;
        }
        match character {
            '"' | '\'' => quote = Some(character),
            ':' => {
                let next = characters.peek().map(|(_, character)| *character);
                if next.is_none_or(|character| {
                    character.is_whitespace() || matches!(character, ',' | '[' | ']' | '{' | '}')
                }) {
                    return Some(start + relative);
                }
            }
            _ => {}
        }
    }
    None
}

fn flow_top_level_mapping_colon(text: &str, start: usize, end: usize) -> Option<usize> {
    let mut quote = None;
    let mut escaped = false;
    let mut stack = Vec::new();
    let mut characters = text[start..end].char_indices().peekable();
    while let Some((relative, character)) = characters.next() {
        if let Some(active_quote) = quote {
            if active_quote == '"' && character == '\\' && !escaped {
                escaped = true;
                continue;
            }
            if character == active_quote && !escaped {
                if active_quote == '\'' && characters.peek().is_some_and(|(_, next)| *next == '\'')
                {
                    characters.next();
                } else {
                    quote = None;
                }
            }
            escaped = false;
            continue;
        }
        match character {
            '"' | '\'' => quote = Some(character),
            '[' | '{' => stack.push(character),
            ']' if stack.last() == Some(&'[') => {
                stack.pop();
            }
            '}' if stack.last() == Some(&'{') => {
                stack.pop();
            }
            ':' if stack.is_empty() => {
                let next = characters.peek().map(|(_, character)| *character);
                if next.is_none_or(|character| {
                    character.is_whitespace() || matches!(character, ',' | '[' | ']' | '{' | '}')
                }) {
                    return Some(start + relative);
                }
            }
            _ => {}
        }
    }
    None
}

fn flow_mapping_value_end(text: &str, start: usize, end: usize) -> (usize, usize) {
    let mut stack = Vec::new();
    let mut quote = None;
    let mut escaped = false;
    let mut comment = false;
    let mut last_significant = start;
    let mut characters = text[start..end].char_indices().peekable();
    while let Some((relative, character)) = characters.next() {
        let absolute = start + relative;
        if comment {
            if matches!(character, '\r' | '\n') {
                comment = false;
            }
            continue;
        }
        if let Some(active_quote) = quote {
            last_significant = absolute + character.len_utf8();
            if active_quote == '"' && character == '\\' && !escaped {
                escaped = true;
                continue;
            }
            if character == active_quote && !escaped {
                if active_quote == '\'' && characters.peek().is_some_and(|(_, next)| *next == '\'')
                {
                    characters.next();
                    last_significant += 1;
                } else {
                    quote = None;
                }
            }
            escaped = false;
            continue;
        }
        match character {
            '#' if absolute == start
                || text[..absolute]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_whitespace) =>
            {
                comment = true;
            }
            '"' | '\'' => {
                quote = Some(character);
                last_significant = absolute + character.len_utf8();
            }
            '{' => {
                stack.push('}');
                last_significant = absolute + 1;
            }
            '[' => {
                stack.push(']');
                last_significant = absolute + 1;
            }
            '}' | ']' if stack.last() == Some(&character) => {
                stack.pop();
                last_significant = absolute + 1;
            }
            ',' | '}' if stack.is_empty() => return (last_significant, absolute),
            _ if !character.is_whitespace() => {
                last_significant = absolute + character.len_utf8();
            }
            _ => {}
        }
    }
    (last_significant, end)
}

fn fallback_content_hash(bytes: &[u8]) -> String {
    let mut hash = 0x811c_9dc5_u32;
    for byte in bytes {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("fnv1a32:{hash:08x}")
}

fn bounded_identity_failure(
    value: &str,
    max_code_units: usize,
    max_bytes: usize,
    subject: &str,
) -> Option<String> {
    if value.encode_utf16().count() > max_code_units {
        return Some(format!(
            "{subject} exceeds the {max_code_units}-code-unit identity safety limit. Shorten the identifier, then retry."
        ));
    }
    if value.len() > max_bytes {
        return Some(format!(
            "{subject} exceeds the {max_bytes}-byte identity safety limit. Shorten the identifier, then retry."
        ));
    }
    None
}

fn semantic_line_count(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    line_spans(text).len()
        + usize::from(
            text.as_bytes()
                .last()
                .is_some_and(|byte| matches!(*byte, b'\r' | b'\n')),
        )
}

fn preparse_line_count(text: &str) -> usize {
    if text.is_empty() {
        0
    } else {
        line_spans(text).len()
    }
}

fn frontmatter_complexity_failure(source: &str) -> Option<String> {
    let chars = source.chars().collect::<Vec<_>>();
    let mut line_count = usize::from(!chars.is_empty());
    let mut structural_tokens = 0usize;
    let mut at_line_start = true;
    let mut indent = 0usize;
    for (index, character) in chars.iter().copied().enumerate() {
        let lone_line_break =
            character == '\n' || (character == '\r' && chars.get(index + 1) != Some(&'\n'));
        if lone_line_break {
            if index + 1 < chars.len() {
                line_count += 1;
            }
            if line_count > MAX_FRONTMATTER_LINES {
                return Some(format!(
                    "YAML frontmatter exceeds the {MAX_FRONTMATTER_LINES}-line pre-parse safety limit. Reduce the metadata, then retry."
                ));
            }
            at_line_start = true;
            indent = 0;
            continue;
        }
        if at_line_start && character == ' ' {
            indent += 1;
            if indent > MAX_FRONTMATTER_INDENT_COLUMNS {
                return Some(format!(
                    "YAML frontmatter indentation exceeds the {MAX_FRONTMATTER_INDENT_COLUMNS}-column pre-parse safety limit. Reduce nesting, then retry."
                ));
            }
            continue;
        }
        if character != '\t' {
            at_line_start = false;
        }
        let code = u32::from(character);
        if (code > 0 && code < 0x20 && !matches!(character, '\t' | '\n' | '\r'))
            || (0x21..=0x2f).contains(&code)
            || (0x3a..=0x40).contains(&code)
            || (0x5b..=0x60).contains(&code)
            || (0x7b..=0x7e).contains(&code)
        {
            structural_tokens += 1;
            if structural_tokens > MAX_FRONTMATTER_STRUCTURAL_TOKENS {
                return Some(format!(
                    "YAML frontmatter exceeds the {MAX_FRONTMATTER_STRUCTURAL_TOKENS}-token pre-parse complexity limit. Reduce the metadata, then retry."
                ));
            }
        }
    }
    yaml_collection_nesting_failure(source)
}

fn yaml_collection_nesting_failure(source: &str) -> Option<String> {
    let mut excluded_ranges = block_scalar_body_ranges(source);
    excluded_ranges.extend(multiline_quoted_scalar_ranges(source));
    normalize_ranges(&mut excluded_ranges);
    let mut block_stack: Vec<(usize, isize)> = Vec::new();
    let mut flow_stack: Vec<(char, isize, bool)> = Vec::new();

    for span in line_spans(source) {
        if sorted_range_contains(&excluded_ranges, span.start) {
            continue;
        }
        let body = &source[span.start..span.content_end];
        let syntax = yaml_comment_start(body).map_or(body, |comment| &body[..comment]);
        let trimmed = syntax.trim_start_matches([' ', '\t']);
        if trimmed.is_empty() {
            continue;
        }
        let indent = syntax.len() - trimmed.len();
        if flow_stack.is_empty() {
            while block_stack
                .last()
                .is_some_and(|(ancestor_indent, _)| indent <= *ancestor_indent)
            {
                block_stack.pop();
            }
        }
        let parent_depth = block_stack.last().map_or(-1, |(_, depth)| *depth);
        let mut node = trimmed;
        let mut block_collections = 0isize;
        while let Some(remainder) = node.strip_prefix('-') {
            if !remainder.is_empty() && !remainder.chars().next().is_some_and(char::is_whitespace) {
                break;
            }
            block_collections += 1;
            node = remainder.trim_start_matches([' ', '\t']);
        }
        if mapping_key_colon(node).is_some() {
            block_collections += 1;
        }
        let block_depth = if block_collections > 0 {
            let depth = parent_depth + block_collections;
            if depth > MAX_FRONTMATTER_NESTING_DEPTH as isize {
                return Some(format!(
                    "YAML frontmatter collection nesting exceeds the {MAX_FRONTMATTER_NESTING_DEPTH}-level pre-parse safety limit. Reduce nesting, then retry."
                ));
            }
            if flow_stack.is_empty() {
                block_stack.push((indent, depth));
            }
            depth
        } else {
            parent_depth
        };

        let mut quote = None;
        let mut escaped = false;
        let mut comment = false;
        let mut characters = syntax.char_indices().peekable();
        while let Some((relative, character)) = characters.next() {
            if comment {
                break;
            }
            if let Some(active_quote) = quote {
                if active_quote == '"' && character == '\\' && !escaped {
                    escaped = true;
                    continue;
                }
                if character == active_quote && !escaped {
                    if active_quote == '\''
                        && characters.peek().is_some_and(|(_, next)| *next == '\'')
                    {
                        characters.next();
                    } else {
                        quote = None;
                    }
                }
                escaped = false;
                continue;
            }
            match character {
                '"' | '\'' => quote = Some(character),
                '#' if relative == 0
                    || syntax[..relative]
                        .chars()
                        .next_back()
                        .is_some_and(char::is_whitespace) =>
                {
                    comment = true;
                }
                '[' | '{' if yaml_node_property_position(source, span.start + relative) => {
                    let depth = flow_stack
                        .last()
                        .map_or(block_depth + 1, |(_, parent, _)| parent + 1);
                    if depth > MAX_FRONTMATTER_NESTING_DEPTH as isize {
                        return Some(format!(
                            "YAML frontmatter collection nesting exceeds the {MAX_FRONTMATTER_NESTING_DEPTH}-level pre-parse safety limit. Reduce nesting, then retry."
                        ));
                    }
                    flow_stack.push((character, depth, false));
                }
                ']' | '}' => {
                    flow_stack.pop();
                }
                ',' => {
                    if let Some((_, _, implicit_mapping)) = flow_stack.last_mut() {
                        *implicit_mapping = false;
                    }
                }
                ':' => {
                    let structural = characters.peek().is_none_or(|(_, next)| {
                        next.is_whitespace() || matches!(next, ',' | ']' | '}')
                    });
                    if structural
                        && let Some(('[', depth, implicit_mapping)) = flow_stack.last_mut()
                        && !*implicit_mapping
                    {
                        *implicit_mapping = true;
                        if *depth + 1 > MAX_FRONTMATTER_NESTING_DEPTH as isize {
                            return Some(format!(
                                "YAML frontmatter collection nesting exceeds the {MAX_FRONTMATTER_NESTING_DEPTH}-level pre-parse safety limit. Reduce nesting, then retry."
                            ));
                        }
                    }
                }
                _ => {}
            }
        }
    }
    None
}

fn yaml_alias_occurrence_count(source: &str) -> (usize, usize, usize) {
    let mut excluded_ranges = block_scalar_body_ranges(source);
    excluded_ranges.extend(multiline_quoted_scalar_ranges(source));
    excluded_ranges.extend(plain_scalar_value_ranges(source));
    normalize_ranges(&mut excluded_ranges);
    let mut aliases = Vec::new();
    let mut quote = None;
    let mut escaped = false;
    let mut comment = false;
    let mut cursor = 0usize;
    while cursor < source.len() {
        let character = source[cursor..]
            .chars()
            .next()
            .expect("cursor is at a character boundary");
        let width = character.len_utf8();
        let offset = cursor;
        if sorted_range_contains(&excluded_ranges, offset) {
            cursor += width;
            continue;
        }
        if comment {
            if matches!(character, '\r' | '\n') {
                comment = false;
            }
            cursor += width;
            continue;
        }
        if let Some(active_quote) = quote {
            if active_quote == '"' && character == '\\' && !escaped {
                escaped = true;
                cursor += width;
                continue;
            }
            if character == active_quote && !escaped {
                quote = None;
            }
            escaped = false;
            cursor += width;
            continue;
        }
        match character {
            '"' | '\'' => quote = Some(character),
            '#' if offset == 0
                || source[..offset]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_whitespace) =>
            {
                comment = true;
            }
            '*' if yaml_node_property_position(source, offset) => {
                let name_start = offset + width;
                let name_end = yaml_anchor_name_end(source, name_start);
                if name_end > name_start {
                    aliases.push(YamlAliasOccurrence {
                        offset,
                        name: source[name_start..name_end].to_owned(),
                    });
                    cursor = name_end;
                    continue;
                }
            }
            _ => {}
        }
        cursor += width;
    }
    let anchors = yaml_anchor_occurrences_in_ranges(source, &[(0, source.len())])
        .into_iter()
        .map(|(offset, name)| YamlAnchorOccurrence { offset, name })
        .collect::<Vec<_>>();
    let mut memo = vec![None; anchors.len()];
    let mut visiting = vec![false; anchors.len()];
    let lexical_count = aliases.len();
    let expansion_count = aliases
        .iter()
        .map(|alias| {
            yaml_alias_expansion_cost(source, alias, &aliases, &anchors, &mut memo, &mut visiting)
        })
        .fold(0usize, |total, cost| total.saturating_add(cost));
    let expanded_scalar_units = aliases
        .iter()
        .filter_map(|alias| {
            let anchor = anchors
                .iter()
                .rev()
                .find(|anchor| anchor.offset < alias.offset && anchor.name == alias.name)?;
            let (start, end) = yaml_anchored_node_range(source, anchor)?;
            let node = &source[start..end];
            (!node.starts_with(['[', '{', '|', '>'])).then(|| scalar_lexical_source(node).len())
        })
        .fold(0usize, usize::saturating_add);
    (lexical_count, expansion_count, expanded_scalar_units)
}

struct YamlAliasOccurrence {
    offset: usize,
    name: String,
}

struct YamlAnchorOccurrence {
    offset: usize,
    name: String,
}

fn yaml_alias_expansion_cost(
    source: &str,
    alias: &YamlAliasOccurrence,
    aliases: &[YamlAliasOccurrence],
    anchors: &[YamlAnchorOccurrence],
    memo: &mut [Option<usize>],
    visiting: &mut [bool],
) -> usize {
    let Some(anchor_index) = anchors
        .iter()
        .enumerate()
        .rev()
        .find_map(|(index, anchor)| {
            (anchor.offset < alias.offset && anchor.name == alias.name).then_some(index)
        })
    else {
        return 1;
    };
    if visiting[anchor_index] {
        return 1;
    }
    let nested = if let Some(cost) = memo[anchor_index] {
        cost
    } else {
        visiting[anchor_index] = true;
        let anchor = &anchors[anchor_index];
        let range = yaml_anchored_node_range(source, anchor);
        let cost = range.map_or(0, |(start, end)| {
            aliases
                .iter()
                .filter(|nested| nested.offset >= start && nested.offset < end)
                .map(|nested| {
                    yaml_alias_expansion_cost(source, nested, aliases, anchors, memo, visiting)
                })
                .fold(0usize, |total, nested| {
                    total.saturating_add(nested).min(MAX_ALIAS_EXPANSIONS + 1)
                })
        });
        visiting[anchor_index] = false;
        memo[anchor_index] = Some(cost);
        cost
    };
    1usize.saturating_add(nested).min(MAX_ALIAS_EXPANSIONS + 1)
}

fn yaml_anchored_node_range(source: &str, anchor: &YamlAnchorOccurrence) -> Option<(usize, usize)> {
    let mut cursor = anchor.offset + 1 + anchor.name.len();
    let anchor_line_start = source[..anchor.offset]
        .rfind(['\r', '\n'])
        .map_or(0, |newline| newline + 1);
    let anchor_indent = source[anchor_line_start..anchor.offset]
        .chars()
        .take_while(|character| matches!(character, ' ' | '\t'))
        .count();
    let mut deferred = false;
    loop {
        while source[cursor..].starts_with([' ', '\t']) {
            cursor += 1;
        }
        if source[cursor..].starts_with('#') {
            cursor += source[cursor..]
                .find(['\r', '\n'])
                .unwrap_or(source.len() - cursor);
        }
        if source[cursor..].starts_with("\r\n") {
            cursor += 2;
            deferred = true;
            continue;
        }
        if source[cursor..].starts_with(['\r', '\n']) {
            cursor += 1;
            deferred = true;
            continue;
        }
        if source[cursor..].starts_with('!') {
            cursor += node_property_token_length(&source[cursor..])?;
            continue;
        }
        break;
    }
    if cursor >= source.len() {
        return None;
    }
    let node_line_start = source[..cursor]
        .rfind(['\r', '\n'])
        .map_or(0, |newline| newline + 1);
    let node_indent = source[node_line_start..cursor]
        .chars()
        .take_while(|character| matches!(character, ' ' | '\t'))
        .count();
    let first = source[cursor..].chars().next()?;
    if matches!(first, '[' | '{') {
        return Some((cursor, flow_value_end(source, cursor)));
    }
    let line_end = cursor
        + source[cursor..]
            .find(['\r', '\n'])
            .unwrap_or(source.len() - cursor);
    let line_node = &source[cursor..line_end];
    let block_collection = deferred
        || mapping_key_colon(line_node).is_some()
        || line_node.strip_prefix('-').is_some_and(|rest| {
            rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
        });
    if !block_collection {
        return Some((cursor, line_end));
    }
    let boundary_indent = if deferred {
        node_indent
    } else {
        anchor_indent.saturating_add(1)
    };
    let end = line_spans(source)
        .into_iter()
        .find(|line| {
            if line.start <= node_line_start {
                return false;
            }
            let body = &source[line.start..line.content_end];
            let trimmed = body.trim_start_matches([' ', '\t']);
            if trimmed.is_empty() || trimmed.starts_with('#') {
                return false;
            }
            let indent = body.len() - trimmed.len();
            indent < boundary_indent
        })
        .map_or(source.len(), |line| line.start);
    Some((cursor, end))
}

fn multiple_yaml_document_range(source: &str) -> Option<(usize, usize)> {
    let mut excluded_ranges = block_scalar_body_ranges(source);
    excluded_ranges.extend(multiline_quoted_scalar_ranges(source));
    excluded_ranges.extend(plain_scalar_value_ranges(source));
    normalize_ranges(&mut excluded_ranges);
    let spans = line_spans(source);
    for (index, span) in spans.iter().enumerate() {
        if sorted_range_contains(&excluded_ranges, span.start) {
            continue;
        }
        let body = &source[span.start..span.content_end];
        let syntax = yaml_comment_start(body).map_or(body, |comment| &body[..comment]);
        if syntax.trim_end_matches([' ', '\t']) != "..." {
            continue;
        }
        let remainder_start = span.end;
        if spans.iter().skip(index + 1).any(|candidate| {
            let body = &source[candidate.start..candidate.content_end];
            let syntax = yaml_comment_start(body).map_or(body, |comment| &body[..comment]);
            !syntax.trim().is_empty()
        }) {
            return Some((remainder_start, source.len()));
        }
    }
    None
}

fn has_misaligned_plain_scalar_property(source: &str) -> bool {
    let spans = line_spans(source);
    for (index, span) in spans.iter().enumerate() {
        let body = &source[span.start..span.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        if !trimmed.starts_with(['!', '&']) {
            continue;
        }
        let indent = body.len() - trimmed.len();
        let Some(previous) = spans[..index].iter().rev().find(|candidate| {
            let candidate_body = &source[candidate.start..candidate.content_end];
            let candidate_trimmed = candidate_body.trim_start_matches([' ', '\t']);
            !candidate_trimmed.is_empty() && !candidate_trimmed.starts_with('#')
        }) else {
            continue;
        };
        let previous_body = &source[previous.start..previous.content_end];
        let previous_trimmed = previous_body.trim_start_matches([' ', '\t']);
        let previous_indent = previous_body.len() - previous_trimmed.len();
        if previous_indent == indent
            && mapping_key_colon(previous_trimmed).is_none()
            && !previous_trimmed.starts_with(['-', '?', ':', '!', '&'])
        {
            return true;
        }
    }
    false
}

fn concept_metadata_failure(metadata: &NormalizedFrontmatter) -> Option<String> {
    if has_control_character(metadata.r#type.as_deref().unwrap_or_default()) {
        return Some(
            "Concept type contains a control character that is unsafe for graph filters."
                .to_owned(),
        );
    }
    if let Some(message) = bounded_identity_failure(
        metadata.r#type.as_deref().unwrap_or_default(),
        MAX_TYPE_CODE_UNITS,
        MAX_TYPE_BYTES,
        "Concept type",
    ) {
        return Some(message);
    }
    if metadata.tags.len() > MAX_TAGS_PER_CONCEPT {
        return Some(format!(
            "Concept metadata contains more than {MAX_TAGS_PER_CONCEPT} tags, exceeding the per-concept safety limit. Reduce the tag list, then retry."
        ));
    }
    for tag in &metadata.tags {
        if has_control_character(tag) {
            return Some(
                "Concept tag contains a control character that is unsafe for graph filters."
                    .to_owned(),
            );
        }
        if let Some(message) =
            bounded_identity_failure(tag, MAX_TAG_CODE_UNITS, MAX_TAG_BYTES, "Concept tag")
        {
            return Some(message);
        }
    }
    for (subject, value, limit) in [
        (
            "Concept title",
            metadata.title.as_deref(),
            MAX_TITLE_CODE_UNITS,
        ),
        (
            "Concept description",
            metadata.description.as_deref(),
            MAX_DESCRIPTION_CODE_UNITS,
        ),
        (
            "Concept resource",
            metadata.resource.as_deref(),
            MAX_RESOURCE_CODE_UNITS,
        ),
        (
            "Concept timestamp",
            metadata.timestamp.as_deref(),
            MAX_TIMESTAMP_CODE_UNITS,
        ),
        (
            "Concept generator actor",
            metadata
                .generated
                .as_ref()
                .and_then(|value| value.by.as_deref()),
            MAX_RESOURCE_CODE_UNITS,
        ),
        (
            "Concept generation time",
            metadata
                .generated
                .as_ref()
                .and_then(|value| value.at.as_deref()),
            MAX_TIMESTAMP_CODE_UNITS,
        ),
        (
            "Concept lifecycle status",
            metadata.status.as_deref(),
            MAX_TYPE_CODE_UNITS,
        ),
        (
            "Concept stale-after date",
            metadata.stale_after.as_deref(),
            MAX_TIMESTAMP_CODE_UNITS,
        ),
        (
            "Concept computation runtime",
            metadata.runtime.as_deref(),
            MAX_TYPE_CODE_UNITS,
        ),
        (
            "Concept computation path",
            metadata.computation.as_deref(),
            MAX_RESOURCE_CODE_UNITS,
        ),
    ] {
        if value.is_some_and(|value| value.encode_utf16().count() > limit) {
            return Some(format!(
                "{subject} exceeds the {limit}-code-unit graph metadata safety limit. Shorten the value, then retry."
            ));
        }
    }
    if metadata
        .resource
        .as_deref()
        .is_some_and(has_control_character)
        || metadata
            .timestamp
            .as_deref()
            .is_some_and(has_control_character)
        || metadata
            .generated
            .as_ref()
            .and_then(|value| value.by.as_deref())
            .is_some_and(has_control_character)
        || metadata
            .generated
            .as_ref()
            .and_then(|value| value.at.as_deref())
            .is_some_and(has_control_character)
        || metadata
            .status
            .as_deref()
            .is_some_and(has_control_character)
        || metadata
            .stale_after
            .as_deref()
            .is_some_and(has_control_character)
        || metadata
            .runtime
            .as_deref()
            .is_some_and(has_control_character)
        || metadata
            .computation
            .as_deref()
            .is_some_and(has_control_character)
    {
        return Some(
            "Concept scalar metadata contains a control character that is unsafe for graph metadata."
                .to_owned(),
        );
    }
    None
}

fn bounded_link_text_failure(
    value: &str,
    max_code_units: usize,
    max_bytes: usize,
    subject: &str,
) -> Option<String> {
    if value.encode_utf16().count() > max_code_units || value.len() > max_bytes {
        Some(format!(
            "Markdown {subject} exceeds the {max_code_units}-code-unit / {max_bytes}-byte pre-parse safety limit. Shorten it, then retry."
        ))
    } else {
        None
    }
}

fn markdown_links(
    body: &str,
    body_start: usize,
    full_text: &str,
) -> Result<Vec<LinkCandidate>, String> {
    let body_code_units = body.encode_utf16().count();
    if body_code_units > MAX_MARKDOWN_BODY_CODE_UNITS {
        return Err(format!(
            "Markdown body exceeds the {MAX_MARKDOWN_BODY_CODE_UNITS}-code-unit pre-parse safety limit. Reduce or split the document, then retry."
        ));
    }
    if body.len() > MAX_MARKDOWN_BODY_BYTES {
        return Err(format!(
            "Markdown body exceeds the {MAX_MARKDOWN_BODY_BYTES}-byte pre-parse safety limit. Reduce or split the document, then retry."
        ));
    }
    if preparse_line_count(body) > MAX_MARKDOWN_LINES {
        return Err(format!(
            "Markdown body exceeds the {MAX_MARKDOWN_LINES}-line pre-parse safety limit. Reduce or split the document, then retry."
        ));
    }
    if markdown_syntax_candidate_count(body) > MAX_MARKDOWN_SYNTAX_CANDIDATES {
        return Err(format!(
            "Markdown body exceeds the {MAX_MARKDOWN_SYNTAX_CANDIDATES}-token pre-parse complexity limit. Reduce or split the document, then retry."
        ));
    }
    if let Some(message) = markdown_inline_work_failure(body) {
        return Err(message);
    }
    let maximum_definition_expansion = markdown_definition_inspection(body)?;
    let bracket_count = body.bytes().filter(|byte| *byte == b'[').count();
    let estimated_reference_expansion = bracket_count.saturating_mul(maximum_definition_expansion);
    if estimated_reference_expansion > MAX_MARKDOWN_REFERENCE_EXPANSION_BYTES {
        return Err(format!(
            "Markdown reference expansion exceeds the {MAX_MARKDOWN_REFERENCE_EXPANSION_BYTES}-byte parser-work safety limit. Reduce repeated references or definition titles, then retry."
        ));
    }
    let desired_parser_capacity = estimated_reference_expansion;
    let parser_padding = if desired_parser_capacity > body.len().max(100_000) {
        desired_parser_capacity.saturating_sub(body.len())
    } else {
        0
    };
    let padded_body = (parser_padding > 0).then(|| {
        let mut padded = String::with_capacity(body.len() + parser_padding + 2);
        padded.push_str(body);
        padded.push_str("\n\n");
        padded.extend(std::iter::repeat_n(' ', parser_padding));
        padded
    });
    let parser_body = padded_body.as_deref().unwrap_or(body);
    let reference_parser = Parser::new_ext(body, Options::ENABLE_STRIKETHROUGH);
    let reference_definitions = reference_parser
        .reference_definitions()
        .iter()
        .map(|(label, definition)| {
            (
                normalize_reference_identifier(label),
                definition.dest.to_string(),
                definition
                    .title
                    .as_ref()
                    .map_or_else(String::new, ToString::to_string),
            )
        })
        .collect::<Vec<_>>();
    let reference_callback = move |broken: pulldown_cmark::BrokenLink<'_>| {
        let identifier = normalize_reference_identifier(&broken.reference);
        reference_definitions
            .iter()
            .find(|(label, _, _)| *label == identifier)
            .map(|(_, destination, title)| (destination.clone().into(), title.clone().into()))
    };
    let parser = Parser::new_with_broken_link_callback(
        parser_body,
        Options::ENABLE_STRIKETHROUGH,
        Some(reference_callback),
    )
    .into_offset_iter();
    let positions = source_position_index(full_text);
    let mut stack: Vec<(String, String, std::ops::Range<usize>)> = Vec::new();
    let mut result = Vec::new();
    let mut retained_text_units = 0usize;
    for (event, range) in parser {
        match event {
            Event::Start(Tag::Link { dest_url, .. }) => {
                stack.push((String::new(), dest_url.into_string(), range));
            }
            Event::Text(text) | Event::Code(text) => {
                if let Some((label, _, _)) = stack.last_mut() {
                    label.push_str(&text);
                }
            }
            Event::SoftBreak => {
                if let Some((label, _, _)) = stack.last_mut() {
                    label.push_str(&body[range.start..range.end]);
                }
            }
            Event::HardBreak => {
                if let Some((label, _, _)) = stack.last_mut() {
                    label.push(' ');
                }
            }
            Event::End(pulldown_cmark::TagEnd::Link) => {
                if let Some((label, target, start_range)) = stack.pop() {
                    let label = trim_ecmascript_whitespace(&label);
                    if let Some(message) = bounded_link_text_failure(
                        &target,
                        MAX_LINK_TARGET_CODE_UNITS,
                        MAX_LINK_TARGET_BYTES,
                        "link target",
                    ) {
                        return Err(message);
                    }
                    if let Some(message) = bounded_link_text_failure(
                        label,
                        MAX_LINK_LABEL_CODE_UNITS,
                        MAX_LINK_LABEL_BYTES,
                        "link label",
                    ) {
                        return Err(message);
                    }
                    if result.len() >= MAX_MARKDOWN_LINKS_PER_DOCUMENT {
                        return Err(format!(
                            "Markdown contains more than {MAX_MARKDOWN_LINKS_PER_DOCUMENT} links, exceeding the per-document safety limit. Reduce or split the document, then retry."
                        ));
                    }
                    let additional_text_units = target.len().saturating_add(label.len());
                    if retained_text_units
                        > MAX_LINK_TEXT_UNITS_PER_DOCUMENT.saturating_sub(additional_text_units)
                    {
                        return Err(format!(
                            "Retained Markdown link targets and labels exceed the {MAX_LINK_TEXT_UNITS_PER_DOCUMENT}-unit per-document safety limit. Reduce or split the document, then retry."
                        ));
                    }
                    retained_text_units += additional_text_units;
                    let mut end = range.end;
                    if body
                        .get(end..)
                        .is_some_and(|suffix| suffix.starts_with("[]"))
                    {
                        end += 2;
                    }
                    result.push(LinkCandidate {
                        label: label.to_owned(),
                        target,
                        range: range_for_with_position_index(
                            full_text,
                            body_start + start_range.start,
                            body_start + end,
                            &positions,
                        ),
                    });
                }
            }
            _ => {}
        }
    }
    Ok(result)
}

fn trim_ecmascript_whitespace(value: &str) -> &str {
    value.trim_matches(is_ecmascript_whitespace)
}

fn is_ecmascript_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'
            | '\u{000a}'
            | '\u{000b}'
            | '\u{000c}'
            | '\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn normalize_reference_identifier(value: &str) -> String {
    let mut result = String::new();
    let mut pending_space = false;
    for character in trim_ecmascript_whitespace(value).chars() {
        if is_ecmascript_whitespace(character) {
            pending_space = !result.is_empty();
            continue;
        }
        if pending_space {
            result.push(' ');
            pending_space = false;
        }
        result.push(character);
    }
    result.to_uppercase().to_lowercase()
}

fn markdown_definition_inspection(body: &str) -> Result<usize, String> {
    let definition_parser = Parser::new_ext(body, Options::ENABLE_STRIKETHROUGH);
    let parsed_definitions = definition_parser
        .reference_definitions()
        .iter()
        .map(|(_, definition)| definition)
        .collect::<Vec<_>>();
    let spans = line_spans(body);
    let mut definition_count = 0usize;
    let mut maximum_expansion_bytes = 0usize;
    let mut seen_definition_labels = BTreeSet::new();
    let mut fence: Option<(char, usize, usize)> = None;
    let mut html_block: Option<(MarkdownHtmlBlock, usize)> = None;
    let mut line_index = 0usize;
    while line_index < spans.len() {
        let span = &spans[line_index];
        let source_line = &body[span.start..span.content_end];
        let (line, container_depth) = markdown_container_content_and_depth(source_line);
        let leading_spaces = line
            .chars()
            .take_while(|character| *character == ' ')
            .count();
        let trimmed = &line[leading_spaces.min(line.len())..];
        if let Some((marker, minimum, opening_depth)) = fence {
            if container_depth < opening_depth {
                fence = None;
            } else {
                if leading_spaces <= 3 {
                    let marker_count = trimmed
                        .chars()
                        .take_while(|character| *character == marker)
                        .count();
                    if marker_count >= minimum
                        && trimmed[marker_count..].chars().all(char::is_whitespace)
                    {
                        fence = None;
                    }
                }
                line_index += 1;
                continue;
            }
        }
        if let Some((active_html_block, opening_depth)) = html_block.as_ref() {
            if container_depth < *opening_depth {
                html_block = None;
            } else {
                if active_html_block.ends_on(trimmed) {
                    html_block = None;
                }
                line_index += 1;
                continue;
            }
        }
        if leading_spaces <= 3
            && let Some((marker, marker_count)) = markdown_fence_opener(trimmed)
        {
            fence = Some((marker, marker_count, container_depth));
            line_index += 1;
            continue;
        }
        if leading_spaces <= 3
            && let Some(started_html_block) = markdown_html_block_start(trimmed)
        {
            if !started_html_block.ends_on(trimmed) {
                html_block = Some((started_html_block, container_depth));
            }
            line_index += 1;
            continue;
        }
        if leading_spaces >= 4 || !trimmed.starts_with('[') {
            line_index += 1;
            continue;
        }
        let mut escaped = false;
        let mut closing = None;
        for (offset, character) in trimmed[1..].char_indices() {
            if character == ']' && !escaped {
                closing = Some(1 + offset);
                break;
            }
            escaped = character == '\\' && !escaped;
            if character != '\\' {
                escaped = false;
            }
        }
        let Some(closing) = closing else {
            line_index += 1;
            continue;
        };
        if closing == 1 {
            line_index += 1;
            continue;
        }
        let after_label = &trimmed[closing + 1..];
        let Some(after_colon) = after_label.strip_prefix(':') else {
            line_index += 1;
            continue;
        };
        let label = &trimmed[1..closing];
        let candidate_start = span.start + source_line.len() - line.len() + leading_spaces;
        let parsed_definition = parsed_definitions.iter().copied().find(|definition| {
            definition.span.start <= candidate_start && candidate_start < definition.span.end
        });
        let normalized_label = normalize_reference_identifier(label);
        if let Some(definition) = parsed_definition {
            definition_count += 1;
            if definition_count > MAX_MARKDOWN_DEFINITIONS_PER_DOCUMENT {
                return Err(format!(
                    "Markdown contains more than {MAX_MARKDOWN_DEFINITIONS_PER_DOCUMENT} link definitions, exceeding the pre-parse safety limit. Reduce or split the document, then retry."
                ));
            }
            seen_definition_labels.insert(normalized_label);
            let title_bytes = definition.title.as_ref().map_or(0, |title| title.len());
            maximum_expansion_bytes =
                maximum_expansion_bytes.max(definition.dest.len().saturating_add(title_bytes));
            if let Some(message) = bounded_link_text_failure(
                label,
                MAX_LINK_LABEL_CODE_UNITS,
                MAX_LINK_LABEL_BYTES,
                "link label",
            ) {
                return Err(message);
            }
            if let Some(message) = bounded_link_text_failure(
                &definition.dest,
                MAX_LINK_TARGET_CODE_UNITS,
                MAX_LINK_TARGET_BYTES,
                "link target",
            ) {
                return Err(message);
            }
            line_index += definition
                .span
                .clone()
                .filter(|offset| body.as_bytes().get(*offset) == Some(&b'\n'))
                .count();
            line_index += 1;
            continue;
        }
        if !seen_definition_labels.contains(&normalized_label) {
            line_index += 1;
            continue;
        }
        let mut definition_tail = after_colon.trim_start();
        if definition_tail.is_empty()
            && let Some(next) = spans.get(line_index + 1)
        {
            let continuation = markdown_container_content(&body[next.start..next.content_end]);
            let continuation_indent = continuation
                .chars()
                .take_while(|character| *character == ' ')
                .count();
            if continuation_indent <= 3 {
                definition_tail = continuation.trim_start();
                line_index += 1;
            }
        }
        let Some((destination, remainder)) = markdown_definition_destination(definition_tail)
        else {
            line_index += 1;
            continue;
        };
        let Some(title_bytes) = markdown_definition_title_bytes(remainder) else {
            line_index += 1;
            continue;
        };
        definition_count += 1;
        if definition_count > MAX_MARKDOWN_DEFINITIONS_PER_DOCUMENT {
            return Err(format!(
                "Markdown contains more than {MAX_MARKDOWN_DEFINITIONS_PER_DOCUMENT} link definitions, exceeding the pre-parse safety limit. Reduce or split the document, then retry."
            ));
        }
        maximum_expansion_bytes =
            maximum_expansion_bytes.max(destination.len().saturating_add(title_bytes));
        if let Some(message) = bounded_link_text_failure(
            label,
            MAX_LINK_LABEL_CODE_UNITS,
            MAX_LINK_LABEL_BYTES,
            "link label",
        ) {
            return Err(message);
        }
        if let Some(message) = bounded_link_text_failure(
            destination,
            MAX_LINK_TARGET_CODE_UNITS,
            MAX_LINK_TARGET_BYTES,
            "link target",
        ) {
            return Err(message);
        }
        line_index += 1;
    }
    Ok(maximum_expansion_bytes)
}

fn markdown_syntax_candidate_count(body: &str) -> usize {
    body.bytes()
        .filter(|byte| {
            (*byte > 0 && *byte < 0x20 && !matches!(byte, b'\t' | b'\n' | b'\r'))
                || matches!(byte, 0x21..=0x2f | 0x3a..=0x40 | 0x5b..=0x60 | 0x7b..=0x7e)
        })
        .count()
}

fn markdown_work_inspection(body: &str) -> MarkdownWorkInspection {
    let mut inspection = MarkdownWorkInspection::default();
    let mut attention_runs = 0usize;
    let mut attention_markers = 0usize;
    let mut media_depth = 0usize;
    let mut active_container_depth = 0usize;
    let mut fence: Option<(char, usize, usize)> = None;
    let mut html_block: Option<(MarkdownHtmlBlock, usize)> = None;
    let spans = line_spans(body);
    for span in &spans {
        let source_line = &body[span.start..span.content_end];
        let (line, container_depth) = markdown_container_content_and_depth(source_line);
        let indentation_columns = markdown_indentation_columns(source_line);
        if container_depth > 0 {
            inspection.container_work_units = inspection
                .container_work_units
                .saturating_add(container_depth.saturating_mul(2));
            active_container_depth = container_depth;
        } else if active_container_depth > 0
            && !source_line.trim().is_empty()
            && indentation_columns >= active_container_depth.saturating_mul(2)
        {
            inspection.container_work_units = inspection
                .container_work_units
                .saturating_add(active_container_depth);
        } else {
            active_container_depth = 0;
            let candidate = source_line.trim_start_matches([' ', '\t']);
            if markdown_container_attempt(candidate) {
                inspection.container_work_units += 1;
            }
        }
        if inspection.container_work_units > MAX_MARKDOWN_CONTAINER_WORK_UNITS_PER_DOCUMENT {
            inspection.container_work_units = MAX_MARKDOWN_CONTAINER_WORK_UNITS_PER_DOCUMENT + 1;
            inspection.failure = Some(format!(
                "Markdown list and blockquote continuation work exceeds the {MAX_MARKDOWN_CONTAINER_WORK_UNITS_PER_DOCUMENT}-unit per-document pre-parse safety limit. Reduce or split the document, then retry."
            ));
            return inspection;
        }
        let leading_spaces = line
            .chars()
            .take_while(|character| *character == ' ')
            .count();
        let trimmed = &line[leading_spaces.min(line.len())..];
        if let Some((marker, minimum, opening_depth)) = fence {
            if container_depth < opening_depth {
                fence = None;
            } else {
                if leading_spaces <= 3 {
                    let marker_count = trimmed
                        .chars()
                        .take_while(|character| *character == marker)
                        .count();
                    if marker_count >= minimum
                        && trimmed[marker_count..].chars().all(char::is_whitespace)
                    {
                        fence = None;
                    }
                }
                continue;
            }
        }
        if let Some((active_html_block, opening_depth)) = html_block.as_ref() {
            if container_depth < *opening_depth {
                html_block = None;
            } else {
                if active_html_block.ends_on(trimmed) {
                    html_block = None;
                }
                continue;
            }
        }
        if container_depth > MAX_MARKDOWN_CONTAINER_NESTING_DEPTH {
            inspection.failure = Some(format!(
                "Markdown list and blockquote nesting exceeds the {MAX_MARKDOWN_CONTAINER_NESTING_DEPTH}-level pre-parse safety limit. Reduce nesting, then retry."
            ));
            return inspection;
        }
        if leading_spaces >= 4 {
            continue;
        }
        if let Some((marker, marker_count)) = markdown_fence_opener(trimmed) {
            fence = Some((marker, marker_count, container_depth));
            continue;
        }
        if let Some(started_html_block) = markdown_html_block_start(trimmed) {
            if !started_html_block.ends_on(trimmed) {
                html_block = Some((started_html_block, container_depth));
            }
            continue;
        }
        if markdown_thematic_break(trimmed) {
            continue;
        }
        if trimmed.is_empty() {
            media_depth = 0;
            continue;
        }

        let bytes = trimmed.as_bytes();
        let mut index = 0usize;
        while index < bytes.len() {
            if bytes[index] == b'\\' {
                index = (index + 2).min(bytes.len());
                continue;
            }
            if bytes[index] == b'`' {
                let marker_count = bytes[index..]
                    .iter()
                    .take_while(|byte| **byte == b'`')
                    .count();
                if let Some(end) =
                    markdown_inline_code_end(bytes, index + marker_count, marker_count)
                {
                    index = end;
                    continue;
                }
                index += marker_count;
                continue;
            }
            if matches!(bytes[index], b'*' | b'_') {
                let marker = bytes[index];
                attention_runs += 1;
                if attention_runs > MAX_MARKDOWN_ATTENTION_RUNS_PER_DOCUMENT {
                    inspection.failure = Some(format!(
                        "Markdown emphasis delimiter work exceeds the {MAX_MARKDOWN_ATTENTION_RUNS_PER_DOCUMENT}-run pre-parse safety limit. Reduce or split the document, then retry."
                    ));
                    return inspection;
                }
                inspection.attention_work_units = attention_runs.saturating_mul(spans.len());
                if inspection.attention_work_units > MAX_MARKDOWN_ATTENTION_WORK_UNITS_PER_DOCUMENT
                {
                    inspection.attention_work_units =
                        MAX_MARKDOWN_ATTENTION_WORK_UNITS_PER_DOCUMENT + 1;
                    inspection.failure = Some(format!(
                        "Markdown emphasis resolution work exceeds the {MAX_MARKDOWN_ATTENTION_WORK_UNITS_PER_DOCUMENT}-unit per-document pre-parse safety limit. Reduce or split the document, then retry."
                    ));
                    return inspection;
                }
                while bytes.get(index) == Some(&marker) {
                    attention_markers += 1;
                    if attention_markers > MAX_MARKDOWN_ATTENTION_MARKERS_PER_DOCUMENT {
                        inspection.failure = Some(format!(
                            "Markdown emphasis delimiter work exceeds the {MAX_MARKDOWN_ATTENTION_MARKERS_PER_DOCUMENT}-marker-code-unit pre-parse safety limit. Reduce or split the document, then retry."
                        ));
                        return inspection;
                    }
                    index += 1;
                }
                continue;
            }
            if bytes[index] == b'!' && bytes.get(index + 1) == Some(&b'[') {
                media_depth += 1;
                if media_depth > MAX_MARKDOWN_MEDIA_NESTING_DEPTH {
                    inspection.failure = Some(format!(
                        "Markdown link and image label nesting exceeds the {MAX_MARKDOWN_MEDIA_NESTING_DEPTH}-level pre-parse safety limit. Reduce nesting, then retry."
                    ));
                    return inspection;
                }
                index += 2;
                continue;
            }
            if bytes[index] == b'[' {
                media_depth += 1;
                if media_depth > MAX_MARKDOWN_MEDIA_NESTING_DEPTH {
                    inspection.failure = Some(format!(
                        "Markdown link and image label nesting exceeds the {MAX_MARKDOWN_MEDIA_NESTING_DEPTH}-level pre-parse safety limit. Reduce nesting, then retry."
                    ));
                    return inspection;
                }
            } else if bytes[index] == b']' {
                let closing_count = bytes[index..]
                    .iter()
                    .take_while(|byte| **byte == b']')
                    .count();
                let closing_work = closing_count.saturating_mul(closing_count.saturating_sub(1));
                if closing_work
                    > MAX_MARKDOWN_LABEL_END_WORK_UNITS_PER_DOCUMENT
                        .saturating_sub(inspection.label_end_work_units)
                {
                    inspection.label_end_work_units =
                        MAX_MARKDOWN_LABEL_END_WORK_UNITS_PER_DOCUMENT + 1;
                    inspection.failure = Some(format!(
                        "Markdown link-label closing work exceeds the {MAX_MARKDOWN_LABEL_END_WORK_UNITS_PER_DOCUMENT}-unit per-document pre-parse safety limit. Reduce or split the document, then retry."
                    ));
                    return inspection;
                }
                inspection.label_end_work_units += closing_work;
                media_depth = media_depth.saturating_sub(1);
                index += closing_count;
                continue;
            }
            index += 1;
        }
    }
    inspection.attention_work_units = attention_runs.saturating_mul(spans.len());
    let parser = Parser::new_ext(body, Options::ENABLE_STRIKETHROUGH);
    inspection.link_candidates = parser.reference_definitions().iter().count();
    let media_candidates = parser
        .filter(|event| matches!(event, Event::Start(Tag::Link { .. } | Tag::Image { .. })))
        .count();
    inspection.link_candidates += media_candidates;
    if media_candidates > MAX_MARKDOWN_LINKS_PER_DOCUMENT {
        inspection.failure = Some(format!(
            "Markdown contains more than {MAX_MARKDOWN_LINKS_PER_DOCUMENT} links and images, exceeding the pre-parse safety limit. Reduce or split the document, then retry."
        ));
    }
    inspection
}

fn markdown_inline_work_failure(body: &str) -> Option<String> {
    markdown_work_inspection(body).failure
}

fn markdown_indentation_columns(line: &str) -> usize {
    line.chars()
        .take_while(|character| matches!(character, ' ' | '\t'))
        .fold(0usize, |columns, character| {
            if character == '\t' {
                columns + (4 - columns % 4)
            } else {
                columns + 1
            }
        })
}

fn markdown_container_attempt(line: &str) -> bool {
    line.starts_with(['>', '*', '+', '-']) || {
        let digits = line
            .as_bytes()
            .iter()
            .take(9)
            .take_while(|byte| byte.is_ascii_digit())
            .count();
        digits > 0
            && line
                .as_bytes()
                .get(digits)
                .is_some_and(|marker| matches!(marker, b'.' | b')'))
    }
}

fn markdown_inline_code_end(bytes: &[u8], mut index: usize, marker_count: usize) -> Option<usize> {
    while index < bytes.len() {
        if bytes[index] != b'`' {
            index += 1;
            continue;
        }
        let candidate_count = bytes[index..]
            .iter()
            .take_while(|byte| **byte == b'`')
            .count();
        if candidate_count == marker_count {
            return Some(index + candidate_count);
        }
        index += candidate_count;
    }
    None
}

fn markdown_fence_opener(line: &str) -> Option<(char, usize)> {
    let marker = line
        .chars()
        .next()
        .filter(|marker| matches!(marker, '`' | '~'))?;
    let marker_count = line
        .chars()
        .take_while(|character| *character == marker)
        .count();
    if marker_count < 3 {
        return None;
    }
    let remainder = &line[marker_count..];
    (marker != '`' || !remainder.contains('`')).then_some((marker, marker_count))
}

fn markdown_definition_destination(value: &str) -> Option<(&str, &str)> {
    if let Some(angled) = value.strip_prefix('<') {
        let mut escaped = false;
        for (offset, character) in angled.char_indices() {
            if character == '>' && !escaped {
                return Some((&angled[..offset], &angled[offset + 1..]));
            }
            if character == '<' && !escaped {
                return None;
            }
            escaped = character == '\\' && !escaped;
            if character != '\\' {
                escaped = false;
            }
        }
        return None;
    }
    let mut escaped = false;
    let mut parenthesis_depth = 0usize;
    let mut end = value.len();
    for (offset, character) in value.char_indices() {
        if character.is_whitespace() && !escaped {
            end = offset;
            break;
        }
        if !escaped {
            match character {
                '(' => {
                    parenthesis_depth += 1;
                    if parenthesis_depth > 32 {
                        return None;
                    }
                }
                ')' => parenthesis_depth = parenthesis_depth.checked_sub(1)?,
                _ => {}
            }
        }
        escaped = character == '\\' && !escaped;
        if character != '\\' {
            escaped = false;
        }
    }
    (end > 0 && parenthesis_depth == 0).then_some((&value[..end], &value[end..]))
}

fn markdown_definition_title_bytes(value: &str) -> Option<usize> {
    let value = value.trim_start();
    if value.is_empty() {
        return Some(0);
    }
    let Some(opening) = value.chars().next() else {
        return Some(0);
    };
    let closing = match opening {
        '"' | '\'' => opening,
        '(' => ')',
        _ => return None,
    };
    let mut escaped = false;
    for (offset, character) in value[opening.len_utf8()..].char_indices() {
        if character == closing && !escaped {
            let end = opening.len_utf8() + offset + character.len_utf8();
            return value[end..].trim().is_empty().then_some(offset);
        }
        escaped = character == '\\' && !escaped;
        if character != '\\' {
            escaped = false;
        }
    }
    None
}

fn markdown_container_content(line: &str) -> &str {
    markdown_container_content_and_depth(line).0
}

fn markdown_container_content_and_depth(mut line: &str) -> (&str, usize) {
    let mut depth = 0usize;
    loop {
        let leading = line
            .chars()
            .take_while(|character| *character == ' ')
            .count();
        if leading > 3 {
            return (line, depth);
        }
        let candidate = &line[leading..];
        if let Some(after_quote) = candidate.strip_prefix('>') {
            depth += 1;
            line = after_quote.strip_prefix([' ', '\t']).unwrap_or(after_quote);
            continue;
        }
        if markdown_thematic_break(candidate) {
            return (line, depth);
        }
        if let Some(after_marker) = markdown_list_item_content(candidate) {
            depth += 1;
            line = after_marker;
            continue;
        }
        return (line, depth);
    }
}

fn markdown_thematic_break(line: &str) -> bool {
    let mut marker = None;
    let mut count = 0usize;
    for character in line.chars() {
        if character.is_whitespace() {
            continue;
        }
        if !matches!(character, '*' | '-' | '_') {
            return false;
        }
        if marker.is_some_and(|expected| expected != character) {
            return false;
        }
        marker = Some(character);
        count += 1;
    }
    count >= 3
}

fn markdown_list_item_content(line: &str) -> Option<&str> {
    let marker_end = if line
        .as_bytes()
        .first()
        .is_some_and(|marker| matches!(marker, b'-' | b'+' | b'*'))
    {
        1
    } else {
        let digit_count = line
            .as_bytes()
            .iter()
            .take(9)
            .take_while(|byte| byte.is_ascii_digit())
            .count();
        if digit_count == 0
            || !line
                .as_bytes()
                .get(digit_count)
                .is_some_and(|marker| matches!(marker, b'.' | b')'))
        {
            return None;
        }
        digit_count + 1
    };
    let after_marker = &line[marker_end..];
    if after_marker.is_empty() {
        return Some(after_marker);
    }
    let padding = after_marker
        .chars()
        .take(4)
        .take_while(|character| *character == ' ')
        .count();
    if padding > 0 {
        return Some(&after_marker[padding..]);
    }
    after_marker.strip_prefix('\t')
}

#[derive(Clone, Debug)]
enum MarkdownHtmlBlock {
    RawTag(&'static str),
    Until(&'static str),
    UntilBlankLine,
}

impl MarkdownHtmlBlock {
    fn ends_on(&self, line: &str) -> bool {
        match self {
            Self::RawTag(tag) => {
                let closing = format!("</{tag}>");
                ascii_case_insensitive_contains(line, &closing)
            }
            Self::Until(terminator) => line.contains(terminator),
            Self::UntilBlankLine => line.trim().is_empty(),
        }
    }
}

fn markdown_html_block_start(line: &str) -> Option<MarkdownHtmlBlock> {
    const RAW_TAGS: [&str; 4] = ["pre", "script", "style", "textarea"];
    const BLOCK_TAGS: [&str; 62] = [
        "address",
        "article",
        "aside",
        "base",
        "basefont",
        "blockquote",
        "body",
        "caption",
        "center",
        "col",
        "colgroup",
        "dd",
        "details",
        "dialog",
        "dir",
        "div",
        "dl",
        "dt",
        "fieldset",
        "figcaption",
        "figure",
        "footer",
        "form",
        "frame",
        "frameset",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "head",
        "header",
        "hr",
        "html",
        "iframe",
        "legend",
        "li",
        "link",
        "main",
        "menu",
        "menuitem",
        "nav",
        "noframes",
        "ol",
        "optgroup",
        "option",
        "p",
        "param",
        "search",
        "section",
        "summary",
        "table",
        "tbody",
        "td",
        "tfoot",
        "th",
        "thead",
        "title",
        "tr",
        "track",
        "ul",
    ];
    if line.starts_with("<!--") {
        return Some(MarkdownHtmlBlock::Until("-->"));
    }
    if line.starts_with("<?") {
        return Some(MarkdownHtmlBlock::Until("?>"));
    }
    if line.starts_with("<![CDATA[") {
        return Some(MarkdownHtmlBlock::Until("]]>"));
    }
    if line
        .strip_prefix("<!")
        .and_then(|remainder| remainder.as_bytes().first())
        .is_some_and(u8::is_ascii_alphabetic)
    {
        return Some(MarkdownHtmlBlock::Until(">"));
    }
    let after_open = line.strip_prefix('<')?;
    let closing_tag = after_open.starts_with('/');
    let after_open = after_open.strip_prefix('/').unwrap_or(after_open);
    let tag_end = after_open
        .bytes()
        .position(|byte| !(byte.is_ascii_alphanumeric() || byte == b'-'))
        .unwrap_or(after_open.len());
    if tag_end == 0 {
        return None;
    }
    let tag = &after_open[..tag_end];
    let boundary = &after_open[tag_end..];
    if !boundary.is_empty() && !boundary.starts_with([' ', '\t', '>', '/']) {
        return None;
    }
    if !closing_tag
        && let Some(raw_tag) = RAW_TAGS
            .iter()
            .find(|candidate| tag.eq_ignore_ascii_case(candidate))
    {
        return Some(MarkdownHtmlBlock::RawTag(raw_tag));
    }
    if BLOCK_TAGS
        .iter()
        .any(|candidate| tag.eq_ignore_ascii_case(candidate))
    {
        return Some(MarkdownHtmlBlock::UntilBlankLine);
    }
    markdown_complete_html_tag(line).then_some(MarkdownHtmlBlock::UntilBlankLine)
}

fn ascii_case_insensitive_contains(value: &str, needle: &str) -> bool {
    value
        .as_bytes()
        .windows(needle.len())
        .any(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
}

fn markdown_complete_html_tag(line: &str) -> bool {
    let bytes = line.as_bytes();
    let mut index = 1usize;
    let closing = bytes.get(index) == Some(&b'/');
    if closing {
        index += 1;
    }
    if !bytes.get(index).is_some_and(u8::is_ascii_alphabetic) {
        return false;
    }
    index += 1;
    while bytes
        .get(index)
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
    {
        index += 1;
    }
    if closing {
        while bytes
            .get(index)
            .is_some_and(|byte| matches!(byte, b' ' | b'\t'))
        {
            index += 1;
        }
        return bytes.get(index) == Some(&b'>')
            && bytes[index + 1..].iter().all(u8::is_ascii_whitespace);
    }
    loop {
        let whitespace_start = index;
        while bytes
            .get(index)
            .is_some_and(|byte| matches!(byte, b' ' | b'\t'))
        {
            index += 1;
        }
        if bytes.get(index) == Some(&b'>') {
            return bytes[index + 1..].iter().all(u8::is_ascii_whitespace);
        }
        if bytes.get(index) == Some(&b'/') && bytes.get(index + 1) == Some(&b'>') {
            return bytes[index + 2..].iter().all(u8::is_ascii_whitespace);
        }
        if index == whitespace_start
            || !bytes
                .get(index)
                .is_some_and(|byte| byte.is_ascii_alphabetic() || matches!(byte, b'_' | b':'))
        {
            return false;
        }
        index += 1;
        while bytes.get(index).is_some_and(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b':' | b'.' | b'-')
        }) {
            index += 1;
        }
        while bytes
            .get(index)
            .is_some_and(|byte| matches!(byte, b' ' | b'\t'))
        {
            index += 1;
        }
        if bytes.get(index) != Some(&b'=') {
            continue;
        }
        index += 1;
        while bytes
            .get(index)
            .is_some_and(|byte| matches!(byte, b' ' | b'\t'))
        {
            index += 1;
        }
        if let Some(quote @ (b'\'' | b'"')) = bytes.get(index).copied() {
            index += 1;
            while bytes.get(index).is_some_and(|byte| *byte != quote) {
                index += 1;
            }
            if bytes.get(index) != Some(&quote) {
                return false;
            }
            index += 1;
        } else {
            let value_start = index;
            while bytes.get(index).is_some_and(|byte| {
                !byte.is_ascii_whitespace()
                    && !matches!(byte, b'"' | b'\'' | b'=' | b'<' | b'>' | b'`')
            }) {
                index += 1;
            }
            if index == value_start {
                return false;
            }
        }
    }
}

fn resolve_link(
    source_id: &str,
    source_path: &str,
    candidate: LinkCandidate,
    concept_paths: &BTreeSet<String>,
    directories: &BTreeSet<String>,
    reserved_paths: &BTreeSet<String>,
) -> ConceptLink {
    let raw = candidate.target.clone();
    let (path_and_query, fragment) = split_once(&raw, '#');
    let (path, query) = split_once(path_and_query, '?');
    let fragment = fragment.map(str::to_owned);
    let query = query.map(str::to_owned);
    let external = has_uri_scheme(path) || path.starts_with("//");
    let (classification, target_id) = if raw.is_empty() || has_link_control_character(&raw) {
        (LinkClassification::Invalid, None)
    } else if external {
        (LinkClassification::External, None)
    } else if path.is_empty() && fragment.is_some() && query.is_none() {
        (LinkClassification::Fragment, None)
    } else if path.is_empty() || path.contains('\\') {
        (LinkClassification::Invalid, None)
    } else {
        match normalize_link_path(source_path, path) {
            LinkPathResult::Invalid => (LinkClassification::Invalid, None),
            LinkPathResult::Outside => (LinkClassification::OutOfBundle, None),
            LinkPathResult::Contained { path: resolved, .. } if directories.contains(&resolved) => {
                (LinkClassification::Directory, None)
            }
            LinkPathResult::Contained { path: resolved, .. }
                if concept_paths.contains(&resolved) =>
            {
                (
                    LinkClassification::Internal,
                    Some(resolved.trim_end_matches(".md").to_owned()),
                )
            }
            LinkPathResult::Contained { path: resolved, .. }
                if reserved_paths.contains(&resolved) =>
            {
                if file_name(&resolved) == "index.md" {
                    (LinkClassification::Directory, None)
                } else {
                    (LinkClassification::Invalid, None)
                }
            }
            LinkPathResult::Contained {
                path: resolved,
                trailing_separator,
            } if resolved.ends_with(".md") || trailing_separator => {
                (LinkClassification::Broken, None)
            }
            LinkPathResult::Contained { .. } => (LinkClassification::Invalid, None),
        }
    };
    ConceptLink {
        source_id: source_id.to_owned(),
        raw_target: raw,
        label: candidate.label,
        classification,
        range: candidate.range,
        target_id,
        fragment,
        query,
    }
}

enum LinkPathResult {
    Invalid,
    Outside,
    Contained {
        path: String,
        trailing_separator: bool,
    },
}

fn normalize_link_path(source_path: &str, target: &str) -> LinkPathResult {
    let Some(decoded) = percent_decode(target) else {
        return LinkPathResult::Invalid;
    };
    let decoded = decoded.replace('\\', "/");
    if has_link_control_character(&decoded) {
        return LinkPathResult::Invalid;
    }
    let base = if decoded.starts_with('/') {
        Vec::new()
    } else {
        source_path
            .rsplit_once('/')
            .map(|(parent, _)| parent.split('/').map(str::to_owned).collect())
            .unwrap_or_default()
    };
    let mut parts = base;
    for part in decoded
        .trim_start_matches('/')
        .replace('\\', "/")
        .split('/')
    {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return LinkPathResult::Outside;
                }
            }
            part => parts.push(part.to_owned()),
        }
    }
    LinkPathResult::Contained {
        path: parts.join("/"),
        trailing_separator: decoded.ends_with('/'),
    }
}

pub(crate) fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut result = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = *bytes.get(index + 1)?;
            let low = *bytes.get(index + 2)?;
            result.push((hex(high)? << 4) | hex(low)?);
            index += 3;
        } else {
            result.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(result).ok()
}

fn hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn split_once(value: &str, delimiter: char) -> (&str, Option<&str>) {
    value
        .split_once(delimiter)
        .map_or((value, None), |(left, right)| (left, Some(right)))
}

fn has_uri_scheme(value: &str) -> bool {
    value.find(':').is_some_and(|colon| {
        colon > 0
            && value[..colon]
                .chars()
                .next()
                .is_some_and(|character| character.is_ascii_alphabetic())
            && value[..colon]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    })
}

pub(crate) fn has_control_character(value: &str) -> bool {
    value.chars().any(|character| {
        let code = u32::from(character);
        code <= 0x1f || (0x7f..=0x9f).contains(&code)
    })
}

fn has_link_control_character(value: &str) -> bool {
    value.chars().any(|character| {
        let code = u32::from(character);
        code <= 0x1f || code == 0x7f
    })
}

fn one_character_end(text: &str, start: usize, boundary: usize) -> usize {
    text[start..boundary]
        .chars()
        .next()
        .map_or(start, |character| start + character.len_utf8())
}

fn range_for(text: &str, start: usize, end: usize) -> SourceRange {
    SourceRange {
        start: position_for(text, start),
        end: position_for(text, end),
    }
}

fn source_position_index(text: &str) -> Vec<(usize, SourcePosition)> {
    let mut positions = vec![(0, SourcePosition::default())];
    let mut position = SourcePosition::default();
    let mut characters = text.char_indices().peekable();
    while let Some((offset, character)) = characters.next() {
        position.offset += character.len_utf16();
        if character == '\r' {
            position.line += 1;
            position.character = 0;
            positions.push((offset + character.len_utf8(), position.clone()));
            if characters.peek().is_some_and(|(_, next)| *next == '\n') {
                let (newline, _) = characters.next().expect("peeked newline exists");
                position.offset += 1;
                positions.push((newline + 1, position.clone()));
            }
        } else if character == '\n' {
            position.line += 1;
            position.character = 0;
            positions.push((offset + character.len_utf8(), position.clone()));
        } else {
            position.character += character.len_utf16();
            positions.push((offset + character.len_utf8(), position.clone()));
        }
    }
    positions
}

fn range_for_with_position_index(
    text: &str,
    start: usize,
    end: usize,
    positions: &[(usize, SourcePosition)],
) -> SourceRange {
    let position = |offset: usize| {
        let offset = offset.min(text.len());
        let index = positions.partition_point(|(boundary, _)| *boundary <= offset) - 1;
        positions[index].1.clone()
    };
    SourceRange {
        start: position(start),
        end: position(end),
    }
}

fn position_for(text: &str, byte_offset: usize) -> SourcePosition {
    let prefix = &text[..byte_offset.min(text.len())];
    let mut line = 0usize;
    let mut character = 0usize;
    let mut chars = prefix.chars().peekable();
    while let Some(value) = chars.next() {
        if value == '\r' {
            if chars.peek().is_some_and(|next| *next == '\n') {
                chars.next();
            }
            line += 1;
            character = 0;
        } else if value == '\n' {
            line += 1;
            character = 0;
        } else {
            character += value.len_utf16();
        }
    }
    SourcePosition {
        offset: prefix.encode_utf16().count(),
        line,
        character,
    }
}

fn normalize_ranges(ranges: &mut Vec<(usize, usize)>) {
    ranges.sort_unstable();
    let mut normalized: Vec<(usize, usize)> = Vec::with_capacity(ranges.len());
    for (start, end) in ranges.drain(..) {
        if let Some((_, previous_end)) = normalized.last_mut()
            && start <= *previous_end
        {
            *previous_end = (*previous_end).max(end);
        } else {
            normalized.push((start, end));
        }
    }
    *ranges = normalized;
}

fn sorted_range_contains(ranges: &[(usize, usize)], offset: usize) -> bool {
    let index = ranges.partition_point(|(start, _)| *start <= offset);
    index > 0 && offset < ranges[index - 1].1
}

#[derive(Clone, Copy)]
struct LineSpan {
    start: usize,
    content_end: usize,
    end: usize,
}

fn line_spans(text: &str) -> Vec<LineSpan> {
    let bytes = text.as_bytes();
    let mut lines = Vec::new();
    let mut start = 0usize;
    let mut cursor = 0usize;
    while cursor < bytes.len() {
        if bytes[cursor] == b'\r' {
            let end = if bytes.get(cursor + 1) == Some(&b'\n') {
                cursor + 2
            } else {
                cursor + 1
            };
            lines.push(LineSpan {
                start,
                content_end: cursor,
                end,
            });
            start = end;
            cursor = end;
        } else if bytes[cursor] == b'\n' {
            let end = cursor + 1;
            lines.push(LineSpan {
                start,
                content_end: cursor,
                end,
            });
            start = end;
            cursor = end;
        } else {
            cursor += 1;
        }
    }
    if start < bytes.len() || bytes.is_empty() {
        lines.push(LineSpan {
            start,
            content_end: bytes.len(),
            end: bytes.len(),
        });
    }
    lines
}

fn normalize_line_breaks(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    for line in line_spans(text) {
        result.push_str(&text[line.start..line.content_end]);
        if line.end > line.content_end {
            result.push('\n');
        }
    }
    result
}

enum CanonicalPathError {
    Read(&'static str),
    ResourceLimit,
}

fn canonical_path(value: &str) -> Result<String, CanonicalPathError> {
    if value.is_empty() {
        return Err(CanonicalPathError::Read("Bundle path is empty."));
    }
    let normalized = normalized_path(value);
    let windows_drive = normalized
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphabetic)
        && normalized.as_bytes().get(1) == Some(&b':')
        && normalized.as_bytes().get(2) == Some(&b'/');
    if normalized.starts_with('/') || windows_drive {
        return Err(CanonicalPathError::Read(
            "Bundle path must be relative to the bundle root.",
        ));
    }
    if has_control_character(&normalized) {
        return Err(CanonicalPathError::Read(
            "Bundle path contains a control character.",
        ));
    }
    let mut parts = Vec::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(CanonicalPathError::Read(
                        "Bundle path escapes the bundle root.",
                    ));
                }
            }
            part => {
                parts.push(part);
                if parts.len() > MAX_PROVIDER_PATH_SEGMENTS {
                    return Err(CanonicalPathError::ResourceLimit);
                }
            }
        }
    }
    if parts.is_empty() {
        Err(CanonicalPathError::Read(
            "Bundle path does not identify a document.",
        ))
    } else {
        Ok(parts.join("/"))
    }
}

fn normalized_path(value: &str) -> String {
    value.replace('\\', "/")
}

fn compare_utf16(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn is_reserved(path: &str) -> bool {
    matches!(file_name(path), "index.md" | "log.md")
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn directory_set(paths: &BTreeSet<String>) -> BTreeSet<String> {
    let mut result = BTreeSet::from([String::new()]);
    for path in paths {
        let mut parts = path.split('/').collect::<Vec<_>>();
        parts.pop();
        while !parts.is_empty() {
            result.insert(parts.join("/"));
            parts.pop();
        }
    }
    result
}

fn failure(
    uri: &str,
    path: &str,
    reason: ParseFailureReason,
    message: &str,
    scope: Option<&str>,
) -> ParseFailure {
    ParseFailure {
        kind: "parse-failure".to_owned(),
        uri: uri.to_owned(),
        bundle_path: path.to_owned(),
        reason,
        scope: scope.map(str::to_owned),
        message: message.to_owned(),
        range: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(path: &str, content: &str) -> BundleDocumentInput {
        BundleDocumentInput {
            uri: format!("file:///bundle/{path}"),
            bundle_path: path.to_owned(),
            content: Some(DocumentContent::Text(content.to_owned())),
            content_hash: None,
            identity_only_failure: None,
            invalid_utf16_fields: None,
        }
    }

    #[test]
    fn parses_concepts_and_document_relative_links() {
        let bundle = parse_bundle(ParseBundleInput {
            root_uri: "file:///bundle".to_owned(),
            invalid_root_uri_utf16: None,
            revision: 2,
            documents: vec![
                document("index.md", "---\nokf_version: \"0.1\"\n---\n"),
                document(
                    "area/source.md",
                    "---\ntype: note\ntitle: Source\n---\n[Target](../target.md)\n",
                ),
                document("target.md", "---\ntype: note\ntitle: Target\n---\n"),
            ],
        });
        assert!(bundle.failures.is_empty(), "{:#?}", bundle.failures);
        assert_eq!(bundle.concepts.len(), 2);
        assert_eq!(
            bundle.concepts[0].links[0].classification,
            LinkClassification::Internal
        );
        assert_eq!(
            bundle.concepts[0].links[0].target_id.as_deref(),
            Some("target")
        );
    }

    #[test]
    fn rejects_invalid_utf8_without_panicking() {
        let mut input = document("bad.md", "");
        input.content = Some(DocumentContent::Bytes(vec![0xff]));
        let bundle = parse_bundle(ParseBundleInput {
            root_uri: "file:///bundle".to_owned(),
            invalid_root_uri_utf16: None,
            revision: 1,
            documents: vec![input],
        });
        assert_eq!(bundle.failures[0].reason, ParseFailureReason::Decode);
    }

    #[test]
    fn isolates_invalid_utf16_abi_identities_without_losing_siblings() {
        let mut invalid_uri = document("invalid.md", "---\ntype: reference\n---\n");
        invalid_uri.uri = "<provider-uri-invalid-unicode>".to_owned();
        invalid_uri.invalid_utf16_fields = Some(crate::InvalidUtf16DocumentFields {
            uri: true,
            ..crate::InvalidUtf16DocumentFields::default()
        });
        let bundle = parse_bundle(ParseBundleInput {
            root_uri: "file:///bundle".to_owned(),
            invalid_root_uri_utf16: None,
            revision: 1,
            documents: vec![
                invalid_uri,
                document("sibling.md", "---\ntype: note\n---\n"),
            ],
        });
        assert_eq!(
            bundle
                .concepts
                .iter()
                .map(|concept| concept.id.as_str())
                .collect::<Vec<_>>(),
            vec!["sibling"]
        );
        assert_eq!(bundle.failures.len(), 1);
        assert_eq!(
            bundle.failures[0].message,
            "Source URI contains an unpaired UTF-16 surrogate."
        );

        let root = parse_bundle(ParseBundleInput {
            root_uri: "<bundle-root-uri-invalid-unicode>".to_owned(),
            invalid_root_uri_utf16: Some(true),
            revision: 1,
            documents: vec![document("sibling.md", "---\ntype: note\n---\n")],
        });
        assert!(root.concepts.is_empty());
        assert_eq!(root.failures[0].scope.as_deref(), Some("bundle"));
        assert_eq!(
            root.failures[0].message,
            "Bundle root URI contains an unpaired UTF-16 surrogate."
        );
    }

    #[test]
    fn rejects_empty_mapping_key_nested_in_a_set_without_panicking() {
        let source =
            "---\ntype: reference\nx: !!set\n  ? !!map\n    ?\n    : one\n---\n# Invalid\n";
        let bundle = parse_bundle(ParseBundleInput {
            root_uri: "file:///bundle".to_owned(),
            invalid_root_uri_utf16: None,
            revision: 1,
            documents: vec![document("invalid.md", source)],
        });
        assert_eq!(bundle.failures.len(), 1);
        assert_eq!(bundle.failures[0].reason, ParseFailureReason::Frontmatter);
        assert!(
            bundle.failures[0]
                .message
                .contains("mappings must use string field names")
        );
        let sequence_source = "set: !!set\n  ? !!map\n    items:\n      - ?\n        : one\n";
        let empty = sequence_source.find("- ?").unwrap() + 3;
        assert_eq!(
            non_string_mapping_key_range(sequence_source),
            Some((empty, empty))
        );
    }

    #[test]
    fn restores_empty_explicit_string_keys_in_tagged_maps() {
        let source = "? !!str\n: one\n";
        assert_eq!(
            rewrite_empty_standard_string_keys(source).as_deref(),
            Some("? \"\"   \n: one\n")
        );
        let commented_flow = "custom: { ? !!str # key\n  : one }\n";
        assert_eq!(
            rewrite_empty_standard_string_keys(commented_flow).as_deref(),
            Some("custom: { ? \"\"    # key\n  : one }\n")
        );
        assert_eq!(
            non_string_mapping_key_range("custom: { ? \"\"    # key\n  : one }\n"),
            None
        );
        let duplicate = "? !!str\n: one\n? !!str \"\"\n: two\n";
        let duplicate_start = duplicate.find("\"\"").unwrap();
        assert_eq!(
            duplicate_mapping_key_range(duplicate),
            Some((duplicate_start, duplicate_start + 1))
        );
        assert!(standard_set_member_tag_is_mapping_key(
            "\n    ? # key\n      !!str \"1\"\n    : value\n"
        ));
        let set_source = "\n  ?\n    ? # key\n      !!str \"1\"\n    : value\n";
        let members = direct_standard_set_member_sources(set_source, 1);
        assert_eq!(members.len(), 1, "{members:#?}");
        assert!(
            standard_set_member_tag_is_mapping_key(&members[0]),
            "{members:#?}"
        );
        assert_eq!(
            standard_set_member_properties(&members[0]).2,
            None,
            "{members:#?}"
        );
        let mut deferred_member = serde_json::json!({"1": "value"});
        restore_collection_set_member_provenance(
            &members[0],
            &mut deferred_member,
            &std::collections::BTreeMap::new(),
            0,
        );
        assert_eq!(
            deferred_member,
            serde_json::json!({"1": "value"}),
            "{members:#?}"
        );
        let mut deferred_set = serde_json::json!({
            TAGGED_KEY: {
                "tag": "tag:yaml.org,2002:set",
                "value": [{"1": "value"}],
                "source": set_source,
            }
        });
        restore_nested_standard_set_member_sources(
            &mut deferred_set,
            &mut std::collections::BTreeMap::new(),
            &mut Vec::new(),
            true,
        );
        assert_eq!(
            deferred_set[TAGGED_KEY]["value"],
            serde_json::json!([{"1": "value"}])
        );
        let deferred_key_source = concat!(
            "---\n",
            "type: reference\n",
            "x: !!set\n",
            "  ?\n",
            "    ? # key\n",
            "      !!str \"1\"\n",
            "    : value\n",
            "---\n",
        );
        let deferred_key_bundle = parse_bundle(ParseBundleInput {
            root_uri: "file:///bundle".to_owned(),
            invalid_root_uri_utf16: None,
            revision: 1,
            documents: vec![document("deferred-key.md", deferred_key_source)],
        });
        assert_eq!(
            deferred_key_bundle.concepts[0].frontmatter.raw["x"][TAGGED_KEY]["value"],
            serde_json::json!([{"1": "value"}])
        );
        assert_eq!(
            standard_tag_semantic("map", source, serde_json::json!({"null": "one"})),
            serde_json::json!({"": "one"})
        );
        let document_source =
            "---\ntype: reference\ncustom: !!map\n  ? !!str\n  : one\n---\n# Empty\n";
        let bundle = parse_bundle(ParseBundleInput {
            root_uri: "file:///bundle".to_owned(),
            invalid_root_uri_utf16: None,
            revision: 1,
            documents: vec![document("empty.md", document_source)],
        });
        let frontmatter = &bundle.concepts[0].frontmatter;
        assert_eq!(
            frontmatter.raw["custom"][TAGGED_KEY]["value"][""],
            Value::String("one".to_owned())
        );
        assert_eq!(
            empty_standard_string_key_anchors("? !!map\n    ? &a !!str\n    : one\n"),
            vec!["a"]
        );
        assert_eq!(
            empty_standard_string_key_anchors("? !!map\n    ? &a\n      !!str\n    : one\n"),
            vec!["a"]
        );
        let mut member = serde_json::json!({
            "$okf-workbench:yaml-tag": {
                "tag": "tag:yaml.org,2002:map",
                "value": {"": "one"},
                "source": "? &a !!str\n: one\n"
            }
        });
        let anchors = restore_collection_set_member_provenance(
            "? !!map\n    ? &a !!str\n    : one\n",
            &mut member,
            &std::collections::BTreeMap::new(),
            0,
        );
        assert_eq!(anchors.len(), 1, "{anchors:#?}");
        assert_eq!(anchors[0].0, "a");
        assert_eq!(
            anchors[0].1[TAGGED_KEY]["tag"],
            Value::String("tag:yaml.org,2002:str".to_owned())
        );
    }

    #[test]
    fn root_field_range_stops_at_empty_nested_mapping_content() {
        let text = "type: reference\nouter:\n  empty:\nafter: value\n";
        let ranges = top_level_field_ranges(text, 0, text.len());
        assert_eq!(
            ranges
                .get("outer")
                .and_then(|range| range.get("end"))
                .and_then(|end| end.get("offset"))
                .and_then(Value::as_u64),
            Some(31)
        );
    }

    #[test]
    fn terminal_empty_field_range_stops_before_its_line_break() {
        let text = "type: reference\nstatus:\n";
        let ranges = top_level_field_ranges(text, 0, text.len());
        assert_eq!(
            ranges
                .get("status")
                .and_then(|range| range.get("end"))
                .and_then(|end| end.get("offset"))
                .and_then(Value::as_u64),
            Some((text.len() - 1) as u64)
        );
    }

    #[test]
    fn converts_radix_integers_across_chunk_boundaries() {
        for (digits, radix, expected) in [
            ("fffffff", 16, "268435455"),
            ("ffffffff", 16, "4294967295"),
            ("1ffffffff", 16, "8589934591"),
            ("7777777777", 8, "1073741823"),
            ("77777777777", 8, "8589934591"),
            ("177777777777", 8, "17179869183"),
            ("000000000", 16, "0"),
        ] {
            assert_eq!(decimal_from_radix(digits, radix).as_deref(), Some(expected));
        }
        assert_eq!(decimal_from_radix("g", 16), None);
    }

    #[test]
    fn plain_scalar_ranges_do_not_hide_tagged_flow_collections() {
        let source = concat!(
            "integer_looking_float: !!float 1\n",
            "anchored_null: &anchored-null !!null \"\"\n",
            "anchored_null_copy: *anchored-null\n",
            "tagged_alias_seed: &tagged-alias !!str \"x\"\n",
            "tagged_alias_set: !!set { ? *tagged-alias, ? *tagged-alias }\n",
            "tagged_alias_direct_set: !!set { ? *tagged-alias, ? !!str \"x\" }\n",
        );
        let brace = source.find('{').expect("flow set has an opening brace");
        let plain = plain_scalar_value_ranges(source);
        assert!(!sorted_range_contains(&plain, brace), "{plain:#?}");
        let flow = flow_collection_ranges(source);
        assert!(flow.iter().any(|(start, _)| *start == brace), "{flow:#?}");
        assert_eq!(alias_mapping_key_range(source, &[]), None);
    }

    #[test]
    fn preserves_block_and_flow_provenance_boundaries() {
        let source = [
            "---",
            "type: reference",
            "tags:",
            "- &tag-anchor !!str \"x\"",
            "tag_copy: *tag-anchor",
            "sequence:",
            "  - &key-anchor key: value",
            "key_copy: *key-anchor",
            "meta: { \"a:b\" : !!str \"x\" }",
            "flow_tags: [",
            "  !!str \"x\", # first",
            "  !!str \"y\"",
            "]",
            "items:",
            "  -",
            "    child: !!str \"x\"",
            "? \"explicit:block\"",
            ": !!str \"block\"",
            "flow_explicit: { ? \"explicit:flow\" : !!str \"flow\" }",
            "flow_plain: { a:b: !!str \"plain\" }",
            "old: &shadow !!str \"old\"",
            "&shadow key: value",
            "shadow_copy: *shadow",
            "flow_old: &flow-shadow !!str \"old\"",
            "flow_mapping: { &flow-shadow key: value }",
            "flow_shadow_copy: *flow-shadow",
            "---",
            "# Boundaries",
            "",
        ]
        .join("\n");
        let bundle = parse_bundle(ParseBundleInput {
            root_uri: "file:///bundle".to_owned(),
            invalid_root_uri_utf16: None,
            revision: 1,
            documents: vec![document("boundaries.md", &source)],
        });
        assert!(bundle.failures.is_empty(), "{:#?}", bundle.failures);
        assert_eq!(bundle.concepts.len(), 1);
    }

    #[test]
    fn preserves_adversarial_standard_tag_boundaries() {
        let cases = [
            (
                "split-properties",
                "split_anchor_tag: &split-anchor # comment\n  !!str \"split value\"\nsplit_anchor_copy: *split-anchor\nsplit_tag_anchor: !!str\n  # comment\n  &split-reverse \"reverse value\"\nsplit_reverse_copy: *split-reverse",
            ),
            (
                "standard-semantics",
                "tagged_timestamp: !!timestamp \"2026-07-22T12:00:00Z\"\ntagged_binary: !!binary |\n  SGVsbG8=\ntagged_float: !!float .inf",
            ),
            (
                "standard-set",
                "semantic_set: !!set\n  ? true\n  ? [a, b]\n  ? alpha",
            ),
            ("tagged-string-key", "!!str true: value"),
            (
                "multiline-quotes",
                "quoted_comment_range: !!str \"one\n  two\" # comment\nquoted_scanner_shapes: \"first\n  ? [one, two]\n  x: one\n  x: two\n  last\"",
            ),
            (
                "direct-sequence-quotes",
                "direct_anchor: &direct-shadow !!str \"real\"\ndirect_quoted:\n  - \"first\n    &direct-shadow !!str fake\"\ndirect_anchor_copy: *direct-shadow",
            ),
        ];
        for (name, fields) in cases {
            let source = format!("---\ntype: reference\n{fields}\n---\n# Boundaries\n");
            let bundle = parse_bundle(ParseBundleInput {
                root_uri: "file:///bundle".to_owned(),
                invalid_root_uri_utf16: None,
                revision: 1,
                documents: vec![document("boundaries.md", &source)],
            });
            assert!(bundle.failures.is_empty(), "{name}: {:#?}", bundle.failures);
        }
    }

    #[test]
    fn preserves_set_rewrite_boundaries() {
        let fields = [
            "tagged_member_set: !!set\n  ? !!str true\n  ? !!int nope",
            "nested_member_set: !!set\n  ? [!!set { ? }, !!set { ? true }]",
            "sibling_set_a: !!set\n  ?\nsibling_set_b: !!set\n  ?",
            "duplicate_alias_seed: &duplicate-alias value\nduplicate_alias_set: !!set { ? *duplicate-alias, ? *duplicate-alias }",
            "tag_anchor_set: !!set &tag-anchor-set { ? *duplicate-alias }",
        ]
        .join("\n");
        let source = format!("---\ntype: reference\n{fields}\n---\n# Boundaries\n");
        let bundle = parse_bundle(ParseBundleInput {
            root_uri: "file:///bundle".to_owned(),
            invalid_root_uri_utf16: None,
            revision: 1,
            documents: vec![document("boundaries.md", &source)],
        });
        assert!(bundle.failures.is_empty(), "{:#?}", bundle.failures);
    }

    #[test]
    fn preserves_tagged_block_scalar_set_member_source() {
        let source = "? !!str |2-\n      !!int \"1\": not a key\n";
        let members = direct_standard_set_member_sources(source, 1);
        assert_eq!(members, vec!["!!str |2-\n      !!int \"1\": not a key\n"]);
        let (lexical, _, tag) = standard_set_member_properties(&members[0]);
        assert_eq!(tag.as_deref(), Some("str"));
        assert_eq!(lexical, "|2-\n      !!int \"1\": not a key\n");
        let mut set = serde_json::json!({
            "$okf-workbench:yaml-tag": {
                "tag": "tag:yaml.org,2002:set",
                "value": [{
                    "$okf-workbench:yaml-tag": {
                        "tag": "tag:yaml.org,2002:str",
                        "value": "  !!int \"1\": not a key",
                        "source": "  !!int \"1\": not a key"
                    }
                }],
                "source": source
            }
        });
        restore_nested_standard_set_member_sources(
            &mut set,
            &mut std::collections::BTreeMap::new(),
            &mut Vec::new(),
            false,
        );
        assert_eq!(
            set.get(TAGGED_KEY)
                .and_then(Value::as_object)
                .and_then(|set| set.get("value"))
                .and_then(Value::as_array)
                .and_then(|members| members.first())
                .and_then(|member| member.get(TAGGED_KEY))
                .and_then(Value::as_object)
                .and_then(|tagged| tagged.get("source"))
                .and_then(Value::as_str),
            Some("|2-\n      !!int \"1\": not a key\n")
        );
    }

    #[test]
    fn reports_invalid_reserved_frontmatter() {
        let bundle = parse_bundle(ParseBundleInput {
            root_uri: "file:///bundle".to_owned(),
            invalid_root_uri_utf16: None,
            revision: 1,
            documents: vec![document(
                "index.md",
                "---\nokf_version: [\n---\n# Malformed bundle\n",
            )],
        });
        assert!(bundle.reserved_documents.is_empty());
        assert_eq!(bundle.failures.len(), 1);
        assert_eq!(bundle.failures[0].reason, ParseFailureReason::Frontmatter);
        assert_eq!(bundle.failures[0].bundle_path, "index.md");
    }

    #[test]
    fn normalizes_excluded_ranges_for_boundary_lookups() {
        let mut ranges = vec![(8, 12), (2, 4), (3, 7), (12, 15), (20, 21)];
        normalize_ranges(&mut ranges);
        assert_eq!(ranges, vec![(2, 7), (8, 15), (20, 21)]);
        for offset in [2, 3, 6, 8, 12, 14, 20] {
            assert!(sorted_range_contains(&ranges, offset), "{offset}");
        }
        for offset in [0, 1, 7, 15, 19, 21] {
            assert!(!sorted_range_contains(&ranges, offset), "{offset}");
        }
    }

    #[test]
    fn indexed_source_positions_match_the_canonical_scanner() {
        let text = "a\r\n日本😀\rZ\n";
        let positions = source_position_index(text);
        let mut offsets = text
            .char_indices()
            .map(|(offset, _)| offset)
            .collect::<Vec<_>>();
        offsets.push(text.len());
        for start in offsets.iter().copied() {
            for end in offsets.iter().copied().filter(|end| *end >= start) {
                assert_eq!(
                    range_for_with_position_index(text, start, end, &positions),
                    range_for(text, start, end),
                    "{start}..{end}"
                );
            }
        }
    }

    #[test]
    fn explicit_zone_timestamps_use_the_strict_contract_form() {
        for value in [
            "2026-07-22T12:00:00Z",
            "2026-07-22T12:00:00.123456789Z",
            "2026-07-22T12:00:00+09:00",
        ] {
            assert!(
                parse_explicit_zone_timestamp(value).is_some(),
                "{value} should be valid"
            );
        }
        for value in [
            "2026-07-22 12:00:00+0000",
            "2026-07-22t12:00:00z",
            "2026-07-22T12:00:00+0900",
            "2026-07-22T12:00:60Z",
        ] {
            assert!(
                parse_explicit_zone_timestamp(value).is_none(),
                "{value} should be invalid"
            );
        }
    }

    #[test]
    fn source_authors_accept_the_canonical_team_form_without_widening_verifier_actors() {
        assert!(is_valid_source_author("team:ga4-docs"));
        assert!(!is_valid_actor("team:ga4-docs"));
        assert!(!is_valid_source_author("team:"));
    }

    #[test]
    fn enforces_aggregate_markdown_work_limit() {
        let markdown_documents = (0..81)
            .map(|index| {
                document(
                    &format!("syntax-{index:03}.md"),
                    &format!("---\ntype: reference\n---\n{}", "!".repeat(1_000)),
                )
            })
            .collect();
        let markdown = parse_bundle(ParseBundleInput {
            root_uri: "file:///bundle".to_owned(),
            invalid_root_uri_utf16: None,
            revision: 1,
            documents: markdown_documents,
        });
        let failure = markdown
            .failures
            .iter()
            .find(|failure| failure.scope.as_deref() == Some("bundle"))
            .expect("aggregate Markdown failure");
        assert_eq!(failure.bundle_path, "syntax-080.md");
        assert!(failure.message.contains("80000 syntax candidates"));
    }
}
