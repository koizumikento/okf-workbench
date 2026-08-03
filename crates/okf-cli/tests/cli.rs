use serde_json::Value;
use std::{
    fs,
    path::Path,
    process::{Command, Stdio},
};
use tempfile::tempdir;

fn okf() -> Command {
    Command::new(env!("CARGO_BIN_EXE_okf"))
}

fn json_stdout(output: &std::process::Output) -> Value {
    serde_json::from_slice(&output.stdout).expect("CLI stdout must be versioned JSON")
}

#[test]
fn check_reports_changes_without_creating_the_root() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("bundle");
    let output = okf()
        .args(["init", root.to_str().unwrap(), "--check"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(!root.exists());
    let body = json_stdout(&output);
    assert_eq!(body["schemaVersion"], 1);
    assert_eq!(body["result"]["applied"], false);
}

#[test]
fn explicit_apply_initializes_then_validates_offline() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("bundle");
    let init = okf()
        .args(["init", root.to_str().unwrap(), "--apply"])
        .output()
        .unwrap();
    assert!(init.status.success(), "{:?}", init);
    assert!(root.join("index.md").is_file());

    let validate = okf()
        .args(["validate", root.to_str().unwrap(), "--format", "json"])
        .output()
        .unwrap();
    assert!(validate.status.success(), "{:?}", validate);
    assert_eq!(json_stdout(&validate)["result"], Value::Array(vec![]));
}

