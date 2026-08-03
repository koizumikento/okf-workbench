use okf_core::{
    BundleDocumentInput, DocumentContent, ParseBundleInput, RenderedFile, parse_bundle,
};
use serde::Serialize;
#[cfg(not(unix))]
use std::fs::OpenOptions;
#[cfg(unix)]
use std::{
    ffi::{OsStr, OsString},
    fs::File,
    io::Read,
    os::unix::fs::MetadataExt,
    sync::atomic::{AtomicU64, Ordering},
};
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
};
#[cfg(not(unix))]
use tempfile::NamedTempFile;
use walkdir::WalkDir;

#[cfg(unix)]
use rustix::{
    fs::{AtFlags, Mode, OFlags, mkdirat, open, openat, renameat, unlinkat},
    io::Errno,
};

const MAX_DOCUMENTS: usize = 2_000;
const MAX_DOCUMENT_BYTES: u64 = 320 * 1024 + 16;

#[derive(Clone, Copy, Debug)]
pub enum PlanMode {
    CreateOnly,
    MergeIndexes {
        ensure_root_version: bool,
        update_existing_regions: bool,
    },
    MergeAgent,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedChange {
    #[serde(skip)]
    pub target: PathBuf,
    pub relative_path: String,
    pub operation: &'static str,
    pub byte_length: usize,
    #[serde(skip)]
    pub content: String,
    #[serde(skip)]
    expected_content: Option<String>,
}

pub fn load_bundle(root: &Path) -> Result<ParseBundleInput, String> {
    ensure_safe_root(root)?;
    let root = root
        .canonicalize()
        .map_err(|error| format!("cannot open bundle root {}: {error}", root.display()))?;
    ensure_safe_root(&root)?;
    let mut documents = Vec::new();
    for entry in WalkDir::new(&root)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| entry.path() == root || entry.file_name() != ".agents")
    {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_type().is_symlink() {
            return Err(format!(
                "bundle traversal refused symbolic link {}",
                entry.path().display()
            ));
        }
        if !entry.file_type().is_file()
            || entry.path().extension().and_then(|value| value.to_str()) != Some("md")
        {
            continue;
        }
        if documents.len() >= MAX_DOCUMENTS {
            return Err("bundle contains more than 2,000 Markdown documents".to_owned());
        }
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        if metadata.len() > MAX_DOCUMENT_BYTES {
            return Err(format!(
                "{} exceeds the bounded document size",
                entry.path().display()
            ));
        }
        let bytes = fs::read(entry.path()).map_err(|error| error.to_string())?;
        let relative = entry
            .path()
            .strip_prefix(&root)
            .map_err(|error| error.to_string())?
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if relative == "AGENTS.md" {
            continue;
        }
        documents.push(BundleDocumentInput {
            uri: file_uri(entry.path()),
            bundle_path: relative,
            content: Some(DocumentContent::Bytes(bytes)),
            content_hash: None,
            identity_only_failure: None,
        });
    }
    Ok(ParseBundleInput {
        root_uri: file_uri(&root),
        revision: 1,
        documents,
    })
}

pub fn load_root_index(root: &Path) -> Result<ParseBundleInput, String> {
    ensure_safe_root(root)?;
    let root = root
        .canonicalize()
        .map_err(|error| format!("cannot open bundle root {}: {error}", root.display()))?;
    ensure_safe_root(&root)?;
    let path = root.join("index.md");
    let mut documents = Vec::new();
    match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(format!(
                    "write refused unsafe root index {}",
                    path.display()
                ));
            }
            if metadata.len() > MAX_DOCUMENT_BYTES {
                return Err(format!(
                    "{} exceeds the bounded document size",
                    path.display()
                ));
            }
            documents.push(BundleDocumentInput {
                uri: file_uri(&path),
                bundle_path: "index.md".to_owned(),
                content: Some(DocumentContent::Bytes(
                    fs::read(&path).map_err(|error| error.to_string())?,
                )),
                content_hash: None,
                identity_only_failure: None,
            });
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    Ok(ParseBundleInput {
        root_uri: file_uri(&root),
        revision: 1,
        documents,
    })
}

