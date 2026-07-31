use crate::{
    BundleDocumentInput, ComputationEndpoint, ComputationParameter, Concept, ConceptLink,
    DocumentContent, GeneratedMetadata, KnowledgeSource, LinkClassification, NormalizedFrontmatter,
    ParseBundleInput, ParseFailure, ParseFailureReason, ParsedBundle, ParsedFrontmatter,
    ReservedDocument, SourceDocument, SourcePosition, SourceRange, UsageWindow, VerificationEvent,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use chrono::{DateTime, FixedOffset, SecondsFormat};
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
    let normalized_yaml = normalize_line_breaks(yaml_source);
    let yaml: serde_yaml::Value = serde_yaml::from_str(&normalized_yaml).map_err(|error| {
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
                range_for(text, start, (start + 1).min(closing_start))
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
    for (key, value) in preserve_standard_yaml_tags(yaml_source, &mut raw) {
        explicit_tags.insert(key, value);
    }
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
                if !path.is_empty() {
                    let raw_tag = tagged.tag.to_string();
                    let tag = raw_tag
                        .strip_prefix("!!")
                        .and_then(standard_tag_uri)
                        .unwrap_or(&raw_tag)
                        .to_owned();
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
            let raw_tag = tagged.tag.to_string();
            let canonical_tag = raw_tag
                .strip_prefix("!!")
                .and_then(standard_tag_uri)
                .unwrap_or(&raw_tag)
                .to_owned();
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
            let converted = yaml_to_json(tagged.value)?;
            let semantic = match canonical_tag.as_str() {
                "tag:yaml.org,2002:timestamp" => source
                    .as_deref()
                    .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                    .map(|value| Value::String(value.to_rfc3339_opts(SecondsFormat::Millis, true)))
                    .unwrap_or(converted),
                "tag:yaml.org,2002:binary" => source
                    .as_deref()
                    .and_then(|value| BASE64.decode(value).ok())
                    .map(|bytes| {
                        Value::Array(
                            bytes
                                .into_iter()
                                .map(|byte| Value::Number(Number::from(byte)))
                                .collect(),
                        )
                    })
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

fn non_string_mapping_key_range(source: &str) -> Option<(usize, usize)> {
    let block_scalar_ranges = block_scalar_body_ranges(source);
    if let Some(range) = alias_mapping_key_range(source, &block_scalar_ranges) {
        return Some(range);
    }
    for line in line_spans(source) {
        if block_scalar_ranges
            .iter()
            .any(|(start, end)| *start <= line.start && line.start < *end)
        {
            continue;
        }
        let body = &source[line.start..line.content_end];
        let trimmed = body.trim_start_matches([' ', '\t']);
        let mapping_source = trimmed
            .strip_prefix("- ")
            .or_else(|| (trimmed == "-").then_some(""))
            .unwrap_or(trimmed);
        let mapping_offset = body
            .find(mapping_source)
            .unwrap_or_else(|| body.len().saturating_sub(mapping_source.len()));
        if let Some(candidate) = mapping_source.strip_prefix("? ") {
            let candidate = candidate.trim_end();
            if serde_yaml::from_str::<serde_yaml::Value>(candidate)
                .is_ok_and(|value| !matches!(value, serde_yaml::Value::String(_)))
            {
                let start = line.start + mapping_offset + 2;
                return Some((start, start + candidate.len()));
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
        let (plain_key_source, _, _) = split_node_properties(key_source);
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
                cursor += source[cursor..].len() - source[cursor..].trim_start().len();
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
    let block_scalar_ranges = block_scalar_body_ranges(source);
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
                return Some((key_start, (key_start + 1).min(line.content_end)));
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
            return Some((key_start, (key_start + 1).min(line.content_end)));
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
        let mapping_source = trimmed
            .strip_prefix("- ")
            .or_else(|| (trimmed == "-").then_some(""))
            .unwrap_or(trimmed);
        let Some(colon) = mapping_key_colon(mapping_source) else {
            continue;
        };
        let value_source = mapping_source[colon + 1..].trim_start();
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
            return Some((key_start, (key_start + 1).min(key_end)));
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

fn preserve_standard_yaml_tags(source: &str, raw: &mut Map<String, Value>) -> Map<String, Value> {
    let mut explicit_tags = Map::new();
    let mut anchors: std::collections::BTreeMap<String, PreservedAnchor> =
        std::collections::BTreeMap::new();
    let mut containers: Vec<(usize, String, bool)> = Vec::new();
    let mut sequence_indices: std::collections::BTreeMap<String, usize> =
        std::collections::BTreeMap::new();
    let mut explicit_keys: std::collections::BTreeMap<
        usize,
        (String, Option<String>, Option<String>, String),
    > = std::collections::BTreeMap::new();
    let spans = line_spans(source);
    let scanner_excluded_ranges = provenance_continuation_ranges(source);
    for (line_index, line) in spans.iter().enumerate() {
        if scanner_excluded_ranges
            .iter()
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
        let mut compact_key_tag = None;
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
            let (remainder, anchor_name, tag_name) = split_node_properties(mapping_source);
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
                        &path,
                        raw,
                        &mut explicit_tags,
                        &mut anchors,
                    );
                }
                if let Some(tag_name) = tag_name {
                    let lexical = tagged_lexical_source(
                        source, &spans, line_index, indent, body, remainder, tag_name,
                    );
                    preserve_tagged_value(raw, &path, tag_name, &lexical, &mut explicit_tags);
                }
                continue;
            }
            compact_key_anchor = anchor_name;
            compact_key_tag = tag_name;
            mapping_source = remainder;
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
                compact_key_tag
                    .map(str::to_owned)
                    .or_else(|| tag_name.map(str::to_owned)),
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
                    &path,
                    raw,
                    &mut explicit_tags,
                    &mut anchors,
                );
            }
        }
        let (remainder, anchor_name, tag_name) = split_node_properties(value_source);
        if let Some(anchor_name) = anchor_name {
            anchors.insert(
                anchor_name,
                PreservedAnchor::Path(path.iter().map(|segment| (*segment).to_owned()).collect()),
            );
        }
        if matches!(remainder.chars().next(), Some('{' | '['))
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
                &path,
                raw,
                &mut explicit_tags,
                &mut anchors,
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
                source, &spans, line_index, indent, body, remainder, tag_name,
            );
            preserve_tagged_value(raw, &path, tag_name, &lexical, &mut explicit_tags);
        }
        if remainder.is_empty() {
            containers.push((indent, key, false));
        }
    }
    explicit_tags
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
    let existing = if explicit_tags.contains_key(&explicit_tag_path(path)) {
        semantic_value(&existing).clone()
    } else {
        existing
    };
    let semantic = standard_tag_semantic(tag_name, lexical, existing);
    let mut body = Map::new();
    body.insert("tag".to_owned(), Value::String(tag_uri.clone()));
    body.insert("value".to_owned(), semantic);
    body.insert("source".to_owned(), Value::String(lexical.to_owned()));
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
        .find(remainder)
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
        && (value_source.starts_with("- ") || mapping_key_colon(value_source).is_some())
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
    match tag_name {
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
        _ => existing,
    }
}

fn preserve_flow_standard_yaml_tags(
    source: &str,
    base_path: &[&str],
    raw: &mut Map<String, Value>,
    explicit_tags: &mut Map<String, Value>,
    anchors: &mut std::collections::BTreeMap<String, PreservedAnchor>,
) {
    let mut scanner = FlowTagScanner {
        source,
        cursor: 0,
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
    cursor: usize,
    raw: &'model mut Map<String, Value>,
    explicit_tags: &'model mut Map<String, Value>,
    anchors: &'model mut std::collections::BTreeMap<String, PreservedAnchor>,
}

impl FlowTagScanner<'_, '_> {
    fn parse_value(&mut self, path: &mut Vec<String>) {
        self.skip_whitespace();
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
            self.parse_untagged_value(path);
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
            let (plain_key_source, _, _) = split_node_properties(full_key_source);
            let Ok(name) = serde_yaml::from_str::<String>(plain_key_source) else {
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
                None
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
        let (plain_key_source, _, _) = split_node_properties(key_source);
        let Ok(name) = serde_yaml::from_str::<String>(plain_key_source) else {
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
            None
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
    let (remainder, _, explicit_tag) = split_node_properties(value_source);
    let deferred_value = (remainder.is_empty() && explicit_tag.is_some())
        .then(|| {
            line_spans(&text[content_start..boundary])
                .into_iter()
                .find_map(|line| {
                    let body = &text[content_start + line.start..content_start + line.content_end];
                    let trimmed = body.trim_start_matches([' ', '\t']);
                    (!trimmed.is_empty() && !trimmed.starts_with('#')).then_some(trimmed.to_owned())
                })
        })
        .flatten();
    let deferred_indicator = deferred_value.as_deref().and_then(block_scalar_indicator);
    let block_scalar = indicator.is_some() || deferred_indicator.is_some();
    let tagged_scalar =
        explicit_tag.is_some_and(|tag| !matches!(tag, "map" | "seq" | "set" | "omap" | "pairs"));
    let deferred_block_collection = explicit_tag
        .is_some_and(|tag| matches!(tag, "map" | "seq" | "set" | "omap" | "pairs"))
        && deferred_value.as_deref().is_some_and(|value| {
            !matches!(value.chars().next(), Some('{' | '['))
                && (value.starts_with("- ") || mapping_key_colon(value).is_some())
        });
    let deferred_non_block_node = explicit_tag.is_some()
        && remainder.is_empty()
        && deferred_indicator.is_none()
        && !deferred_block_collection
        && deferred_value.is_some();
    let non_block_scalar = tagged_scalar || !remainder.is_empty() || deferred_non_block_node;
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
            if block_scalar {
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
    if block_scalar && last_nonblank.is_none() {
        return first_content.map_or(fallback, |(_, end)| end);
    }
    last_nonblank.map_or(fallback, |(content_end, line_end)| {
        if non_block_scalar && !block_scalar {
            content_end
        } else {
            line_end
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
