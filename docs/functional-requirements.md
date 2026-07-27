# Functional requirements

- Status: Approved
- Target: MVP
- Version: 0.1
- Date: 2026-07-22

## Purpose

This document consolidates the user-visible and system behavior required for the initial OKF Workbench release. It turns the product brief, MVP scope, compatibility contract, agent integration design, architecture, and accepted decisions into testable requirements.

The canonical OKF v0.1 specification and accepted architecture decisions take precedence if this summary conflicts with them. Requirements use **MUST**, **SHOULD**, and **MAY** in their ordinary normative sense.

## Product boundary

OKF Workbench is a local-first VS Code-compatible extension for the complete authoring loop:

```text
initialize -> create -> edit -> validate -> explore -> repair
```

Markdown files are the source of truth. Diagnostics, indexes, and the graph are derived views or generated artifacts. The MVP does not include an AI provider, hosted account, cloud synchronization, content upload, or telemetry.

## Actors and terms

| Term | Meaning |
| --- | --- |
| User | A person authoring or maintaining an OKF bundle in a VS Code-compatible editor |
| Bundle root | The selected directory whose Markdown tree forms one OKF bundle |
| Concept | A non-reserved Markdown file with YAML frontmatter and a required non-empty `type` |
| Concept ID | The bundle-relative POSIX path of a concept without the `.md` extension |
| Reserved document | An `index.md` or `log.md` at any directory level |
| Conformance error | A violation of a hard OKF v0.1 interoperability rule |
| Curation warning | A maintainability problem that does not make the bundle non-conformant |
| Managed region | A marker-delimited section that Workbench may update without replacing unrelated content |

## Functional requirements

### 1. Bundle context and initialization

| ID | Requirement | Acceptance condition |
| --- | --- | --- |
| FR-001 | Workbench MUST resolve a bundle root by unambiguous detection or explicit user selection. | When detection is ambiguous, incomplete because of a safety limit/access failure, or finds no bundle, the user can select any target directory inside an open workspace before a bundle operation runs. The multiple-candidate picker keeps this explicit browse path available. |
| FR-002 | `OKF: Initialize Bundle` MUST let the user choose the workspace target, suggested bundle directory, and preset. | The command inputs identify all three values before writing. |
| FR-003 | Initialization MUST provide the `Minimal`, `Software Project`, and `Data & Analytics` presets. | Each preset can be selected and produces its documented file set. |
| FR-004 | Initialization MUST apply a create-only proposal without a separate preview or approval when every generated target is absent. | Completing the final input creates the selected preset directly, opens its root index, and produces no proposal preview or confirmation request. |
| FR-005 | A generated bundle MUST contain a UTF-8 root `index.md` declaring `okf_version: "0.1"`. | The generated minimal bundle passes the Workbench conformance validator. |
| FR-006 | Initialization MUST detect every target-path collision before writing. | Any existing target refuses the complete initialization; no initialization path replaces an existing file. |
| FR-007 | Generated paths MUST remain inside the selected bundle root. | Absolute paths, parent traversal, and equivalent encoded or normalized escapes are rejected with an actionable message. |

### 2. Concept creation

| ID | Requirement | Acceptance condition |
| --- | --- | --- |
| FR-010 | `OKF: New Concept` MUST offer `Generic Concept`, `Decision`, `Metric`, `API Endpoint`, `Data Table`, `Playbook`, and `Reference` templates. Generated metadata and the complete YAML/Markdown output MUST remain inside the parser's shared deterministic resource envelope. | Each listed template can generate a concept with valid YAML frontmatter. Inclusive-boundary and one-over tests cover a 256-code-unit/byte type, 4,096-code-unit title, 16,384-code-unit description, 128 tags of at most 256 code units/bytes each, and a 256-code-unit timestamp; every successful render parses and validates without a conformance or resource-limit failure. |
| FR-011 | Concept creation MUST collect destination, type, title, description, tags, and filename. | The proposed output path and frontmatter reflect the submitted values. |
| FR-012 | Concept creation MUST accept any non-empty `type` inside the shared identity-safety envelope; built-in templates MUST NOT form a closed type enumeration. Only malformed Unicode, parser-unsafe control characters, and deterministic code-unit/UTF-8 bounds constrain the otherwise arbitrary vocabulary. | A custom type such as `experiment-result` can be created and validated without an unknown-type error; a boundary-sized custom type remains eligible, while an unpaired surrogate, control character, or first over-limit value is refused with corrective guidance before proposal construction. |
| FR-013 | Concept creation MUST reject output paths outside the selected bundle and detect filename collisions before writing. A valid create-only concept proposal MUST apply without a separate preview or approval. | Rejected input leaves the workspace unchanged and identifies the conflicting or invalid path; an absent target is created directly, while a target that exists initially or appears after preflight is never overwritten. |
| FR-014 | A successfully created concept MUST open in the editor. | The newly created URI becomes the active or visible editor document. |
| FR-015 | A generated concept MUST be visible to validation and graph indexing without reloading the extension host. | The file watcher processes the new file and refreshes affected derived state. |