pub fn plan_files(
    root: &Path,
    files: Vec<RenderedFile>,
    mode: PlanMode,
) -> Result<Vec<PlannedChange>, String> {
    if root.exists() {
        ensure_safe_root(root)?;
    } else {
        ensure_plannable_root(root)?;
    }
    let mut plan = Vec::new();
    for file in files {
        validate_relative_path(&file.relative_path)?;
        let target = root.join(&file.relative_path);
        ensure_contained(root, &target)?;
        ensure_safe_parent_chain(root, &target)?;
        let existing = match fs::symlink_metadata(&target) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(format!("unsafe existing target {}", target.display()));
                }
                Some(fs::read_to_string(&target).map_err(|error| error.to_string())?)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.to_string()),
        };
        let content = match (&existing, mode, file.relative_path.as_str()) {
            (Some(existing), PlanMode::CreateOnly, _) if existing != &file.content => {
                return Err(format!(
                    "{} already exists; no file was changed",
                    target.display()
                ));
            }
            (
                Some(existing),
                PlanMode::MergeIndexes {
                    ensure_root_version,
                    update_existing_regions,
                },
                path,
            ) if path.ends_with("index.md") => {
                let merged = if update_existing_regions {
                    merge_region(
                        existing,
                        &file.content,
                        "<!-- okf-workbench:index:start -->",
                        "<!-- okf-workbench:index:end -->",
                    )?
                } else {
                    existing.clone()
                };
                if path == "index.md" && ensure_root_version {
                    insert_root_version(&merged)?
                } else {
                    merged
                }
            }
            (Some(existing), PlanMode::MergeAgent, "AGENTS.md") => merge_region(
                existing,
                &file.content,
                "<!-- okf-workbench:start -->",
                "<!-- okf-workbench:end -->",
            )?,
            (Some(_), PlanMode::MergeAgent, _) => file.content,
            (Some(_), _, _) => file.content,
            (None, _, _) => file.content,
        };
        if existing.as_deref() == Some(content.as_str()) {
            continue;
        }
        plan.push(PlannedChange {
            target,
            relative_path: file.relative_path,
            operation: if existing.is_some() {
                "update"
            } else {
                "create"
            },
            byte_length: content.len(),
            content,
            expected_content: existing,
        });
    }
    plan.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(plan)
}

fn insert_root_version(existing: &str) -> Result<String, String> {
    let bom_len = if existing.starts_with('\u{feff}') {
        3
    } else {
        0
    };
    let content = &existing[bom_len..];
    let Some((opening_end, source_end, eol)) = frontmatter_source_bounds(existing, bom_len) else {
        let eol = preferred_line_ending(content);
        let candidate = format!(
            "{}---{eol}okf_version: \"0.2\"{eol}---{eol}{content}",
            &existing[..bom_len]
        );
        validate_root_version_insertion(existing, &candidate).map_err(|error| {
            format!(
                "cannot add `okf_version` safely to index.md using {eol:?} line endings: {error}"
            )
        })?;
        return Ok(candidate);
    };

    let frontmatter = &existing[opening_end..source_end];
    let candidate = if let Some(flow_start) = root_flow_mapping_start(frontmatter) {
        let flow_offset = opening_end + flow_start;
        let content_offset = flow_offset + 1;
        let separator = if existing[content_offset..source_end]
            .trim_start()
            .starts_with('}')
        {
            ""
        } else {
            ","
        };
        let property_separator = if root_flow_mapping_has_inline_properties(frontmatter, flow_start)
        {
            eol
        } else {
            ""
        };
        format!(
            "{}{property_separator}{{okf_version: \"0.2\"{separator}{}",
            &existing[..flow_offset],
            &existing[content_offset..]
        )
    } else {
        let (offset, insertion) =
            root_block_mapping_insertion(existing, opening_end, source_end, eol);
        format!("{}{insertion}{}", &existing[..offset], &existing[offset..])
    };
    validate_root_version_insertion(existing, &candidate).map_err(|error| {
        format!("cannot add `okf_version` safely to index.md using {eol:?} line endings: {error}")
    })?;
    Ok(candidate)
}

fn root_block_mapping_insertion(
    source: &str,
    start: usize,
    end: usize,
    default_eol: &'static str,
) -> (usize, String) {
    for (line_start, content_end, _) in line_bounds(source, start, end) {
        let line = &source[line_start..content_end];
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') || is_standalone_node_property(trimmed) {
            continue;
        }
        let indent = &line[..line.len() - trimmed.len()];
        return (
            line_start,
            format!("{indent}okf_version: \"0.2\"{default_eol}"),
        );
    }
    (end, format!("okf_version: \"0.2\"{default_eol}"))
}

fn is_standalone_node_property(line: &str) -> bool {
    let comment_start = line.char_indices().find_map(|(index, character)| {
        (character == '#'
            && line[..index]
                .chars()
                .next_back()
                .is_some_and(char::is_whitespace))
        .then_some(index)
    });
    let content = comment_start
        .map_or(line, |start| &line[..start])
        .trim_end();
    !content.is_empty()
        && content
            .split_whitespace()
            .all(|token| token.starts_with('!') || token.starts_with('&'))
}

