# Implementation environment

- Status: Accepted baseline
- Date: 2026-07-22
- Applies to: MVP implementation

## Purpose

This document defines the concrete development, runtime, test, and packaging environment. The Phase 0 scaffold implements this baseline; later product behavior remains governed by its owning requirements and issues.

Exact dependency versions are committed in `package.json` and `package-lock.json`. Patch-level versions may advance through reviewed dependency updates. A change of package manager, bundler, UI framework, extension surface, or architectural boundary requires an explicit decision update.

## Application shape

OKF Workbench has target-platform desktop extension packages, a CLI-free universal fallback, and
separately downloadable native CLI archives:

```text
VS Code / VSCodium desktop
├── Node extension host
│   ├── commands and diagnostics
│   ├── Activity Bar Bundle, Resources, and Actions views
│   ├── URI-first workspace adapter
│   └── capability-free OKF core Wasm
└── isolated editor Webview
    ├── graph adapter
    ├── details and non-spatial navigation
    └── 3d-force-graph / WebGL

Native executable
└── okf CLI
    ├── local filesystem and terminal adapter
    └── statically linked deterministic OKF core
```

The architecture is a layered modular monolith with ports at the workspace and Webview boundaries. There is no server, database, authentication system, cloud service, queue, background worker, or browser-extension entry point in the MVP.

The shipped trust boundaries are:

1. Workspace content entering the extension host.
2. Privileged filesystem and editor actions behind VS Code APIs.
3. Serializable messages crossing between the extension host and Webview.
4. Untrusted bundle metadata entering DOM or WebGL presentation.

## Runtime and compatibility baseline

| Concern | Baseline | Reason |
| --- | --- | --- |
| Primary surface | VS Code-compatible desktop extension | MVP requires VS Code and VSCodium desktop testing |
| VS Code API floor | `engines.vscode: ^1.121.0` | Covers the current VSCodium stable line while remaining compatible with newer VS Code releases |
| Development and CI Node | Node.js `24.18.0` LTS | Supported LTS, pinned for reproducible tooling |
| Package manager | npm `11.16.0` | Bundled with the pinned Node release; one tool and one lockfile |
| Rust toolchain | Rust `1.92.0`, edition 2024 | Pinned by `rust-toolchain.toml`; owns the shared core, Wasm, and CLI |
| Wasm target | `wasm32-unknown-unknown` | Portable, capability-free Extension Host artifact without WASI |
| Extension-host output target | Node.js 22 / CommonJS | Matches the Node type baseline used by VS Code 1.121 and avoids requiring newer extension-host syntax |
| Webview output target | ES2022 browser module | Conservative target for the Electron/Chromium Webview matrix |
| Type checker | TypeScript `6.0.3` | Mature stable line; TypeScript 7 adoption is deferred until extension tooling compatibility is verified |
| VS Code compile-time types | `@types/vscode` `1.120.0` | Conservative ceiling because npm does not publish `1.121.0`; this does not claim exact type coverage for the `1.121.0` API floor |
| Minimum editor test | VS Code `1.121.0` | Matches the manifest API floor |
| Current editor test | VS Code `1.129.1` | Stable VS Code release pinned for the current release-candidate qualification |
| VSCodium test | VSCodium `1.121.03429` | Stable VSCodium release at the decision date |

Node.js 26 is Current rather than LTS at the decision date, so it is not the development baseline.
The extension must not include native Node add-ons. Extension behavior stays portable through Wasm,
while supported target-platform VSIX packages additionally contain one Rust CLI executable.

References:

