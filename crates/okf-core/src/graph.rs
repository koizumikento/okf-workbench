use crate::{
    BrokenLinkPresentation, GraphEdge, GraphNode, GraphPayload, GraphStatistics,
    LinkClassification, ParseFailureReason, ParsedBundle, SourceRange,
};
use std::collections::{BTreeMap, BTreeSet};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_PROVIDER_PATH_CODE_UNITS: usize = 4_096;
const MAX_PROVIDER_PATH_BYTES: usize = 4_096;
const MAX_PROVIDER_PATH_SEGMENTS: usize = 64;
const MAX_SOURCE_URI_CODE_UNITS: usize = 16 * 1024;
const MAX_SOURCE_URI_BYTES: usize = 16 * 1024;
const MAX_CONTENT_HASH_CODE_UNITS: usize = 256;
const MAX_GRAPH_NODES: usize = 2_000;
const MAX_FINDINGS: usize = 20_000;
const MAX_GRAPH_IDENTITY_BYTES: usize = 4 * 1024 * 1024;
const MAX_GRAPH_PAYLOAD_BYTES: usize = 16 * 1024 * 1024;
const MAX_TYPE_CODE_UNITS: usize = 256;
const MAX_TYPE_BYTES: usize = 256;
const MAX_TAG_CODE_UNITS: usize = 256;
const MAX_TAG_BYTES: usize = 256;
const MAX_TAGS_PER_CONCEPT: usize = 128;
const MAX_BUNDLE_TAG_ASSIGNMENTS: usize = 20_000;
const MAX_UNIQUE_GRAPH_TYPES: usize = 512;
const MAX_UNIQUE_GRAPH_TAGS: usize = 4_096;
const MAX_TITLE_CODE_UNITS: usize = 4_096;
const MAX_DESCRIPTION_CODE_UNITS: usize = 16_384;
const MAX_RESOURCE_CODE_UNITS: usize = 4_096;
const MAX_TIMESTAMP_CODE_UNITS: usize = 256;
const MAX_BUNDLE_LINKS: usize = 10_000;
const MAX_GRAPH_EDGES: usize = 10_000;
const MAX_LINK_TARGET_CODE_UNITS: usize = 2_048;
const MAX_LINK_TARGET_BYTES: usize = 2_048;
const MAX_LINK_LABEL_CODE_UNITS: usize = 512;
const MAX_LINK_LABEL_BYTES: usize = 512;

pub(crate) fn inspect_prevalidation_graph_error(bundle: &ParsedBundle) -> Option<String> {
    if bundle.revision > MAX_SAFE_INTEGER {
        return Some("The graph revision must be a non-negative safe integer.".to_owned());
    }
    if let Some(message) = bounded_string_error(
        &bundle.root_uri,
        MAX_SOURCE_URI_CODE_UNITS,
        MAX_SOURCE_URI_BYTES,
        "Bundle root URI",
    ) {
        return Some(message);
    }
    if bundle.concepts.len() > MAX_GRAPH_NODES {
        return Some(format!(
            "The bundle exceeds the {MAX_GRAPH_NODES}-node graph limit."
        ));
    }
    // Validation creates and then deduplicates one finding for every parse failure. Refuse an
    // input that is already guaranteed to exceed the canonical finding cap before allocating and
    // sorting those findings, while retaining the later failure-count error for duplicate input.
    let mut failure_findings = BTreeSet::new();
    for failure in &bundle.failures {
        failure_findings.insert((
            failure.uri.as_str(),
            failure.range.as_ref().map(|range| range.start.offset),
            failure.range.as_ref().map(|range| range.end.offset),
            parse_failure_rank(&failure.reason),
            failure.message.as_str(),
        ));
        if failure_findings.len() > MAX_FINDINGS {
            break;
        }
    }
    if failure_findings.len() > MAX_FINDINGS {
        return Some(format!(
            "The bundle exceeds the {MAX_FINDINGS}-finding limit."
        ));
    }
    None
}

