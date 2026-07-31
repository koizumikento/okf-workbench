mod workspace;

use chrono::{DateTime, SecondsFormat, Utc};
use clap::{Args, Parser, Subcommand, ValueEnum};
use okf_core::{
    AgentTarget, BundlePreset, CORE_VERSION, ConceptTemplateInput, IndexMode,
    MigrationDocumentResult, MigrationInput, RenderedFile, agent_files,
    build_graph_payload_checked, bundle_preset_files, concept_template_file_checked, index_files,
    is_future_minor_version, migrate_bundle, parse_bundle, validate_bundle,
};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    io::{self, IsTerminal, Write},
    path::{Path, PathBuf},
    process::ExitCode,
    time::SystemTime,
};
use workspace::{
    PlanMode, PlannedChange, apply_plan, load_bundle, load_root_index, plan_files,
    plan_replacement_files, validate_relative_path,
};

const CONCEPT_TEMPLATES: &[&str] = &[
    "generic-concept",
    "decision",
    "metric",
    "api-endpoint",
    "data-table",
    "playbook",
    "reference",
    "attested-computation",
];

#[derive(Debug, Parser)]
#[command(name = "okf", version, about = "Offline OKF bundle workbench")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Init(InitArgs),
    New(NewArgs),
    Validate(ValidateArgs),
    Index(IndexArgs),
    Graph(GraphArgs),
    Agent(AgentArgs),
    Migrate(MigrateArgs),
    Version,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum PresetArg {
    Minimal,
    #[value(name = "software-project")]
    Software,
    #[value(name = "data-analytics")]
    Data,
}

