# OKF Workbench

Create, validate, index, and explore Open Knowledge Format bundles locally in VS Code-compatible
desktop editors.

OKF Workbench implements a local authoring loop for the
[Open Knowledge Format (OKF) v0.1 specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/ee67a5ca27044ebe7c38385f5b6cffc2305a9c1a/okf/SPEC.md):

```text
initialize -> create -> edit -> validate -> explore -> repair
```

## What it does

- Initializes Minimal, Software Project, or Data & Analytics bundles after preview and
  confirmation.
- Creates concepts from seven built-in templates while allowing arbitrary non-empty concept
  types.
- Reports OKF conformance errors separately from curation warnings in the Problems panel.
- Regenerates managed `index.md` regions without replacing unrelated content.
- Builds a read-only, searchable 3D graph of concepts and directed internal Markdown links.
- Shows details, backlinks, broken-link warnings, orphan state, type and tag filters, and an
  accessible non-spatial node list.
- Opens source Markdown from graph nodes and refreshes the selected bundle after workspace
  changes.
- Generates a managed `AGENTS.md` section and a project-local Agent Skill after preview.

## Commands

| Command Palette title | Stable command ID |
| --- | --- |
| `OKF: Initialize Bundle` | `okfWorkbench.initializeBundle` |
| `OKF: New Concept` | `okfWorkbench.newConcept` |
| `OKF: Validate Bundle` | `okfWorkbench.validateBundle` |
| `OKF: Regenerate Indexes` | `okfWorkbench.regenerateIndexes` |
| `OKF: Open 3D Graph` | `okfWorkbench.openGraph` |
| `OKF: Set Up Agent Integration` | `okfWorkbench.setupAgentIntegration` |

Open a workspace folder and run the `OKF:` commands from the Command Palette or an Explorer folder
context menu. Authoring commands require a trusted workspace. Validation and graph inspection
remain read-only.

The extension targets VS Code-compatible desktop editors with API floor `^1.121.0`. Compatibility
is specific to the editor version, operating system, and exact extension package; the manifest
floor is not a universal compatibility guarantee.

## Safety and file ownership

- Markdown in the workspace is the source of truth; the graph is derived and read-only.
- Generated changes are previewed, path-contained, and collision-checked before application.
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
`THIRD_PARTY_NOTICES.md`.

The extension identifier is `straydog.okf-workbench`.

## Project resources

- [Project site](https://koizumikento.github.io/okf-workbench/)
- [Source code](https://github.com/koizumikento/okf-workbench)
- [Issue tracker](https://github.com/koizumikento/okf-workbench/issues)
- [Privacy statement](https://koizumikento.github.io/okf-workbench/privacy/)
- [Support](https://koizumikento.github.io/okf-workbench/support/)
- [Security policy](https://koizumikento.github.io/okf-workbench/security/)
- [Third-party notices](https://koizumikento.github.io/okf-workbench/notices/)
