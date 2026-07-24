use crate::{Finding, LinkClassification, ParseFailureReason, ParsedBundle};
use chrono::{DateTime, FixedOffset};
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use std::collections::{BTreeMap, BTreeSet};

pub fn validate_bundle(bundle: &ParsedBundle, now: &str) -> Vec<Finding> {
    let now = DateTime::parse_from_rfc3339(now).ok();
    let mut findings = bundle.findings.clone();
    for failure in &bundle.failures {
        let (code, action) = match failure.reason {
            ParseFailureReason::Decode => (
                "okf.conformance.utf8-decode",
                "Save the document as valid UTF-8 and validate the bundle again.",
            ),
            ParseFailureReason::Frontmatter => (
                "okf.conformance.frontmatter",
                "Add or repair the YAML frontmatter block at the start of the concept document.",
            ),
            ParseFailureReason::Markdown => (
                "okf.conformance.markdown",
                "Repair the Markdown so the document can be consumed.",
            ),
            ParseFailureReason::Read => (
                "okf.conformance.read",
                "Make the document readable and validate the bundle again.",
            ),
            ParseFailureReason::ResourceLimit => (
                "okf.conformance.resource-limit",
                "Reduce or split the document or bundle, then validate it again.",
            ),
        };
        findings.push(Finding {
            code: code.to_owned(),
            category: "conformance".to_owned(),
            severity: "error".to_owned(),
            uri: failure.uri.clone(),
            message: format!("OKF conformance: {}", failure.message),
            corrective_action: Some(action.to_owned()),
            range: failure.range.clone(),
        });
    }

    if !bundle
        .reserved_documents
        .iter()
        .any(|document| document.source.bundle_path == "index.md")
        && !bundle
            .failures
            .iter()
            .any(|failure| failure.bundle_path == "index.md")
    {
        findings.push(finding(
            "okf.conformance.root-index",
            "conformance",
            "error",
            &bundle.root_uri,
            "OKF conformance: the selected bundle root is missing index.md.",
            "Run OKF: Regenerate Indexes to synthesize the missing root index, or create index.md with an OKF version declaration.",
        ));
    }

    for reserved in bundle
        .reserved_documents
        .iter()
        .filter(|document| document.source.bundle_path == "index.md")
    {
        let Some(frontmatter) = &reserved.frontmatter else {
            continue;
        };
        let Some(declared_value) = frontmatter.raw.get("okf_version") else {
            continue;
        };
        let range = frontmatter_field_range(frontmatter, "okf_version");
        match reserved.okf_version.as_deref() {
            Some("0.1") => {}
            Some(declared) if future_minor_version(declared) => findings.push(Finding {
                code: "okf.compatibility.future-minor-version".to_owned(),
                category: "compatibility".to_owned(),
                severity: "information".to_owned(),
                uri: reserved.source.uri.clone(),
                message: format!(
                    "OKF compatibility: bundle declares future minor version {declared:?}; reading continues on a best-effort basis."
                ),
                corrective_action: Some(
                    "Review producer changes before relying on fields introduced after OKF 0.1."
                        .to_owned(),
                ),
                range,
            }),
            Some(declared) => findings.push(Finding {
                code: "okf.compatibility.unsupported-version".to_owned(),
                category: "compatibility".to_owned(),
                severity: "warning".to_owned(),
                uri: reserved.source.uri.clone(),
                message: format!(
                    "OKF compatibility: bundle declares unsupported version {declared:?}; reading continues on a best-effort basis."
                ),
                corrective_action: Some(
                    "Review the declared OKF version before applying Workbench-generated changes."
                        .to_owned(),
                ),
                range,
            }),
            None => findings.push(Finding {
                code: "okf.compatibility.unsupported-version".to_owned(),
                category: "compatibility".to_owned(),
                severity: "warning".to_owned(),
                uri: reserved.source.uri.clone(),
                message: format!(
                    "OKF compatibility: bundle declares a non-string `okf_version` ({}); reading continues on a best-effort basis.",
                    json_value_kind(declared_value)
                ),
                corrective_action: Some(
                    "Declare the supported version as the string `okf_version: \"0.1\"`.".to_owned(),
                ),
                range,
            }),
        }
    }

    let failed_paths = bundle
        .failures
        .iter()
        .map(|failure| failure.bundle_path.as_str())
        .collect::<BTreeSet<_>>();
    let mut connected = BTreeSet::new();
    let mut resource_owners: BTreeMap<&str, Vec<&crate::Concept>> = BTreeMap::new();
    for concept in &bundle.concepts {
        if failed_paths.contains(concept.source.bundle_path.as_str()) {
            continue;
        }
        if concept.r#type.trim().is_empty() {
            findings.push(Finding {
                code: "okf.conformance.concept-type".to_owned(),
                category: "conformance".to_owned(),
                severity: "error".to_owned(),
                uri: concept.source.uri.clone(),
                message: "OKF conformance: concept frontmatter must contain a non-empty string `type` field.".to_owned(),
                corrective_action: Some("Set `type` to a descriptive, non-empty string. Custom type values are allowed.".to_owned()),
                range: Some(concept_field_range(concept, "type")),
            });
        }
        for link in &concept.links {
            match link.classification {
                LinkClassification::Internal => {
                    connected.insert(concept.id.as_str());
                    if let Some(target) = &link.target_id {
                        connected.insert(target.as_str());
                    }
                }
                LinkClassification::Broken => findings.push(link_finding(
                    "okf.curation.broken-link",
                    &concept.source.uri,
                    &link.range,
                    format!(
                        "OKF curation: internal link target {:?} does not resolve to a concept.",
                        link.raw_target
                    ),
                    "Create the target concept or update the Markdown link target.",
                )),
                LinkClassification::OutOfBundle => findings.push(link_finding(
                    "okf.curation.out-of-bundle-link",
                    &concept.source.uri,
                    &link.range,
                    format!(
                        "OKF curation: link target {:?} resolves outside the selected bundle.",
                        link.raw_target
                    ),
                    "Point the link at a concept inside the selected bundle or use an explicit external URL.",
                )),
                LinkClassification::Invalid => findings.push(link_finding(
                    "okf.curation.invalid-link",
                    &concept.source.uri,
                    &link.range,
                    format!(
                        "OKF curation: link target {:?} cannot be decoded or normalized safely.",
                        link.raw_target
                    ),
                    "Use a valid Markdown URL with each path segment percent-encoded at most once.",
                )),
                _ => {}
            }
        }
        if concept
            .title
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
        {
            findings.push(curation(
                "okf.curation.missing-title",
                &concept.source.uri,
                "OKF curation: concept is missing the recommended non-empty `title` field.",
                "Add a concise human-readable `title`, or keep the filename fallback intentionally.",
                Some(concept_field_range(concept, "title")),
            ));
        }
        if concept
            .description
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
        {
            findings.push(curation(
                "okf.curation.missing-description",
                &concept.source.uri,
                "OKF curation: concept is missing the recommended non-empty `description` field.",
                "Add a one-sentence `description` to improve indexes, search, and previews.",
                Some(concept_field_range(concept, "description")),
            ));
        }
        if concept.frontmatter.raw.contains_key("timestamp") {
            let timestamp = concept
                .timestamp
                .as_deref()
                .and_then(|value| DateTime::<FixedOffset>::parse_from_rfc3339(value).ok());
            if timestamp.is_none() {
                findings.push(curation(
                    "okf.curation.invalid-timestamp",
                    &concept.source.uri,
                    "OKF curation: `timestamp` must be a valid ISO 8601 date-time with `Z` or a numeric offset.",
                    "Use an explicit-zone value such as `2026-07-22T09:30:00Z`.",
                    Some(concept_field_range(concept, "timestamp")),
                ));
            } else if let (Some(timestamp), Some(now)) = (timestamp, now)
                && timestamp.timestamp_millis() > now.timestamp_millis() + 300_000
            {
                findings.push(curation(
                    "okf.curation.future-timestamp",
                    &concept.source.uri,
                    "OKF curation: `timestamp` is more than five minutes after the validation reference time.",
                    "Correct the timestamp or the system clock, then validate the bundle again.",
                    Some(concept_field_range(concept, "timestamp")),
                ));
            }
        }
        if let Some(resource) = concept
            .resource
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            resource_owners.entry(resource).or_default().push(concept);
        }
    }

    for concept in &bundle.concepts {
        if !failed_paths.contains(concept.source.bundle_path.as_str())
            && !connected.contains(concept.id.as_str())
        {
            findings.push(curation(
                "okf.curation.orphan-concept",
                &concept.source.uri,
                &format!(
                    "OKF curation: concept {:?} has no resolvable incoming or outgoing internal links.",
                    concept.id
                ),
                "Link this concept to related bundle knowledge, or keep it isolated intentionally.",
                Some(concept_field_range(concept, "type")),
            ));
        }
    }

    for (resource, owners) in resource_owners
        .iter()
        .filter(|(_, owners)| owners.len() > 1)
    {
        for (index, owner) in owners.iter().enumerate() {
            let peer_ids = owners
                .iter()
                .enumerate()
                .filter(|(peer_index, _)| *peer_index != index)
                .map(|(_, peer)| bounded_diagnostic_text(&peer.id))
                .take(8)
                .collect::<Vec<_>>();
            let omitted = owners.len() - 1 - peer_ids.len();
            let peers = format!(
                "{}{}",
                peer_ids.join(", "),
                if omitted > 0 {
                    format!(", and {omitted} more")
                } else {
                    String::new()
                }
            );
            findings.push(curation(
                "okf.curation.duplicate-resource",
                &owner.source.uri,
                &format!(
                    "OKF curation: resource {:?} is also declared by {peers}.",
                    bounded_diagnostic_text(resource)
                ),
                "Confirm whether these concepts intentionally describe the same exact resource identifier.",
                Some(concept_field_range(owner, "resource")),
            ));
        }
    }

    for reserved in &bundle.reserved_documents {
        validate_reserved_document(reserved, &mut findings);
    }

    findings.sort_by(|left, right| {
        left.uri
            .cmp(&right.uri)
            .then_with(|| {
                left.range
                    .as_ref()
                    .map(|range| range.start.offset)
                    .unwrap_or(usize::MAX)
                    .cmp(
                        &right
                            .range
                            .as_ref()
                            .map(|range| range.start.offset)
                            .unwrap_or(usize::MAX),
                    )
            })
            .then_with(|| {
                left.range
                    .as_ref()
                    .map(|range| range.end.offset)
                    .unwrap_or(usize::MAX)
                    .cmp(
                        &right
                            .range
                            .as_ref()
                            .map(|range| range.end.offset)
                            .unwrap_or(usize::MAX),
                    )
            })
            .then_with(|| category_rank(&left.category).cmp(&category_rank(&right.category)))
            .then_with(|| left.code.cmp(&right.code))
            .then_with(|| left.message.cmp(&right.message))
    });
    findings.dedup_by(|left, right| {
        left.uri == right.uri
            && left.range == right.range
            && left.category == right.category
            && left.severity == right.severity
            && left.code == right.code
            && left.message == right.message
            && left.corrective_action == right.corrective_action
    });
    findings
}

