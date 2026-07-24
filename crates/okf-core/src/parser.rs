use crate::{
    BundleDocumentInput, Concept, ConceptLink, DocumentContent, LinkClassification,
    NormalizedFrontmatter, ParseBundleInput, ParseFailure, ParseFailureReason, ParsedBundle,
    ParsedFrontmatter, ReservedDocument, SourceDocument, SourcePosition, SourceRange,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use chrono::{DateTime, SecondsFormat};
use pulldown_cmark::{Event, Options, Parser, Tag};
use serde_json::{Map, Number, Value};
use std::collections::BTreeSet;

const MAX_DOCUMENTS: usize = 2_000;
const MAX_DOCUMENT_BYTES: usize = 320 * 1024 + 16;
const MAX_LINKS: usize = 10_000;
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
}

pub fn parse_bundle(mut input: ParseBundleInput) -> ParsedBundle {
    if input.documents.len() > MAX_DOCUMENTS {
        return ParsedBundle {
            root_uri: input.root_uri.clone(),
            revision: input.revision,
            concepts: Vec::new(),
            reserved_documents: Vec::new(),
            failures: vec![failure(
                &input.root_uri,
                "<bundle>",
                ParseFailureReason::ResourceLimit,
                "Bundle parsing refused more than 2,000 Markdown documents.",
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
                    decoded.push(failed_document(&document, path.clone(), &item.reason));
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
                        ParseFailureReason::Frontmatter,
                        &error.message,
                        None,
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
                frontmatter
                    .raw
                    .get("okf_version")
                    .and_then(Value::as_str)
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
                    ParseFailureReason::Frontmatter,
                    &error.message,
                    None,
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
        let candidates = markdown_links(&body, body_range.start.offset, &document.text);
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
    let mut text = match content {
        DocumentContent::Text(text) => text,
        DocumentContent::Bytes(bytes) => String::from_utf8(bytes).map_err(|_| {
            Box::new(failure(
                &document.uri,
                &path,
                ParseFailureReason::Decode,
                "Document bytes are not valid UTF-8.",
                None,
            ))
        })?,
    };
    if text.len() > MAX_DOCUMENT_BYTES {
        return Err(Box::new(failure(
            &document.uri,
            &path,
            ParseFailureReason::ResourceLimit,
            "Document source exceeds the 327,696-byte semantic parsing limit.",
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
    let hash = document
        .content_hash
        .unwrap_or_else(|| fallback_content_hash(text.as_bytes()));
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
    reason: &ParseFailureReason,
) -> DecodedDocument {
    let hash = if *reason == ParseFailureReason::Decode {
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
        frontmatter: ParsedFrontmatter::default(),
        r#type: String::new(),
        title: None,
        description: None,
        resource: None,
        tags: Vec::new(),
        timestamp: None,
        body: String::new(),
        body_range: SourceRange::default(),
        links: Vec::new(),
    }
}

fn parse_frontmatter(
    text: &str,
) -> Result<(Option<ParsedFrontmatter>, String, SourceRange), FrontmatterError> {
    if !text.starts_with("---\n") && !text.starts_with("---\r\n") {
        return Ok((None, text.to_owned(), range_for(text, 0, text.len())));
    }
    let opening_end = text
        .find('\n')
        .map(|offset| offset + 1)
        .unwrap_or(text.len());
    let mut closing_start = None;
    let mut cursor = opening_end;
    for line in text[opening_end..].split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed == "---" {
            closing_start = Some(cursor);
            break;
        }
        cursor += line.len();
    }
    let closing_start = closing_start.ok_or_else(|| FrontmatterError {
        message: "YAML frontmatter has no closing delimiter.".to_owned(),
        range: Some(range_for(text, 0, opening_end)),
    })?;
    let closing_line_end = text[closing_start..]
        .find('\n')
        .map(|offset| closing_start + offset + 1)
        .unwrap_or(text.len());
    let yaml_source = &text[opening_end..closing_start];
    let yaml: serde_yaml::Value = serde_yaml::from_str(yaml_source).map_err(|error| {
        let range = error.location().map(|location| {
            let relative_line = location.line().saturating_sub(1);
            let line_start = yaml_source
                .match_indices('\n')
                .nth(relative_line.saturating_sub(1))
                .map_or(0, |(offset, _)| offset + 1);
            let start = opening_end + line_start;
            range_for(text, start, (start + 1).min(closing_start))
        });
        let message = if error.to_string().contains("expected ',' or ']'") {
            "Invalid YAML frontmatter: Flow sequence in block collection must be sufficiently indented and end with a ]".to_owned()
        } else {
            format!("Invalid YAML frontmatter: {error}")
        };
        FrontmatterError { message, range }
    })?;
    let mut raw = match yaml_to_json(yaml) {
        Value::Object(map) => map,
        _ => {
            return Err(FrontmatterError {
                message: "YAML frontmatter must be a mapping with string field names.".to_owned(),
                range: Some(range_for(text, opening_end, closing_start)),
            });
        }
    };
    preserve_standard_yaml_tags(yaml_source, &mut raw);
    let fields = top_level_field_ranges(text, opening_end, closing_start);
    let normalized = NormalizedFrontmatter {
        r#type: raw.get("type").and_then(Value::as_str).map(str::to_owned),
        title: raw.get("title").and_then(Value::as_str).map(str::to_owned),
        description: raw
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_owned),
        resource: raw
            .get("resource")
            .and_then(Value::as_str)
            .map(str::to_owned),
        tags: raw
            .get("tags")
            .and_then(Value::as_array)
            .map(|tags| {
                tags.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        timestamp: raw
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_owned),
    };
    let frontmatter = ParsedFrontmatter {
        raw,
        explicit_tags: Map::new(),
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

fn yaml_to_json(value: serde_yaml::Value) -> Value {
    match value {
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
        serde_yaml::Value::Sequence(values) => {
            Value::Array(values.into_iter().map(yaml_to_json).collect())
        }
        serde_yaml::Value::Mapping(values) => {
            let mut result = Map::new();
            for (key, value) in values {
                let key = match key {
                    serde_yaml::Value::String(key) => key,
                    other => serde_yaml::to_string(&other)
                        .unwrap_or_default()
                        .trim()
                        .to_owned(),
                };
                result.insert(key, yaml_to_json(value));
            }
            Value::Object(result)
        }
        serde_yaml::Value::Tagged(tagged) => {
            let mut tagged_body = Map::new();
            tagged_body.insert("tag".to_owned(), Value::String(tagged.tag.to_string()));
            tagged_body.insert("value".to_owned(), yaml_to_json(tagged.value));
            let mut wrapper = Map::new();
            wrapper.insert(TAGGED_KEY.to_owned(), Value::Object(tagged_body));
            Value::Object(wrapper)
        }
    }
}

fn preserve_standard_yaml_tags(source: &str, raw: &mut Map<String, Value>) {
    let mut containers: Vec<(usize, String)> = Vec::new();
    for line in source.lines() {
        let indent = line
            .chars()
            .take_while(|character| *character == ' ')
            .count();
        let trimmed = line.trim();
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
        let Some(tag_source) = value_source.strip_prefix("!!") else {
            continue;
        };
        let Some((tag_name, source_value)) = tag_source.split_once(char::is_whitespace) else {
            continue;
        };
        let source_value = source_value.trim();
        let path = containers
            .iter()
            .map(|(_, segment)| segment.as_str())
            .chain(std::iter::once(key.as_str()))
            .collect::<Vec<_>>();
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
            "omap" => existing,
            _ => continue,
        };
        let mut body = Map::new();
        body.insert(
            "tag".to_owned(),
            Value::String(format!("tag:yaml.org,2002:{tag_name}")),
        );
        body.insert("value".to_owned(), semantic);
        body.insert("source".to_owned(), Value::String(source_value.to_owned()));
        let mut wrapper = Map::new();
        wrapper.insert(TAGGED_KEY.to_owned(), Value::Object(body));
        set_value_at_path(raw, &path, Value::Object(wrapper));
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
    let mut cursor = start;
    for line in text[start..end].split_inclusive('\n') {
        let body = line.trim_end_matches(['\r', '\n']);
        if !body.starts_with(char::is_whitespace)
            && let Some(colon) = body.find(':')
        {
            let name = body[..colon].trim();
            if !name.is_empty() {
                starts.push((
                    name.to_owned(),
                    cursor,
                    cursor + body.len(),
                    !body[colon + 1..].trim().is_empty(),
                ));
            }
        }
        cursor += line.len();
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

fn markdown_links(body: &str, body_start: usize, full_text: &str) -> Vec<LinkCandidate> {
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
                    result.push(LinkCandidate {
                        label,
                        target,
                        range: range_for(
                            full_text,
                            body_start + start_range.start,
                            body_start + range.end,
                        ),
                    });
                }
            }
            _ => {}
        }
    }
    result
}

fn resolve_link(
    source_id: &str,
    source_path: &str,
    candidate: LinkCandidate,
    concept_paths: &BTreeSet<String>,
    directories: &BTreeSet<String>,
) -> ConceptLink {
    let raw = candidate.target.clone();
    let (path_and_query, fragment) = split_once(&raw, '#');
    let (path, query) = split_once(path_and_query, '?');
    let fragment = fragment.map(str::to_owned);
    let query = query.map(str::to_owned);
    let external = has_uri_scheme(path);
    let (classification, target_id) = if external {
        (LinkClassification::External, None)
    } else if path.is_empty() {
        (LinkClassification::Fragment, None)
    } else if path.ends_with('/') {
        (LinkClassification::Directory, None)
    } else {
        match normalize_link_path(source_path, path) {
            None => (LinkClassification::OutOfBundle, None),
            Some(resolved) if directories.contains(&resolved) => {
                (LinkClassification::Directory, None)
            }
            Some(resolved) => {
                let markdown = if resolved.ends_with(".md") {
                    resolved
                } else {
                    format!("{resolved}.md")
                };
                let id = markdown.trim_end_matches(".md").to_owned();
                if concept_paths.contains(&markdown) {
                    (LinkClassification::Internal, Some(id))
                } else {
                    (LinkClassification::Broken, None)
                }
            }
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

fn normalize_link_path(source_path: &str, target: &str) -> Option<String> {
    let decoded = percent_decode(target)?;
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
                parts.pop()?;
            }
            part => parts.push(part.to_owned()),
        }
    }
    Some(parts.join("/"))
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
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
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
    let line = prefix.bytes().filter(|byte| *byte == b'\n').count();
    let line_start = prefix.rfind('\n').map_or(0, |offset| offset + 1);
    SourcePosition {
        offset: prefix.encode_utf16().count(),
        line,
        character: prefix[line_start..].encode_utf16().count(),
    }
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
