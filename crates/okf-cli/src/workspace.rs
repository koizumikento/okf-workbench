use okf_core::{
    BundleDocumentInput, DocumentContent, ParseBundleInput, RenderedFile, parse_bundle,
};
use serde::Serialize;
#[cfg(target_os = "linux")]
use std::collections::BTreeMap;
#[cfg(unix)]
use std::ffi::OsString;
#[cfg(not(unix))]
use std::fs::OpenOptions;
#[cfg(unix)]
use std::os::unix::{ffi::OsStringExt, fs::MetadataExt};
use std::{
    ffi::OsStr,
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
#[cfg(all(not(unix), not(windows)))]
use tempfile::NamedTempFile;
#[cfg(all(not(unix), not(windows)))]
use walkdir::WalkDir;

#[cfg(windows)]
use std::os::windows::{
    ffi::OsStrExt,
    fs::{MetadataExt as WindowsMetadataExt, OpenOptionsExt},
    io::AsRawHandle,
};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_DISPOSITION_FLAG_DELETE,
    FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO_EX, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_READ_ATTRIBUTES,
    FILE_RENAME_INFO, FILE_RENAME_INFO_0, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE,
    FileDispositionInfoEx, FileRenameInfoEx, SYNCHRONIZE, SetFileInformationByHandle,
};

#[cfg(target_os = "linux")]
use rustix::fs::{
    Gid, Uid, XattrFlags, fchmod, fchown, fgetxattr, flistxattr, fremovexattr, fsetxattr,
};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use rustix::fs::{RenameFlags, renameat_with};
#[cfg(unix)]
use rustix::{
    fs::{Mode, OFlags, mkdirat, open, openat},
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
    #[cfg(unix)]
    {
        load_bundle_anchored(root)
    }

    #[cfg(windows)]
    {
        load_bundle_windows(root)
    }

    #[cfg(all(not(unix), not(windows)))]
    {
        load_bundle_ambient(root)
    }
}

#[cfg(all(not(unix), not(windows)))]
fn load_bundle_ambient(root: &Path) -> Result<ParseBundleInput, String> {
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
            invalid_utf16_fields: None,
        });
    }
    Ok(ParseBundleInput {
        root_uri: file_uri(&root),
        invalid_root_uri_utf16: None,
        revision: 1,
        documents,
    })
}

#[cfg(windows)]
fn load_bundle_windows(root: &Path) -> Result<ParseBundleInput, String> {
    let (root, mut locks) = windows_anchor_directory(root, false)?;
    let mut documents = Vec::new();
    collect_windows_documents(&root, &root, Path::new(""), &mut locks, &mut documents)?;
    Ok(ParseBundleInput {
        root_uri: file_uri(&root),
        invalid_root_uri_utf16: None,
        revision: 1,
        documents,
    })
}

