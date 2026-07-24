mod workspace;

use chrono::{DateTime, SecondsFormat, Utc};
use clap::{Args, Parser, Subcommand, ValueEnum};
use okf_core::{
    AgentTarget, BundlePreset, CORE_VERSION, ConceptTemplateInput, IndexMode, RenderedFile,
    agent_files, build_graph_payload, bundle_preset_files, concept_template_file, index_files,
    parse_bundle, validate_bundle,
};
use serde::Serialize;
use std::{
    io::{self, IsTerminal, Write},
    path::PathBuf,
    process::ExitCode,
    time::SystemTime,
};
use workspace::{
    PlanMode, PlannedChange, apply_plan, load_bundle, plan_files, validate_relative_path,
};

const CONCEPT_TEMPLATES: &[&str] = &[
    "generic-concept",
    "decision",
    "metric",
    "api-endpoint",
    "data-table",
    "playbook",
    "reference",
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
    #[arg(long, default_value = "concept")]
    r#type: String,
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
            let path = args.path.unwrap_or_else(|| slug(&args.title));
            validate_relative_path(&path)?;
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
            if args.r#type.trim().is_empty() {
                return Err("concept type must not be empty".to_owned());
            }
            let files = vec![concept_template_file(&ConceptTemplateInput {
                template: args.template,
                relative_path: path,
                r#type: args.r#type,
                title: args.title,
                description: args.description,
                tags: args.tags,
                timestamp: Some(timestamp()),
            })];
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
            let input = load_bundle(&args.root)?;
            let bundle = parse_bundle(input);
            let mode = match args.mode {
                IndexModeArg::Missing => IndexMode::Missing,
                IndexModeArg::All => IndexMode::All,
            };
            run_write(
                "index",
                args.root,
                index_files(&bundle, mode),
                args.write,
                PlanMode::MergeIndexes,
            )
        }
        Command::Graph(args) => {
            if !matches!(args.format, OutputFormat::Json) {
                return Err("`okf graph` supports only `--format json`; 3D rendering belongs to the editor Webview.".to_owned());
            }
            let bundle = parse_bundle(load_bundle(&args.root)?);
            let graph = build_graph_payload(&bundle);
            write_json(&JsonEnvelope {
                schema_version: 1,
                command: "graph",
                result: graph,
            })?;
            Ok(0)
        }
        Command::Agent(args) => {
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

fn run_write(
    command: &'static str,
    root: PathBuf,
    files: Vec<RenderedFile>,
    flags: WriteFlags,
    mode: PlanMode,
) -> Result<u8, String> {
    let root = absolute(root)?;
    let plan = plan_files(&root, files, mode)?;
    let should_apply = if flags.check || plan.is_empty() {
        false
    } else if flags.apply {
        true
    } else if io::stdin().is_terminal() && io::stderr().is_terminal() {
        let mut stderr = io::stderr().lock();
        writeln!(stderr, "{} change(s) are ready:", plan.len()).map_err(io_error)?;
        for change in &plan {
            writeln!(stderr, "  {} {}", change.operation, change.relative_path)
                .map_err(io_error)?;
        }
        write!(stderr, "Apply this complete plan? [y/N] ").map_err(io_error)?;
        stderr.flush().map_err(io_error)?;
        let mut answer = String::new();
        io::stdin().read_line(&mut answer).map_err(io_error)?;
        matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes")
    } else {
        return Err("a non-interactive write requires explicit `--apply`; use `--check` to inspect without writing".to_owned());
    };
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