### 3. Bundle parsing and graph construction

| ID | Requirement | Acceptance condition |
| --- | --- | --- |
| FR-020 | The parser MUST treat every non-reserved `.md` file with a non-empty filename stem beneath the bundle root as a concept and every `index.md` or `log.md` as reserved, except that the root `AGENTS.md` and every `.agents/` subtree are project-control metadata and MUST be excluded from the bundle inventory. A non-reserved file whose bytes, frontmatter, or Markdown cannot be consumed MUST still retain a stable partial concept identity and source record. A provider-reported basename exactly equal to `.md` MUST instead become a file-scoped parse failure without invalidating siblings. | Nested and invalid-document fixtures produce the expected concept and reserved-document sets; root-level agent integration outputs produce no concepts or findings even when the bundle is the workspace root; a nested `AGENTS.md` outside `.agents/` remains eligible; partial concepts retain ID, source URI/path, and content hash with empty safe metadata/body sentinels; `.md` and `nested/.md` produce only path-addressable failures while `.notes.md` remains a concept. |
| FR-021 | The parser MUST derive non-empty concept IDs from bundle-relative paths without `.md`, normalized to POSIX `/` separators. | Equivalent Windows and POSIX fixture paths produce the same concept ID, and an empty filename stem never produces an empty graph node ID. |
| FR-022 | The parser MUST retain the complete frontmatter map while exposing normalized known fields. Standard YAML tagged values MUST use an explicit JSON-safe representation that retains the canonical tag, semantic value, and original lexical value. That representation MUST NOT establish tag provenance by structural similarity: only the parsed YAML AST for a real explicit tag, including an alias resolved to its tagged node, may grant explicit-tag semantics. Custom runtime objects and tags MUST fail closed. | Unknown fields survive every supported parse-and-write round trip unchanged; the `yaml-standard-tags` fixture inventories timestamp, binary, set, and ordered-map values without a parse failure, serializes with `JSON.stringify`, and does not pollute object prototypes. Direct and aliased real `!!str` scalars satisfy semantic-string fields, while mappings or sequences that imitate `$okf-workbench:yaml-tag` and version values bearing a non-`!!str` tag are rejected as semantic strings. |
| FR-023 | The link resolver MUST resolve `/`-prefixed links from the bundle root and relative links from the source document directory. | Bundle-relative, document-relative, nested, spaced, and Unicode fixtures resolve to the expected target IDs. |
| FR-024 | The link resolver MUST distinguish resolvable internal, broken internal, external, and out-of-bundle targets. | Each target category produces the expected graph inclusion and diagnostic behavior without crashing parsing. |
| FR-025 | Internal Markdown links MUST produce directed, untyped graph relationships. | A link from A to B produces an A-to-B relationship and does not infer a semantic edge type from surrounding prose. |
| FR-026 | Parsing failures MUST be represented as diagnostics or operation results rather than uncaught errors. A source-scoped parse failure owns the diagnostic for its partial concept and MUST NOT trigger misleading derived metadata or orphan findings. | Invalid YAML and undecodable UTF-8 do not terminate processing of unrelated bundle files, remain navigable in graph/model inventory, and produce one precise primary conformance finding per failure. |
| FR-027 | Graph publication MUST enforce one deterministic resource envelope before Webview serialization. | Construction and protocol decoding share limits of 2,000 nodes, 10,000 retained relationships, 128 tags per concept, 20,000 tag assignments, 512 unique types, 4,096 unique tags, and a 16 MiB escaped-JSON payload. Edge IDs are compact deterministic ordinals rather than copies of producer IDs. A one-over payload is refused without allocating the serialized string, while an exact-boundary relative path or graph field remains eligible. |
| FR-028 | One selected-bundle load MUST have a deterministic provider-resource envelope and bounded physical concurrency. | At most 2,000 Markdown documents, 2 MiB per document, 32 MiB total reported and actual Markdown bytes, eight concurrent provider calls, 64 path segments, 32 MiB cumulative retained traversal identity, and 128 retained failures are admitted. Provider paths are at most 4,096 code units and UTF-8 bytes; serialized source URIs are at most 16 KiB so a fully percent-expanded 4 KiB path remains representable. Exact limits pass. A one-over document becomes one document-scoped identity-only failure without suppressing readable siblings; every materialized provider byte remains charged to the actual aggregate even when later parent revalidation discards it; and a count, aggregate, root, depth, or traversal-identity overflow fails the refresh. Every already-started provider call is drained before a canceled or failed generation settles. |
| FR-029 | YAML and Markdown parser work MUST be bounded before constructing their ASTs and again before retaining semantic output. | Per document, frontmatter is limited to 64 KiB, 4,000 lines, 8,000 structural tokens, depth 64 and indentation 128; Markdown body is limited to 256 KiB, 20,000 lines, 20,000 syntax candidates, list/blockquote and link/image nesting depth 64, 1,024 emphasis delimiter runs and marker code units, 8,388,608 attention grammar-event work units, 65,536 list/blockquote continuation work units, 8,388,608 link-label closing work units, 5,000 link/image constructs, 5,000 definitions, 512-byte labels, and 2,048-byte targets. Across a bundle, every Markdown inspection, including a reserved or document-failing source, is charged before its failure is handled against limits of 8 MiB body code units, 100,000 body lines, 33,554,432 attention grammar-event work units, 262,144 list/blockquote continuation work units, 33,554,432 link-label closing work units, 80,000 syntax candidates, and 20,000 link candidates. Other bundle-level pre-AST and retained-output limits are deterministic. A document limit yields one safe partial identity; an aggregate parser-work limit is bundle-scoped, preserves later identity-only entries, and prevents publication. Exact and one-over cases are covered without parsing the over-limit AST. |