#[cfg(windows)]
fn collect_windows_documents(
    root: &Path,
    directory: &Path,
    relative_directory: &Path,
    locks: &mut Vec<File>,
    documents: &mut Vec<BundleDocumentInput>,
) -> Result<(), String> {
    let mut entries = fs::read_dir(directory)
        .map_err(|error| format!("cannot enumerate {}: {error}", directory.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name();
        if name == ".agents" {
            continue;
        }
        let relative = relative_directory.join(&name);
        let path = directory.join(&name);
        let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if windows_metadata_is_reparse(&metadata) {
            return Err(format!(
                "bundle traversal refused reparse point {}",
                path.display()
            ));
        }
        if metadata.is_dir() {
            locks.push(open_windows_directory_lock(&path)?);
            collect_windows_documents(root, &path, &relative, locks, documents)?;
            continue;
        }
        if !metadata.is_file()
            || relative.extension().and_then(|value| value.to_str()) != Some("md")
        {
            continue;
        }
        let bundle_path = relative
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if bundle_path == "AGENTS.md" {
            continue;
        }
        if documents.len() >= MAX_DOCUMENTS {
            return Err("bundle contains more than 2,000 Markdown documents".to_owned());
        }
        let file = open_windows_read_lock(&path)?;
        let opened_metadata = file.metadata().map_err(|error| error.to_string())?;
        if windows_metadata_is_reparse(&opened_metadata) || !opened_metadata.is_file() {
            return Err(format!(
                "bundle traversal refused unsafe file {}",
                path.display()
            ));
        }
        if opened_metadata.len() > MAX_DOCUMENT_BYTES {
            return Err(format!(
                "{} exceeds the bounded document size",
                path.display()
            ));
        }
        let mut bytes = Vec::new();
        file.take(MAX_DOCUMENT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
            return Err(format!(
                "{} exceeds the bounded document size",
                path.display()
            ));
        }
        documents.push(BundleDocumentInput {
            uri: file_uri(&path),
            bundle_path,
            content: Some(DocumentContent::Bytes(bytes)),
            content_hash: None,
            identity_only_failure: None,
            invalid_utf16_fields: None,
        });
    }
    Ok(())
}

#[cfg(unix)]
fn load_bundle_anchored(root: &Path) -> Result<ParseBundleInput, String> {
    ensure_safe_root(root)?;
    let root_directory = open_anchored_root(root)?;
    let mut documents = Vec::new();
    collect_anchored_documents(&root_directory, root, Path::new(""), &mut documents)?;
    Ok(ParseBundleInput {
        root_uri: file_uri(root),
        invalid_root_uri_utf16: None,
        revision: 1,
        documents,
    })
}

#[cfg(unix)]
fn collect_anchored_documents(
    directory: &File,
    root: &Path,
    relative_directory: &Path,
    documents: &mut Vec<BundleDocumentInput>,
) -> Result<(), String> {
    let mut stream = rustix::fs::Dir::read_from(directory)
        .map_err(|error| format!("cannot enumerate anchored bundle directory: {error}"))?;
    let mut names = Vec::new();
    while let Some(entry) = stream.read() {
        let entry = entry.map_err(|error| error.to_string())?;
        let bytes = entry.file_name().to_bytes();
        if matches!(bytes, b"." | b"..") {
            continue;
        }
        names.push(OsString::from_vec(bytes.to_vec()));
    }
    names.sort();

    for name in names {
        if name == ".agents" {
            continue;
        }
        let relative = relative_directory.join(&name);
        let opened = openat(
            directory,
            &name,
            OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| {
            format!(
                "bundle traversal refused unsafe entry {}: {error}",
                relative.display()
            )
        })?;
        let file = File::from(opened);
        let metadata = file.metadata().map_err(|error| error.to_string())?;
        if metadata.is_dir() {
            collect_anchored_documents(&file, root, &relative, documents)?;
            continue;
        }
        if !metadata.is_file()
            || relative.extension().and_then(|value| value.to_str()) != Some("md")
        {
            continue;
        }
        let bundle_path = relative
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if bundle_path == "AGENTS.md" {
            continue;
        }
        if documents.len() >= MAX_DOCUMENTS {
            return Err("bundle contains more than 2,000 Markdown documents".to_owned());
        }
        if metadata.len() > MAX_DOCUMENT_BYTES {
            return Err(format!(
                "{} exceeds the bounded document size",
                relative.display()
            ));
        }
        let bytes = read_anchored_file_with_hook(file, || Ok(()))?;
        if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
            return Err(format!(
                "{} exceeds the bounded document size",
                relative.display()
            ));
        }
        documents.push(BundleDocumentInput {
            uri: file_uri(&root.join(&relative)),
            bundle_path,
            content: Some(DocumentContent::Bytes(bytes)),
            content_hash: None,
            identity_only_failure: None,
            invalid_utf16_fields: None,
        });
    }
    Ok(())
}

#[cfg(unix)]
fn read_anchored_file_with_hook(
    file: File,
    before_read: impl FnOnce() -> Result<(), String>,
) -> Result<Vec<u8>, String> {
    before_read()?;
    let mut bytes = Vec::new();
    file.take(MAX_DOCUMENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    Ok(bytes)
}

pub fn load_root_index(root: &Path) -> Result<ParseBundleInput, String> {
    #[cfg(unix)]
    {
        load_root_index_anchored(root)
    }

    #[cfg(windows)]
    {
        load_root_index_windows(root)
    }

    #[cfg(all(not(unix), not(windows)))]
    {
        load_root_index_ambient(root)
    }
}

#[cfg(all(not(unix), not(windows)))]
fn load_root_index_ambient(root: &Path) -> Result<ParseBundleInput, String> {
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
                invalid_utf16_fields: None,
            });
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    Ok(ParseBundleInput {
        root_uri: file_uri(&root),
        invalid_root_uri_utf16: None,
        revision: 1,
        documents,
    })
}

#[cfg(windows)]
fn load_root_index_windows(root: &Path) -> Result<ParseBundleInput, String> {
    let (root, _locks) = windows_anchor_directory(root, false)?;
    let path = root.join("index.md");
    let mut documents = Vec::new();
    match open_windows_read_handle(&path) {
        Ok(file) => {
            let metadata = file.metadata().map_err(|error| error.to_string())?;
            if windows_metadata_is_reparse(&metadata) || !metadata.is_file() {
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
            let mut bytes = Vec::new();
            file.take(MAX_DOCUMENT_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|error| error.to_string())?;
            if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
                return Err(format!(
                    "{} exceeds the bounded document size",
                    path.display()
                ));
            }
            documents.push(BundleDocumentInput {
                uri: file_uri(&path),
                bundle_path: "index.md".to_owned(),
                content: Some(DocumentContent::Bytes(bytes)),
                content_hash: None,
                identity_only_failure: None,
                invalid_utf16_fields: None,
            });
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "cannot open {} without following reparse points: {error}",
                path.display()
            ));
        }
    }
    Ok(ParseBundleInput {
        root_uri: file_uri(&root),
        invalid_root_uri_utf16: None,
        revision: 1,
        documents,
    })
}

