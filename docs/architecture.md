# Architecture

## Goals

- Share one interpretation of OKF across validation, indexing, templates, and visualization.
- Keep core behavior deterministic and independent of VS Code APIs.
- Support local, remote, and virtual workspace URIs where practical.
- Keep bundle contents inside the workspace and Webview boundary.
- Make graph rendering replaceable without rewriting OKF parsing.

## Structure

```text
src/
├── core/
│   ├── model/         # serializable host types and migration oracle
│   ├── parser/        # migration oracle and host-side safety preflight
│   ├── validation/    # migration oracle
│   ├── graph/         # migration oracle
│   ├── indexes/       # guarded managed-region merge
│   ├── templates/     # migration oracle
│   └── wasm/          # production Extension Host ABI adapter
├── extension/
│   ├── commands/
│   ├── diagnostics/
│   ├── sidebar/
│   ├── workspace/
│   └── webview/
└── webview/
    ├── graph/
    ├── details/
    └── state/
templates/
├── bundles/
├── concepts/
└── agents/
test/
├── fixtures/
├── unit/
└── integration/
crates/
├── okf-core/          # capability-free deterministic semantics
├── okf-wasm/          # raw wasm32-unknown-unknown ABI
└── okf-cli/           # native filesystem/terminal adapter
```

The accepted runtime, build, test, and packaging baseline is documented in
[Implementation environment](implementation-environment.md), [ADR 0004](decisions/0004-use-npm-typescript-esbuild-toolchain.md),
and [ADR 0007](decisions/0007-adopt-rust-wasm-shared-core-and-cli.md). [ADR 0008](decisions/0008-bundle-native-cli-in-platform-vsix.md)
defines the dual bundled/standalone CLI distribution. npm/esbuild own the
extension and Webview package; Cargo owns the deterministic core, portable Wasm artifact, and
native CLI.

## Implementation baseline

- Desktop-only VS Code-compatible extension for the MVP; no Web extension entry point.
- VS Code API floor `^1.121.0`, covering the current VSCodium stable line at the decision date.
- Release qualification pins the API-floor lane to VS Code `1.121.0`, the current-stable lane to
  VS Code `1.129.1`, and the compatible-editor lane to VSCodium `1.121.03429`. The current exact
  candidate still requires fresh hosted results on those lanes; the recorded VS Code `1.127.0`
  headed run is a superseded historical record and does not qualify the current performance
  contract.
- Node.js 24 LTS and npm for development and CI.
- Rust `1.92.0`, Cargo, and the `wasm32-unknown-unknown` target.
- TypeScript 6 with strict checking.
- Node 22/CommonJS extension bundle and ES2022/ESM Webview bundle produced by esbuild.
- Plain TypeScript and DOM UI with no React or state-management framework.
- Vitest, VS Code Test CLI, Playwright Webview harness, and packaged-editor smoke tests at distinct layers.

## Shared core ports and adapters

```text
VS Code workspace APIs                    local filesystem + terminal
          |                                         |
TypeScript Extension Host                      okf-cli
          |                                         |
versioned JSON / raw Wasm ABI              native Rust calls
          |                                         |
          +--------------- okf-core ----------------+
                 parser / validator / graph /
                 indexes / templates / agents
```

`okf-core` accepts bytes and serializable operation inputs and returns serializable results. It
does not import filesystem, terminal, editor, Webview, or network capabilities. `okf-wasm`
exports memory allocation/deallocation, ABI metadata, and one request dispatcher; it has no WASI
or other imports. The Extension Host validates the ABI version, memory bounds, UTF-8, envelope,
and operation result before publication. It loads the packaged module lazily on the first core
operation and
does not silently switch to the TypeScript migration oracle after a missing module, version
mismatch, trap, or malformed response.

The Extension Host continues to own URI-first reads, Workspace Trust, previews, guarded writes,
diagnostics, watchers, and the Webview lifecycle. The native CLI owns local path resolution,
interactive confirmation, atomic local writes, and stdout/stderr. The Webview receives only the
bounded presentation payload and never instantiates Wasm.