### 4. Validation and diagnostics

| ID | Requirement | Acceptance condition |
| --- | --- | --- |
| FR-030 | `OKF: Validate Bundle` MUST publish findings through the Problems panel. | Invoking the command replaces stale findings for the selected bundle with current results. |
| FR-031 | Conformance errors MUST include missing or invalid YAML frontmatter, missing or empty concept `type`, invalid reserved-document structure, and unconsumable UTF-8 input. | A fixture for each case is reported as a conformance error. |
| FR-032 | Curation warnings MUST include broken internal links, orphan concepts, missing recommended title or description, suspicious timestamps, and duplicate resource identifiers. | A fixture for each case is reported as a warning and not as an OKF conformance failure. |
| FR-033 | Unknown concept types and additional frontmatter fields MUST NOT produce errors or warnings solely because they are unknown. | A valid custom-type fixture with custom fields has no unknown-schema finding. |
| FR-034 | Every diagnostic SHOULD identify the narrowest useful URI and source range. | Frontmatter and link fixtures point to their field or Markdown link when a range is available. |
| FR-035 | Diagnostic wording and severity MUST visibly distinguish conformance from curation. | A user can determine the category from the Problems panel without opening implementation logs. |
| FR-036 | Saving, creating, deleting, or renaming an affected Markdown file MUST refresh its diagnostics without reloading the extension host. | Watcher integration tests observe current findings after the debounced update completes. |

### 5. Index generation

| ID | Requirement | Acceptance condition |
| --- | --- | --- |
| FR-040 | `OKF: Regenerate Indexes` MUST offer `missing indexes only` and `update all` modes. | The selected mode limits the proposed files accordingly. |
| FR-041 | Index generation MUST show a diff before applying changes. | Canceling the diff preview changes no file. |
| FR-042 | Generated entries MUST use concept titles and descriptions when present and MUST tolerate their absence. | Fixtures with complete and minimal metadata both generate valid index entries. |
| FR-043 | Updating an existing index MUST change only one valid managed region and preserve unrelated content. | Content outside the managed markers remains byte-for-byte unchanged where practical. |
| FR-044 | Workbench MUST refuse automatic merging when managed markers are malformed or duplicated. | The command reports the affected file and performs no partial write. |
| FR-045 | Index generation SHOULD be idempotent. | Running the same operation twice without source changes produces an empty second diff. |

### 6. Three-dimensional graph exploration