fn bounded_diagnostic_text(value: &str) -> String {
    const LIMIT: usize = 160;
    let units = value.encode_utf16().count();
    if units <= LIMIT {
        return value.to_owned();
    }
    let mut retained = String::new();
    let mut retained_units = 0usize;
    for character in value.chars() {
        let units = character.len_utf16();
        if retained_units + units >= LIMIT {
            break;
        }
        retained.push(character);
        retained_units += units;
    }
    retained.push('…');
    retained
}

fn validate_reserved_document(reserved: &crate::ReservedDocument, findings: &mut Vec<Finding>) {
    let is_root_index = reserved.source.bundle_path.replace('\\', "/") == "index.md";
    if let Some(frontmatter) = &reserved.frontmatter
        && !(reserved.reserved_kind == "index" && is_root_index)
    {
        findings.push(Finding {
            code: "okf.conformance.reserved-frontmatter".to_owned(),
            category: "conformance".to_owned(),
            severity: "error".to_owned(),
            uri: reserved.source.uri.clone(),
            message: format!(
                "OKF conformance: {}.md may not contain YAML frontmatter at this location.",
                reserved.reserved_kind
            ),
            corrective_action: Some(
                "Remove the frontmatter. Only the bundle-root index.md may declare `okf_version`."
                    .to_owned(),
            ),
            range: Some(frontmatter.range.clone()),
        });
    }

    let headings = markdown_headings(&reserved.body);
    if reserved.reserved_kind == "index" {
        if headings.is_empty() {
            findings.push(Finding {
                code: "okf.conformance.index-structure".to_owned(),
                category: "conformance".to_owned(),
                severity: "error".to_owned(),
                uri: reserved.source.uri.clone(),
                message:
                    "OKF conformance: index.md must contain at least one Markdown section heading."
                        .to_owned(),
                corrective_action: Some(
                    "Add a heading and list the directory's concepts or subdirectories beneath it."
                        .to_owned(),
                ),
                range: Some(reserved.body_range.clone()),
            });
        }
    } else {
        let date_headings = headings
            .iter()
            .filter(|heading| heading.level == HeadingLevel::H2)
            .collect::<Vec<_>>();
        let invalid = date_headings
            .iter()
            .find(|heading| !is_iso_date(&heading.text));
        if date_headings.is_empty() || invalid.is_some() {
            let (message, range) = if let Some(heading) = invalid {
                (
                    format!(
                        "OKF conformance: log.md date heading {:?} is not YYYY-MM-DD.",
                        heading.text
                    ),
                    translate_body_range(&reserved.body_range.start, &heading.range),
                )
            } else {
                (
                    "OKF conformance: log.md must group entries under `## YYYY-MM-DD` date headings."
                        .to_owned(),
                    reserved.body_range.clone(),
                )
            };
            findings.push(Finding {
                code: "okf.conformance.log-structure".to_owned(),
                category: "conformance".to_owned(),
                severity: "error".to_owned(),
                uri: reserved.source.uri.clone(),
                message,
                corrective_action: Some(
                    "Use ISO 8601 date headings such as `## 2026-07-22`.".to_owned(),
                ),
                range: Some(range),
            });
        }
    }
}

