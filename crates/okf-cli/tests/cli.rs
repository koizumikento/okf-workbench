use serde_json::Value;
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