pub(crate) fn bounded_graph_input_error(bundle: &ParsedBundle) -> Option<String> {
    if let Some(message) = inspect_prevalidation_graph_error(bundle) {
        return Some(message);
    }
    if bundle.findings.len() > MAX_FINDINGS {
        return Some(format!(
            "The bundle exceeds the {MAX_FINDINGS}-finding limit."
        ));
    }
    if bundle.failures.len() > MAX_FINDINGS {
        return Some(format!(
            "The bundle exceeds the {MAX_FINDINGS}-failure limit."
        ));
    }
    if bundle.failures.iter().any(|failure| {
        failure.reason == ParseFailureReason::ResourceLimit
            && failure.scope.as_deref() == Some("bundle")
    }) {
        return Some("A bundle-scoped resource failure prevents graph publication.".to_owned());
    }

    let mut identity_bytes = bundle.root_uri.len();
    if identity_bytes > MAX_GRAPH_IDENTITY_BYTES {
        return Some(identity_budget_error());
    }
    let mut failed_sources = BTreeSet::new();
    for failure in &bundle.failures {
        if let Some(message) = bounded_string_error(
            &failure.uri,
            MAX_SOURCE_URI_CODE_UNITS,
            MAX_SOURCE_URI_BYTES,
            "Parse failure URI",
        ) {
            return Some(message);
        }
        if !failure.bundle_path.is_empty()
            && let Some(message) = bounded_string_error(
                &failure.bundle_path,
                MAX_PROVIDER_PATH_CODE_UNITS,
                MAX_PROVIDER_PATH_BYTES,
                "Parse failure path",
            )
        {
            return Some(message);
        }
        if !add_identity_bytes(&mut identity_bytes, &failure.uri)
            || !add_identity_bytes(&mut identity_bytes, &failure.bundle_path)
        {
            return Some(identity_budget_error());
        }
        failed_sources.insert((failure.uri.as_str(), failure.bundle_path.as_str()));
    }
    for finding in &bundle.findings {
        if let Some(message) = bounded_string_error(
            &finding.uri,
            MAX_SOURCE_URI_CODE_UNITS,
            MAX_SOURCE_URI_BYTES,
            "Finding URI",
        ) {
            return Some(message);
        }
        if !add_identity_bytes(&mut identity_bytes, &finding.uri) {
            return Some(identity_budget_error());
        }
    }

    let mut link_count = 0usize;
    let mut tag_assignments = 0usize;
    let mut types = BTreeSet::new();
    let mut tags = BTreeSet::new();
    for concept in &bundle.concepts {
        if concept.id.is_empty() {
            continue;
        }
        if let Some(message) = graph_identity_error(&concept.id, "Concept ID") {
            return Some(message);
        }
        if let Some(message) = bounded_string_error(
            &concept.source.bundle_path,
            MAX_PROVIDER_PATH_CODE_UNITS,
            MAX_PROVIDER_PATH_BYTES,
            "Concept source path",
        ) {
            return Some(message);
        }
        if path_segment_count(&concept.source.bundle_path) > MAX_PROVIDER_PATH_SEGMENTS {
            return Some(format!(
                "A concept source path exceeds the {MAX_PROVIDER_PATH_SEGMENTS}-segment limit."
            ));
        }
        if let Some(message) = bounded_string_error(
            &concept.source.uri,
            MAX_SOURCE_URI_CODE_UNITS,
            MAX_SOURCE_URI_BYTES,
            "Concept source URI",
        ) {
            return Some(message);
        }
        if let Some(message) = bounded_string_error(
            &concept.source.content_hash,
            MAX_CONTENT_HASH_CODE_UNITS,
            MAX_CONTENT_HASH_CODE_UNITS * 3,
            "Concept content hash",
        ) {
            return Some(message);
        }
        if !add_identity_bytes(&mut identity_bytes, &concept.id)
            || !add_identity_bytes(&mut identity_bytes, &concept.source.bundle_path)
            || !add_identity_bytes(&mut identity_bytes, &concept.source.uri)
        {
            return Some(identity_budget_error());
        }

        if failed_sources.contains(&(
            concept.source.uri.as_str(),
            concept.source.bundle_path.as_str(),
        )) {
            continue;
        }
        if let Some(message) = bounded_string_error(
            &concept.r#type,
            MAX_TYPE_CODE_UNITS,
            MAX_TYPE_BYTES,
            "Concept type",
        ) {
            return Some(message);
        }
        for (value, limit, subject) in [
            (
                concept.title.as_deref(),
                MAX_TITLE_CODE_UNITS,
                "Concept title",
            ),
            (
                concept.description.as_deref(),
                MAX_DESCRIPTION_CODE_UNITS,
                "Concept description",
            ),
            (
                concept.resource.as_deref(),
                MAX_RESOURCE_CODE_UNITS,
                "Concept resource",
            ),
            (
                concept.timestamp.as_deref(),
                MAX_TIMESTAMP_CODE_UNITS,
                "Concept timestamp",
            ),
            (
                concept
                    .generated
                    .as_ref()
                    .and_then(|value| value.by.as_deref()),
                MAX_RESOURCE_CODE_UNITS,
                "Concept generator actor",
            ),
            (
                concept
                    .generated
                    .as_ref()
                    .and_then(|value| value.at.as_deref()),
                MAX_TIMESTAMP_CODE_UNITS,
                "Concept generation time",
            ),
            (
                concept.status.as_deref(),
                MAX_TYPE_CODE_UNITS,
                "Concept lifecycle status",
            ),
            (
                concept.stale_after.as_deref(),
                MAX_TIMESTAMP_CODE_UNITS,
                "Concept stale-after date",
            ),
            (
                concept.runtime.as_deref(),
                MAX_TYPE_CODE_UNITS,
                "Concept computation runtime",
            ),
            (
                concept.computation.as_deref(),
                MAX_RESOURCE_CODE_UNITS,
                "Concept computation path",
            ),
        ] {
            if let Some(value) = value
                && let Some(message) = bounded_string_error(value, limit, limit * 3, subject)
            {
                return Some(message);
            }
        }
        if concept.tags.len() > MAX_TAGS_PER_CONCEPT {
            return Some(format!(
                "A concept exceeds the {MAX_TAGS_PER_CONCEPT}-tag limit."
            ));
        }
        tag_assignments = tag_assignments.saturating_add(concept.tags.len());
        if tag_assignments > MAX_BUNDLE_TAG_ASSIGNMENTS {
            return Some(format!(
                "The bundle exceeds the {MAX_BUNDLE_TAG_ASSIGNMENTS}-tag assignment limit."
            ));
        }
        types.insert(concept.r#type.as_str());
        for tag in &concept.tags {
            if let Some(message) =
                bounded_string_error(tag, MAX_TAG_CODE_UNITS, MAX_TAG_BYTES, "Concept tag")
            {
                return Some(message);
            }
            tags.insert(tag.as_str());
        }
        if types.len() > MAX_UNIQUE_GRAPH_TYPES {
            return Some(format!(
                "The graph exceeds the {MAX_UNIQUE_GRAPH_TYPES}-type cardinality limit."
            ));
        }
        if tags.len() > MAX_UNIQUE_GRAPH_TAGS {
            return Some(format!(
                "The graph exceeds the {MAX_UNIQUE_GRAPH_TAGS}-tag cardinality limit."
            ));
        }

        for link in &concept.links {
            link_count = link_count.saturating_add(1);
            if link_count > MAX_BUNDLE_LINKS || link_count > MAX_GRAPH_EDGES {
                return Some(format!(
                    "The graph exceeds the {}-relationship limit.",
                    MAX_BUNDLE_LINKS.min(MAX_GRAPH_EDGES)
                ));
            }
            if link.source_id != concept.id {
                return Some("A graph link does not belong to its containing concept.".to_owned());
            }
            if let Some(message) = bounded_string_error(
                &link.raw_target,
                MAX_LINK_TARGET_CODE_UNITS,
                MAX_LINK_TARGET_BYTES,
                "Markdown link target",
            ) {
                return Some(message);
            }
            if let Some(message) = bounded_string_error(
                &link.label,
                MAX_LINK_LABEL_CODE_UNITS,
                MAX_LINK_LABEL_BYTES,
                "Markdown link label",
            ) {
                return Some(message);
            }
            if let Some(target_id) = link.target_id.as_deref() {
                if target_id.is_empty() {
                    return Some("A link target ID must not be empty.".to_owned());
                }
                if let Some(message) = graph_identity_error(target_id, "Link target ID") {
                    return Some(message);
                }
            }
            if matches!(
                link.classification,
                LinkClassification::Broken | LinkClassification::Internal
            ) && link.raw_target.is_empty()
            {
                return Some("An internal or broken-link target must not be empty.".to_owned());
            }
            if let Some(message) = source_range_error(&link.range) {
                return Some(message);
            }
        }
    }
    None
}

fn graph_payload_size_error(payload: &GraphPayload) -> Option<String> {
    let mut writer = CappedWriter::new(MAX_GRAPH_PAYLOAD_BYTES);
    if serde_json::to_writer(&mut writer, payload).is_err() || writer.exceeded {
        return Some(format!(
            "The derived graph exceeds the {MAX_GRAPH_PAYLOAD_BYTES}-byte serialized payload limit."
        ));
    }
    None
}

fn bounded_string_error(
    value: &str,
    max_code_units: usize,
    max_bytes: usize,
    subject: &str,
) -> Option<String> {
    if value.encode_utf16().count() > max_code_units || value.len() > max_bytes {
        Some(format!(
            "{subject} exceeds its {max_code_units}-code-unit or {max_bytes}-byte limit."
        ))
    } else {
        None
    }
}

fn graph_identity_error(value: &str, subject: &str) -> Option<String> {
    if value.is_empty() {
        return None;
    }
    bounded_string_error(
        value,
        MAX_PROVIDER_PATH_CODE_UNITS,
        MAX_PROVIDER_PATH_BYTES,
        subject,
    )
    .or_else(|| {
        (path_segment_count(value) > MAX_PROVIDER_PATH_SEGMENTS)
            .then(|| format!("{subject} exceeds the {MAX_PROVIDER_PATH_SEGMENTS}-segment limit."))
    })
}

fn path_segment_count(value: &str) -> usize {
    value.bytes().filter(|byte| *byte == b'/').count() + 1
}

fn add_identity_bytes(total: &mut usize, value: &str) -> bool {
    *total = total.saturating_add(value.len());
    *total <= MAX_GRAPH_IDENTITY_BYTES
}

fn identity_budget_error() -> String {
    format!("Graph identities exceed the {MAX_GRAPH_IDENTITY_BYTES}-byte aggregate limit.")
}

fn parse_failure_rank(reason: &ParseFailureReason) -> u8 {
    match reason {
        ParseFailureReason::Decode => 0,
        ParseFailureReason::Frontmatter => 1,
        ParseFailureReason::Markdown => 2,
        ParseFailureReason::Read => 3,
        ParseFailureReason::ResourceLimit => 4,
    }
}

fn source_range_error(range: &SourceRange) -> Option<String> {
    for position in [&range.start, &range.end] {
        if position.offset as u64 > MAX_SAFE_INTEGER
            || position.line as u64 > MAX_SAFE_INTEGER
            || position.character as u64 > MAX_SAFE_INTEGER
        {
            return Some("A graph source range contains an invalid position.".to_owned());
        }
    }
    (range.start.offset > range.end.offset)
        .then(|| "A graph source range ends before it starts.".to_owned())
}

struct CappedWriter {
    remaining: usize,
    exceeded: bool,
}

impl CappedWriter {
    fn new(limit: usize) -> Self {
        Self {
            remaining: limit,
            exceeded: false,
        }
    }
}

impl std::io::Write for CappedWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.remaining {
            self.exceeded = true;
            return Err(std::io::Error::other("graph payload limit exceeded"));
        }
        self.remaining -= bytes.len();
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn build_graph_payload(bundle: &ParsedBundle) -> GraphPayload {
    let concept_ids = bundle
        .concepts
        .iter()
        .map(|concept| concept.id.as_str())
        .collect::<BTreeSet<_>>();
    let failed_paths = bundle
        .failures
        .iter()
        .map(|failure| (failure.uri.as_str(), failure.bundle_path.as_str()))
        .collect::<BTreeSet<_>>();
    let mut connected = BTreeSet::new();
    let mut edges_data = Vec::new();
    let mut broken_links = Vec::new();
    let mut backlinks: BTreeMap<String, Vec<String>> = bundle
        .concepts
        .iter()
        .map(|concept| (concept.id.clone(), Vec::new()))
        .collect();
    let mut broken_count: BTreeMap<String, usize> = BTreeMap::new();

    for concept in &bundle.concepts {
        if failed_paths.contains(&(
            concept.source.uri.as_str(),
            concept.source.bundle_path.as_str(),
        )) {
            continue;
        }
        for link in &concept.links {
            if link.classification == LinkClassification::Internal
                && let Some(target) = &link.target_id
                && concept_ids.contains(target.as_str())
            {
                connected.insert(concept.id.as_str());
                connected.insert(target.as_str());
                edges_data.push((concept.id.clone(), target.clone(), link.range.clone()));
                backlinks
                    .entry(target.clone())
                    .or_default()
                    .push(concept.id.clone());
            } else if link.classification == LinkClassification::Broken {
                *broken_count.entry(concept.id.clone()).or_default() += 1;
                broken_links.push(BrokenLinkPresentation {
                    source_id: concept.id.clone(),
                    label: link.label.clone(),
                    raw_target: link.raw_target.clone(),
                    source_range: link.range.clone(),
                });
            }
        }
    }
    edges_data.sort_by(|left, right| {
        compare_utf16(&left.0, &right.0)
            .then_with(|| left.2.start.offset.cmp(&right.2.start.offset))
            .then_with(|| compare_utf16(&left.1, &right.1))
    });
    let edges = edges_data
        .into_iter()
        .enumerate()
        .map(|(index, (source, target, source_range))| GraphEdge {
            id: format!("edge:{}", radix36(index)),
            source,
            target,
            source_range,
        })
        .collect::<Vec<_>>();

    for values in backlinks.values_mut() {
        values.sort_by(|left, right| compare_utf16(left, right));
        values.dedup();
    }
    broken_links.sort_by(|left, right| {
        compare_utf16(&left.source_id, &right.source_id).then_with(|| {
            left.source_range
                .start
                .offset
                .cmp(&right.source_range.start.offset)
        })
    });

    let mut type_counts = BTreeMap::new();
    let mut tag_counts = BTreeMap::new();
    let mut nodes = Vec::new();
    for concept in &bundle.concepts {
        if !failed_paths.contains(&(
            concept.source.uri.as_str(),
            concept.source.bundle_path.as_str(),
        )) {
            *type_counts.entry(concept.r#type.clone()).or_default() += 1;
            for tag in concept.tags.iter().collect::<BTreeSet<_>>() {
                *tag_counts.entry(tag.clone()).or_default() += 1;
            }
        }
        let source_failed = failed_paths.contains(&(
            concept.source.uri.as_str(),
            concept.source.bundle_path.as_str(),
        ));
        nodes.push(GraphNode {
            id: concept.id.clone(),
            source_failed: source_failed.then_some(true),
            r#type: if source_failed {
                String::new()
            } else {
                concept.r#type.clone()
            },
            title: (!source_failed).then(|| concept.title.clone()).flatten(),
            description: (!source_failed)
                .then(|| concept.description.clone())
                .flatten(),
            resource: (!source_failed).then(|| concept.resource.clone()).flatten(),
            tags: if source_failed {
                Vec::new()
            } else {
                concept.tags.clone()
            },
            timestamp: (!source_failed && !concept.frontmatter.raw.contains_key("generated"))
                .then(|| concept.timestamp.clone())
                .flatten(),
            generated_by: (!source_failed)
                .then(|| {
                    concept
                        .generated
                        .as_ref()
                        .and_then(|generated| generated.by.clone())
                })
                .flatten(),
            generated_at: (!source_failed)
                .then(|| {
                    concept
                        .generated
                        .as_ref()
                        .and_then(|generated| generated.at.clone())
                })
                .flatten(),
            trust_tier: (!source_failed).then(|| concept.trust_tier.clone()),
            status: if source_failed {
                None
            } else if let Some(status) = concept.status.clone() {
                Some(status)
            } else if concept.frontmatter.raw.contains_key("status") {
                None
            } else {
                Some("stable".to_owned())
            },
            stale_after: (!source_failed)
                .then(|| concept.stale_after.clone())
                .flatten(),
            source_count: (!source_failed).then_some(concept.sources.len()),
            runtime: (!source_failed).then(|| concept.runtime.clone()).flatten(),
            computation: (!source_failed)
                .then(|| concept.computation.clone())
                .flatten(),
            orphan: !connected.contains(concept.id.as_str()) && !source_failed,
            broken_link_count: if source_failed {
                0
            } else {
                *broken_count.get(&concept.id).unwrap_or(&0)
            },
        });
    }
    nodes.sort_by(|left, right| compare_utf16(&left.id, &right.id));
    let statistics = GraphStatistics {
        concept_count: nodes.len(),
        edge_count: edges.len(),
        orphan_count: nodes.iter().filter(|node| node.orphan).count(),
        broken_link_count: broken_links.len(),
        type_counts,
        tag_counts,
    };
    GraphPayload {
        protocol_version: 1,
        revision: bundle.revision,
        nodes,
        edges,
        backlinks,
        broken_links,
        statistics,
    }
}

/// Build a graph only when the parsed bundle and serialized payload both fit the
/// shared publication envelope.
pub fn build_graph_payload_checked(bundle: &ParsedBundle) -> Result<GraphPayload, String> {
    if let Some(message) = bounded_graph_input_error(bundle) {
        return Err(message);
    }
    let payload = build_graph_payload(bundle);
    if let Some(message) = graph_payload_size_error(&payload) {
        return Err(message);
    }
    Ok(payload)
}

fn compare_utf16(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn radix36(mut value: usize) -> String {
    if value == 0 {
        return "0".to_owned();
    }
    let mut digits = Vec::new();
    while value > 0 {
        let digit = value % 36;
        digits.push(if digit < 10 {
            (b'0' + digit as u8) as char
        } else {
            (b'a' + (digit - 10) as u8) as char
        });
        value /= 36;
    }
    digits.into_iter().rev().collect()
}