struct MarkdownHeading {
    level: HeadingLevel,
    text: String,
    range: crate::SourceRange,
}

fn markdown_headings(body: &str) -> Vec<MarkdownHeading> {
    let mut pending: Option<(HeadingLevel, String, std::ops::Range<usize>)> = None;
    let mut headings = Vec::new();
    for (event, range) in Parser::new_ext(body, Options::empty()).into_offset_iter() {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                pending = Some((level, String::new(), range));
            }
            Event::Text(text) | Event::Code(text) => {
                if let Some((_, value, _)) = pending.as_mut() {
                    value.push_str(&text);
                }
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some((level, text, start)) = pending.take() {
                    let mut end = range.end;
                    while end > start.start
                        && body
                            .as_bytes()
                            .get(end - 1)
                            .is_some_and(|byte| matches!(*byte, b'\r' | b'\n'))
                    {
                        end -= 1;
                    }
                    headings.push(MarkdownHeading {
                        level,
                        text,
                        range: source_range_for(body, start.start, end),
                    });
                }
            }
            _ => {}
        }
    }
    headings
}

fn is_iso_date(value: &str) -> bool {
    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
        && value.len() == "YYYY-MM-DD".len()
}

fn source_range_for(text: &str, start: usize, end: usize) -> crate::SourceRange {
    crate::SourceRange {
        start: source_position_for(text, start),
        end: source_position_for(text, end),
    }
}

