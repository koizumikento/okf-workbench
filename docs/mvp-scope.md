# MVP scope

## Core workflow

The MVP must support one complete loop:

```text
initialize bundle
-> create concept
-> edit Markdown
-> validate
-> regenerate indexes
-> inspect in 3D
-> open and repair source
```

The editor extension and native `okf` CLI share the deterministic Rust OKF core. The extension
loads it as capability-free `wasm32-unknown-unknown` inside the Extension Host; the CLI links it
natively and owns only local-filesystem and terminal interaction.

## Workbench sidebar

The Activity Bar provides one **OKF Workbench** container with three native views:

- **Bundle** shows the session-selected root, concept count, conformance errors, actionable
  curation warnings, and orphan count.
- **Resources** presents concepts and reserved Markdown documents in a folder tree derived from
  canonical POSIX bundle paths. Selecting a document opens its current workspace URI.
- **Actions** exposes the authoring loop in order and launches the existing guarded commands.

The sidebar consumes the selected bundle runtime snapshot. It does not parse Markdown, create a
second file watcher, add folder concepts, or render another graph. **Open 3D Graph** continues to
open or reveal the editor Webview, where sufficient width and the existing security boundary are
available.

Bundle selection is session-local. Empty states guide users to open a workspace, initialize a
bundle, or select an existing bundle. In untrusted workspaces, resource inspection, validation, and
3D exploration remain available while authoring actions remain unavailable.

## Commands

### `OKF: Initialize Bundle`

Creates a bundle in a selected workspace folder.

Initial presets:

- Minimal
- Software Project
- Data & Analytics

Requirements:

- Apply immediately after the final input when every generated target is absent.
- Refuse the complete initialization when any target already exists; never overwrite it.
- Create a root `index.md` declaring `okf_version: "0.2"`.
- Continue to read and safely author existing bundles declaring `okf_version: "0.1"` without
  silently rewriting their version.
- Allow users to change the suggested bundle directory.

### `OKF: New Concept`

Creates a concept file from a template.

Initial templates:

- Generic Concept
- Decision
- Metric
- API Endpoint
- Data Table
- Playbook
- Reference
- Attested Computation

Requirements:

- Prompt for destination, type, title, description, tags, and filename.
- Permit arbitrary `type` values.
- Prevent paths from escaping the selected bundle.
- Detect filename collisions before writing.
- Open the generated Markdown after creation.

### `OKF: Validate Bundle`

Reports actionable source diagnostics through the VS Code Problems panel. Orphan concepts remain
part of validation and graph state but do not decorate valid Markdown in the editor.

Conformance errors:

- Invalid or missing YAML frontmatter on a concept.
- Missing or empty `type`.
- Invalid reserved `index.md` or `log.md` structure.
- Invalid UTF-8 input that cannot be consumed.

Curation warnings:

- Broken internal link.
- Missing recommended title or description.
- Invalid or suspicious generation or verification metadata, including a legacy timestamp fallback.
- Invalid lifecycle, provenance, staleness, or Attested Computation metadata.
- Duplicate resource identifier.

The validation completion summary reports the orphan count separately, and the 3D graph provides
the detailed orphan indicators.

Unknown types and additional frontmatter fields are not errors.

### `OKF: Regenerate Indexes`

Synthesizes directory index entries from concept metadata.

Requirements:

- Apply without preview when every proposed index is a new file; preview the complete diff and
  require explicit approval when any existing index would be updated.
- Support "missing indexes only" and "update all" modes.
- Preserve content outside an explicitly managed region, or refuse to update when safe merging is not possible.
- Use each concept's title and description when present.

### `OKF: Migrate Bundle to v0.2`

Builds an optional, deterministic v0.1-to-v0.2 proposal.

Requirements:

- Require an explicit producer actor; never infer identity or run automatically.
- Convert a valid legacy `timestamp` only when `generated` is absent.
- Preserve unknown frontmatter and all Markdown body content.
- Convert only unambiguous URL bullets under `# Citations`; retain Citations and report ambiguous
  documents for manual follow-up.