Supported target-platform VSIX packages add one native CLI at the distribution boundary, while the
universal fallback remains CLI-free. The exact same executable is also shipped in a standalone
archive. The extension validates it and exposes it only to new integrated terminals; extension
commands do not invoke it.

## Core model

```ts
interface Concept {
  kind: 'concept';
  id: string;
  source: SourceDocument;
  frontmatter: ParsedFrontmatter;
  type: string;
  title?: string;
  description?: string;
  resource?: string;
  tags: readonly string[];
  timestamp?: string;
  body: string;
  bodyRange: SourceRange;
  links: readonly ConceptLink[];
}

interface ConceptLink {
  sourceId: string;
  rawTarget: string;
  label: string;
  classification: LinkClassification;
  range: SourceRange;
  targetId?: string;
  fragment?: string;
  query?: string;
}
```

`ParsedFrontmatter.raw` retains the complete JSON-safe producer map, including unknown fields.
Explicit standard YAML tags are represented by the reserved `$okf-workbench:yaml-tag` object with
their canonical tag name, JSON-safe semantic value, and original lexical value source. In
particular, YAML timestamps, binary data, and sets never leak `Date`, `Buffer`, or `Set` instances
into the model. This object is a serialization representation, not a trust signal:
`ParsedFrontmatter.explicitTags` is a separate sidecar derived only from the YAML AST. A direct
explicit tag and an alias resolved to the same real tagged node retain provenance; a producer
mapping or sequence that imitates the reserved object does not. Semantic-string compatibility
checks accept a plain string or an AST-proven `!!str` scalar, including its aliases, and reject
lookalike mappings, sequences, and values tagged with anything other than `!!str`. The exact
frontmatter source remains separately available for source-preserving writes. Null-prototype
mappings and a closed standard-tag converter prevent prototype pollution and fail closed on custom
runtime objects. The normalized fields are conveniences, not a closed schema.
Link state is represented by the explicit `LinkClassification` union rather than overlapping
boolean flags.

When decoding, frontmatter parsing, or Markdown parsing fails for a non-reserved document, the
bundle model still contains a partial `Concept`. It retains the canonical ID and complete
`SourceDocument` identity (URI, bundle path, and content hash), while frontmatter, type, tags, body,
and links use JSON-safe empty sentinels. The accompanying source-scoped `ParseFailure` is the
authoritative diagnostic; validators suppress derivative metadata and orphan findings for that
partial concept. Other concepts can still resolve links to its stable identity, so graph cardinality
and source-repair navigation do not change merely because one file is temporarily malformed.

## Data flow

```text
workspace URIs
-> TypeScript capability adapter
-> Rust core through the versioned Wasm ABI
-> normalized serializable bundle model
-> validator + graph builder + index generator
-> extension messages
-> Webview graph and details panel
```

### Initial load

1. Resolve an explicit or detected bundle root. Automatic discovery streams exact-name `index.md`
   candidates, skips known VCS/dependency/generated trees, and records an unreadable subtree while
   continuing with its siblings. It is intentionally bounded to 32 workspace roots, 16 relative
   path segments, 512 candidate indexes, 1 MiB per index, 8 MiB of total index content, and 64
   retained failure records. Provider traversal also stops at 10,000 directories or 100,000
   entries per root. Any access or safety-limit truncation prevents automatic/current-candidate
   selection and routes the user to explicit directory selection.
