use crate::ParsedBundle;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BundlePreset {
    Minimal,
    SoftwareProject,
    DataAnalytics,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum IndexMode {
    Missing,
    All,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentTarget {
    Agents,
    Skill,
    Both,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConceptTemplateInput {
    pub template: String,
    pub relative_path: String,
    pub r#type: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub timestamp: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedFile {
    pub relative_path: String,
    pub encoding: &'static str,
    pub content: String,
}

struct Starter {
    path: &'static str,
    template: &'static str,
    kind: &'static str,
    title: &'static str,
    description: &'static str,
    tags: &'static [&'static str],
}

#[derive(Clone)]
struct IndexEntry {
    label: String,
    path: String,
    description: Option<String>,
}

const SOFTWARE: &[Starter] = &[
    Starter {
        path: "project-overview.md",
        template: "generic-concept",
        kind: "project-overview",
        title: "Project overview",
        description: "The product purpose, users, scope, and important constraints.",
        tags: &["project", "overview"],
    },
    Starter {
        path: "architecture/system-overview.md",
        template: "generic-concept",
        kind: "architecture",
        title: "System overview",
        description: "The system boundaries, components, and important data flows.",
        tags: &["architecture"],
    },
    Starter {
        path: "decisions/initial-context.md",
        template: "decision",
        kind: "decision",
        title: "Initial context",
        description: "The initial constraints and decisions that shape this project.",
        tags: &["decision", "context"],
    },
    Starter {
        path: "playbooks/development.md",
        template: "playbook",
        kind: "playbook",
        title: "Development",
        description: "The repeatable workflow for developing and verifying changes.",
        tags: &["development", "playbook"],
    },
];

const DATA: &[Starter] = &[
    Starter {
        path: "data-landscape.md",
        template: "generic-concept",
        kind: "data-landscape",
        title: "Data landscape",
        description: "The important data domains, producers, consumers, and constraints.",
        tags: &["data", "overview"],
    },
    Starter {
        path: "datasets/example-dataset.md",
        template: "data-table",
        kind: "dataset",
        title: "Example dataset",
        description: "Replace this starter with a durable description of a real dataset.",
        tags: &["dataset"],
    },
    Starter {
        path: "metrics/example-metric.md",
        template: "metric",
        kind: "metric",
        title: "Example metric",
        description: "Replace this starter with a precise definition of a real metric.",
        tags: &["metric"],
    },
    Starter {
        path: "playbooks/data-quality.md",
        template: "playbook",
        kind: "playbook",
        title: "Data quality",
        description: "The repeatable workflow for detecting and resolving data-quality problems.",
        tags: &["data-quality", "playbook"],
    },
];

pub fn bundle_preset_files(preset: BundlePreset, timestamp: &str) -> Vec<RenderedFile> {
    let starters = match preset {
        BundlePreset::Minimal => &[][..],
        BundlePreset::SoftwareProject => SOFTWARE,
        BundlePreset::DataAnalytics => DATA,
    };
    let concept_files = starters
        .iter()
        .map(|starter| {
            concept_template_file(&ConceptTemplateInput {
                template: starter.template.to_owned(),
                relative_path: starter.path.to_owned(),
                r#type: starter.kind.to_owned(),
                title: starter.title.to_owned(),
                description: Some(starter.description.to_owned()),
                tags: starter
                    .tags
                    .iter()
                    .map(|value| (*value).to_owned())
                    .collect(),
                timestamp: Some(timestamp.to_owned()),
            })
        })
        .collect::<Vec<_>>();
    let mut directories = BTreeSet::from([String::new()]);
    for file in &concept_files {
        if let Some((directory, _)) = file.relative_path.rsplit_once('/') {
            directories.insert(directory.to_owned());
        }
    }
    let indexes = directories
        .into_iter()
        .map(|directory| {
            let entries = index_entries_for_starters(&directory, starters);
            (
                if directory.is_empty() {
                    "index.md".to_owned()
                } else {
                    format!("{directory}/index.md")
                },
                render_index(&directory, &entries),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let concepts = concept_files
        .into_iter()
        .map(|file| (file.relative_path.clone(), file))
        .collect::<BTreeMap<_, _>>();
    let paths: &[&str] = match preset {
        BundlePreset::Minimal => &["index.md"],
        BundlePreset::SoftwareProject => &[
            "index.md",
            "project-overview.md",
            "architecture/index.md",
            "architecture/system-overview.md",
            "decisions/index.md",
            "decisions/initial-context.md",
            "playbooks/index.md",
            "playbooks/development.md",
        ],
        BundlePreset::DataAnalytics => &[
            "index.md",
            "data-landscape.md",
            "datasets/index.md",
            "datasets/example-dataset.md",
            "metrics/index.md",
            "metrics/example-metric.md",
            "playbooks/index.md",
            "playbooks/data-quality.md",
        ],
    };
    paths
        .iter()
        .map(|path| {
            concepts
                .get(*path)
                .cloned()
                .unwrap_or_else(|| RenderedFile {
                    relative_path: (*path).to_owned(),
                    encoding: "utf8",
                    content: indexes.get(*path).cloned().unwrap_or_default(),
                })
        })
        .collect()
}

pub fn concept_template_file(input: &ConceptTemplateInput) -> RenderedFile {
    let path = normalize_concept_path(&input.relative_path);
    let title = one_line(&input.title);
    let mut frontmatter = vec![
        "---".to_owned(),
        format!("type: {}", yaml_string(input.r#type.trim())),
        format!("title: {}", yaml_string(&title)),
    ];
    if let Some(description) = input
        .description
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        frontmatter.push(format!("description: {}", yaml_string(description)));
    }
    if !input.tags.is_empty() {
        frontmatter.push("tags:".to_owned());
        frontmatter.extend(
            input
                .tags
                .iter()
                .map(|tag| format!("  - {}", yaml_string(tag.trim()))),
        );
    }
    if let Some(timestamp) = input.timestamp.as_deref() {
        frontmatter.push(format!("timestamp: {}", yaml_string(timestamp)));
    }
    frontmatter.push("---".to_owned());
    frontmatter.push(String::new());
    frontmatter.push(format!("# {title}"));
    frontmatter.push(String::new());
    if let Some(description) = &input.description
        && !description.trim().is_empty()
    {
        frontmatter.push(description.trim().to_owned());
        frontmatter.push(String::new());
    }
    frontmatter.extend(
        body_sections(&input.template)
            .iter()
            .map(|value| (*value).to_owned()),
    );
    RenderedFile {
        relative_path: path,
        encoding: "utf8",
        content: format!("{}\n", frontmatter.join("\n")),
    }
}

pub fn index_files(bundle: &ParsedBundle, mode: IndexMode) -> Vec<RenderedFile> {
    let existing = bundle
        .reserved_documents
        .iter()
        .filter(|document| document.reserved_kind == "index")
        .map(|document| document.source.bundle_path.as_str())
        .collect::<BTreeSet<_>>();
    let concept_files = bundle
        .concepts
        .iter()
        .map(|concept| RenderedFile {
            relative_path: concept.source.bundle_path.clone(),
            encoding: "utf8",
            content: String::new(),
        })
        .collect::<Vec<_>>();
    let mut directories = BTreeSet::from([String::new()]);
    for concept in &bundle.concepts {
        if let Some((directory, _)) = concept.source.bundle_path.rsplit_once('/') {
            directories.insert(directory.to_owned());
        }
    }
    let by_path = bundle
        .concepts
        .iter()
        .map(|concept| (concept.source.bundle_path.as_str(), concept))
        .collect::<BTreeMap<_, _>>();
    directories
        .into_iter()
        .filter_map(|directory| {
            let path = if directory.is_empty() {
                "index.md".to_owned()
            } else {
                format!("{directory}/index.md")
            };
            if matches!(mode, IndexMode::Missing) && existing.contains(path.as_str()) {
                return None;
            }
            let prefix = if directory.is_empty() {
                String::new()
            } else {
                format!("{directory}/")
            };
            let entries = index_entries_for(&directory, &concept_files)
                .into_iter()
                .map(|mut entry| {
                    let full_path = format!("{prefix}{}", entry.path);
                    if let Some(concept) = by_path.get(full_path.as_str()) {
                        entry.label = concept.title.clone().unwrap_or(entry.label);
                        entry.description.clone_from(&concept.description);
                    }
                    entry
                })
                .collect::<Vec<_>>();
            Some(RenderedFile {
                relative_path: path,
                encoding: "utf8",
                content: render_index(&directory, &entries),
            })
        })
        .collect()
}

pub fn agent_files(target: AgentTarget, bundle_path: &str) -> Vec<RenderedFile> {
    let bundle = if bundle_path == "." || bundle_path.is_empty() {
        "./".to_owned()
    } else {
        format!("{}/", bundle_path.trim_matches('/').replace('\\', "/"))
    };
    let agents = RenderedFile {
        relative_path: "AGENTS.md".to_owned(),
        encoding: "utf8",
        content: format!(
            "{}\n",
            [
                "<!-- okf-workbench:start -->".to_owned(),
                "## OKF knowledge".to_owned(),
                String::new(),
                format!("- The OKF bundle is located at `{bundle}`."),
                format!(
                    "- Read `{}index.md` before tasks that require project-wide context.",
                    bundle
                ),
                "- Update the relevant concept when a change affects durable project knowledge."
                    .to_owned(),
                "- When an `okf` executable is available for a local bundle, prefer it for validation, new-concept planning, and managed-index updates; review `--check` output before `--apply`."
                    .to_owned(),
                "- Preserve unknown YAML frontmatter fields.".to_owned(),
                "- Use bundle-relative Markdown links between concepts.".to_owned(),
                "- Do not add speculative or temporary information to the bundle.".to_owned(),
                "<!-- okf-workbench:end -->".to_owned(),
            ]
            .join("\n")
        ),
    };
    let skill = RenderedFile {
        relative_path: ".agents/skills/maintain-okf-knowledge/SKILL.md".to_owned(),
        encoding: "utf8",
        content: format!(
            "---\nname: maintain-okf-knowledge\ndescription: Maintain this repository's OKF knowledge bundle. Use when creating or updating durable project knowledge, recording decisions, repairing links, regenerating indexes, or reviewing knowledge quality.\n---\n\n# Maintain OKF knowledge\n\nThe repository's OKF bundle is located at `{bundle}`.\n\n## Workflow\n\n1. Read `{bundle}index.md` and follow its links before changing durable project knowledge.\n2. Search for an existing concept and update it instead of creating a duplicate.\n3. Create a new concept only when no existing concept has the same durable purpose.\n4. Add bundle-relative Markdown links to related concepts.\n5. Regenerate managed indexes and run both conformance and curation checks.\n\n## CLI-assisted workflow\n\nThe `okf` CLI is optional. Prefer it when an `okf` executable is available in the agent's terminal and the bundle has a local filesystem path. Otherwise use OKF Workbench editor commands and follow the document rules below.\n\nReplace `<bundle-root>` with a correctly shell-quoted local path for the bundle at `{bundle}`.\n\n```text\nokf validate <bundle-root> --format json\nokf new <bundle-root> --template decision --title \"<title>\" --check\nokf index <bundle-root> --mode missing --check\n```\n\nInspect every reported path and change before rerunning a write command with `--apply` instead of `--check`. Edit existing concept Markdown directly while preserving unknown frontmatter.\n\n## Concept documents\n\n- Every concept is a non-reserved `.md` file with YAML frontmatter.\n- `type` is required and may be any non-empty value; do not enforce a closed type list.\n- `title`, `description`, `resource`, `tags`, and `timestamp` are optional or recommended fields.\n- Preserve every unknown frontmatter field and tolerate unknown concept types.\n- Reuse a stable concept ID: its bundle-relative POSIX path without the `.md` suffix.\n\n## Links and timestamps\n\n- Use `/path/to/concept.md` for bundle-root links or relative paths from the current document.\n- Keep internal relationships as ordinary directed Markdown links; do not invent relationship types.\n- Use ISO 8601 date-times with an explicit `Z` or numeric offset when recording a timestamp.\n- Do not treat a broken link as a conformance failure; repair it as a curation problem.\n\n## Indexes and checks\n\n- Let OKF Workbench update only the explicit `okf-workbench:index` managed region in each `index.md`.\n- Do not hand-edit or duplicate managed-region markers.\n- Fix conformance errors before relying on the bundle for interoperability.\n- Review curation warnings for missing metadata, orphan concepts, duplicate resources, and suspicious timestamps.\n- Keep speculative notes and short-lived task state outside the durable bundle.\n"
        ),
    };
    match target {
        AgentTarget::Agents => vec![agents],
        AgentTarget::Skill => vec![skill],
        AgentTarget::Both => vec![agents, skill],
    }
}

fn body_sections(template: &str) -> &'static [&'static str] {
    match template {
        "decision" => &[
            "## Status",
            "",
            "Proposed",
            "",
            "## Context",
            "",
            "Describe the forces that require a decision.",
            "",
            "## Decision",
            "",
            "Record the chosen direction.",
            "",
            "## Consequences",
            "",
            "Record the important trade-offs and follow-up work.",
        ],
        "metric" => &[
            "## Definition",
            "",
            "Define what the metric measures and why it matters.",
            "",
            "## Calculation",
            "",
            "Describe the formula, dimensions, and source data.",
            "",
            "## Interpretation",
            "",
            "Explain expected ranges and important caveats.",
        ],
        "api-endpoint" => &[
            "## Contract",
            "",
            "Document the method, path, request, and response.",
            "",
            "## Authentication",
            "",
            "Describe access requirements without recording secrets.",
            "",
            "## Failure modes",
            "",
            "List actionable error behavior and retry expectations.",
        ],
        "data-table" => &[
            "## Purpose",
            "",
            "Describe the table's business or analytical purpose.",
            "",
            "## Grain and keys",
            "",
            "Record row grain, primary keys, and important relationships.",
            "",
            "## Columns",
            "",
            "Document important columns and quality constraints.",
        ],
        "playbook" => &[
            "## When to use",
            "",
            "Describe the trigger and prerequisites.",
            "",
            "## Steps",
            "",
            "1. Add the first repeatable step.",
            "",
            "## Verification",
            "",
            "Describe how to confirm the procedure succeeded.",
        ],
        "reference" => &[
            "## Reference",
            "",
            "Summarize the durable information supplied by the referenced resource.",
            "",
            "## Relevance",
            "",
            "Explain when and why maintainers should consult it.",
        ],
        _ => &[
            "## Summary",
            "",
            "Describe the durable knowledge captured by this concept.",
            "",
            "## Details",
            "",
            "Add relevant context, constraints, and links.",
        ],
    }
}

fn index_entries_for(directory: &str, files: &[RenderedFile]) -> Vec<IndexEntry> {
    let prefix = if directory.is_empty() {
        String::new()
    } else {
        format!("{directory}/")
    };
    let mut entries = BTreeMap::new();
    for file in files {
        let Some(rest) = file.relative_path.strip_prefix(&prefix) else {
            continue;
        };
        if rest == "index.md" {
            continue;
        }
        if let Some((child, _)) = rest.split_once('/') {
            entries.insert(
                format!("1:{child}"),
                IndexEntry {
                    label: child.to_owned(),
                    path: format!("{child}/"),
                    description: None,
                },
            );
        } else {
            entries.insert(
                format!("0:{rest}"),
                IndexEntry {
                    label: rest.trim_end_matches(".md").to_owned(),
                    path: rest.to_owned(),
                    description: None,
                },
            );
        }
    }
    entries.into_values().collect()
}

fn index_entries_for_starters(directory: &str, starters: &[Starter]) -> Vec<IndexEntry> {
    let files = starters
        .iter()
        .map(|starter| RenderedFile {
            relative_path: starter.path.to_owned(),
            encoding: "utf8",
            content: String::new(),
        })
        .collect::<Vec<_>>();
    let metadata = starters
        .iter()
        .map(|starter| (starter.path, starter))
        .collect::<BTreeMap<_, _>>();
    index_entries_for(directory, &files)
        .into_iter()
        .map(|mut entry| {
            let prefix = if directory.is_empty() {
                String::new()
            } else {
                format!("{directory}/")
            };
            let full_path = format!("{prefix}{}", entry.path);
            if let Some(starter) = metadata.get(full_path.as_str()) {
                entry.label = starter.title.to_owned();
                entry.description = Some(starter.description.to_owned());
            }
            entry
        })
        .collect()
}

fn render_index(directory: &str, entries: &[IndexEntry]) -> String {
    let mut lines = Vec::new();
    if directory.is_empty() {
        lines.extend([
            "---".to_owned(),
            "okf_version: \"0.1\"".to_owned(),
            "---".to_owned(),
        ]);
    }
    lines.extend([
        "<!-- okf-workbench:index:start -->".to_owned(),
        "## Contents".to_owned(),
        String::new(),
    ]);
    for entry in entries {
        let encoded = encode_markdown_path(&entry.path);
        let line = format!("- [{}](./{})", escape_label(&entry.label), encoded);
        lines.push(match entry.description.as_deref() {
            Some(description) if !description.is_empty() => {
                format!("{line} - {}", escape_label(description))
            }
            _ => line,
        });
    }
    lines.push("<!-- okf-workbench:index:end -->".to_owned());
    format!("{}\n", lines.join("\n"))
}

fn normalize_concept_path(path: &str) -> String {
    let mut value = path.replace('\\', "/").trim_start_matches('/').to_owned();
    if !value.ends_with(".md") {
        value.push_str(".md");
    }
    value
}

fn one_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn yaml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned())
}

fn escape_label(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]")
}

fn encode_markdown_path(value: &str) -> String {
    let mut output = String::new();
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'.' | b'_' | b'~' | b'/') {
            output.push(*byte as char);
        } else {
            output.push('%');
            output.push_str(&format!("{byte:02X}"));
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimal_bundle_is_deterministic() {
        assert_eq!(
            bundle_preset_files(BundlePreset::Minimal, "2026-07-24T00:00:00Z"),
            bundle_preset_files(BundlePreset::Minimal, "2026-07-24T00:00:00Z")
        );
        assert_eq!(
            bundle_preset_files(BundlePreset::Minimal, "2026-07-24T00:00:00Z")[0].relative_path,
            "index.md"
        );
    }

    #[test]
    fn concept_path_is_portable() {
        let file = concept_template_file(&ConceptTemplateInput {
            template: "generic-concept".to_owned(),
            relative_path: "folder\\日本語".to_owned(),
            r#type: "custom".to_owned(),
            title: "A title".to_owned(),
            description: None,
            tags: vec![],
            timestamp: None,
        });
        assert_eq!(file.relative_path, "folder/日本語.md");
    }

    #[test]
    fn concept_heading_is_separated_from_frontmatter() {
        let file = concept_template_file(&ConceptTemplateInput {
            template: "generic-concept".to_owned(),
            relative_path: "concept.md".to_owned(),
            r#type: "concept".to_owned(),
            title: "A title".to_owned(),
            description: None,
            tags: vec![],
            timestamp: None,
        });
        assert!(file.content.contains("\n---\n\n# A title\n"));
    }
}
