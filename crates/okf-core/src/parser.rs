use crate::{
    BundleDocumentInput, ComputationEndpoint, ComputationParameter, Concept, ConceptLink,
    DocumentContent, GeneratedMetadata, KnowledgeSource, LinkClassification, NormalizedFrontmatter,
    ParseBundleInput, ParseFailure, ParseFailureReason, ParsedBundle, ParsedFrontmatter,
    ReservedDocument, SourceDocument, SourcePosition, SourceRange, UsageWindow, VerificationEvent,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use chrono::{DateTime, SecondsFormat};
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
    if let Some((relative_start, relative_end)) = duplicate_mapping_key_range(yaml_source) {
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
    let normalized_yaml = normalize_line_breaks(yaml_source);
    let yaml: serde_yaml::Value = serde_yaml::from_str(&normalized_yaml).map_err(|error| {
        let range = error.location().map(|location| {
            let relative_line = location.line().saturating_sub(1);
            let source_lines = line_spans(yaml_source);
            let line = source_lines
                .get(relative_line)
                .or_else(|| source_lines.last());
            let start = opening_end + line.map_or(0, |line| line.start);
            range_for(text, start, (start + 1).min(closing_start))
        });
        let error_text = error.to_string();
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
    let explicit_tags = preserve_standard_yaml_tags(yaml_source, &mut raw);
    let fields = top_level_field_ranges(text, opening_end, closing_start);
    let verified = normalized_verifications(raw.get("verified"));
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
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        timestamp: normalized_string(&raw, &explicit_tags, "timestamp").map(str::to_owned),
        generated: normalized_generated(raw.get("generated")),
        trust_tier: trust_tier(&verified).to_owned(),
        verified,
        status: normalized_string(&raw, &explicit_tags, "status").map(str::to_owned),
        stale_after: normalized_string(&raw, &explicit_tags, "stale_after").map(str::to_owned),
        sources: normalized_sources(raw.get("sources")),
        usage_window: normalized_usage_window(raw.get("usage_window")),
        runtime: normalized_string(&raw, &explicit_tags, "runtime").map(str::to_owned),
        parameters: normalized_parameters(raw.get("parameters")),
        computation: normalized_string(&raw, &explicit_tags, "computation").map(str::to_owned),
        executor: normalized_endpoint(raw.get("executor")),
        attester: normalized_endpoint(raw.get("attester")),
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

fn object_string(object: &Map<String, Value>, key: &str) -> Option<String> {
    object.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn normalized_generated(value: Option<&Value>) -> Option<GeneratedMetadata> {
    let object = value?.as_object()?;
    Some(GeneratedMetadata {
        by: object_string(object, "by"),
        at: object_string(object, "at"),
    })
}

fn normalized_verifications(value: Option<&Value>) -> Vec<VerificationEvent> {
    let values = match value {
        Some(Value::Array(values)) => values.iter().collect::<Vec<_>>(),
        Some(value @ Value::Object(_)) => vec![value],
        _ => Vec::new(),
    };
    values
        .into_iter()
        .filter_map(Value::as_object)
        .map(|object| VerificationEvent {
            by: object_string(object, "by"),
            at: object_string(object, "at"),
        })
        .collect()
}

fn trust_tier(events: &[VerificationEvent]) -> &'static str {
    let valid_events = events.iter().filter(|event| {
        event.by.as_deref().is_some_and(|by| !by.trim().is_empty())
            && event
                .at
                .as_deref()
                .is_some_and(|at| DateTime::parse_from_rfc3339(at).is_ok())
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

fn normalized_usage_window(value: Option<&Value>) -> Option<UsageWindow> {
    let object = value?.as_object()?;
    Some(UsageWindow {
        from: object_string(object, "from"),
        to: object_string(object, "to"),
    })
}

fn normalized_sources(value: Option<&Value>) -> Vec<KnowledgeSource> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .map(|object| KnowledgeSource {
            id: object_string(object, "id"),
            resource: object_string(object, "resource"),
            title: object_string(object, "title"),
            author: object_string(object, "author"),
            usage_count: object.get("usage_count").and_then(Value::as_u64),
            last_modified: object_string(object, "last_modified"),
            usage_window: normalized_usage_window(object.get("usage_window")),
        })
        .collect()
}

fn normalized_parameters(value: Option<&Value>) -> Vec<ComputationParameter> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .map(|object| ComputationParameter {
            name: object_string(object, "name"),
            r#type: object_string(object, "type"),
            required: object.get("required").and_then(Value::as_bool),
        })
        .collect()
}

fn normalized_endpoint(value: Option<&Value>) -> Option<ComputationEndpoint> {
    let object = value?.as_object()?;
    let receipt = object
        .get("receipt")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    Some(ComputationEndpoint {
        resource: object_string(object, "resource"),
        receipt,
    })
}

fn yaml_to_json(value: serde_yaml::Value) -> Result<Value, String> {
    Ok(match value {
        serde_yaml::Value::Null => Value::Null,
        serde_yaml::Value::Bool(value) => Value::Bool(value),
        serde_yaml::Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                Value::Number(Number::from(value))
            } else if let Some(value) = value.as_u64() {
                Value::Number(Number::from(value))
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
            let mut result = Map::new();
            for (key, value) in values {
                let key = match key {
                    serde_yaml::Value::String(key) => key,
                    _ => {
                        return Err(
                            "YAML frontmatter mappings must use string field names at every level."
                                .to_owned(),
                        );
                    }
                };
                result.insert(key, yaml_to_json(value)?);
            }
            Value::Object(result)
        }
        serde_yaml::Value::Tagged(tagged) => {
            let tag = tagged.tag.to_string();
            if !tag.starts_with("tag:yaml.org,2002:") && !tag.starts_with("!!") {
                return Err(format!(
                    "YAML frontmatter is not JSON-safe: custom YAML tag is not supported: {tag}"
                ));
            }
            let mut tagged_body = Map::new();
            tagged_body.insert("tag".to_owned(), Value::String(tag));
            tagged_body.insert("value".to_owned(), yaml_to_json(tagged.value)?);
            let mut wrapper = Map::new();
            wrapper.insert(TAGGED_KEY.to_owned(), Value::Object(tagged_body));
            Value::Object(wrapper)
        }
    })
}

fn non_string_mapping_key_range(source: &str) -> Option<(usize, usize)> {
    for line in line_spans(source) {
        let body = &source[line.start..line.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        let prefix = body.len() - trimmed.len();
        let Some(candidate) = trimmed.strip_prefix("? ") else {
            continue;
        };
        let candidate = candidate.trim_end();
        if candidate.starts_with('[')
            || candidate.starts_with('{')
            || matches!(candidate, "null" | "true" | "false")
            || candidate.parse::<f64>().is_ok()
        {
            let start = line.start + prefix + 2;
            return Some((start, start + candidate.len()));
        }
    }
    None
}

fn duplicate_mapping_key_range(source: &str) -> Option<(usize, usize)> {
    let mut keys = std::collections::BTreeSet::new();
    for line in line_spans(source) {
        let body = &source[line.start..line.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        if trimmed.is_empty()
            || trimmed.starts_with('#')
            || trimmed.starts_with('-')
            || trimmed.starts_with('?')
        {
            continue;
        }
        let Some(colon) = trimmed.find(':') else {
            continue;
        };
        let key = trimmed[..colon].trim();
        if key.is_empty() {
            continue;
        }
        let indent = body.len() - trimmed.len();
        if !keys.insert((indent, key.to_owned())) {
            return Some((line.start, (line.start + 1).min(line.content_end)));
        }
    }
    None
}

fn preserve_standard_yaml_tags(source: &str, raw: &mut Map<String, Value>) -> Map<String, Value> {
    let mut explicit_tags = Map::new();
    let mut anchors: std::collections::BTreeMap<String, (Value, String)> =
        std::collections::BTreeMap::new();
    let mut containers: Vec<(usize, String)> = Vec::new();
    for line in line_spans(source) {
        let body = &source[line.start..line.content_end];
        let indent = body
            .chars()
            .take_while(|character| *character == ' ')
            .count();
        let trimmed = body.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('-') {
            continue;
        }
        let Some((key, value_source)) = trimmed.split_once(':') else {
            continue;
        };
        let key = key.trim().trim_matches(['\'', '"']).to_owned();
        while containers
            .last()
            .is_some_and(|(container_indent, _)| *container_indent >= indent)
        {
            containers.pop();
        }
        let value_source = value_source.trim();
        if value_source.is_empty() {
            containers.push((indent, key));
            continue;
        }
        let path = containers
            .iter()
            .map(|(_, segment)| segment.as_str())
            .chain(std::iter::once(key.as_str()))
            .collect::<Vec<_>>();
        let mut remainder = value_source;
        let mut anchor_name = None;
        if let Some(anchor) = remainder.strip_prefix('&')
            && let Some((name, rest)) = anchor.split_once(char::is_whitespace)
        {
            anchor_name = Some(name.to_owned());
            remainder = rest.trim_start();
        }
        if let Some(alias) = remainder.strip_prefix('*').map(str::trim)
            && let Some((wrapped, tag)) = anchors.get(alias).cloned()
        {
            set_value_at_path(raw, &path, wrapped);
            if path.len() == 1 {
                explicit_tags.insert(key, Value::String(tag));
            }
            continue;
        }

        let Some(tag_source) = remainder.strip_prefix("!!") else {
            continue;
        };
        let (tag_name, source_value) = tag_source
            .split_once(char::is_whitespace)
            .map_or((tag_source, ""), |(tag, value)| (tag, value.trim()));
        let Some(tag_uri) = standard_tag_uri(tag_name) else {
            continue;
        };
        let Some(existing) = value_at_path(raw, &path).cloned() else {
            continue;
        };
        let semantic = match tag_name {
            "timestamp" => DateTime::parse_from_rfc3339(source_value)
                .map(|value| Value::String(value.to_rfc3339_opts(SecondsFormat::Millis, true)))
                .unwrap_or(existing),
            "binary" => BASE64
                .decode(source_value)
                .map(|bytes| {
                    Value::Array(
                        bytes
                            .into_iter()
                            .map(|byte| Value::Number(Number::from(byte)))
                            .collect(),
                    )
                })
                .unwrap_or(existing),
            "set" => existing
                .as_object()
                .map(|set| Value::Array(set.keys().cloned().map(Value::String).collect::<Vec<_>>()))
                .unwrap_or(existing),
            _ => semantic_value(&existing).clone(),
        };
        let mut body = Map::new();
        body.insert("tag".to_owned(), Value::String(tag_uri.to_owned()));
        body.insert("value".to_owned(), semantic);
        body.insert("source".to_owned(), Value::String(source_value.to_owned()));
        let mut wrapper = Map::new();
        wrapper.insert(TAGGED_KEY.to_owned(), Value::Object(body));
        let wrapped = Value::Object(wrapper);
        set_value_at_path(raw, &path, wrapped.clone());
        if path.len() == 1 {
            explicit_tags.insert(key, Value::String(tag_uri.to_owned()));
        }
        if let Some(anchor_name) = anchor_name {
            anchors.insert(anchor_name, (wrapped, tag_uri.to_owned()));
        }
    }
    explicit_tags
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

fn value_at_path<'a>(root: &'a Map<String, Value>, path: &[&str]) -> Option<&'a Value> {
    let (first, rest) = path.split_first()?;
    let mut value = root.get(*first)?;
    for segment in rest {
        value = value.as_object()?.get(*segment)?;
    }
    Some(value)
}

fn set_value_at_path(root: &mut Map<String, Value>, path: &[&str], value: Value) {
    let Some((last, parents)) = path.split_last() else {
        return;
    };
    let mut current = root;
    for segment in parents {
        let Some(next) = current.get_mut(*segment).and_then(Value::as_object_mut) else {
            return;
        };
        current = next;
    }
    current.insert((*last).to_owned(), value);
}

fn top_level_field_ranges(text: &str, start: usize, end: usize) -> Map<String, Value> {
    let mut starts = Vec::new();
    for line in line_spans(&text[start..end]) {
        let body = &text[start + line.start..start + line.content_end];
        if !body.starts_with(char::is_whitespace)
            && let Some(colon) = body.find(':')
        {
            let name = body[..colon].trim();
            if !name.is_empty() {
                starts.push((
                    name.to_owned(),
                    start + line.start,
                    start + line.content_end,
                    !body[colon + 1..].trim().is_empty(),
                ));
            }
        }
    }

    let mut fields = Map::new();
    for (index, (name, field_start, scalar_end, has_inline_value)) in starts.iter().enumerate() {
        let next_start = starts.get(index + 1).map_or(end, |(_, start, _, _)| *start);
        let field_end = if *has_inline_value {
            *scalar_end
        } else {
            next_start
        };
        fields.insert(
            name.clone(),
            serde_json::to_value(range_for(text, *field_start, field_end)).unwrap_or(Value::Null),
        );
    }
    fields
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
        assert!(bundle.failures.is_empty());
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
}