#[cfg(unix)]
fn load_root_index_anchored(root: &Path) -> Result<ParseBundleInput, String> {
    ensure_safe_root(root)?;
    let root_directory = open_anchored_root(root)?;
    let mut documents = Vec::new();
    match openat(
        &root_directory,
        "index.md",
        OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(file) => {
            let file = File::from(file);
            let metadata = file.metadata().map_err(|error| error.to_string())?;
            if !metadata.is_file() {
                return Err(format!(
                    "write refused unsafe root index {}",
                    root.join("index.md").display()
                ));
            }
            if metadata.len() > MAX_DOCUMENT_BYTES {
                return Err(format!(
                    "{} exceeds the bounded document size",
                    root.join("index.md").display()
                ));
            }
            let bytes = read_anchored_file_with_hook(file, || Ok(()))?;
            if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
                return Err(format!(
                    "{} exceeds the bounded document size",
                    root.join("index.md").display()
                ));
            }
            documents.push(BundleDocumentInput {
                uri: file_uri(&root.join("index.md")),
                bundle_path: "index.md".to_owned(),
                content: Some(DocumentContent::Bytes(bytes)),
                content_hash: None,
                identity_only_failure: None,
                invalid_utf16_fields: None,
            });
        }
        Err(Errno::NOENT) => {}
        Err(error) => {
            return Err(format!(
                "write refused unsafe root index {}: {error}",
                root.join("index.md").display()
            ));
        }
    }
    Ok(ParseBundleInput {
        root_uri: file_uri(root),
        invalid_root_uri_utf16: None,
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
        invalid_root_uri_utf16: None,
        revision: 1,
        documents: vec![BundleDocumentInput {
            uri: "file:///okf-version-proposal/index.md".to_owned(),
            bundle_path: "index.md".to_owned(),
            content: Some(DocumentContent::Text(content.to_owned())),
            content_hash: None,
            identity_only_failure: None,
            invalid_utf16_fields: None,
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
    #[cfg(unix)]
    {
        apply_plan_anchored(root, plan)
    }

    #[cfg(windows)]
    {
        apply_plan_windows(root, plan)
    }

    #[cfg(all(not(unix), not(windows)))]
    {
        if !root.exists() {
            create_safe_root(root)?;
        }
        ensure_safe_root(root)?;
        apply_plan_ambient(root, plan)
    }
}

#[cfg(all(not(unix), not(windows)))]
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

#[cfg(windows)]
fn apply_plan_windows(root: &Path, plan: &[PlannedChange]) -> Result<(), String> {
    let (root, _root_locks) = windows_anchor_directory(root, true)?;
    for change in plan {
        ensure_contained(&root, &root.join(&change.relative_path))?;
        validate_relative_path(&change.relative_path)?;
        preflight_windows_change(&root, change)?;
    }
    for change in plan {
        apply_windows_change(&root, change)?;
    }
    Ok(())
}

#[cfg(windows)]
fn preflight_windows_change(root: &Path, change: &PlannedChange) -> Result<(), String> {
    let target = root.join(&change.relative_path);
    let parent = target
        .parent()
        .ok_or_else(|| format!("{} has no parent", target.display()))?;
    if !parent.exists() {
        return if change.expected_content.is_none() {
            Ok(())
        } else {
            Err(format!(
                "{} disappeared after planning; no write was attempted",
                target.display()
            ))
        };
    }
    let (_parent, _locks) = windows_anchor_directory(parent, false)?;
    match &change.expected_content {
        None => match open_windows_read_handle(&target) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Ok(_) => Err(format!(
                "{} appeared after planning; no replacement was attempted",
                target.display()
            )),
            Err(error) => Err(format!("cannot revalidate {}: {error}", target.display())),
        },
        Some(expected) => {
            let mut existing = open_windows_read_handle(&target)
                .map_err(|error| format!("cannot revalidate {}: {error}", target.display()))?;
            ensure_windows_regular_file(&existing, &target)?;
            let mut current = String::new();
            existing
                .read_to_string(&mut current)
                .map_err(|error| error.to_string())?;
            if current == *expected {
                Ok(())
            } else {
                Err(format!(
                    "{} changed after planning; no replacement was attempted",
                    target.display()
                ))
            }
        }
    }
}

#[cfg(windows)]
fn apply_windows_change(root: &Path, change: &PlannedChange) -> Result<(), String> {
    let target = root.join(&change.relative_path);
    let parent = target
        .parent()
        .ok_or_else(|| format!("{} has no parent", target.display()))?;
    let (parent, _locks) = windows_anchor_directory(parent, true)?;
    let leaf = target
        .file_name()
        .ok_or_else(|| format!("{} has no filename", target.display()))?;
    match &change.expected_content {
        None => create_windows_file(&parent, leaf, change),
        Some(expected) => replace_windows_file(&parent, leaf, expected, change),
    }
}

#[cfg(windows)]
fn create_windows_file(parent: &Path, leaf: &OsStr, change: &PlannedChange) -> Result<(), String> {
    match open_windows_read_handle(&parent.join(leaf)) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Ok(_) => {
            return Err(format!(
                "{} appeared after planning; no replacement was attempted",
                change.target.display()
            ));
        }
        Err(error) => {
            return Err(format!(
                "cannot revalidate {}: {error}",
                change.target.display()
            ));
        }
    }
    let parent_handle = open_windows_directory_mutation_handle(parent)?;
    let (_temporary_path, mut temporary) = create_windows_temporary(parent)?;
    let result = (|| {
        temporary
            .write_all(change.content.as_bytes())
            .and_then(|_| temporary.sync_all())
            .map_err(|error| error.to_string())?;
        rename_windows_handle(&temporary, &parent_handle, leaf, false).map_err(|error| {
            format!(
                "{} appeared after planning; no file was published: {error}",
                change.target.display()
            )
        })
    })();
    match result {
        Ok(()) => Ok(()),
        Err(primary) => match dispose_windows_handle(&temporary) {
            Ok(()) => Err(primary),
            Err(cleanup) => Err(format!(
                "{primary}; additionally, the staged temporary file could not be removed: {cleanup}"
            )),
        },
    }
}

#[cfg(windows)]
fn replace_windows_file(
    parent: &Path,
    leaf: &OsStr,
    expected: &str,
    change: &PlannedChange,
) -> Result<(), String> {
    let target = parent.join(leaf);
    let mut existing = open_windows_read_handle(&target)
        .map_err(|error| format!("cannot revalidate {}: {error}", target.display()))?;
    ensure_windows_regular_file(&existing, &target)?;
    let mut current = String::new();
    existing
        .read_to_string(&mut current)
        .map_err(|error| error.to_string())?;
    if current != expected {
        return Err(format!(
            "{} changed after planning; no replacement was attempted",
            target.display()
        ));
    }
    let parent_handle = open_windows_directory_mutation_handle(parent)?;
    let (_temporary_path, mut temporary) = create_windows_temporary(parent)?;
    let result = (|| {
        temporary
            .write_all(change.content.as_bytes())
            .map_err(|error| error.to_string())?;
        temporary
            .set_permissions(
                existing
                    .metadata()
                    .map_err(|error| error.to_string())?
                    .permissions(),
            )
            .and_then(|_| temporary.sync_all())
            .map_err(|error| error.to_string())?;
        // The verified target remains open without FILE_SHARE_WRITE or FILE_SHARE_DELETE until
        // this single kernel operation. POSIX rename semantics either replaces that exact entry
        // or fails closed; there is no ambient delete-then-rename window.
        rename_windows_handle(&temporary, &parent_handle, leaf, true)
            .map_err(|error| format!("cannot replace {}: {error}", target.display()))
    })();
    match result {
        Ok(()) => Ok(()),
        Err(primary) => match dispose_windows_handle(&temporary) {
            Ok(()) => Err(primary),
            Err(cleanup) => Err(format!(
                "{primary}; additionally, the staged temporary file could not be removed: {cleanup}"
            )),
        },
    }
}

#[cfg(windows)]
fn windows_anchor_directory(
    path: &Path,
    create_missing: bool,
) -> Result<(PathBuf, Vec<File>), String> {
    let absolute = std::path::absolute(path)
        .map_err(|error| format!("cannot make {} absolute: {error}", path.display()))?;
    let mut existing = absolute.as_path();
    let mut missing = Vec::new();
    loop {
        match fs::symlink_metadata(existing) {
            Ok(metadata) => {
                if windows_metadata_is_reparse(&metadata) || !metadata.is_dir() {
                    return Err(format!("{} is not a real directory", existing.display()));
                }
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && create_missing => {
                missing.push(
                    existing
                        .file_name()
                        .ok_or_else(|| format!("{} has no existing ancestor", absolute.display()))?
                        .to_os_string(),
                );
                existing = existing
                    .parent()
                    .ok_or_else(|| format!("{} has no existing ancestor", absolute.display()))?;
            }
            Err(error) => {
                return Err(format!("cannot inspect {}: {error}", existing.display()));
            }
        }
    }

    let mut locks = Vec::new();
    let mut ancestors = existing.ancestors().collect::<Vec<_>>();
    ancestors.reverse();
    for ancestor in ancestors {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        locks.push(open_windows_directory_lock(ancestor)?);
    }

    let mut current = existing.to_path_buf();
    for component in missing.into_iter().rev() {
        current.push(component);
        match fs::create_dir(&current) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(format!("cannot create {}: {error}", current.display()));
            }
        }
        locks.push(open_windows_directory_lock(&current)?);
    }
    if current != absolute {
        return Err(format!(
            "cannot anchor requested directory {}",
            absolute.display()
        ));
    }
    Ok((absolute, locks))
}