- Preview the complete existing-file proposal and update the root version in the same guarded plan.
- Produce no changes on a second run and never invent Attested Computation or verification claims.

### `OKF: Open 3D Graph`

Displays a read-only interactive graph in an editor Webview.

Requirements:

- Represent concepts as nodes and internal Markdown links as directed edges.
- Treat link edges as untyped relationships.
- Color nodes by `type`, with a stable fallback for unknown values.
- Search by concept ID, title, and tags.
- Filter by type, tag, and a folder subtree derived from canonical concept paths.
- Show a collapsible folder tree with recursive concept counts and a clickable folder breadcrumb
  for the selected concept. Root-level concepts appear under `Bundle root`.
- Optionally group the 3D layout by folder without creating folder concepts, semantic edges, or
  source changes.
- Highlight broken links and orphan concepts.
- Show metadata, outgoing links, and backlinks for the selected node.
- Navigate the camera with mouse and trackpad rotation, pan, and zoom gestures.
- Provide visible zoom, fit, selected-node focus, reset, and interaction-help controls with
  keyboard equivalents.
- Open source Markdown from a node action.
- Refresh incrementally after create, change, delete, and rename events.

### `OKF: Set Up Agent Integration`

Generates project-local guidance for external coding agents.

Requirements:

- Offer `AGENTS.md`, Agent Skill, or both.
- Insert the actual bundle path into generated instructions.
- Apply without preview when every output is a new file; preview the complete proposal when any
  output updates or replaces an existing file.
- Never replace unrelated instructions in an existing `AGENTS.md`.
- Generate a portable `.agents/skills/maintain-okf-knowledge/SKILL.md`.
- Prefer the native CLI for safe local validation and planned writes when available, without making
  it a requirement for provider-backed or CLI-free environments.

### Pending change recovery

Create-only proposals do not open a preview. Every authoring preview for an existing-file change
that is awaiting Apply or Cancel must remain recoverable when its modeless notification is hidden:

- Show an `OKF changes awaiting review` status-bar action while the decision is pending.
- Expose `OKF: Review Pending Changes` only while a proposal is pending.
- Reveal the exact existing summary and issue a fresh Apply/Cancel choice without rebuilding the
  proposal.
- Offer Review or Cancel when another write command is refused as busy.
- Ignore late results from superseded confirmation attempts and write nothing after cancellation.

### Native `okf` CLI

Provides `init`, `new`, `validate`, `index`, `graph`, `agent`, `migrate`, and `version` for local automation.

Requirements:

- Use the same parser, validator, graph, index, template, migration, and agent generation crate as the
  extension.
- Keep validation and graph commands read-only.
- Require `--apply` for supported non-interactive writes; keep `--check` strictly non-mutating and
  make `migrate` an explicit preview-only `--check` command while native existing-file replacement
  remains outside FR-104.
- Refuse path escapes, symbolic-link traversal, collisions, and malformed managed regions.
- Emit versioned JSON for machine-readable validation and graph output.
- Ship identical native bytes both in supported target-platform VSIX packages and standalone
  archives; retain a CLI-free universal VSIX for unsupported targets.
- Expose the bundled executable only to new integrated terminals, preserve an existing `okf`
  earlier in `PATH`, and never modify an external shell profile.

## Acceptance criteria

- All core commands work without an account or network connection.
- A minimal generated bundle passes the extension's conformance validator.
- File changes update diagnostics and the graph without reloading the extension host.
- Diagnostics point to a specific file and useful source range where possible.
- The graph can open the source file for any valid concept node.
- The sidebar can select a bundle, browse nested Markdown resources, open source, run validation,
  and launch the existing 3D graph without duplicating core or Webview behavior.
- Existing unknown frontmatter fields are preserved by supported write operations.
- VSCodium desktop is included in MVP compatibility testing.

## Explicitly out of scope

- LLM API integration or built-in chat.
- Automatic semantic relationship inference.
- Cloud synchronization or publishing.
- PDF, Word, website, or database ingestion.
- Collaborative editing.
- Editing concept content by dragging graph nodes.
- Git-history animation.
- A fully programmable template language.
- Guaranteed support for very large graphs before performance testing.
