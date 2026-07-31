use serde_json::Value;
#[cfg(unix)]
use std::process::Stdio;
use std::{fs, path::Path, process::Command};
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
fn version_and_new_use_the_stable_json_envelope() {
    let version = okf().arg("version").output().unwrap();
    assert!(version.status.success(), "{version:?}");
    let version_body = json_stdout(&version);
    assert_eq!(version_body["schemaVersion"], 1);
    assert_eq!(version_body["command"], "version");
    assert_eq!(version_body["result"]["abiVersion"], 1);

    let directory = tempdir().unwrap();
    initialize(directory.path());
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
fn index_adds_v02_declaration_to_an_existing_versionless_root() {
    let directory = tempdir().unwrap();
    initialize(directory.path());
    fs::write(
        directory.path().join("index.md"),
        "# Knowledge\n\nHuman introduction.\n",
    )
    .unwrap();
    let output = okf()
        .args(["index", directory.path().to_str().unwrap(), "--apply"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let root = fs::read_to_string(directory.path().join("index.md")).unwrap();
    assert!(root.starts_with("---\nokf_version: \"0.2\"\n---\n"));
    assert!(root.contains("Human introduction."));
}

#[test]
fn missing_index_mode_only_adds_the_root_version_to_an_existing_index() {
    let directory = tempdir().unwrap();
    initialize(directory.path());
    fs::write(
        directory.path().join("index.md"),
        [
            "# Knowledge",
            "",
            "<!-- okf-workbench:index:start -->",
            "## Contents",
            "",
            "- [Stale](./stale.md)",
            "<!-- okf-workbench:index:end -->",
            "",
        ]
        .join("\n"),
    )
    .unwrap();
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
    assert!(output.status.success(), "{output:?}");
    let root = fs::read_to_string(directory.path().join("index.md")).unwrap();
    assert!(root.starts_with("---\nokf_version: \"0.2\"\n---\n"));
    assert!(root.contains("- [Stale](./stale.md)"));
    assert!(!root.contains("- [Alpha](./alpha.md)"));
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
    let agent = okf()
        .args([
            "agent",
            directory.path().to_str().unwrap(),
            "--target",
            "both",
            "--apply",
        ])
        .output()
        .unwrap();
    assert!(agent.status.success(), "{agent:?}");
    let agents = fs::read_to_string(directory.path().join("AGENTS.md")).unwrap();
    let skill = fs::read_to_string(
        directory
            .path()
            .join(".agents/skills/maintain-okf-knowledge/SKILL.md"),
    )
    .unwrap();
    assert!(agents.contains("When an `okf` executable is available for a local bundle"));
    assert!(skill.contains("okf validate <bundle-root> --format json"));
    assert!(skill.contains("with `--apply` instead of `--check`"));

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
    ] {
        let output = okf().args(arguments).output().unwrap();
        assert_eq!(output.status.code(), Some(2));
    }
    assert!(!outside.exists());
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

fn initialize(root: &Path) {
    let output = okf()
        .args(["init", root.to_str().unwrap(), "--apply"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{:?}", output);
}
