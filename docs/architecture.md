# Architecture

## Goals

- Share one interpretation of OKF across validation, indexing, templates, and visualization.
- Keep core behavior deterministic and independent of VS Code APIs.
- Support local, remote, and virtual workspace URIs where practical.
- Keep bundle contents inside the workspace and Webview boundary.
- Make graph rendering replaceable without rewriting OKF parsing.

## Structure

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

The accepted runtime, build, test, and packaging baseline is documented in [Implementation environment](implementation-environment.md) and [ADR 0004](decisions/0004-use-npm-typescript-esbuild-toolchain.md). The repository is one npm package with separate esbuild outputs for the Node extension host and browser Webview. Phase 0 implements these boundaries as a minimal extension and Webview shell; feature modules are added only with their owning behavior.

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
  kind: 'concept';
  id: string;
  source: SourceDocument;
  frontmatter: ParsedFrontmatter;
  type: string;
  title?: string;
  description?: string;
  resource?: string;
  tags: readonly string[];
  timestamp?: string;
  body: string;
  bodyRange: SourceRange;
  links: readonly ConceptLink[];
}

interface ConceptLink {
  sourceId: string;
  rawTarget: string;
  label: string;
  classification: LinkClassification;
  range: SourceRange;
  targetId?: string;
  fragment?: string;
  query?: string;
}
```

`ParsedFrontmatter.raw` retains the complete JSON-safe producer map, including unknown fields.
Explicit standard YAML tags are represented by the reserved `$okf-workbench:yaml-tag` object with
their canonical tag name, JSON-safe semantic value, and original lexical value source. In
particular, YAML timestamps, binary data, and sets never leak `Date`, `Buffer`, or `Set` instances
into the model. The exact frontmatter source remains separately available for source-preserving
writes. Null-prototype mappings and a closed standard-tag converter prevent prototype pollution and
fail closed on custom runtime objects. The normalized fields are conveniences, not a closed schema.
Link state is represented by the explicit `LinkClassification` union rather than overlapping
boolean flags.

When decoding, frontmatter parsing, or Markdown parsing fails for a non-reserved document, the
bundle model still contains a partial `Concept`. It retains the canonical ID and complete
`SourceDocument` identity (URI, bundle path, and content hash), while frontmatter, type, tags, body,
and links use JSON-safe empty sentinels. The accompanying source-scoped `ParseFailure` is the
authoritative diagnostic; validators suppress derivative metadata and orphan findings for that
partial concept. Other concepts can still resolve links to its stable identity, so graph cardinality
and source-repair navigation do not change merely because one file is temporarily malformed.

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

1. Resolve an explicit or detected bundle root. Automatic discovery streams exact-name `index.md`
   candidates, skips known VCS/dependency/generated trees, and records an unreadable subtree while
   continuing with its siblings.
2. Stream Markdown through the URI-first workspace port. Provider-reported relative path segments
   retain their verbatim identity; they never re-enter the percent-decoding path used to validate
   user-entered write targets. An unreadable document or child subtree becomes a path- and
   URI-scoped conformance finding while readable siblings continue through parsing, validation, and
   graph construction. Failure to enumerate the selected root itself remains fatal for that refresh.
3. Parse frontmatter and Markdown links. Every enumerated in-bundle non-reserved input contributes
   a concept identity; decode or parse failure yields a safe partial concept plus a precise failure.
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
- Keep provider path identity and user-input normalization as separate APIs. A literal provider
  filename such as `encoded%2Fsegment.md` must not alias `encoded/segment.md`, while encoded
  traversal in user input remains rejected.
- Resolve proposal targets from an explicit write root. Before the first change, inspect that root
  and every existing parent segment through the URI-first workspace port. A symbolic link, ordinary
  file, or unknown resource in any ancestor refuses the complete proposal, preventing logical URI
  containment from becoming an external filesystem write through a `file:` symlink. Initialization
  uses the selected workspace target as its write root so would-be bundle-directory ancestors are
  included; virtual providers remain supported through their `stat` result rather than Node paths.

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

The renderer is the standalone `3d-force-graph` package behind a repository-owned adapter, as recorded in [ADR 0003](decisions/0003-use-3d-force-graph.md). It is locally bundled, exposes an accessible non-spatial navigation surface, stops its animation loop after cooldown, and uses the `d3` engine selected by strict schema-v2 headed evidence for the exact measured production bundles. Dependency licensing and packaged notices are reviewed separately from the project-license gate. Any renderer or candidate-bundle change invalidates that evidence binding and requires a new evaluation.

## Performance targets

Accepted MVP thresholds:

- 1,000 concepts and 5,000 internal edges remain interactively navigable on a typical developer laptop.
- Opening the graph does not block normal text editing.
- File changes are reflected within one second after debounce for representative bundles.

The retained schema-v2 run on Mac16,7 / Apple M4 Pro / VS Code 1.127.0 passes QR-002 at 703 ms p95
over 20 create/change/rename/delete samples correlated across current Problems diagnostics and graph
publication. The same candidate passes QR-003 with `d3`; `ngraph` failed the cooldown requirement
after 120,000.3 ms. See [performance evidence](performance-evidence.md) for the raw samples, exact
bundle hashes, environment, authority rules, and candidate-binding limits. These measurements do
not establish a cross-machine guarantee.

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
