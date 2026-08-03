use crate::ParsedBundle;
use crate::parser::{
    MAX_PROVIDER_PATH_BYTES, MAX_PROVIDER_PATH_CODE_UNITS, MAX_PROVIDER_PATH_SEGMENTS,
    has_control_character, percent_decode,
};
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

pub fn bundle_preset_files_checked(
    preset: BundlePreset,
    timestamp: &str,
) -> Result<Vec<RenderedFile>, String> {
    if ecmascript_trim(timestamp).is_empty() {
        return Err("Bundle rendering requires a caller-supplied timestamp.".to_owned());
    }
    if !matches!(preset, BundlePreset::Minimal) {
        validate_template_timestamp(timestamp)?;
    }
    Ok(bundle_preset_files(preset, timestamp))
}

pub fn concept_template_file(input: &ConceptTemplateInput) -> RenderedFile {
    let path = normalize_concept_path(&input.relative_path);
    let title = one_line(&input.title);
    let description = input
        .description
        .as_deref()
        .map(|value| value.replace("\r\n", "\n").replace('\r', "\n"));
    let mut frontmatter = vec![
        "---".to_owned(),
        format!("type: {}", yaml_string(&input.r#type)),
        format!("title: {}", yaml_string(&title)),
    ];
    if let Some(description) = description
        .as_deref()
        .filter(|value| !ecmascript_trim(value).is_empty())
    {
        frontmatter.push(format!("description: {}", yaml_string(description)));
    }
    if !input.tags.is_empty() {
        frontmatter.push("tags:".to_owned());
        frontmatter.extend(
            input
                .tags
                .iter()
                .map(|tag| format!("  - {}", yaml_string(tag))),
        );
    }
    if let Some(timestamp) = input.timestamp.as_deref() {
        frontmatter.push("generated:".to_owned());
        frontmatter.push("  by: \"process:okf-workbench\"".to_owned());
        frontmatter.push(format!("  at: {}", yaml_string(timestamp)));
    }
    if input.template == "attested-computation" {
        frontmatter.push("runtime: \"replace-with-runtime\"".to_owned());
    }
    frontmatter.push("---".to_owned());
    frontmatter.push(String::new());
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

pub fn concept_template_file_checked(input: &ConceptTemplateInput) -> Result<RenderedFile, String> {
    let mut normalized = input.clone();
    normalized.relative_path = validate_concept_path(&input.relative_path)?;
    validate_concept_metadata(input)?;
    Ok(concept_template_file(&normalized))
}

fn validate_concept_metadata(input: &ConceptTemplateInput) -> Result<(), String> {
    const TEMPLATES: &[&str] = &[
        "generic-concept",
        "decision",
        "metric",
        "api-endpoint",
        "data-table",
        "playbook",
        "reference",
        "attested-computation",
    ];
    if !TEMPLATES.contains(&input.template.as_str()) {
        return Err(format!("Unknown concept template: {:?}.", input.template));
    }
    if ecmascript_trim(&input.r#type).is_empty() {
        return Err(
            "A concept type must contain at least one non-whitespace character.".to_owned(),
        );
    }
    validate_metadata_text(&input.r#type, "Concept type", 256, Some(256))?;
    if has_control_character(&input.r#type) {
        return Err(
            "Concept type contains a control character that cannot be used safely by graph filters."
                .to_owned(),
        );
    }

    let title = one_line(&input.title);
    if title.is_empty() {
        return Err(
            "A concept title must contain at least one non-whitespace character.".to_owned(),
        );
    }
    validate_metadata_text(&title, "Concept title", 4_096, None)?;

    if let Some(description) = input.description.as_deref() {
        let normalized = description.replace("\r\n", "\n").replace('\r', "\n");
        validate_metadata_text(&normalized, "Concept description", 16_384, None)?;
    }

    if input.tags.len() > 128 {
        return Err("Concept metadata contains more than 128 tags.".to_owned());
    }
    for tag in &input.tags {
        if ecmascript_trim(tag).is_empty() {
            return Err("Concept tags cannot be empty or whitespace-only.".to_owned());
        }
        validate_metadata_text(tag, "Concept tag", 256, Some(256))?;
        if has_control_character(tag) {
            return Err(
                "Concept tag contains a control character that cannot be used safely by graph filters."
                    .to_owned(),
            );
        }
    }

    if let Some(timestamp) = input.timestamp.as_deref() {
        if ecmascript_trim(timestamp).is_empty() {
            return Err("An injected timestamp must be non-empty text.".to_owned());
        }
        validate_metadata_text(timestamp, "Concept timestamp", 256, None)?;
        if has_control_character(timestamp) {
            return Err(
                "Concept timestamp contains a control character that cannot be retained safely."
                    .to_owned(),
            );
        }
    }
    Ok(())
}

fn validate_metadata_text(
    value: &str,
    subject: &str,
    max_code_units: usize,
    max_bytes: Option<usize>,
) -> Result<(), String> {
    if value.encode_utf16().count() > max_code_units {
        return Err(format!(
            "{subject} exceeds the {max_code_units}-code-unit safety limit."
        ));
    }
    if max_bytes.is_some_and(|limit| value.len() > limit) {
        return Err(format!(
            "{subject} exceeds the {}-byte UTF-8 safety limit.",
            max_bytes.unwrap_or_default()
        ));
    }
    Ok(())
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
    let mut directories = directories.into_iter().collect::<Vec<_>>();
    directories.sort_by(|left, right| compare_utf16(left, right));
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
                        if let Some(title) = concept.title.as_deref().map(one_line)
                            && !title.is_empty()
                        {
                            entry.label = title;
                        }
                        entry.description = concept
                            .description
                            .as_deref()
                            .map(one_line)
                            .filter(|description| !description.is_empty());
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
    let bundle_code = inline_code(&bundle);
    let index_code = inline_code(&format!("{bundle}index.md"));
    let agents = RenderedFile {
        relative_path: "AGENTS.md".to_owned(),
        encoding: "utf8",
        content: format!(
            "{}\n",
            [
                "<!-- okf-workbench:start -->".to_owned(),
                "## OKF knowledge".to_owned(),
                String::new(),
                format!("- The OKF bundle is located at {bundle_code}."),
                format!("- Read {index_code} before tasks that require project-wide context."),
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
            "---\nname: maintain-okf-knowledge\ndescription: Maintain this repository's OKF knowledge bundle. Use when creating or updating durable project knowledge, recording decisions, repairing links, regenerating indexes, or reviewing knowledge quality.\n---\n\n# Maintain OKF knowledge\n\nThe repository's OKF bundle is located at {bundle_code}.\n\n## Workflow\n\n1. Read {index_code} and follow its links before changing durable project knowledge.\n2. Search for an existing concept and update it instead of creating a duplicate.\n3. Create a new concept only when no existing concept has the same durable purpose.\n4. Add bundle-relative Markdown links to related concepts.\n5. Regenerate managed indexes and run both conformance and curation checks.\n\n## CLI-assisted workflow\n\nThe `okf` CLI is optional. Prefer it when an `okf` executable is available in the agent's terminal and the bundle has a local filesystem path. Otherwise use OKF Workbench editor commands and follow the document rules below.\n\nReplace `<bundle-root>` with a correctly shell-quoted local path for the bundle at {bundle_code}.\n\n```text\nokf validate <bundle-root> --format json\nokf new <bundle-root> --template decision --title \"<title>\" --check\nokf index <bundle-root> --mode missing --check\n```\n\nInspect every reported path and change before rerunning a write command with `--apply` instead of `--check`. Edit existing concept Markdown directly while preserving unknown frontmatter.\n\n## Concept documents\n\n- Every concept is a non-reserved `.md` file with YAML frontmatter.\n- `type` is required and may be any non-empty value; do not enforce a closed type list.\n- `title`, `description`, `resource`, and `tags` are optional or recommended fields.\n- Use `generated`, `verified`, `status`, `stale_after`, and `sources` for OKF v0.2 provenance, trust, and lifecycle metadata.\n- Read legacy `timestamp` only as the v0.1 fallback when `generated` is absent.\n- Preserve every unknown frontmatter field and tolerate unknown concept types.\n- Reuse a stable concept ID: its bundle-relative POSIX path without the `.md` suffix.\n\n## Links, provenance, and time\n\n- Use `/path/to/concept.md` for bundle-root links or relative paths from the current document.\n- Keep internal relationships as ordinary directed Markdown links; do not invent relationship types.\n- Use ISO 8601 date-times with an explicit `Z` or numeric offset for `generated.at` and `verified[].at`.\n- Treat `type: Attested Computation` as a declarative contract; do not execute its executor or attester without a separate trusted runtime.\n- Do not treat a broken link as a conformance failure; repair it as a curation problem.\n\n## Indexes and checks\n\n- Let OKF Workbench update only the explicit `okf-workbench:index` managed region in each `index.md`.\n- Do not hand-edit or duplicate managed-region markers.\n- Fix conformance errors before relying on the bundle for interoperability.\n- Review curation warnings for missing metadata, orphan concepts, duplicate resources, malformed trust families, suspicious times, and stale concepts.\n- Keep speculative notes and short-lived task state outside the durable bundle.\n"
        ),
    };
    match target {
        AgentTarget::Agents => vec![agents],
        AgentTarget::Skill => vec![skill],
        AgentTarget::Both => vec![agents, skill],
    }
}

pub fn agent_files_checked(
    target: AgentTarget,
    bundle_path: &str,
) -> Result<Vec<RenderedFile>, String> {
    let normalized = validate_bundle_directory(bundle_path)?;
    Ok(agent_files(target, &normalized))
}

pub fn agent_files_provider_checked(
    target: AgentTarget,
    bundle_path: &str,
) -> Result<Vec<RenderedFile>, String> {
    let preserved = validate_provider_bundle_directory(bundle_path)?;
    Ok(agent_files(target, &preserved))
}

fn validate_template_timestamp(timestamp: &str) -> Result<(), String> {
    if ecmascript_trim(timestamp).is_empty() {
        return Err("Bundle rendering requires a caller-supplied timestamp.".to_owned());
    }
    validate_metadata_text(timestamp, "Concept timestamp", 256, None)?;
    if has_control_character(timestamp) {
        return Err(
            "Concept timestamp contains a control character that cannot be retained safely."
                .to_owned(),
        );
    }
    Ok(())
}

fn is_windows_device_name(segment: &str) -> bool {
    let basename = segment
        .split_once('.')
        .map_or(segment, |(basename, _)| basename)
        .to_ascii_uppercase();
    matches!(basename.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            basename.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
        })
}

fn is_portable_generated_segment(segment: &str) -> bool {
    segment.len() <= 255
        && !segment
            .bytes()
            .any(|byte| matches!(byte, b'<' | b'>' | b':' | b'"' | b'|' | b'?' | b'*'))
        && !segment.ends_with('.')
        && !segment.ends_with(' ')
        && !is_windows_device_name(segment)
}

fn validate_bundle_directory(path: &str) -> Result<String, String> {
    if !bounded_relative_path(path, true) {
        return Err("The path exceeds the supported relative-path limit.".to_owned());
    }
    let slash_normalized = path.replace('\\', "/");
    let mut candidate = slash_normalized.as_str();
    while let Some(remainder) = candidate.strip_prefix("./") {
        candidate = remainder;
    }
    while candidate.len() > 1 && candidate.ends_with('/') {
        candidate = &candidate[..candidate.len() - 1];
    }
    let candidate = if candidate.is_empty() && !ecmascript_trim(path).is_empty() {
        "."
    } else {
        candidate
    };
    if candidate == "." {
        return Ok(".".to_owned());
    }
    if ecmascript_trim(candidate).is_empty() {
        return Err("A non-empty relative path is required.".to_owned());
    }
    let mut decoded = candidate.to_owned();
    let mut stable = false;
    for _ in 0..16 {
        if has_control_character(&decoded) {
            return Err(format!("The path {path:?} contains a control character."));
        }
        let next = percent_decode(&decoded)
            .ok_or_else(|| format!("The path {path:?} contains invalid percent encoding."))?;
        if next == decoded {
            stable = true;
            break;
        }
        decoded = next.replace('\\', "/");
    }
    if !stable {
        return Err(format!(
            "The path {path:?} contains excessive nested percent encoding."
        ));
    }
    if !bounded_relative_path(&decoded, false) {
        return Err("The path exceeds the supported relative-path limit.".to_owned());
    }
    if decoded == "." {
        return Ok(decoded);
    }
    if decoded.starts_with('/') || decoded.contains(':') {
        return Err(format!("The path {path:?} is absolute or URI-like."));
    }
    if decoded
        .split('/')
        .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
    {
        return Err(format!(
            "The path {path:?} contains an empty, current, or parent segment."
        ));
    }
    if decoded
        .split('/')
        .any(|segment| !is_portable_generated_segment(segment))
    {
        return Err(format!(
            "The path {path:?} contains a component that is not portable across supported filesystems."
        ));
    }
    Ok(decoded)
}

fn validate_provider_bundle_directory(path: &str) -> Result<String, String> {
    if path.is_empty() {
        return Err("A non-empty provider-relative path is required.".to_owned());
    }
    if !bounded_relative_path(path, false) {
        return Err("The provider path exceeds the supported relative-path limit.".to_owned());
    }
    if has_control_character(path) {
        return Err(format!(
            "The provider path {path:?} contains a control character."
        ));
    }
    if path.contains('\\') {
        return Err(format!(
            "The provider path {path:?} must use POSIX separators."
        ));
    }
    let windows_absolute = path.as_bytes().get(1) == Some(&b':')
        && path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
        && (path.len() == 2 || path.as_bytes().get(2) == Some(&b'/'));
    if path.starts_with('/') || windows_absolute {
        return Err(format!("The provider path {path:?} is absolute."));
    }
    if path == "." {
        return Ok(path.to_owned());
    }
    if path
        .split('/')
        .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
    {
        return Err(format!(
            "The provider path {path:?} contains an empty, current, or parent segment."
        ));
    }
    Ok(path.to_owned())
}

fn bounded_relative_path(path: &str, backslash_is_separator: bool) -> bool {
    path.encode_utf16().count() <= MAX_PROVIDER_PATH_CODE_UNITS
        && path.len() <= MAX_PROVIDER_PATH_BYTES
        && path
            .chars()
            .filter(|character| *character == '/' || (backslash_is_separator && *character == '\\'))
            .count()
            < MAX_PROVIDER_PATH_SEGMENTS
}

fn inline_code(value: &str) -> String {
    let maximum = value
        .split(|character| character != '`')
        .map(str::len)
        .max()
        .unwrap_or_default();
    let delimiter = "`".repeat(std::cmp::max(1, maximum + 1));
    let pad = value.starts_with(['`', ' ']) || value.ends_with(['`', ' ']);
    format!(
        "{delimiter}{}{value}{}{delimiter}",
        if pad { " " } else { "" },
        if pad { " " } else { "" }
    )
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
        "attested-computation" => &[
            "# Computation",
            "",
            "```text",
            "Replace this fence with the sanctioned computation.",
            "```",
            "",
            "## Contract notes",
            "",
            "Document the runtime, typed parameters, executor receipt, and deterministic attester.",
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
    let mut entries = entries.into_values().collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        left.path
            .ends_with('/')
            .cmp(&right.path.ends_with('/'))
            .then_with(|| compare_utf16(&left.path, &right.path))
    });
    entries
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
            "okf_version: \"0.2\"".to_owned(),
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

fn validate_concept_path(path: &str) -> Result<String, String> {
    fn bounded(value: &str, backslash_is_separator: bool) -> bool {
        value.encode_utf16().count() <= MAX_PROVIDER_PATH_CODE_UNITS
            && value.len() <= MAX_PROVIDER_PATH_BYTES
            && value
                .chars()
                .filter(|character| {
                    *character == '/' || (backslash_is_separator && *character == '\\')
                })
                .count()
                < MAX_PROVIDER_PATH_SEGMENTS
    }

    if !bounded(path, true) {
        return Err("The path exceeds the supported relative-path limit.".to_owned());
    }
    if ecmascript_trim(path).is_empty() {
        return Err("A non-empty relative path is required.".to_owned());
    }
    let mut candidate = path.replace('\\', "/");
    let mut stable = false;
    for _ in 0..16 {
        if has_control_character(&candidate) {
            return Err(format!("The path {path:?} contains a control character."));
        }
        let decoded = percent_decode(&candidate)
            .ok_or_else(|| format!("The path {path:?} contains invalid percent encoding."))?;
        if decoded == candidate {
            stable = true;
            break;
        }
        candidate = decoded.replace('\\', "/");
    }
    if !stable {
        return Err(format!(
            "The path {path:?} contains excessive nested percent encoding."
        ));
    }
    if !bounded(&candidate, false) {
        return Err("The path exceeds the supported relative-path limit.".to_owned());
    }
    if candidate.starts_with('/') || candidate.contains(':') {
        return Err(format!("The path {path:?} is absolute or URI-like."));
    }
    if candidate
        .split('/')
        .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
    {
        return Err(format!(
            "The path {path:?} contains an empty, current, or parent segment."
        ));
    }
    if candidate
        .split('/')
        .any(|segment| !is_portable_generated_segment(segment))
    {
        return Err(format!(
            "The path {path:?} contains a component that is not portable across supported filesystems."
        ));
    }
    let file_name = candidate.rsplit('/').next().unwrap_or_default();
    if matches!(
        file_name.to_ascii_lowercase().as_str(),
        "index.md" | "log.md"
    ) {
        return Err(format!(
            "{path:?} is reserved by OKF and cannot be a concept path."
        ));
    }
    if !candidate.ends_with(".md") {
        return Err(format!("The path {path:?} must end with .md."));
    }
    if file_name.strip_suffix(".md").is_some_and(str::is_empty) {
        return Err(format!(
            "The concept path {path:?} must include a filename before the .md extension."
        ));
    }
    Ok(candidate)
}

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

fn compare_utf16(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn one_line(value: &str) -> String {
    let mut output = String::new();
    let mut pending_space = false;
    for character in value.chars() {
        if is_ecmascript_whitespace(character) {
            pending_space = !output.is_empty();
        } else {
            if pending_space {
                output.push(' ');
                pending_space = false;
            }
            output.push(character);
        }
    }
    output
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
    fn checked_paths_reject_windows_alternate_data_streams() {
        let input = ConceptTemplateInput {
            template: "generic-concept".to_owned(),
            relative_path: "folder/file.md:payload".to_owned(),
            r#type: "custom".to_owned(),
            title: "A title".to_owned(),
            description: None,
            tags: vec![],
            timestamp: None,
        };
        assert!(concept_template_file_checked(&input).is_err());

        let mut encoded = input;
        encoded.relative_path = "folder/file%3Astream.md".to_owned();
        assert!(concept_template_file_checked(&encoded).is_err());

        assert!(agent_files_checked(AgentTarget::Both, "folder:stream").is_err());
        let provider_files =
            agent_files_provider_checked(AgentTarget::Both, "folder:stream").unwrap();
        assert_eq!(provider_files.len(), 2);
        assert!(
            provider_files
                .iter()
                .all(|file| file.content.contains("folder:stream"))
        );
    }

    #[test]
    fn checked_generated_paths_reject_non_portable_windows_components() {
        for relative_path in [
            "CON.md",
            "aux.md",
            "COM1.md",
            "folder/name?.md",
            "folder/a|b.md",
            "folder/name%3F.md",
            "folder/trailing .md ",
            "folder/trailing.",
        ] {
            let input = ConceptTemplateInput {
                template: "generic-concept".to_owned(),
                relative_path: relative_path.to_owned(),
                r#type: "custom".to_owned(),
                title: "A title".to_owned(),
                description: None,
                tags: vec![],
                timestamp: None,
            };
            assert!(
                concept_template_file_checked(&input).is_err(),
                "{relative_path:?}"
            );
        }

        let mut oversized = ConceptTemplateInput {
            template: "generic-concept".to_owned(),
            relative_path: format!("{}.md", "a".repeat(253)),
            r#type: "custom".to_owned(),
            title: "A title".to_owned(),
            description: None,
            tags: vec![],
            timestamp: None,
        };
        assert!(concept_template_file_checked(&oversized).is_err());
        oversized.relative_path = format!("{}.md", "a".repeat(252));
        assert!(concept_template_file_checked(&oversized).is_ok());

        assert!(agent_files_checked(AgentTarget::Both, "folder/PRN").is_err());
        assert!(agent_files_checked(AgentTarget::Both, "folder/name*").is_err());
        assert!(agent_files_provider_checked(AgentTarget::Both, "folder/PRN").is_ok());
    }

    #[test]
    fn concept_title_is_not_duplicated_as_a_body_heading() {
        let file = concept_template_file(&ConceptTemplateInput {
            template: "generic-concept".to_owned(),
            relative_path: "concept.md".to_owned(),
            r#type: "concept".to_owned(),
            title: "A title".to_owned(),
            description: Some("# Alternate title\n[Link](target.md)".to_owned()),
            tags: vec![],
            timestamp: None,
        });
        assert!(
            file.content
                .contains("description: \"# Alternate title\\n[Link](target.md)\"\n")
        );
        assert!(file.content.contains("\n---\n\n## Summary\n"));
        assert!(!file.content.contains("\n# A title\n"));
        assert!(!file.content.contains("\n# Alternate title\n"));
        assert!(!file.content.contains("\n[Link](target.md)\n"));
    }
}
