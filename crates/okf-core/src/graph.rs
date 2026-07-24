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
        .map(|failure| failure.bundle_path.as_str())
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
        left.0
            .cmp(&right.0)
            .then_with(|| left.2.start.offset.cmp(&right.2.start.offset))
            .then_with(|| left.1.cmp(&right.1))
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
        values.sort();
        values.dedup();
    }
    broken_links.sort_by(|left, right| {
        left.source_id.cmp(&right.source_id).then_with(|| {
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
        if !failed_paths.contains(concept.source.bundle_path.as_str()) {
            *type_counts.entry(concept.r#type.clone()).or_default() += 1;
            for tag in &concept.tags {
                *tag_counts.entry(tag.clone()).or_default() += 1;
            }
        }
        nodes.push(GraphNode {
            id: concept.id.clone(),
            source_failed: failed_paths
                .contains(concept.source.bundle_path.as_str())
                .then_some(true),
            r#type: concept.r#type.clone(),
            title: concept.title.clone(),
            description: concept.description.clone(),
            resource: concept.resource.clone(),
            tags: concept.tags.clone(),
            timestamp: concept.timestamp.clone(),
            orphan: !connected.contains(concept.id.as_str())
                && !failed_paths.contains(concept.source.bundle_path.as_str()),
            broken_link_count: *broken_count.get(&concept.id).unwrap_or(&0),
        });
    }
    nodes.sort_by(|left, right| left.id.cmp(&right.id));
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