fn root_flow_mapping_start(source: &str) -> Option<usize> {
    let mut cursor = 0usize;
    loop {
        while source[cursor..]
            .chars()
            .next()
            .is_some_and(char::is_whitespace)
        {
            cursor += source[cursor..].chars().next()?.len_utf8();
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

fn root_flow_mapping_has_inline_properties(source: &str, flow_start: usize) -> bool {
    let line_start = source[..flow_start]
        .rfind(['\r', '\n'])
        .map_or(0, |offset| offset + 1);
    !source[line_start..flow_start].trim().is_empty()
}

fn frontmatter_source_bounds(content: &str, start: usize) -> Option<(usize, usize, &'static str)> {
    let opening_end = if content[start..].starts_with("---\r\n") {
        start + 5
    } else if content[start..].starts_with("---\n") || content[start..].starts_with("---\r") {
        start + 4
    } else {
        return None;
    };
    let eol = if content[start + 3..].starts_with("\r\n") {
        "\r\n"
    } else if content.as_bytes().get(start + 3) == Some(&b'\r') {
        "\r"
    } else {
        "\n"
    };
    let source_end = line_bounds(content, opening_end, content.len())
        .into_iter()
        .find_map(|(line_start, content_end, _)| {
            (content[line_start..content_end].trim() == "---").then_some(line_start)
        })?;
    Some((opening_end, source_end, eol))
}

fn line_bounds(content: &str, start: usize, end: usize) -> Vec<(usize, usize, usize)> {
    let mut lines = Vec::new();
    let mut line_start = start;
    while line_start < end {
        let mut content_end = line_start;
        while content_end < end && !matches!(content.as_bytes()[content_end], b'\r' | b'\n') {
            content_end += 1;
        }
        let line_end = if content.as_bytes().get(content_end) == Some(&b'\r')
            && content.as_bytes().get(content_end + 1) == Some(&b'\n')
        {
            content_end + 2
        } else if content_end < end {
            content_end + 1
        } else {
            content_end
        };
        lines.push((line_start, content_end, line_end));
        line_start = line_end;
    }
    lines
}

fn preferred_line_ending(content: &str) -> &'static str {
    for (index, byte) in content.bytes().enumerate() {
        match byte {
            b'\r' if content.as_bytes().get(index + 1) == Some(&b'\n') => return "\r\n",
            b'\r' => return "\r",
            b'\n' => return "\n",
            _ => {}
        }
    }
    "\n"
}

fn validate_root_version_insertion(existing: &str, candidate: &str) -> Result<(), String> {
    let before = root_frontmatter(existing)?;
    let mut after = root_frontmatter(candidate)?;
    if after.remove("okf_version") != Some(serde_json::Value::String("0.2".to_owned())) {
        return Err(
            "the proposed root does not declare the exact string version \"0.2\"".to_owned(),
        );
    }
    if after != before {
        return Err("the proposed root changes existing frontmatter fields".to_owned());
    }
    Ok(())
}

fn root_frontmatter(content: &str) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let bundle = parse_bundle(ParseBundleInput {
        root_uri: "file:///okf-version-proposal".to_owned(),
        revision: 1,
        documents: vec![BundleDocumentInput {
            uri: "file:///okf-version-proposal/index.md".to_owned(),
            bundle_path: "index.md".to_owned(),
            content: Some(DocumentContent::Text(content.to_owned())),
            content_hash: None,
            identity_only_failure: None,
        }],
    });
    if let Some(failure) = bundle.failures.first() {
        return Err(failure.message.clone());
    }
    Ok(bundle
        .reserved_documents
        .iter()
        .find(|document| document.source.bundle_path == "index.md")
        .and_then(|document| document.frontmatter.as_ref())
        .map(|frontmatter| frontmatter.raw.clone())
        .unwrap_or_default())
}

pub fn apply_plan(root: &Path, plan: &[PlannedChange]) -> Result<(), String> {
    if !root.exists() {
        create_safe_root(root)?;
    }
    ensure_safe_root(root)?;

    #[cfg(unix)]
    {
        apply_plan_anchored(root, plan)
    }

    #[cfg(not(unix))]
    {
        apply_plan_ambient(root, plan)
    }
}

#[cfg(not(unix))]
fn apply_plan_ambient(root: &Path, plan: &[PlannedChange]) -> Result<(), String> {
    for change in plan {
        ensure_contained(root, &change.target)?;
        ensure_safe_parent_chain(root, &change.target)?;
        verify_unchanged(change)?;
    }
    for change in plan {
        let parent = change
            .target
            .parent()
            .ok_or_else(|| format!("{} has no parent", change.target.display()))?;
        if !parent.exists() {
            create_safe_root(parent)?;
        }
        ensure_safe_parent_chain(root, &change.target)?;
        verify_unchanged(change)?;
        if change.operation == "create" {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&change.target)
                .map_err(|error| format!("cannot create {}: {error}", change.target.display()))?;
            file.write_all(change.content.as_bytes())
                .and_then(|_| file.sync_all())
                .map_err(|error| error.to_string())?;
        } else {
            let mut temporary = NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
            temporary
                .write_all(change.content.as_bytes())
                .map_err(|error| error.to_string())?;
            let permissions = fs::symlink_metadata(&change.target)
                .map_err(|error| {
                    format!(
                        "cannot preserve permissions for {}: {error}",
                        change.target.display()
                    )
                })?
                .permissions();
            temporary
                .as_file()
                .set_permissions(permissions)
                .and_then(|_| temporary.as_file().sync_all())
                .map_err(|error| error.to_string())?;
            temporary
                .persist(&change.target)
                .map_err(|error| error.error.to_string())?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn apply_plan_anchored(root: &Path, plan: &[PlannedChange]) -> Result<(), String> {
    let root_directory = open_anchored_root(root)?;
    for change in plan {
        ensure_contained(root, &change.target)?;
        validate_relative_path(&change.relative_path)?;
        preflight_anchored_change(&root_directory, change)?;
    }
    for change in plan {
        apply_anchored_change(&root_directory, change)?;
    }
    Ok(())
}

#[cfg(unix)]
fn open_anchored_root(root: &Path) -> Result<File, String> {
    let before = fs::metadata(root)
        .map_err(|error| format!("cannot inspect {}: {error}", root.display()))?;
    let directory = File::from(
        open(
            root,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| format!("cannot anchor bundle root {}: {error}", root.display()))?,
    );
    ensure_safe_root(root)?;
    let after = fs::metadata(root)
        .map_err(|error| format!("cannot revalidate {}: {error}", root.display()))?;
    let anchored = directory
        .metadata()
        .map_err(|error| format!("cannot inspect anchored root {}: {error}", root.display()))?;
    if (before.dev(), before.ino()) != (after.dev(), after.ino())
        || (after.dev(), after.ino()) != (anchored.dev(), anchored.ino())
    {
        return Err(format!(
            "bundle root {} changed while preparing the write",
            root.display()
        ));
    }
    Ok(directory)
}

#[cfg(unix)]
fn open_anchored_parent(
    root: &File,
    relative_path: &str,
    create_missing: bool,
) -> Result<Option<(File, OsString)>, String> {
    let mut components = Path::new(relative_path)
        .components()
        .map(|component| match component {
            Component::Normal(value) => Ok(value.to_os_string()),
            _ => Err(format!("generated path {relative_path:?} is not relative")),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let leaf = components
        .pop()
        .ok_or_else(|| format!("generated path {relative_path:?} has no filename"))?;
    let mut directory = File::from(
        openat(
            root,
            ".",
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| format!("cannot duplicate the anchored bundle root: {error}"))?,
    );
    for component in components {
        let opened = openat(
            &directory,
            &component,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        );
        let next = match opened {
            Ok(next) => next,
            Err(Errno::NOENT) if !create_missing => return Ok(None),
            Err(Errno::NOENT) => {
                match mkdirat(&directory, &component, Mode::from_raw_mode(0o755)) {
                    Ok(()) | Err(Errno::EXIST) => {}
                    Err(error) => {
                        return Err(format!(
                            "cannot create parent component {component:?}: {error}"
                        ));
                    }
                }
                openat(
                    &directory,
                    &component,
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|error| {
                    format!("cannot open parent component {component:?} safely: {error}")
                })?
            }
            Err(error) => {
                return Err(format!(
                    "cannot open parent component {component:?} safely: {error}"
                ));
            }
        };
        directory = File::from(next);
    }
    Ok(Some((directory, leaf)))
}

#[cfg(unix)]
fn apply_anchored_change(root: &File, change: &PlannedChange) -> Result<(), String> {
    let (parent, leaf) = open_anchored_parent(root, &change.relative_path, true)?
        .ok_or_else(|| "cannot create the generated parent chain".to_owned())?;
    match &change.expected_content {
        None => create_anchored_file(&parent, &leaf, change),
        Some(expected) => replace_anchored_file(&parent, &leaf, expected, change),
    }
}

#[cfg(unix)]
fn preflight_anchored_change(root: &File, change: &PlannedChange) -> Result<(), String> {
    let Some((parent, leaf)) = open_anchored_parent(root, &change.relative_path, false)? else {
        return if change.expected_content.is_none() {
            Ok(())
        } else {
            Err(format!(
                "{} disappeared after planning; no write was attempted",
                change.target.display()
            ))
        };
    };
    match &change.expected_content {
        None => match openat(
            &parent,
            &leaf,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Err(Errno::NOENT) => Ok(()),
            Ok(_) => Err(format!(
                "{} appeared after planning; no replacement was attempted",
                change.target.display()
            )),
            Err(error) => Err(format!(
                "cannot revalidate {}: {error}",
                change.target.display()
            )),
        },
        Some(expected) => {
            let mut existing = File::from(
                openat(
                    &parent,
                    &leaf,
                    OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|error| {
                    format!("cannot revalidate {}: {error}", change.target.display())
                })?,
            );
            if !existing
                .metadata()
                .map_err(|error| error.to_string())?
                .is_file()
            {
                return Err(format!(
                    "{} changed to an unsafe target after planning",
                    change.target.display()
                ));
            }
            let mut current = String::new();
            existing
                .read_to_string(&mut current)
                .map_err(|error| error.to_string())?;
            if current == *expected {
                Ok(())
            } else {
                Err(format!(
                    "{} changed after planning; no replacement was attempted",
                    change.target.display()
                ))
            }
        }
    }
}

#[cfg(unix)]
fn create_anchored_file(parent: &File, leaf: &OsStr, change: &PlannedChange) -> Result<(), String> {
    let mut file = File::from(
        openat(
            parent,
            leaf,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_raw_mode(0o666),
        )
        .map_err(|error| {
            format!(
                "{} appeared after planning; no replacement was attempted: {error}",
                change.target.display()
            )
        })?,
    );
    file.write_all(change.content.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|error| error.to_string())
}

#[cfg(unix)]
fn replace_anchored_file(
    parent: &File,
    leaf: &OsStr,
    expected: &str,
    change: &PlannedChange,
) -> Result<(), String> {
    let mut existing = File::from(
        openat(
            parent,
            leaf,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| {
            format!(
                "cannot revalidate {} through its anchored parent: {error}",
                change.target.display()
            )
        })?,
    );
    if !existing
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err(format!(
            "{} changed to an unsafe target after planning",
            change.target.display()
        ));
    }
    let mut current = String::new();
    existing
        .read_to_string(&mut current)
        .map_err(|error| error.to_string())?;
    if current != expected {
        return Err(format!(
            "{} changed after planning; no replacement was attempted",
            change.target.display()
        ));
    }

    let (temporary_name, mut temporary) = create_anchored_temporary(parent)?;
    let result = (|| {
        temporary
            .write_all(change.content.as_bytes())
            .map_err(|error| error.to_string())?;
        preserve_replacement_metadata(&existing, &temporary)?;
        temporary.sync_all().map_err(|error| error.to_string())?;
        renameat(parent, &temporary_name, parent, leaf)
            .map_err(|error| format!("cannot replace {}: {error}", change.target.display()))
    })();
    if result.is_err() {
        let _ = unlinkat(parent, &temporary_name, AtFlags::empty());
    }
    result
}

#[cfg(unix)]
fn create_anchored_temporary(parent: &File) -> Result<(OsString, File), String> {
    static NEXT_TEMPORARY: AtomicU64 = AtomicU64::new(0);
    for _ in 0..128 {
        let sequence = NEXT_TEMPORARY.fetch_add(1, Ordering::Relaxed);
        let name = OsString::from(format!(
            ".okf-workbench-{}-{sequence}.tmp",
            std::process::id()
        ));
        match openat(
            parent,
            &name,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_raw_mode(0o600),
        ) {
            Ok(file) => return Ok((name, File::from(file))),
            Err(Errno::EXIST) => {}
            Err(error) => return Err(format!("cannot reserve temporary file name: {error}")),
        }
    }
    Err("cannot reserve a unique anchored temporary file name".to_owned())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn preserve_replacement_metadata(existing: &File, temporary: &File) -> Result<(), String> {
    temporary
        .set_permissions(
            existing
                .metadata()
                .map_err(|error| error.to_string())?
                .permissions(),
        )
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn preserve_replacement_metadata(existing: &File, temporary: &File) -> Result<(), String> {
    use std::os::fd::AsRawFd;

    // SAFETY: both descriptors remain open regular files for the duration of this call, and a
    // null copyfile state asks macOS to allocate and release its internal state for this copy.
    let result = unsafe {
        libc::fcopyfile(
            existing.as_raw_fd(),
            temporary.as_raw_fd(),
            std::ptr::null_mut(),
            libc::COPYFILE_METADATA,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(format!(
            "cannot preserve replacement metadata: {}",
            std::io::Error::last_os_error()
        ))
    }
}

#[cfg(not(unix))]
fn verify_unchanged(change: &PlannedChange) -> Result<(), String> {
    match &change.expected_content {
        None => match fs::symlink_metadata(&change.target) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Ok(_) => Err(format!(
                "{} appeared after planning; no replacement was attempted",
                change.target.display()
            )),
            Err(error) => Err(format!(
                "cannot revalidate {}: {error}",
                change.target.display()
            )),
        },
        Some(expected) => {
            let metadata = fs::symlink_metadata(&change.target).map_err(|error| {
                format!("cannot revalidate {}: {error}", change.target.display())
            })?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(format!(
                    "{} changed to an unsafe target after planning",
                    change.target.display()
                ));
            }
            let current = fs::read_to_string(&change.target).map_err(|error| {
                format!("cannot revalidate {}: {error}", change.target.display())
            })?;
            if current != *expected {
                return Err(format!(
                    "{} changed after planning; no replacement was attempted",
                    change.target.display()
                ));
            }
            Ok(())
        }
    }
}

fn merge_region(existing: &str, rendered: &str, start: &str, end: &str) -> Result<String, String> {
    let rendered_start = rendered
        .find(start)
        .ok_or_else(|| "generated managed region is missing its start marker".to_owned())?;
    let rendered_end = rendered
        .find(end)
        .map(|offset| offset + end.len())
        .ok_or_else(|| "generated managed region is missing its end marker".to_owned())?;
    let region = &rendered[rendered_start..rendered_end];
    let starts = existing.match_indices(start).collect::<Vec<_>>();
    let ends = existing.match_indices(end).collect::<Vec<_>>();
    if starts.is_empty() && ends.is_empty() {
        let separator = if existing.is_empty() || existing.ends_with('\n') {
            ""
        } else {
            "\n"
        };
        return Ok(format!("{existing}{separator}{region}\n"));
    }
    if starts.len() != 1 || ends.len() != 1 || starts[0].0 >= ends[0].0 {
        return Err(
            "managed-region markers are malformed or duplicated; no file was changed".to_owned(),
        );
    }
    let end_offset = ends[0].0 + end.len();
    Ok(format!(
        "{}{}{}",
        &existing[..starts[0].0],
        region,
        &existing[end_offset..]
    ))
}

fn ensure_safe_root(root: &Path) -> Result<(), String> {
    let mut current = PathBuf::new();
    for component in root.components() {
        current.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&current)
            .map_err(|error| format!("cannot inspect {}: {error}", current.display()))?;
        if metadata.file_type().is_symlink() {
            if is_trusted_platform_path_alias(&current) {
                continue;
            }
            return Err(format!("{} is not a real directory", current.display()));
        }
        if !metadata.is_dir() && current != root {
            return Err(format!("{} is not a real directory", current.display()));
        }
    }
    let metadata = fs::metadata(root)
        .map_err(|error| format!("cannot inspect {}: {error}", root.display()))?;
    if !metadata.is_dir() {
        return Err(format!("{} is not a real directory", root.display()));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn is_trusted_platform_path_alias(path: &Path) -> bool {
    // macOS exposes these root-owned compatibility aliases in otherwise ordinary user paths.
    // Only the platform's exact fixed targets are exempt from the user-controlled symlink rule.
    let expected_target = match path.to_str() {
        Some("/tmp") => Path::new("private/tmp"),
        Some("/var") => Path::new("private/var"),
        _ => return false,
    };
    fs::read_link(path).is_ok_and(|target| target == expected_target)
}

#[cfg(not(target_os = "macos"))]
fn is_trusted_platform_path_alias(_path: &Path) -> bool {
    false
}

fn ensure_plannable_root(root: &Path) -> Result<(), String> {
    let mut candidate = root;
    loop {
        match fs::symlink_metadata(candidate) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(format!("{} is not a real directory", candidate.display()));
            }
            Ok(_) => return ensure_safe_root(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                candidate = candidate.parent().ok_or_else(|| {
                    format!("{} has no existing directory ancestor", root.display())
                })?;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

fn create_safe_root(root: &Path) -> Result<(), String> {
    ensure_plannable_root(root)?;
    let mut missing = Vec::new();
    let mut candidate = root;
    while !candidate.exists() {
        missing.push(candidate.to_path_buf());
        candidate = candidate
            .parent()
            .ok_or_else(|| format!("{} has no existing directory ancestor", root.display()))?;
    }
    ensure_safe_root(candidate)?;
    for directory in missing.into_iter().rev() {
        fs::create_dir(&directory)
            .map_err(|error| format!("cannot create {}: {error}", directory.display()))?;
        ensure_safe_root(&directory)?;
    }
    Ok(())
}

fn ensure_safe_parent_chain(root: &Path, target: &Path) -> Result<(), String> {
    let relative = target
        .strip_prefix(root)
        .map_err(|_| "target escapes the selected root".to_owned())?;
    let mut current = root.to_path_buf();
    for component in relative
        .components()
        .take(relative.components().count().saturating_sub(1))
    {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(format!("unsafe parent {}", current.display()));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.to_string()),
        }
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

pub fn validate_relative_path(path: &str) -> Result<(), String> {
    const MAX_PATH_UNITS: usize = 4_096;
    const MAX_SEGMENTS: usize = 64;
    let normalized = path.replace('\\', "/");
    let segments = normalized.split('/').collect::<Vec<_>>();
    let drive_prefixed = normalized
        .as_bytes()
        .get(1)
        .is_some_and(|byte| *byte == b':');
    if normalized.is_empty()
        || normalized.len() > MAX_PATH_UNITS
        || normalized.encode_utf16().count() > MAX_PATH_UNITS
        || segments.len() > MAX_SEGMENTS
        || normalized.starts_with('/')
        || drive_prefixed
        || segments
            .iter()
            .any(|segment| segment.is_empty() || matches!(*segment, "." | ".."))
        || segments
            .iter()
            .any(|segment| !is_portable_generated_segment(segment))
        || normalized.contains(':')
        || normalized.chars().any(char::is_control)
        || Path::new(path).components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!("generated path {path:?} escapes the selected root"));
    }
    Ok(())
}

fn ensure_contained(root: &Path, target: &Path) -> Result<(), String> {
    if target.starts_with(root) {
        Ok(())
    } else {
        Err(format!(
            "target {} escapes {}",
            target.display(),
            root.display()
        ))
    }
}

fn file_uri(path: &Path) -> String {
    let portable = path.to_string_lossy().replace('\\', "/");
    let mut encoded = String::with_capacity(portable.len() + 8);
    for byte in portable.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'.' | b'_' | b'~' | b'/' | b':')
        {
            encoded.push(char::from(*byte));
        } else {
            use std::fmt::Write as _;
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    if encoded.starts_with('/') {
        format!("file://{encoded}")
    } else {
        format!("file:///{encoded}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn malformed_markers_fail_closed() {
        assert!(
            merge_region(
                "<!-- okf-workbench:index:start -->\n",
                "<!-- okf-workbench:index:start -->\nx\n<!-- okf-workbench:index:end -->",
                "<!-- okf-workbench:index:start -->",
                "<!-- okf-workbench:index:end -->",
            )
            .is_err()
        );
    }

    #[test]
    fn parent_paths_are_rejected() {
        assert!(validate_relative_path("../outside.md").is_err());
        assert!(validate_relative_path(r"..\outside.md").is_err());
        assert!(validate_relative_path("/outside.md").is_err());
        assert!(validate_relative_path(r"C:\outside.md").is_err());
        assert!(validate_relative_path("folder/file.md:payload").is_err());
    }

    #[test]
    fn non_portable_windows_components_are_rejected() {
        for path in [
            "CON.md",
            "aux.md",
            "COM1.md",
            "folder/Lpt9.txt",
            "folder/name?.md",
            "folder/a|b.md",
            "folder/trailing.",
            "folder/trailing ",
        ] {
            assert!(validate_relative_path(path).is_err(), "{path:?}");
        }
        assert!(validate_relative_path(&format!("{}.md", "a".repeat(253))).is_err());

        for path in ["COM0.md", "COM10.md", "console.md", ".CON.md"] {
            assert!(validate_relative_path(path).is_ok(), "{path:?}");
        }
        assert!(validate_relative_path(&format!("{}.md", "a".repeat(252))).is_ok());
    }

    #[test]
    fn changed_target_is_rejected_after_planning() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let target = root.join("AGENTS.md");
        fs::write(
            &target,
            "before\n<!-- okf-workbench:start -->\nold\n<!-- okf-workbench:end -->\n",
        )
        .unwrap();
        let plan = plan_files(
            root,
            vec![RenderedFile {
                relative_path: "AGENTS.md".to_owned(),
                encoding: "utf8",
                content: "<!-- okf-workbench:start -->\nnew\n<!-- okf-workbench:end -->\n"
                    .to_owned(),
            }],
            PlanMode::MergeAgent,
        )
        .unwrap();
        fs::write(&target, "user changed this after planning\n").unwrap();
        assert!(apply_plan(root, &plan).is_err());
        assert_eq!(
            fs::read_to_string(target).unwrap(),
            "user changed this after planning\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn parent_symlink_swap_after_planning_cannot_redirect_the_write() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().unwrap();
        let root = directory.path().join("bundle");
        let nested = root.join("nested");
        let moved = directory.path().join("moved-original-parent");
        let outside = directory.path().join("outside");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir(&outside).unwrap();
        let plan = plan_files(
            &root,
            vec![RenderedFile {
                relative_path: "nested/new.md".to_owned(),
                encoding: "utf8",
                content: "safe content\n".to_owned(),
            }],
            PlanMode::CreateOnly,
        )
        .unwrap();

        fs::rename(&nested, &moved).unwrap();
        symlink(&outside, &nested).unwrap();

        assert!(apply_plan(&root, &plan).is_err());
        assert!(!outside.join("new.md").exists());
        assert!(!moved.join("new.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn anchored_final_symlink_swap_never_opens_the_outside_target() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().unwrap();
        let root = directory.path().join("bundle");
        fs::create_dir(&root).unwrap();
        let target = root.join("target.md");
        let outside = directory.path().join("outside.md");
        fs::write(&target, "before\n").unwrap();
        fs::write(&outside, "outside\n").unwrap();
        let plan = plan_files(
            &root,
            vec![RenderedFile {
                relative_path: "target.md".to_owned(),
                encoding: "utf8",
                content: "after\n".to_owned(),
            }],
            PlanMode::MergeAgent,
        )
        .unwrap();
        fs::remove_file(&target).unwrap();
        symlink(&outside, &target).unwrap();

        assert!(apply_plan(&root, &plan).is_err());
        assert_eq!(fs::read_to_string(outside).unwrap(), "outside\n");
    }

    #[test]
    fn file_uri_percent_encodes_non_ascii_and_spaces() {
        let uri = file_uri(Path::new("/tmp/日本 語.md"));
        assert_eq!(uri, "file:///tmp/%E6%97%A5%E6%9C%AC%20%E8%AA%9E.md");
    }

    #[test]
    fn root_version_insertion_reparses_and_preserves_frontmatter() {
        let mixed = "---\ntitle: Knowledge\r\ncustom: retained\r\n---\r\n# Knowledge\r\n";
        let updated = insert_root_version(mixed).unwrap();
        assert!(updated.starts_with("---\nokf_version: \"0.2\"\n"));
        assert_eq!(
            root_frontmatter(&updated).unwrap().get("custom"),
            Some(&serde_json::Value::String("retained".to_owned()))
        );

        let plain = "# Knowledge\r";
        let updated = insert_root_version(plain).unwrap();
        assert!(updated.starts_with("---\rokf_version: \"0.2\"\r---\r"));
        assert!(updated.ends_with(plain));
    }

    #[test]
    fn root_version_insertion_supports_complex_yaml_shapes() {
        for (source, insertion) in [
            (
                "---\n{ title: Knowledge }\n---\n# Knowledge\n",
                "okf_version: \"0.2\",",
            ),
            (
                "---\n&metadata\n title: Knowledge\n---\n# Knowledge\n",
                " okf_version: \"0.2\"\n",
            ),
            (
                "---\n  title: Knowledge\n---\n# Knowledge\n",
                "  okf_version: \"0.2\"\n",
            ),
        ] {
            let updated = insert_root_version(source).unwrap();
            assert_eq!(
                root_frontmatter(&updated).unwrap().get("okf_version"),
                Some(&serde_json::Value::String("0.2".to_owned())),
                "{source:?}"
            );
            assert_eq!(updated.replacen(insertion, "", 1), source, "{source:?}");
        }
    }

    #[test]
    fn root_version_insertion_separates_inline_properties_from_empty_flow_maps() {
        for source in [
            "---\n!!map {}\n---\n# Knowledge\n",
            "---\n&root !!map {}\n---\n# Knowledge\n",
            "---\n&root !<tag:yaml.org,2002:map> {}\n---\n# Knowledge\n",
        ] {
            let before = root_frontmatter(source).unwrap();
            let updated = insert_root_version(source).unwrap();
            let mut after = root_frontmatter(&updated).unwrap();
            assert_eq!(
                after.remove("okf_version"),
                Some(serde_json::Value::String("0.2".to_owned())),
                "{updated:?}"
            );
            assert_eq!(after, before, "{updated:?}");
            assert!(updated.contains("\n{okf_version: \"0.2\"}"), "{updated:?}");
        }
    }

    #[test]
    fn root_version_insertion_supports_explicit_key_maps() {
        let source = "---\n!!map\n? type\n: bundle\n? title\n: Knowledge\n---\n# Knowledge\n";
        let before = root_frontmatter(source).unwrap();
        let updated = insert_root_version(source).unwrap();
        let mut after = root_frontmatter(&updated).unwrap();
        assert_eq!(
            after.remove("okf_version"),
            Some(serde_json::Value::String("0.2".to_owned())),
            "{updated:?}"
        );
        assert_eq!(after, before, "{updated:?}");
    }

    #[test]
    fn root_version_insertion_handles_many_explicit_entries_in_one_pass() {
        let mut source = String::from("---\n!!map\n");
        for index in 0..1_500 {
            source.push_str(&format!("? field{index:04}\n: value{index:04}\n"));
        }
        source.push_str("---\n# Knowledge\n");

        let updated = insert_root_version(&source).unwrap();

        assert!(updated.starts_with("---\n!!map\nokf_version: \"0.2\"\n? field0000\n"));
        assert_eq!(root_frontmatter(&updated).unwrap().len(), 1_501);
    }

    #[test]
    fn root_version_insertion_ignores_flow_tokens_in_comments() {
        let source = format!(
            "---\n# {}\n&metadata\n title: Knowledge\n---\n# Knowledge\n",
            "{".repeat(4_096)
        );
        let updated = insert_root_version(&source).unwrap();
        assert_eq!(
            root_frontmatter(&updated).unwrap().get("okf_version"),
            Some(&serde_json::Value::String("0.2".to_owned()))
        );
    }
}
