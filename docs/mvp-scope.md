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

## Commands

### `OKF: Initialize Bundle`

Creates a bundle in a selected workspace folder.

Initial presets:

- Minimal
- Software Project
- Data & Analytics

Requirements:

- Show the target path and generated files before writing.
- Never overwrite existing files without explicit confirmation.
- Create a root `index.md` declaring `okf_version: "0.1"`.
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

Requirements:

- Prompt for destination, type, title, description, tags, and filename.
- Permit arbitrary `type` values.
- Prevent paths from escaping the selected bundle.
- Detect filename collisions before writing.
- Open the generated Markdown after creation.

### `OKF: Validate Bundle`

Reports diagnostics through the VS Code Problems panel.

Conformance errors:

- Invalid or missing YAML frontmatter on a concept.
- Missing or empty `type`.
- Invalid reserved `index.md` or `log.md` structure.
- Invalid UTF-8 input that cannot be consumed.

Curation warnings:

- Broken internal link.
- Orphan concept.
- Missing recommended title or description.
- Invalid or suspicious timestamp.
- Duplicate resource identifier.

Unknown types and additional frontmatter fields are not errors.

### `OKF: Regenerate Indexes`

Synthesizes directory index entries from concept metadata.

Requirements:

- Preview the diff before applying it.
- Support "missing indexes only" and "update all" modes.
- Preserve content outside an explicitly managed region, or refuse to update when safe merging is not possible.
- Use each concept's title and description when present.

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
- Preview changes.
- Never replace unrelated instructions in an existing `AGENTS.md`.
- Generate a portable `.agents/skills/maintain-okf-knowledge/SKILL.md`.

## Acceptance criteria

- All core commands work without an account or network connection.
- A minimal generated bundle passes the extension's conformance validator.
- File changes update diagnostics and the graph without reloading the extension host.
- Diagnostics point to a specific file and useful source range where possible.
- The graph can open the source file for any valid concept node.
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
