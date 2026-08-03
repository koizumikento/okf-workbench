# AGENTS.md

## Scope

These instructions apply to the entire `okf-workbench` repository.

## Mission

Build a local-first VS Code-compatible extension that helps users initialize, author, validate, index, and explore Open Knowledge Format bundles. The product is a workbench, not only a graph viewer.

The core workflow is:

```text
initialize -> create -> edit -> validate -> explore -> repair
```

## Current state

The deterministic Rust core, capability-free Wasm Extension Host adapter, native CLI, platform
VSIX CLI integration, seven MVP
extension command workflows, diagnostics, URI-first workspace runtime, 3D Webview, agent-template
generation, and release-candidate harnesses are implemented. A genuine schema-v3 headed VS Code
1.129.1 capture for the `0.3.0` candidate passes QR-002 at 873 ms p95 across 20 samples, selects
`d3` for QR-003, and records zero remote HTTP(S)/WS or other-scheme Webview requests under the
strict current-input contract. The retained VS Code 1.127.0 capture predates that contract and is
historical-only. The exact `0.3.0` packaged-input revision passed the required hosted VS Code and
VSCodium lifecycle matrix on Ubuntu, macOS, and Windows, including upgrade from the published
`v0.2.1` universal VSIX; its browser boundary, four target packages, and aggregate package-set
consistency also passed. The repository, issue
tracker, security-advisory route, and GitHub Pages trust pages are public, and the hosted
branch/scanning baseline is configured. The maintainer selected MIT for the project and approved
the third-party notice inventory for the initial release. Signed tag `v0.1.0` on reviewed `main` commit
`438f1ed2233fdf86d289bd7dfdb934757c6a35f3` completed release workflow `30233342837`, publishing
the GitHub Release, the universal and four target Open VSX packages, and the Homebrew/Scoop
manifests in `koizumikento/stray-tools`. Clean post-publication editor and package-manager install
verification remains outstanding. Do not turn a configured matrix, component test, single-machine
benchmark, or prepared listing into a broader compatibility, performance, or publication claim.

Supported releases distribute the exact same native CLI bytes in both target-platform VSIX
packages and standalone archives for macOS arm64/x64, Linux x64, and Windows x64. The universal
VSIX is a CLI-free fallback. Extension features always use Wasm; bundled CLI exposure is limited to
new integrated terminals and must not modify external shell configuration.

## Sources of truth

Use this order when requirements conflict:

1. The pinned canonical [OKF v0.2 specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/3fcbb9f828c2f23d109c855ee403c3a4c81f3a96/okf/SPEC.md) for format behavior.
2. Accepted records under `docs/decisions/` for repository decisions.
3. `docs/okf-v0.2-contract.md` for the current Workbench compatibility interpretation, with
   `docs/okf-v0.1-contract.md` retained as the legacy compatibility record.
4. `docs/functional-requirements.md` for testable MVP behavior.
5. `docs/implementation-environment.md` for accepted runtime, tooling, dependency, test, and packaging choices.
6. `docs/mvp-scope.md` and `docs/architecture.md` for planned product and engineering scope.

When the upstream OKF specification changes, document the observed version or commit and review the compatibility contract before changing behavior.

## Non-negotiable product rules

- Keep core features local and deterministic.
- Do not add an AI provider, API key flow, hosted account, content upload, or telemetry without a new accepted decision.
- Treat Markdown as the source of truth and the graph as a derived read-only view in the MVP.
- Preserve unknown frontmatter fields during supported write operations.
- Permit arbitrary non-empty concept `type` values.
- Treat internal Markdown links as directed, untyped relationships.
- Treat broken links as curation warnings, not OKF v0.2 conformance errors.
- Never silently overwrite an existing user file.
- Preview generated or merged content when an operation may change an existing file.

## Module boundaries

Keep the deterministic OKF core independent of VS Code APIs:

- `core/parser`: frontmatter, Markdown, concepts, and links.
- `core/validation`: conformance errors and curation findings.
- `core/graph`: serializable nodes, edges, backlinks, and statistics.
- `core/indexes`: index synthesis and safe managed-region merging.
- `core/templates`: bundle, concept, and agent template rendering.
- `crates/okf-core`: production deterministic semantics shared by Wasm and CLI.
- `crates/okf-wasm`: capability-free, versioned Extension Host ABI.
- `crates/okf-cli`: native filesystem and terminal adapter.
- `extension`: commands, diagnostics, workspace access, and Webview lifecycle.
- `webview`: 3D presentation and interaction only.

Do not put canonical parsing or validation logic inside Webview components.

## Workspace and path rules

