# Functional requirements

- Status: Draft for review
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
| FR-001 | Workbench MUST resolve a bundle root by unambiguous detection or explicit user selection. | When detection is ambiguous or no bundle is found, the user can select the target directory before a bundle operation runs. |
| FR-002 | `OKF: Initialize Bundle` MUST let the user choose the workspace target, suggested bundle directory, and preset. | The confirmation UI identifies all three values before writing. |
| FR-003 | Initialization MUST provide the `Minimal`, `Software Project`, and `Data & Analytics` presets. | Each preset can be selected and produces its documented file set. |
| FR-004 | Initialization MUST show the target path and complete generated-file list before writing. | Canceling the preview creates or changes no workspace file. |
| FR-005 | A generated bundle MUST contain a UTF-8 root `index.md` declaring `okf_version: "0.1"`. | The generated minimal bundle passes the Workbench conformance validator. |
| FR-006 | Initialization MUST detect every target-path collision before writing. | No existing file is replaced unless the user explicitly approves that replacement after previewing it. |
| FR-007 | Generated paths MUST remain inside the selected bundle root. | Absolute paths, parent traversal, and equivalent encoded or normalized escapes are rejected with an actionable message. |

### 2. Concept creation

| ID | Requirement | Acceptance condition |
| --- | --- | --- |
| FR-010 | `OKF: New Concept` MUST offer `Generic Concept`, `Decision`, `Metric`, `API Endpoint`, `Data Table`, `Playbook`, and `Reference` templates. | Each listed template can generate a concept with valid YAML frontmatter. |
| FR-011 | Concept creation MUST collect destination, type, title, description, tags, and filename. | The proposed output path and frontmatter reflect the submitted values. |
| FR-012 | Concept creation MUST accept any non-empty `type`; built-in templates MUST NOT form a closed type enumeration. | A custom type such as `experiment-result` can be created and validated without an unknown-type error. |
| FR-013 | Concept creation MUST reject output paths outside the selected bundle and detect filename collisions before writing. | Rejected input leaves the workspace unchanged and identifies the conflicting or invalid path. |
| FR-014 | A successfully created concept MUST open in the editor. | The newly created URI becomes the active or visible editor document. |
| FR-015 | A generated concept MUST be visible to validation and graph indexing without reloading the extension host. | The file watcher processes the new file and refreshes affected derived state. |

### 3. Bundle parsing and graph construction

| ID | Requirement | Acceptance condition |
| --- | --- | --- |
| FR-020 | The parser MUST treat every non-reserved `.md` file beneath the bundle root as a concept and every `index.md` or `log.md` as reserved. | Nested fixtures produce the expected concept and reserved-document sets. |
| FR-021 | The parser MUST derive concept IDs from bundle-relative paths without `.md`, normalized to POSIX `/` separators. | Equivalent Windows and POSIX fixture paths produce the same concept ID. |
| FR-022 | The parser MUST retain the complete frontmatter map while exposing normalized known fields. | Unknown fields survive every supported parse-and-write round trip unchanged. |
| FR-023 | The link resolver MUST resolve `/`-prefixed links from the bundle root and relative links from the source document directory. | Bundle-relative, document-relative, nested, spaced, and Unicode fixtures resolve to the expected target IDs. |
| FR-024 | The link resolver MUST distinguish resolvable internal, broken internal, external, and out-of-bundle targets. | Each target category produces the expected graph inclusion and diagnostic behavior without crashing parsing. |
| FR-025 | Internal Markdown links MUST produce directed, untyped graph relationships. | A link from A to B produces an A-to-B relationship and does not infer a semantic edge type from surrounding prose. |
| FR-026 | Parsing failures MUST be represented as diagnostics or operation results rather than uncaught errors. | Invalid YAML and unreadable content do not terminate processing of unrelated bundle files. |

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

### 7. Agent integration templates

| ID | Requirement | Acceptance condition |
| --- | --- | --- |
| FR-070 | `OKF: Set Up Agent Integration` MUST offer `AGENTS.md`, Agent Skill, or both. | The preview contains only the selected outputs. |
| FR-071 | Generated instructions MUST contain the actual selected bundle path. | No placeholder path remains in the proposed output. |
| FR-072 | Every new or changed agent-integration file MUST be previewed before writing. | Canceling the preview leaves all files unchanged. |
| FR-073 | Workbench MUST append or update exactly one marker-delimited managed section in an existing `AGENTS.md`. | Unrelated instructions are preserved, and re-running generation updates only the managed section. |
| FR-074 | Workbench MUST refuse automatic `AGENTS.md` modification when markers are malformed or duplicated. | The user receives repair guidance and the file remains unchanged. |
| FR-075 | The default Agent Skill output MUST be `.agents/skills/maintain-okf-knowledge/SKILL.md`. | Generation creates a Skill with valid frontmatter and the documented maintenance workflow. |
| FR-076 | An existing Agent Skill MUST NOT be replaced without an explicit preview and replacement confirmation. | The default action on collision is non-destructive. |
| FR-077 | Agent setup MUST generate instructions only; it MUST NOT invoke an agent, model, or external provider. | The complete setup flow performs no model request or provider authentication. |

