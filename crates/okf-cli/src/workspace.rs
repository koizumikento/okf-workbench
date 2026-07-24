use okf_core::{BundleDocumentInput, DocumentContent, ParseBundleInput, RenderedFile};
use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
};
use tempfile::NamedTempFile;
use walkdir::WalkDir;

const MAX_DOCUMENTS: usize = 2_000;
const MAX_DOCUMENT_BYTES: u64 = 320 * 1024 + 16;

#[derive(Clone, Copy, Debug)]
pub enum PlanMode {
    CreateOnly,
    MergeIndexes,
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
        let existing = if target.exists() {
            let metadata = fs::symlink_metadata(&target).map_err(|error| error.to_string())?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(format!("unsafe existing target {}", target.display()));
            }
            Some(fs::read_to_string(&target).map_err(|error| error.to_string())?)
        } else {
            None
        };
        let content = match (&existing, mode, file.relative_path.as_str()) {
            (Some(existing), PlanMode::CreateOnly, _) if existing != &file.content => {
                return Err(format!(
                    "{} already exists; no file was changed",
                    target.display()
                ));
            }
            (Some(existing), PlanMode::MergeIndexes, path) if path.ends_with("index.md") => {
                merge_region(
                    existing,
                    &file.content,
                    "<!-- okf-workbench:index:start -->",
                    "<!-- okf-workbench:index:end -->",
                )?
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

pub fn apply_plan(root: &Path, plan: &[PlannedChange]) -> Result<(), String> {
    if !root.exists() {
        create_safe_root(root)?;
    }
    ensure_safe_root(root)?;
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
                .and_then(|_| temporary.as_file().sync_all())
                .map_err(|error| error.to_string())?;
            temporary
                .persist(&change.target)
                .map_err(|error| error.error.to_string())?;
        }
    }
    Ok(())
}

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
    let metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("cannot inspect {}: {error}", root.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("{} is not a real directory", root.display()));
    }
    Ok(())
}

fn ensure_plannable_root(root: &Path) -> Result<(), String> {
    let mut candidate = root;
    loop {
        match fs::symlink_metadata(candidate) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(format!("{} is not a real directory", candidate.display()));
            }
            Ok(_) => return Ok(()),
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

    #[test]
    fn file_uri_percent_encodes_non_ascii_and_spaces() {
        let uri = file_uri(Path::new("/tmp/日本 語.md"));
        assert_eq!(uri, "file:///tmp/%E6%97%A5%E6%9C%AC%20%E8%AA%9E.md");
    }
}
