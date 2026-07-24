# Changelog

All notable changes to OKF Workbench are documented in this file.

The project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and intends to use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) after the first public release.

## 0.1.0 - Unreleased

Initial release.

### Added

- Three bundle presets and seven concept templates with previewed, contained workspace writes.
- OKF v0.1 parsing with strict UTF-8 handling, unknown-frontmatter preservation, reserved-document
  handling, and deterministic internal-link resolution.
- Conformance diagnostics and separate curation findings for broken links, orphans, incomplete
  metadata, timestamps, and duplicate resources.
- Safe managed-region generation for directory indexes and `AGENTS.md`, plus a portable Agent
  Skill template.
- A Rust `okf-core` shared by the extension through a capability-free Wasm ABI and by an offline
  native `okf` CLI with init, create, validate, index, graph, and agent commands.
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
