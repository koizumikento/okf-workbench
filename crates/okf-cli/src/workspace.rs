use okf_core::{
    BundleDocumentInput, DocumentContent, ParseBundleInput, RenderedFile, parse_bundle,
};
use serde::Serialize;
#[cfg(not(unix))]
use std::fs::OpenOptions;
#[cfg(unix)]
use std::os::unix::{ffi::OsStringExt, fs::MetadataExt};
use std::{
    ffi::{OsStr, OsString},
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
#[cfg(all(not(unix), not(windows)))]
use walkdir::WalkDir;

#[cfg(windows)]
use std::os::windows::{
    ffi::OsStrExt,
    fs::{MetadataExt as _, OpenOptionsExt},
    io::AsRawHandle,
};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO_EX,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ,
    FILE_GENERIC_WRITE, FILE_READ_ATTRIBUTES, FILE_RENAME_INFO, FILE_RENAME_INFO_0,
    FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE, FileDispositionInfoEx, FileRenameInfoEx,
    GetFileInformationByHandle, SYNCHRONIZE, SetFileInformationByHandle,
};

#[cfg(target_os = "linux")]
use rustix::fs::{AtFlags, linkat};
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
    #[serde(skip)]
    planned_root: Option<PlannedRootIdentity>,
    #[serde(skip)]
    expected_identity: Option<ObjectIdentity>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ObjectIdentity {
    first: u64,
    second: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum PlannedRootIdentity {
    Existing {
        requested: PathBuf,
        identity: ObjectIdentity,
    },
    Missing {
        requested: PathBuf,
        anchor: PathBuf,
        anchor_identity: ObjectIdentity,
        components: Vec<OsString>,
    },
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
    collect_windows_documents(&root, Path::new(""), &mut locks, &mut documents)?;
    Ok(ParseBundleInput {
        root_uri: file_uri(&root),
        invalid_root_uri_utf16: None,
        revision: 1,
        documents,
    })
}

#[cfg(windows)]
fn collect_windows_documents(
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
            collect_windows_documents(&path, &relative, locks, documents)?;
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
    let planned_root = capture_planned_root_identity(root)?;
    let mut plan = Vec::new();
    for file in files {
        validate_relative_path(&file.relative_path)?;
        let target = root.join(&file.relative_path);
        ensure_contained(root, &target)?;
        ensure_safe_parent_chain(root, &target)?;
        let mut expected_identity = None;
        let existing = match fs::symlink_metadata(&target) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(format!("unsafe existing target {}", target.display()));
                }
                let identity = path_object_identity(&target)?;
                let content = fs::read_to_string(&target).map_err(|error| error.to_string())?;
                let after = fs::symlink_metadata(&target).map_err(|error| {
                    format!(
                        "cannot revalidate planned target {}: {error}",
                        target.display()
                    )
                })?;
                if after.file_type().is_symlink() || !after.is_file() {
                    return Err(format!(
                        "{} changed to an unsafe target while the plan was being prepared",
                        target.display()
                    ));
                }
                if path_object_identity(&target)? != identity {
                    return Err(format!(
                        "{} changed while the plan was being prepared",
                        target.display()
                    ));
                }
                expected_identity = Some(identity);
                Some(content)
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
            planned_root: Some(planned_root.clone()),
            expected_identity,
        });
    }
    plan.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(plan)
}

