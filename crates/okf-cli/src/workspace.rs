use okf_core::{
    BundleDocumentInput, DocumentContent, ParseBundleInput, RenderedFile, is_future_minor_version,
    parse_bundle,
};
use serde::Serialize;
#[cfg(windows)]
use std::collections::HashSet;
#[cfg(any(not(unix), target_os = "macos"))]
use std::fs::OpenOptions;
#[cfg(unix)]
use std::os::unix::{ffi::OsStringExt, fs::MetadataExt};
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::Arc,
};
#[cfg(all(not(unix), not(windows)))]
use walkdir::WalkDir;

#[cfg(windows)]
use std::os::windows::{
    ffi::OsStrExt,
    fs::{MetadataExt as _, OpenOptionsExt},
    io::{AsRawHandle, FromRawHandle},
};
#[cfg(windows)]
use windows_sys::Wdk::{
    Foundation::OBJECT_ATTRIBUTES,
    Storage::FileSystem::{
        FILE_CREATE, FILE_DIRECTORY_FILE, FILE_SYNCHRONOUS_IO_NONALERT, NtCreateFile,
    },
};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO_EX,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ,
    FILE_GENERIC_WRITE, FILE_READ_ATTRIBUTES, FILE_RENAME_INFO, FILE_RENAME_INFO_0,
    FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE, FileDispositionInfoEx, FileRenameInfo,
    GetFileInformationByHandle, SYNCHRONIZE, SetFileInformationByHandle,
};
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{
        INVALID_HANDLE_VALUE, OBJ_CASE_INSENSITIVE, RtlNtStatusToDosError, STATUS_PENDING,
        STATUS_SUCCESS, UNICODE_STRING,
    },
    System::IO::IO_STATUS_BLOCK,
};

#[cfg(target_os = "linux")]
use rustix::fs::{RenameFlags, linkat, renameat_with};
#[cfg(target_os = "macos")]
use rustix::fs::{RenameFlags, renameat_with};
#[cfg(unix)]
use rustix::{
    fs::{AtFlags, Mode, OFlags, mkdirat, open, openat, unlinkat},
    io::Errno,
};

const MAX_DOCUMENTS: usize = 2_000;
const MAX_DOCUMENT_BYTES: u64 = 320 * 1024 + 16;
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn update_staging_hash(hash: &mut u128, bytes: &[u8]) {
    const FNV_128_PRIME: u128 = 0x0000_0000_0100_0000_0000_0000_0000_013b;
    for byte in bytes {
        *hash ^= u128::from(*byte);
        *hash = hash.wrapping_mul(FNV_128_PRIME);
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn anchor_coordination_name(planned: &PlannedRootIdentity) -> Result<OsString, String> {
    const FNV_128_OFFSET: u128 = 0x6c62_272e_07bb_0142_62b8_2175_6295_c58d;
    let PlannedRootIdentity::Missing {
        anchor_identity, ..
    } = planned
    else {
        return Err("missing-root staging requires a missing-root plan".to_owned());
    };
    let mut hash = FNV_128_OFFSET;
    update_staging_hash(&mut hash, &anchor_identity.first.to_le_bytes());
    update_staging_hash(&mut hash, &anchor_identity.second.to_le_bytes());
    // A dot plus zero-padded ASCII decimal digits has no case variants or canonical Unicode
    // aliases on the supported filesystems. The anchor-wide key intentionally serializes every
    // missing-root publication below the same existing directory.
    Ok(format!(".{hash:039}").into())
}

#[cfg(windows)]
fn windows_root_staging_name() -> &'static OsStr {
    // This is itself a valid 8.3 name. Windows therefore has no distinct generated short-name
    // alias that could expose the private directory through another requested component.
    OsStr::new("00000000.000")
}

#[cfg(windows)]
fn windows_reservation_name_matches_requested(reservation: &OsStr, requested: &OsStr) -> bool {
    let reservation = reservation.encode_wide().collect::<Vec<_>>();
    let mut requested = requested.encode_wide().collect::<Vec<_>>();
    // Win32 normalizes trailing ASCII dots and spaces away when opening a component. Reject those
    // aliases before the private reservation can become visible through the requested spelling.
    while requested
        .last()
        .is_some_and(|unit| *unit == u16::from(b'.') || *unit == u16::from(b' '))
    {
        requested.pop();
    }
    if reservation.len() != requested.len() {
        return false;
    }
    reservation.iter().zip(requested).all(|(left, right)| {
        let left = u8::try_from(*left).ok();
        let right = u8::try_from(right).ok();
        match (left, right) {
            (Some(left), Some(right)) => left.eq_ignore_ascii_case(&right),
            _ => false,
        }
    })
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn fresh_unix_root_staging_name() -> Result<OsString, String> {
    const PREFIX: &str = ".okf-workbench-root-staging-";
    let mut entropy = [0_u8; 16];
    getrandom::fill(&mut entropy)
        .map_err(|error| format!("cannot generate a private staging name: {error}"))?;
    let mut name = String::with_capacity(PREFIX.len() + entropy.len() * 2);
    name.push_str(PREFIX);
    for byte in entropy {
        use std::fmt::Write as _;
        write!(name, "{byte:02x}").unwrap();
    }
    Ok(name.into())
}

#[derive(Clone, Copy, Debug)]
pub enum PlanMode {
    CreateOnly,
    MergeIndexes {
        ensure_root_version: bool,
        update_existing_regions: bool,
    },
    MergeAgent,
    ReplaceExisting,
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
    planned_root: Option<Arc<PlannedRootIdentity>>,
    #[serde(skip)]
    expected_identity: Option<ObjectIdentity>,
    #[cfg(windows)]
    #[serde(skip)]
    planned_parent: Option<Arc<WindowsPlannedParent>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ObjectIdentity {
    first: u64,
    second: u64,
}

#[derive(Debug)]
enum PlannedRootIdentity {
    Existing {
        requested: PathBuf,
        identity: ObjectIdentity,
        anchor: Arc<PlannedRootAnchor>,
        index: PlannedIndexIdentity,
    },
    Missing {
        requested: PathBuf,
        anchor: PathBuf,
        anchor_identity: ObjectIdentity,
        components: Vec<OsString>,
        handle: Arc<PlannedRootAnchor>,
    },
}

#[derive(Debug)]
struct PlannedRootAnchor {
    #[cfg(unix)]
    directory: File,
    #[cfg(windows)]
    locks: Vec<File>,
}

#[derive(Debug)]
enum PlannedIndexIdentity {
    Missing,
    Existing {
        file: File,
        identity: ObjectIdentity,
        bytes: Vec<u8>,
    },
}

#[cfg(windows)]
#[derive(Debug)]
struct WindowsPlannedParent {
    path: PathBuf,
    identity: ObjectIdentity,
    locks: Vec<File>,
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
    plan_files_with_expected(root, files, mode, None)
}

pub fn plan_replacement_files(
    root: &Path,
    files: Vec<RenderedFile>,
    expected_contents: &BTreeMap<String, String>,
) -> Result<Vec<PlannedChange>, String> {
    plan_files_with_expected(
        root,
        files,
        PlanMode::ReplaceExisting,
        Some(expected_contents),
    )
}

fn plan_files_with_expected(
    root: &Path,
    files: Vec<RenderedFile>,
    mode: PlanMode,
    expected_contents: Option<&BTreeMap<String, String>>,
) -> Result<Vec<PlannedChange>, String> {
    let planned_root = capture_planned_root_identity(root)?;
    #[cfg(windows)]
    let mut planned_parents = BTreeMap::<PathBuf, Arc<WindowsPlannedParent>>::new();
    let mut plan = Vec::new();
    for file in files {
        if matches!(mode, PlanMode::ReplaceExisting) {
            validate_existing_relative_path(&file.relative_path)?;
        } else {
            validate_relative_path(&file.relative_path)?;
        }
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
        if matches!(mode, PlanMode::ReplaceExisting) {
            let expected = expected_contents
                .and_then(|contents| contents.get(&file.relative_path))
                .ok_or_else(|| {
                    format!(
                        "{} is missing its migration source snapshot; no file was changed",
                        target.display()
                    )
                })?;
            if existing.as_ref() != Some(expected) {
                return Err(format!(
                    "{} changed after migration planning; no file was changed",
                    target.display()
                ));
            }
        }
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
            (Some(_), PlanMode::ReplaceExisting, _) => file.content,
            (None, PlanMode::ReplaceExisting, _) => {
                return Err(format!(
                    "{} no longer exists; no file was changed",
                    target.display()
                ));
            }
            (Some(_), _, _) => file.content,
            (None, _, _) => file.content,
        };
        if existing.as_deref() == Some(content.as_str()) {
            continue;
        }
        #[cfg(windows)]
        let planned_parent = if existing.is_none()
            && matches!(planned_root.as_ref(), PlannedRootIdentity::Existing { .. })
        {
            let parent = target
                .parent()
                .ok_or_else(|| format!("{} has no parent", target.display()))?;
            let absolute_parent = platform_absolute_root(parent)?;
            if let Some(planned_parent) = planned_parents.get(&absolute_parent) {
                Some(planned_parent.clone())
            } else {
                let planned_parent = capture_windows_planned_parent(parent)?;
                planned_parents.insert(absolute_parent, planned_parent.clone());
                Some(planned_parent)
            }
        } else {
            None
        };
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
            #[cfg(windows)]
            planned_parent,
        });
    }
    if !matches!(mode, PlanMode::ReplaceExisting) {
        plan.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    }
    Ok(plan)
}