### 8. Common file and workspace behavior

| ID | Requirement | Acceptance condition |
| --- | --- | --- |
| FR-080 | All core commands MUST operate without an account or network connection. | Initialize, create, validate, index, graph, and agent-template acceptance flows pass with network access disabled. |
| FR-081 | Any operation that may change an existing file MUST show a preview or diff and require explicit approval. | No supported command silently replaces existing user content. |
| FR-082 | Workspace access MUST support URI-based resources and MUST NOT require the selected workspace to use the `file:` scheme. | Core workspace flows pass against the supported remote or virtual workspace test harness. |
| FR-083 | File watching MUST cover create, change, delete, and rename events and debounce related bursts. | One logical edit burst results in current diagnostics and graph state without persistent duplicate processing. |
| FR-084 | User-facing failures MUST identify the affected operation and provide a corrective next step when one is known. | Expected parse, validation, collision, path, and merge failures do not expose only a raw stack trace. |

## Implementation constraints

These constraints support the functional behavior but do not add separate user features.

- The deterministic core remains independent of VS Code APIs.
- Parsing and graph construction remain outside Webview components.
- The initial renderer is the standalone `3d-force-graph` package behind a repository-owned adapter, as accepted in [ADR 0003](decisions/0003-use-3d-force-graph.md).
- Webview scripts and styles are bundled locally and protected by a restrictive Content Security Policy with a nonce.
- Messages crossing the extension/Webview boundary are validated.
- User-controlled Markdown and metadata are escaped or sanitized before rendering.
- Unknown frontmatter fields are preserved by supported write operations.

## Quality and compatibility targets

The following are release constraints or prototype targets, not claims about current implementation.

| ID | Target | Verification |
| --- | --- | --- |
| QR-001 | A user can create a valid first bundle and concept in under two minutes. | Timed first-use prototype test with the documented happy path. |
| QR-002 | File changes appear in diagnostics and graph state within one second after debounce for representative bundles. | Instrumented integration benchmark with documented hardware and fixture. |
| QR-003 | A graph containing 1,000 concepts and 5,000 internal edges remains interactively navigable on a typical developer laptop. | VS Code Webview benchmark; fixture, hardware, Electron version, and interaction threshold must be recorded. |
| QR-004 | VSCodium desktop is included in MVP compatibility testing. | Package installation and core acceptance scenarios pass on a documented VSCodium version. |
| QR-005 | Webview content meets the keyboard navigation behavior in FR-060 even when the 3D canvas itself is not accessible. | Keyboard-only acceptance test. |

QR-001 through QR-003 remain hypotheses until measured. No release documentation may present them as achieved before evidence is recorded.

## End-to-end acceptance scenarios

| ID | Scenario | Expected outcome |
| --- | --- | --- |
| AC-001 | First bundle | From an empty workspace, initialize the Minimal preset, create one concept, and validate. The bundle is conformant and the concept opens in the editor. |
| AC-002 | Permissive custom metadata | Load a concept with a custom type and unknown fields, perform a supported write operation, and reload it. The type remains valid and unknown fields are unchanged. |
| AC-003 | Diagnose and repair | Open a bundle with invalid frontmatter and a broken link, navigate from each Problem to source, repair and save. Findings clear after debounce without reloading. |
| AC-004 | Safe index regeneration | Regenerate indexes containing user-authored text and one valid managed region. The preview is accurate, only the managed region changes, and a second run has no diff. |
| AC-005 | Explore and navigate | Open the 3D graph, search and filter concepts, inspect backlinks, locate an orphan, and open source. The Markdown remains unchanged. |
| AC-006 | Live graph update | With the graph open, create, edit, rename, and delete concepts. The graph and details view converge to current workspace state without extension-host reload. |
| AC-007 | Safe agent setup | Add both integration outputs to a repository with an existing unrelated `AGENTS.md`. Preview and apply; unrelated content remains unchanged and a second run is idempotent. |
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

## Open requirements questions

These items must be decided before their affected implementation is considered complete.

| ID | Question | Affected area |
| --- | --- | --- |
| OQ-001 | How does the user select and switch among multiple bundle roots in one workspace? | Commands, state, file watching |
| OQ-002 | What exact files and initial concepts does each initialization preset contain? | Initialization, fixtures |
| OQ-003 | What marker syntax and generated entry format are used for managed `index.md` regions? | Index generation, merging |
| OQ-004 | What deterministic rules define a suspicious timestamp? | Curation validation |
| OQ-005 | What commands, views, and defaults are configurable, and what are their stable VS Code command IDs? | Extension manifest, settings |
| OQ-006 | How are broken links represented visually without confusing placeholders with concepts? | Graph adapter, accessibility |
| OQ-007 | Which VS Code, VSCodium, Electron, and operating-system versions form the MVP test matrix? | Compatibility, release |
| OQ-008 | What fixture and interaction thresholds define "interactively navigable" for QR-003? | Performance benchmark |

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

- [ ] Functional requirements reviewed and approved for MVP implementation.