- [Node.js release status and schedule](https://nodejs.org/en/about/previous-releases)
- [Node.js 24.18.0 archive metadata](https://nodejs.org/en/download/archive/v24.18.0)
- [VS Code 1.129 release notes](https://code.visualstudio.com/updates/v1_129)
- [VS Code 1.121 source manifest](https://github.com/microsoft/vscode/blob/1.121.0/package.json)
- [VSCodium releases](https://github.com/VSCodium/vscodium/releases)

The current-stable test pin is refreshed for each release candidate and is pinned to VS Code
`1.129.1`. Predecessor revision `80ae7d560337cbe8d97af864c77aee410d5e5988` passed
[Compatibility run 30335399539](https://github.com/koizumikento/okf-workbench/actions/runs/30335399539)
across all seven VS Code/VSCodium lifecycle lanes and
[Package smoke run 30335400890](https://github.com/koizumikento/okf-workbench/actions/runs/30335400890)
across all four target packages plus aggregate consistency. Those receipts do not qualify the
current Rust/Wasm source candidate; fresh hosted and package-smoke qualification is pending. The
retained VS Code `1.127.0` headed capture is historical after strengthening the schema-v3 evidence
contract. The retained `0.2.1` VS Code `1.129.1` headed capture recorded QR-002 at `677 ms` p95
across 20 samples, `d3` as its QR-003 selection, and zero remote HTTP(S)/WS or other-scheme Webview
requests on its recorded hardware. The current strict evaluator exits `2` because the record does
not satisfy current-source binding checks; fresh current-candidate headed evidence is pending.

## Repository and package management

Use one npm package and one Cargo workspace at the repository root. Do not introduce npm
workspaces, a monorepo orchestrator, pnpm, Yarn, Bun, Nix, or a container requirement.

The Phase 0 scaffold includes:

- `.nvmrc` and `.node-version` pinned to `24.18.0`.
- `packageManager: "npm@11.16.0"` in `package.json`.
- `.npmrc` with exact dependency saving and engine enforcement.
- A committed `package-lock.json` generated with the pinned npm version.
- `rust-toolchain.toml` pinned to Rust `1.92.0` with `rustfmt`, `clippy`, and
  `wasm32-unknown-unknown`, plus a committed `Cargo.lock`.
- `engines.node` for development tooling and `engines.vscode` for installation compatibility.
- Dependabot or an equivalent reviewed dependency-update workflow.

CI and local clean installs use `npm ci`. Production, development, and optional dependencies must remain visibly separated. Open VSX or marketplace tokens are release secrets only and are never required for build, test, or package validation.

The lockfile overrides Mocha's development-only transitive `diff` and `serialize-javascript`
packages to `8.0.4` and `7.0.7`. Those are the first reviewed releases outside Mocha's declared
major ranges that close the applicable advisories while retaining the CommonJS APIs used by the
pinned VS Code test runner. Both packages remain excluded from the VSIX. Clean install, the full
test matrix, and a full-tree `npm audit` must pass whenever either override changes.

## Source layout

The planned layout is refined as follows:

```text
src/
├── core/
│   ├── model/
│   ├── parser/
│   ├── validation/
│   ├── graph/
│   ├── indexes/
│   ├── templates/
│   └── wasm/
├── extension/
│   ├── activate.ts
│   ├── commands/
│   ├── diagnostics/
│   ├── sidebar/
│   ├── workspace/
│   └── webview/
├── shared/
│   └── protocol/
└── webview/
    ├── main.ts
    ├── graph/
    ├── details/
    ├── navigation/
    ├── state/
    └── styles/
scripts/
├── build.mjs
└── package-check.mjs
test/
├── fixtures/
├── unit/
├── extension/
├── webview/
└── benchmarks/
crates/
├── okf-core/
├── okf-wasm/
└── okf-cli/
```

Dependency direction is inward:

```text
webview -> shared protocol
extension -> shared protocol + Wasm adapter
okf-wasm -> okf-core
okf-cli -> okf-core
okf-core -> no filesystem, network, terminal, VS Code, or Webview dependency
```

The shared protocol contains serializable data and runtime decoders only. It must not become a general dumping ground for behavior shared by unrelated modules.

## TypeScript configuration

Use separate TypeScript configurations sharing one strict base:

- `tsconfig.base.json`: strict language rules and no emit.
- `tsconfig.extension.json`: Node 22 and VS Code types; no DOM globals.
- `tsconfig.webview.json`: ES2022, DOM, and DOM iterable types; no Node globals.
- `tsconfig.test.json`: test-runner globals and harness-specific types only.

The base configuration explicitly enables:

- `strict`.
- `noUncheckedIndexedAccess`.
- `exactOptionalPropertyTypes`.
- `noImplicitOverride`.
- `useUnknownInCatchVariables`.
- `noFallthroughCasesInSwitch`.
- `forceConsistentCasingInFileNames`.
- `noEmit`.

Source files use ESM import/export syntax. The root package may be ESM for build scripts, while the extension entry is bundled to CommonJS for the Node extension host.

## Build and bundle pipeline

Use the pinned `esbuild` `0.28.x` line and Cargo through the repository-owned build script. A
production build first runs `cargo build --locked --release --target wasm32-unknown-unknown
-p okf-wasm`, copies the exact module to `dist/okf_core.wasm`, and then emits the two TypeScript
targets below. Missing Rust, a missing target, or a failed Wasm build fails the production build.
The only placeholder path requires an explicit test-only command flag and environment variable
and is not accepted by package validation.

### Extension-host bundle

- Entry: `src/extension/activate.ts`.
- Output: `dist/extension.cjs`.
- Platform: Node.
- Format: CommonJS.
- Target: Node 22.
- External: `vscode` only, unless a reviewed dependency demonstrably cannot be bundled.

### Webview bundle

- Entry: `src/webview/main.ts`.
- Output: `dist/webview/main.js` and local CSS assets.
- Platform: browser.
- Format: ESM.
- Target: ES2022.
- No CDN, runtime package fetch, dynamic remote import, or remote font.

### Native CLI

- Package: `okf-cli`; binary name: `okf`.
- Local build: `cargo build --locked --release --bin okf`.
- Commands: `init`, `new`, `validate`, `index`, `graph`, `agent`, and `version`.
- Read-only commands never mutate storage. `--check` is non-mutating; non-interactive writes
  require `--apply`.
- Native binaries are OS/architecture-specific release artifacts and are not included in the
  universal VSIX.
- The initial `darwin-arm64`, `darwin-x64`, `linux-x64`, and `win32-x64` VSIX packages each include
  the same executable bytes used by their standalone CLI archive.
- New integrated terminals append the bundled CLI directory to `PATH` and receive the exact
  executable path in `OKF_WORKBENCH_CLI`; external shells and profile files are untouched.

### Shared core ABI

- ABI version: `1`, with versioned JSON request/response envelopes.
- Raw exports: linear memory, allocation, deallocation, ABI version, and one dispatcher.
- The module must have zero imports and no WASI surface.
- The TypeScript adapter bounds pointers and lengths and validates UTF-8, JSON, envelope version,
  operation identity, and result shape before use.

Development builds include source maps without embedded source content. Release builds are minified and omit source maps from the VSIX unless a later debugging decision explicitly includes them.

The TypeScript compiler performs type checking separately because esbuild transpiles TypeScript without type checking. This follows the [official VS Code extension bundling guidance](https://code.visualstudio.com/api/working-with-extensions/bundling-extension).

Vite, webpack, and Vite+ are not part of the initial pipeline. Esbuild directly supports the required Node and browser bundles and is documented by VS Code, so an additional application framework or build layer is not justified.

## Runtime dependency baseline

| Purpose | Package baseline | Usage boundary |
| --- | --- | --- |
| YAML parsing | `yaml` `2.9.x` | Core parser; parse AST nodes with error details, retain original source, and normalize supported tags without carrying YAML-created object prototypes into the serializable model |
| Markdown pre-AST tokenization | `micromark` `4.0.x`, `micromark-core-commonmark` `2.0.x`, `micromark-util-decode-string` `2.0.x`, `micromark-util-subtokenize` `2.1.x` | Core parser; wrap the public CommonMark list, quote, label-open, label-close, and attention constructs with fail-fast work guards, apply the same guarded grammar when constructing mdast, then enforce link, image, definition, autolink, label, and destination limits |
| Markdown AST | `unified` `11.0.x`, `remark-parse` `11.0.x`, and focused unist visitors | Core parser; extract links and source positions without rendering HTML |
| 3D graph | `3d-force-graph` `1.80.x` | Webview renderer adapter only |

References:

- [`yaml`](https://www.npmjs.com/package/yaml)
- [`micromark`](https://www.npmjs.com/package/micromark)
- [`micromark-core-commonmark`](https://www.npmjs.com/package/micromark-core-commonmark)
- [`micromark-util-decode-string`](https://www.npmjs.com/package/micromark-util-decode-string)
- [`micromark-util-subtokenize`](https://www.npmjs.com/package/micromark-util-subtokenize)
- [`unified`](https://www.npmjs.com/package/unified)
- [`remark-parse`](https://www.npmjs.com/package/remark-parse)
- [`3d-force-graph`](https://www.npmjs.com/package/3d-force-graph)

Do not add React, a router, a state-management framework, a dependency-injection container, a CSS framework, or a runtime schema framework for the MVP.

The Webview uses plain TypeScript, DOM APIs, CSS, and a small reducer-style state store. User-controlled values are inserted with `textContent` or equivalent safe DOM APIs. The MVP details view does not render concept Markdown as HTML. If rich Markdown rendering is added later, sanitization requires a separate dependency and security review.

Extension/Webview messages use discriminated unions containing a protocol version and graph revision. Small hand-written runtime decoders narrow `unknown` at both sides of the boundary. If the protocol grows enough that manual decoders become error-prone, adopting a schema library requires a measured bundle and maintenance review.

## Workspace access and write safety

All workspace reads and writes go through an extension-side, URI-first port. Non-`file:` resources
use `vscode.workspace.fs`; local `file:` resources use Node's file-handle API behind that same port
only for identity-bound reads. Core modules receive text, byte arrays, normalized concept IDs, and
operation inputs rather than VS Code objects.

The native CLI binds every write plan to the filesystem identity of its bundle root (or the deepest
existing ancestor of a missing root) and to the identity of every existing target. Apply reopens
that anchored identity with no-follow semantics, so replacing the root while an interactive plan is
awaiting confirmation cannot redirect the approved write. A missing-root plan retains the
canonical existing ancestor captured during planning and rejects any component that appears before
apply instead of canonicalizing through newly introduced path state.

Existing-file updates fail closed before root creation or any other proposal write on every native
CLI platform. None of the supported filesystem APIs provides the complete generation-CAS primitive
needed to replace exactly the approved file while also preserving all required metadata: POSIX name
exchange does not compare the destination generation, and Windows replacement does not by itself
preserve the complete security descriptor, encryption state, and alternate data streams. `--check`
still reports the proposed update, but `--apply` returns an actionable conditional-replacement error
and leaves the entire plan untouched. This also means macOS never copies an old content modification
time onto changed bytes and Windows never publishes a metadata-incomplete replacement.

Create-only publication remains supported without an overwrite path. Linux stages bytes in an
anonymous same-directory `O_TMPFILE` and publishes them with `linkat(AT_EMPTY_PATH)` no-replace;
macOS stages in an already unlinked file and uses
`fclonefileat(..., flags=0)` relative to the anchored parent; a cross-volume or unsupported clone
fails closed. Windows stages through an open delete-capable handle and publishes relative to the
retained parent handle with no replacement flag. After handled failure it attempts handle-bound
cleanup; if cleanup also fails, both errors are reported. A single fixed reservation name keeps
abrupt-interruption or cleanup-failure residue bounded to at most one pathname per target directory;
a later invocation never deletes that name by pathname and fails closed if it remains.
Interrupted or failed Unix creates therefore leave neither a partial target nor an accumulating
hidden recovery file. The locked filesystem crates were already present in the reviewed Rust
dependency graph; making them direct CLI dependencies does not add a network, editor, or core
capability.

For a local file, `stat` uses `lstat({ bigint: true })` and returns an opaque generation containing
device, inode, mode, nanosecond ctime, and birthtime. `read` requires that generation, opens with
`O_RDONLY | O_NOFOLLOW` where `O_NOFOLLOW` exists, checks the opened regular file with `fstat`
before reading, reads through the already verified handle, then checks the handle and pathname
generations again. A missing or unusable native identity fails closed rather than falling back to
`workspace.fs.readFile`. Bytes are not returned until the handle closes successfully; a close
failure rejects an otherwise successful read, while a simultaneous primary read failure remains
primary with the close failure attached. Node exposes no `openat`-style directory-handle walk here,
so this is an identity-bound local-file guarantee for the tested filesystems, not a claim of a
formally atomic arbitrary pathname walk against privileged mount changes.

A runtime selection retains the containing workspace-folder URI separately from the bundle-root
URI and captures the native/provider generation of every directory between them. Every full load
revalidates that snapshot before traversal, between enumeration and Markdown reads, after each
bounded read batch, and before publication; a failure clears stale graph and diagnostics and
discards the load result. Automatic discovery, explicit-root and write-version inspection,
proposal-preview snapshots, Agent Integration reads, proposal preflight, and internal write
verification use the same identity-bearing stat/read contract. Traversal separately captures the
root-to-current-directory chain before each `readDirectory` and releases no provider child tuple
until that chain and the root snapshot pass afterward. A generation failure at any nested directory
is load-fatal, not an ordinary partial-access finding. Each distinct Markdown/index/authoring
resource also receives a root-to-parent snapshot around its stat/read; discovery rechecks after an
asynchronous inspector returns or rejects. A nested parent permission/unavailability failure
discards only affected document bytes and retains independently verified siblings, but the
materialized bytes are still charged to the 32 MiB actual-content aggregate before discard.

VS Code exposes only `type`, `size`, `ctime`, and `mtime` around a whole-resource `readFile` for
non-`file:` providers, with no handle, inode, ETag, or conditional read. This branch therefore uses
a trusted-provider `stat` / `readFile` / `stat` metadata sandwich plus directory-generation
revalidation. Provider compatibility tests must exercise this boundary; the implementation does not
describe it as an atomic snapshot.

Generated changes start from one immutable proposal containing target URI, expected current state,
and proposed bytes. The Extension Host then selects one of two flows:

1. When every change is `create` with an absent-target precondition, run complete preflight and
   apply directly without a preview or confirmation.
2. When any change updates or replaces an existing file, preview the complete proposal, re-check
   the expected content, and apply only after explicit confirmation.

Diff previews use a read-only virtual document provider and the built-in VS Code diff editor. Approval
is a modeless continuation so the user can switch among every opened diff before applying or
cancelling. One extension-scoped scheduler admits only one complete write-command workflow at a
time. Its opaque lease is acquired by the registered command entry before trust checks, trust
notifications, target selection, workspace reads, or proposal planning. The entry passes that same
lease into the selected authoring factory instead of reacquiring the scheduler, and it remains
active through preflight, optional preview and decision, apply, and cleanup.
While that workflow is active, every concurrent
invocation settles immediately with the structured `proposal-workflow-busy` problem and an
actionable instruction to finish or cancel the active workflow before retrying. The scheduler does
not retain the rejected workflow callback, proposal, or a FIFO queue entry. A host-owned decision
controller retains only the active proposal's one-shot resolver and preview identity. While that
decision remains unresolved, it shows an `OKF changes awaiting review` status item and enables the
context-gated `OKF: Review Pending Changes` command. Recovery reveals the exact existing summary and
starts a numbered Apply/Cancel prompt attempt; only the newest attempt may settle the resolver, so a
late result from a hidden notification cannot approve a superseded review. A busy refusal remains
immediate but may offer Review or Cancel for that same pending proposal. Cancellation, preview
invalidation, host disposal, and thrown failures release the active slot, preview tabs, virtual
document bodies, and provider registration in `finally`, after which a newly invoked workflow may
proceed. Selecting an initialized bundle and opening a generated Markdown document are best-effort
follow-up navigation. The command does not await those host UI promises inside the write lease, so
a slow editor reveal cannot make the next authoring invocation appear concurrently active.

Validate Bundle and Open 3D Graph use a separate extension-scoped fail-fast gate around their
complete bundle-selection and refresh-scheduling phase. The gate is acquired before automatic
discovery, explicit-root inspection, QuickPick, or folder selection. A concurrent read command
settles immediately with a structured `read-command-busy` result; its callback is not invoked or
retained, so roots from separate Explorer invocations cannot be conflated. Ordinary sessions show
at most one busy warning per admitted phase, and success, cancellation, or failure releases the gate
in `finally`.

Each Extension Host activation creates a cryptographically random nonce, and every confirmation
combines that nonce with its run, target fingerprint, and complete write-root URI. The nonce keeps
provider schemes and virtual-document URIs unique across host restarts, so an editor-cached document
from an earlier activation cannot satisfy a current preview. The shared identity appears in the
summary filename and body, every diff title, and the confirmation notification.

Before any workspace `stat`, read, or proposal preflight, Workbench performs a pure feasibility
check over the immutable proposal and generated presentation. It accepts the inclusive boundaries
of 64 changes, 2 MiB of UTF-8 for each proposed output, 2 MiB for each declared existing
`expected.byteLength`, 16 MiB of cumulative UTF-8 before-and-after bodies, and 1 MiB for the
generated summary. A proposal exceeding any boundary is refused without workspace I/O, provider
registration, or tab creation. The 64-change ceiling is deliberately conservative because a
previewed proposal opens one pinned diff per change, for at most 65 run-owned editor tabs including
the summary; it is a reliability guard rather than a measured editor-performance claim. Raising it
requires a virtualized or multi-diff review surface with new evidence. A create-only proposal moves
from feasibility through complete preflight to guarded application without registering preview
resources. For a previewed proposal, Workbench prepares every accepted before/after snapshot with
overflow-safe accounting before registering the run's provider or opening any tab. An oversized or
inconsistent existing snapshot, decode failure, or later read failure therefore refuses the entire
preview without leaving a partial summary, diff set, registration, or retained body. Preview
snapshots validate either a stable absent target under an existing parent or a stably absent parent
suffix without reading through it. Snapshots for all distinct target parents are retained and
deduplicated, and the last workspace pass before returning the prepared bodies revalidates every
snapshot.

After approval, cancellation, failure, or host disposal, the extension closes only the summary and
diff tabs whose URIs exactly match that activation and run, then releases the before/after bodies and
registration so no retained provider can reopen a stale preview URI. Disposal is checked after each
awaited preview operation and cleanup rescans exact owned URIs, preventing a late editor result from
restoring a disposed tab or body. Once opening completes, the session retains the current VS Code
`Tab` object and URI identity for the summary and each exact before/after diff pair. An explicit
close event or input replacement permanently expires the session, even when the same URI opens in
that event or a duplicate remains. VS Code 1.121 can rebuild all API `Tab` objects for an unrelated
group-model update, so a group-change event may rebind only a single unambiguous tab with the
unchanged URI identity and no explicit close; synchronous checks otherwise require the current
objects and input pairs to remain present. Reopening a closed virtual URI cannot revive approval,
and listener disposal precedes owned-tab cleanup. Agent Skill replacement uses one
replacement-and-apply decision over the final proposal, keeping that exact preview open through the
write result. The workflow verifies that preview synchronously after preflight and asynchronous
compatibility guards and again immediately before every individual write; closing it refuses the
first write or stops the remaining writes with an explicit partial report. The proposal also captures the exact open
workspace-folder URI that supplied its safety root. Removing that folder irreversibly invalidates
the active workflow and disposes its preview when one exists; leaving a containing parent open or
re-adding the same URI requires a new command and authorization. Exact membership is checked before
the first and each later change. The authorization callback is also carried into the workspace
port, which invokes it before directory creation and again after absence/hash verification
immediately before `applyEdit` or `workspace.fs.writeFile`. This closes membership changes that
occur during provider preparation; the provider API still offers no atomic lock spanning an
already-started asynchronous mutation and the editor's folder-change event.
The extension preflights all targets before starting a multi-file write. That preflight calls the workspace port's `stat` for
the proposal write root and every existing intermediate segment; `FileType.SymbolicLink`, a normal
file used as a parent, or an unknown entry refuses the entire proposal before the first write.
Missing parents remain provider-creatable only after the deepest existing parent is captured and
every segment initially observed absent is rechecked; a segment that appears during that baseline
refuses the proposal before target content is inspected. Initialization anchors the proposal at the selected
workspace target, while existing-bundle and agent operations anchor at their bundle or integration
root, so the same URI-first rule covers every write workflow without assuming `file:` resources.
Because virtual workspace providers do not guarantee a cross-file transaction, a partial failure
after a successful preflight must stop remaining writes and report completed, failed, and untouched
targets explicitly.

Creates use `WorkspaceEdit.createFile` with overwrite and ignore-if-exists both disabled and with
the proposed bytes supplied as the initial content. This is the strongest provider-neutral
no-overwrite create exposed by the supported VS Code API and is the final guard for direct
create-only application when a target appears after preflight. The adapter does not fall back to
`workspace.fs.writeFile` when a provider cannot apply that resource edit; it fails closed instead.

Updates retain the SHA-256 of the original provider bytes, including an optional UTF-8 BOM, instead of deriving the guard by decoding and re-encoding text. They re-read and compare that exact preview hash as the final awaited operation before starting `workspace.fs.writeFile`, then verify the resulting bytes. Caller-owned target-parent snapshots are prepared before both internal reads and checked around their stat/read boundaries, including the post-write readback. VS Code's public workspace filesystem API does not expose an expected version, ETag, hash precondition, or other compare-and-swap option for an existing resource. A provider or remote actor can therefore change an existing file in the narrow interval between the hash check and the write, and the write can overwrite that change; similarly, no directory lock spans the provider mutation. The MVP reports this limitation explicitly as a fail-detect boundary and does not claim full update CAS or a universal atomic pathname walk. Remote and virtual provider acceptance evidence must exercise collision and failure behavior for each supported editor/provider combination.

The extension maintains an in-memory parsed-bundle cache keyed by selected bundle and document revision. Markdown remains authoritative. No parsed concept body or frontmatter is stored in `globalState`, `workspaceState`, a database, or an external service.

The Activity Bar sidebar is also in-memory and session-scoped. Native Tree View providers consume
the latest runtime snapshot, compact user-controlled labels as text, and cache a bounded
presentation tree for the current revision. Tree items retain current URI/root/revision identity;
stale items cannot open or author against a replacement snapshot. The Actions view uses native
welcome content and registered command links. No sidebar Webview, HTML renderer, persistence, or
additional workspace watcher is introduced.

## Webview security and lifecycle

The Webview HTML uses a per-render nonce and a CSP equivalent to:

```text
default-src 'none';
img-src <webview-source> data:;
style-src <webview-source>;
script-src 'nonce-<nonce>';
font-src <webview-source>;
connect-src 'none';
```

Only packaged resources are exposed through narrow `localResourceRoots`. The graph does not need network access. Message receivers validate the protocol version, message type, graph revision, per-post delivery ID, IDs, payload shape, reference/backlink/statistics consistency, and the shared resource limits before any privileged action. The graph boundary permits at most 2,000 nodes, 10,000 retained relationships, 128 tags per concept, 20,000 tag assignments, 512 unique types, 4,096 unique tags, and 16 MiB of exact escaped JSON. Its size gate counts UTF-8 and JSON escapes in one pass without first allocating the serialized payload. Every replacement post receives a new delivery ID, including a repost of the same revision after Webview context recreation. The Webview accepts only a greater delivery ID for an already displayed revision, so a delayed or replayed replacement cannot roll the UI back. Render success, render failure, and source-navigation messages echo that ID, so a queued message from the destroyed context cannot complete or act on the replacement context's delivery.

The graph renderer adapter owns the render loop, resize observer, subscriptions, WebGL resources,
camera controller, and disposal. OrbitControls supplies drag rotation and modified/secondary-drag
panning. The camera controller disables OrbitControls wheel zoom so it can distinguish identifiable
Chromium pinch input from short pixel-delta trackpad swipes, retain mouse-wheel zoom, and constrain
camera distance. It captures a non-passive wheel listener only on the graph surface; ordinary
Webview scrolling outside that surface remains untouched. Toolbar and keyboard commands use the
same controller as node/search focus. Camera movement temporarily resumes rendering and restores
the idle stop after a bounded transition or gesture window. Hiding, reopening, switching bundles,
or closing the panel must not leave an active simulation, camera timer, or stale listener.
The adapter also owns the optional folder-cluster force. Toggling it reheats the `d3` simulation
only for the existing bounded cooldown window; filtering or graph replacement reinitializes the
force against private render nodes. No folder anchor is serialized, published as a graph node, or
counted in graph statistics.

## State and async model

The extension host owns:

- Selected bundle context.
- Parsed bundle revision.
- Diagnostics.
- Graph payload and source-URI mapping.
- Activity Bar Bundle/Resources/Actions presentation derived from the current snapshot.
- File watcher and debounce lifecycle.

The Webview owns presentation-only state:

- Camera and node coordinates.
- Search, type/tag filters, selected folder subtree, and the folder-grouping toggle.
- Selected node and visible details.
- Focus state for non-spatial navigation.

Every graph payload carries a monotonically increasing revision. Webview actions include the revision they were based on, and the extension rejects actions from a stale bundle or graph revision when acting on them would target the wrong resource.

File events are processed through cancelable, strictly single-flight refresh work. Equal pending
changes coalesce when inserted; more than 512 distinct pending paths collapse to one full rescan.
The scheduler combines a 250 ms trailing debounce with a 1,000 ms maximum latency, so a continuous
event stream still runs. A newer request invalidates an older result, but no replacement starts
until all physical provider calls issued by the prior refresh settle, and at most one trailing
refresh runs afterward. Failure to enumerate the selected bundle root, a bundle-scoped semantic
resource failure, or another unhandled current-generation refresh failure clears the prior
diagnostics and graph rather than leaving stale derived state visible; later watcher activity can
recover the still-selected context. The first fatal failure in one unavailable period also raises
one modeless warning that identifies workspace availability or read permissions and tells the user
to restore access, then save Markdown or run `OKF: Validate Bundle` to retry. Repeated watcher
batches suppress that warning until a successful publication resets the notification state. An
unreadable child subtree, individual Markdown file, or document-scoped semantic limit is instead
retained as a URI- and provider-path-scoped finding, and readable siblings still produce current
diagnostics and graph state. A partial concept crosses the graph boundary only as an identity-only
`sourceFailed` node: it remains navigable and counts as a concept but produces no derived
type/tag/orphan/outgoing-link/broken-link claim; valid siblings may still link to its stable
identity. The first implementation sends a full replacement graph; patch messages are introduced
only after benchmark evidence shows they are needed.

Generated and provider-relative paths share one early resource guard before decoding, splitting,
joining, or rendering: 4,096 UTF-16 code units, 4,096 UTF-8 bytes, and 64 segments. User-input paths
are checked again after stable percent decoding. Initialize Bundle validates every preset output
after prefixing the requested directory, New Concept validates the combined destination and
filename, and Agent Integration validates the selected bundle identity before reading an existing
instruction file. Serialized bundle/source/provider URIs use a separate inclusive 16 KiB
code-unit/UTF-8 envelope. This admits the roughly 12 KiB percent-encoded representation of a valid
4 KiB multibyte path while still bounding retained URI identities.

One selected-bundle refresh admits at most 2,000 Markdown documents, 2 MiB for each reported and
actual document, 32 MiB of cumulative Markdown bytes, eight concurrent provider operations,
64 traversal segments, 32 MiB of cumulative retained path/URI identity, and 128 retained failures.
Every fixed concurrency batch uses `Promise.allSettled`; cancellation or one fatal result is
reported only after all already-issued physical calls settle. Provider metadata is checked before
avoidable reads, then each materialized byte array is checked immediately. The workspace API cannot
prevent a dishonest provider from first allocating and returning an oversized array, but Workbench
does not hash, decode, or retain that body. A per-document overflow becomes one typed identity-only
resource failure and leaves siblings publishable. Document-count, aggregate-byte, root, depth, and
traversal-identity overflows invalidate the refresh.

Before constructing YAML or Markdown ASTs, the parser checks per-document byte/code-unit, line,
YAML collection and Markdown media nesting, indentation, structural-token, syntax-candidate,
link-candidate, label, and target limits. Markdown additionally caps emphasis at 1,024 delimiter
runs and marker code units, 8,388,608 attention grammar-event work units, 65,536 list/blockquote
continuation work units, and 8,388,608 prospective link-label closing scan units per document.
It also applies overflow-safe bundle-level work budgets before later ASTs and caps retained semantic
output afterward. Every completed Markdown inspection, including reserved documents and inspections
that already found a document limit, is charged before its document failure is handled. The
Markdown aggregate envelope is 8 MiB of body code units, 100,000 body lines, 33,554,432 attention
grammar-event work units, 262,144 list/blockquote continuation work units, 33,554,432 link-label
closing work units, 80,000 syntax candidates, and 20,000 link candidates. A document-scoped limit
retains only stable source identity and empty safe sentinels; a bundle-scoped aggregate limit
preserves later identity-only entries and prevents diagnostics or graph publication. Exact and
one-over tests cover these boundaries, including compact YAML sequences, syntax-free body/line
inputs, attention grammar-event work, container continuation work, link-label closing work, and
dense Markdown reference syntax.

Automatic bundle discovery is a bounded convenience scan. Its defaults are 32 workspace roots,
depth 16, 512 `index.md` files, 1 MiB per index, 8 MiB total index bytes, and 64 retained failure
records. The VS Code workspace adapter separately caps one traversal at 10,000 directories and
100,000 provider entries. A depth, access, count, or byte limit produces an incomplete result;
Workbench does not auto-select even a previously selected candidate from that partial view and
instead opens the explicit directory picker. The provider API necessarily returns one directory's
entry array before its size is known, but the adapter rejects an oversized array before sorting or
retaining individual entries, and discovery uses `stat.size` to avoid avoidable oversized reads.

## Testing environment

| Layer | Tool baseline | What it proves |
| --- | --- | --- |
| Core and presentation-model unit tests | Vitest `4.1.x`, Node environment | Parsing, preservation, resolution, validation, indexes, templates, graph model, and deterministic sidebar resource hierarchy |
| Rust core and CLI | `cargo test --workspace` | Native semantics, deterministic generation, CLI no-write/apply/collision behavior |
| Wasm parity | Vitest plus locked release Wasm build | ABI/import boundary and canonical Rust/TypeScript fixture and byte parity |
| Webview state unit tests | Vitest `4.1.x`, Node environment | Pure search, type/tag/folder filtering, folder hierarchy, focus, presentation, color, custom-force, and message-decoding state without claiming browser DOM behavior |
| Security boundaries | Dedicated Vitest and Playwright configs | Host/path/protocol boundaries plus hostile-content DOM execution and browser egress interception |
| Extension integration | `@vscode/test-cli` `0.0.x` and `@vscode/test-electron` `3.1.x` with Mocha | Commands and Activity Bar views, workspace FS, diagnostics, watchers, URI behavior, source navigation, and the registered non-`file:` read boundary |
| Webview browser harness | Playwright `1.62.x` on Chromium | Real DOM, WebGL smoke, CSP-compatible bundle loading, folder tree/filter/breadcrumb interaction, keyboard interaction, camera toolbar behavior, and wheel/pinch event boundaries |
| Release smoke | Packaged VSIX in VS Code and VSCodium | Installation, activation, packaged resources, upgrade, uninstall |
| Performance | Headed VS Code `1.129.1` release benchmark harness | QR-002 and QR-003 evidence on recorded hardware; VSCodium performance may be investigated separately but cannot satisfy the current strict release record |

References:

- [Testing VS Code extensions](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
- [`@vscode/test-cli`](https://www.npmjs.com/package/@vscode/test-cli)
- [`@vscode/test-electron`](https://www.npmjs.com/package/@vscode/test-electron)
- [Vitest](https://www.npmjs.com/package/vitest)
- [Playwright Test](https://www.npmjs.com/package/@playwright/test)

Playwright is not treated as proof of Electron Webview performance. WebGL performance claims require the headed editor benchmark with hardware, GPU, editor, Electron, and fixture versions recorded.
That benchmark starts through a built-in-only bootstrap which copies the exact runner, recorder,
build/report helpers, Playwright, `@vscode/test-electron`, esbuild, and their runtime closure into
an owner-only temporary module root outside the repository. The checked-in performance-toolchain
manifest binds platform-native esbuild and installed platform-optional files by exact hash while
keeping the candidate identity portable between the macOS capture host and Ubuntu release
verification. The portable identities retain esbuild's JavaScript and metadata but hash-bind an
exclusion for its postinstall host-native `bin/esbuild` mirror. Before any build, the bootstrap and
shared verifier require the npm lock integrity plus the manifest's exact inventory and hashes for
every other portable esbuild file, rejecting persisted install-time binary overrides; the
execution snapshot and per-platform manifest still verify native bytes exactly. The runner rejects
repository-root execution, resolver fallback, toolchain overrides, mixed-case dangerous
environment variables, and any original/staged input change. A live production or QR-003 build is
used only to discover esbuild's input graph. The exact discovered bytes and resolver manifests are
then materialized
under the owner-only benchmark root, and every authoritative production bundle and injected QR-003
harness is built twice from those private trees. The captured private inputs are verified before,
between and after the builds, through strict evaluation, and after each file's atomic rename under
`artifacts/performance`. Success is reported only after the complete JSON/Markdown pair is committed
and read back, closing transient source-change-and-restore and output-alias races.

The integration configuration exposes the narrow acceptance-completion API only in its isolated
test Extension Host. Its provider-boundary scenario registers a read-only `okfmem:`
`FileSystemProvider`, adds that URI as an actual workspace folder, invokes Validate Bundle and Open
3D Graph through their public resource-URI command arguments, checks Problems URI identity and the
Webview render acknowledgement, and rejects any provider mutation. This development-host evidence
does not substitute for packaged VSIX lifecycle evidence, an external remote provider, or write-flow
UI automation.

The packaged lifecycle driver derives the six-command contract from acceptance-only command
metadata and compares it with the installed manifest and registered IDs. In an untrusted workspace
it probes all metadata-classified write commands: Initialize Bundle, New Concept, Regenerate
Indexes, and Set Up Agent Integration. Each must refuse with `workspace-untrusted` before requesting
interactive input. Validate Bundle and Open 3D Graph are the two read commands.
For those commands, the driver requires a request ticket and waits for completion using that exact
request ID; a generic later runtime or graph signal cannot satisfy the command assertion.

The same driver installs a deliberately narrow Extension Host network observer for active phases.
It replaces properties on the CommonJS builtin export-owner objects returned by `require`: `node:http.get/request`, `node:https.get/request`, `node:http2.connect`,
`node:net.connect/createConnection`, `node:tls.connect`,
`node:dns.lookup/resolve/resolve4/resolve6`, `node:dgram.createSocket`, and the available
`globalThis.fetch` and `globalThis.WebSocket` globals, inventories the installed hooks, observes a
500 ms quiescence window, and leaves the hooks installed until Extension Host exit. Lifecycle
validation rejects a missing attempt array, incomplete inventory, nonzero attempt list, restored
guard, or incomplete metadata. This is CommonJS export-owner/global-hook evidence, not OS-level isolation; it
does not observe ESM named bindings, cached references, prototype or raw bindings, `dns.promises`, child processes,
editor-owned traffic, or Webview traffic. The persisted attempt list ends at report creation; the
hooks remain installed to deny later tail calls until process exit. The post-uninstall phase installs no network observer and
records attempts and guarded quiescence as not observed because it verifies extension API absence
only. Webview egress is covered separately by CSP and the candidate-specific headed capture.

## Code quality

The scaffold uses ESLint 9 with the compatible `typescript-eslint` 8 line and Prettier 3. Formatting, linting, type checking, unit tests, integration tests, Webview tests, build, package validation, dependency review, and benchmark-harness entry points are exposed through package-local scripts. `npm run check` invokes `test:security:all`, which runs the dedicated Node boundary suite, creates a current production build, and then runs the dedicated Playwright hostile-content suite. A fresh machine must install the pinned Playwright Chromium binary once before invoking this aggregate; the test command does not download tooling at runtime.

The repository does not currently use `vp`, so Vite+ commands are not introduced. Documentation must reference script names only after those scripts exist in `package.json`.

Production code must not use `any`. Tests may use explicit unsafe casts only at a boundary being deliberately tested, with the reason visible in the test.

## CI and release environment

GitHub Actions is the initial CI platform.

Required pull-request gates:

- Clean `npm ci` using Node 24.18.0.
- Pinned Rust `1.92.0` with the `wasm32-unknown-unknown` target.
- TypeScript format, lint, and strict type checks plus `cargo fmt`, `cargo clippy`, and
  `cargo test --workspace`.
- Core and Webview unit tests.
- Dedicated Node boundary tests and the dedicated Chromium hostile-content/no-egress test.
- Extension integration tests on a pinned minimum VS Code and the current stable VS Code.
- Production build and VSIX package inspection.
- Production dependency license classification and deterministic `THIRD_PARTY_NOTICES.md`
  freshness through `node scripts/security-check.mjs --check-notices` after the clean install.
- Locked Cargo-graph license classification and deterministic `RUST_THIRD_PARTY_NOTICES.md`
  freshness through `node scripts/rust-notices.mjs`.

Ubuntu 24.04 is the primary CI environment. Release smoke also runs on current supported GitHub-hosted Windows and macOS images, with exact runner images recorded by each workflow run. VSCodium validation installs the pinned VSCodium release rather than assuming `@vscode/test-electron` represents it.

Security suites have one explicit owner in every aggregate workflow so a passing ordinary test command is never reported as dedicated security coverage:

| Gate | Node security owner | Playwright security owner | Candidate ordering |
| --- | --- | --- | --- |
| Local `npm run check` | `test:security:all` | `test:security:all` after its production build | Both are part of the aggregate |
| Pull-request CI | `quality-and-package` | `webview-browser` after `test:webview` builds | Both jobs are required by the workflow |
| Compatibility | `candidate` before packaging | `acceptance` after its current Webview build | Node boundary pass precedes candidate upload; the browser lane gates the workflow |
| Package smoke | Every `package-smoke` matrix lane | `security-boundaries` after its production build | Node host/path/junction boundaries run on Ubuntu, macOS, and Windows; the Chromium boundary passes before any OS package lane |
| Open VSX release | `build-candidate` | Covered by required main-branch CI before tagging | The release reruns the deterministic Node boundary before retaining the candidate |

The package-smoke matrix deliberately does not repeat the complete unit, performance-stress, or
editor-acceptance suites on every runner. Pull-request CI owns those platform-neutral gates once.
Each package lane instead runs the native Rust suite, the bundled-CLI host-platform contract, the
Node filesystem security boundary, and the target VSIX reproducibility/parity checks. This keeps
slow runner variance out of package qualification without weakening any platform-dependent gate.

The repository supply-chain policy parses these workflows and fails on a missing, misplaced,
duplicate, conditional, or failure-tolerating security command. The default Vitest config includes
only `test/unit`, and the default Playwright config includes only `test/webview`; neither is counted
as a substitute for the dedicated configs under `test/security`.

Package with `@vscode/vsce` `3.9.x`. Validate and publish an already built VSIX with `ovsx`
`1.0.x`. The root `package.json` keeps `"private": true` as an npm-registry publish guard; it does
not make the GitHub repository private and does not prevent an MIT-licensed VSIX from being
submitted to Open VSX.

Per [ADR 0006](decisions/0006-publish-open-vsx-from-version-tags.md), a pushed `v*` tag is the
release authorization. The workflow accepts only a tag whose commit is contained in `main`, whose
name matches `v<package.json version>`, and whose changelog entry has a publication date. It reruns
the deterministic source, dependency, Node security, audit, package, reproducibility, and packaged
security checks, retains the universal VSIX and canonical Wasm, then builds four native binaries.
Each native job packages the same binary bytes into a target-platform VSIX and a standalone CLI
archive. The workflow creates the matching GitHub Release and publishes all five retained VSIX
files without rebuilding them. After the GitHub Release exists, the package-repository job verifies
the retained macOS and Windows CLI archive checksums, deterministically generates
`Formula/okf.rb` and `bucket/okf.json`, and pushes only those paths to the repository named by
the `TAP_REPO` repository secret. The Homebrew and Scoop manifests point back to the immutable
GitHub Release archives; they do not introduce another binary build.

The repository secret `OPEN_VSX_TOKEN` is exposed only to `ovsx verify-pat straydog` and the
subsequent `ovsx publish` step. Missing or invalid authorization fails closed. Pull requests,
ordinary branch builds, the candidate build job, and the GitHub Release job do not receive the
credential. The locked `ovsx` `1.0.2` command uses duplicate-safe retry behavior, while Open VSX
still treats a published version as immutable; changed bytes require a higher SemVer version and a
new tag. The package-repository credential follows the same step-local boundary:
`STRAY_TOOLS_TOKEN` and `TAP_REPO` are exposed only to the manifest push step, both are required,
and an inaccessible repository or failed push fails the tagged workflow.

The hosted repository enforces GitHub Actions SHA pinning in addition to repository-owned workflow
checks. Every `uses:` reference remains a reviewed full commit SHA. Artifact downloads use the
Node 24-based `actions/download-artifact` v8 line, and the aggregate package gate requires the exact
Linux x64, Windows x64, macOS arm64, and macOS x64 artifact labels. It validates one correctly
targeted VSIX per label, one native executable per VSIX, and one shared canonical Wasm SHA-256.

The ordinary pull-request CI and tagged candidate job run the repository-owned npm and Cargo
notice commands. Package and security checks require both exact notice files in the VSIX. The
Cargo notice generator traverses only dependencies reachable from `okf-wasm`; native CLI
distribution must run the same policy against its release graph before binaries are published.

The repository-owned package wrapper sets a fixed `SOURCE_DATE_EPOCH`, which makes pinned `vsce`
sort ZIP entries lexicographically, and then normalizes every local-header and central-directory
DOS timestamp to `1980-01-01 00:00:00`. Regular files use mode `0644`; Unix CLI entries use `0755`.
This removes asynchronous file-discovery ordering, clock-dependent bytes, and host filesystem mode
defaults while preserving entry contents, CRCs, compression, extra fields, and comments. The
normalizer fails closed for ZIP64, split archives, timestamp-bearing ZIP extra fields, or a missing
declared executable. CI invokes that same wrapper a second time against the unchanged build and
requires byte equality with each candidate before retaining it. Because target VSIX packages
intentionally differ, cross-platform byte identity is no longer the aggregate contract. Package
smoke instead supplies one Ubuntu-built canonical capability-free Wasm module to all four package
jobs, validates each declared platform and executable, and requires the same Wasm SHA-256 across
the set. Each platform job also requires the standalone and bundled CLI byte length and SHA-256 to
match.

References:

- [`@vscode/vsce`](https://www.npmjs.com/package/@vscode/vsce)
- [`ovsx`](https://www.npmjs.com/package/ovsx)
- [Open VSX](https://github.com/eclipse-openvsx/openvsx)

## Local diagnostics without telemetry

Use one named VS Code output channel for support-relevant local diagnostics. Log stable operation events for command start, success, handled failure, watcher refresh, Webview lifecycle, and partial write failure.

Logs may contain an operation name, result, reason code, duration, safe concept count, graph revision, and retryability. They must not contain document bodies, raw frontmatter, secrets, tokens, complete generated content, or arbitrary user-controlled strings without sanitization. Debug detail is opt-in. No log is uploaded automatically.

## Initial dependency review checklist

Before merging the Phase 0 scaffold:

- Confirm every selected version supports Node 24 tooling and the Node 22 extension target.
- Confirm runtime dependency licenses and required notices.
- Confirm esbuild produces one extension bundle and one locally loadable Webview bundle.
- Inspect the VSIX and ensure source, fixtures, tests, and development-only dependencies are excluded where appropriate.
- Verify the extension runs without network access.
- Verify the manifest installs on VS Code 1.121 and VSCodium 1.121.
- Record any deviation from this baseline in an ADR update before adding overlapping tooling.

## Deferred decisions

- Browser-hosted VS Code extension support and a `browser` entry point.
- Microsoft Marketplace publication.
- Rich Markdown-to-HTML rendering in the Webview.
- Incremental graph patch protocol.
- Custom templates and third-party template packages.
- TypeScript 7 adoption.
- Backward compatibility below VS Code 1.121.