fn capture_planned_root_identity(root: &Path) -> Result<Arc<PlannedRootIdentity>, String> {
    let absolute_root = platform_absolute_root(root)?;
    match fs::symlink_metadata(&absolute_root) {
        Ok(_) => {
            let anchor = capture_root_anchor(&absolute_root)?;
            let identity = root_anchor_identity(&anchor)?;
            let index = capture_planned_index(&anchor, &absolute_root)?;
            Ok(Arc::new(PlannedRootIdentity::Existing {
                requested: root.to_path_buf(),
                identity,
                anchor,
                index,
            }))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut anchor_path = absolute_root.as_path();
            loop {
                anchor_path = anchor_path.parent().ok_or_else(|| {
                    format!("{} has no existing directory ancestor", root.display())
                })?;
                match fs::symlink_metadata(anchor_path) {
                    Ok(metadata) if metadata.file_type().is_symlink() => {
                        return Err(format!("{} is not a real directory", anchor_path.display()));
                    }
                    Ok(metadata) if metadata.is_dir() => break,
                    Ok(_) => {
                        return Err(format!("{} is not a real directory", anchor_path.display()));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.to_string()),
                }
            }
            let handle = capture_missing_root_anchor(anchor_path)?;
            let anchor_identity = root_anchor_identity(&handle)?;
            let components = absolute_root
                .strip_prefix(anchor_path)
                .map_err(|_| "new root escapes its existing ancestor".to_owned())?
                .components()
                .map(|component| match component {
                    Component::Normal(value) => Ok(value.to_os_string()),
                    _ => Err("new root contains a non-relative component".to_owned()),
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Arc::new(PlannedRootIdentity::Missing {
                requested: root.to_path_buf(),
                anchor: anchor_path.to_path_buf(),
                anchor_identity,
                components,
                handle,
            }))
        }
        Err(error) => Err(error.to_string()),
    }
}

fn platform_absolute_root(root: &Path) -> Result<PathBuf, String> {
    let absolute = std::path::absolute(root)
        .map_err(|error| format!("cannot make {} absolute: {error}", root.display()))?;
    #[cfg(target_os = "macos")]
    {
        for (alias, physical) in [
            (Path::new("/tmp"), Path::new("/private/tmp")),
            (Path::new("/var"), Path::new("/private/var")),
        ] {
            if let Ok(suffix) = absolute.strip_prefix(alias) {
                return Ok(physical.join(suffix));
            }
        }
    }
    Ok(absolute)
}

#[cfg(unix)]
fn capture_root_anchor(path: &Path) -> Result<Arc<PlannedRootAnchor>, String> {
    Ok(Arc::new(PlannedRootAnchor {
        directory: open_anchored_root(path)?,
    }))
}

#[cfg(unix)]
fn capture_missing_root_anchor(path: &Path) -> Result<Arc<PlannedRootAnchor>, String> {
    capture_root_anchor(path)
}

#[cfg(windows)]
fn capture_missing_root_anchor(path: &Path) -> Result<Arc<PlannedRootAnchor>, String> {
    let (_absolute, mut locks) = windows_anchor_directory(path, false)?;
    locks.push(open_windows_directory_strict_mutation_lock(path)?);
    Ok(Arc::new(PlannedRootAnchor { locks }))
}

#[cfg(all(not(unix), not(windows)))]
fn capture_missing_root_anchor(path: &Path) -> Result<Arc<PlannedRootAnchor>, String> {
    capture_root_anchor(path)
}

#[cfg(windows)]
fn capture_root_anchor(path: &Path) -> Result<Arc<PlannedRootAnchor>, String> {
    let (_absolute, locks) = windows_anchor_directory(path, false)?;
    Ok(Arc::new(PlannedRootAnchor { locks }))
}

#[cfg(all(not(unix), not(windows)))]
fn capture_root_anchor(_path: &Path) -> Result<Arc<PlannedRootAnchor>, String> {
    Err("stable filesystem anchors are unavailable on this platform".to_owned())
}

#[cfg(unix)]
fn root_anchor_identity(anchor: &PlannedRootAnchor) -> Result<ObjectIdentity, String> {
    file_object_identity(&anchor.directory)
}

#[cfg(windows)]
fn root_anchor_identity(anchor: &PlannedRootAnchor) -> Result<ObjectIdentity, String> {
    file_object_identity(
        anchor
            .locks
            .last()
            .ok_or_else(|| "Windows root anchor is empty".to_owned())?,
    )
}

#[cfg(unix)]
fn capture_planned_index(
    anchor: &PlannedRootAnchor,
    _root: &Path,
) -> Result<PlannedIndexIdentity, String> {
    match openat(
        &anchor.directory,
        "index.md",
        OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(file) => {
            let file = File::from(file);
            if !file
                .metadata()
                .map_err(|error| error.to_string())?
                .is_file()
            {
                return Err("write refused unsafe root index".to_owned());
            }
            Ok(PlannedIndexIdentity::Existing {
                identity: file_object_identity(&file)?,
                bytes: read_planned_index_bytes(&file)?,
                file,
            })
        }
        Err(Errno::NOENT) => Ok(PlannedIndexIdentity::Missing),
        Err(error) => Err(format!("write refused unsafe root index: {error}")),
    }
}

#[cfg(windows)]
fn capture_windows_planned_parent(parent: &Path) -> Result<Arc<WindowsPlannedParent>, String> {
    let (path, mut locks) = windows_anchor_directory(parent, false).map_err(|error| {
        format!(
            "generated parent {} must already exist for an atomic existing-root create: {error}",
            parent.display()
        )
    })?;
    locks.push(open_windows_directory_strict_mutation_lock(&path)?);
    let identity = file_object_identity(
        locks
            .last()
            .ok_or_else(|| "Windows generated parent anchor is empty".to_owned())?,
    )?;
    Ok(Arc::new(WindowsPlannedParent {
        path,
        identity,
        locks,
    }))
}

#[cfg(windows)]
fn capture_planned_index(
    _anchor: &PlannedRootAnchor,
    root: &Path,
) -> Result<PlannedIndexIdentity, String> {
    match open_windows_read_handle(&root.join("index.md")) {
        Ok(file) => {
            let metadata = file.metadata().map_err(|error| error.to_string())?;
            if windows_metadata_is_reparse(&metadata) || !metadata.is_file() {
                return Err("write refused unsafe root index".to_owned());
            }
            Ok(PlannedIndexIdentity::Existing {
                identity: file_object_identity(&file)?,
                bytes: read_planned_index_bytes(&file)?,
                file,
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(PlannedIndexIdentity::Missing)
        }
        Err(error) => Err(format!("write refused unsafe root index: {error}")),
    }
}

fn read_planned_index_bytes(file: &File) -> Result<Vec<u8>, String> {
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_DOCUMENT_BYTES {
        return Err("write refused because the root index is unsafe or too large".to_owned());
    }
    let mut reader = file.try_clone().map_err(|error| error.to_string())?;
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    reader
        .take(MAX_DOCUMENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err("write refused because the root index is too large".to_owned());
    }
    Ok(bytes)
}

#[cfg(all(not(unix), not(windows)))]
fn capture_planned_index(
    _anchor: &PlannedRootAnchor,
    _root: &Path,
) -> Result<PlannedIndexIdentity, String> {
    Ok(PlannedIndexIdentity::Missing)
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
    let planned_root = planned_root_for_apply(plan)?;
    let planned_requested = match planned_root {
        PlannedRootIdentity::Existing { requested, .. }
        | PlannedRootIdentity::Missing { requested, .. } => requested,
    };
    if planned_requested != root {
        return Err("write plan root does not match the requested root".to_owned());
    }
    if plan.len() > 1 && matches!(planned_root, PlannedRootIdentity::Existing { .. }) {
        return Err(
            "multiple creates in an existing root cannot be committed atomically; no changes were written"
                .to_owned(),
        );
    }
    validate_planned_root_version(planned_root)?;

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

fn validate_planned_root_version(planned: &PlannedRootIdentity) -> Result<(), String> {
    let PlannedRootIdentity::Existing {
        requested,
        anchor,
        index,
        ..
    } = planned
    else {
        return Ok(());
    };
    let mut documents = Vec::new();
    match index {
        PlannedIndexIdentity::Missing => ensure_planned_index_absent(anchor, requested)?,
        PlannedIndexIdentity::Existing {
            file,
            identity,
            bytes: planned_bytes,
        } => {
            ensure_planned_index_identity(anchor, requested, identity)?;
            let bytes = read_planned_index_bytes(file)?;
            if bytes != *planned_bytes {
                return Err(
                    "root index bytes changed after planning; no changes were written".to_owned(),
                );
            }
            ensure_planned_index_identity(anchor, requested, identity)?;
            documents.push(BundleDocumentInput {
                uri: file_uri(&platform_absolute_root(requested)?.join("index.md")),
                bundle_path: "index.md".to_owned(),
                content: Some(DocumentContent::Bytes(bytes)),
                content_hash: None,
                identity_only_failure: None,
                invalid_utf16_fields: None,
            });
        }
    }
    let bundle = parse_bundle(ParseBundleInput {
        root_uri: file_uri(&platform_absolute_root(requested)?),
        invalid_root_uri_utf16: None,
        revision: 1,
        documents,
    });
    if let Some(failure) = bundle.failures.first() {
        return Err(format!(
            "write refused because the root index cannot be inspected: {}",
            failure.message
        ));
    }
    let Some(index) = bundle.reserved_documents.first() else {
        return Ok(());
    };
    let Some(frontmatter) = &index.frontmatter else {
        return Ok(());
    };
    let Some(raw_version) = frontmatter.raw.get("okf_version") else {
        return Ok(());
    };
    let Some(version) = &index.okf_version else {
        return Err(format!(
            "write refused because `okf_version` is not a supported string: {raw_version}"
        ));
    };
    if matches!(version.as_str(), "0.1" | "0.2") || is_future_minor_version(version) {
        Ok(())
    } else {
        Err(format!(
            "write refused because the bundle declares unsupported OKF version {version:?}"
        ))
    }
}

#[cfg(unix)]
fn ensure_planned_index_absent(anchor: &PlannedRootAnchor, _root: &Path) -> Result<(), String> {
    match openat(
        &anchor.directory,
        "index.md",
        OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Err(Errno::NOENT) => Ok(()),
        Ok(_) => Err("root index appeared after planning; no changes were written".to_owned()),
        Err(error) => Err(format!("cannot revalidate planned root index: {error}")),
    }
}

#[cfg(unix)]
fn ensure_planned_index_identity(
    anchor: &PlannedRootAnchor,
    _root: &Path,
    expected: &ObjectIdentity,
) -> Result<(), String> {
    let current = File::from(
        openat(
            &anchor.directory,
            "index.md",
            OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| format!("cannot revalidate planned root index: {error}"))?,
    );
    if file_object_identity(&current)? == *expected {
        Ok(())
    } else {
        Err("root index changed after planning; no changes were written".to_owned())
    }
}

#[cfg(windows)]
fn ensure_planned_index_absent(_anchor: &PlannedRootAnchor, root: &Path) -> Result<(), String> {
    match open_windows_read_handle(&platform_absolute_root(root)?.join("index.md")) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) => Err("root index appeared after planning; no changes were written".to_owned()),
        Err(error) => Err(format!("cannot revalidate planned root index: {error}")),
    }
}

#[cfg(windows)]
fn ensure_planned_index_identity(
    _anchor: &PlannedRootAnchor,
    root: &Path,
    expected: &ObjectIdentity,
) -> Result<(), String> {
    let current = open_windows_read_handle(&platform_absolute_root(root)?.join("index.md"))
        .map_err(|error| format!("cannot revalidate planned root index: {error}"))?;
    if file_object_identity(&current)? == *expected {
        Ok(())
    } else {
        Err("root index changed after planning; no changes were written".to_owned())
    }
}

fn planned_root_for_apply(plan: &[PlannedChange]) -> Result<&PlannedRootIdentity, String> {
    let planned = plan
        .first()
        .and_then(|change| change.planned_root.as_ref())
        .ok_or_else(|| "write plan is missing its root identity".to_owned())?;
    if plan.iter().any(|change| {
        change
            .planned_root
            .as_ref()
            .is_none_or(|candidate| !Arc::ptr_eq(candidate, planned))
    }) {
        return Err("write plan contains inconsistent root identities".to_owned());
    }
    Ok(planned.as_ref())
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
    let planned = planned_root_for_apply(plan)?;
    if matches!(planned, PlannedRootIdentity::Missing { .. }) {
        return apply_missing_root_plan_windows(planned, plan);
    }
    let (root, _root_locks) = windows_open_or_create_planned_root(root, planned)?;
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
fn apply_missing_root_plan_windows(
    planned: &PlannedRootIdentity,
    plan: &[PlannedChange],
) -> Result<(), String> {
    apply_missing_root_plan_windows_with_hook(planned, plan, |_| Ok(()))
}

#[cfg(windows)]
fn apply_missing_root_plan_windows_with_hook(
    planned: &PlannedRootIdentity,
    plan: &[PlannedChange],
    before_publish: impl FnOnce(&OsStr) -> Result<(), String>,
) -> Result<(), String> {
    apply_missing_root_plan_windows_with_staging_name_and_hook(
        planned,
        plan,
        windows_root_staging_name(),
        before_publish,
    )
}

#[cfg(windows)]
fn apply_missing_root_plan_windows_with_staging_name_and_hook(
    planned: &PlannedRootIdentity,
    plan: &[PlannedChange],
    staging_name: &OsStr,
    before_publish: impl FnOnce(&OsStr) -> Result<(), String>,
) -> Result<(), String> {
    let PlannedRootIdentity::Missing {
        requested,
        anchor,
        anchor_identity,
        components,
        handle,
        ..
    } = planned
    else {
        return Err("missing-root staging requires a missing-root plan".to_owned());
    };
    if handle.locks.is_empty() || path_object_identity(anchor)? != *anchor_identity {
        return Err("root ancestor changed after planning; no changes were written".to_owned());
    }
    let mut expected_root = anchor.clone();
    expected_root.extend(components);
    if expected_root != platform_absolute_root(requested)? {
        return Err("missing-root plan no longer matches its requested root".to_owned());
    }
    let first = components
        .first()
        .ok_or_else(|| "missing-root plan has no missing component".to_owned())?;
    if windows_reservation_name_matches_requested(staging_name, first) {
        return Err(
            "private staging reservation matched the requested root; no target was published"
                .to_owned(),
        );
    }
    let final_path = anchor.join(first);
    let staging_path = anchor.join(staging_name);
    for path in [&final_path, &staging_path] {
        match fs::symlink_metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => {
                return Err(format!(
                    "root publication entry {} appeared after planning; no changes were written",
                    path.display()
                ));
            }
            Err(error) => return Err(format!("cannot preflight root publication: {error}")),
        }
    }
    let parent_handle = handle
        .locks
        .last()
        .ok_or_else(|| "missing-root plan has no retained Windows ancestor handle".to_owned())?;
    let staging_handle = create_windows_directory_rename_handle(parent_handle, staging_name)
        .map_err(|error| {
            format!(
                "cannot reserve bounded root staging directory {}: {error}; no target was published",
                staging_path.display()
            )
        })?;
    let staging_identity = file_object_identity(&staging_handle)?;
    if path_object_identity(&staging_path)? != staging_identity {
        return Err(
            "root staging reservation changed while it was being anchored; no target was published"
                .to_owned(),
        );
    }
    let mut staged_root = staging_path.clone();
    let mut staged_directory_paths = HashSet::new();
    let mut staged_directory_locks = Vec::new();
    for component in components.iter().skip(1) {
        staged_root.push(component);
        create_and_lock_windows_staged_directory(
            &staged_root,
            &mut staged_directory_paths,
            &mut staged_directory_locks,
        )?;
    }
    for change in plan {
        validate_relative_path(&change.relative_path)?;
        let parent = Path::new(&change.relative_path)
            .parent()
            .ok_or_else(|| format!("{} has no parent", change.relative_path))?;
        let mut current = staged_root.clone();
        for component in parent.components() {
            let Component::Normal(component) = component else {
                return Err(format!(
                    "generated path {:?} is not relative",
                    change.relative_path
                ));
            };
            current.push(component);
            create_and_lock_windows_staged_directory(
                &current,
                &mut staged_directory_paths,
                &mut staged_directory_locks,
            )?;
        }
    }
    let mut staged_leaf_bindings = Vec::with_capacity(plan.len());
    for change in plan {
        let target = staged_root.join(&change.relative_path);
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&target)
            .map_err(|error| format!("cannot stage {}: {error}", target.display()))?;
        file.write_all(change.content.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        let identity = file_object_identity(&file)?;
        staged_leaf_bindings.push(WindowsStagedLeafBinding {
            path: target,
            file,
            identity,
            expected: change.content.as_bytes().to_vec(),
        });
    }
    before_publish(staging_name)?;
    verify_windows_staged_leaf_bindings(&mut staged_leaf_bindings)?;
    if path_object_identity(&staging_path)? != staging_identity {
        return Err(
            "root staging reservation changed before publication; no target was published"
                .to_owned(),
        );
    }
    // Windows refuses an ancestor-directory rename while any descendant handle remains open.
    // Hold strict leaf/directory handles through the final byte/identity checks, then release them
    // immediately before the root-handle rename. The resulting non-cooperating mutation window is
    // an explicit platform boundary in FR-104.
    drop(staged_leaf_bindings);
    drop(staged_directory_locks);
    rename_windows_handle(&staging_handle, parent_handle, first).map_err(|error| {
        format!(
            "cannot atomically publish the complete new root; concurrent content was preserved and bounded staging remains for inspection: {error}"
        )
    })
}

#[cfg(windows)]
struct WindowsStagedLeafBinding {
    path: PathBuf,
    file: File,
    identity: ObjectIdentity,
    expected: Vec<u8>,
}

#[cfg(windows)]
fn verify_windows_staged_leaf_bindings(
    bindings: &mut [WindowsStagedLeafBinding],
) -> Result<(), String> {
    for binding in bindings {
        if path_object_identity(&binding.path)? != binding.identity {
            return Err(format!(
                "staged file {} changed before publication; no target was published",
                binding.path.display()
            ));
        }
        binding
            .file
            .seek(SeekFrom::Start(0))
            .map_err(|error| error.to_string())?;
        let limit = u64::try_from(binding.expected.len())
            .ok()
            .and_then(|length| length.checked_add(1))
            .ok_or_else(|| "staged file byte length is not representable".to_owned())?;
        let mut bytes = Vec::with_capacity(binding.expected.len());
        (&mut binding.file)
            .take(limit)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes != binding.expected
            || file_object_identity(&binding.file)? != binding.identity
            || path_object_identity(&binding.path)? != binding.identity
        {
            return Err(format!(
                "staged file {} bytes or identity changed before publication; no target was published",
                binding.path.display()
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn create_and_lock_windows_staged_directory(
    path: &Path,
    created: &mut HashSet<PathBuf>,
    locks: &mut Vec<File>,
) -> Result<(), String> {
    if !created.insert(path.to_path_buf()) {
        return Ok(());
    }
    fs::create_dir(path).map_err(|error| {
        format!(
            "cannot create private staged directory {}: {error}; no target was published",
            path.display()
        )
    })?;
    locks.push(open_windows_directory_strict_mutation_lock(path)?);
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
            ..
        } => {
            if requested != root {
                return Err("write plan root does not match the requested root".to_owned());
            }
            if path_object_identity(&platform_absolute_root(root)?)? != *identity {
                return Err(format!(
                    "bundle root {} changed after planning; no changes were written",
                    root.display()
                ));
            }
            Ok((platform_absolute_root(root)?, Vec::new()))
        }
        PlannedRootIdentity::Missing { .. } => {
            Err("missing roots require complete staged publication".to_owned())
        }
    }
}

#[cfg(windows)]
fn preflight_windows_change(root: &Path, change: &PlannedChange) -> Result<(), String> {
    let target = root.join(&change.relative_path);
    let parent = target
        .parent()
        .ok_or_else(|| format!("{} has no parent", target.display()))?;
    match &change.expected_content {
        None => {
            let planned_parent = change
                .planned_parent
                .as_ref()
                .ok_or_else(|| "write plan is missing its Windows parent anchor".to_owned())?;
            if planned_parent.path != parent
                || path_object_identity(parent)? != planned_parent.identity
                || planned_parent.locks.is_empty()
            {
                return Err(format!(
                    "generated parent {} changed after planning; no changes were written",
                    parent.display()
                ));
            }
            match open_windows_read_handle(&target) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Ok(_) => {
                    return Err(format!(
                        "{} appeared after planning; no replacement was attempted",
                        target.display()
                    ));
                }
                Err(error) => {
                    return Err(format!("cannot revalidate {}: {error}", target.display()));
                }
            }
            let reservation = parent.join(".okf-workbench-staging.tmp");
            match fs::symlink_metadata(&reservation) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Ok(_) => Err(format!(
                    "bounded staging reservation {} already exists; no changes were written",
                    reservation.display()
                )),
                Err(error) => Err(format!(
                    "cannot preflight bounded staging reservation {}: {error}",
                    reservation.display()
                )),
            }
        }
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
    let planned_parent = change
        .planned_parent
        .as_ref()
        .ok_or_else(|| "write plan is missing its Windows parent anchor".to_owned())?;
    if planned_parent.path != parent || path_object_identity(parent)? != planned_parent.identity {
        return Err(format!(
            "generated parent {} changed after planning; no changes were written",
            parent.display()
        ));
    }
    let leaf = target
        .file_name()
        .ok_or_else(|| format!("{} has no filename", target.display()))?;
    let parent_handle = planned_parent
        .locks
        .last()
        .ok_or_else(|| "write plan is missing its Windows parent mutation handle".to_owned())?;
    match &change.expected_content {
        None => create_windows_file(parent, parent_handle, leaf, change),
        Some(_) => {
            Err("conditional replacement is unavailable on Windows; no file was changed".to_owned())
        }
    }
}

#[cfg(windows)]
fn create_windows_file(
    parent: &Path,
    parent_handle: &File,
    leaf: &OsStr,
    change: &PlannedChange,
) -> Result<(), String> {
    create_windows_file_with_writer(
        parent,
        parent_handle,
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
    parent_handle: &File,
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
    let (_temporary_path, mut temporary) = create_windows_temporary(parent)?;
    let result = (|| {
        write_content(&mut temporary)?;
        temporary.sync_all().map_err(|error| error.to_string())?;
        before_publish()?;
        rename_windows_handle(&temporary, parent_handle, leaf).map_err(|error| {
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
fn open_windows_directory_strict_mutation_lock(path: &Path) -> Result<File, String> {
    let file = OpenOptions::new()
        .access_mode(FILE_GENERIC_READ | FILE_GENERIC_WRITE | SYNCHRONIZE)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| {
            format!(
                "cannot exclusively anchor parent {} for publication: {error}",
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
fn create_windows_directory_rename_handle(parent: &File, name: &OsStr) -> Result<File, String> {
    let name_wide = name.encode_wide().collect::<Vec<_>>();
    let byte_length = name_wide
        .len()
        .checked_mul(std::mem::size_of::<u16>())
        .and_then(|length| u16::try_from(length).ok())
        .ok_or_else(|| "Windows staging name is too long".to_owned())?;
    let unicode_name = UNICODE_STRING {
        Length: byte_length,
        MaximumLength: byte_length,
        Buffer: name_wide.as_ptr().cast_mut(),
    };
    let object_attributes = OBJECT_ATTRIBUTES {
        Length: u32::try_from(std::mem::size_of::<OBJECT_ATTRIBUTES>()).unwrap(),
        RootDirectory: parent.as_raw_handle(),
        ObjectName: &raw const unicode_name,
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: std::ptr::null(),
        SecurityQualityOfService: std::ptr::null(),
    };
    let mut io_status = IO_STATUS_BLOCK::default();
    // SAFETY: the union is initialized as an NTSTATUS before NtCreateFile reads or writes it.
    io_status.Anonymous.Status = STATUS_PENDING;
    let mut raw_handle = INVALID_HANDLE_VALUE;
    // SAFETY: every pointer references a live value for the duration of the synchronous call;
    // `name_wide` is kept alive, the parent handle is retained by the plan, and FILE_CREATE with
    // FILE_DIRECTORY_FILE atomically creates the child and returns its publication handle.
    let status = unsafe {
        NtCreateFile(
            &mut raw_handle,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE | SYNCHRONIZE,
            &raw const object_attributes,
            &mut io_status,
            std::ptr::null(),
            FILE_ATTRIBUTE_DIRECTORY,
            FILE_SHARE_READ,
            FILE_CREATE,
            FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT,
            std::ptr::null(),
            0,
        )
    };
    if status != STATUS_SUCCESS {
        // SAFETY: the status was returned by NtCreateFile and is valid for this conversion.
        let code = unsafe { RtlNtStatusToDosError(status) };
        return Err(std::io::Error::from_raw_os_error(code.cast_signed()).to_string());
    }
    // SAFETY: successful NtCreateFile returned one owned, valid handle.
    let file = unsafe { File::from_raw_handle(raw_handle) };
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if windows_metadata_is_reparse(&metadata) || !metadata.is_dir() {
        return Err("created staging object is not a real directory".to_owned());
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
        // `access_mode` controls the Win32 access mask, while Rust still requires an explicit
        // write intent before it will allow a create disposition.
        .write(true)
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
fn windows_rename_buffer_bytes(name_bytes: usize) -> Result<usize, String> {
    std::mem::offset_of!(FILE_RENAME_INFO, FileName)
        .checked_add(name_bytes)
        // Keep one zeroed WCHAR after the counted name. `FileNameLength` excludes this slot.
        .and_then(|length| length.checked_add(std::mem::size_of::<u16>()))
        .ok_or_else(|| "replacement filename is too long".to_owned())
}

#[cfg(windows)]
fn rename_windows_handle(file: &File, parent: &File, leaf: &OsStr) -> Result<(), String> {
    let name = leaf.encode_wide().collect::<Vec<_>>();
    let name_bytes = name
        .len()
        .checked_mul(std::mem::size_of::<u16>())
        .ok_or_else(|| "replacement filename is too long".to_owned())?;
    let header_bytes = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
    let buffer_bytes = windows_rename_buffer_bytes(name_bytes)?;
    let words = buffer_bytes.div_ceil(std::mem::size_of::<usize>());
    let mut buffer = vec![0usize; words];
    let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    // SAFETY: `buffer` is word-aligned and large enough for the fixed header, `name_bytes`, and
    // one zeroed trailing WCHAR. Both file handles remain live for the call.
    let succeeded = unsafe {
        // This is an ordinary atomic no-replace rename. The extended information class is only
        // needed for extended flags such as POSIX replacement semantics.
        (*info).Anonymous = FILE_RENAME_INFO_0 {
            ReplaceIfExists: false,
        };
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
            FileRenameInfo,
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
    let planned = planned_root_for_apply(plan)?;
    if matches!(planned, PlannedRootIdentity::Missing { .. }) {
        return apply_missing_root_plan_anchored(planned, plan);
    }
    let root_directory = open_or_create_anchored_root(root, planned)?;
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

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn apply_missing_root_plan_anchored(
    planned: &PlannedRootIdentity,
    plan: &[PlannedChange],
) -> Result<(), String> {
    apply_missing_root_plan_anchored_with_hook(planned, plan, |_| Ok(()))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn apply_missing_root_plan_anchored_with_hook(
    planned: &PlannedRootIdentity,
    plan: &[PlannedChange],
    before_publish: impl FnOnce(&OsStr) -> Result<(), String>,
) -> Result<(), String> {
    apply_missing_root_plan_anchored_with_name_factory_and_hook(
        planned,
        plan,
        fresh_unix_root_staging_name,
        before_publish,
    )
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn apply_missing_root_plan_anchored_with_name_factory_and_hook(
    planned: &PlannedRootIdentity,
    plan: &[PlannedChange],
    staging_name_factory: impl FnOnce() -> Result<OsString, String>,
    before_publish: impl FnOnce(&OsStr) -> Result<(), String>,
) -> Result<(), String> {
    let (coordination, coordination_name, anchor_handle) =
        reserve_unix_missing_root_coordination(planned)?;
    // Arm cleanup immediately after the atomic reservation, before any fallible staging work.
    // Explicit cleanup reports failures; Drop is the best-effort fallback for an early return.
    let mut coordination =
        UnixCoordinationGuard::new(anchor_handle, coordination_name, coordination);
    let staging_name = match staging_name_factory() {
        Ok(name) => name,
        Err(primary) => {
            return match coordination.remove() {
                Ok(()) => Err(primary),
                Err(cleanup) => Err(format!(
                    "{primary}; additionally, the coordination entry could not be removed: {cleanup}"
                )),
            };
        }
    };
    let result = apply_missing_root_plan_anchored_with_staging_name_and_hook(
        planned,
        plan,
        &staging_name,
        before_publish,
    );
    let staging_exists = match unix_anchored_entry_exists(anchor_handle, &staging_name) {
        Ok(exists) => exists,
        Err(inspect) => {
            coordination.leave_in_place();
            return Err(match result {
                Ok(()) => format!(
                    "root was published but the staging pathname could not be revalidated: {inspect}"
                ),
                Err(primary) => format!(
                    "{primary}; additionally, the staging pathname could not be revalidated: {inspect}"
                ),
            });
        }
    };
    match (result, staging_exists) {
        (Ok(()), true) => {
            coordination.leave_in_place();
            Err(
                "root was published but the staging pathname reappeared; coordination was retained"
                    .to_owned(),
            )
        }
        (Err(primary), true) => {
            coordination.leave_in_place();
            Err(primary)
        }
        (result, false) => {
            let cleanup = coordination.remove();
            match (result, cleanup) {
                (Ok(()), Ok(())) => Ok(()),
                (Ok(()), Err(cleanup)) => Err(format!(
                    "root was published but its coordination entry could not be removed: {cleanup}"
                )),
                (Err(primary), Ok(())) => Err(primary),
                (Err(primary), Err(cleanup)) => Err(format!(
                    "{primary}; additionally, the coordination entry could not be removed: {cleanup}"
                )),
            }
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn unix_anchored_entry_exists(anchor: &File, name: &OsStr) -> Result<bool, String> {
    match openat(
        anchor,
        name,
        OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(_) => Ok(true),
        Err(Errno::NOENT) => Ok(false),
        Err(error) => Err(format!("cannot inspect anchored entry {name:?}: {error}")),
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
struct UnixCoordinationGuard<'a> {
    anchor: &'a File,
    name: OsString,
    coordination: File,
    armed: bool,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
impl<'a> UnixCoordinationGuard<'a> {
    fn new(anchor: &'a File, name: OsString, coordination: File) -> Self {
        Self {
            anchor,
            name,
            coordination,
            armed: true,
        }
    }

    fn remove(&mut self) -> Result<(), String> {
        if !self.armed {
            return Ok(());
        }
        // Make every cleanup attempt single-shot. If it fails, retaining our entry is safer than
        // retrying against a pathname whose identity may have changed in the meantime.
        self.armed = false;
        remove_unix_coordination(self.anchor, &self.name, &self.coordination)
    }

    fn leave_in_place(&mut self) {
        self.armed = false;
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
impl Drop for UnixCoordinationGuard<'_> {
    fn drop(&mut self) {
        let _ = self.remove();
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn reserve_unix_missing_root_coordination(
    planned: &PlannedRootIdentity,
) -> Result<(File, OsString, &File), String> {
    let PlannedRootIdentity::Missing {
        components, handle, ..
    } = planned
    else {
        return Err("missing-root coordination requires a missing-root plan".to_owned());
    };
    let first = components
        .first()
        .ok_or_else(|| "missing-root plan has no missing component".to_owned())?;
    let name = anchor_coordination_name(planned)?;
    if name == *first {
        return Err(
            "coordination reservation matched the requested root; no target was published"
                .to_owned(),
        );
    }
    let file = File::from(
        openat(
            &handle.directory,
            &name,
            OFlags::CREATE | OFlags::EXCL | OFlags::WRONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_raw_mode(0o600),
        )
        .map_err(|error| {
            format!(
                "bounded root publication coordination entry {name:?} is unavailable: {error}; no target was published"
            )
        })?,
    );
    Ok((file, name, &handle.directory))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn remove_unix_coordination(
    anchor: &File,
    name: &OsStr,
    coordination: &File,
) -> Result<(), String> {
    let current = File::from(
        openat(
            anchor,
            name,
            OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| format!("cannot reopen coordination entry: {error}"))?,
    );
    if file_object_identity(&current)? != file_object_identity(coordination)? {
        return Err("coordination entry identity changed; it was not removed".to_owned());
    }
    unlinkat(anchor, name, AtFlags::empty())
        .map_err(|error| format!("cannot remove coordination entry: {error}"))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn apply_missing_root_plan_anchored_with_staging_name_and_hook(
    planned: &PlannedRootIdentity,
    plan: &[PlannedChange],
    staging_name: &OsStr,
    before_publish: impl FnOnce(&OsStr) -> Result<(), String>,
) -> Result<(), String> {
    let PlannedRootIdentity::Missing {
        anchor,
        anchor_identity,
        components,
        handle,
        ..
    } = planned
    else {
        return Err("missing-root staging requires a missing-root plan".to_owned());
    };
    let first = components
        .first()
        .ok_or_else(|| "missing-root plan has no missing component".to_owned())?;
    if staging_name == first {
        return Err(
            "private staging reservation matched the requested root; no target was published"
                .to_owned(),
        );
    }
    let current = open_anchored_root(anchor)?;
    if file_object_identity(&current)? != *anchor_identity {
        return Err("root ancestor changed after planning; no changes were written".to_owned());
    }
    for leaf in [first.as_os_str(), staging_name] {
        match openat(
            &handle.directory,
            leaf,
            OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Err(Errno::NOENT) => {}
            Ok(_) => {
                return Err(format!(
                    "root publication entry {leaf:?} appeared after planning; no changes were written"
                ));
            }
            Err(error) => return Err(format!("cannot preflight root publication: {error}")),
        }
    }
    mkdirat(
        &handle.directory,
        staging_name,
        Mode::from_raw_mode(0o755),
    )
    .map_err(|error| {
        format!(
            "cannot reserve bounded root staging directory {staging_name:?}: {error}; no target was published"
        )
    })?;
    let staging_directory = File::from(
        openat(
            &handle.directory,
            staging_name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| format!("cannot open root staging directory: {error}"))?,
    );
    let staging_identity = file_object_identity(&staging_directory)?;
    let mut root_directory = staging_directory
        .try_clone()
        .map_err(|error| format!("cannot retain root staging directory: {error}"))?;
    for component in components.iter().skip(1) {
        mkdirat(&root_directory, component, Mode::from_raw_mode(0o755)).map_err(|error| {
            format!("cannot build staged root component {component:?}: {error}")
        })?;
        root_directory = File::from(
            openat(
                &root_directory,
                component,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(|error| format!("cannot open staged root component: {error}"))?,
        );
    }
    let mut staged_leaf_identities = Vec::with_capacity(plan.len());
    for change in plan {
        validate_relative_path(&change.relative_path)?;
        apply_anchored_change(&root_directory, change)?;
        staged_leaf_identities.push(verify_unix_staged_leaf(&root_directory, change, None)?);
    }
    root_directory
        .sync_all()
        .map_err(|error| error.to_string())?;
    before_publish(staging_name)?;
    for (change, identity) in plan.iter().zip(&staged_leaf_identities) {
        verify_unix_staged_leaf(&root_directory, change, Some(identity))?;
    }
    let current_staging = File::from(
        openat(
            &handle.directory,
            staging_name,
            OFlags::RDONLY
                | OFlags::DIRECTORY
                | OFlags::NONBLOCK
                | OFlags::NOFOLLOW
                | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| format!("root staging reservation changed before publication: {error}"))?,
    );
    if file_object_identity(&current_staging)? != staging_identity {
        return Err(
            "root staging reservation changed before publication; no target was published"
                .to_owned(),
        );
    }
    let current_anchor = open_anchored_root(anchor)?;
    if file_object_identity(&current_anchor)? != *anchor_identity {
        return Err(
            "root ancestor pathname changed before publication; no target was published".to_owned(),
        );
    }
    renameat_with(
        &handle.directory,
        staging_name,
        &handle.directory,
        first,
        RenameFlags::NOREPLACE,
    )
    .map_err(|error| {
        format!(
            "cannot atomically publish the complete new root; concurrent content was preserved and bounded staging remains for inspection: {error}"
        )
    })?;
    let published = File::from(
        openat(
            &handle.directory,
            first,
            OFlags::RDONLY
                | OFlags::DIRECTORY
                | OFlags::NONBLOCK
                | OFlags::NOFOLLOW
                | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| format!("cannot verify published root identity: {error}"))?,
    );
    if file_object_identity(&published)? != staging_identity {
        return Err("published root identity does not match the staged tree".to_owned());
    }
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn open_unix_staged_leaf(root: &File, relative_path: &str) -> Result<File, String> {
    let Some((parent, leaf)) = open_anchored_parent(root, relative_path, false)? else {
        return Err(format!(
            "staged file {relative_path:?} disappeared before publication"
        ));
    };
    let file = File::from(
        openat(
            &parent,
            &leaf,
            OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| format!("cannot reopen staged file {relative_path:?} safely: {error}"))?,
    );
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err(format!(
            "staged file {relative_path:?} is not a regular file"
        ));
    }
    Ok(file)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn verify_unix_staged_leaf(
    root: &File,
    change: &PlannedChange,
    expected_identity: Option<&ObjectIdentity>,
) -> Result<ObjectIdentity, String> {
    let mut file = open_unix_staged_leaf(root, &change.relative_path)?;
    let identity = file_object_identity(&file)?;
    if expected_identity.is_some_and(|expected| *expected != identity) {
        return Err(format!(
            "staged file {:?} identity changed before publication; no target was published",
            change.relative_path
        ));
    }
    let expected = change.content.as_bytes();
    let limit = u64::try_from(expected.len())
        .ok()
        .and_then(|length| length.checked_add(1))
        .ok_or_else(|| "staged file byte length is not representable".to_owned())?;
    let mut bytes = Vec::with_capacity(expected.len());
    (&mut file)
        .take(limit)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let current = open_unix_staged_leaf(root, &change.relative_path)?;
    if bytes != expected
        || file_object_identity(&file)? != identity
        || file_object_identity(&current)? != identity
    {
        return Err(format!(
            "staged file {:?} bytes or identity changed before publication; no target was published",
            change.relative_path
        ));
    }
    Ok(identity)
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn apply_missing_root_plan_anchored(
    _planned: &PlannedRootIdentity,
    _plan: &[PlannedChange],
) -> Result<(), String> {
    Err("atomic complete-root publication is unavailable on this Unix platform".to_owned())
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
            anchor,
            ..
        } => {
            if requested != root {
                return Err("write plan root does not match the requested root".to_owned());
            }
            let current = open_anchored_root(&platform_absolute_root(root)?)?;
            if file_object_identity(&current)? != *identity {
                return Err(format!(
                    "bundle root {} changed after planning; no changes were written",
                    root.display()
                ));
            }
            after_anchor()?;
            anchor
                .directory
                .try_clone()
                .map_err(|error| error.to_string())
        }
        PlannedRootIdentity::Missing {
            requested,
            anchor,
            anchor_identity,
            components,
            handle,
        } => {
            if requested != root {
                return Err("write plan root does not match the requested root".to_owned());
            }
            let current = open_anchored_root(anchor)?;
            if file_object_identity(&current)? != *anchor_identity {
                return Err(format!(
                    "root ancestor {} changed after planning; no changes were written",
                    anchor.display()
                ));
            }
            let mut directory = handle
                .directory
                .try_clone()
                .map_err(|error| error.to_string())?;
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
            OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC,
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

    let temporary_directory = tempfile::tempdir().map_err(|error| error.to_string())?;
    let temporary_path = temporary_directory.path().join("stage");
    let mut temporary = {
        use std::os::unix::fs::OpenOptionsExt;

        OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .mode(0o666)
            .open(&temporary_path)
            .map_err(|error| error.to_string())?
    };
    fs::remove_file(&temporary_path).map_err(|error| error.to_string())?;
    drop(temporary_directory);
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

#[cfg(not(windows))]
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

#[cfg(all(not(target_os = "macos"), not(windows)))]
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

/// Validates a bounded path that was obtained by enumerating an existing bundle.
///
/// Unlike generated paths, an existing provider identity follows the host filesystem's naming
/// rules. In particular, POSIX filenames may contain `:`, end in a dot or space, or match a
/// Windows device basename. Windows keeps rejecting those spellings because Win32 may interpret
/// them as invalid or as aliases rather than the enumerated leaf.
fn validate_existing_relative_path(path: &str) -> Result<(), String> {
    const MAX_PATH_UNITS: usize = 4_096;
    const MAX_SEGMENTS: usize = 64;
    #[cfg(windows)]
    let normalized = path.replace('\\', "/");
    #[cfg(not(windows))]
    let normalized = path;
    let segments = normalized.split('/').collect::<Vec<_>>();
    let invalid_common = normalized.is_empty()
        || normalized.len() > MAX_PATH_UNITS
        || normalized.encode_utf16().count() > MAX_PATH_UNITS
        || segments.len() > MAX_SEGMENTS
        || normalized.starts_with('/')
        || segments
            .iter()
            .any(|segment| segment.is_empty() || matches!(*segment, "." | ".."))
        || normalized.chars().any(char::is_control)
        || Path::new(path).components().any(|component| {
            matches!(
                component,
                Component::CurDir
                    | Component::ParentDir
                    | Component::RootDir
                    | Component::Prefix(_)
            )
        });
    #[cfg(windows)]
    let invalid_platform = segments
        .iter()
        .any(|segment| !is_portable_generated_segment(segment));
    #[cfg(not(windows))]
    let invalid_platform = false;
    if invalid_common || invalid_platform {
        return Err(format!(
            "existing bundle path {path:?} is unsafe or ambiguous on this platform"
        ));
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

    #[cfg(unix)]
    #[test]
    fn existing_posix_paths_keep_host_filesystem_identity() {
        for path in [
            "notes:2026.md",
            "CON.md",
            "folder/trailing.",
            "folder/trailing ",
        ] {
            assert!(validate_existing_relative_path(path).is_ok(), "{path:?}");
        }
        for path in ["", "/outside.md", "../outside.md", "folder//file.md"] {
            assert!(validate_existing_relative_path(path).is_err(), "{path:?}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn existing_windows_paths_reject_device_and_normalization_aliases() {
        for path in [
            "CON.md",
            "folder/AUX.txt",
            "folder/trailing.",
            "folder/trailing ",
            "folder/name:stream.md",
        ] {
            assert!(validate_existing_relative_path(path).is_err(), "{path:?}");
        }
        assert!(validate_existing_relative_path("folder/ordinary.md").is_ok());
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

    #[cfg(not(windows))]
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

    #[cfg(unix)]
    #[test]
    fn raced_fifo_leaf_is_rejected_without_a_blocking_open() {
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
        #[cfg(target_os = "linux")]
        {
            let root_directory = open_anchored_root(&root).unwrap();
            rustix::fs::mkfifoat(&root_directory, "new.md", Mode::from_raw_mode(0o600)).unwrap();
        }
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::ffi::OsStrExt;

            let target =
                std::ffi::CString::new(root.join("new.md").as_os_str().as_bytes()).unwrap();
            // SAFETY: `target` is NUL-terminated and the mode contains permission bits only.
            assert_eq!(unsafe { libc::mkfifo(target.as_ptr(), 0o600) }, 0);
        }

        let error = apply_plan(&root, &plan).unwrap_err();

        assert!(error.contains("appeared after planning"), "{error}");
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

    #[test]
    fn existing_root_multiple_creates_fail_before_any_publication() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("bundle");
        fs::create_dir(&root).unwrap();
        let plan = plan_files(
            &root,
            vec![
                RenderedFile {
                    relative_path: "one.md".to_owned(),
                    encoding: "utf8",
                    content: "one\n".to_owned(),
                },
                RenderedFile {
                    relative_path: "two.md".to_owned(),
                    encoding: "utf8",
                    content: "two\n".to_owned(),
                },
            ],
            PlanMode::CreateOnly,
        )
        .unwrap();

        #[cfg(windows)]
        assert!(Arc::ptr_eq(
            plan[0].planned_parent.as_ref().unwrap(),
            plan[1].planned_parent.as_ref().unwrap()
        ));

        let error = apply_plan(&root, &plan).unwrap_err();

        assert!(error.contains("cannot be committed atomically"), "{error}");
        assert_eq!(fs::read_dir(root).unwrap().count(), 0);
    }

    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    #[test]
    fn missing_root_plan_cannot_be_applied_to_a_different_root() {
        let directory = tempdir().unwrap();
        let planned_root = directory.path().join("planned");
        let requested_root = directory.path().join("requested");
        let plan = plan_files(
            &planned_root,
            vec![RenderedFile {
                relative_path: "new.md".to_owned(),
                encoding: "utf8",
                content: "generated\n".to_owned(),
            }],
            PlanMode::CreateOnly,
        )
        .unwrap();

        let error = apply_plan(&requested_root, &plan).unwrap_err();

        assert!(error.contains("plan root does not match"), "{error}");
        assert!(!planned_root.exists());
        assert!(!requested_root.exists());
    }

    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    #[test]
    fn deterministic_staging_keeps_legacy_unicode_alias_root_private_until_publish() {
        let directory = tempdir().unwrap();
        let root = directory.path().join(".oKf-workbench-root-staging");
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
        let planned = planned_root_for_apply(&plan).unwrap();

        #[cfg(any(target_os = "linux", target_os = "macos"))]
        let result = apply_missing_root_plan_anchored_with_hook(planned, &plan, |staging_name| {
            assert!(!root.exists());
            assert!(directory.path().join(staging_name).exists());
            Ok(())
        });
        #[cfg(windows)]
        let result = apply_missing_root_plan_windows_with_hook(planned, &plan, |staging_name| {
            assert!(!root.exists());
            assert!(directory.path().join(staging_name).exists());
            Ok(())
        });

        result.unwrap();
        assert_eq!(
            fs::read_to_string(root.join("new.md")).unwrap(),
            "generated\n"
        );
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    #[test]
    fn staged_leaf_bytes_are_bound_before_root_publication() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("bundle");
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
        let planned = planned_root_for_apply(&plan).unwrap();
        let tamper_succeeded = std::cell::Cell::new(false);

        #[cfg(any(target_os = "linux", target_os = "macos"))]
        let result = apply_missing_root_plan_anchored_with_hook(planned, &plan, |staging_name| {
            tamper_succeeded.set(
                fs::write(
                    directory.path().join(staging_name).join("new.md"),
                    "tampered\n",
                )
                .is_ok(),
            );
            Ok(())
        });
        #[cfg(windows)]
        let result = apply_missing_root_plan_windows_with_hook(planned, &plan, |staging_name| {
            tamper_succeeded.set(
                fs::write(
                    directory.path().join(staging_name).join("new.md"),
                    "tampered\n",
                )
                .is_ok(),
            );
            Ok(())
        });

        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            let error = result.unwrap_err();
            assert!(tamper_succeeded.get());
            assert!(error.contains("bytes or identity changed"), "{error}");
            assert!(!root.exists());
        }
        #[cfg(windows)]
        {
            result.unwrap();
            assert!(!tamper_succeeded.get());
            assert_eq!(
                fs::read_to_string(root.join("new.md")).unwrap(),
                "generated\n"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_staged_leaf_handle_denies_replacement_until_final_validation() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("bundle");
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
        let planned = planned_root_for_apply(&plan).unwrap();

        let replacement_succeeded = std::cell::Cell::new(false);
        apply_missing_root_plan_windows_with_hook(planned, &plan, |staging_name| {
            let staged = directory.path().join(staging_name);
            replacement_succeeded
                .set(fs::rename(staged.join("new.md"), staged.join("moved-new.md")).is_ok());
            Ok(())
        })
        .unwrap();

        assert!(!replacement_succeeded.get());
        assert_eq!(
            fs::read_to_string(root.join("new.md")).unwrap(),
            "generated\n"
        );
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn renamed_anchor_is_rejected_before_handle_relative_publication() {
        let directory = tempdir().unwrap();
        let anchor = directory.path().join("anchor");
        let moved_anchor = directory.path().join("moved-anchor");
        fs::create_dir(&anchor).unwrap();
        let root = anchor.join("bundle");
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
        let planned = planned_root_for_apply(&plan).unwrap();

        let error = apply_missing_root_plan_anchored_with_hook(planned, &plan, |staging_name| {
            assert!(anchor.join(staging_name).exists());
            fs::rename(&anchor, &moved_anchor).map_err(|error| error.to_string())?;
            fs::create_dir(&anchor).map_err(|error| error.to_string())
        })
        .unwrap_err();

        assert!(error.contains("ancestor pathname changed"), "{error}");
        assert!(!root.exists());
        assert!(!moved_anchor.join("bundle").exists());
        assert_eq!(fs::read_dir(&anchor).unwrap().count(), 0);
        assert_eq!(fs::read_dir(&moved_anchor).unwrap().count(), 2);
    }

    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    #[test]
    fn exact_staging_match_fails_before_reservation_or_hook() {
        let directory = tempdir().unwrap();
        let staging_name = OsStr::new(".okf-workbench-root-staging-forced-match");
        let root = directory.path().join(staging_name);
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
        let planned = planned_root_for_apply(&plan).unwrap();
        let hook_called = std::cell::Cell::new(false);

        #[cfg(any(target_os = "linux", target_os = "macos"))]
        let result = apply_missing_root_plan_anchored_with_staging_name_and_hook(
            planned,
            &plan,
            staging_name,
            |_| {
                hook_called.set(true);
                Ok(())
            },
        );
        #[cfg(windows)]
        let result = apply_missing_root_plan_windows_with_staging_name_and_hook(
            planned,
            &plan,
            staging_name,
            |_| {
                hook_called.set(true);
                Ok(())
            },
        );

        let error = result.unwrap_err();
        assert!(error.contains("matched the requested root"), "{error}");
        assert!(!hook_called.get());
        assert!(!root.exists());
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn exact_coordination_match_fails_before_reservation_or_hook() {
        let directory = tempdir().unwrap();
        let render = || RenderedFile {
            relative_path: "new.md".to_owned(),
            encoding: "utf8",
            content: "generated\n".to_owned(),
        };
        let seed = plan_files(
            &directory.path().join("seed"),
            vec![render()],
            PlanMode::CreateOnly,
        )
        .unwrap();
        let coordination =
            anchor_coordination_name(planned_root_for_apply(&seed).unwrap()).unwrap();
        drop(seed);
        let root = directory.path().join(coordination);
        let plan = plan_files(&root, vec![render()], PlanMode::CreateOnly).unwrap();
        let planned = planned_root_for_apply(&plan).unwrap();
        let hook_called = std::cell::Cell::new(false);

        let error = apply_missing_root_plan_anchored_with_hook(planned, &plan, |_| {
            hook_called.set(true);
            Ok(())
        })
        .unwrap_err();

        assert!(
            error.contains("coordination reservation matched"),
            "{error}"
        );
        assert!(!hook_called.get());
        assert!(!root.exists());
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn staging_name_generation_failure_removes_coordination() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("bundle");
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
        let planned = planned_root_for_apply(&plan).unwrap();
        let hook_called = std::cell::Cell::new(false);

        let error = apply_missing_root_plan_anchored_with_name_factory_and_hook(
            planned,
            &plan,
            || Err("injected randomness failure".to_owned()),
            |_| {
                hook_called.set(true);
                Ok(())
            },
        )
        .unwrap_err();

        assert!(error.contains("injected randomness failure"), "{error}");
        assert!(!hook_called.get());
        assert!(!root.exists());
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn replaced_coordination_entry_is_not_removed() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("bundle");
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
        let planned = planned_root_for_apply(&plan).unwrap();
        let (coordination, name, anchor_handle) =
            reserve_unix_missing_root_coordination(planned).unwrap();
        let anchor = directory.path();
        let coordination_path = anchor.join(&name);
        let moved_path = anchor.join("moved-owned-coordination");
        fs::rename(&coordination_path, &moved_path).unwrap();
        fs::write(&coordination_path, "third party\n").unwrap();

        let error = remove_unix_coordination(anchor_handle, &name, &coordination).unwrap_err();

        assert!(error.contains("identity changed"), "{error}");
        assert_eq!(
            fs::read_to_string(&coordination_path).unwrap(),
            "third party\n"
        );
        assert!(moved_path.exists());
        assert!(!root.exists());
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn coordination_name_is_anchor_wide_fixed_length_decimal() {
        let directory = tempdir().unwrap();
        let render = || RenderedFile {
            relative_path: "new.md".to_owned(),
            encoding: "utf8",
            content: "generated\n".to_owned(),
        };
        let first = plan_files(
            &directory.path().join("Bundle"),
            vec![render()],
            PlanMode::CreateOnly,
        )
        .unwrap();
        let second = plan_files(
            &directory.path().join("unrelated-root"),
            vec![render()],
            PlanMode::CreateOnly,
        )
        .unwrap();

        let first_name = anchor_coordination_name(planned_root_for_apply(&first).unwrap()).unwrap();
        let second_name =
            anchor_coordination_name(planned_root_for_apply(&second).unwrap()).unwrap();
        let text = first_name.to_str().unwrap();

        assert_eq!(first_name, second_name);
        assert_eq!(text.len(), 40);
        assert!(text.starts_with('.'));
        assert!(text[1..].bytes().all(|byte| byte.is_ascii_digit()));
    }

    #[cfg(windows)]
    #[test]
    fn windows_staging_name_is_83_and_self_match_is_rejected() {
        let staging_name = windows_root_staging_name();
        let text = staging_name.to_str().unwrap();
        let (stem, extension) = text.split_once('.').unwrap();
        assert_eq!(stem.len(), 8);
        assert_eq!(extension.len(), 3);
        assert!(stem.bytes().all(|byte| byte.is_ascii_digit()));
        assert!(extension.bytes().all(|byte| byte.is_ascii_digit()));

        let directory = tempdir().unwrap();
        let root = directory.path().join(staging_name);
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
        let planned = planned_root_for_apply(&plan).unwrap();
        let hook_called = std::cell::Cell::new(false);

        let error = apply_missing_root_plan_windows_with_hook(planned, &plan, |_| {
            hook_called.set(true);
            Ok(())
        })
        .unwrap_err();

        assert!(error.contains("matched the requested root"), "{error}");
        assert!(!hook_called.get());
        assert!(!root.exists());
    }

    #[cfg(windows)]
    #[test]
    fn windows_staging_terminal_dot_and_space_aliases_are_rejected() {
        for requested_name in ["00000000.000.", "00000000.000 ", "00000000.000. "] {
            assert!(windows_reservation_name_matches_requested(
                windows_root_staging_name(),
                OsStr::new(requested_name)
            ));

            let directory = tempdir().unwrap();
            let root = directory.path().join(requested_name);
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
            let planned = planned_root_for_apply(&plan).unwrap();
            let hook_called = std::cell::Cell::new(false);

            let error = apply_missing_root_plan_windows_with_hook(planned, &plan, |_| {
                hook_called.set(true);
                Ok(())
            })
            .unwrap_err();

            assert!(error.contains("matched the requested root"), "{error}");
            assert!(!hook_called.get());
            assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    #[test]
    fn missing_root_staging_collision_preserves_the_existing_entry() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("bundle");
        let staging_name = OsStr::new(".okf-workbench-root-staging-collision");
        let staging = directory.path().join(staging_name);
        fs::create_dir(&staging).unwrap();
        fs::write(staging.join("sentinel"), "owned elsewhere\n").unwrap();
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
        let planned = planned_root_for_apply(&plan).unwrap();

        #[cfg(any(target_os = "linux", target_os = "macos"))]
        let error = apply_missing_root_plan_anchored_with_staging_name_and_hook(
            planned,
            &plan,
            staging_name,
            |_| Ok(()),
        )
        .unwrap_err();
        #[cfg(windows)]
        let error = apply_missing_root_plan_windows_with_staging_name_and_hook(
            planned,
            &plan,
            staging_name,
            |_| Ok(()),
        )
        .unwrap_err();

        assert!(error.contains("appeared after planning"), "{error}");
        assert!(!root.exists());
        assert_eq!(
            fs::read_to_string(staging.join("sentinel")).unwrap(),
            "owned elsewhere\n"
        );
    }

    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    #[test]
    fn handled_failure_residue_blocks_an_additional_staging_tree() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("bundle");
        let rendered = || RenderedFile {
            relative_path: "new.md".to_owned(),
            encoding: "utf8",
            content: "generated\n".to_owned(),
        };
        let plan = plan_files(&root, vec![rendered()], PlanMode::CreateOnly).unwrap();
        let planned = planned_root_for_apply(&plan).unwrap();

        #[cfg(any(target_os = "linux", target_os = "macos"))]
        let first_error = apply_missing_root_plan_anchored_with_hook(planned, &plan, |_| {
            Err("injected handled failure".to_owned())
        })
        .unwrap_err();
        #[cfg(windows)]
        let first_error = apply_missing_root_plan_windows_with_hook(planned, &plan, |_| {
            Err("injected handled failure".to_owned())
        })
        .unwrap_err();
        assert!(first_error.contains("injected handled failure"));
        assert!(!root.exists());

        // Windows retains a strict mutation guard in the plan. Release that completed attempt
        // before preparing an independent retry against the retained staging residue.
        #[cfg(windows)]
        drop(plan);

        let retry = plan_files(&root, vec![rendered()], PlanMode::CreateOnly).unwrap();
        let error = apply_plan(&root, &retry).unwrap_err();

        #[cfg(any(target_os = "linux", target_os = "macos"))]
        assert!(error.contains("coordination entry"), "{error}");
        #[cfg(windows)]
        assert!(error.contains("appeared after planning"), "{error}");
        assert_eq!(
            fs::read_dir(directory.path())
                .unwrap()
                .filter_map(Result::ok)
                .count(),
            if cfg!(windows) { 1 } else { 2 }
        );
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn maximum_length_root_component_uses_a_bounded_staging_name() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("r".repeat(255));
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

        apply_plan(&root, &plan).unwrap();

        assert_eq!(
            fs::read_to_string(root.join("new.md")).unwrap(),
            "generated\n"
        );
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn missing_root_multiple_creates_publish_as_one_complete_tree() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("nested/bundle");
        let plan = plan_files(
            &root,
            vec![
                RenderedFile {
                    relative_path: "one.md".to_owned(),
                    encoding: "utf8",
                    content: "one\n".to_owned(),
                },
                RenderedFile {
                    relative_path: "deep/two.md".to_owned(),
                    encoding: "utf8",
                    content: "two\n".to_owned(),
                },
            ],
            PlanMode::CreateOnly,
        )
        .unwrap();

        apply_plan(&root, &plan).unwrap();

        assert_eq!(fs::read_to_string(root.join("one.md")).unwrap(), "one\n");
        assert_eq!(
            fs::read_to_string(root.join("deep/two.md")).unwrap(),
            "two\n"
        );
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn missing_root_late_collision_publishes_no_generated_leaf() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("bundle");
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
        let planned = planned_root_for_apply(&plan).unwrap();
        let staged_path = std::cell::RefCell::new(None);

        let result = apply_missing_root_plan_anchored_with_hook(planned, &plan, |staging_name| {
            staged_path.replace(Some(directory.path().join(staging_name)));
            fs::create_dir(&root).map_err(|error| error.to_string())?;
            fs::write(root.join("sentinel"), "concurrent\n").map_err(|error| error.to_string())
        });

        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(root.join("sentinel")).unwrap(),
            "concurrent\n"
        );
        assert!(!root.join("new.md").exists());
        assert!(staged_path.into_inner().unwrap().exists());
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn replaced_staging_entry_is_rejected_before_publish() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("bundle");
        let moved_staging = directory.path().join("moved-owned-staging");
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
        let planned = planned_root_for_apply(&plan).unwrap();
        let replacement_path = std::cell::RefCell::new(None);

        let error = apply_missing_root_plan_anchored_with_hook(planned, &plan, |staging_name| {
            let staging = directory.path().join(staging_name);
            replacement_path.replace(Some(staging.clone()));
            fs::rename(&staging, &moved_staging).map_err(|error| error.to_string())?;
            fs::create_dir(&staging).map_err(|error| error.to_string())?;
            fs::write(staging.join("sentinel"), "third party\n").map_err(|error| error.to_string())
        })
        .unwrap_err();

        assert!(error.contains("staging reservation changed"), "{error}");
        assert!(!root.exists());
        assert_eq!(
            fs::read_to_string(moved_staging.join("new.md")).unwrap(),
            "generated\n"
        );
        let replacement = replacement_path.into_inner().unwrap();
        assert_eq!(
            fs::read_to_string(replacement.join("sentinel")).unwrap(),
            "third party\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn planned_supported_index_cannot_be_replaced_before_apply() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("bundle");
        fs::create_dir(&root).unwrap();
        let index = root.join("index.md");
        let saved = root.join("supported.md");
        fs::write(&index, "---\nokf_version: \"0.2\"\n---\n").unwrap();
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
        fs::rename(&index, &saved).unwrap();
        fs::write(&index, "---\nokf_version: \"9.0\"\n---\n").unwrap();

        let error = apply_plan(&root, &plan).unwrap_err();

        assert!(error.contains("root index changed"), "{error}");
        assert!(!root.join("new.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn planned_index_same_inode_content_change_is_revalidated() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("bundle");
        fs::create_dir(&root).unwrap();
        let index = root.join("index.md");
        fs::write(&index, "---\nokf_version: \"0.2\"\n---\n").unwrap();
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
        fs::write(&index, "---\nokf_version: \"9.0\"\n---\n").unwrap();

        let error = apply_plan(&root, &plan).unwrap_err();

        assert!(error.contains("root index bytes changed"), "{error}");
        assert!(!root.join("new.md").exists());
    }

    #[test]
    fn planned_missing_index_cannot_appear_before_apply() {
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
        fs::write(root.join("index.md"), "---\nokf_version: \"9.0\"\n---\n").unwrap();

        let error = apply_plan(&root, &plan).unwrap_err();

        assert!(error.contains("appeared after planning"), "{error}");
        assert!(!root.join("new.md").exists());
    }

    #[cfg(windows)]
    #[test]
    fn windows_planned_index_and_root_guards_block_rename_until_plan_drop() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("bundle");
        fs::create_dir(&root).unwrap();
        let index = root.join("index.md");
        fs::write(&index, "---\nokf_version: \"0.2\"\n---\n").unwrap();
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

        assert!(fs::rename(&index, root.join("moved-index.md")).is_err());
        assert!(fs::rename(&root, directory.path().join("moved-root")).is_err());
        drop(plan);
        fs::rename(&index, root.join("moved-index.md")).unwrap();
        fs::rename(&root, directory.path().join("moved-root")).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_strict_staged_directory_lock_denies_a_second_writer() {
        let directory = tempdir().unwrap();
        let staged_parent = directory.path().join("staged-parent");
        fs::create_dir(&staged_parent).unwrap();
        let lock = open_windows_directory_strict_mutation_lock(&staged_parent).unwrap();

        let writer = OpenOptions::new()
            .access_mode(FILE_GENERIC_READ | FILE_GENERIC_WRITE | SYNCHRONIZE)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&staged_parent);

        assert!(writer.is_err());
        drop(lock);
        assert!(
            OpenOptions::new()
                .access_mode(FILE_GENERIC_READ | FILE_GENERIC_WRITE | SYNCHRONIZE)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&staged_parent)
                .is_ok()
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_staged_descendant_lock_is_released_before_ancestor_rename() {
        let directory = tempdir().unwrap();
        let staged_root = directory.path().join("staged-root");
        let staged_child = staged_root.join("nested");
        let moved_root = directory.path().join("moved-root");
        fs::create_dir_all(&staged_child).unwrap();
        let lock = open_windows_directory_strict_mutation_lock(&staged_child).unwrap();

        assert!(fs::rename(&staged_root, &moved_root).is_err());
        drop(lock);
        fs::rename(&staged_root, &moved_root).unwrap();

        assert!(moved_root.join("nested").is_dir());
    }

    #[cfg(windows)]
    #[test]
    fn windows_missing_root_multiple_creates_publish_as_one_complete_tree() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("nested/bundle");
        let plan = plan_files(
            &root,
            vec![
                RenderedFile {
                    relative_path: "one.md".to_owned(),
                    encoding: "utf8",
                    content: "one\n".to_owned(),
                },
                RenderedFile {
                    relative_path: "deep/two.md".to_owned(),
                    encoding: "utf8",
                    content: "two\n".to_owned(),
                },
            ],
            PlanMode::CreateOnly,
        )
        .unwrap();

        apply_plan(&root, &plan).unwrap();

        assert_eq!(fs::read_to_string(root.join("one.md")).unwrap(), "one\n");
        assert_eq!(
            fs::read_to_string(root.join("deep/two.md")).unwrap(),
            "two\n"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_missing_root_late_collision_publishes_no_generated_leaf() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("bundle");
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
        let planned = planned_root_for_apply(&plan).unwrap();
        let staged_path = std::cell::RefCell::new(None);

        let result = apply_missing_root_plan_windows_with_hook(planned, &plan, |staging_name| {
            staged_path.replace(Some(directory.path().join(staging_name)));
            fs::create_dir(&root).map_err(|error| error.to_string())?;
            fs::write(root.join("sentinel"), "concurrent\n").map_err(|error| error.to_string())
        });

        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(root.join("sentinel")).unwrap(),
            "concurrent\n"
        );
        assert!(!root.join("new.md").exists());
        assert!(staged_path.into_inner().unwrap().exists());
    }

    #[cfg(windows)]
    #[test]
    fn windows_staging_handle_blocks_replacement_before_publish() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("bundle");
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
        let planned = planned_root_for_apply(&plan).unwrap();

        apply_missing_root_plan_windows_with_hook(planned, &plan, |staging_name| {
            let staging = directory.path().join(staging_name);
            assert!(
                fs::rename(&staging, directory.path().join("moved-staging")).is_err(),
                "the strict staging handle must deny rename before publication"
            );
            Ok(())
        })
        .unwrap();

        assert_eq!(
            fs::read_to_string(root.join("new.md")).unwrap(),
            "generated\n"
        );
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

        let parent_handle = plan[0]
            .planned_parent
            .as_ref()
            .unwrap()
            .locks
            .last()
            .unwrap();
        let error =
            create_windows_file(&root, parent_handle, OsStr::new("new.md"), &plan[0]).unwrap_err();

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
            plan[0]
                .planned_parent
                .as_ref()
                .unwrap()
                .locks
                .last()
                .unwrap(),
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
            plan[0]
                .planned_parent
                .as_ref()
                .unwrap()
                .locks
                .last()
                .unwrap(),
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

    #[cfg(windows)]
    #[test]
    fn windows_rename_layout_reserves_an_uncounted_trailing_wchar() {
        let name_bytes = "new.md".encode_utf16().count() * std::mem::size_of::<u16>();
        let header_bytes = std::mem::offset_of!(FILE_RENAME_INFO, FileName);

        assert_eq!(
            windows_rename_buffer_bytes(name_bytes).unwrap(),
            header_bytes + name_bytes + std::mem::size_of::<u16>()
        );
    }

    #[test]
    fn migration_rejects_a_target_changed_after_source_loading() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let target = root.join("concept.md");
        fs::write(&target, "user changed after bundle load\n").unwrap();
        let expected = BTreeMap::from([("concept.md".to_owned(), "loaded source\n".to_owned())]);
        let result = plan_replacement_files(
            root,
            vec![RenderedFile {
                relative_path: "concept.md".to_owned(),
                encoding: "utf8",
                content: "migrated source\n".to_owned(),
            }],
            &expected,
        );
        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(target).unwrap(),
            "user changed after bundle load\n"
        );
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