#[cfg(windows)]
fn open_windows_directory_lock(path: &Path) -> Result<File, String> {
    let file = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES | FILE_TRAVERSE | SYNCHRONIZE)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| format!("cannot anchor directory {}: {error}", path.display()))?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if windows_metadata_is_reparse(&metadata)
        || metadata.file_attributes() & FILE_ATTRIBUTE_DIRECTORY == 0
    {
        return Err(format!("{} is not a real directory", path.display()));
    }
    Ok(file)
}

#[cfg(windows)]
fn open_windows_directory_mutation_handle(path: &Path) -> Result<File, String> {
    let file = OpenOptions::new()
        .access_mode(FILE_GENERIC_READ | FILE_GENERIC_WRITE | SYNCHRONIZE)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| {
            format!(
                "cannot open parent {} for publication: {error}",
                path.display()
            )
        })?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if windows_metadata_is_reparse(&metadata) || !metadata.is_dir() {
        return Err(format!("{} is not a real directory", path.display()));
    }
    Ok(file)
}

#[cfg(windows)]
fn open_windows_read_handle(path: &Path) -> std::io::Result<File> {
    OpenOptions::new()
        .access_mode(FILE_GENERIC_READ | SYNCHRONIZE)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(windows)]
fn open_windows_read_lock(path: &Path) -> Result<File, String> {
    open_windows_read_handle(path).map_err(|error| {
        format!(
            "cannot open {} without following reparse points: {error}",
            path.display()
        )
    })
}

