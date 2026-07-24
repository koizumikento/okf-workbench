# ADR 0007 — Adopt a Rust/Wasm shared OKF core and native CLI

- Status: Accepted
- Date: 2026-07-24
- Issue: STR-221

## Context

OKF Workbench currently implements its deterministic format behavior in TypeScript inside the
extension package. A command-line interface is also required, and duplicating parsing, validation,
graph construction, index generation, and template generation in a second language would create
two competing interpretations of OKF v0.1.

The extension must continue to support VS Code and VSCodium desktop, including virtual and remote
workspace providers. The VSIX must remain platform-independent and must not gain a native Node
add-on. The CLI, by contrast, is a platform-native executable and may use the local filesystem.

The existing parser has compatibility-sensitive behavior: precise UTF-16 source ranges, explicit
YAML tags and aliases, unknown-frontmatter preservation, permissive concept types, partial concepts
after source-scoped failures, bounded work, deterministic ordering, and byte-stable generated
content. A migration is acceptable only when those contracts remain covered by shared fixtures.

## Decision

Use a Cargo workspace containing:

- `okf-core`: deterministic, serializable OKF semantics without editor, terminal, network, or
  filesystem dependencies;
- `okf-wasm`: a small `wasm32-unknown-unknown` adapter exposing a versioned JSON ABI to the
  Extension Host; and
- `okf-cli`: the native command-line and local-filesystem adapter.

The Extension Host remains TypeScript and continues to own VS Code APIs, URI-first workspace I/O,
Workspace Trust, bundle membership, previews, guarded writes, diagnostics publication, watchers,
and Webview lifecycle. The Webview never loads the Wasm module. The Wasm module has no WASI imports
and cannot read files, access the network, or write workspace content.

The ABI is an explicitly versioned request/response envelope. The raw Wasm adapter exports only
memory allocation, deallocation, ABI metadata, and one request dispatcher. This avoids a native
Node add-on and avoids generated JavaScript glue that could vary by platform. The build copies the
same Wasm bytes into every VSIX variant.

The CLI uses the same `okf-core` crate and provides:

```text
okf init [PATH] --preset <minimal|software-project|data-analytics> [--check|--apply]
okf new [ROOT] --template <name> --title <title> [--path <path>] [--check|--apply]
okf validate [ROOT] [--format <human|json>]
okf index [ROOT] --mode <missing|all> [--check|--apply]
okf graph [ROOT] --format json
okf agent [ROOT] --target <agents|skill|both> [--check|--apply]
okf version
```

Read commands never write. Write commands always create a complete change plan first. In an
interactive terminal, applying the plan requires confirmation unless `--apply` is present. In a
non-interactive terminal, writes require `--apply`; `--check` never writes. Machine-readable output
is versioned JSON on stdout, while diagnostics and prompts use stderr.

Migration parity is measured from checked-in canonical requests and exact JSON responses. A
TypeScript implementation may remain temporarily as a test oracle, but production execution must
not silently fall back from Wasm to TypeScript. An ABI mismatch, missing artifact, trap, or invalid
response is a visible core-unavailable error.

ADR 0007 scoped-supersedes ADR 0004 where that record limits deterministic core implementation to
TypeScript or limits the repository to npm alone. npm and esbuild remain authoritative for the
extension and Webview; Cargo is authoritative for the Rust core, Wasm artifact, and CLI.

## Consequences

Positive:

- Extension and CLI share one deterministic implementation of the OKF contract.
- Extension semantics remain platform-independent because they use portable Wasm rather than a
  native Node add-on.
- The Wasm capability boundary is smaller than the Extension Host boundary and is independently
  testable.
- CLI automation can validate and plan changes without launching an editor or requiring network
  access.

Costs:

- Contributors and CI require pinned Node/npm and Rust/Cargo toolchains.
- Exact source-provenance parity, especially YAML tags and aliases, must be tested explicitly
  rather than assumed from parser-library similarity.
- JS/Wasm serialization and copying add measurable overhead, so release qualification must retain
  the existing parser and graph performance thresholds.
- CLI binaries require per-operating-system and per-architecture release qualification.

ADR 0008 supersedes only the packaging decision above: each native CLI is distributed both in a
target-platform VSIX and as a standalone archive, while a platform-neutral VSIX remains available
as a CLI-free fallback.

## Rollout and rollback

The rollout order is models and fixtures, parsing and validation, graph and generators, Wasm
adapter, Extension Host cutover, CLI, then removal of the TypeScript oracle. Open VSX publication
remains blocked until the exact candidate passes the required extension, security, packaging,
compatibility, and performance gates.

Rollback means publishing the last qualified TypeScript-core release or reverting the candidate
before a release tag. Production must never use an undocumented mixed-core fallback.