fn capture_planned_root_identity(root: &Path) -> Result<PlannedRootIdentity, String> {
    match fs::symlink_metadata(root) {
        Ok(_) => {
            ensure_safe_root(root)?;
            Ok(PlannedRootIdentity::Existing {
                requested: root.to_path_buf(),
                identity: path_object_identity(root)?,
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let absolute_root = std::path::absolute(root)
                .map_err(|error| format!("cannot make {} absolute: {error}", root.display()))?;
            let mut anchor = absolute_root.as_path();
            loop {
                anchor = anchor.parent().ok_or_else(|| {
                    format!("{} has no existing directory ancestor", root.display())
                })?;
                match fs::symlink_metadata(anchor) {
                    Ok(metadata) if metadata.file_type().is_symlink() => {
                        if is_trusted_platform_path_alias(anchor) {
                            break;
                        }
                        return Err(format!("{} is not a real directory", anchor.display()));
                    }
                    Ok(metadata) if metadata.is_dir() => break,
                    Ok(_) => return Err(format!("{} is not a real directory", anchor.display())),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.to_string()),
                }
            }
            ensure_safe_root(anchor)?;
            let canonical_anchor = anchor
                .canonicalize()
                .map_err(|error| format!("cannot anchor {}: {error}", anchor.display()))?;
            let anchor_identity = path_object_identity(&canonical_anchor)?;
            let components = absolute_root
                .strip_prefix(anchor)
                .map_err(|_| "new root escapes its existing ancestor".to_owned())?
                .components()
                .map(|component| match component {
                    Component::Normal(value) => Ok(value.to_os_string()),
                    _ => Err("new root contains a non-relative component".to_owned()),
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(PlannedRootIdentity::Missing {
                requested: root.to_path_buf(),
                anchor: canonical_anchor,
                anchor_identity,
                components,
            })
        }
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(unix)]
fn path_object_identity(path: &Path) -> Result<ObjectIdentity, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    Ok(ObjectIdentity {
        first: metadata.dev(),
        second: metadata.ino(),
    })
}

#[cfg(windows)]
fn path_object_identity(path: &Path) -> Result<ObjectIdentity, String> {
    let file = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES | SYNCHRONIZE)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| format!("cannot open {} for identity: {error}", path.display()))?;
    file_object_identity(&file)
}

#[cfg(all(not(unix), not(windows)))]
fn path_object_identity(_path: &Path) -> Result<ObjectIdentity, String> {
    Err("stable filesystem identity is unavailable on this platform".to_owned())
}

#[cfg(unix)]
fn file_object_identity(file: &File) -> Result<ObjectIdentity, String> {
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    Ok(ObjectIdentity {
        first: metadata.dev(),
        second: metadata.ino(),
    })
}

#[cfg(windows)]
fn file_object_identity(file: &File) -> Result<ObjectIdentity, String> {
    let mut information = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    // SAFETY: `file` is live and the output points to initialized, writable storage of the
    // structure size required by GetFileInformationByHandle.
    let succeeded =
        unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) };
    if succeeded == 0 {
        return Err(format!(
            "cannot read Windows file identity: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: a successful call initializes the entire output structure.
    let information = unsafe { information.assume_init() };
    Ok(ObjectIdentity {
        first: u64::from(information.dwVolumeSerialNumber),
        second: (u64::from(information.nFileIndexHigh) << 32)
            | u64::from(information.nFileIndexLow),
    })
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
    if plan
        .iter()
        .any(|change| change.expected_content.is_some() && change.expected_identity.is_none())
    {
        return Err("write plan is missing an existing-file identity".to_owned());
    }
    if plan.iter().any(|change| change.expected_content.is_some()) {
        return Err(
            "conditional replacement is unavailable without a filesystem generation-CAS primitive; no changes were written"
                .to_owned(),
        );
    }
    if plan.is_empty() {
        return Ok(());
    }

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

fn planned_root_for_apply(plan: &[PlannedChange]) -> Result<&PlannedRootIdentity, String> {
    let planned = plan
        .first()
        .and_then(|change| change.planned_root.as_ref())
        .ok_or_else(|| "write plan is missing its root identity".to_owned())?;
    if plan
        .iter()
        .any(|change| change.planned_root.as_ref() != Some(planned))
    {
        return Err("write plan contains inconsistent root identities".to_owned());
    }
    Ok(planned)
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
        if change.operation != "create" {
            return Err(
                "conditional replacement is unavailable on this platform; no file was changed"
                    .to_owned(),
            );
        }
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&change.target)
            .map_err(|error| format!("cannot create {}: {error}", change.target.display()))?;
        file.write_all(change.content.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(windows)]
fn apply_plan_windows(root: &Path, plan: &[PlannedChange]) -> Result<(), String> {
    let (root, _root_locks) =
        windows_open_or_create_planned_root(root, planned_root_for_apply(plan)?)?;
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
fn windows_open_or_create_planned_root(
    root: &Path,
    planned: &PlannedRootIdentity,
) -> Result<(PathBuf, Vec<File>), String> {
    match planned {
        PlannedRootIdentity::Existing {
            requested,
            identity,
        } => {
            if requested != root {
                return Err("write plan root does not match the requested root".to_owned());
            }
            let (absolute, locks) = windows_anchor_directory(root, false)?;
            let anchored = locks
                .last()
                .ok_or_else(|| "Windows root anchor is empty".to_owned())?;
            if file_object_identity(anchored)? != *identity {
                return Err(format!(
                    "bundle root {} changed after planning; no changes were written",
                    root.display()
                ));
            }
            Ok((absolute, locks))
        }
        PlannedRootIdentity::Missing {
            requested,
            anchor,
            anchor_identity,
            components,
        } => {
            if requested != root {
                return Err("write plan root does not match the requested root".to_owned());
            }
            let (_anchor, mut locks) = windows_anchor_directory(anchor, false)?;
            let anchored = locks
                .last()
                .ok_or_else(|| "Windows root ancestor anchor is empty".to_owned())?;
            if file_object_identity(anchored)? != *anchor_identity {
                return Err(format!(
                    "root ancestor {} changed after planning; no changes were written",
                    anchor.display()
                ));
            }
            let mut current = anchor.clone();
            for component in components {
                current.push(component);
                fs::create_dir(&current).map_err(|error| {
                    if error.kind() == std::io::ErrorKind::AlreadyExists {
                        format!(
                            "root component {component:?} appeared after planning; no changes were written"
                        )
                    } else {
                        format!("cannot create {}: {error}", current.display())
                    }
                })?;
                locks.push(open_windows_directory_lock(&current)?);
            }
            Ok((root.to_path_buf(), locks))
        }
    }
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
        Some(_) => {
            Err("conditional replacement is unavailable on Windows; no file was changed".to_owned())
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
        Some(_) => {
            Err("conditional replacement is unavailable on Windows; no file was changed".to_owned())
        }
    }
}

#[cfg(windows)]
fn create_windows_file(parent: &Path, leaf: &OsStr, change: &PlannedChange) -> Result<(), String> {
    create_windows_file_with_writer(
        parent,
        leaf,
        change,
        |file| {
            file.write_all(change.content.as_bytes())
                .map_err(|error| error.to_string())
        },
        || Ok(()),
    )
}

#[cfg(windows)]
fn create_windows_file_with_writer(
    parent: &Path,
    leaf: &OsStr,
    change: &PlannedChange,
    write_content: impl FnOnce(&mut File) -> Result<(), String>,
    before_publish: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
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
        write_content(&mut temporary)?;
        temporary.sync_all().map_err(|error| error.to_string())?;
        before_publish()?;
        rename_windows_handle(&temporary, &parent_handle, leaf).map_err(|error| {
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
fn windows_metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(windows)]
fn create_windows_temporary(parent: &Path) -> Result<(PathBuf, File), String> {
    // One fixed reservation bounds interruption residue to at most one pathname per directory.
    // A pre-existing reservation is never removed by pathname: it may belong to another process,
    // so this attempt fails closed instead of racing its cleanup.
    let path = parent.join(".okf-workbench-staging.tmp");
    let file = OpenOptions::new()
        .create_new(true)
        .access_mode(FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE | SYNCHRONIZE)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(&path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                format!(
                    "bounded staging reservation {} already exists; confirm no okf process is using it, remove it, and retry; no file was written",
                    path.display()
                )
            } else {
                format!("cannot reserve bounded temporary file: {error}")
            }
        })?;
    Ok((path, file))
}

#[cfg(windows)]
fn rename_windows_handle(file: &File, parent: &File, leaf: &OsStr) -> Result<(), String> {
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
    // SAFETY: `buffer` is word-aligned and large enough for the fixed header plus `name_bytes`.
    // Both file handles remain live for the call and the UTF-16 filename contains no terminator.
    let succeeded = unsafe {
        (*info).Anonymous = FILE_RENAME_INFO_0 { Flags: 0 };
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
    let root_directory = open_or_create_anchored_root(root, planned_root_for_apply(plan)?)?;
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
fn open_or_create_anchored_root(
    root: &Path,
    planned: &PlannedRootIdentity,
) -> Result<File, String> {
    open_or_create_anchored_root_with_hook(root, planned, || Ok(()))
}

#[cfg(unix)]
fn open_or_create_anchored_root_with_hook(
    root: &Path,
    planned: &PlannedRootIdentity,
    after_anchor: impl FnOnce() -> Result<(), String>,
) -> Result<File, String> {
    match planned {
        PlannedRootIdentity::Existing {
            requested,
            identity,
        } => {
            if requested != root {
                return Err("write plan root does not match the requested root".to_owned());
            }
            let directory = open_anchored_root(root)?;
            if file_object_identity(&directory)? != *identity {
                return Err(format!(
                    "bundle root {} changed after planning; no changes were written",
                    root.display()
                ));
            }
            after_anchor()?;
            Ok(directory)
        }
        PlannedRootIdentity::Missing {
            requested,
            anchor,
            anchor_identity,
            components,
        } => {
            if requested != root {
                return Err("write plan root does not match the requested root".to_owned());
            }
            let mut directory = open_anchored_root(anchor)?;
            if file_object_identity(&directory)? != *anchor_identity {
                return Err(format!(
                    "root ancestor {} changed after planning; no changes were written",
                    anchor.display()
                ));
            }
            after_anchor()?;
            for component in components {
                mkdirat(&directory, component, Mode::from_raw_mode(0o755)).map_err(|error| {
                    if error == Errno::EXIST {
                        format!(
                            "root component {component:?} appeared after planning; no changes were written"
                        )
                    } else {
                        format!("cannot create root component {component:?}: {error}")
                    }
                })?;
                directory = File::from(
                    openat(
                        &directory,
                        component,
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
    }
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
        Some(_) => Err(
            "conditional replacement is unavailable on this Unix platform; no file was changed"
                .to_owned(),
        ),
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
        Some(_) => Err(
            "conditional replacement is unavailable on this Unix platform; no file was changed"
                .to_owned(),
        ),
    }
}

#[cfg(unix)]
fn create_anchored_file(parent: &File, leaf: &OsStr, change: &PlannedChange) -> Result<(), String> {
    create_anchored_file_with_writer(parent, leaf, change, |file| {
        file.write_all(change.content.as_bytes())
            .map_err(|error| error.to_string())
    })
}

#[cfg(target_os = "linux")]
fn create_anchored_file_with_writer(
    parent: &File,
    leaf: &OsStr,
    change: &PlannedChange,
    write_content: impl FnOnce(&mut File) -> Result<(), String>,
) -> Result<(), String> {
    let mut temporary = File::from(
        openat(
            parent,
            ".",
            OFlags::RDWR | OFlags::TMPFILE | OFlags::CLOEXEC,
            Mode::from_raw_mode(0o666),
        )
        .map_err(|error| {
            format!("anonymous staging is unavailable in the target directory: {error}")
        })?,
    );
    write_content(&mut temporary)?;
    temporary.sync_all().map_err(|error| error.to_string())?;
    linkat(&temporary, "", parent, leaf, AtFlags::EMPTY_PATH).map_err(|error| {
        format!(
            "{} appeared after planning; no file was published: {error}",
            change.target.display()
        )
    })
}

#[cfg(target_os = "macos")]
fn create_anchored_file_with_writer(
    parent: &File,
    leaf: &OsStr,
    change: &PlannedChange,
    write_content: impl FnOnce(&mut File) -> Result<(), String>,
) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;

    let mut temporary = tempfile::tempfile().map_err(|error| error.to_string())?;
    write_content(&mut temporary)?;
    temporary.sync_all().map_err(|error| error.to_string())?;
    let leaf = std::ffi::CString::new(leaf.as_bytes())
        .map_err(|_| "generated filename contains NUL".to_owned())?;
    // SAFETY: both descriptors are live, `leaf` is NUL-terminated, and flags=0 requests the
    // platform's no-overwrite clone. The source is an already unlinked system temporary file, so
    // no bundle-visible staging pathname can accumulate after interruption.
    let result =
        unsafe { libc::fclonefileat(temporary.as_raw_fd(), parent.as_raw_fd(), leaf.as_ptr(), 0) };
    if result == 0 {
        Ok(())
    } else {
        Err(format!(
            "{} appeared after planning or atomic clone publication is unavailable: {}",
            change.target.display(),
            std::io::Error::last_os_error()
        ))
    }
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn create_anchored_file_with_writer(
    _parent: &File,
    _leaf: &OsStr,
    _change: &PlannedChange,
    _write_content: impl FnOnce(&mut File) -> Result<(), String>,
) -> Result<(), String> {
    Err("anonymous atomic create publication is unavailable on this Unix platform".to_owned())
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

#[cfg(all(not(unix), not(windows)))]
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

    #[test]
    fn root_replacement_during_confirmation_fails_before_any_write() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("bundle");
        let planned_root = directory.path().join("planned-bundle");
        fs::create_dir(&root).unwrap();
        let plan = plan_files(
            &root,
            vec![RenderedFile {
                relative_path: "new.md".to_owned(),
                encoding: "utf8",
                content: "safe content\n".to_owned(),
            }],
            PlanMode::CreateOnly,
        )
        .unwrap();

        // This is the same gap as an interactive plan/confirmation/apply sequence.
        fs::rename(&root, &planned_root).unwrap();
        fs::create_dir(&root).unwrap();

        let error = apply_plan(&root, &plan).unwrap_err();

        assert!(error.contains("changed after planning"), "{error}");
        assert!(!root.join("new.md").exists());
        assert!(!planned_root.join("new.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn missing_root_symlink_interposition_fails_before_any_outside_write() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().unwrap();
        let root = directory.path().join("new-root");
        let outside = directory.path().join("outside");
        fs::create_dir(&outside).unwrap();

        let planned = capture_planned_root_identity(&root).unwrap();
        let result = open_or_create_anchored_root_with_hook(&root, &planned, || {
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

    #[test]
    fn update_plan_fails_before_any_create_or_metadata_change() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("bundle");
        fs::create_dir(&root).unwrap();
        let target = root.join("z-existing.md");
        fs::write(&target, "before\n").unwrap();
        let before = fs::metadata(&target).unwrap();
        let plan = plan_files(
            &root,
            vec![
                RenderedFile {
                    relative_path: "a-new.md".to_owned(),
                    encoding: "utf8",
                    content: "new\n".to_owned(),
                },
                RenderedFile {
                    relative_path: "z-existing.md".to_owned(),
                    encoding: "utf8",
                    content: "after\n".to_owned(),
                },
            ],
            PlanMode::MergeAgent,
        )
        .unwrap();

        let error = apply_plan(&root, &plan).unwrap_err();

        assert!(error.contains("generation-CAS"), "{error}");
        assert_eq!(fs::read_to_string(&target).unwrap(), "before\n");
        assert_eq!(
            fs::metadata(&target).unwrap().modified().unwrap(),
            before.modified().unwrap()
        );
        assert!(!root.join("a-new.md").exists());
        assert_eq!(fs::read_dir(root).unwrap().count(), 1);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn failed_create_write_has_no_visible_staging_or_partial_leaf() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("bundle");
        fs::create_dir(&root).unwrap();
        let plan = plan_files(
            &root,
            vec![RenderedFile {
                relative_path: "new.md".to_owned(),
                encoding: "utf8",
                content: "complete\n".to_owned(),
            }],
            PlanMode::CreateOnly,
        )
        .unwrap();
        let change = &plan[0];
        let root_directory = open_anchored_root(&root).unwrap();
        let (parent, leaf) = open_anchored_parent(&root_directory, "new.md", false)
            .unwrap()
            .unwrap();

        let result = create_anchored_file_with_writer(&parent, &leaf, change, |file| {
            file.write_all(b"partial").unwrap();
            assert!(!root.join("new.md").exists());
            assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
            Err("injected write failure".to_owned())
        });

        assert!(result.is_err());
        assert!(!root.join("new.md").exists());
        assert_eq!(fs::read_dir(root).unwrap().count(), 0);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn leaf_appearing_after_staging_is_never_overwritten() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("bundle");
        fs::create_dir(&root).unwrap();
        let plan = plan_files(
            &root,
            vec![RenderedFile {
                relative_path: "new.md".to_owned(),
                encoding: "utf8",
                content: "generated\n".to_owned(),
            }],
            PlanMode::CreateOnly,
        )
        .unwrap();
        let root_directory = open_anchored_root(&root).unwrap();
        let (parent, leaf) = open_anchored_parent(&root_directory, "new.md", false)
            .unwrap()
            .unwrap();

        let result = create_anchored_file_with_writer(&parent, &leaf, &plan[0], |file| {
            file.write_all(b"generated\n").unwrap();
            fs::write(root.join("new.md"), "concurrent\n").map_err(|error| error.to_string())
        });

        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(root.join("new.md")).unwrap(),
            "concurrent\n"
        );
        assert_eq!(fs::read_dir(root).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn windows_existing_staging_reservation_is_not_removed_or_overwritten() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("bundle");
        fs::create_dir(&root).unwrap();
        let reservation = root.join(".okf-workbench-staging.tmp");
        fs::write(&reservation, "other process\n").unwrap();
        let plan = plan_files(
            &root,
            vec![RenderedFile {
                relative_path: "new.md".to_owned(),
                encoding: "utf8",
                content: "generated\n".to_owned(),
            }],
            PlanMode::CreateOnly,
        )
        .unwrap();

        let error = create_windows_file(&root, OsStr::new("new.md"), &plan[0]).unwrap_err();

        assert!(error.contains("already exists"), "{error}");
        assert_eq!(fs::read_to_string(reservation).unwrap(), "other process\n");
        assert!(!root.join("new.md").exists());
    }

    #[cfg(windows)]
    #[test]
    fn windows_handled_write_failure_removes_its_staging_reservation() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("bundle");
        fs::create_dir(&root).unwrap();
        let plan = plan_files(
            &root,
            vec![RenderedFile {
                relative_path: "new.md".to_owned(),
                encoding: "utf8",
                content: "generated\n".to_owned(),
            }],
            PlanMode::CreateOnly,
        )
        .unwrap();

        let result = create_windows_file_with_writer(
            &root,
            OsStr::new("new.md"),
            &plan[0],
            |file| {
                file.write_all(b"partial").unwrap();
                Err("injected write failure".to_owned())
            },
            || Ok(()),
        );

        assert!(result.is_err());
        assert!(!root.join("new.md").exists());
        assert!(!root.join(".okf-workbench-staging.tmp").exists());
    }

    #[cfg(windows)]
    #[test]
    fn windows_leaf_appearing_after_staging_is_never_overwritten() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("bundle");
        fs::create_dir(&root).unwrap();
        let plan = plan_files(
            &root,
            vec![RenderedFile {
                relative_path: "new.md".to_owned(),
                encoding: "utf8",
                content: "generated\n".to_owned(),
            }],
            PlanMode::CreateOnly,
        )
        .unwrap();

        let result = create_windows_file_with_writer(
            &root,
            OsStr::new("new.md"),
            &plan[0],
            |file| {
                file.write_all(b"generated\n")
                    .map_err(|error| error.to_string())
            },
            || fs::write(root.join("new.md"), "concurrent\n").map_err(|error| error.to_string()),
        );

        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(root.join("new.md")).unwrap(),
            "concurrent\n"
        );
        assert!(!root.join(".okf-workbench-staging.tmp").exists());
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