impl From<PresetArg> for BundlePreset {
    fn from(value: PresetArg) -> Self {
        match value {
            PresetArg::Minimal => Self::Minimal,
            PresetArg::Software => Self::SoftwareProject,
            PresetArg::Data => Self::DataAnalytics,
        }
    }
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum OutputFormat {
    Human,
    Json,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum IndexModeArg {
    Missing,
    All,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum AgentTargetArg {
    Agents,
    Skill,
    Both,
}

#[derive(Debug, Args)]
struct WriteFlags {
    /// Report whether changes are needed without writing.
    #[arg(long, conflicts_with = "apply")]
    check: bool,
    /// Apply the complete reviewed change plan.
    #[arg(long)]
    apply: bool,
}

#[derive(Debug, Args)]
struct InitArgs {
    #[arg(default_value = ".")]
    path: PathBuf,
    #[arg(long, value_enum, default_value = "minimal")]
    preset: PresetArg,
    #[command(flatten)]
    write: WriteFlags,
}

#[derive(Debug, Args)]
struct NewArgs {
    #[arg(default_value = ".")]
    root: PathBuf,
    #[arg(long, default_value = "generic-concept")]
    template: String,
    #[arg(long)]
    title: String,
    #[arg(long)]
    path: Option<String>,
    #[arg(long)]
    r#type: Option<String>,
    #[arg(long)]
    description: Option<String>,
    #[arg(long, value_delimiter = ',')]
    tags: Vec<String>,
    #[command(flatten)]
    write: WriteFlags,
}

#[derive(Debug, Args)]
struct ValidateArgs {
    #[arg(default_value = ".")]
    root: PathBuf,
    #[arg(long, value_enum, default_value = "human")]
    format: OutputFormat,
}

#[derive(Debug, Args)]
struct IndexArgs {
    #[arg(default_value = ".")]
    root: PathBuf,
    #[arg(long, value_enum, default_value = "missing")]
    mode: IndexModeArg,
    #[command(flatten)]
    write: WriteFlags,
}

#[derive(Debug, Args)]
struct GraphArgs {
    #[arg(default_value = ".")]
    root: PathBuf,
    #[arg(long, value_enum, default_value = "json")]
    format: OutputFormat,
}

#[derive(Debug, Args)]
struct AgentArgs {
    #[arg(default_value = ".")]
    root: PathBuf,
    #[arg(long, value_enum, default_value = "both")]
    target: AgentTargetArg,
    #[command(flatten)]
    write: WriteFlags,
}

#[derive(Debug, Args)]
struct MigrateArgs {
    #[arg(default_value = ".")]
    root: PathBuf,
    #[arg(long, default_value = "0.2")]
    to: String,
    #[arg(long)]
    actor: String,
    #[command(flatten)]
    write: WriteFlags,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonEnvelope<T: Serialize> {
    schema_version: u8,
    command: &'static str,
    result: T,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanOutput<'a> {
    root: String,
    change_count: usize,
    applied: bool,
    changes: &'a [PlannedChange],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MigrationOutput<'a> {
    root: String,
    from_version: &'a str,
    to_version: &'a str,
    change_count: usize,
    applied: bool,
    changes: &'a [PlannedChange],
    documents: &'a [MigrationDocumentResult],
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            let _ = writeln!(io::stderr().lock(), "okf: {error}");
            ExitCode::from(2)
        }
    }
}

fn run(cli: Cli) -> Result<u8, String> {
    match cli.command {
        Command::Init(args) => {
            let timestamp = timestamp();
            let files = bundle_preset_files(args.preset.into(), &timestamp);
            run_write("init", args.path, files, args.write, PlanMode::CreateOnly)
        }
        Command::New(args) => {
            ensure_supported_root_version(&args.root)?;
            let mut path = args.path.unwrap_or_else(|| slug(&args.title));
            validate_relative_path(&path)?;
            if !path.ends_with(".md") {
                path.push_str(".md");
            }
            if !CONCEPT_TEMPLATES.contains(&args.template.as_str()) {
                return Err(format!(
                    "unknown concept template {:?}; choose one of {}",
                    args.template,
                    CONCEPT_TEMPLATES.join(", ")
                ));
            }
            if args.title.trim().is_empty() {
                return Err("concept title must not be empty".to_owned());
            }
            let concept_type = args.r#type.unwrap_or_else(|| {
                if args.template == "attested-computation" {
                    "Attested Computation".to_owned()
                } else {
                    "concept".to_owned()
                }
            });
            if concept_type.trim().is_empty() {
                return Err("concept type must not be empty".to_owned());
            }
            let files = vec![concept_template_file_checked(&ConceptTemplateInput {
                template: args.template,
                relative_path: path,
                r#type: concept_type,
                title: args.title,
                description: args.description,
                tags: args.tags,
                timestamp: Some(timestamp()),
            })?];
            run_write("new", args.root, files, args.write, PlanMode::CreateOnly)
        }
        Command::Validate(args) => {
            let input = load_bundle(&args.root)?;
            let bundle = parse_bundle(input);
            let findings = validate_bundle(&bundle, &timestamp());
            match args.format {
                OutputFormat::Json => write_json(&JsonEnvelope {
                    schema_version: 1,
                    command: "validate",
                    result: &findings,
                })?,
                OutputFormat::Human => {
                    let mut stdout = io::stdout().lock();
                    if findings.is_empty() {
                        write_line(&mut stdout, "OKF validation: clean")?;
                    }
                    for finding in &findings {
                        write_line(
                            &mut stdout,
                            &format!(
                                "{} {} {}: {}",
                                finding.severity, finding.code, finding.uri, finding.message
                            ),
                        )?;
                    }
                }
            }
            Ok(u8::from(
                findings
                    .iter()
                    .any(|finding| finding.category == "conformance"),
            ))
        }
        Command::Index(args) => {
            let bundle = ensure_supported_write_version(&args.root)?;
            if let Some(parse_failure) = bundle.failures.first() {
                return Err(format!(
                    "index generation refused an incomplete bundle: {}: {}",
                    parse_failure.bundle_path, parse_failure.message
                ));
            }
            let mode = match args.mode {
                IndexModeArg::Missing => IndexMode::Missing,
                IndexModeArg::All => IndexMode::All,
            };
            let ensure_root_version = bundle
                .reserved_documents
                .iter()
                .find(|document| document.source.bundle_path.replace('\\', "/") == "index.md")
                .is_none_or(|document| {
                    document
                        .frontmatter
                        .as_ref()
                        .is_none_or(|frontmatter| !frontmatter.raw.contains_key("okf_version"))
                });
            let mut files = index_files(&bundle, mode);
            if ensure_root_version
                && !files
                    .iter()
                    .any(|file| file.relative_path.replace('\\', "/") == "index.md")
                && let Some(root_index) = index_files(&bundle, IndexMode::All)
                    .into_iter()
                    .find(|file| file.relative_path.replace('\\', "/") == "index.md")
            {
                files.push(root_index);
            }
            run_write(
                "index",
                args.root,
                files,
                args.write,
                PlanMode::MergeIndexes {
                    ensure_root_version,
                    update_existing_regions: matches!(mode, IndexMode::All),
                },
            )
        }
        Command::Graph(args) => {
            if !matches!(args.format, OutputFormat::Json) {
                return Err("`okf graph` supports only `--format json`; 3D rendering belongs to the editor Webview.".to_owned());
            }
            let bundle = parse_bundle(load_bundle(&args.root)?);
            let graph = build_graph_payload_checked(&bundle)?;
            write_json(&JsonEnvelope {
                schema_version: 1,
                command: "graph",
                result: graph,
            })?;
            Ok(0)
        }
        Command::Agent(args) => {
            ensure_supported_root_version(&args.root)?;
            let target = match args.target {
                AgentTargetArg::Agents => AgentTarget::Agents,
                AgentTargetArg::Skill => AgentTarget::Skill,
                AgentTargetArg::Both => AgentTarget::Both,
            };
            run_write(
                "agent",
                args.root,
                agent_files(target, "."),
                args.write,
                PlanMode::MergeAgent,
            )
        }
        Command::Migrate(args) => run_migration(args),
        Command::Version => {
            write_json(&JsonEnvelope {
                schema_version: 1,
                command: "version",
                result: serde_json::json!({
                    "cliVersion": env!("CARGO_PKG_VERSION"),
                    "coreVersion": CORE_VERSION,
                    "abiVersion": okf_core::ABI_VERSION,
                }),
            })?;
            Ok(0)
        }
    }
}

fn ensure_supported_write_version(root: &Path) -> Result<okf_core::ParsedBundle, String> {
    let bundle = parse_bundle(load_bundle(root)?);
    ensure_supported_version(&bundle)?;
    Ok(bundle)
}

fn ensure_supported_root_version(root: &Path) -> Result<(), String> {
    ensure_supported_version(&parse_bundle(load_root_index(root)?))
}

fn ensure_supported_version(bundle: &okf_core::ParsedBundle) -> Result<(), String> {
    if let Some(failure) = bundle
        .failures
        .iter()
        .find(|failure| failure.bundle_path.replace('\\', "/") == "index.md")
    {
        return Err(format!(
            "write refused because the root index cannot be inspected: {}",
            failure.message
        ));
    }
    let Some(index) = bundle
        .reserved_documents
        .iter()
        .find(|document| document.source.bundle_path.replace('\\', "/") == "index.md")
    else {
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
        return Ok(());
    }
    Err(format!(
        "write refused because the bundle declares unsupported OKF version {version:?}"
    ))
}

fn run_write(
    command: &'static str,
    root: PathBuf,
    files: Vec<RenderedFile>,
    flags: WriteFlags,
    mode: PlanMode,
) -> Result<u8, String> {
    let root = absolute(root)?;
    let plan = plan_files(&root, files, mode)?;
    let should_apply = should_apply(&flags, &plan)?;
    if should_apply {
        apply_plan(&root, &plan)?;
    }
    write_json(&JsonEnvelope {
        schema_version: 1,
        command,
        result: PlanOutput {
            root: root.display().to_string(),
            change_count: plan.len(),
            applied: should_apply,
            changes: &plan,
        },
    })?;
    Ok(if flags.check && !plan.is_empty() {
        1
    } else {
        0
    })
}

fn run_migration(args: MigrateArgs) -> Result<u8, String> {
    if args.to != "0.2" {
        return Err(format!(
            "unsupported migration target {:?}; only `--to 0.2` is available",
            args.to
        ));
    }
    let root = absolute(args.root)?;
    let bundle = load_bundle(&root)?;
    let expected_contents = migration_source_snapshots(&bundle)?;
    let migration = migrate_bundle(MigrationInput {
        bundle,
        actor: args.actor,
    })?;
    let plan = plan_replacement_files(&root, migration.files.clone(), &expected_contents)?;
    let should_apply = should_apply(&args.write, &plan)?;
    if should_apply {
        apply_plan(&root, &plan)?;
    }
    write_json(&JsonEnvelope {
        schema_version: 1,
        command: "migrate",
        result: MigrationOutput {
            root: root.display().to_string(),
            from_version: &migration.from_version,
            to_version: migration.to_version,
            change_count: plan.len(),
            applied: should_apply,
            changes: &plan,
            documents: &migration.documents,
        },
    })?;
    let needs_attention = !plan.is_empty()
        || migration
            .documents
            .iter()
            .any(|document| document.manual_follow_up);
    Ok(if args.write.check && needs_attention {
        1
    } else {
        0
    })
}

fn migration_source_snapshots(
    input: &okf_core::ParseBundleInput,
) -> Result<BTreeMap<String, String>, String> {
    input
        .documents
        .iter()
        .map(|document| {
            let content = match document.content.as_ref() {
                Some(okf_core::DocumentContent::Text(value)) => value.clone(),
                Some(okf_core::DocumentContent::Bytes(bytes)) => String::from_utf8(bytes.clone())
                    .map_err(|_| {
                    format!("migration requires valid UTF-8 in {}", document.bundle_path)
                })?,
                Some(okf_core::DocumentContent::InvalidUtf16 { .. }) => {
                    return Err(format!(
                        "migration requires valid UTF-16 text in {}",
                        document.bundle_path
                    ));
                }
                None => {
                    return Err(format!(
                        "migration cannot snapshot {} completely",
                        document.bundle_path
                    ));
                }
            };
            Ok((document.bundle_path.clone(), content))
        })
        .collect()
}

fn should_apply(flags: &WriteFlags, plan: &[PlannedChange]) -> Result<bool, String> {
    if flags.check || plan.is_empty() {
        return Ok(false);
    }
    if flags.apply {
        return Ok(true);
    }
    if io::stdin().is_terminal() && io::stderr().is_terminal() {
        let mut stderr = io::stderr().lock();
        writeln!(stderr, "{} change(s) are ready:", plan.len()).map_err(io_error)?;
        for change in plan {
            writeln!(stderr, "  {} {}", change.operation, change.relative_path)
                .map_err(io_error)?;
        }
        write!(stderr, "Apply this complete plan? [y/N] ").map_err(io_error)?;
        stderr.flush().map_err(io_error)?;
        let mut answer = String::new();
        io::stdin().read_line(&mut answer).map_err(io_error)?;
        return Ok(matches!(
            answer.trim().to_ascii_lowercase().as_str(),
            "y" | "yes"
        ));
    }
    Err(
        "a non-interactive write requires explicit `--apply`; use `--check` to inspect without writing"
            .to_owned(),
    )
}

fn absolute(path: PathBuf) -> Result<PathBuf, String> {
    if path.is_absolute() {
        Ok(path)
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .map_err(io_error)
    }
}

fn timestamp() -> String {
    DateTime::<Utc>::from(SystemTime::now()).to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn slug(value: &str) -> String {
    let slug = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if slug.is_empty() {
        "concept".to_owned()
    } else {
        slug
    }
}

fn write_json(value: &impl Serialize) -> Result<(), String> {
    let mut stdout = io::stdout().lock();
    match serde_json::to_writer_pretty(&mut stdout, value) {
        Ok(()) => write_line(&mut stdout, ""),
        Err(error) if error.io_error_kind() == Some(io::ErrorKind::BrokenPipe) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn write_line(writer: &mut impl Write, value: &str) -> Result<(), String> {
    match writeln!(writer, "{value}") {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => Ok(()),
        Err(error) => Err(io_error(error)),
    }
}

fn io_error(error: io::Error) -> String {
    error.to_string()
}