| ID | Requirement | Acceptance condition |
| --- | --- | --- |
| FR-050 | `OKF: Open 3D Graph` MUST open a read-only editor Webview for the selected bundle. | Opening the graph does not modify bundle files. |
| FR-051 | The graph MUST render each parsed concept as a node and each resolvable internal Markdown relationship as a directed edge. | The rendered node and edge counts match the serializable graph model for a fixture. |
| FR-052 | Nodes MUST be colored by concept `type` using a stable fallback for previously unseen values. | Reopening unchanged data assigns the same visible color to each type. |
| FR-053 | The graph MUST support search by concept ID, title, and tags. | Each populated field can locate and focus its concept node. |
| FR-054 | The graph MUST support filtering by type and tag. | Applying and clearing filters updates visible results without changing source data. |
| FR-055 | Orphan concepts and broken internal links MUST have visible curation indicators. | Corresponding fixtures can be located from the graph or its associated non-spatial UI. |
| FR-056 | Selecting a concept MUST show its metadata, outgoing links, and backlinks. | Details match the core graph model and contain no inferred edge types. |
| FR-057 | A selected concept MUST provide an action that opens its source Markdown. | The editor opens the correct URI; a source range is selected when one is available. |
| FR-058 | The graph MUST react to concept create, change, delete, and rename events without reloading the extension host. | The Webview receives and displays a current replacement graph or patch after debounce. |
| FR-059 | Graph node coordinates and drag operations MUST remain presentation state only. | Dragging a node causes no Markdown or frontmatter write. |
| FR-060 | The graph MUST provide a searchable, keyboard-accessible, non-spatial node navigation path. | A keyboard-only user can locate a concept, inspect its details, and open its source without manipulating the 3D canvas. |
| FR-061 | Broken links MAY use placeholder presentation objects but MUST NOT be turned into valid concepts or semantic relationships. | Placeholder rendering does not alter graph-model concept counts or validation results. |
| FR-062 | The graph MUST provide bounded mouse, trackpad, toolbar, and keyboard camera navigation without capturing scroll outside the graph interaction surface. | Users can rotate, pan, zoom, fit, focus, and reset the camera; macOS trackpad pinch zoom and two-finger pan remain distinct where Chromium exposes sufficient gesture metadata; toolbar and keyboard fallbacks remain available; and the render loop returns to idle after interaction. |
| FR-063 | The graph MUST derive a navigable folder hierarchy from canonical POSIX concept IDs and compose one selected folder subtree with search, type, and tag filters. | The folder section shows deterministic nesting and recursive counts; `Bundle root` selects root-level concepts; same-named files in different folders remain distinct; clearing filters restores the complete bundle. |
| FR-064 | Selected-concept details MUST expose a clickable breadcrumb from `Bundle root` to the concept's parent folder. | Activating a breadcrumb segment selects that folder subtree and fits the visible graph without changing the source or semantic graph model. |
| FR-065 | The graph MUST offer optional presentation-only folder grouping. | Enabling grouping separates top-level folder clusters, gives nested folders a weaker deterministic offset, preserves type colors and the exact concept/edge/statistics model, and returns the renderer to its bounded idle lifecycle. |

### 7. Agent integration templates

| ID | Requirement | Acceptance condition |
| --- | --- | --- |
| FR-070 | `OKF: Set Up Agent Integration` MUST offer `AGENTS.md`, Agent Skill, or both. | The resulting proposal contains only the selected outputs. |
| FR-071 | Generated instructions MUST contain the actual selected bundle path. | No placeholder path remains in the proposed output. |
| FR-072 | Agent Integration MUST apply without preview when every proposed output is new, and MUST preview the complete proposal when any output changes or replaces an existing file. | An all-create proposal produces no confirmation request; canceling an existing-file preview leaves every new and existing target unchanged. |
| FR-073 | Workbench MUST append or update exactly one marker-delimited managed section in an existing `AGENTS.md`. | Unrelated instructions are preserved, and re-running generation updates only the managed section. |
| FR-074 | Workbench MUST refuse automatic `AGENTS.md` modification when markers are malformed or duplicated. | The user receives repair guidance and the file remains unchanged. |
| FR-075 | The default Agent Skill output MUST be `.agents/skills/maintain-okf-knowledge/SKILL.md`. | Generation creates a Skill with valid frontmatter and the documented maintenance workflow. When the bundle is the workspace root, this Skill and the root `AGENTS.md` remain outside the OKF concept and diagnostic inventory. |
| FR-076 | An existing Agent Skill MUST NOT be replaced without an explicit preview and replacement confirmation. | One exact replacement preview remains open through its tied replace-and-apply decision and write result; cancellation is non-destructive. |
| FR-077 | Agent setup MUST generate instructions only; it MUST NOT invoke an agent, model, or external provider. | The complete setup flow performs no model request or provider authentication. |
| FR-078 | Generated instructions SHOULD prefer the native `okf` CLI for local-filesystem validation, new-concept planning, and managed-index updates when it is available, but MUST remain usable without it. | `AGENTS.md` keeps one concise optional-CLI rule; the Skill provides `validate`, `new --check`, and `index --check` examples, requires review before `--apply`, and directs provider-backed or CLI-free environments to editor commands and document rules. |

