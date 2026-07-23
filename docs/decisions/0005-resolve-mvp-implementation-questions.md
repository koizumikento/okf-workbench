# 0005 — Resolve the MVP implementation questions

- Status: Accepted
- Date: 2026-07-22
- Applies to: OQ-001 through OQ-008 in the approved functional requirements

## Context

The approved MVP requirements intentionally left eight implementation details open. The affected Linear issues cannot be completed reproducibly until bundle selection, generated content, merge markers, timestamp analysis, command identifiers, broken-link presentation, compatibility coverage, and performance thresholds have deterministic answers.

The upstream format authority used for these decisions is [OKF v0.1 at `ee67a5ca27044ebe7c38385f5b6cffc2305a9c1a`](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/ee67a5ca27044ebe7c38385f5b6cffc2305a9c1a/okf/SPEC.md).

## Decisions

### OQ-001 — Bundle selection and switching

- A bundle candidate is a directory containing a root `index.md` with `okf_version`, or a directory explicitly selected by the user as an OKF bundle root.
- Commands reuse the current in-memory bundle selection while it remains inside an open workspace folder.
- One unambiguous candidate is selected automatically. Zero or multiple candidates produce a directory picker before the operation proceeds.
- Selecting a different directory replaces the session selection, disposes its watcher and cache, and starts a new monotonic revision sequence.
- The MVP does not persist a selection outside the editor session and does not add a seventh public command solely for switching. Invoking a bundle-sensitive command from an Explorer directory supplies an explicit replacement root; successful selection replaces the current session context. Command-palette flows still prompt when automatic discovery is absent or ambiguous.
- Automatic discovery accepts only parseable root `index.md` declarations containing a semantic string `okf_version`. A user-explicit directory remains a candidate when its root index is missing, unreadable, versionless, or malformed, so validation and graph inspection can expose the underlying conformance state. A missing index or absent declaration is synthesizable and does not by itself block writes; index regeneration creates `okf_version: "0.1"` while preserving an existing root's human body and unrelated frontmatter source and safely merging its managed region. In `missing indexes only` mode, this declaration repair is the sole permitted update to an existing index. An unreadable or malformed index, an invalid declared value, and a declared unsupported major version fail closed before planning and are rechecked after approval and content preflight immediately before existing-bundle writes are applied.
- Initialization selects the newly created bundle after a successful apply.

### OQ-002 — Built-in bundle presets

All files are UTF-8 with LF newlines. Root `index.md` may contain the OKF version frontmatter exception defined by the upstream specification.

| Preset | Generated files |
| --- | --- |
| Minimal | `index.md` |
| Software Project | `index.md`, `project-overview.md`, `architecture/index.md`, `architecture/system-overview.md`, `decisions/index.md`, `decisions/initial-context.md`, `playbooks/index.md`, `playbooks/development.md` |
| Data & Analytics | `index.md`, `data-landscape.md`, `datasets/index.md`, `datasets/example-dataset.md`, `metrics/index.md`, `metrics/example-metric.md`, `playbooks/index.md`, `playbooks/data-quality.md` |

Directory indexes contain only their generated managed region. Preset concepts use descriptive starter content and conventional types, but remain ordinary concepts that the user can replace or extend. Rendering is deterministic and accepts an injected timestamp rather than reading the clock internally.

### OQ-003 — Managed index syntax and entries

Workbench owns only the content between exactly one pair of these markers:

```markdown
<!-- okf-workbench:index:start -->
## Contents

- [Concept title](./concept.md) - Optional description
- [Directory name](./directory/)
<!-- okf-workbench:index:end -->
```

- Marker matching is exact after splitting CR, LF, or CRLF line endings; updates retain the existing document's line-ending style.
- Missing markers may be appended after the existing content in `update all` mode, following preview.
- One complete pair may be replaced.
- Nested, reversed, incomplete, or duplicate markers are refused.
- Entries use paths relative to the containing index, POSIX separators, percent-encoded URL path segments, stable concept-before-directory ordering, and a final LF newline.
- Missing titles fall back to the filename stem. Missing descriptions omit the separator and description.

### OQ-004 — Suspicious timestamps and duplicate resources

- A present timestamp must be an ISO 8601 date-time with an explicit `Z` or numeric offset.
- An unparseable timestamp, a date without a time zone, or a timestamp more than five minutes after an injected reference time is a curation warning.
- Age alone is not suspicious; the MVP does not guess that old knowledge is stale.
- Duplicate `resource` findings compare trimmed, non-empty resource strings exactly and case-sensitively. URI schemes and hosts are not rewritten because producer identifiers may have case-sensitive components.

### OQ-005 — Stable commands and defaults

The six stable command identifiers are:

