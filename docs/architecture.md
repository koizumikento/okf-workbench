# Architecture

## Goals

- Share one interpretation of OKF across validation, indexing, templates, and visualization.
- Keep core behavior deterministic and independent of VS Code APIs.
- Support local, remote, and virtual workspace URIs where practical.
- Keep bundle contents inside the workspace and Webview boundary.
- Make graph rendering replaceable without rewriting OKF parsing.

## Proposed structure

```text
src/
├── core/
│   ├── model/
│   ├── parser/
│   ├── validation/
│   ├── graph/
│   ├── indexes/
│   └── templates/
├── extension/
│   ├── commands/
│   ├── diagnostics/
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
```

The accepted runtime, build, test, and packaging baseline is documented in [Implementation environment](implementation-environment.md) and [ADR 0004](decisions/0004-use-npm-typescript-esbuild-toolchain.md). The repository remains one npm package with separate esbuild outputs for the Node extension host and browser Webview.

## Implementation baseline

- Desktop-only VS Code-compatible extension for the MVP; no Web extension entry point.
- VS Code API floor `^1.121.0`, covering the current VSCodium stable line at the decision date.
- Node.js 24 LTS and npm for development and CI.
- TypeScript 6 with strict checking.
- Node 22/CommonJS extension bundle and ES2022/ESM Webview bundle produced by esbuild.
- Plain TypeScript and DOM UI with no React or state-management framework.
- Vitest, VS Code Test CLI, Playwright Webview harness, and packaged-editor smoke tests at distinct layers.

## Core model

```ts
interface Concept {
  id: string;
  uri: string;
  type: string;
  title?: string;
  description?: string;
  resource?: string;
  tags: string[];
  timestamp?: string;
  frontmatter: Record<string, unknown>;
  body: string;
  links: ConceptLink[];
}

interface ConceptLink {
  sourceId: string;
  targetId?: string;
  rawTarget: string;
  range?: SourceRange;
  external: boolean;
  broken: boolean;
}
```

Unknown frontmatter is retained in `frontmatter`. The normalized fields are conveniences, not a closed schema.

## Data flow

```text
workspace URIs
-> Markdown/YAML parser
-> normalized bundle model
-> validator + graph builder + index generator
-> extension messages
-> Webview graph and details panel
```

### Initial load

1. Resolve an explicit or detected bundle root.
2. Enumerate Markdown through `vscode.workspace.fs` and workspace search APIs.
3. Parse frontmatter and Markdown links.
4. Resolve concept IDs and internal targets.
5. Produce diagnostics and a serializable graph payload.

### Incremental update

1. Listen for create, change, delete, and rename events.
2. Debounce related file events.
3. Reparse changed concepts.
4. Recompute affected outgoing links, backlinks, and diagnostics.
5. Send a graph patch or replacement payload to the Webview.

The first implementation may replace the full graph payload if profiling shows it is sufficiently fast. Incremental rendering is a performance optimization, not a correctness requirement.

## VS Code integration

- Use commands and Explorer context menus as the primary entry points.
- Use `DiagnosticCollection` for conformance and curation findings.
- Use an editor Webview for the 3D graph.
- Use `vscode.workspace.fs` rather than Node `fs` for workspace content when possible.
- Treat all workspace resources as URIs; do not assume the `file:` scheme.

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

The initial renderer is the standalone `3d-force-graph` package behind a repository-owned adapter, as recorded in [ADR 0003](decisions/0003-use-3d-force-graph.md). Local bundling, license compatibility, WebGL behavior in Electron, accessibility hooks, and performance under representative fixtures remain implementation and verification requirements.

## Performance targets

Provisional prototype targets:

- 1,000 concepts and 5,000 internal edges remain interactively navigable on a typical developer laptop.
- Opening the graph does not block normal text editing.
- File changes are reflected within one second after debounce for representative bundles.

These numbers are hypotheses and must not be documented as achieved until benchmarked.

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
- Workspace file creation and diagnostics.
- Watcher-driven updates.
- Webview message validation.
- Source navigation from diagnostics and graph nodes.

### Webview browser tests

- Search, filter, details, and keyboard navigation in a standalone harness.
- Actual WebGL graph smoke in Chromium.
- CSP-compatible local bundle loading.

Playwright browser results are not used as Electron Webview performance evidence. Performance targets require a headed VS Code or VSCodium benchmark with the environment recorded.
