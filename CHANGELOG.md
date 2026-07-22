# Changelog

All notable changes to OKF Workbench are documented in this file.

The project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and intends to use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) after the first public release.

## [0.1.0] - Unreleased

Release-candidate implementation. This entry does not mean that `0.1.0` has been published.
Replace `Unreleased` with the publication date only after the release checklist and explicit
maintainer approval are complete.

### Added

- Three bundle presets and seven concept templates with previewed, contained workspace writes.
- OKF v0.1 parsing with strict UTF-8 handling, unknown-frontmatter preservation, reserved-document
  handling, and deterministic internal-link resolution.
- Conformance diagnostics and separate curation findings for broken links, orphans, incomplete
  metadata, timestamps, and duplicate resources.
- Safe managed-region generation for directory indexes and `AGENTS.md`, plus a portable Agent
  Skill template.
- Read-only `3d-force-graph` Webview with search, filters, details, backlinks, source navigation,
  stable type colors, and an accessible non-spatial node list.
- URI-first workspace access, session-scoped bundle selection, debounced refresh, diagnostics,
  and stale-revision rejection.
- Reproducible unit, acceptance-component, Webview, security, benchmark, package, and compatibility
  harnesses, including fixed VSIX entry ordering and isolated hosted-Linux WebGL launch controls.
- Local-only Webview assets, restrictive CSP, strict message decoding, dependency inventory, and
  third-party notices.

### Security and privacy

- No built-in AI provider, account, authentication flow, telemetry, content upload, or runtime
  network client.
- Fixed development-only transitive packages are pinned so the complete dependency graph passes the
  npm advisory gate.
- Workspace bodies and source URIs remain on the extension-host side of the privileged boundary.
- Authoring operations require workspace trust and refuse unsafe paths or silent overwrites.

### Release gates

- The project license still requires maintainer selection and approval.
- The current-candidate schema-v2 headed run passes QR-002 at 703 ms p95 over 20 correlated
  create/change/rename/delete samples and passes QR-003 with `d3` as the release engine on the
  recorded Mac16,7 / Apple M4 Pro / VS Code 1.127.0 environment. This closes the performance gate
  for the exact measured production bundles, not for other machines or candidates.
- The current unlicensed candidate passed clean install, untrusted-workspace, upgrade, and
  uninstall lifecycle checks on local macOS arm64 with VS Code 1.121.0, VS Code 1.127.0, and
  VSCodium 1.121.03429. Successful hosted Ubuntu, macOS, and Windows artifacts remain required for
  the full compatibility matrix, and any package-content change requires candidate-specific
  lifecycle reruns.
- Open VSX publication under `straydog.okf-workbench` requires explicit maintainer approval.

[0.1.0]: https://github.com/koizumikento/okf-workbench/releases/tag/v0.1.0
