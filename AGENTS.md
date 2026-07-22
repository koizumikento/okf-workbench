# AGENTS.md

## Scope

These instructions apply to the entire `okf-workbench` repository.

## Mission

Build a local-first VS Code-compatible extension that helps users initialize, author, validate, index, and explore Open Knowledge Format bundles. The product is a workbench, not only a graph viewer.

The core workflow is:

```text
initialize -> create -> edit -> validate -> explore -> repair
```

## Current state

The repository is in product-definition and architecture-planning stage. Do not imply that commands, packages, benchmarks, or compatibility targets have already been implemented or achieved.

## Sources of truth

Use this order when requirements conflict:

1. The canonical [OKF v0.1 specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) for format behavior.
2. Accepted records under `docs/decisions/` for repository decisions.
3. `docs/okf-v0.1-contract.md` for the Workbench compatibility interpretation.
4. `docs/functional-requirements.md` for testable MVP behavior.
5. `docs/implementation-environment.md` for accepted runtime, tooling, dependency, test, and packaging choices.
6. `docs/mvp-scope.md` and `docs/architecture.md` for planned product and engineering scope.

When the upstream OKF specification changes, document the observed version or commit and review the compatibility contract before changing behavior.

## Non-negotiable product rules

- Keep core features local and deterministic.
- Do not add an AI provider, API key flow, hosted account, content upload, or telemetry without a new accepted decision.
- Treat Markdown as the source of truth and the graph as a derived read-only view in the MVP.
- Preserve unknown frontmatter fields during supported write operations.
- Permit arbitrary non-empty concept `type` values.
- Treat internal Markdown links as directed, untyped relationships.
- Treat broken links as curation warnings, not OKF v0.1 conformance errors.
- Never silently overwrite an existing user file.
- Preview generated or merged content when an operation may change an existing file.

## Planned module boundaries

Keep the deterministic OKF core independent of VS Code APIs:

- `core/parser`: frontmatter, Markdown, concepts, and links.
- `core/validation`: conformance errors and curation findings.
- `core/graph`: serializable nodes, edges, backlinks, and statistics.
- `core/indexes`: index synthesis and safe managed-region merging.
- `core/templates`: bundle, concept, and agent template rendering.
- `extension`: commands, diagnostics, workspace access, and Webview lifecycle.
- `webview`: 3D presentation and interaction only.

Do not put canonical parsing or validation logic inside Webview components.

## Workspace and path rules

- Prefer `vscode.workspace.fs` and URI-based APIs over Node `fs` for workspace content.
- Do not assume a workspace URI uses the `file:` scheme.
- Normalize concept IDs with POSIX `/` separators regardless of host platform.
- Reject generated paths that escape the selected bundle root.
- Resolve both bundle-relative and document-relative Markdown links.
- Add fixtures for Windows separators, spaces, Unicode, and nested directories when path behavior changes.

## Webview rules

- Bundle scripts and styles locally; do not use a CDN.
- Apply a restrictive Content Security Policy with a nonce.
- Sanitize rendered Markdown and all user-controlled metadata.
- Validate extension-to-Webview and Webview-to-extension messages.
- Do not execute scripts contained in bundle content.
- Provide a searchable, keyboard-accessible non-spatial way to reach graph nodes.
- Keep graph rendering concerns separate from graph construction.

## Diagnostics

Maintain a visible distinction between:

- **Conformance errors:** the bundle violates the hard OKF v0.1 interoperability rules.
- **Curation warnings:** the bundle is consumable but may be incomplete, stale, duplicated, orphaned, or difficult to navigate.

Diagnostics should include the most precise useful URI and source range. Do not promote a recommendation to an error merely because the template generator prefers it.

## Generation and merge safety

- Make generation idempotent where practical.
- Detect collisions before writing.
- Preserve unrelated content in `index.md` and `AGENTS.md`.
- Update only explicit managed regions when merging generated sections.
- Refuse automatic merging when markers are malformed or duplicated.
- Show a preview or diff before replacing an existing generated Skill.
- Never delete generated files during extension uninstall.

## Coding conventions

These apply once implementation begins:

- Use TypeScript with strict type checking.
- Follow the single-package npm and esbuild baseline in `docs/implementation-environment.md`; do not add an overlapping package manager, bundler, or UI framework without an accepted decision.
- Keep public core types explicit and serializable.
- Avoid `any`; narrow `unknown` at parsing and message boundaries.
- Prefer small pure functions in the core.
- Represent expected parse and validation failures as data, not uncaught exceptions.
- Keep user-facing messages actionable and avoid exposing raw stack traces.
- Add dependencies only when their license and bundling behavior are understood.
- Do not introduce a framework solely for a small utility that can be implemented clearly in the repository.

Follow repository formatters and linters after they are established. Do not invent command names in documentation before adding the corresponding package script.

## Testing expectations

Every behavior change should be tested at the lowest useful level.

Required coverage areas include:

- Frontmatter parsing and unknown-field preservation.
- Concept ID and link resolution.
- Reserved `index.md` and `log.md` handling.
- Conformance versus curation severity.
- Safe index and instruction merging.
- Template path validation and collision handling.
- File watcher update behavior.
- Webview message validation and source navigation.

Use small checked-in fixtures. Never make unit tests depend on network access or an AI provider.

## Documentation workflow

- Update `docs/mvp-scope.md` when adding or removing an MVP feature.
- Update `docs/functional-requirements.md` when user-visible behavior or acceptance criteria change.
- Update `docs/implementation-environment.md` when runtime, tooling, dependencies, test layers, CI, or packaging assumptions change.
- Update `docs/okf-v0.1-contract.md` when compatibility behavior changes.
- Update `docs/architecture.md` when module boundaries or security assumptions change.
- Add a record under `docs/decisions/` for choices that constrain future implementation.
- Mark provisional performance numbers as targets until benchmarked.
- Prefer primary specification and API links.

## Agent workflow

Before changing the repository:

1. Read `docs/index.md` and the documents relevant to the request.
2. Inspect the current worktree and preserve unrelated user changes.
3. Identify whether the change affects the OKF contract, MVP scope, or an accepted decision.
4. Implement the smallest coherent change.
5. Run the relevant checks available in the repository.
6. Update documentation when behavior or scope changes.

Before declaring work complete, verify:

- No unknown OKF fields or types were accidentally rejected.
- No user content can be overwritten silently.
- No network or AI-provider dependency entered a core workflow.
- New Webview content is sanitized and covered by a restrictive CSP.
- Tests and documentation match the implemented behavior.