| Command ID | User-visible title |
| --- | --- |
| `okfWorkbench.initializeBundle` | `OKF: Initialize Bundle` |
| `okfWorkbench.newConcept` | `OKF: New Concept` |
| `okfWorkbench.validateBundle` | `OKF: Validate Bundle` |
| `okfWorkbench.regenerateIndexes` | `OKF: Regenerate Indexes` |
| `okfWorkbench.openGraph` | `OKF: Open 3D Graph` |
| `okfWorkbench.setupAgentIntegration` | `OKF: Set Up Agent Integration` |

They appear in the Command Palette. Workspace-sensitive Explorer context entries are gated by an open workspace folder. The graph is an editor Webview panel, not a persistent activity-bar view. File-event bursts use a fixed 250 ms debounce in the MVP. No user setting is added until a real need is demonstrated, which keeps configuration from becoming an untested second behavior surface.

### OQ-006 — Broken links in the graph

Broken links never become graph nodes or valid edges. Each source node exposes a warning badge and a non-spatial details list containing the safe link label, raw target, and source range. The initial 3D canvas does not render placeholder nodes. This keeps concept and relationship counts format-faithful while still making broken links discoverable.

Additional graph rules:

- One resolvable Markdown link occurrence produces one stable directed edge; its source range distinguishes repeated links.
- Backlink navigation groups occurrences by source concept without inventing a relationship type.
- A concept is an orphan when it has no resolvable incoming or outgoing internal link occurrence.
- External, directory, fragment-only, and out-of-bundle links do not become graph edges.
- Search normalizes user input and ID/title/tag values with Unicode NFKC and locale-independent lowercase matching.
- Unknown types use an FNV-1a hash into the checked-in color palette, producing a stable fallback without a closed type registry.

### OQ-007 — Compatibility matrix

- Manifest/API floor: VS Code 1.121.0.
- Current-stable lane: the stable VS Code release recorded by each release candidate; 1.127.0 at this decision date.
- Compatible-editor lane: VSCodium 1.121.03429 at this decision date.
- Primary automation: Ubuntu 24.04.
- Release smoke: the current supported GitHub-hosted macOS and Windows images, with exact image metadata retained.
- Development and CI tooling: Node.js 24.18.0 and npm 11.16.0.
- Electron, Chromium, GPU, OS, and editor build versions are evidence fields, not inferred compatibility claims.

Implementation note (2026-07-22): `1.127.0` above is the decision-date snapshot, not a permanent
pin. The current release-candidate workflow refreshes the current-stable lane to VS Code `1.129.1`;
the recorded schema-v3 VS Code `1.127.0` headed run is a superseded historical record bound to its
recorded identities and does not qualify the current performance contract or current compatibility
candidate.

### OQ-008 — Performance fixtures and thresholds

Checked-in deterministic generators produce 100-node/500-edge, 1,000-node/5,000-edge, and larger stress payloads.

On recorded release-test hardware:

- QR-002 passes when 20 representative one-file update samples publish current diagnostics and a replacement graph within 1,000 ms at p95, including the 250 ms debounce.
- QR-003 passes when the 1,000-node/5,000-edge graph produces an interactive frame within 5,000 ms; search, filtering, selection, and non-spatial navigation complete within 100 ms at p95; and the simulation reaches its configured cooldown without continuing an idle animation loop.
- Memory, idle CPU, camera frame rate, GPU, editor, Electron, OS, fixture seed, and package versions are recorded but do not receive invented cross-machine guarantees.
- `d3` and `ngraph` are compared with the same payload and settings. The release default is chosen from measured editor evidence and documented without changing the renderer boundary.

## Link-resolution clarifications

- A concept target must resolve to a `.md` concept file. Query and fragment components are preserved for presentation but removed for concept lookup.
- A fragment-only link is document navigation and does not create a graph self-edge.
- URL path segments are percent-decoded once for lookup. Invalid encoding is reported as a curation warning.
- Dot segments and separators are normalized before containment checks. Any resolved target outside the bundle is classified as out-of-bundle and is never read.
- Backslashes supplied by filesystem-neutral fixture paths normalize to POSIX separators for concept IDs; Markdown URLs continue to use `/`.
- Symlinks and provider-specific aliases are not traversed by the core. The privileged workspace adapter supplies enumerated URIs and rejects generated paths outside the selected logical root. Before the first proposal write it also stats the write root and every existing intermediate segment, refusing the complete proposal when any segment is a symbolic link or is not a directory. Initialization anchors this check at the selected workspace target so a symlink above the would-be bundle root cannot redirect generated files.

## Consequences

Positive:

- Every previously open MVP question now has a deterministic implementation and test target.
- Broken links and unknown types remain permissive without corrupting graph semantics.
- Managed writes have exact refusal conditions and idempotent output.
- Performance claims can be recorded as pass/fail evidence rather than vague impressions.

Costs:

- Session-only bundle selection may prompt again after an editor restart.
- The fixed preset contents and managed marker syntax become compatibility surfaces.
- Performance completion still requires headed editor evidence on recorded hardware.
- A publisher namespace and actual Open VSX publication remain release-candidate decisions that require maintainer approval.
