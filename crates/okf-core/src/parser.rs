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
const MAX_PROVIDER_PATH_CODE_UNITS: usize = 4_096;
const MAX_PROVIDER_PATH_BYTES: usize = 4_096;
const MAX_PROVIDER_PATH_SEGMENTS: usize = 64;
const MAX_SOURCE_URI_CODE_UNITS: usize = 16 * 1024;
const MAX_SOURCE_URI_BYTES: usize = 16 * 1024;
const MAX_CONTENT_HASH_CODE_UNITS: usize = 256;
const MAX_FRONTMATTER_SOURCE_BYTES: usize = 64 * 1024;
const MAX_FRONTMATTER_SOURCE_CODE_UNITS: usize = 64 * 1024;
const MAX_FRONTMATTER_LINES: usize = 4_000;
const MAX_FRONTMATTER_STRUCTURAL_TOKENS: usize = 8_000;
const MAX_FRONTMATTER_INDENT_COLUMNS: usize = 128;
const MAX_MARKDOWN_BODY_BYTES: usize = 256 * 1024;
const MAX_MARKDOWN_BODY_CODE_UNITS: usize = 256 * 1024;
const MAX_MARKDOWN_LINES: usize = 20_000;
const MAX_MARKDOWN_LINKS_PER_DOCUMENT: usize = 5_000;
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

#[derive(Debug)]
struct FrontmatterError {
    message: String,
    range: Option<SourceRange>,
    resource_limit: bool,
}