### 8. Common file and workspace behavior

| ID | Requirement | Acceptance condition |
| --- | --- | --- |
| FR-080 | All core commands MUST operate without an account or network connection. | Initialize, create, validate, index, graph, and agent-template acceptance flows pass with network access disabled. |
| FR-081 | Any proposal that may change an existing file MUST show a preview or diff and require explicit approval; a proposal whose every change is `create` with an absent-target precondition MUST apply without preview. At most one write-command workflow may be active per Extension Host activation. | The registered command entry acquires an opaque lease before even its untrusted-workspace check or notification, then passes that same lease into the selected authoring factory instead of acquiring a nested lease. While one lease is active, every same-command or cross-command invocation settles immediately as a structured `proposal-workflow-busy` refusal that tells the user to finish or cancel the active workflow and retry; it performs no trust UI, selection, enumeration, read, or planning, and no rejected callback or proposal is retained in a FIFO or other pending queue. One admitted trust refusal and at most one modeless busy-warning promise are produced even under 100 concurrent untrusted invocations; notification rejection does not affect refusal completion, and the next active lease may notify once again. An all-create proposal opens no preview and requests no confirmation; its initial and immediately-before-write absence checks, plus the provider's no-overwrite primitive, refuse a target that already exists or appears during application. A mixed proposal containing even one update or replacement previews the complete change set. For previewed proposals, the summary tab, every diff title, and modeless confirmation share one cryptographically unique activation/run and full target identity; a closed or replaced approved preview refuses the first or next proposed write. After an applied or unchanged result, informational completion and editor navigation are best-effort: unresolved or failing host UI promises neither retain the lease nor change the settled result, and the next write command can start immediately. No supported command silently replaces existing user content. |
| FR-082 | Workspace access MUST support URI-based resources and MUST NOT require the selected workspace to use the `file:` scheme. | Core workspace flows pass against the supported remote or virtual workspace test harness. |
| FR-083 | File watching MUST cover create, change, delete, and rename events and debounce related bursts. | One logical edit burst results in current diagnostics and graph state without persistent duplicate processing. |
| FR-084 | User-facing failures MUST identify the affected operation and provide a corrective next step when one is known. | Expected parse, validation, collision, path, and merge failures do not expose only a raw stack trace. |
| FR-085 | Before any proposal write, Workbench MUST inspect the write root and every existing intermediate target segment, recheck an optional segment that was absent while its existing-parent baseline was captured, and bind internal expected-content and post-write reads to the target-parent generation. It MUST fail closed on a symbolic link, non-directory parent, or changed parent generation. | Initialize Bundle, New Concept, index regeneration, and Agent Integration leave every proposal target untouched when any target traverses a symlink or ordinary parent file; a deterministic absent-parent race reaches no external target stat/read; and a real `file:` workspace regression proves that a linked external directory receives no generated file. Existing-file updates remain a documented fail-detect boundary because the VS Code provider API exposes no compare-and-swap write. |
| FR-086 | Every authoring proposal MUST run a pure feasibility check before workspace preflight or any workspace I/O and MUST fail atomically when it exceeds 64 changes, 2 MiB for any proposed output, 2 MiB for any declared existing `expected.byteLength`, 16 MiB of cumulative UTF-8 before-and-after bodies, or a 1 MiB generated summary. | Every limit is inclusive and an exact-boundary proposal remains eligible for direct create-only application or a complete preview. Every one-over-limit proposal performs no workspace preflight or I/O; every infeasible proposal or later snapshot-read failure leaves zero preview tabs, registrations, provider bodies, and workspace writes. Until a virtualized or multi-diff review surface exists, the one-pinned-diff-per-change design is not approved above 64 previewed changes. |
| FR-087 | Validate Bundle and Open 3D Graph MUST share one fail-fast bundle-selection gate. | The gate is acquired before discovery, inspection, or a picker. While one read command is selecting and scheduling, 100 concurrent same-command or cross-command starts settle as structured `read-command-busy` refusals without invoking or retaining their callbacks, multiplying discovery reads, opening additional pickers, or substituting the admitted command's root for another explicit root. Admission is released after cancellation, success, or failure. |
| FR-088 | Every user-entered, generated, or provider-relative write path MUST be bounded before decoding, splitting, joining, or rendering it. | Initialize Bundle, New Concept, Set Up Agent Integration, and the privileged workspace path guard accept at most 4,096 UTF-16 code units, 4,096 UTF-8 bytes, and 64 POSIX segments. Exact limits pass when the complete output path fits; every one-over value is refused before direct application, a proposal preview, provider read, or write. |
| FR-089 | Watcher refresh scheduling MUST be single-flight, bounded, and eventually run during a continuous event stream. | Equal pending changes coalesce at insertion time; more than 512 distinct pending paths collapse to one full rescan. A 250 ms trailing debounce has a 1,000 ms maximum latency. No replacement refresh starts while physical provider calls from the prior refresh remain unsettled, and at most one trailing refresh runs afterward. |
| FR-090 | Every selected-bundle load MUST retain its containing workspace safety root; withhold each directory enumeration until the root-to-current-directory generation is revalidated; bind every distinct resource read to its complete parent chain; bind each local `file:` read to the native generation returned by its immediately preceding `lstat`; and revalidate the bundle generation before traversal, after enumeration, after each bounded read batch, and before publication. A nested traversal generation failure MUST invalidate the complete load. Non-`file:` providers MUST use an explicit trusted-provider metadata sandwich and MUST NOT be described as an atomic snapshot. | Validate, Open 3D Graph, index planning, watcher refreshes, automatic discovery, explicit inspection, proposal previews, Agent Integration reads, and proposal preflight fail closed when a required native identity is unavailable or when a file/ancestor becomes missing, a symbolic link, a non-directory, or a different generation. A native read opens one handle, verifies it before reading, reads only from that handle, rechecks handle and pathname identity, and returns bytes only after successful close; simultaneous read/close failure retains both facts. Deterministic real-`file:` tests swap root and deep descendant parents during open, fresh stat, and directory enumeration, then restore them before return: command and watcher refreshes publish no external title, bytes, or partial safe-sibling replacement; automatic discovery retains no external label or enumerated name; and every successfully closed or close-failing handle has an explicit outcome. The current graph and diagnostics are cleared and no replacement payload is published. Changing which overlapping workspace folder contains the same bundle changes the runtime selection identity and safety root. Removing the active workspace folder invalidates the runtime generation even if a folder with the identical URI is added again in the same host event. |
| FR-091 | Every write proposal MUST remain authorized by the exact open workspace-folder URI captured as its safety root. | Initialize Bundle, New Concept, Regenerate Indexes, and Set Up Agent Integration invalidate either their direct create authorization or active modeless preview when that exact folder is removed. A containing parent, a different provider authority, or re-adding the same URI does not revive the old authorization. The workflow checks current exact membership before the first and every later write, and the workspace adapter repeats the check after preparatory awaits immediately before its provider create or write primitive. Removal before the first commit produces zero writes; removal after one completed write stops all remaining targets and reports completed, failed, and untouched paths. |
| FR-092 | A modeless write decision MUST remain discoverable and explicitly cancellable if its original notification is hidden or dismissed. | While a valid proposal awaits input, Workbench shows a pending-review status item and enables `OKF: Review Pending Changes`. Recovery reveals the exact existing summary, opens a new Apply/Cancel attempt, and ignores results from older attempts. Invoking another write command offers Review or Cancel without queuing that command. Cancel, preview invalidation, or Extension Host disposal resolves the active workflow, releases its lease and preview resources, and performs zero new writes. |