2. Stream Markdown through the URI-first workspace port. Exclude every `.agents/` subtree during
   traversal and omit a root `AGENTS.md` from the document inventory because both are project-local
   agent integration controls rather than OKF concepts; a nested `AGENTS.md` outside `.agents/`
   remains eligible. Provider-reported relative path segments
   retain their verbatim identity; they never re-enter the percent-decoding path used to validate
   user-entered write targets. An unreadable document or child subtree becomes a path- and
   URI-scoped conformance finding while readable siblings continue through parsing, validation, and
   graph construction. One load admits at most 2,000 Markdown documents, 2 MiB per document,
   32 MiB of reported and actual Markdown bytes, eight concurrent provider calls, 64 path segments,
   32 MiB of cumulative traversal identity, and 128 retained failures. A 4 KiB relative path uses a
   16 KiB serialized-URI envelope to accommodate percent expansion. One oversized document is
   retained as a typed identity-only input; aggregate, root, count, depth, and traversal-identity
   failures remain fatal for that refresh. Already-started provider calls settle before another
   generation may perform physical I/O. Every materialized byte is charged to the actual-byte
   aggregate before any later parent-access failure or resource limit discards that document. The
   runtime retains both the logical bundle root and its
   containing workspace safety root. Every load, including watcher refreshes, captures the complete
   URI/provider directory chain between them before traversal and rechecks that same generation
   after enumeration, after each bounded read batch, and before publication. A missing,
   symbolic-link, non-directory, or changed-generation segment fails closed and clears all
   previously derived graph and diagnostic state. Traversal additionally captures the
   workspace-root-to-current-directory chain for every directory it enters and does not release any
   `readDirectory` tuple until both that chain and the traversal-root chain have been revalidated.
   A nested generation failure is fatal to the complete load rather than an ordinary unreadable
   subtree. Before every distinct document stat/read batch, the loader captures its complete
   workspace-root-to-parent chain and sandwiches the file operation with parent and bundle-root
   checks; safe siblings cannot make a generation failure publishable as a partial result.

   For a local `file:` URI, `stat` captures native `lstat` identity
   (`dev`, `ino`, mode, nanosecond ctime, and birthtime). A later read must present that identity,
   opens one handle with `O_NOFOLLOW` where the host defines it, verifies the handle with `fstat`
   before reading, reads only through that handle, and compares the handle and pathname generations
   again before returning bytes. This prevents a transient ancestor or final-file swap from
   redirecting the read even when the original path is restored before the caller resumes, and the
   handle is closed on every outcome. A close rejection also rejects otherwise valid bytes; when a
   read and close both fail, the read failure remains primary and the close failure is attached for
   diagnosis. Non-`file:` providers expose no file handle, inode, ETag, or conditional read through
   VS Code, so they use an explicit trusted-provider metadata sandwich (`stat` / `readFile` /
   `stat`) plus the directory-generation checks. That branch is a provider trust boundary, not an
   atomic-snapshot claim.
3. Parse frontmatter and Markdown links. Every enumerated in-bundle non-reserved input contributes
   a concept identity; decode or parse failure yields a safe partial concept plus a precise failure.
4. Resolve concept IDs and internal targets.
5. Produce diagnostics and a bounded serializable graph payload. A document-scoped failure remains
   an identity-only `sourceFailed` node so it is navigable and included in concept cardinality, but
   it contributes no invented type, tag, outgoing-link, broken-link, or orphan state. Valid siblings
   may still link to that stable identity. A bundle-scoped resource
   failure invalidates the complete derived view.

### Incremental update

1. Listen for create, change, delete, and rename events.
2. Coalesce equal events at insertion time. Retain at most 512 distinct pending paths, collapsing
   overflow to one rescan. Use a 250 ms trailing debounce with a 1,000 ms maximum latency.
3. Reparse changed concepts.
4. Recompute affected outgoing links, backlinks, and diagnostics.
5. Send a graph patch or replacement payload to the Webview.

Refresh work is strictly single-flight: invalidated work is aborted logically, but a replacement
does not start until every already-issued provider promise settles; at most one trailing refresh
runs next. The first implementation may replace the full graph payload if profiling shows it is
sufficiently fast. Incremental rendering is a performance optimization, not a correctness
requirement.

### Workbench sidebar

The Activity Bar container is an Extension Host presentation adapter over the selected
`BundleRuntimeSnapshot`. Its Bundle provider derives bounded counts from the snapshot, and its
Resources provider builds a deterministic folder-first tree from canonical POSIX concept and
reserved-document paths. Folder items are presentation objects only: they never enter `okf-core`,
the Wasm ABI, the graph protocol, or graph statistics.