pub fn parse_bundle(mut input: ParseBundleInput) -> ParsedBundle {
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
        normalized_path(&left.bundle_path)
            .cmp(&normalized_path(&right.bundle_path))
            .then_with(|| left.uri.cmp(&right.uri))
    });

    let mut failures = Vec::new();
    let mut decoded = Vec::new();
    let mut seen = BTreeSet::new();
    for document in input.documents {
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
        if canonical_segment_count(&document.bundle_path) > MAX_PROVIDER_PATH_SEGMENTS {
            failures.push(failure(
                &document.uri,
                "<provider-path-exceeds-limit>",
                ParseFailureReason::ResourceLimit,
                "Bundle path exceeds the 64-segment identity safety limit. Reduce directory nesting, then retry.",
                Some("document"),
            ));
            continue;
        }
        let Some(path) = canonical_path(&document.bundle_path) else {
            failures.push(failure(
                &document.uri,
                &document.bundle_path,
                ParseFailureReason::Read,
                "The provider path escapes the selected bundle or is not canonical.",
                None,
            ));
            continue;
        };
        if !path.ends_with(".md") {
            continue;
        }
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
            && document
                .content_hash
                .as_deref()
                .is_some_and(|hash| hash.encode_utf16().count() > MAX_CONTENT_HASH_CODE_UNITS)
        {
            failures.push(failure(
                &document.uri,
                &path,
                ParseFailureReason::ResourceLimit,
                "Content identity exceeds the 256-code-unit safety limit. Refresh the bundle from a conforming provider, then retry.",
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
    for document in decoded {
        if document.identity_only {
            pending.push(PendingConcept {
                concept: partial_concept(&document),
                candidates: Vec::new(),
            });
            continue;
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
        if let Some(message) = concept_metadata_failure(&frontmatter.normalized) {
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
        let candidates = match markdown_links(&body, body_range.start.offset, &document.text) {
            Ok(candidates) => candidates,
            Err(message) => {
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
        total_links += candidates.len();
        if total_links > MAX_LINKS {
            failures.push(failure(
                &input.root_uri,
                "<bundle>",
                ParseFailureReason::ResourceLimit,
                "Bundle parsing refused more than 10,000 retained Markdown links.",
                Some("bundle"),
            ));
            break;
        }
        let normalized = &frontmatter.normalized;
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
        left.id
            .cmp(&right.id)
            .then_with(|| left.source.uri.cmp(&right.source.uri))
    });
    reserved_documents
        .sort_by(|left, right| left.source.bundle_path.cmp(&right.source.bundle_path));
    failures.sort_by(|left, right| {
        left.bundle_path
            .cmp(&right.bundle_path)
            .then_with(|| left.uri.cmp(&right.uri))
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
    if let Some((relative_start, relative_end)) = non_string_mapping_key_range(yaml_source) {
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
    let normalized_yaml = normalize_line_breaks(yaml_source);
    let set_safe_yaml = rewrite_standard_sets_for_serde(&normalized_yaml);
    let anchor_safe_yaml = normalize_hash_anchor_names(&set_safe_yaml);
    let flow_plain_safe_yaml = normalize_tight_flow_plain_keys(&anchor_safe_yaml);
    let parser_yaml =
        mask_large_yaml_integers(&mask_invalid_standard_scalar_tags(&flow_plain_safe_yaml));
    let yaml: serde_yaml::Value = serde_yaml::from_str(&parser_yaml).map_err(|error| {
        let error_text = error.to_string();
        let range = if error_text.contains("duplicate entry with key") {
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
        let message = if error_text.contains("expected ',' or ']'") {
            "Invalid YAML frontmatter: Flow sequence in block collection must be sufficiently indented and end with a ]".to_owned()
        } else if error_text.contains("duplicate entry with key") {
            "Invalid YAML frontmatter: Map keys must be unique".to_owned()
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
    let empty_preserved_anchors = std::collections::BTreeMap::new();
    let empty_value_anchors = std::collections::BTreeMap::new();
    let (pre_preserved_tags, pre_preserved_anchors) = preserve_standard_yaml_tags(
        yaml_source,
        &mut raw,
        &explicit_tags,
        &empty_preserved_anchors,
        &[],
    );
    for (key, value) in pre_preserved_tags {
        explicit_tags.insert(key, value);
    }
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
    for (key, value) in preserved_tags {
        explicit_tags.insert(key, value);
    }
    restore_standard_set_sources(yaml_source, &mut raw, false, &empty_value_anchors);
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

pub(crate) fn is_valid_actor(value: &str) -> bool {
    fn token(value: &str) -> bool {
        !value.is_empty()
            && value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(byte, b'.' | b'_' | b'@' | b':' | b'-' | b'/')
            })
    }

    if value.is_empty() || value.len() > 256 || value.trim() != value {
        return false;
    }
    if let Some(actor) = value
        .strip_prefix("human:")
        .or_else(|| value.strip_prefix("process:"))
    {
        return token(actor);
    }
    let mut parts = value.split('/');
    matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some(producer), Some(version), None) if token(producer) && token(version)
    )
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
                    if let serde_yaml::Value::String(key) = key {
                        path.push(escape(key));
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
            let is_string = tag == "tag:yaml.org,2002:str"
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

fn parsed_string_mapping_key(source: &str, tag_name: Option<&str>) -> Option<String> {
    if tag_name != Some("str") {
        return serde_yaml::from_str::<String>(source).ok();
    }
    serde_yaml::from_str::<serde_yaml::Value>(source)
        .ok()
        .and_then(|value| match value {
            serde_yaml::Value::String(value) => Some(value),
            serde_yaml::Value::Bool(value) => Some(value.to_string()),
            serde_yaml::Value::Number(value) => Some(value.to_string()),
            serde_yaml::Value::Null => Some("null".to_owned()),
            _ => None,
        })
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
        if excluded_ranges
            .iter()
            .any(|(start, end)| *start <= offset && offset < *end)
        {
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
    for tag in [
        "!oset", "!ostr", "!obool", "!oint", "!ofloat", "!onull", "!obigint",
    ] {
        for (offset, _) in source.match_indices(tag) {
            if excluded_ranges
                .iter()
                .any(|(start, end)| *start <= offset && offset < *end)
            {
                continue;
            }
            let line_start = source[..offset]
                .rfind(['\r', '\n'])
                .map_or(0, |newline| newline + 1);
            let prefix = &source[line_start..offset];
            let previous = source[..offset].chars().next_back();
            let following = source[offset + tag.len()..].chars().next();
            if yaml_comment_start(prefix).is_none()
                && prefix.matches('"').count().is_multiple_of(2)
                && prefix.matches('\'').count().is_multiple_of(2)
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
    let excluded_ranges = block_scalar_body_ranges(source);
    let mut quote = None;
    let mut escaped = false;
    let mut comment = false;
    for (offset, character) in source.char_indices() {
        if excluded_ranges
            .iter()
            .any(|(start, end)| *start <= offset && offset < *end)
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
    for (offset, _) in source.match_indices('*') {
        if excluded_ranges
            .iter()
            .any(|(start, end)| *start <= offset && offset < *end)
        {
            continue;
        }
        let line_start = source[..offset]
            .rfind(['\r', '\n'])
            .map_or(0, |newline| newline + 1);
        let prefix = &source[line_start..offset];
        if yaml_comment_start(prefix).is_some()
            || prefix.matches('"').count() % 2 == 1
            || prefix.matches('\'').count() % 2 == 1
        {
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
        let tail = &source[offset + 1..];
        let length = tail
            .find(|character: char| {
                character.is_whitespace() || matches!(character, ',' | ']' | '}')
            })
            .unwrap_or(tail.len());
        let name = &tail[..length];
        if name.is_empty() {
            continue;
        }
        let anchor_defined = yaml_anchor_occurrences_in_ranges(source, &[(0, offset)])
            .into_iter()
            .any(|(anchor_offset, anchor_name)| {
                anchor_name == name
                    && !excluded_ranges
                        .iter()
                        .any(|(start, end)| *start <= anchor_offset && anchor_offset < *end)
            });
        if !anchor_defined {
            return Some(name.to_owned());
        }
    }
    None
}

fn compact_nested_mapping_range(source: &str) -> Option<(usize, usize)> {
    let spans = line_spans(source);
    for (line_index, span) in spans.iter().enumerate() {
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
            let nested_body = &source[candidate.start..candidate.content_end];
            let nested_trimmed = nested_body.trim_start_matches([' ', '\t']);
            if nested_trimmed.is_empty() || nested_trimmed.starts_with('#') {
                return None;
            }
            let nested_indent = nested_body.len() - nested_trimmed.len();
            Some(nested_indent > indent && mapping_key_colon(nested_trimmed).is_some())
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
                if excluded_ranges
                    .iter()
                    .any(|(start, end)| *start <= absolute && absolute < *end)
                    || yaml_comment_start(prefix).is_some()
                    || previous.is_some_and(|character| {
                        !matches!(character, '[' | '{' | ',' | ':' | '?' | '-')
                    })
                    || (previous.is_none()
                        && !follows_deferred_block_node(source, &spans, line_index))
                {
                    search_start = offset + tag.len();
                    continue;
                }
                let after_tag = line[offset + tag.len()..].trim_start();
                let (remainder, _, _) = split_node_properties(after_tag);
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
                if lexical.is_empty() {
                    search_start = offset + tag.len();
                    continue;
                }
                let parsed = serde_yaml::from_str::<serde_yaml::Value>(&lexical).ok();
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
        if excluded_ranges
            .iter()
            .any(|(start, end)| *start <= tag_start && tag_start < *end)
        {
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
        if yaml_comment_start(prefix).is_some()
            || prefix.matches('"').count() % 2 == 1
            || prefix.matches('\'').count() % 2 == 1
        {
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
                    edits.push((
                        start,
                        start + 2,
                        format!("- ?\n{}", " ".repeat(member_indent + 4)),
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
    let mut verbatim_tag = false;
    for (relative, character) in source[start + 1..end].char_indices() {
        let offset = start + 1 + relative;
        if comment {
            if matches!(character, '\r' | '\n') {
                comment = false;
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
            '!' if source[offset..].starts_with("!<") => verbatim_tag = true,
            '"' | '\'' => quote = Some(character),
            '#' if offset == 0
                || source[..offset]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_whitespace) =>
            {
                comment = true;
            }
            '[' | '{' => stack.push(character),
            ']' | '}' => {
                if stack.len() == 1 {
                    let candidate = &source[entry_start..offset];
                    if !candidate.trim().is_empty() {
                        entries.push((entry_start, offset));
                    }
                    break;
                }
                stack.pop();
            }
            ',' if stack.len() == 1 => {
                let candidate = &source[entry_start..offset];
                if !candidate.trim().is_empty() {
                    entries.push((entry_start, offset));
                }
                entry_start = offset + 1;
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

fn normalize_hash_anchor_names(source: &str) -> String {
    let mut names = std::collections::BTreeMap::<String, String>::new();
    let mut replacements = Vec::new();
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
                let start = offset + 1;
                let mut end = start;
                while let Some(next) = source[end..].chars().next() {
                    if next.is_whitespace() || matches!(next, ',' | '[' | ']' | '{' | '}' | ':') {
                        break;
                    }
                    end += next.len_utf8();
                }
                let name = &source[start..end];
                if name.contains('#') {
                    let next_index = names.len();
                    let replacement = names
                        .entry(name.to_owned())
                        .or_insert_with(|| format!("okf_internal_anchor_{next_index}"))
                        .clone();
                    replacements.push((start, end, replacement));
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
                if excluded_ranges
                    .iter()
                    .any(|(start, end)| *start <= absolute && absolute < *end)
                {
                    search_start = offset + tag.len();
                    continue;
                }
                let prefix = &line[..offset];
                let quoted =
                    prefix.matches('"').count() % 2 == 1 || prefix.matches('\'').count() % 2 == 1;
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
                let mask_after_anchor = follows_anchor_property
                    && matches!(tag, "!!null" | "!<tag:yaml.org,2002:null>");
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
    let spans = line_spans(source);
    for span in &spans {
        let line = &source[span.start..span.content_end];
        let syntax = yaml_comment_start(line).map_or(line, |comment| &line[..comment]);
        let mut quote = None;
        let mut escaped = false;
        for (offset, character) in syntax.char_indices() {
            let absolute = span.start + offset;
            if excluded_ranges
                .iter()
                .any(|(start, end)| *start <= absolute && absolute < *end)
            {
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
    for (line_index, span) in spans.iter().enumerate() {
        if excluded_ranges
            .iter()
            .any(|(start, end)| *start <= span.start && span.start < *end)
        {
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

fn non_string_mapping_key_range(source: &str) -> Option<(usize, usize)> {
    let mut excluded_ranges = block_scalar_body_ranges(source);
    excluded_ranges.extend(standard_set_body_ranges(source));
    excluded_ranges.extend(multiline_quoted_scalar_ranges(source));
    if let Some(range) = alias_mapping_key_range(source, &excluded_ranges) {
        return Some(range);
    }
    let spans = line_spans(source);
    for (line_index, line) in spans.iter().enumerate() {
        if excluded_ranges
            .iter()
            .any(|(start, end)| *start <= line.start && line.start < *end)
        {
            continue;
        }
        let body = &source[line.start..line.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        let item = trimmed
            .strip_prefix("- ")
            .or_else(|| (trimmed == "-").then_some(""));
        let mapping_source = item.unwrap_or(trimmed);
        let mapping_offset = body
            .find(mapping_source)
            .unwrap_or_else(|| body.len().saturating_sub(mapping_source.len()));
        if mapping_source == "?" || mapping_source.starts_with("? ") {
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
            let candidate = source[key_start..key_end].trim_end_matches(['\r', '\n']);
            let (plain_candidate, _, key_tag) = split_node_properties(candidate);
            if key_tag != Some("str")
                && serde_yaml::from_str::<serde_yaml::Value>(plain_candidate)
                    .is_ok_and(|value| !matches!(value, serde_yaml::Value::String(_)))
            {
                return Some((key_start, key_start + plain_candidate.len()));
            }
            continue;
        }
        let Some(colon) = mapping_key_colon(mapping_source) else {
            continue;
        };
        let key_source = mapping_source[..colon].trim_end();
        if key_source.is_empty() {
            continue;
        }
        let (plain_key_source, _, key_tag) = split_node_properties(key_source);
        if key_tag == Some("str") {
            continue;
        }
        if serde_yaml::from_str::<serde_yaml::Value>(plain_key_source)
            .is_ok_and(|value| !matches!(value, serde_yaml::Value::String(_)))
        {
            let start = line.start
                + mapping_offset
                + key_source.len().saturating_sub(plain_key_source.len());
            return Some((start, start + plain_key_source.len()));
        }
    }
    None
}

fn multiline_quoted_scalar_ranges(source: &str) -> Vec<(usize, usize)> {
    let spans = line_spans(source);
    spans
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
            } else if (remainder.is_empty() || remainder.starts_with('#')) && tag_name.is_some() {
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
        .collect()
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
                        following_block_end(source, &spans, line_index, indent, false, false),
                    )
                },
            )
        })
        .collect()
}

fn standard_set_tag_occurrences(source: &str) -> Vec<(usize, usize)> {
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
    occurrences
}

fn invalid_flow_block_scalar_range(source: &str) -> Option<(usize, usize, char)> {
    let excluded_ranges = multiline_quoted_scalar_ranges(source);
    let mut flow_depth = 0usize;
    let mut value_start = 0usize;

    for span in line_spans(source) {
        let line = &source[span.start..span.content_end];
        let syntax_end = yaml_comment_start(line).unwrap_or(line.len());
        let syntax = &line[..syntax_end];
        for (relative, character) in syntax.char_indices() {
            let absolute = span.start + relative;
            if excluded_ranges
                .iter()
                .any(|(start, end)| *start <= absolute && absolute < *end)
            {
                continue;
            }
            match character {
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
    for span in line_spans(source) {
        let line = &source[span.start..span.content_end];
        let syntax = yaml_comment_start(line).map_or(line, |comment| &line[..comment]);
        let mut quote = None;
        let mut escaped = false;
        for (offset, character) in syntax.char_indices() {
            let absolute = span.start + offset;
            if excluded_ranges
                .iter()
                .any(|(start, end)| *start <= absolute && absolute < *end)
            {
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
            if tag_name == Some("float")
                || prefix.contains("!<tag:yaml.org,2002:float>")
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
    let mut decimal = vec![0_u8];
    for character in digits.chars() {
        let digit = character.to_digit(radix)?;
        let mut carry = digit;
        for value in decimal.iter_mut().rev() {
            let product = u32::from(*value) * radix + carry;
            *value = (product % 10) as u8;
            carry = product / 10;
        }
        while carry > 0 {
            decimal.insert(0, (carry % 10) as u8);
            carry /= 10;
        }
    }
    let value = decimal
        .into_iter()
        .skip_while(|digit| *digit == 0)
        .map(|digit| char::from(b'0' + digit))
        .collect::<String>();
    Some(if value.is_empty() {
        "0".to_owned()
    } else {
        value
    })
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
        let mut seen = Vec::<Value>::new();
        for (entry_start, entry_end) in top_level_flow_entries(source, flow_start, flow_end) {
            let entry_source = &source[entry_start..entry_end];
            let leading = entry_source.len() - entry_source.trim_start().len();
            let entry = entry_source.trim();
            let Some(after_question) = entry.strip_prefix('?') else {
                continue;
            };
            let question_gap = after_question.len() - after_question.trim_start().len();
            let member = after_question.trim_start();
            let Some(semantic) = semantic_set_member_key(member) else {
                continue;
            };
            if seen.contains(&semantic) {
                let member_start = entry_start + leading + 1 + question_gap;
                let (remainder, _, tag_name) = split_node_properties(member);
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

fn inside_standard_flow_set(source: &str, offset: usize) -> bool {
    let mut stack = Vec::new();
    let mut quote = None;
    let mut escaped = false;
    let mut comment = false;
    for (position, character) in source[..offset].char_indices() {
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
            '#' if position == 0
                || source[..position]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_whitespace) =>
            {
                comment = true;
            }
            '"' | '\'' => quote = Some(character),
            '{' => stack.push(('}', position)),
            '[' => stack.push((']', position)),
            '}' | ']'
                if stack
                    .last()
                    .is_some_and(|(closing, _)| *closing == character) =>
            {
                stack.pop();
            }
            _ => {}
        }
    }
    stack.iter().rev().any(|(closing, opening)| {
        if *closing != '}' {
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
}

fn alias_mapping_key_range(
    source: &str,
    excluded_ranges: &[(usize, usize)],
) -> Option<(usize, usize)> {
    let mut quote = None;
    let mut escaped = false;
    let mut comment = false;
    let mut characters = source.char_indices().peekable();
    while let Some((offset, character)) = characters.next() {
        if excluded_ranges
            .iter()
            .any(|(start, end)| *start <= offset && offset < *end)
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
                if flow_explicit_key && !inside_standard_flow_set(source, offset) {
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

fn duplicate_mapping_key_range(source: &str) -> Option<(usize, usize)> {
    if let Some(range) = duplicate_flow_mapping_key_range_anywhere(source) {
        return Some(range);
    }
    let mut keys = std::collections::BTreeSet::new();
    let mut containers: Vec<(usize, String, bool)> = Vec::new();
    let mut sequence_indices: std::collections::BTreeMap<String, usize> =
        std::collections::BTreeMap::new();
    let spans = line_spans(source);
    let mut block_scalar_ranges = block_scalar_body_ranges(source);
    block_scalar_ranges.extend(multiline_quoted_scalar_ranges(source));
    for (line_index, line) in spans.iter().enumerate() {
        if block_scalar_ranges
            .iter()
            .any(|(start, end)| *start <= line.start && line.start < *end)
        {
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
            let (plain_key_source, _, _) = split_node_properties(key_source);
            let Ok(key) = serde_yaml::from_str::<String>(plain_key_source) else {
                continue;
            };
            let scope = containers
                .iter()
                .map(|(_, segment, _)| segment.clone())
                .collect::<Vec<_>>();
            if !keys.insert((scope, key)) {
                return Some((
                    key_start,
                    one_character_end(source, key_start, line.content_end),
                ));
            }
            continue;
        }
        let Some(colon) = mapping_key_colon(mapping_source) else {
            continue;
        };
        let key_source = mapping_source[..colon].trim_end();
        let Ok(key) = serde_yaml::from_str::<String>(key_source) else {
            continue;
        };
        let scope = containers
            .iter()
            .map(|(_, segment, _)| segment.clone())
            .collect::<Vec<_>>();
        if !keys.insert((scope, key.clone())) {
            let key_start = line.start
                + body
                    .find(mapping_source)
                    .unwrap_or_else(|| body.len().saturating_sub(mapping_source.len()));
            return Some((
                key_start,
                one_character_end(source, key_start, line.content_end),
            ));
        }
        if mapping_source[colon + 1..].trim().is_empty() {
            containers.push((indent + usize::from(item.is_some()), key, false));
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
        if block_scalar_ranges
            .iter()
            .any(|(start, end)| *start <= offset && offset < *end)
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
            let end = following_block_end(
                source,
                &spans,
                line_index,
                indent,
                indicator.contains('+'),
                true,
            );
            Some((span.end, end))
        })
        .collect()
}

fn provenance_continuation_ranges(source: &str) -> Vec<(usize, usize)> {
    let spans = line_spans(source);
    let mut ranges = block_scalar_body_ranges(source);
    for (line_index, span) in spans.iter().enumerate() {
        if ranges
            .iter()
            .any(|(start, end)| *start <= span.start && span.start < *end)
        {
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

fn duplicate_flow_mapping_key_range(source: &str, flow_start: usize) -> Option<(usize, usize)> {
    let mut keys = std::collections::BTreeSet::new();
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
        let key_end = key_start + source[key_start..colon].trim_end().len();
        let key = serde_yaml::from_str::<String>(&source[key_start..key_end]).ok()?;
        if !keys.insert(key) {
            return Some((key_start, one_character_end(source, key_start, key_end)));
        }
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
            '&' if ranges
                .iter()
                .any(|(start, end)| *start <= cursor && cursor < *end) =>
            {
                let start = cursor + 1;
                let mut end = start;
                while let Some(next) = source[end..].chars().next() {
                    if next.is_whitespace() || matches!(next, ',' | '[' | ']' | '{' | '}' | ':') {
                        break;
                    }
                    end += next.len_utf8();
                }
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
    let spans = line_spans(source);
    let scanner_excluded_ranges = provenance_continuation_ranges(source);
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
    set_member_ranges.sort_unstable();
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
        if scanner_excluded_ranges
            .iter()
            .chain(block_set_member_ranges.iter())
            .any(|(start, end)| *start <= line.start && line.start < *end)
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
                let continued_is_block_collection = continued.starts_with("- ")
                    || continued.starts_with("? ")
                    || mapping_key_colon(continued).is_some();
                if !continued_is_block_collection {
                    let current = mapping_source
                        .split_once('#')
                        .map_or(mapping_source, |(properties, _)| properties)
                        .trim_end();
                    property_source = format!("{current} {continued}");
                    node_line_index = continued_index;
                    node_body = continued_body;
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
            if mapping_key_colon(remainder).is_none() && !explicit_mapping_key {
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
            && mapping_key_colon(mapping_source).is_none()
            && !mapping_source.starts_with(['?', ':'])
            && containers
                .last()
                .is_some_and(|(_, _, sequence_item)| *sequence_item)
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
                    source, &spans, line_index, indent, body, remainder, tag_name,
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
            let (plain_key_source, anchor_name, tag_name) = split_node_properties(key_source);
            let key = serde_yaml::from_str::<String>(plain_key_source)
                .unwrap_or_else(|_| plain_key_source.trim_matches(['\'', '"']).to_owned());
            explicit_keys.insert(
                indent + if compact_mapping_item { 2 } else { 0 },
                (
                    key,
                    anchor_name,
                    tag_name.map(str::to_owned),
                    plain_key_source.trim().to_owned(),
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
            let key_source = mapping_source[..colon].trim_end();
            let (plain_key_source, anchor_name, tag_name) =
                split_node_properties(key_source.trim());
            let key = serde_yaml::from_str::<String>(plain_key_source)
                .unwrap_or_else(|_| plain_key_source.trim_matches(['\'', '"']).to_owned());
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
            let continued_is_block_collection = continued.starts_with("- ")
                || continued.starts_with("? ")
                || mapping_key_colon(continued).is_some();
            if !continued_is_block_collection {
                let current = value_source
                    .split_once('#')
                    .map_or(value_source, |(properties, _)| properties)
                    .trim_end();
                property_source = format!("{current} {continued}");
                node_line_index = continued_index;
                node_body = continued_body;
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
            set_value_at_path(raw, &target, value, explicit_tags);
            if anchor_path.len() == 1
                && let Some(tag) = explicit_tags.get(&anchor_path[0]).cloned()
            {
                explicit_tags.insert(explicit_tag_path(&target), tag);
            }
            let copied = explicit_tags
                .iter()
                .filter_map(|(key, tag)| {
                    let segments = explicit_tag_segments(key);
                    segments.strip_prefix(anchor_path.as_slice()).map(|suffix| {
                        let mut translated = target_path.to_vec();
                        translated.extend_from_slice(suffix);
                        let borrowed = translated.iter().map(String::as_str).collect::<Vec<_>>();
                        (explicit_tag_path(&borrowed), tag.clone())
                    })
                })
                .collect::<Vec<_>>();
            for (key, tag) in copied {
                explicit_tags.insert(key, tag);
            }
        }
        PreservedAnchor::Scalar {
            value,
            explicit_tag,
        } => {
            set_value_at_path(raw, &target, value.clone(), explicit_tags);
            if let Some(tag) = explicit_tag {
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
                .map(str::to_owned)
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
        return if matches!(lexical.chars().next(), Some('|' | '>'))
            || matches!(tag_name, "map" | "seq" | "set" | "omap" | "pairs")
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
        let indicator = remainder.split_whitespace().next().unwrap_or(remainder);
        let end = following_block_end(
            source,
            spans,
            line_index,
            parent_indent,
            indicator.contains('+'),
            true,
        );
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
    let Some(first_index) = ((line_index + 1)..spans.len()).find(|index| {
        let body = &source[spans[*index].start..spans[*index].content_end];
        !body.trim().is_empty() && !body.trim_start().starts_with('#')
    }) else {
        return String::new();
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
        let indicator = value_source
            .split_whitespace()
            .next()
            .unwrap_or(value_source);
        let end = following_block_end(
            source,
            spans,
            first_index,
            parent_indent,
            indicator.contains('+'),
            true,
        );
        return source[start..end].to_owned();
    }
    if matches!(tag_name, "map" | "seq" | "set" | "omap" | "pairs")
        && (value_source.starts_with("- ")
            || value_source.starts_with("? ")
            || mapping_key_colon(value_source).is_some())
    {
        let end = following_block_end(source, spans, first_index, parent_indent, false, false);
        return source[start..end].to_owned();
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
    let source = source.trim_end();
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

fn standard_tag_semantic(tag_name: &str, source_value: &str, existing: Value) -> Value {
    let scalar_text = || {
        serde_yaml::from_str::<serde_yaml::Value>(source_value)
            .ok()
            .and_then(|value| match value {
                serde_yaml::Value::String(value) => Some(value),
                serde_yaml::Value::Bool(value) => Some(value.to_string()),
                serde_yaml::Value::Number(value) => Some(value.to_string()),
                serde_yaml::Value::Null => Some("null".to_owned()),
                _ => None,
            })
            .unwrap_or_else(|| source_value.trim().to_owned())
    };
    match tag_name {
        "timestamp" => canonical_timestamp(&scalar_text())
            .map(Value::String)
            .unwrap_or(existing),
        "binary" => decoded_binary(&scalar_text()).unwrap_or(existing),
        "int" => {
            let scalar = scalar_text();
            if yaml_schema_integer_string(&scalar) {
                Value::String(scalar)
            } else {
                canonical_set_integer(&scalar, true)
                    .filter(|canonical| {
                        if canonical.starts_with('-') {
                            canonical.parse::<i64>().is_err()
                        } else {
                            canonical.parse::<u64>().is_err()
                        }
                    })
                    .map(|canonical| {
                        let mut exact = Map::new();
                        exact.insert(EXACT_INTEGER_KEY.to_owned(), Value::String(canonical));
                        Value::Object(exact)
                    })
                    .unwrap_or(existing)
            }
        }
        "float" => {
            let scalar = scalar_text();
            match plain_nonfinite_kind(&scalar) {
                Some("inf") => Value::String("Infinity".to_owned()),
                Some("-inf") => Value::String("-Infinity".to_owned()),
                Some("nan") => Value::String("NaN".to_owned()),
                _ if canonical_set_integer(&scalar, true).is_some() => Value::String(scalar),
                _ => existing,
            }
        }
        "set" => existing
            .as_object()
            .map(|set| Value::Array(set.keys().cloned().map(Value::String).collect::<Vec<_>>()))
            .unwrap_or(existing),
        _ => existing,
    }
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

fn semantic_for_standard_set_source(source: &str) -> Option<Value> {
    let synthetic = if source.trim_start().starts_with('{') {
        format!("value: !!set {source}")
    } else {
        format!("value: !!set\n  {source}")
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

fn direct_standard_set_member_sources(source: &str) -> Vec<String> {
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
        let following_indent = members
            .iter()
            .filter(|(line, _, _)| *line != first_line)
            .map(|(_, _, indent)| *indent)
            .min();
        members.retain(|(line, _, indent)| {
            (*line == first_line && *indent == first_indent) || following_indent == Some(*indent)
        });
    }
    members
        .iter()
        .enumerate()
        .map(|(member_index, (_, start, _))| {
            let end = members
                .get(member_index + 1)
                .map_or(source.len(), |(next_index, _, _)| spans[*next_index].start);
            source[*start..end].to_owned()
        })
        .collect()
}

fn standard_set_member_properties(member_source: &str) -> (String, Option<String>, Option<String>) {
    let mut anchor_name = None;
    let mut tag_name = None;
    for line in line_spans(member_source) {
        let body = &member_source[line.start..line.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
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
        let lexical = if matches!(remainder.chars().next(), Some('|' | '>')) {
            let indicator = remainder.split_whitespace().next().unwrap_or(remainder);
            if indicator.contains('+') {
                member_source[lexical_start..]
                    .trim_end_matches([' ', '\t'])
                    .to_owned()
            } else {
                let mut lexical = member_source[lexical_start..].trim_end().to_owned();
                lexical.push('\n');
                lexical
            }
        } else if matches!(remainder.chars().next(), Some('{' | '[')) {
            member_source[lexical_start..flow_value_end(member_source, lexical_start)].to_owned()
        } else {
            scalar_lexical_source(&member_source[lexical_start..]).to_owned()
        };
        return (lexical, anchor_name, tag_name);
    }
    (String::new(), anchor_name, tag_name)
}

fn restore_collection_set_member_provenance(
    member_source: &str,
    member: &mut Value,
    active_anchors: &std::collections::BTreeMap<String, Value>,
) -> Vec<(String, Value)> {
    if !matches!(member, Value::Array(_) | Value::Object(_))
        || member.get(TAGGED_KEY).is_some()
        || !(member_source.contains(['&', '*']) || contains_standard_tag_property(member_source))
    {
        return Vec::new();
    }
    let trimmed = member_source.trim_start();
    let synthetic = if matches!(trimmed.chars().next(), Some('{' | '['))
        || member_source.starts_with(['\r', '\n'])
    {
        format!("member: {member_source}")
    } else {
        format!("member:\n  {member_source}")
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
    let (local_tags, local_anchors) = preserve_standard_yaml_tags(
        &synthetic,
        &mut local_raw,
        &initial_tags,
        &initial_anchors,
        &[],
    );
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
        let scalar = lexical.trim();
        if let Some(canonical) = canonical_set_integer(scalar, false)
            && canonical != scalar
            && !yaml_schema_integer_string(scalar)
            && let Ok(normalized) = serde_json::from_str::<Value>(&canonical)
        {
            *value = normalized;
        }
        return;
    }
    let Some(tag_name) = tag_name.filter(|tag| *tag != "set") else {
        return;
    };
    let Some(tag_uri) = standard_tag_uri(&tag_name) else {
        return;
    };
    if let Some(Value::Object(tagged)) = value.get_mut(TAGGED_KEY)
        && tagged.get("tag").and_then(Value::as_str) == Some(tag_uri)
    {
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
            let sources = body
                .get("source")
                .and_then(Value::as_str)
                .map(direct_standard_set_member_sources)
                .unwrap_or_default();
            if let Some(Value::Array(members)) = body.get_mut("value") {
                for (index, member) in members.iter_mut().enumerate() {
                    let mut member_anchor = None;
                    let mut member_anchor_event_index = None;
                    let mut nested_member_anchors = Vec::new();
                    let nested_member_anchor_event_index = anchor_events.len();
                    if let Some(source) = sources.get(index) {
                        let (lexical, anchor, _) = standard_set_member_properties(source);
                        if let Some(alias) = lexical.strip_prefix('*').map(str::trim)
                            && let Some(anchored) = anchors.get(alias)
                        {
                            *member = anchored.clone();
                        } else {
                            restore_direct_standard_set_member_source(source, member);
                            if restore_collection_provenance {
                                nested_member_anchors = restore_collection_set_member_provenance(
                                    source, member, anchors,
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
        if excluded_ranges
            .iter()
            .any(|(start, end)| *start <= tag_start && tag_start < *end)
        {
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
        if yaml_comment_start(prefix).is_some()
            || prefix.matches('"').count() % 2 == 1
            || prefix.matches('\'').count() % 2 == 1
        {
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

    fn restored_set_source(source: &str) -> String {
        if source.trim() == "?" || source.trim_start().starts_with('{') {
            source.trim_end().to_owned()
        } else {
            source.to_owned()
        }
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
                    && let Some(index) = sources
                        .iter()
                        .enumerate()
                        .position(|(index, source)| {
                            let restored = restored_set_source(source);
                            let target = body.get("value").map(value_without_tag_sources);
                            !used[index]
                                && (target.as_ref().is_some_and(|target| {
                                    semantics[index].as_ref() == Some(target)
                                }) || contains_standard_tag_property(&existing))
                                && (restored == existing
                                    || restored.trim_end() == existing.trim_end())
                        })
                        .or_else(|| {
                            sources.iter().enumerate().position(|(index, source)| {
                                let restored = restored_set_source(source);
                                let target = body.get("value").map(value_without_tag_sources);
                                used[index]
                                    && target.as_ref().is_some_and(|target| {
                                        semantics[index].as_ref() == Some(target)
                                    })
                                    && restored == existing
                            })
                        })
                        .or_else(|| {
                            sources.iter().enumerate().position(|(index, source)| {
                                let restored = restored_set_source(source);
                                let target = body.get("value").map(value_without_tag_sources);
                                used[index]
                                    && target.as_ref().is_some_and(|target| {
                                        semantics[index].as_ref() == Some(target)
                                    })
                                    && restored.trim_end() == existing.trim_end()
                            })
                        })
                {
                    used[index] = true;
                    let source = restored_set_source(&sources[index]);
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
                    let source = restored_set_source(source);
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
            let borrowed = path.iter().map(String::as_str).collect::<Vec<_>>();
            let Some(existing) = value_at_path(self.raw, &borrowed, self.explicit_tags).cloned()
            else {
                return;
            };
            let existing = if self
                .explicit_tags
                .contains_key(&explicit_tag_path(&borrowed))
            {
                semantic_value(&existing).clone()
            } else {
                existing
            };
            let Some(tag_uri) = standard_tag_uri(&tag_name) else {
                return;
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
        if let Some(alias) = self.remaining().strip_prefix('*') {
            let alias_end = alias
                .find(|character: char| {
                    character.is_whitespace() || matches!(character, ',' | '}' | ']')
                })
                .unwrap_or(alias.len());
            let alias_name = alias[..alias_end].to_owned();
            apply_tagged_alias(
                self.raw,
                self.explicit_tags,
                self.anchors,
                &alias_name,
                path,
            );
            self.cursor += alias_end + 1;
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
            let entry = self.source[entry_start..entry_end].trim();
            let member = entry
                .strip_prefix('?')
                .map(str::trim_start)
                .unwrap_or(entry);
            let (remainder, _, _) = split_node_properties(member);
            let Some(alias) = remainder.strip_prefix('*').map(str::trim) else {
                self.activate_set_anchors_before(entry_end);
                continue;
            };
            path.push(index.to_string());
            apply_tagged_alias(self.raw, self.explicit_tags, self.anchors, alias, path);
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
            let (plain_key_source, anchor_name, tag_name) = split_node_properties(key_source);
            let key = serde_yaml::from_str::<String>(plain_key_source)
                .unwrap_or_else(|_| plain_key_source.trim_matches(['\'', '"']).to_owned());
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
            self.parse_value(path);
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
            let (plain_key_source, _, key_tag) = split_node_properties(full_key_source);
            let Some(name) = parsed_string_mapping_key(plain_key_source, key_tag) else {
                continue;
            };
            let leading_whitespace = after_colon.len() - after_colon.trim_start().len();
            let field_start = start + key_start;
            let value_start = start + value_line.start + value_indent + 1 + leading_whitespace;
            let value_source = after_colon.trim_start();
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
        let key_source = trimmed[..colon].trim_end();
        let (plain_key_source, _, key_tag) = split_node_properties(key_source);
        let Some(name) = parsed_string_mapping_key(plain_key_source, key_tag) else {
            continue;
        };
        let after_colon = &trimmed[colon + 1..];
        let leading_whitespace = after_colon.len() - after_colon.trim_start().len();
        let line_start = start + line.start + indent;
        let field_start = line_start + key_source.len().saturating_sub(plain_key_source.len());
        let value_start = line_start + colon + 1 + leading_whitespace;
        let value_source = after_colon.trim_start();
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
            )
        });
        fields.insert(
            name.clone(),
            serde_json::to_value(range_for(text, *field_start, field_end)).unwrap_or(Value::Null),
        );
    }
    fields
}

fn root_flow_mapping_start(source: &str) -> Option<usize> {
    let mut cursor = 0usize;
    loop {
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
    if value_source.is_empty() || matches!(value_source.chars().next(), Some('{' | '[' | '|' | '>'))
    {
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
) -> usize {
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
            block_scalar_indicator(nested).is_some_and(|value| value.contains('+'))
        });
    let tagged_scalar =
        effective_tag.is_some_and(|tag| !matches!(tag, "map" | "seq" | "set" | "omap" | "pairs"));
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
    let deferred_block_collection = effective_tag
        .is_none_or(|tag| matches!(tag, "map" | "seq" | "set" | "omap" | "pairs"))
        && deferred_value.as_deref().is_some_and(|value| {
            !matches!(value.chars().next(), Some('{' | '['))
                && (value.starts_with("- ")
                    || (value == "-" && deferred_marker_has_nested_value)
                    || value.starts_with("? ")
                    || (value == "?" && deferred_marker_has_nested_value)
                    || mapping_key_colon(value).is_some())
        });
    let deferred_non_block_node = deferred_properties
        && deferred_indicator.is_none()
        && !deferred_block_collection
        && deferred_value.is_some();
    let inline_node = !remainder.is_empty() && !remainder.starts_with('#');
    let non_block_scalar = tagged_scalar || inline_node || deferred_non_block_node;
    let indentationless_sequence = value_source.is_empty();
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
            if effective_tag.is_none()
                && value_source.is_empty()
                && text[line_start..content_end].trim() == "?"
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
            serde_json::to_value(range_for(text, key_start, value_end)).unwrap_or(Value::Null),
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
    None
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

fn canonical_segment_count(value: &str) -> usize {
    let mut count = 0usize;
    for part in value.replace('\\', "/").split('/') {
        match part {
            "" | "." => {}
            ".." => {
                count = count.saturating_sub(1);
            }
            _ => count += 1,
        }
    }
    count
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
    let parser = Parser::new_ext(body, Options::ENABLE_STRIKETHROUGH).into_offset_iter();
    let mut stack: Vec<(String, String, std::ops::Range<usize>)> = Vec::new();
    let mut result = Vec::new();
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
            Event::End(pulldown_cmark::TagEnd::Link) => {
                if let Some((label, target, start_range)) = stack.pop() {
                    if let Some(message) = bounded_link_text_failure(
                        &target,
                        MAX_LINK_TARGET_CODE_UNITS,
                        MAX_LINK_TARGET_BYTES,
                        "link target",
                    ) {
                        return Err(message);
                    }
                    if let Some(message) = bounded_link_text_failure(
                        label.trim(),
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
                    let mut end = range.end;
                    if body
                        .get(end..)
                        .is_some_and(|suffix| suffix.starts_with("[]"))
                    {
                        end += 2;
                    }
                    result.push(LinkCandidate {
                        label: label.trim().to_owned(),
                        target,
                        range: range_for(
                            full_text,
                            body_start + start_range.start,
                            body_start + end,
                        ),
                    });
                }
            }
            _ => {}
        }
    }
    Ok(result)
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
    let (classification, target_id) = if raw.is_empty() || has_control_character(&raw) {
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
            LinkPathResult::Contained(resolved) if directories.contains(&resolved) => {
                (LinkClassification::Directory, None)
            }
            LinkPathResult::Contained(resolved) if concept_paths.contains(&resolved) => (
                LinkClassification::Internal,
                Some(resolved.trim_end_matches(".md").to_owned()),
            ),
            LinkPathResult::Contained(resolved) if reserved_paths.contains(&resolved) => {
                if file_name(&resolved) == "index.md" {
                    (LinkClassification::Directory, None)
                } else {
                    (LinkClassification::Invalid, None)
                }
            }
            LinkPathResult::Contained(resolved)
                if resolved.ends_with(".md") || path.ends_with('/') =>
            {
                (LinkClassification::Broken, None)
            }
            LinkPathResult::Contained(_) => (LinkClassification::Invalid, None),
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
    Contained(String),
}

fn normalize_link_path(source_path: &str, target: &str) -> LinkPathResult {
    let Some(decoded) = percent_decode(target) else {
        return LinkPathResult::Invalid;
    };
    let decoded = decoded.replace('\\', "/");
    if has_control_character(&decoded) {
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
    LinkPathResult::Contained(parts.join("/"))
}

fn percent_decode(value: &str) -> Option<String> {
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

fn has_control_character(value: &str) -> bool {
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

fn canonical_path(value: &str) -> Option<String> {
    let normalized = normalized_path(value);
    if normalized.starts_with('/') {
        return None;
    }
    let mut parts = Vec::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            part => parts.push(part),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn normalized_path(value: &str) -> String {
    value.replace('\\', "/")
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
        }
    }

    #[test]
    fn parses_concepts_and_document_relative_links() {
        let bundle = parse_bundle(ParseBundleInput {
            root_uri: "file:///bundle".to_owned(),
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
            revision: 1,
            documents: vec![input],
        });
        assert_eq!(bundle.failures[0].reason, ParseFailureReason::Decode);
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
            revision: 1,
            documents: vec![document("boundaries.md", &source)],
        });
        assert!(bundle.failures.is_empty(), "{:#?}", bundle.failures);
    }

    #[test]
    fn reports_invalid_reserved_frontmatter() {
        let bundle = parse_bundle(ParseBundleInput {
            root_uri: "file:///bundle".to_owned(),
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
}
