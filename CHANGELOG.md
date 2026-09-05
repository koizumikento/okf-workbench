# Changelog

All notable changes to OKF Workbench are documented in this file.

The project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and intends to use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) after the first public release.

## 0.4.0 - 2026-09-05

### Changed

- Target Node 24 in the Extension Host and update `@types/node` to 24.13.3.
  New packages require VS Code 1.123 or newer; the VSCodium test pin is 1.126.04524.
- Update development dependencies undici, fast-uri, js-yaml, and postcss, including
  their security fixes, and the transitive nanoid package.

## 0.3.0 - 2026-08-03

### Added

- OKF v0.2 provenance, verification, trust-tier, lifecycle, freshness, source, and Attested
  Computation metadata are normalized by the shared Rust/Wasm core and surfaced in graph details.
- Attested Computation is available as an eighth built-in concept template.
- An explicit `OKF: Migrate Bundle to v0.2` workflow and preview-only `okf migrate --check` CLI
  command plan deterministic v0.1 upgrades, require an explicit producer actor, and retain
  ambiguous Citations for manual follow-up. Guarded application remains in the extension.

### Changed

- New bundles and synthesized root indexes now declare `okf_version: "0.2"`. Existing v0.1 bundles
  remain readable and eligible for guarded authoring without an implicit version rewrite.
- Injected concept generation times now render as `generated.by` and `generated.at`; legacy
  `timestamp` is consulted only when `generated` is absent.
- Malformed optional v0.2 metadata remains a curation concern rather than a conformance error.

## 0.2.1 - 2026-07-28

### Fixed

- Orphan-only concepts no longer appear as actionable curation warnings in the Workbench sidebar;
  the separate orphan count and resource indicator remain visible.
- Creating or editing concepts while the 3D graph is hidden no longer sends refresh data to a
  destroyed Webview context or shows a misleading interaction error. The latest graph revision is
  delivered when the panel is shown again.

## 0.2.0 - 2026-07-28

### Added

- A dedicated OKF Workbench Activity Bar entry now exposes persistent Bundle, Resources, and
  Actions views for selecting a bundle, reviewing its status, opening source Markdown, and
  launching the existing 3D graph.
- The Resources view presents deterministic folder and concept trees, preserves arbitrary
  non-empty concept types, distinguishes conformance errors from curation findings, and can start
  the existing guarded New Concept workflow in a selected folder.

### Changed

- Orphan concepts remain visible in validation summaries and the 3D graph, but no longer produce
  editor warning decorations or Problems entries for otherwise valid Markdown.

## 0.1.2 - 2026-07-27

### Changed

- Authoring proposals containing only collision-guarded new files now apply after the final input
  without opening a redundant preview or Apply prompt. Any proposal containing an existing-file
  update or replacement still previews the complete change set and requires explicit approval.

### Fixed

- Generated concept files now keep the frontmatter title as the single document title and retain
  descriptions as metadata instead of duplicating either value as body Markdown, avoiding
  markdownlint MD025 warnings.
- Successful Initialize Bundle and New Concept commands no longer retain the write-command lease
  while VS Code selects or opens their generated documents.

## 0.1.1 - 2026-07-27

### Fixed

- Successful authoring commands no longer remain locked while Cursor keeps their informational
  completion notification open.

## 0.1.0 - 2026-07-27

Initial release.

### Added

- Three bundle presets and seven concept templates with previewed, contained workspace writes.
- OKF v0.1 parsing with strict UTF-8 handling, unknown-frontmatter preservation, reserved-document
  handling, and deterministic internal-link resolution.
- Conformance diagnostics and separate curation findings for broken links, orphans, incomplete
  metadata, timestamps, and duplicate resources.
- Safe managed-region generation for directory indexes and `AGENTS.md`, plus a portable Agent
  Skill template with optional CLI-assisted validation and planned-write guidance.
- A Rust `okf-core` shared by the extension through a capability-free Wasm ABI and by an offline
  native `okf` CLI with init, create, validate, index, graph, and agent commands.
- Target-platform VSIX packages expose the validated bundled CLI to new integrated terminals on
  macOS arm64/x64, Linux x64, and Windows x64; matching standalone CLI archives remain available.
- Read-only `3d-force-graph` Webview with search, filters, details, backlinks, source navigation,
  stable type colors, an accessible non-spatial node list, mouse/trackpad camera navigation, visible
  camera controls, keyboard shortcuts, and interaction help.
- Folder-tree exploration with recursive counts, composable subtree filtering, detail breadcrumbs,
  and an optional presentation-only 3D folder grouping force.
- URI-first workspace access, session-scoped bundle selection, debounced refresh, diagnostics,
  and stale-revision rejection.
- Reproducible unit, acceptance-component, Webview, security, benchmark, package, and compatibility
  harnesses, including fixed VSIX entry ordering, timestamps, cross-platform file attributes, and
  isolated hosted-Linux WebGL launch controls.
- Local-only Webview assets, restrictive CSP, strict message decoding, dependency inventory, and
  third-party notices.

### Fixed

- Root-level `AGENTS.md` and `.agents/` agent-integration metadata are excluded from OKF concept
  discovery, preventing generated instructions from creating conformance errors in root-level
  bundles.
- Modeless authoring decisions remain recoverable through a pending-review status item, command,
  and busy-workflow Review/Cancel actions when the original notification is hidden.

### Security and privacy

- No built-in AI provider, account, authentication flow, telemetry, content upload, or runtime
  network client.
- Fixed development-only transitive packages are pinned so the complete dependency graph passes the
  npm advisory gate.
- Workspace bodies and source URIs remain on the extension-host side of the privileged boundary.
- Authoring operations require workspace trust and refuse unsafe paths or silent overwrites.

### Distribution

- OKF Workbench is licensed under the MIT License.
- Bundled third-party license texts and notices are included with the extension.
- Rust/Wasm dependency notices are generated from the locked Cargo graph and packaged separately.
- The extension identifier is `straydog.okf-workbench`.
- Every platform release derives its VSIX and standalone CLI archive from identical native binary
  bytes; a universal CLI-free VSIX remains the unsupported-target fallback.