#[cfg(windows)]
fn ensure_windows_regular_file(file: &File, path: &Path) -> Result<(), String> {
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if windows_metadata_is_reparse(&metadata) || !metadata.is_file() {
        return Err(format!("{} changed to an unsafe target", path.display()));
    }
    Ok(())
}

#[cfg(windows)]
fn windows_metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(windows)]
fn create_windows_temporary(parent: &Path) -> Result<(PathBuf, File), String> {
    static NEXT_TEMPORARY: AtomicU64 = AtomicU64::new(0);
    for _ in 0..128 {
        let sequence = NEXT_TEMPORARY.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(
            ".okf-workbench-{}-{sequence}.tmp",
            std::process::id()
        ));
        match OpenOptions::new()
            .create_new(true)
            .access_mode(FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE | SYNCHRONIZE)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&path)
        {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(format!("cannot reserve temporary file: {error}")),
        }
    }
    Err("cannot reserve a unique temporary file name".to_owned())
}

#[cfg(windows)]
fn rename_windows_handle(
    file: &File,
    parent: &File,
    leaf: &OsStr,
    replace: bool,
) -> Result<(), String> {
    const FILE_RENAME_FLAG_REPLACE_IF_EXISTS: u32 = 0x1;
    const FILE_RENAME_FLAG_POSIX_SEMANTICS: u32 = 0x2;
    let name = leaf.encode_wide().collect::<Vec<_>>();
    let name_bytes = name
        .len()
        .checked_mul(std::mem::size_of::<u16>())
        .ok_or_else(|| "replacement filename is too long".to_owned())?;
    let header_bytes = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
    let buffer_bytes = header_bytes
        .checked_add(name_bytes)
        .ok_or_else(|| "replacement filename is too long".to_owned())?;
    let words = buffer_bytes.div_ceil(std::mem::size_of::<usize>());
    let mut buffer = vec![0usize; words];
    let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    let flags = if replace {
        FILE_RENAME_FLAG_POSIX_SEMANTICS | FILE_RENAME_FLAG_REPLACE_IF_EXISTS
    } else {
        0
    };
    // SAFETY: `buffer` is word-aligned and large enough for the fixed header plus `name_bytes`.
    // Both file handles remain live for the call and the UTF-16 filename contains no terminator.
    let succeeded = unsafe {
        (*info).Anonymous = FILE_RENAME_INFO_0 { Flags: flags };
        (*info).RootDirectory = parent.as_raw_handle();
        (*info).FileNameLength =
            u32::try_from(name_bytes).map_err(|_| "replacement filename is too long".to_owned())?;
        std::ptr::copy_nonoverlapping(
            name.as_ptr().cast::<u8>(),
            buffer.as_mut_ptr().cast::<u8>().add(header_bytes),
            name_bytes,
        );
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileRenameInfoEx,
            buffer.as_ptr().cast(),
            u32::try_from(buffer_bytes)
                .map_err(|_| "replacement filename is too long".to_owned())?,
        )
    };
    if succeeded != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().to_string())
    }
}

#[cfg(windows)]
fn dispose_windows_handle(file: &File) -> Result<(), String> {
    let disposition = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
    };
    // SAFETY: the descriptor is live and the fixed-size structure is valid for this info class.
    let succeeded = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfoEx,
            (&raw const disposition).cast(),
            u32::try_from(std::mem::size_of_val(&disposition)).unwrap(),
        )
    };
    if succeeded != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().to_string())
    }
}