fn source_position_for(text: &str, byte_offset: usize) -> crate::SourcePosition {
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
    crate::SourcePosition {
        offset: prefix.encode_utf16().count(),
        line,
        character,
    }
}

fn translate_body_range(
    body_start: &crate::SourcePosition,
    relative: &crate::SourceRange,
) -> crate::SourceRange {
    crate::SourceRange {
        start: translate_position(body_start, &relative.start),
        end: translate_position(body_start, &relative.end),
    }
}

fn translate_position(
    body_start: &crate::SourcePosition,
    relative: &crate::SourcePosition,
) -> crate::SourcePosition {
    crate::SourcePosition {
        offset: body_start.offset + relative.offset,
        line: body_start.line + relative.line,
        character: if relative.line == 0 {
            body_start.character + relative.character
        } else {
            relative.character
        },
    }
}

fn category_rank(category: &str) -> u8 {
    match category {
        "conformance" => 0,
        "curation" => 1,
        _ => 2,
    }
}

fn future_minor_version(value: &str) -> bool {
    let Some((major, minor)) = value.split_once('.') else {
        return false;
    };
    major == "0" && minor.parse::<u64>().is_ok_and(|minor| minor > 1)
}

fn concept_field_range(concept: &crate::Concept, field: &str) -> crate::SourceRange {
    frontmatter_field_range(&concept.frontmatter, field)
        .unwrap_or_else(|| concept.frontmatter.range.clone())
}