### 9. Shared core and native CLI

| ID | Requirement | Acceptance condition |
| --- | --- | --- |
| FR-100 | Production extension semantics and the native CLI MUST use the same Rust `okf-core` implementation for parsing, validation, graph construction, indexes, bundle/concept templates, and agent templates. | Canonical fixtures and generated bytes pass parity tests through native Rust and the packaged Wasm ABI; the production activation loads the packaged Wasm core once and does not silently fall back after a load, ABI, trap, or response failure. |
| FR-101 | The extension Wasm adapter MUST be capability-free and remain outside the Webview. | The module targets `wasm32-unknown-unknown`, has no imports or WASI dependency, exposes only the versioned raw ABI, and is instantiated by the Extension Host. |
| FR-102 | The native `okf` CLI MUST provide `init`, `new`, `validate`, `index`, `graph`, `agent`, and `version`. | CLI integration tests exercise each command family and machine-readable output uses a `schemaVersion: 1` envelope. |
| FR-103 | CLI read commands MUST NOT write, and CLI write commands MUST plan before mutation. | `validate`, `graph`, and every `--check` path leave the filesystem unchanged; a non-TTY write refuses without `--apply`; collisions and unsafe paths fail before any target is changed. |
| FR-104 | CLI writes MUST remain contained and recoverable at the operation boundary. | Paths cannot escape the selected root, symbolic-link traversal is rejected, create-only targets are never overwritten, managed regions preserve unrelated text, and each file update uses an atomic same-directory replacement where supported. |
| FR-105 | Supported target-platform VSIX packages MUST expose a validated bundled `okf` CLI to new integrated terminals without modifying external shell configuration. | macOS arm64/x64, Linux x64, and Windows x64 packages contain exactly one executable and a reviewed manifest; terminal environment mutation appends its directory to `PATH`, publishes its exact path as `OKF_WORKBENCH_CLI`, is configurable, and rejects target/hash/mode drift. |
| FR-106 | The native CLI MUST also remain separately distributable, and each platform release MUST use identical CLI bytes in its standalone archive and VSIX. | Release jobs copy one release binary into both outputs, compare the raw copy, validate the VSIX manifest SHA-256, and fail unless standalone and bundled byte length and SHA-256 agree. |
| FR-107 | Unsupported Extension Host targets MUST retain extension functionality without a native CLI. | A universal VSIX contains no native executable; status explains the limitation and all editor commands continue through the packaged Wasm core. |