The sidebar owns no parser, workspace enumeration, Markdown watcher, diagnostic collection, or
Webview. Selecting a bundle reuses URI-first discovery and changes only the session-scoped bundle
context. A runtime publication atomically replaces the small sidebar model; clear or fatal refresh
events remove stale resources. Tree commands carry the root and runtime revision that produced
their item. Source opening and folder-originated concept creation accept the item only while both
still match the current runtime snapshot.

The Actions view and title/context menus invoke registered commands rather than command
implementations. Validate and Open 3D Graph retain the read-command gate. Authoring retains
Workspace Trust checks, the single proposal scheduler, preview recovery, path and collision
guards, and URI-first application. The 3D renderer remains the single editor Webview.

## VS Code integration

- Use commands and Explorer context menus as the primary entry points.
- Use `DiagnosticCollection` for conformance and actionable source-level curation findings.
  Keep `okf.curation.orphan-concept` in the complete deterministic validation result and graph
  statistics, but do not publish it as an editor diagnostic: an intentionally isolated concept is
  valid source and should not receive a warning decoration.
- Use an editor Webview for the 3D graph.
- Use `vscode.workspace.fs` for provider-backed workspace content. Route local `file:` reads through
  the URI-first port's native identity-bound handle implementation; do not silently fall back to
  provider reads when native identity is unavailable.
- Treat all workspace resources as URIs; do not assume the `file:` scheme.
- Include both bundle root and containing workspace-folder URI in runtime selection identity.
  Revalidate the captured workspace-to-bundle directory generation at the start of every full load,
  between enumeration and content reads, after each read batch, and immediately before publication
  rather than relying on the earlier picker/discovery check. Require the same identity-bound read
  primitive for automatic discovery, explicit-root inspection, proposal previews, Agent Integration
  snapshots, proposal preflight, and post-write verification. This preserves virtual-provider URI
  identity, handles overlapping workspace folders deterministically, and prevents a reused
  selection or watcher refresh from publishing content reached through a transiently swapped
  `file:` ancestor outside the workspace. A host workspace-folder removal forces a new runtime
  generation and watcher even when a replacement folder with the same serialized URI is added in
  that event, so pre-removal provider work cannot publish into the replacement selection.
  Discovery rechecks a candidate chain after an asynchronous index inspector returns. Preview and
  Agent Integration code capture each resource parent independently; preview retains and
  deduplicates those snapshots and revalidates all of them as its last workspace pass before
  presenting any bodies. A safely absent parent suffix is classified without probing through that
  suffix, then its deepest existing ancestor and absence state are rechecked.
- Admit at most one complete write-command workflow per Extension Host activation, acquiring its
  opaque lease at the registered command entry before trust checks, trust notifications, target
  selection, workspace reads, or proposal planning. Pass that same lease into the authoring factory
  rather than nesting scheduler admission, and retain it through preflight, optional preview and
  modeless approval, apply, and cleanup. After pure feasibility and complete preflight, apply a
  proposal directly only when every change is `create` with an absent-target precondition. If any
  change updates or replaces an existing file, preview the complete proposal and require approval.
  While the lease is active, reject every concurrent invocation
  immediately with the structured `proposal-workflow-busy` problem and an actionable instruction to
  finish or cancel the active workflow before retrying. Do not retain the rejected proposal in a
  FIFO or other pending queue. Keep one host-owned decision controller for the admitted preview:
  while it is unresolved, expose a status-bar action and context-gated `Review Pending Changes`
  command that reveal the exact summary and start a new Apply/Cancel attempt. A busy refusal offers
  Review or Cancel against that same controller. Number prompt attempts and accept a result only
  from the latest attempt, so a late notification cannot authorize a superseded review. Reuse one
  run/target identity across the summary, diff titles, and every approval attempt so a decision
  cannot be confused with another bundle's proposal. Keep that exact preview alive through the
  result, and fail closed after asynchronous guards and immediately before every write if it is no
  longer active. Treat post-create selection and editor navigation as best-effort follow-up work:
  do not retain the write lease while those host UI promises remain pending.