fn frontmatter_field_range(
    frontmatter: &crate::ParsedFrontmatter,
    field: &str,
) -> Option<crate::SourceRange> {
    frontmatter
        .fields
        .get(field)
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .or_else(|| Some(frontmatter.range.clone()))
}

fn json_value_kind(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "boolean",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

fn finding(
    code: &str,
    category: &str,
    severity: &str,
    uri: &str,
    message: &str,
    action: &str,
) -> Finding {
    Finding {
        code: code.to_owned(),
        category: category.to_owned(),
        severity: severity.to_owned(),
        uri: uri.to_owned(),
        message: message.to_owned(),
        corrective_action: Some(action.to_owned()),
        range: None,
    }
}

fn curation(
    code: &str,
    uri: &str,
    message: &str,
    action: &str,
    range: Option<crate::SourceRange>,
) -> Finding {
    Finding {
        code: code.to_owned(),
        category: "curation".to_owned(),
        severity: "warning".to_owned(),
        uri: uri.to_owned(),
        message: message.to_owned(),
        corrective_action: Some(action.to_owned()),
        range,
    }
}

fn link_finding(
    code: &str,
    uri: &str,
    range: &crate::SourceRange,
    message: String,
    action: &str,
) -> Finding {
    curation(code, uri, &message, action, Some(range.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BundleDocumentInput, DocumentContent, ParseBundleInput, parse_bundle};

    fn validate_root(source: &str) -> Vec<Finding> {
        let bundle = parse_bundle(ParseBundleInput {
            root_uri: "file:///bundle".to_owned(),
            revision: 1,
            documents: vec![BundleDocumentInput {
                uri: "file:///bundle/index.md".to_owned(),
                bundle_path: "index.md".to_owned(),
                content: Some(DocumentContent::Text(source.to_owned())),
                content_hash: None,
                identity_only_failure: None,
            }],
        });
        validate_bundle(&bundle, "2026-07-24T00:00:00Z")
    }

    #[test]
    fn reports_unsupported_root_version() {
        let findings = validate_root("---\nokf_version: \"1.0\"\n---\n# Root\n");
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].code, "okf.compatibility.unsupported-version");
        assert_eq!(findings[0].category, "compatibility");
    }

    #[test]
    fn accepts_supported_root_version() {
        assert!(validate_root("---\nokf_version: \"0.1\"\n---\n# Root\n").is_empty());
    }
}
