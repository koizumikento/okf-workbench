# Roadmap

The roadmap describes sequencing, not committed dates.

## Phase 0 — Foundation

- Confirm product scope and compatibility contract.
- Create the repository and architecture decisions.
- Scaffold the accepted npm, TypeScript, and esbuild environment from ADR 0004.
- Establish CI for type checking, tests, packaging, and dependency review.
- Add representative OKF fixtures.

Exit gate: the repository can build, test, and package an empty extension reproducibly.

## Phase 1 — Deterministic core

- Parse bundles and concept frontmatter.
- Resolve bundle-relative and relative Markdown links.
- Validate OKF v0.2 conformance with guarded v0.1 fallback compatibility.
- Produce curation findings separately.
- Generate and safely merge index content.
- Render built-in bundle and concept templates.

Exit gate: fixtures cover the compatibility contract and unknown fields survive supported round trips.

## Phase 2 — Editor authoring workflow

- Detect or select a bundle root.
- Initialize a bundle.
- Create a concept from a template.
- Publish diagnostics to the Problems panel.
- Regenerate indexes with preview.
- Watch workspace changes.

Exit gate: a user can complete the initialize-to-repair workflow without leaving the editor.

## Phase 3 — 3D exploration

- Bundle the selected graph renderer behind the repository-owned adapter.
- Add graph search and filters.
- Add details, backlinks, and source navigation.
- Highlight orphans and broken links.
- Profile representative large fixtures.
- Add accessible non-spatial navigation for graph contents.

Exit gate: the graph is useful for navigation and diagnosis, not only visual demonstration.

## Phase 4 — Agent templates

- Generate an `AGENTS.md` managed section.
- Generate a project-local Agent Skill.
- Preview and safely merge changes.
- Test re-running generation against existing content.

Exit gate: generation is idempotent and never silently overwrites unrelated instructions.

## Phase 5 — Distribution

- Package a VSIX.
- Test supported VS Code and VSCodium versions.
- Review bundled dependency licenses.
- Add Webview CSP and security checks.
- Publish to Open VSX under the chosen publisher namespace.
- Decide separately whether to publish to the Microsoft Marketplace.

Exit gate: installation, upgrade, and uninstall behavior are verified from the published package.

## Later candidates

- Custom workspace concept templates.
- Two-dimensional or table-based graph fallback.
- Static HTML graph export.
- Link-aware concept rename and move refactoring.
- Git diff overlays.
- Selected-subgraph context export.
- Additional compatible bundle versions.

These candidates are not part of the MVP until validated by usage.
