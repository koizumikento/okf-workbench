# Product brief

## Summary

OKF Workbench is a local-first VS Code-compatible extension for creating, maintaining, validating, and visually exploring Open Knowledge Format bundles.

The product is intentionally broader than a 3D graph viewer. A viewer only helps teams that already have a healthy bundle. OKF Workbench is intended to help a user move from an empty folder to an actively maintained knowledge graph without leaving the editor.

## Target users

Primary users:

- Developers maintaining project knowledge alongside source code.
- Data and analytics engineers documenting datasets, tables, metrics, and playbooks.
- Teams experimenting with agent-readable, Git-managed knowledge bases.

Secondary users:

- Technical writers working with Markdown-based knowledge repositories.
- Maintainers reviewing bundle structure, broken links, and stale concepts.

## User problem

OKF is deliberately a minimal file format. That makes it portable, but leaves common workflow needs to consumers and authoring tools:

- A new user must understand the bundle structure before creating anything.
- Repeating YAML frontmatter by hand is error-prone.
- A file tree does not expose hubs, orphans, backlinks, or cross-directory clusters.
- Conformance errors and curation problems are different but easy to conflate.
- Existing browser or CLI tools interrupt the edit-and-repair loop.

## Value proposition

> Start an OKF bundle, keep it healthy, and understand its structure without leaving the editor.

The main differentiator is the short path from discovery to repair:

```text
find an orphan or broken link
-> inspect its context
-> open the source Markdown
-> edit and save
-> see diagnostics and graph update
```

## Positioning

OKF Workbench should be positioned as an editor-native workbench, not as:

- A hosted knowledge platform.
- A graph database.
- An AI memory service.
- A replacement for Markdown editors.
- A generic file-template extension.

## Product principles

### Local first

Parsing, validation, indexing, and visualization run locally. The MVP has no telemetry, hosted account, LLM request, or content upload.

### Source is primary

Markdown remains the source of truth. The graph is a derived view and must never hide or replace the underlying files.

### Permissive consumption

The extension must tolerate unknown types, extra frontmatter fields, missing optional metadata, and broken links in accordance with OKF v0.1.

### Safe generation

Create-only generation applies without an extra confirmation only when every target is absent and
the workspace adapter can enforce no-overwrite creation. Any proposal that may update or replace an
existing file is previewable and requires explicit approval. Existing user content is never
silently overwritten. Re-running a generator should be idempotent wherever practical.

### Useful without AI

All core features are deterministic. AI integration consists only of portable instruction templates for external agents.

## Success indicators

Initial validation targets:

- A new user can create a valid first bundle and concept in under two minutes.
- A concept created from a template appears in the graph without manually reloading the window.
- A user can navigate from a diagnostic or graph node to the relevant Markdown file.
- Unknown types and custom frontmatter survive parsing and any supported round trip.
- The extension can operate without network access.

These are product hypotheses until measured in prototypes or user tests.