- Prefer `vscode.workspace.fs` and URI-based APIs over Node `fs` for workspace content.
- Do not assume a workspace URI uses the `file:` scheme.
- Normalize concept IDs with POSIX `/` separators regardless of host platform.
- Reject generated paths that escape the selected bundle root.
- Before any proposal write, reject the complete change set if the write root or an existing parent
  segment is a symbolic link or is not a directory.
- Resolve both bundle-relative and document-relative Markdown links.
- Add fixtures for Windows separators, spaces, Unicode, and nested directories when path behavior changes.

## Webview rules

- Bundle scripts and styles locally; do not use a CDN.
- Apply a restrictive Content Security Policy with a nonce.
- Sanitize rendered Markdown and all user-controlled metadata.
- Validate extension-to-Webview and Webview-to-extension messages.
- Do not execute scripts contained in bundle content.
- Provide a searchable, keyboard-accessible non-spatial way to reach graph nodes.
- Keep graph rendering concerns separate from graph construction.

## Diagnostics

Maintain a visible distinction between:

- **Conformance errors:** the bundle violates the hard OKF v0.2 interoperability rules.
- **Curation warnings:** the bundle is consumable but may be incomplete, stale, duplicated, orphaned, or difficult to navigate.

Diagnostics should include the most precise useful URI and source range. Do not promote a recommendation to an error merely because the template generator prefers it.

## Generation and merge safety

- Make generation idempotent where practical.
- Detect collisions before writing.
- Preserve unrelated content in `index.md` and `AGENTS.md`.
- Update only explicit managed regions when merging generated sections.
- Refuse automatic merging when markers are malformed or duplicated.
- Show a preview or diff before replacing an existing generated Skill.
- Never delete generated files during extension uninstall.

## Coding conventions

These conventions apply to all implementation work:

- Use TypeScript with strict type checking for the Extension Host and Webview. Use stable Rust with
  `cargo fmt`, `cargo clippy`, and `cargo test` for the shared core, Wasm adapter, and CLI.
- Follow the npm/esbuild plus Cargo baseline in `docs/implementation-environment.md`; do not add an
  overlapping package manager, bundler, UI framework, or Rust workspace tool without an accepted
  decision.
- Keep public core types explicit and serializable.
- Avoid `any`; narrow `unknown` at parsing and message boundaries.
- Prefer small pure functions in the core.
- Represent expected parse and validation failures as data, not uncaught exceptions.
- Keep user-facing messages actionable and avoid exposing raw stack traces.
- Add dependencies only when their license and bundling behavior are understood.
- Keep `okf-core` free of filesystem, network, editor, terminal, and Webview APIs. Put those
  capabilities in the TypeScript Extension Host or native CLI adapter.
- Keep the Wasm ABI versioned and JSON-serializable. Never add WASI or load the Wasm module in the
  Webview.
- Do not introduce a framework solely for a small utility that can be implemented clearly in the repository.

Follow repository formatters and linters after they are established. Do not invent command names in documentation before adding the corresponding package script.

## Testing expectations

Every behavior change should be tested at the lowest useful level.

Required coverage areas include:

- Frontmatter parsing and unknown-field preservation.
- Concept ID and link resolution.
- Reserved `index.md` and `log.md` handling.
- Conformance versus curation severity.
- Safe index and instruction merging.
- Template path validation and collision handling.
- File watcher update behavior.
- Webview message validation and source navigation.

Use small checked-in fixtures. Never make unit tests depend on network access or an AI provider.

## Documentation workflow

- Update `docs/mvp-scope.md` when adding or removing an MVP feature.
- Update `docs/functional-requirements.md` when user-visible behavior or acceptance criteria change.
- Update `docs/implementation-environment.md` when runtime, tooling, dependencies, test layers, CI, or packaging assumptions change.
- Update `docs/okf-v0.2-contract.md` when current compatibility behavior changes; update
  `docs/okf-v0.1-contract.md` only when clarifying the historical fallback contract.
- Update `docs/architecture.md` when module boundaries or security assumptions change.
- Add a record under `docs/decisions/` for choices that constrain future implementation.
- Mark provisional performance numbers as targets until benchmarked.
- Prefer primary specification and API links.

## Agent workflow

Before changing the repository:

1. Read `docs/index.md` and the documents relevant to the request.
2. Inspect the current worktree and preserve unrelated user changes.
3. Identify whether the change affects the OKF contract, MVP scope, or an accepted decision.
4. Implement the smallest coherent change.
5. Run the relevant checks available in the repository.
6. Update documentation when behavior or scope changes.

Before declaring work complete, verify:

- No unknown OKF fields or types were accidentally rejected.
- No user content can be overwritten silently.
- No network or AI-provider dependency entered a core workflow.
- New Webview content is sanitized and covered by a restrictive CSP.
- Tests and documentation match the implemented behavior.
