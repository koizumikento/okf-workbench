use crate::parser::{is_valid_actor, is_valid_source_author, parse_explicit_zone_timestamp};
use crate::{Finding, LinkClassification, ParseFailureReason, ParsedBundle};
use chrono::{DateTime, Datelike, FixedOffset, NaiveDate, TimeZone, Utc};
use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use std::collections::{BTreeMap, BTreeSet};

fn is_ecmascript_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'
            ..='\u{000d}'
                | '\u{0020}'
                | '\u{00a0}'
                | '\u{1680}'
                | '\u{2000}'..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn ecmascript_trim(value: &str) -> &str {
    value.trim_matches(is_ecmascript_whitespace)
}

pub fn parse_reference_time(now: &str) -> Option<DateTime<FixedOffset>> {
    let (date_source, time_source) = now.split_once('T').unwrap_or((now, ""));
    if date_source.len() != 10
        || date_source.as_bytes().get(4) != Some(&b'-')
        || date_source.as_bytes().get(7) != Some(&b'-')
        || !date_source[..4].bytes().all(|byte| byte.is_ascii_digit())
        || !date_source[5..7].bytes().all(|byte| byte.is_ascii_digit())
        || !date_source[8..10].bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let year = date_source[..4].parse::<i32>().ok()?;
    let month = date_source[5..7].parse::<u32>().ok()?;
    let day = date_source[8..10].parse::<u32>().ok()?;
    let mut date = NaiveDate::from_ymd_opt(year, month, day)?;
    if time_source.is_empty() {
        return (now.len() == 10).then(|| {
            FixedOffset::east_opt(0)?
                .from_local_datetime(&date.and_hms_opt(0, 0, 0)?)
                .single()
        })?;
    }

    let (time, zone) = if let Some(time) = time_source.strip_suffix('Z') {
        (time, "Z")
    } else if let Some(offset) = time_source
        .char_indices()
        .skip(1)
        .find(|(_, character)| matches!(character, '+' | '-'))
        .map(|(index, _)| index)
    {
        (&time_source[..offset], &time_source[offset..])
    } else {
        (time_source, "Z")
    };
    let offset = if zone == "Z" {
        FixedOffset::east_opt(0)?
    } else {
        let sign = zone.as_bytes().first().copied()?;
        if !matches!(sign, b'+' | b'-') {
            return None;
        }
        let (hours, minutes) =
            if zone.len() == 5 && zone[1..].bytes().all(|byte| byte.is_ascii_digit()) {
                (&zone[1..3], &zone[3..5])
            } else if zone.len() == 6
                && zone.as_bytes().get(3) == Some(&b':')
                && zone[1..3].bytes().all(|byte| byte.is_ascii_digit())
                && zone[4..6].bytes().all(|byte| byte.is_ascii_digit())
            {
                (&zone[1..3], &zone[4..6])
            } else {
                return None;
            };
        let hours = hours.parse::<i32>().ok()?;
        let minutes = minutes.parse::<i32>().ok()?;
        if hours > 23 || minutes > 59 {
            return None;
        }
        let seconds = (hours * 60 + minutes) * 60;
        FixedOffset::east_opt(if sign == b'-' { -seconds } else { seconds })?
    };

    let parts = time.split(':').collect::<Vec<_>>();
    if !(2..=3).contains(&parts.len())
        || parts[0].len() != 2
        || parts[1].len() != 2
        || !parts[0].bytes().all(|byte| byte.is_ascii_digit())
        || !parts[1].bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let hour = parts[0].parse::<u32>().ok()?;
    let minute = parts[1].parse::<u32>().ok()?;
    let seconds = parts.get(2).copied().unwrap_or("00");
    let (whole_seconds, fraction) = seconds.split_once('.').unwrap_or((seconds, ""));
    if whole_seconds.len() != 2
        || !whole_seconds.bytes().all(|byte| byte.is_ascii_digit())
        || (!fraction.is_empty() && !fraction.bytes().all(|byte| byte.is_ascii_digit()))
        || seconds.ends_with('.')
    {
        return None;
    }
    let second = whole_seconds.parse::<u32>().ok()?;
    if hour == 24 {
        if minute != 0 || second != 0 || fraction.bytes().any(|byte| byte != b'0') {
            return None;
        }
        date = date.succ_opt()?;
    }
    if hour > 24 || minute > 59 || second > 59 {
        return None;
    }
    let nanoseconds = if fraction.is_empty() {
        0
    } else {
        let digits = fraction.chars().take(9).collect::<String>();
        format!("{digits:0<9}").parse::<u32>().ok()?
    };
    let normalized_hour = if hour == 24 { 0 } else { hour };
    offset
        .from_local_datetime(&date.and_hms_nano_opt(
            normalized_hour,
            minute,
            second,
            nanoseconds,
        )?)
        .single()
}

