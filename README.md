# OKF Workbench

Create, validate, index, and explore Open Knowledge Format bundles locally in VS Code-compatible
desktop editors.

OKF Workbench implements a local authoring loop for the
[Open Knowledge Format (OKF) v0.2 specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/3fcbb9f828c2f23d109c855ee403c3a4c81f3a96/okf/SPEC.md),
while retaining guarded read and authoring compatibility for v0.1 bundles:

```text
initialize -> create -> edit -> validate -> explore -> repair
```

## What it does

- Adds an OKF Workbench Activity Bar container for bundle status, Markdown resource navigation,
  and direct access to the authoring loop and 3D Graph.
- Initializes Minimal, Software Project, or Data & Analytics bundles with collision-safe
  create-only writes.
- Creates concepts from eight built-in templates, including Attested Computation, while allowing arbitrary non-empty concept
  types.
- Normalizes v0.2 provenance, verification, trust, lifecycle, and computation metadata without
  executing producer-supplied resources.
- Reports OKF conformance errors separately from actionable curation warnings in the Problems
  panel, while keeping valid orphan concepts free of editor warning decorations.
- Regenerates managed `index.md` regions without replacing unrelated content.
- Builds a read-only, searchable 3D graph of concepts and directed internal Markdown links.
- Shows details, backlinks, broken-link warnings, orphan state, type, tag, and folder-subtree
  filters, clickable folder breadcrumbs, and an accessible non-spatial node list.
- Can group the 3D layout by the bundle's folder hierarchy without adding semantic nodes or links.
- Supports mouse and trackpad rotation, panning, and zoom, plus visible fit, focus, reset, help,
  and keyboard camera controls.
- Opens source Markdown from graph nodes and refreshes the selected bundle after workspace
  changes.
- Generates a managed `AGENTS.md` section and a project-local Agent Skill, previewing any proposal
  that would update or replace an existing file.
- Includes an offline native `okf` CLI backed by the same Rust core used by the extension through
  a capability-free Wasm adapter, both in supported platform VSIX packages and as standalone
  release archives.

## Commands

| Command Palette title | Stable command ID |
| --- | --- |
| `OKF: Initialize Bundle` | `okfWorkbench.initializeBundle` |
| `OKF: New Concept` | `okfWorkbench.newConcept` |
| `OKF: Validate Bundle` | `okfWorkbench.validateBundle` |
| `OKF: Regenerate Indexes` | `okfWorkbench.regenerateIndexes` |
| `OKF: Open 3D Graph` | `okfWorkbench.openGraph` |
| `OKF: Set Up Agent Integration` | `okfWorkbench.setupAgentIntegration` |
| `OKF: Review Pending Changes` | `okfWorkbench.reviewPendingChanges` |
| `OKF: Select Bundle` | `okfWorkbench.selectBundle` |
| `OKF: Refresh Bundle` | `okfWorkbench.refreshBundle` |
| `OKF: Show CLI Status` | `okfWorkbench.showCliStatus` |
| `OKF: Open CLI Terminal` | `okfWorkbench.openCliTerminal` |

Open the **OKF Workbench** icon in the Activity Bar to select a bundle, inspect current counts,
browse nested concepts and reserved documents, open source, and launch the existing 3D Graph.
The same six core `OKF:` workflows remain available from the Command Palette or an Explorer folder
context menu. Authoring commands require a trusted workspace. Validation, resource navigation, and
graph inspection remain read-only. While an authoring preview awaits a decision, the status bar shows
`OKF changes awaiting review`; activate it, or run `OKF: Review Pending Changes`, to bring back the
exact summary and choose Apply or Cancel. Proposals containing only new files apply immediately
after the final input; collision checks refuse an existing target without overwriting it.

The extension targets VS Code-compatible desktop editors with API floor `^1.121.0`. Compatibility
is specific to the editor version, operating system, and exact extension package; the manifest
floor is not a universal compatibility guarantee.

## Command-line interface

Build the native CLI with the pinned Rust toolchain:

```sh
cargo build --locked --release --bin okf
./target/release/okf --help
```

The CLI provides `init`, `new`, `validate`, `index`, `graph`, `agent`, and `version`. Read commands
never write. Write commands first report a complete plan; non-interactive writes require
`--apply`, and `--check` reports whether changes are needed without modifying the workspace.
A single-create plan for an existing bundle can be applied. An all-create plan for a missing bundle
root is built privately and published as one no-replace directory operation. Existing-root plans
with multiple creates, and every plan containing an existing-file update, fail closed before any
write because the supported filesystems do not expose the required complete-plan transaction or
generation-CAS and metadata-preserving replacement primitives.
`validate --format json` and `graph --format json` emit a versioned JSON envelope for automation.

Open VSX selects a target package for macOS arm64/x64, Linux x64, or Windows x64 when supported.
The bundled CLI is appended to `PATH` for new integrated terminals, without changing shell profile
files or shadowing an existing standalone `okf` earlier in `PATH`. `OKF_WORKBENCH_CLI` points to the
exact validated bundled executable. Disable this with
`okfWorkbench.cli.exposeInIntegratedTerminal`, or run `OKF: Show CLI Status` to inspect the current
Extension Host. A universal CLI-free VSIX remains available for other targets; standalone archives
support external shells, CI, and editor-free use.

## Safety and file ownership

- Markdown in the workspace is the source of truth; the graph is derived and read-only.
- Create-only changes are path-contained and atomically collision-checked; any proposal that may
  update or replace an existing file is previewed before application.
- Existing unrelated `index.md` and `AGENTS.md` content is preserved through managed regions.
- Unknown frontmatter fields and arbitrary non-empty concept types remain valid.
- Webview scripts and styles are packaged locally under a restrictive Content Security Policy.
- Disabling or uninstalling the extension does not delete generated bundles or agent instructions.

## Privacy

OKF Workbench processes workspace Markdown and file metadata locally through editor workspace APIs.
It has no built-in account, authentication flow, telemetry, analytics, advertising, AI provider,
content upload, synchronization service, or runtime HTTP client. It does not intentionally send
bundle content, filenames, frontmatter, links, prompts, diagnostics, or graph data to the
maintainer or a hosted service.

Only a serializable graph presentation payload crosses into the Webview. Source URIs and proposed
file contents stay in the Extension Host, and the Webview's Content Security Policy disables
network connections. The output channel is designed to record operational metadata without
workspace bodies, proposed content, source URIs, credentials, or secret-bearing fields.

Editor update checks, extension-registry access, Git, remote-workspace providers, filesystem
synchronization, and any external coding agent configured by the user are separate software and
are outside this extension's bundle-processing boundary. `OKF: Set Up Agent Integration` only
generates local instruction files; it does not install, invoke, or configure an AI model.

## License and notices

OKF Workbench is licensed under the MIT License. The packaged VSIX includes the complete project
license as `LICENSE.txt` and the bundled production-dependency inventory and license texts as
`THIRD_PARTY_NOTICES.md` and `RUST_THIRD_PARTY_NOTICES.md`.

The extension identifier is `straydog.okf-workbench`.

## Project resources

- [Project site](https://koizumikento.github.io/okf-workbench/)
- [Source code](https://github.com/koizumikento/okf-workbench)
- [Issue tracker](https://github.com/koizumikento/okf-workbench/issues)
- [Privacy statement](https://koizumikento.github.io/okf-workbench/privacy/)
- [Support](https://koizumikento.github.io/okf-workbench/support/)
- [Security policy](https://koizumikento.github.io/okf-workbench/security/)
- [Third-party notices](https://koizumikento.github.io/okf-workbench/notices/)