#[test]
fn concurrent_missing_root_initializers_leave_no_loser_staging_tree() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("bundle");
    let root_arg = root.to_str().unwrap();
    let mut children = Vec::new();
    for _ in 0..64 {
        children.push(
            okf()
                .args(["init", root_arg, "--apply"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
    }

    let statuses = children
        .into_iter()
        .map(|mut child| child.wait().unwrap())
        .collect::<Vec<_>>();

    assert!(statuses.iter().any(std::process::ExitStatus::success));
    assert!(root.join("index.md").is_file());
    let siblings = fs::read_dir(directory.path())
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name())
        .collect::<Vec<_>>();
    assert_eq!(siblings, vec![root.file_name().unwrap()]);
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn concurrent_case_alias_initializers_share_one_anchor_reservation() {
    let directory = tempdir().unwrap();
    let probe = directory.path().join("case-probe");
    fs::write(&probe, "probe").unwrap();
    let case_insensitive = directory.path().join("CASE-PROBE").exists();
    fs::remove_file(&probe).unwrap();
    if !case_insensitive {
        return;
    }

    let lower = directory.path().join("bundle");
    let upper = directory.path().join("BUNDLE");
    let mut children = Vec::new();
    for index in 0..64 {
        let root = if index % 2 == 0 { &lower } else { &upper };
        children.push(
            okf()
                .args(["init", root.to_str().unwrap(), "--apply"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
    }

    let statuses = children
        .into_iter()
        .map(|mut child| child.wait().unwrap())
        .collect::<Vec<_>>();

    assert!(statuses.iter().any(std::process::ExitStatus::success));
    assert!(lower.join("index.md").is_file());
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[cfg(target_os = "macos")]
#[test]
fn concurrent_unicode_alias_initializers_share_one_anchor_reservation() {
    let directory = tempdir().unwrap();
    let composed_probe = directory.path().join("é-probe");
    fs::write(&composed_probe, "probe").unwrap();
    let decomposed_probe = directory.path().join("e\u{301}-probe");
    let normalization_insensitive = decomposed_probe.exists();
    fs::remove_file(&composed_probe).unwrap();
    if !normalization_insensitive {
        return;
    }

    let composed = directory.path().join("Bündlé");
    let decomposed = directory.path().join("Bu\u{308}ndle\u{301}");
    let mut children = Vec::new();
    for index in 0..64 {
        let root = if index % 2 == 0 {
            &composed
        } else {
            &decomposed
        };
        children.push(
            okf()
                .args(["init", root.to_str().unwrap(), "--apply"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
    }

    let statuses = children
        .into_iter()
        .map(|mut child| child.wait().unwrap())
        .collect::<Vec<_>>();

    assert!(statuses.iter().any(std::process::ExitStatus::success));
    assert!(composed.join("index.md").is_file());
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[test]
fn relative_missing_root_can_be_initialized_from_its_captured_absolute_anchor() {
    let directory = tempdir().unwrap();
    let output = okf()
        .current_dir(directory.path())
        .args(["init", "bundle", "--apply"])
        .output()
        .unwrap();

    assert!(output.status.success(), "{output:?}");
    assert!(directory.path().join("bundle/index.md").is_file());
}

#[cfg(target_os = "macos")]
#[test]
fn macos_create_mode_respects_a_022_umask() {
    use std::os::unix::{fs::PermissionsExt, process::CommandExt};

    let directory = tempdir().unwrap();
    let root = directory.path().join("bundle");
    let mut command = okf();
    command.args(["init", root.to_str().unwrap(), "--apply"]);
    // SAFETY: `pre_exec` runs after fork in the child. `umask` is async-signal-safe and mutates
    // only the child process before it immediately executes the CLI image.
    unsafe {
        command.pre_exec(|| {
            libc::umask(0o022);
            Ok(())
        });
    }

    let output = command.output().unwrap();

    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        fs::metadata(root.join("index.md"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o644
    );
}

#[test]
fn documented_bundle_preset_names_are_accepted() {
    for preset in ["minimal", "software-project", "data-analytics"] {
        let directory = tempdir().unwrap();
        let output = okf()
            .args([
                "init",
                directory.path().join("bundle").to_str().unwrap(),
                "--preset",
                preset,
                "--check",
            ])
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1), "{preset}");
        let result = json_stdout(&output);
        assert_eq!(result["command"], "init");
        assert!(
            result["result"]["changeCount"].as_u64().unwrap_or_default() > 0,
            "{preset}"
        );
    }
}

#[test]
fn non_interactive_write_requires_apply() {
    let directory = tempdir().unwrap();
    let output = okf()
        .args(["init", directory.path().join("bundle").to_str().unwrap()])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("--apply"));
}

#[test]
fn create_collision_does_not_overwrite_user_content() {
    let directory = tempdir().unwrap();
    let root = directory.path();
    fs::write(root.join("existing.md"), "user content\n").unwrap();
    let output = okf()
        .args([
            "new",
            root.to_str().unwrap(),
            "--title",
            "Existing",
            "--path",
            "existing.md",
            "--apply",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(
        fs::read_to_string(root.join("existing.md")).unwrap(),
        "user content\n"
    );
}

#[test]
fn graph_is_semantic_json_not_a_terminal_renderer() {
    let directory = tempdir().unwrap();
    initialize(directory.path());
    let output = okf()
        .args([
            "graph",
            directory.path().to_str().unwrap(),
            "--format",
            "json",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    let body = json_stdout(&output);
    assert_eq!(body["command"], "graph");
    assert_eq!(body["result"]["protocolVersion"], 1);
}

#[test]
fn graph_refuses_bundle_scoped_parser_resource_failures() {
    let directory = tempdir().unwrap();
    initialize(directory.path());
    let body = "x".repeat(256 * 1024);
    for index in 0..33 {
        fs::write(
            directory.path().join(format!("large-{index:02}.md")),
            format!("---\ntype: concept\n---\n{body}"),
        )
        .unwrap();
    }

    let output = okf()
        .args([
            "graph",
            directory.path().to_str().unwrap(),
            "--format",
            "json",
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(output.stdout.is_empty(), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("bundle-scoped resource failure prevents graph publication"),
        "{output:?}"
    );
}

#[test]
fn version_and_new_use_the_stable_json_envelope() {
    let version = okf().arg("version").output().unwrap();
    assert!(version.status.success(), "{version:?}");
    let version_body = json_stdout(&version);
    assert_eq!(version_body["schemaVersion"], 1);
    assert_eq!(version_body["command"], "version");
    assert_eq!(version_body["result"]["abiVersion"], 1);

    let directory = tempdir().unwrap();
    initialize(directory.path());
    #[cfg(windows)]
    fs::create_dir(directory.path().join("nested")).unwrap();
    let created = okf()
        .args([
            "new",
            directory.path().to_str().unwrap(),
            "--title",
            "CLI contract",
            "--path",
            "nested/contract.md",
            "--check",
        ])
        .output()
        .unwrap();
    assert_eq!(created.status.code(), Some(1), "{created:?}");
    let created_body = json_stdout(&created);
    assert_eq!(created_body["schemaVersion"], 1);
    assert_eq!(created_body["command"], "new");
    assert_eq!(created_body["result"]["applied"], false);
    assert!(!directory.path().join("nested/contract.md").exists());
}

#[test]
fn new_keeps_markdown_looking_description_in_frontmatter_only() {
    let directory = tempdir().unwrap();
    initialize(directory.path());
    let created = okf()
        .args([
            "new",
            directory.path().to_str().unwrap(),
            "--title",
            "CLI lint contract",
            "--description",
            "# Alternate title\n[Link](target.md)",
            "--path",
            "lint-contract.md",
            "--apply",
        ])
        .output()
        .unwrap();
    assert!(created.status.success(), "{created:?}");

    let content = fs::read_to_string(directory.path().join("lint-contract.md")).unwrap();
    assert!(content.contains("description: \"# Alternate title\\n[Link](target.md)\"\n"));
    assert!(!content.contains("\n# Alternate title\n"));
    assert!(!content.contains("\n[Link](target.md)\n"));
}

#[test]
fn attested_computation_defaults_to_the_required_type() {
    let directory = tempdir().unwrap();
    initialize(directory.path());
    let created = okf()
        .args([
            "new",
            directory.path().to_str().unwrap(),
            "--template",
            "attested-computation",
            "--title",
            "Deterministic build",
            "--path",
            "build.md",
            "--apply",
        ])
        .output()
        .unwrap();
    assert!(created.status.success(), "{created:?}");
    let content = fs::read_to_string(directory.path().join("build.md")).unwrap();
    assert!(content.contains("type: \"Attested Computation\"\n"));
}

#[test]
fn mutating_commands_refuse_unsupported_bundle_versions() {
    for command in ["new", "index", "agent"] {
        let directory = tempdir().unwrap();
        initialize(directory.path());
        fs::write(
            directory.path().join("index.md"),
            "---\nokf_version: \"1.0\"\n---\n# Knowledge\n",
        )
        .unwrap();
        let mut arguments = vec![command, directory.path().to_str().unwrap()];
        if command == "new" {
            arguments.extend(["--title", "Blocked", "--path", "blocked.md"]);
        }
        arguments.push("--apply");
        let output = okf().args(arguments).output().unwrap();
        assert_eq!(output.status.code(), Some(2), "{command}: {output:?}");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("unsupported OKF version"),
            "{command}: {output:?}"
        );
        assert!(!directory.path().join("blocked.md").exists());
    }
}

#[test]
fn writes_refuse_non_string_and_malformed_root_versions() {
    for index in [
        "---\nokf_version: 2\n---\n# Knowledge\n",
        "---\nokf_version: [unterminated\n---\n# Knowledge\n",
    ] {
        let directory = tempdir().unwrap();
        initialize(directory.path());
        fs::write(directory.path().join("index.md"), index).unwrap();
        let output = okf()
            .args([
                "new",
                directory.path().to_str().unwrap(),
                "--title",
                "Blocked",
                "--path",
                "blocked.md",
                "--apply",
            ])
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2), "{output:?}");
        assert!(!directory.path().join("blocked.md").exists());
    }
}

#[test]
fn writes_allow_declared_future_minor_versions() {
    let directory = tempdir().unwrap();
    initialize(directory.path());
    fs::write(
        directory.path().join("index.md"),
        "---\nokf_version: \"0.999999999999999999999999999999\"\n---\n# Knowledge\n",
    )
    .unwrap();
    let output = okf()
        .args([
            "new",
            directory.path().to_str().unwrap(),
            "--title",
            "Future minor",
            "--path",
            "future.md",
            "--apply",
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert!(directory.path().join("future.md").is_file());
}

#[test]
fn index_refuses_partial_parse_results_without_writing() {
    let directory = tempdir().unwrap();
    initialize(directory.path());
    let invalid = directory.path().join("area/broken.md");
    fs::create_dir_all(invalid.parent().unwrap()).unwrap();
    fs::write(&invalid, "---\ntype: [unterminated\n").unwrap();

    let output = okf()
        .args(["index", directory.path().to_str().unwrap(), "--apply"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("incomplete bundle"));
    assert!(!directory.path().join("area/index.md").exists());
    assert_eq!(
        fs::read_to_string(&invalid).unwrap(),
        "---\ntype: [unterminated\n"
    );
}

#[test]
fn index_existing_versionless_root_fails_closed_without_replacement_cas() {
    let directory = tempdir().unwrap();
    initialize(directory.path());
    let index = directory.path().join("index.md");
    let original = "# Knowledge\n\nHuman introduction.\n";
    fs::write(&index, original).unwrap();
    let output = okf()
        .args(["index", directory.path().to_str().unwrap(), "--apply"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("generation-CAS"));
    assert_eq!(fs::read_to_string(index).unwrap(), original);
}

#[cfg(unix)]
#[test]
fn rejected_index_update_does_not_change_existing_file_mode() {
    use std::os::unix::fs::PermissionsExt;

    let directory = tempdir().unwrap();
    initialize(directory.path());
    let index = directory.path().join("index.md");
    let original = "# Versionless knowledge\n";
    fs::write(&index, original).unwrap();
    fs::set_permissions(&index, fs::Permissions::from_mode(0o644)).unwrap();

    let output = okf()
        .args(["index", directory.path().to_str().unwrap(), "--apply"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("generation-CAS"));
    assert_eq!(fs::read_to_string(&index).unwrap(), original);
    assert_eq!(
        fs::metadata(index).unwrap().permissions().mode() & 0o777,
        0o644
    );
}

#[cfg(target_os = "macos")]
#[test]
fn rejected_macos_update_leaves_acl_xattr_and_timestamps_untouched() {
    use std::os::unix::fs::MetadataExt;

    let directory = tempdir().unwrap();
    initialize(directory.path());
    let index = directory.path().join("index.md");
    let original = "# Versionless knowledge\n";
    fs::write(&index, original).unwrap();
    let xattr = "com.okf-workbench.metadata-test";
    let set_xattr = Command::new("/usr/bin/xattr")
        .args(["-w", xattr, "retained", index.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(set_xattr.status.success(), "{set_xattr:?}");
    let set_acl = Command::new("/bin/chmod")
        .args(["+a", "everyone allow read", index.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(set_acl.status.success(), "{set_acl:?}");
    let set_old_mtime = Command::new("/usr/bin/touch")
        .args(["-t", "200001010000", index.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(set_old_mtime.status.success(), "{set_old_mtime:?}");
    let before = fs::metadata(&index).unwrap();

    let output = okf()
        .args(["index", directory.path().to_str().unwrap(), "--apply"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("generation-CAS"));

    let after = fs::metadata(&index).unwrap();
    assert_eq!((after.uid(), after.gid()), (before.uid(), before.gid()));
    assert_eq!(
        (after.mode(), after.mtime(), after.mtime_nsec()),
        (before.mode(), before.mtime(), before.mtime_nsec())
    );
    assert_eq!(fs::read_to_string(&index).unwrap(), original);
    let retained_xattr = Command::new("/usr/bin/xattr")
        .args(["-p", xattr, index.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(retained_xattr.status.success(), "{retained_xattr:?}");
    assert_eq!(
        String::from_utf8_lossy(&retained_xattr.stdout).trim_end(),
        "retained"
    );
    let retained_acl = Command::new("/bin/ls")
        .args(["-le", index.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(retained_acl.status.success(), "{retained_acl:?}");
    assert!(
        String::from_utf8_lossy(&retained_acl.stdout).contains("everyone allow read"),
        "{retained_acl:?}"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn rejected_linux_update_leaves_owner_group_acl_and_user_xattr_untouched() {
    use rustix::fs::{XattrFlags, getxattr, setxattr};
    use std::os::unix::fs::MetadataExt;

    fn read_xattr(path: &Path, name: &str) -> Vec<u8> {
        let mut value = vec![0u8; 64 * 1024];
        let length = getxattr(path, name, &mut value[..]).unwrap();
        value.truncate(length);
        value
    }

    let directory = tempdir().unwrap();
    initialize(directory.path());
    let index = directory.path().join("index.md");
    let original = "# Versionless knowledge\n";
    fs::write(&index, original).unwrap();
    let user_xattr = "user.okf-workbench.metadata-test";
    setxattr(&index, user_xattr, b"retained", XattrFlags::empty()).unwrap();

    let named_uid = if fs::metadata(&index).unwrap().uid() == 0 {
        1u32
    } else {
        0u32
    };
    let mut acl = 2u32.to_le_bytes().to_vec();
    for (tag, permissions, id) in [
        (0x01u16, 0x06u16, u32::MAX),
        (0x02u16, 0x04u16, named_uid),
        (0x04u16, 0x04u16, u32::MAX),
        (0x10u16, 0x04u16, u32::MAX),
        (0x20u16, 0x00u16, u32::MAX),
    ] {
        acl.extend(tag.to_le_bytes());
        acl.extend(permissions.to_le_bytes());
        acl.extend(id.to_le_bytes());
    }
    let acl_name = "system.posix_acl_access";
    let acl_supported = match setxattr(&index, acl_name, &acl, XattrFlags::empty()) {
        Ok(()) => true,
        Err(rustix::io::Errno::NOTSUP) => false,
        Err(error) => panic!("cannot install Linux ACL fixture: {error}"),
    };
    let expected_acl = acl_supported.then(|| read_xattr(&index, acl_name));
    let before = fs::metadata(&index).unwrap();

    let output = okf()
        .args(["index", directory.path().to_str().unwrap(), "--apply"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("generation-CAS"));

    let after = fs::metadata(&index).unwrap();
    assert_eq!((after.uid(), after.gid()), (before.uid(), before.gid()));
    assert_eq!(after.mode() & 0o7777, before.mode() & 0o7777);
    assert_eq!(read_xattr(&index, user_xattr), b"retained");
    if let Some(expected_acl) = expected_acl {
        assert_eq!(read_xattr(&index, acl_name), expected_acl);
    }
    assert_eq!(fs::read_to_string(index).unwrap(), original);
}

#[cfg(windows)]
#[test]
fn rejected_windows_update_leaves_sddl_attributes_and_ads_untouched() {
    use std::os::windows::fs::MetadataExt;

    fn sddl(path: &Path) -> String {
        let output = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "(Get-Acl -LiteralPath $env:OKF_SDDL_PATH).Sddl",
            ])
            .env("OKF_SDDL_PATH", path)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        String::from_utf8(output.stdout).unwrap()
    }

    let directory = tempdir().unwrap();
    initialize(directory.path());
    let index = directory.path().join("index.md");
    let original = "# Versionless knowledge\n";
    fs::write(&index, original).unwrap();
    let ads = format!("{}:okf-workbench-metadata-test", index.display());
    fs::write(&ads, "retained").unwrap();
    let before = fs::metadata(&index).unwrap();
    let before_sddl = sddl(&index);

    let output = okf()
        .args(["index", directory.path().to_str().unwrap(), "--apply"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("generation-CAS"));
    let after = fs::metadata(&index).unwrap();
    assert_eq!(after.file_attributes(), before.file_attributes());
    assert_eq!(sddl(&index), before_sddl);
    assert_eq!(fs::read_to_string(&ads).unwrap(), "retained");
    assert_eq!(fs::read_to_string(index).unwrap(), original);
}

#[test]
fn index_explicit_key_root_map_fails_closed_without_replacement_cas() {
    let directory = tempdir().unwrap();
    initialize(directory.path());
    let index = directory.path().join("index.md");
    let original = "---\n!!map\n? type\n: bundle\n? title\n: Knowledge\n---\n# Knowledge\n";
    fs::write(&index, original).unwrap();

    let output = okf()
        .args(["index", directory.path().to_str().unwrap(), "--apply"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("generation-CAS"));
    assert_eq!(fs::read_to_string(index).unwrap(), original);
}

#[test]
fn missing_index_mode_supports_an_inline_tagged_empty_flow_root() {
    let directory = tempdir().unwrap();
    initialize(directory.path());
    let index = directory.path().join("index.md");
    let original = "---\n!!map {}\n---\n# Knowledge\n";
    fs::write(&index, original).unwrap();

    let check = okf()
        .args([
            "index",
            directory.path().to_str().unwrap(),
            "--mode",
            "missing",
            "--check",
        ])
        .output()
        .unwrap();
    assert_eq!(check.status.code(), Some(1), "{check:?}");
    assert_eq!(fs::read_to_string(&index).unwrap(), original);

    let apply = okf()
        .args([
            "index",
            directory.path().to_str().unwrap(),
            "--mode",
            "missing",
            "--apply",
        ])
        .output()
        .unwrap();
    assert_eq!(apply.status.code(), Some(2), "{apply:?}");
    assert!(String::from_utf8_lossy(&apply.stderr).contains("generation-CAS"));
    assert_eq!(fs::read_to_string(index).unwrap(), original);
}

#[test]
fn missing_index_mode_fails_closed_before_updating_an_existing_index() {
    let directory = tempdir().unwrap();
    initialize(directory.path());
    let index = directory.path().join("index.md");
    let original = [
        "# Knowledge",
        "",
        "<!-- okf-workbench:index:start -->",
        "## Contents",
        "",
        "- [Stale](./stale.md)",
        "<!-- okf-workbench:index:end -->",
        "",
    ]
    .join("\n");
    fs::write(&index, &original).unwrap();
    fs::write(
        directory.path().join("alpha.md"),
        "---\ntype: reference\ntitle: Alpha\n---\n",
    )
    .unwrap();

    let output = okf()
        .args([
            "index",
            directory.path().to_str().unwrap(),
            "--mode",
            "missing",
            "--apply",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("generation-CAS"));
    assert_eq!(fs::read_to_string(index).unwrap(), original);
}

#[cfg(unix)]
#[test]
fn authoring_version_checks_ignore_unrelated_bundle_symlinks() {
    use std::os::unix::fs::symlink;

    let directory = tempdir().unwrap();
    initialize(directory.path());
    let outside = tempdir().unwrap();
    symlink(outside.path(), directory.path().join("unrelated-link")).unwrap();

    let created = okf()
        .args([
            "new",
            directory.path().to_str().unwrap(),
            "--title",
            "Added",
            "--path",
            "added.md",
            "--apply",
        ])
        .output()
        .unwrap();
    assert!(created.status.success(), "{created:?}");

    let agent = okf()
        .args([
            "agent",
            directory.path().to_str().unwrap(),
            "--target",
            "agents",
            "--apply",
        ])
        .output()
        .unwrap();
    assert!(agent.status.success(), "{agent:?}");
}

#[cfg(unix)]
#[test]
fn closed_stdout_is_a_clean_pipeline_termination() {
    let directory = tempdir().unwrap();
    initialize(directory.path());
    let mut child = okf()
        .args([
            "graph",
            directory.path().to_str().unwrap(),
            "--format",
            "json",
        ])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    drop(child.stdout.take());
    assert!(child.wait().unwrap().success());
}

#[test]
fn agent_outputs_stay_outside_bundle_validation() {
    let directory = tempdir().unwrap();
    initialize(directory.path());
    let agents_apply = okf()
        .args([
            "agent",
            directory.path().to_str().unwrap(),
            "--target",
            "agents",
            "--apply",
        ])
        .output()
        .unwrap();
    assert!(agents_apply.status.success(), "{agents_apply:?}");
    #[cfg(windows)]
    fs::create_dir_all(
        directory
            .path()
            .join(".agents/skills/maintain-okf-knowledge"),
    )
    .unwrap();
    let skill_apply = okf()
        .args([
            "agent",
            directory.path().to_str().unwrap(),
            "--target",
            "skill",
            "--apply",
        ])
        .output()
        .unwrap();
    assert!(skill_apply.status.success(), "{skill_apply:?}");
    let agents = fs::read_to_string(directory.path().join("AGENTS.md")).unwrap();
    let skill = fs::read_to_string(
        directory
            .path()
            .join(".agents/skills/maintain-okf-knowledge/SKILL.md"),
    )
    .unwrap();
    assert!(agents.contains("When an `okf` executable is available for a local bundle"));
    assert!(skill.contains("okf validate <bundle-root> --format json"));
    assert!(skill.contains("before replacing `--check` with `--apply`"));
    assert!(skill.contains("Multiple creates in an existing root"));

    let validate = okf()
        .args([
            "validate",
            directory.path().to_str().unwrap(),
            "--format",
            "json",
        ])
        .output()
        .unwrap();
    assert!(validate.status.success(), "{validate:?}");
    assert_eq!(json_stdout(&validate)["result"], Value::Array(vec![]));
}

#[test]
fn migrate_is_an_explicit_preview_only_check() {
    let directory = tempdir().unwrap();
    let root = directory.path();
    fs::write(
        root.join("index.md"),
        "---\nokf_version: \"0.1\"\n---\n# Root\n",
    )
    .unwrap();
    let legacy = concat!(
        "---\n",
        "type: Reference\n",
        "title: Legacy\n",
        "description: Legacy provenance\n",
        "timestamp: \"2026-07-22T10:00:00Z\"\n",
        "custom_field: retained\n",
        "---\n",
        "# Legacy\n\n",
        "# Citations\n\n",
        "- https://example.com/source\n",
    );
    fs::write(root.join("legacy.md"), legacy).unwrap();

    let check = okf()
        .args([
            "migrate",
            root.to_str().unwrap(),
            "--to",
            "0.2",
            "--actor",
            "human:reviewer",
            "--check",
        ])
        .output()
        .unwrap();
    assert_eq!(check.status.code(), Some(1), "{check:?}");
    assert_eq!(fs::read_to_string(root.join("legacy.md")).unwrap(), legacy);
    let check_body = json_stdout(&check);
    assert_eq!(check_body["command"], "migrate");
    assert_eq!(check_body["result"]["fromVersion"], "0.1");
    assert_eq!(check_body["result"]["changeCount"], 2);
    assert_eq!(check_body["result"]["applied"], false);
    assert_eq!(check_body["result"]["previewOnly"], true);

    let root_index = fs::read_to_string(root.join("index.md")).unwrap();
    let apply = okf()
        .args([
            "migrate",
            root.to_str().unwrap(),
            "--actor",
            "human:reviewer",
            "--apply",
        ])
        .output()
        .unwrap();
    assert_eq!(apply.status.code(), Some(2), "{apply:?}");
    assert!(String::from_utf8_lossy(&apply.stderr).contains("--apply"));
    assert_eq!(
        fs::read_to_string(root.join("index.md")).unwrap(),
        root_index
    );
    assert_eq!(fs::read_to_string(root.join("legacy.md")).unwrap(), legacy);
}

#[test]
fn migrate_requires_check_even_when_only_manual_follow_up_remains() {
    let directory = tempdir().unwrap();
    let root = directory.path();
    fs::write(
        root.join("index.md"),
        "---\nokf_version: \"0.2\"\n---\n# Root\n",
    )
    .unwrap();
    fs::write(
        root.join("manual.md"),
        "---\ntype: Reference\ntimestamp: &when \"2026-07-22T10:00:00Z\"\n---\n# Manual\n",
    )
    .unwrap();

    let omitted = okf()
        .args([
            "migrate",
            root.to_str().unwrap(),
            "--actor",
            "human:reviewer",
        ])
        .output()
        .unwrap();
    assert_eq!(omitted.status.code(), Some(2), "{omitted:?}");
    assert!(String::from_utf8_lossy(&omitted.stderr).contains("--check"));

    let apply = okf()
        .args([
            "migrate",
            root.to_str().unwrap(),
            "--actor",
            "human:reviewer",
            "--apply",
        ])
        .output()
        .unwrap();
    assert_eq!(apply.status.code(), Some(2), "{apply:?}");
    assert!(String::from_utf8_lossy(&apply.stderr).contains("--apply"));
}

#[cfg(unix)]
#[test]
fn migrate_check_accepts_existing_posix_filename_identities() {
    let directory = tempdir().unwrap();
    let root = directory.path();
    fs::write(
        root.join("index.md"),
        "---\nokf_version: \"0.1\"\n---\n# Root\n",
    )
    .unwrap();
    let legacy = "---\ntype: Reference\ntimestamp: \"2026-07-22T10:00:00Z\"\n---\n# Legacy\n";
    for name in ["notes:2026.md", "CON.md"] {
        fs::write(root.join(name), legacy).unwrap();
    }
    for directory_name in ["trailing.", "trailing "] {
        fs::create_dir(root.join(directory_name)).unwrap();
        fs::write(root.join(directory_name).join("note.md"), legacy).unwrap();
    }

    let check = okf()
        .args([
            "migrate",
            root.to_str().unwrap(),
            "--actor",
            "human:reviewer",
            "--check",
        ])
        .output()
        .unwrap();
    assert_eq!(check.status.code(), Some(1), "{check:?}");
    assert_eq!(json_stdout(&check)["result"]["changeCount"], 5);
    for name in [
        "notes:2026.md",
        "CON.md",
        "trailing./note.md",
        "trailing /note.md",
    ] {
        assert_eq!(fs::read_to_string(root.join(name)).unwrap(), legacy);
    }
}

#[test]
fn unsafe_paths_and_unknown_templates_fail_before_writing() {
    let directory = tempdir().unwrap();
    let outside = directory.path().join("outside.md");
    for arguments in [
        vec![
            "new",
            directory.path().to_str().unwrap(),
            "--title",
            "Escape",
            "--path",
            "../outside",
            "--apply",
        ],
        vec![
            "new",
            directory.path().to_str().unwrap(),
            "--title",
            "Unknown",
            "--template",
            "unknown-template",
            "--apply",
        ],
        vec![
            "new",
            directory.path().to_str().unwrap(),
            "--title",
            "Reserved",
            "--path",
            "nested/index.md",
            "--apply",
        ],
        vec![
            "new",
            directory.path().to_str().unwrap(),
            "--title",
            "Reserved",
            "--path",
            "nested/log.md",
            "--apply",
        ],
        vec![
            "new",
            directory.path().to_str().unwrap(),
            "--title",
            "Missing filename",
            "--path",
            ".md",
            "--apply",
        ],
    ] {
        let output = okf().args(arguments).output().unwrap();
        assert_eq!(output.status.code(), Some(2));
    }
    assert!(!outside.exists());
    assert!(!directory.path().join("nested").exists());
    assert!(!directory.path().join(".md").exists());
}

#[test]
fn new_refuses_non_portable_windows_paths_during_check() {
    let directory = tempdir().unwrap();
    initialize(directory.path());
    for path in [
        "CON.md",
        "folder/aux.md",
        "folder/name?.md",
        "folder/name%3F.md",
        "folder/trailing.",
    ] {
        let output = okf()
            .args([
                "new",
                directory.path().to_str().unwrap(),
                "--title",
                "Portable path required",
                "--path",
                path,
                "--check",
            ])
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2), "{path:?}: {output:?}");
    }
    assert!(!directory.path().join("CON.md").exists());
    assert!(!directory.path().join("folder").exists());
}

#[test]
fn new_appends_markdown_extension_to_default_and_explicit_paths() {
    let directory = tempdir().unwrap();
    initialize(directory.path());
    #[cfg(windows)]
    fs::create_dir(directory.path().join("nested")).unwrap();
    for arguments in [
        vec![
            "new",
            directory.path().to_str().unwrap(),
            "--title",
            "Default Path",
            "--apply",
        ],
        vec![
            "new",
            directory.path().to_str().unwrap(),
            "--title",
            "Explicit Path",
            "--path",
            "nested/explicit",
            "--apply",
        ],
    ] {
        let output = okf().args(arguments).output().unwrap();
        assert!(output.status.success(), "{output:?}");
    }
    assert!(directory.path().join("default-path.md").is_file());
    assert!(directory.path().join("nested/explicit.md").is_file());
}

#[cfg(windows)]
#[test]
fn windows_existing_root_create_requires_an_existing_direct_parent() {
    let directory = tempdir().unwrap();
    initialize(directory.path());

    let output = okf()
        .args([
            "new",
            directory.path().to_str().unwrap(),
            "--title",
            "Missing Parent",
            "--path",
            "nested/concept.md",
            "--apply",
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("must already exist"),
        "{output:?}"
    );
    assert!(!directory.path().join("nested").exists());
}

#[cfg(unix)]
#[test]
fn symbolic_link_bundle_root_is_refused() {
    use std::os::unix::fs::symlink;

    let directory = tempdir().unwrap();
    let real = directory.path().join("real");
    fs::create_dir(&real).unwrap();
    initialize(&real);
    let linked = directory.path().join("linked");
    symlink(&real, &linked).unwrap();

    let output = okf()
        .args(["validate", linked.to_str().unwrap(), "--format", "json"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("not a real directory"));
}

#[cfg(unix)]
#[test]
fn symbolic_link_bundle_root_ancestor_is_refused_before_writing() {
    use std::os::unix::fs::symlink;

    let directory = tempdir().unwrap();
    let real_parent = directory.path().join("real-parent");
    let real_root = real_parent.join("bundle");
    fs::create_dir_all(&real_root).unwrap();
    initialize(&real_root);
    let linked_parent = directory.path().join("linked-parent");
    symlink(&real_parent, &linked_parent).unwrap();
    let linked_root = linked_parent.join("bundle");

    let output = okf()
        .args([
            "new",
            linked_root.to_str().unwrap(),
            "--title",
            "Must not escape",
            "--path",
            "outside.md",
            "--apply",
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("not a real directory"));
    assert!(!real_root.join("outside.md").exists());
}

#[cfg(unix)]
#[test]
fn check_refuses_a_symbolic_link_in_the_generated_parent_chain() {
    use std::os::unix::fs::symlink;

    let directory = tempdir().unwrap();
    let root = directory.path().join("bundle");
    fs::create_dir(&root).unwrap();
    initialize(&root);
    let outside = directory.path().join("outside");
    fs::create_dir(&outside).unwrap();
    symlink(&outside, root.join("linked-parent")).unwrap();

    let output = okf()
        .args([
            "new",
            root.to_str().unwrap(),
            "--title",
            "Must not escape",
            "--path",
            "linked-parent/outside.md",
            "--check",
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("unsafe parent"));
    assert!(!outside.join("outside.md").exists());
}

#[cfg(unix)]
#[test]
fn check_refuses_a_dangling_symbolic_link_target() {
    use std::os::unix::fs::symlink;

    let directory = tempdir().unwrap();
    initialize(directory.path());
    let target = directory.path().join("dangling.md");
    symlink(directory.path().join("missing.md"), &target).unwrap();

    let output = okf()
        .args([
            "new",
            directory.path().to_str().unwrap(),
            "--title",
            "Must not replace",
            "--path",
            "dangling.md",
            "--check",
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("unsafe existing target"));
    assert!(
        fs::symlink_metadata(target)
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

fn initialize(root: &Path) {
    let output = okf()
        .args(["init", root.to_str().unwrap(), "--apply"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{:?}", output);
}