#[cfg(unix)]
fn apply_plan_anchored(root: &Path, plan: &[PlannedChange]) -> Result<(), String> {
    let root_directory = open_or_create_anchored_root(root)?;
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
fn open_or_create_anchored_root(root: &Path) -> Result<File, String> {
    open_or_create_anchored_root_with_hook(root, || Ok(()))
}

#[cfg(unix)]
fn open_or_create_anchored_root_with_hook(
    root: &Path,
    after_anchor: impl FnOnce() -> Result<(), String>,
) -> Result<File, String> {
    match fs::symlink_metadata(root) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(format!("{} is not a real directory", root.display()));
        }
        Ok(_) => return open_anchored_root(root),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }

    let mut existing = root;
    loop {
        existing = existing
            .parent()
            .ok_or_else(|| format!("{} has no existing directory ancestor", root.display()))?;
        match fs::symlink_metadata(existing) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                if is_trusted_platform_path_alias(existing) {
                    break;
                }
                return Err(format!("{} is not a real directory", existing.display()));
            }
            Ok(metadata) if metadata.is_dir() => break,
            Ok(_) => return Err(format!("{} is not a real directory", existing.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    ensure_safe_root(existing)?;
    let canonical_existing = existing
        .canonicalize()
        .map_err(|error| format!("cannot anchor {}: {error}", existing.display()))?;
    let mut directory = open_anchored_root(&canonical_existing)?;
    let missing = root
        .strip_prefix(existing)
        .map_err(|_| "new root escapes its existing ancestor".to_owned())?
        .components()
        .map(|component| match component {
            Component::Normal(value) => Ok(value.to_os_string()),
            _ => Err("new root contains a non-relative component".to_owned()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    after_anchor()?;
    for component in missing {
        match mkdirat(&directory, &component, Mode::from_raw_mode(0o755)) {
            Ok(()) | Err(Errno::EXIST) => {}
            Err(error) => {
                return Err(format!(
                    "cannot create root component {component:?}: {error}"
                ));
            }
        }
        directory = File::from(
            openat(
                &directory,
                &component,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(|error| {
                format!("cannot open new root component {component:?} safely: {error}")
            })?,
        );
    }
    Ok(directory)
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
    create_anchored_file_with_writer(parent, leaf, change, |file| {
        file.write_all(change.content.as_bytes())
            .map_err(|error| error.to_string())
    })
}

#[cfg(unix)]
fn create_anchored_file_with_writer(
    parent: &File,
    leaf: &OsStr,
    change: &PlannedChange,
    write_content: impl FnOnce(&mut File) -> Result<(), String>,
) -> Result<(), String> {
    let (temporary_name, mut temporary) = create_anchored_temporary(parent)?;
    (|| {
        write_content(&mut temporary)?;
        temporary.sync_all().map_err(|error| error.to_string())?;
        publish_anchored_new(parent, &temporary_name, leaf).map_err(|error| {
            format!(
                "{} appeared after planning; no file was published: {error}",
                change.target.display()
            )
        })
    })()
}

#[cfg(unix)]
fn replace_anchored_file(
    parent: &File,
    leaf: &OsStr,
    expected: &str,
    change: &PlannedChange,
) -> Result<(), String> {
    replace_anchored_file_with_hook(parent, leaf, expected, change, || Ok(()))
}

#[cfg(unix)]
fn replace_anchored_file_with_hook(
    parent: &File,
    leaf: &OsStr,
    expected: &str,
    change: &PlannedChange,
    before_exchange: impl FnOnce() -> Result<(), String>,
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
    let existing_identity = file_identity(&existing)?;

    let (temporary_name, mut temporary) = create_anchored_temporary(parent)?;
    let temporary_identity = file_identity(&temporary)?;
    (|| {
        temporary
            .write_all(change.content.as_bytes())
            .map_err(|error| error.to_string())?;
        preserve_replacement_metadata(&existing, &temporary)?;
        temporary.sync_all().map_err(|error| error.to_string())?;
        before_exchange()?;
        exchange_anchored_names(parent, &temporary_name, leaf)
            .map_err(|error| format!("cannot replace {}: {error}", change.target.display()))?;

        let exchanged_matches =
            anchored_file_matches(parent, &temporary_name, existing_identity, expected);
        if exchanged_matches {
            // POSIX has no portable compare-and-unlink primitive. Retain the verified displaced
            // file under the generated name: unlinking by pathname after a separate identity
            // check could delete a concurrent actor's entry.
            return Ok(());
        }

        exchange_anchored_names(parent, &temporary_name, leaf).map_err(|error| {
            format!(
                "{} changed during replacement and the atomic rollback failed: {error}",
                change.target.display()
            )
        })?;
        if !anchored_file_matches(parent, &temporary_name, temporary_identity, &change.content) {
            return Err(format!(
                "{} changed during replacement; the generated temporary file was retained to avoid deleting concurrent data",
                change.target.display()
            ));
        }
        Err(format!(
            "{} changed during replacement; the concurrent file was restored and the staged file was retained for safe recovery",
            change.target.display()
        ))
    })()
}

#[cfg(unix)]
fn file_identity(file: &File) -> Result<(u64, u64), String> {
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(unix)]
fn anchored_file_matches(
    parent: &File,
    leaf: &OsStr,
    identity: (u64, u64),
    expected: &str,
) -> bool {
    let mut file = match openat(
        parent,
        leaf,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(file) => File::from(file),
        Err(_) => return false,
    };
    if file_identity(&file).ok() != Some(identity) {
        return false;
    }
    let mut current = String::new();
    file.read_to_string(&mut current).is_ok() && current == expected
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn exchange_anchored_names(parent: &File, left: &OsStr, right: &OsStr) -> Result<(), String> {
    renameat_with(parent, left, parent, right, RenameFlags::EXCHANGE)
        .map_err(|error| error.to_string())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn publish_anchored_new(parent: &File, temporary: &OsStr, leaf: &OsStr) -> Result<(), String> {
    renameat_with(parent, temporary, parent, leaf, RenameFlags::NOREPLACE)
        .map_err(|error| error.to_string())
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn publish_anchored_new(_parent: &File, _temporary: &OsStr, _leaf: &OsStr) -> Result<(), String> {
    Err("atomic no-replace publication is unsupported on this Unix platform".to_owned())
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn exchange_anchored_names(_parent: &File, _left: &OsStr, _right: &OsStr) -> Result<(), String> {
    Err("atomic compare-and-replace is unsupported on this Unix platform".to_owned())
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
            Mode::from_raw_mode(0o666),
        ) {
            Ok(file) => return Ok((name, File::from(file))),
            Err(Errno::EXIST) => {}
            Err(error) => return Err(format!("cannot reserve temporary file name: {error}")),
        }
    }
    Err("cannot reserve a unique anchored temporary file name".to_owned())
}

#[cfg(target_os = "linux")]
fn preserve_replacement_metadata(existing: &File, temporary: &File) -> Result<(), String> {
    let source = existing.metadata().map_err(|error| error.to_string())?;
    let destination = temporary.metadata().map_err(|error| error.to_string())?;
    let owner = (source.uid() != destination.uid()).then(|| Uid::from_raw(source.uid()));
    let group = (source.gid() != destination.gid()).then(|| Gid::from_raw(source.gid()));
    if owner.is_some() || group.is_some() {
        fchown(temporary, owner, group)
            .map_err(|error| format!("cannot preserve replacement owner/group: {error}"))?;
    }

    let source_xattrs = linux_selected_xattrs(existing)?;
    let destination_xattrs = linux_selected_xattrs(temporary)?;
    for name in destination_xattrs.keys() {
        if !source_xattrs.contains_key(name) {
            let name = std::ffi::CString::new(name.as_slice())
                .map_err(|_| "replacement xattr name contains NUL".to_owned())?;
            fremovexattr(temporary, name.as_c_str()).map_err(|error| {
                format!(
                    "cannot remove inherited replacement xattr {:?}: {error}",
                    name
                )
            })?;
        }
    }
    for (name, value) in &source_xattrs {
        if destination_xattrs.get(name) == Some(value) {
            continue;
        }
        let name = std::ffi::CString::new(name.as_slice())
            .map_err(|_| "source xattr name contains NUL".to_owned())?;
        fsetxattr(temporary, name.as_c_str(), value, XattrFlags::empty())
            .map_err(|error| format!("cannot preserve replacement xattr {:?}: {error}", name))?;
    }

    fchmod(temporary, Mode::from_raw_mode(source.mode() & 0o7777))
        .map_err(|error| format!("cannot preserve replacement mode: {error}"))
}

#[cfg(target_os = "linux")]
fn linux_selected_xattrs(file: &File) -> Result<BTreeMap<Vec<u8>, Vec<u8>>, String> {
    const MAX_XATTR_BYTES: usize = 64 * 1024;
    let mut names = vec![0u8; MAX_XATTR_BYTES];
    let names_length = flistxattr(file, &mut names[..])
        .map_err(|error| format!("cannot list replacement xattrs: {error}"))?;
    names.truncate(names_length);
    let mut selected = BTreeMap::new();
    let mut start = 0usize;
    while start < names.len() {
        let Some(relative_end) = names[start..].iter().position(|byte| *byte == 0) else {
            return Err("replacement xattr list is not NUL-terminated".to_owned());
        };
        let end = start + relative_end;
        if end == start {
            return Err("replacement xattr list contains an empty name".to_owned());
        }
        let name = &names[start..end];
        if is_preserved_linux_xattr(name) {
            let c_name = std::ffi::CString::new(name)
                .map_err(|_| "replacement xattr name contains NUL".to_owned())?;
            let mut value = vec![0u8; MAX_XATTR_BYTES];
            let value_length = fgetxattr(file, c_name.as_c_str(), &mut value[..])
                .map_err(|error| format!("cannot read replacement xattr {c_name:?}: {error}"))?;
            value.truncate(value_length);
            selected.insert(name.to_vec(), value);
        }
        start = end + 1;
    }
    Ok(selected)
}

#[cfg(target_os = "linux")]
fn is_preserved_linux_xattr(name: &[u8]) -> bool {
    name.starts_with(b"user.") || name == b"system.posix_acl_access" || name == b"security.selinux"
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
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

#[cfg(all(not(unix), not(windows)))]
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

#[cfg(all(not(unix), not(windows)))]
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
        .trim_end_matches([' ', '.'])
        .to_ascii_uppercase();
    matches!(
        basename.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        basename.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
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
            "COM¹.md",
            "folder/lpt².txt",
            "CONIN$.md",
            "folder/conout$.txt",
            "NUL .md",
            "folder/AUX .txt.md",
            "COM1 .md",
            "folder/LPT9 .txt.md",
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

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_metadata_selector_excludes_content_sensitive_security_xattrs() {
        for name in [
            b"user.okf-workbench".as_slice(),
            b"system.posix_acl_access",
            b"security.selinux",
        ] {
            assert!(is_preserved_linux_xattr(name));
        }
        for name in [
            b"security.capability".as_slice(),
            b"security.ima",
            b"security.evm",
            b"trusted.overlay.origin",
            b"system.posix_acl_default",
        ] {
            assert!(!is_preserved_linux_xattr(name));
        }
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
    fn missing_root_symlink_interposition_fails_before_any_outside_write() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().unwrap();
        let root = directory.path().join("new-root");
        let outside = directory.path().join("outside");
        fs::create_dir(&outside).unwrap();

        let result = open_or_create_anchored_root_with_hook(&root, || {
            symlink(&outside, &root).map_err(|error| error.to_string())
        });

        assert!(result.is_err());
        assert!(fs::read_dir(outside).unwrap().next().is_none());
        assert!(fs::symlink_metadata(root).unwrap().file_type().is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn anchored_read_never_ingests_a_leaf_swapped_to_an_outside_symlink() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().unwrap();
        let root = directory.path().join("bundle");
        fs::create_dir(&root).unwrap();
        let target = root.join("concept.md");
        let displaced = root.join("displaced.md");
        let outside = directory.path().join("outside.md");
        fs::write(&target, b"inside\n").unwrap();
        fs::write(&outside, b"outside sentinel\n").unwrap();
        let root_directory = open_anchored_root(&root).unwrap();
        let file = File::from(
            openat(
                &root_directory,
                "concept.md",
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .unwrap(),
        );

        let bytes = read_anchored_file_with_hook(file, || {
            fs::rename(&target, &displaced).map_err(|error| error.to_string())?;
            symlink(&outside, &target).map_err(|error| error.to_string())
        })
        .unwrap();

        assert_eq!(bytes, b"inside\n");
        assert_ne!(bytes, b"outside sentinel\n");
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

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn atomic_exchange_restores_a_regular_leaf_swapped_after_verification() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("bundle");
        fs::create_dir(&root).unwrap();
        let target = root.join("target.md");
        let displaced_original = root.join("original.md");
        fs::write(&target, "before\n").unwrap();
        let plan = plan_files(
            &root,
            vec![RenderedFile {
                relative_path: "target.md".to_owned(),
                encoding: "utf8",
                content: "generated\n".to_owned(),
            }],
            PlanMode::MergeAgent,
        )
        .unwrap();
        let root_directory = open_anchored_root(&root).unwrap();
        let (parent, leaf) = open_anchored_parent(&root_directory, "target.md", false)
            .unwrap()
            .unwrap();

        let result = replace_anchored_file_with_hook(&parent, &leaf, "before\n", &plan[0], || {
            fs::rename(&target, &displaced_original).map_err(|error| error.to_string())?;
            fs::write(&target, "concurrent\n").map_err(|error| error.to_string())
        });

        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "concurrent\n");
        assert_eq!(fs::read_to_string(displaced_original).unwrap(), "before\n");
        let retained = fs::read_dir(root)
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".okf-workbench-")
            })
            .unwrap();
        assert_eq!(fs::read_to_string(retained.path()).unwrap(), "generated\n");
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn atomic_exchange_retains_the_verified_displaced_file_instead_of_racy_cleanup() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("bundle");
        fs::create_dir(&root).unwrap();
        let target = root.join("target.md");
        fs::write(&target, "before\n").unwrap();
        let change = PlannedChange {
            target: target.clone(),
            relative_path: "target.md".to_owned(),
            operation: "update",
            byte_length: 6,
            content: "after\n".to_owned(),
            expected_content: Some("before\n".to_owned()),
        };
        let root_directory = open_anchored_root(&root).unwrap();
        let (parent, leaf) = open_anchored_parent(&root_directory, "target.md", false)
            .unwrap()
            .unwrap();

        replace_anchored_file(&parent, &leaf, "before\n", &change).unwrap();

        assert_eq!(fs::read_to_string(target).unwrap(), "after\n");
        let retained = fs::read_dir(root)
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".okf-workbench-")
            })
            .unwrap();
        assert_eq!(fs::read_to_string(retained.path()).unwrap(), "before\n");
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn failed_create_write_never_publishes_a_partial_leaf() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("bundle");
        fs::create_dir(&root).unwrap();
        let change = PlannedChange {
            target: root.join("new.md"),
            relative_path: "new.md".to_owned(),
            operation: "create",
            byte_length: 9,
            content: "complete\n".to_owned(),
            expected_content: None,
        };
        let root_directory = open_anchored_root(&root).unwrap();
        let (parent, leaf) = open_anchored_parent(&root_directory, "new.md", false)
            .unwrap()
            .unwrap();

        let result = create_anchored_file_with_writer(&parent, &leaf, &change, |file| {
            file.write_all(b"partial").unwrap();
            Err("injected write failure".to_owned())
        });

        assert!(result.is_err());
        assert!(!root.join("new.md").exists());
        let retained = fs::read_dir(root)
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".okf-workbench-")
            })
            .unwrap();
        assert_eq!(fs::read(retained.path()).unwrap(), b"partial");
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