- Capture the proposal's workspace safety root as an exact open-folder URI when the common write
  workflow starts. The host's workspace-folder change listener irreversibly invalidates only
  sessions whose exact root was removed and closes any active preview; a containing parent, another
  authority, or a same-URI re-add cannot revive a direct-create authorization or reviewed proposal.
  Recheck the live exact folder set before the first and every subsequent change, then pass the
  same authorization callback into the workspace adapter so it runs again after preparatory
  provider awaits and immediately before `applyEdit` or `writeFile`.
- Admit only one `Validate Bundle` or `Open 3D Graph` selection-and-scheduling phase at a time.
  Acquire this read-command gate before bundle discovery or any bundle picker. Concurrent read
  commands fail immediately with `read-command-busy`; their callbacks and explicit-root arguments
  are neither retained nor shared with the admitted command. Coalesce the ordinary-session busy
  warning to one notification per active phase.
- Run a pure proposal-feasibility check before workspace preflight or any workspace I/O. Inclusive
  limits are 64 changes, 2 MiB for each proposed output and each declared existing
  `expected.byteLength`, 16 MiB for cumulative UTF-8 before-and-after bodies, and 1 MiB for the
  generated summary. A create-only proposal remains eligible for direct application. For a
  previewed proposal, prepare every before/after snapshot before registering a virtual-document
  provider or opening any tab. Refuse the whole proposal rather than exposing a partial change set
  when a limit or later snapshot read fails; exact-boundary proposals remain eligible.
- Keep provider path identity and user-input normalization as separate APIs. A literal provider
  filename such as `encoded%2Fsegment.md` must not alias `encoded/segment.md`, while encoded
  traversal in user input remains rejected. Both branches use the same pre-allocation envelope:
  4,096 UTF-16 code units, 4,096 UTF-8 bytes, and 64 relative path segments. The guard runs again
  after user-input percent decoding so an encoded separator cannot bypass the depth limit.
  Serialized source/provider URIs have a separate 16 KiB code-unit/UTF-8 envelope because a valid
  multibyte 4 KiB path may expand to roughly 12 KiB when percent-encoded.
- Resolve proposal targets from an explicit write root. Before the first change, inspect that root
  and every existing parent segment through the URI-first workspace port. A symbolic link, ordinary
  file, or unknown resource in any ancestor refuses the complete proposal, preventing logical URI
  containment from becoming an external filesystem write through a `file:` symlink. Initialization
  uses the selected workspace target as its write root so would-be bundle-directory ancestors are
  included; virtual providers remain supported through their `stat` result rather than Node paths.
  If an optional missing parent appears while preflight captures the deepest existing baseline, the
  proposal is refused before the target is statted or read. Update hash comparison and post-write
  verification carry caller-owned target-parent snapshots through the workspace adapter and check
  them before and after each internal stat/read. This detects parent changes around those reads but
  does not create an atomic update transaction: VS Code exposes no conditional existing-file write,
  and Node's path API here exposes no `openat` walk spanning the provider mutation.

## Webview security

- Bundle JavaScript and styles with the extension; do not load them from a CDN.
- Use a restrictive Content Security Policy and per-render nonce.
- Set narrow `localResourceRoots`.
- Escape or sanitize rendered Markdown and metadata.
- Validate every message crossing between the extension host and Webview.
- Never enable arbitrary script execution from bundle content.

## Graph behavior

- Each concept is one node.
- Each resolvable internal Markdown link is one directed, untyped edge.
- Broken links may be represented as warnings or optional placeholder targets.
- Directory hierarchy is optional presentation metadata and must not be confused with an OKF semantic relationship.
- External citations are excluded from the main graph by default.