## Implementation constraints

These constraints support the functional behavior but do not add separate user features.

- The deterministic Rust core remains independent of filesystem, terminal, network, VS Code, and
  Webview APIs.
- The Extension Host loads the versioned Wasm ABI; the Webview never instantiates the core.
- Parsing and graph construction remain outside Webview components.
- The initial renderer is the standalone `3d-force-graph` package behind a repository-owned adapter, as accepted in [ADR 0003](decisions/0003-use-3d-force-graph.md).
- Webview scripts and styles are bundled locally and protected by a restrictive Content Security Policy with a nonce.
- Messages crossing the extension/Webview boundary are validated.
- User-controlled Markdown and metadata are escaped or sanitized before rendering.
- Unknown frontmatter fields are preserved by supported write operations.

## Quality and compatibility targets

The following are release constraints or prototype targets. Evidence status is stated explicitly
below and remains candidate- and environment-specific.

| ID | Target | Verification |
| --- | --- | --- |
| QR-001 | A user can create a valid first bundle and concept in under two minutes. | Timed first-use prototype test with the documented happy path. |
| QR-002 | File changes appear in diagnostics and graph state within one second after debounce for representative bundles. | Instrumented integration benchmark with documented hardware and fixture. |
| QR-003 | A graph containing 1,000 concepts and 5,000 internal edges remains interactively navigable on a typical developer laptop. | VS Code Webview benchmark; fixture, hardware, Electron version, and interaction threshold must be recorded. |
| QR-004 | VSCodium desktop is included in MVP compatibility testing. | Package installation and core acceptance scenarios pass on a documented VSCodium version. |
| QR-005 | Webview content meets the keyboard navigation behavior in FR-060 even when the 3D canvas itself is not accessible. | Keyboard-only acceptance test. |

QR-001 remains a hypothesis until a timed first-use study is retained. QR-002 and QR-003 pass for
the genuine current-input schema-v3 headed VS Code `1.129.1` capture on its recorded hardware:
QR-002 is `832 ms` p95 across 20 samples and QR-003 selects `d3`. The older VS Code `1.127.0`
capture is historical and no longer passes the current strict evaluator. See
[Performance evidence](performance-evidence.md). QR-004 and QR-005 become release claims only when
the required compatibility and packaged acceptance evidence is retained. No release documentation
may present candidate-specific or partially evidenced results as generally achieved.

