# OKF Workbench

Create, validate, index, and explore Open Knowledge Format bundles locally in VS Code-compatible
editors.

> Release status: the MVP implementation is a local release candidate. It has not been published
> to Open VSX. Project-license approval, exact final-candidate compatibility reruns, the remaining
> hosted compatibility lanes, public support resources, and protected publication approval remain
> release gates.

OKF Workbench is a local-first editor extension for the
[Open Knowledge Format (OKF) v0.1 specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/ee67a5ca27044ebe7c38385f5b6cffc2305a9c1a/okf/SPEC.md).
It supports the complete authoring loop instead of acting only as a graph viewer:

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

The extension is deterministic and local-first. It has no built-in AI provider, account,
authentication flow, telemetry, content upload, or cloud service. See the
[privacy statement](docs/privacy.md) for the exact boundary.

## Commands

| Command Palette title | Stable command ID |
| --- | --- |
| `OKF: Initialize Bundle` | `okfWorkbench.initializeBundle` |
| `OKF: New Concept` | `okfWorkbench.newConcept` |
| `OKF: Validate Bundle` | `okfWorkbench.validateBundle` |
| `OKF: Regenerate Indexes` | `okfWorkbench.regenerateIndexes` |
| `OKF: Open 3D Graph` | `okfWorkbench.openGraph` |
| `OKF: Set Up Agent Integration` | `okfWorkbench.setupAgentIntegration` |

## Try the release candidate

Until an approved Open VSX release exists, build and install the VSIX locally:

```sh
mise x node@24.18.0 -- npm ci
mise x node@24.18.0 -- npm run check
mise x node@24.18.0 -- npm run package
mise x node@24.18.0 -- npm run package:check
```

Then run **Extensions: Install from VSIX...** and select
`artifacts/okf-workbench.vsix`. Open a workspace folder and use the `OKF:` commands from the
Command Palette. Authoring commands require a trusted workspace; read-only inspection remains
available within the extension's declared workspace-trust boundary.

The manifest targets VS Code-compatible desktop editors with API floor `^1.121.0`. A configured
matrix is not itself a compatibility claim: retain successful per-lane evidence before declaring
a version supported. The three recorded macOS editor lanes passed for an earlier candidate and
still require exact final-candidate reruns. See the
[compatibility matrix](docs/compatibility-matrix.md) and
[acceptance evidence](docs/acceptance-evidence.md).

## Safety model

- Markdown in the workspace is the source of truth; the graph is derived and read-only.
- Generated changes are previewed, path-contained, and collision-checked before application.
- Existing unrelated `index.md` and `AGENTS.md` content is preserved through managed regions.
- Unknown frontmatter fields and arbitrary non-empty concept types remain valid.
- Webview scripts and styles are packaged locally under a restrictive Content Security Policy.
- Uninstalling the extension does not delete generated bundles or agent instructions.

Review the [security and privacy evidence](docs/security-privacy-evidence.md) for implemented
controls, known findings, and proof gaps. The tracked schema-v2
[headed-editor performance evidence](docs/performance-evidence.md) passes QR-002 at 703 ms p95 over
20 correlated file-event samples and passes QR-003 with `d3` as the release engine for the exact
measured production bundles. This is evidence for Mac16,7 / Apple M4 Pro / VS Code 1.127.0, not a
general performance guarantee.

## Development

Use Node.js `24.18.0` and npm `11.16.0`. The repository commits both `.node-version` and `.nvmrc`;
using `mise` is optional.

| Script | Purpose |
| --- | --- |
| `npm run build` | Produce release extension-host and Webview bundles |
| `npm run build:dev` | Produce debuggable local bundles |
| `npm run check` | Run formatting, lint, strict type, unit, dependency, and build gates |
| `npm run test:integration` | Run the extension test harness against the selected VS Code version |
| `npm run test:webview` | Build and run the standalone Chromium Webview harness |
| `npm run package` | Create `artifacts/okf-workbench.vsix` |
| `npm run package:check` | Inspect the VSIX allowlist, exclusions, manifest, and local assets |

Press F5 with the repository open to build and launch an extension-development host.

## Documentation and support

- [Documentation index](docs/index.md)
- [MVP scope](docs/mvp-scope.md)
- [Functional requirements](docs/functional-requirements.md)
- [OKF v0.1 compatibility contract](docs/okf-v0.1-contract.md)
- [Architecture](docs/architecture.md)
- [Agent integration](docs/agent-integration.md)
- [Support and issue reporting](docs/support.md)
- [Privacy statement](docs/privacy.md)
- [Changelog](CHANGELOG.md)

The project license is an unresolved release gate. Do not publicly distribute the `0.1.0`
candidate until the maintainer has selected a license, added the matching root license file, and
completed the license review in the [release checklist](docs/release-checklist.md). Third-party
notices are tracked separately in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Project links

- [Repository](https://github.com/koizumikento/okf-workbench)
- [Issues](https://github.com/koizumikento/okf-workbench/issues)
- [Open VSX Registry](https://open-vsx.org/)
- [Open VSX draft listing](docs/open-vsx-listing.md)