Graph construction admits at most 2,000 nodes, 10,000 retained internal/broken relationships, 128
tags per concept, 20,000 tag assignments, 512 unique types, and 4,096 unique tags. Edge identities
are compact deterministic base-36 ordinals assigned after stable relationship sorting; producer
concept IDs are not copied into the edge ID. Producer concept/source/failure/finding identities are
bounded to 4 MiB in aggregate before lookup keys are built. Before publication, a streaming escaped-JSON byte
counter computes the exact serialization size without creating the JSON string and refuses payloads
over 16 MiB. The extension-to-Webview decoder mirrors the same string, count, cardinality,
reference, backlink, statistics, and byte limits.

The renderer is the standalone `3d-force-graph` package behind a repository-owned adapter, as recorded in [ADR 0003](decisions/0003-use-3d-force-graph.md). A repository-owned camera controller inside that adapter coordinates OrbitControls, toolbar commands, keyboard commands, search focus, and node focus. It classifies Chromium wheel input conservatively, owns the only custom wheel listener, prevents default scrolling only on the graph surface, and keeps library-specific control objects inside the adapter. It is locally bundled, exposes an accessible non-spatial navigation surface, resumes rendering only for bounded camera interaction windows, stops its animation loop after cooldown, and uses `d3` as the checked-in runtime fallback.

Folder hierarchy is derived inside the Webview from the canonical POSIX `GraphNode.id`; it is not
added to the extension/Webview protocol or core semantic model. Folder selection is another
presentation filter, while breadcrumbs provide the same action from selected-concept details. The
renderer adapter may attach folder-path fields to its private render nodes and install one named
custom `d3` force for deterministic top-level clusters and weaker nested offsets. It never creates
folder nodes or edges, changes type colors, or mutates the received graph payload. The internal
`ngraph` benchmark candidate receives deterministic initial positions instead of a `d3` API call.

The former schema-v3 headed comparison selected `d3`, but the strengthened evidence contract invalidated that selection for release qualification. A fresh full same-Electron comparison must observe real WebGL clears/draws, verify every interaction outcome, and produce a positive coherent camera rate with camera-period graph draws covering every observed clear before selecting the current release engine. Dependency licensing and packaged notices are reviewed separately from the project-license gate. Any renderer or candidate-bundle change invalidates an evidence binding and requires a new evaluation.

## Performance targets

Accepted MVP thresholds:

- 1,000 concepts and 5,000 internal edges remain interactively navigable on a typical developer laptop.
- Opening the graph does not block normal text editing.
- File changes are reflected within one second after debounce for representative bundles.

A genuine current-input schema-v3 headed VS Code `1.129.1` run passes QR-002 at `832 ms` p95 across
20 samples and QR-003 with `d3` selected; its strict CDP envelope records zero remote HTTP(S)/WS or
other-scheme requests. The retained VS Code `1.127.0` run predates the current
diagnostics-correlation, WebGL/UI-outcome, causal-timing, and network-envelope requirements and
remains historical-only. See [performance evidence](performance-evidence.md) for the exact
environment, authority rules, and candidate-binding limits.

## Testing strategy

### Unit tests

- YAML/frontmatter parsing.
- Concept ID and link resolution.
- Reserved filename rules.
- Conformance versus curation severity.
- Unknown-field preservation.
- Index generation and managed-region merging.
- Template path safety and collision detection.

### Fixture tests

- Minimal valid bundle.
- Nested indexes and relative links.
- Broken and out-of-bundle links.
- Unknown types and custom fields.
- Invalid YAML and missing type.
- Duplicate resources and orphan concepts.
- Unicode filenames and content.

### Extension integration tests

- Command registration.
- Activity Bar view registration, resource source navigation, and stale revision refusal.
- Workspace file creation and diagnostics.
- Watcher-driven updates.
- Webview message validation.
- Source navigation from diagnostics and graph nodes.

### Webview browser tests

- Search, filter, details, and keyboard navigation in a standalone harness.
- Actual WebGL graph smoke in Chromium.
- CSP-compatible local bundle loading.

Playwright browser results are not used as Electron Webview performance evidence. Performance targets require a headed VS Code or VSCodium benchmark with the environment recorded.
