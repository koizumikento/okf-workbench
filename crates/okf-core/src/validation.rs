use crate::{Finding, LinkClassification, ParseFailureReason, ParsedBundle};
use chrono::{DateTime, FixedOffset};
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
            "Create index.md with an OKF version declaration.",
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
        match declared_value.as_str() {
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
                        "OKF curation: link target {:?} cannot be normalized safely.",
                        link.raw_target
                    ),
                    "Use a valid Markdown URL.",
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
            let peers = owners
                .iter()
                .enumerate()
                .filter(|(peer_index, _)| *peer_index != index)
                .map(|(_, peer)| peer.id.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            findings.push(curation(
                "okf.curation.duplicate-resource",
                &owner.source.uri,
                &format!(
                    "OKF curation: resource {resource:?} is also declared by {peers}."
                ),
                "Confirm whether these concepts intentionally describe the same exact resource identifier.",
                Some(concept_field_range(owner, "resource")),
            ));
        }
    }

    findings.sort_by(|left, right| {
        category_rank(&left.category)
            .cmp(&category_rank(&right.category))
            .then_with(|| left.uri.cmp(&right.uri))
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
            .then_with(|| finding_rank(&left.code).cmp(&finding_rank(&right.code)))
            .then_with(|| left.code.cmp(&right.code))
            .then_with(|| left.message.cmp(&right.message))
    });
    findings.dedup_by(|left, right| {
        left.code == right.code && left.uri == right.uri && left.message == right.message
    });
    findings
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

fn finding_rank(code: &str) -> u8 {
    match code {
        "okf.curation.duplicate-resource" => 0,
        "okf.curation.orphan-concept" => 1,
        "okf.curation.missing-description" => 2,
        "okf.curation.missing-title" => 3,
        "okf.curation.broken-link" => 4,
        "okf.curation.invalid-link" => 5,
        "okf.curation.out-of-bundle-link" => 6,
        _ => 7,
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