pub fn validate_bundle(bundle: &ParsedBundle, now: &str) -> Vec<Finding> {
    let now = parse_reference_time(now);
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
            Some("0.1" | "0.2") => {}
            Some(declared) if is_future_minor_version(declared) => findings.push(Finding {
                code: "okf.compatibility.future-minor-version".to_owned(),
                category: "compatibility".to_owned(),
                severity: "information".to_owned(),
                uri: reserved.source.uri.clone(),
                message: format!(
                    "OKF compatibility: bundle declares future minor version {}; reading continues on a best-effort basis.",
                    json_quote(declared)
                ),
                corrective_action: Some(
                    "Review producer changes before relying on fields introduced after OKF 0.2."
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
                    "OKF compatibility: bundle declares unsupported version {}; reading continues on a best-effort basis.",
                    json_quote(declared)
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
                    "Declare a supported version as the string `okf_version: \"0.2\"`.".to_owned(),
                ),
                range,
            }),
        }
    }

    let failed_paths = bundle
        .failures
        .iter()
        .map(|failure| {
            (
                failure.uri.clone(),
                normalize_bundle_path(&failure.bundle_path),
            )
        })
        .collect::<BTreeSet<_>>();
    let mut connected = BTreeSet::new();
    let mut resource_owners: BTreeMap<String, Vec<&crate::Concept>> = BTreeMap::new();
    for concept in &bundle.concepts {
        if failed_paths.contains(&(
            concept.source.uri.clone(),
            normalize_bundle_path(&concept.source.bundle_path),
        )) {
            continue;
        }
        if ecmascript_trim(&concept.r#type).is_empty() {
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
                        "OKF curation: internal link target {} does not resolve to a concept.",
                        json_quote(&link.raw_target)
                    ),
                    "Create the target concept or update the Markdown link target.",
                )),
                LinkClassification::OutOfBundle => findings.push(link_finding(
                    "okf.curation.out-of-bundle-link",
                    &concept.source.uri,
                    &link.range,
                    format!(
                        "OKF curation: link target {} resolves outside the selected bundle.",
                        json_quote(&link.raw_target)
                    ),
                    "Point the link at a concept inside the selected bundle or use an explicit external URL.",
                )),
                LinkClassification::Invalid => findings.push(link_finding(
                    "okf.curation.invalid-link",
                    &concept.source.uri,
                    &link.range,
                    format!(
                        "OKF curation: link target {} cannot be decoded or normalized safely.",
                        json_quote(&link.raw_target)
                    ),
                    "Use a valid Markdown URL with each path segment percent-encoded at most once.",
                )),
                _ => {}
            }
        }
        if concept
            .title
            .as_deref()
            .is_none_or(|value| ecmascript_trim(value).is_empty())
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
            .is_none_or(|value| ecmascript_trim(value).is_empty())
        {
            findings.push(curation(
                "okf.curation.missing-description",
                &concept.source.uri,
                "OKF curation: concept is missing the recommended non-empty `description` field.",
                "Add a one-sentence `description` to improve indexes, search, and previews.",
                Some(concept_field_range(concept, "description")),
            ));
        }
        if concept.frontmatter.raw.contains_key("timestamp")
            && !concept.frontmatter.raw.contains_key("generated")
        {
            let timestamp = concept
                .timestamp
                .as_deref()
                .and_then(parse_explicit_zone_timestamp);
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
        validate_v02_metadata(concept, now.as_ref(), &mut findings);
        if let Some(resource) = concept
            .resource
            .as_deref()
            .map(ecmascript_trim)
            .filter(|value| !value.is_empty())
        {
            resource_owners
                .entry(resource.to_owned())
                .or_default()
                .push(concept);
        }
    }

    for concept in &bundle.concepts {
        if !failed_paths.contains(&(
            concept.source.uri.clone(),
            normalize_bundle_path(&concept.source.bundle_path),
        )) && !connected.contains(concept.id.as_str())
        {
            findings.push(curation(
                "okf.curation.orphan-concept",
                &concept.source.uri,
                &format!(
                    "OKF curation: concept {} has no resolvable incoming or outgoing internal links.",
                    json_quote(&concept.id)
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
        let mut owners = owners.clone();
        owners.sort_by(|left, right| {
            compare_utf16(&left.id, &right.id)
                .then_with(|| compare_utf16(&left.source.uri, &right.source.uri))
        });
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
                    "OKF curation: resource {} is also declared by {peers}.",
                    json_quote(&bounded_diagnostic_text(resource))
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
        compare_utf16(&left.uri, &right.uri)
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
            .then_with(|| compare_utf16(&left.code, &right.code))
            .then_with(|| compare_utf16(&left.message, &right.message))
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

fn validate_v02_metadata(
    concept: &crate::Concept,
    now: Option<&DateTime<FixedOffset>>,
    findings: &mut Vec<Finding>,
) {
    let raw = &concept.frontmatter.raw;
    if let Some(generated) = raw.get("generated") {
        let object = generated.as_object();
        let by = concept
            .generated
            .as_ref()
            .and_then(|value| value.by.as_deref());
        let at = concept
            .generated
            .as_ref()
            .and_then(|value| value.at.as_deref());
        let parsed_at = at.and_then(parse_explicit_zone_timestamp);
        let has_at = object.is_some_and(|value| value.contains_key("at"));
        if object.is_none()
            || by.is_none_or(|value| !is_valid_actor(value))
            || has_at && parsed_at.is_none()
        {
            findings.push(curation(
                "okf.curation.invalid-generated",
                &concept.source.uri,
                "OKF curation: `generated` must be a mapping with non-empty `by` and an optional explicit-zone `at` date-time.",
                "Use `generated: { by: process:producer, at: 2026-07-31T00:00:00Z }` or remove the malformed optional family.",
                Some(concept_field_range(concept, "generated")),
            ));
        } else if let (Some(at), Some(now)) = (parsed_at, now)
            && at.timestamp_millis() > now.timestamp_millis() + 300_000
        {
            findings.push(curation(
                "okf.curation.future-generated-at",
                &concept.source.uri,
                "OKF curation: `generated.at` is more than five minutes after the validation reference time.",
                "Correct the generation time or the system clock, then validate the bundle again.",
                Some(concept_field_range(concept, "generated")),
            ));
        }
    }

    if let Some(verified) = raw.get("verified") {
        let values = match verified {
            serde_json::Value::Array(values) => values.iter().collect::<Vec<_>>(),
            value => vec![value],
        };
        let mut invalid = values.is_empty();
        let mut future = false;
        if concept.verified.len() != values.len() {
            invalid = true;
        }
        for (index, value) in values.into_iter().enumerate() {
            let object = value.as_object();
            let normalized = concept.verified.get(index);
            let by = normalized.and_then(|value| value.by.as_deref());
            let at = normalized.and_then(|value| value.at.as_deref());
            let parsed_at = at.and_then(parse_explicit_zone_timestamp);
            if object.is_none()
                || by.is_none_or(|value| !is_valid_actor(value))
                || parsed_at.is_none()
            {
                invalid = true;
            } else if let (Some(at), Some(now)) = (parsed_at, now)
                && at.timestamp_millis() > now.timestamp_millis() + 300_000
            {
                future = true;
            }
        }
        if invalid {
            findings.push(curation(
                "okf.curation.invalid-verified",
                &concept.source.uri,
                "OKF curation: `verified` must be one verification mapping or a list of mappings with non-empty `by` and explicit-zone `at`.",
                "Record each verification as `{ by: <actor>, at: <ISO 8601 date-time> }`.",
                Some(concept_field_range(concept, "verified")),
            ));
        } else if future {
            findings.push(curation(
                "okf.curation.future-verified-at",
                &concept.source.uri,
                "OKF curation: a `verified.at` value is more than five minutes after the validation reference time.",
                "Correct the verification time or the system clock, then validate the bundle again.",
                Some(concept_field_range(concept, "verified")),
            ));
        }
    }

    if raw.contains_key("status")
        && !matches!(
            concept.status.as_deref(),
            Some("draft" | "stable" | "deprecated")
        )
    {
        findings.push(curation(
            "okf.curation.invalid-status",
            &concept.source.uri,
            "OKF curation: `status` must be `draft`, `stable`, or `deprecated`.",
            "Choose a defined lifecycle status or remove the optional field.",
            Some(concept_field_range(concept, "status")),
        ));
    }

    if raw.contains_key("stale_after") {
        let parsed = concept
            .stale_after
            .as_deref()
            .filter(|value| is_iso_date(value))
            .and_then(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok());
        if parsed.is_none() {
            findings.push(curation(
                "okf.curation.invalid-stale-after",
                &concept.source.uri,
                "OKF curation: `stale_after` must be an absolute `YYYY-MM-DD` date.",
                "Use a valid absolute date such as `2026-09-23`.",
                Some(concept_field_range(concept, "stale_after")),
            ));
        } else if let (Some(stale_after), Some(now)) = (parsed, now)
            && stale_after.format("%Y-%m-%d").to_string() <= javascript_iso_date_prefix(now)
        {
            findings.push(curation(
                "okf.curation.stale-concept",
                &concept.source.uri,
                &format!(
                    "OKF curation: concept is stale on or after {}.",
                    json_quote(&stale_after.format("%Y-%m-%d").to_string())
                ),
                "Review and regenerate or re-verify the concept, then move `stale_after` forward when justified.",
                Some(concept_field_range(concept, "stale_after")),
            ));
        }
    }

    if let Some(sources) = raw.get("sources") {
        let valid = sources.as_array().is_some_and(|values| {
            values.len() == concept.sources.len()
                && values.iter().enumerate().all(|(index, value)| {
                    let Some(object) = value.as_object() else {
                        return false;
                    };
                    let Some(source) = concept.sources.get(index) else {
                        return false;
                    };
                    source
                        .resource
                        .as_deref()
                        .is_some_and(|resource| !ecmascript_trim(resource).is_empty())
                        && (!object.contains_key("id") || source.id.is_some())
                        && (!object.contains_key("title") || source.title.is_some())
                        && (!object.contains_key("author")
                            || source.author.as_deref().is_some_and(is_valid_source_author))
                        && object
                            .get("usage_count")
                            .is_none_or(|_| source.usage_count.is_some())
                        && (!object.contains_key("usage_count")
                            || if object.contains_key("usage_window") {
                                source
                                    .usage_window
                                    .as_ref()
                                    .is_some_and(valid_normalized_usage_window)
                            } else {
                                concept
                                    .usage_window
                                    .as_ref()
                                    .is_some_and(valid_normalized_usage_window)
                            })
                        && object.get("last_modified").is_none_or(|_| {
                            source.last_modified.as_deref().is_some_and(is_iso_date)
                        })
                        && object.get("usage_window").is_none_or(|_| {
                            source
                                .usage_window
                                .as_ref()
                                .is_some_and(valid_normalized_usage_window)
                        })
                })
        });
        if !valid {
            findings.push(curation(
                "okf.curation.invalid-sources",
                &concept.source.uri,
                "OKF curation: `sources` must be a list whose entries each contain a non-empty `resource`.",
                "Repair the source entries or remove the malformed optional provenance family.",
                Some(concept_field_range(concept, "sources")),
            ));
        }
    }

    if raw.contains_key("usage_window")
        && !concept
            .usage_window
            .as_ref()
            .is_some_and(valid_normalized_usage_window)
    {
        findings.push(curation(
            "okf.curation.invalid-usage-window",
            &concept.source.uri,
            "OKF curation: `usage_window` must contain valid `from` and `to` dates in ascending order.",
            "Use `{ from: YYYY-MM-DD, to: YYYY-MM-DD }`, or remove the malformed optional window.",
            Some(concept_field_range(concept, "usage_window")),
        ));
    }

    if concept.r#type == "Attested Computation" {
        let parameters_valid = raw.get("parameters").is_none_or(|parameters| {
            parameters.as_array().is_some_and(|values| {
                values.len() == concept.parameters.len()
                    && values.iter().enumerate().all(|(index, value)| {
                        let Some(object) = value.as_object() else {
                            return false;
                        };
                        let Some(parameter) = concept.parameters.get(index) else {
                            return false;
                        };
                        parameter
                            .name
                            .as_deref()
                            .is_some_and(|name| !ecmascript_trim(name).is_empty())
                            && parameter
                                .r#type
                                .as_deref()
                                .is_some_and(|kind| !ecmascript_trim(kind).is_empty())
                            && object.contains_key("required")
                            && parameter.required.is_some()
                    })
            })
        });
        let file_computation = raw.contains_key("computation")
            && concept
                .computation
                .as_deref()
                .is_some_and(|computation| !ecmascript_trim(computation).is_empty());
        let inline_computations = inline_computation_count(&concept.body);
        let computation_valid = if raw.contains_key("computation") {
            file_computation && inline_computations == 0
        } else {
            inline_computations == 1
        };
        let executor_valid = raw
            .get("executor")
            .is_none_or(|value| valid_computation_endpoint(value, concept.executor.as_ref(), true));
        let attester_valid = raw.get("attester").is_none_or(|value| {
            valid_computation_endpoint(value, concept.attester.as_ref(), false)
        });
        if concept
            .runtime
            .as_deref()
            .is_none_or(|runtime| ecmascript_trim(runtime).is_empty())
            || !parameters_valid
            || !computation_valid
            || !executor_valid
            || !attester_valid
        {
            let field = if concept
                .runtime
                .as_deref()
                .is_none_or(|runtime| ecmascript_trim(runtime).is_empty())
            {
                "runtime"
            } else if !parameters_valid {
                "parameters"
            } else if !computation_valid {
                "computation"
            } else if !executor_valid {
                "executor"
            } else {
                "attester"
            };
            findings.push(curation(
                "okf.curation.invalid-attested-computation",
                &concept.source.uri,
                "OKF curation: an Attested Computation needs a runtime, a file or inline fenced computation, valid typed parameters, and well-formed optional executor and attester mappings.",
                "Repair the declarative computation contract before relying on attestation.",
                Some(concept_field_range(concept, field)),
            ));
        }
    }
}

fn javascript_iso_date_prefix(now: &DateTime<FixedOffset>) -> String {
    let utc = now.with_timezone(&Utc);
    let year = utc.year();
    let iso_date = if (0..=9999).contains(&year) {
        format!("{year:04}-{:02}-{:02}", utc.month(), utc.day())
    } else if year >= 0 {
        format!("+{year:06}-{:02}-{:02}", utc.month(), utc.day())
    } else {
        format!(
            "-{:06}-{:02}-{:02}",
            year.unsigned_abs(),
            utc.month(),
            utc.day()
        )
    };
    iso_date.chars().take(10).collect()
}

fn valid_normalized_usage_window(value: &crate::UsageWindow) -> bool {
    value.from.as_deref().is_some_and(is_iso_date)
        && value.to.as_deref().is_some_and(is_iso_date)
        && value.from <= value.to
}

fn valid_computation_endpoint(
    value: &serde_json::Value,
    normalized: Option<&crate::ComputationEndpoint>,
    allow_receipt: bool,
) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let Some(normalized) = normalized else {
        return false;
    };
    if normalized
        .resource
        .as_deref()
        .is_none_or(|resource| ecmascript_trim(resource).is_empty())
    {
        return false;
    }
    !allow_receipt
        || object.get("receipt").is_none_or(|receipt| {
            receipt.as_array().is_some_and(|fields| {
                fields.len() == normalized.receipt.len()
                    && normalized
                        .receipt
                        .iter()
                        .all(|field| !ecmascript_trim(field).is_empty())
            })
        })
}

fn inline_computation_count(body: &str) -> usize {
    let mut in_computation = false;
    let mut heading_text: Option<String> = None;
    let mut container_depth = 0usize;
    let mut count = 0usize;
    for event in Parser::new_ext(body, Options::empty()) {
        match event {
            Event::Start(Tag::BlockQuote(_) | Tag::List(_) | Tag::Item) => {
                container_depth += 1;
            }
            Event::End(TagEnd::BlockQuote(_) | TagEnd::List(_) | TagEnd::Item) => {
                container_depth = container_depth.saturating_sub(1);
            }
            Event::Start(Tag::Heading {
                level: HeadingLevel::H1,
                ..
            }) if container_depth == 0 => {
                heading_text = Some(String::new());
            }
            Event::Text(text) | Event::Code(text) if heading_text.is_some() => {
                if let Some(heading) = &mut heading_text {
                    heading.push_str(&text);
                }
            }
            Event::End(TagEnd::Heading(HeadingLevel::H1)) => {
                if let Some(heading) = heading_text.take() {
                    in_computation = ecmascript_trim(&heading) == "Computation";
                }
            }
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(_))) if in_computation => {
                count += 1;
            }
            _ => {}
        }
    }
    count
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

fn json_quote(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned())
}

fn normalize_bundle_path(value: &str) -> String {
    let normalized = value.replace('\\', "/");
    normalized
        .strip_prefix("./")
        .unwrap_or(&normalized)
        .to_owned()
}

fn compare_utf16(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
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
                        "OKF conformance: log.md date heading {} is not YYYY-MM-DD.",
                        json_quote(&heading.text)
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

pub fn is_future_minor_version(value: &str) -> bool {
    let Some((major, minor)) = value.split_once('.') else {
        return false;
    };
    if major.is_empty()
        || !major.bytes().all(|byte| byte.is_ascii_digit())
        || major.bytes().any(|byte| byte != b'0')
        || minor.is_empty()
        || !minor.bytes().all(|byte| byte.is_ascii_digit())
    {
        return false;
    }
    let significant_minor = minor.trim_start_matches('0');
    significant_minor.len() > 1
        || significant_minor
            .as_bytes()
            .first()
            .is_some_and(|minor| *minor > b'2')
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

    #[test]
    fn future_minor_versions_are_arbitrary_precision() {
        assert!(is_future_minor_version("00.3"));
        assert!(is_future_minor_version(
            "0.999999999999999999999999999999999999999999999999999999999999"
        ));
        assert!(!is_future_minor_version("0.0002"));
        assert!(!is_future_minor_version("1.3"));
    }

    #[test]
    fn inline_computation_uses_commonmark_blocks() {
        assert_eq!(
            inline_computation_count("# Computation\r\r```sh\rtrue\r```\r"),
            1
        );
        assert_eq!(inline_computation_count("```md\n# Computation\n```\n"), 0);
        assert_eq!(
            inline_computation_count("# Computation###\n\n```sh\ntrue\n```\n"),
            0
        );
        assert_eq!(
            inline_computation_count("# Computation\n\n```sh\ntrue\n```\n\n```sh\nfalse\n```\n"),
            2
        );
        assert_eq!(
            inline_computation_count("> # Computation\n>\n> ```sh\n> true\n> ```\n"),
            0
        );
        assert_eq!(
            inline_computation_count("- # Computation\n\n  ```sh\n  true\n  ```\n"),
            0
        );
    }
}