## End-to-end acceptance scenarios

| ID | Scenario | Expected outcome |
| --- | --- | --- |
| AC-001 | First bundle | From an empty workspace, initialize the Minimal preset, create one concept, and validate. The bundle is conformant and the concept opens in the editor. |
| AC-002 | Permissive custom metadata | Load a concept with a custom type and unknown fields, perform a supported write operation, and reload it. The type remains valid and unknown fields are unchanged. |
| AC-003 | Diagnose and repair | Open a bundle with invalid frontmatter and a broken link, navigate from each Problem to source, repair and save. Findings clear after debounce without reloading. |
| AC-004 | Safe index regeneration | Regenerate indexes containing user-authored text and one valid managed region. The preview is accurate, only the managed region changes, and a second run has no diff. |
| AC-005 | Explore and navigate | Open the 3D graph; rotate, pan, zoom, fit, focus, and reset the camera; search and filter concepts; inspect backlinks; locate an orphan; and open source. The Markdown remains unchanged. |
| AC-006 | Live graph update | With the graph open, create, edit, rename, and delete concepts. The graph and details view converge to current workspace state without extension-host reload. |
| AC-007 | Safe agent setup | Add both integration outputs to a repository with an existing unrelated `AGENTS.md`. Preview and apply; unrelated content remains unchanged and a second run is idempotent. Repeat with the bundle at the workspace root; neither generated output becomes a concept or diagnostic. |
| AC-008 | Offline operation | Complete AC-001, AC-003, AC-004, AC-005, and AC-007 with network access disabled. No account, API key, or remote request is required. |

## Explicitly out of scope for the MVP

- Built-in chat, an LLM API, or automatic agent execution.
- Automatic semantic relationship inference or typed graph edges.
- Cloud synchronization, hosting, publishing, telemetry, or collaborative editing.
- PDF, Word, website, or database ingestion.
- Editing concept content by dragging graph nodes.
- Git-history animation or graph diff overlays.
- A fully programmable template language.
- Guaranteed very-large-graph support beyond measured prototype limits.
- Automatic maintenance of `log.md`.

## Resolved requirements questions

These items are resolved by [ADR 0005](decisions/0005-resolve-mvp-implementation-questions.md). The identifiers remain here for traceability.

| ID | Resolution | Affected area |
| --- | --- | --- |
| OQ-001 | Session-scoped selection; Explorer folder invocation explicitly switches roots, the ambiguous-candidate picker includes an alternate-directory choice, read diagnostics remain available for invalid roots, incomplete automatic discovery falls back to explicit selection, and existing-bundle writes use fail-closed compatibility checks before planning and immediately before apply. | Commands, state, file watching |
| OQ-002 | Exact Minimal, Software Project, and Data & Analytics file sets are fixed in ADR 0005. | Initialization, fixtures |
| OQ-003 | Exact `okf-workbench:index` markers and deterministic Markdown entries are fixed in ADR 0005. | Index generation, merging |
| OQ-004 | Explicit-zone ISO date-time validation, five-minute future tolerance, and exact duplicate-resource comparison. | Curation validation |
| OQ-005 | Six `okfWorkbench.*` command IDs, editor Webview graph, and a fixed 250 ms debounce. | Extension manifest, settings |
| OQ-006 | Broken links remain warnings/details owned by source nodes and never become graph nodes or edges. | Graph adapter, accessibility |
| OQ-007 | VS Code floor/current, VSCodium, Ubuntu, macOS, and Windows evidence matrix fixed in ADR 0005. | Compatibility, release |
| OQ-008 | Deterministic graph fixtures plus p95 update and interaction thresholds fixed in ADR 0005. | Performance benchmark |

## Traceability

| Requirement area | Primary repository sources |
| --- | --- |
| Product boundary and workflows | [Product brief](product-brief.md), [MVP scope](mvp-scope.md) |
| OKF parsing and validation | [OKF v0.1 compatibility contract](okf-v0.1-contract.md) |
| Module and Webview constraints | [Architecture](architecture.md) |
| Agent outputs and merge safety | [Agent integration](agent-integration.md), [ADR 0002](decisions/0002-deterministic-local-first-core.md) |
| 3D renderer choice | [ADR 0003](decisions/0003-use-3d-force-graph.md) |
| Delivery order and release gates | [Roadmap](roadmap.md) |

## Approval

- [x] Functional requirements reviewed and approved for MVP implementation.
