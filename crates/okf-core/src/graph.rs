use crate::{
    BrokenLinkPresentation, GraphEdge, GraphNode, GraphPayload, GraphStatistics,
    LinkClassification, ParsedBundle,
};
use std::collections::{BTreeMap, BTreeSet};

pub fn build_graph_payload(bundle: &ParsedBundle) -> GraphPayload {
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
