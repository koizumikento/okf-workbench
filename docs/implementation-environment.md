# Implementation environment

- Status: Accepted baseline
- Date: 2026-07-22
- Applies to: MVP implementation

## Purpose

This document defines the concrete development, runtime, test, and packaging environment. The Phase 0 scaffold implements this baseline; later product behavior remains governed by its owning requirements and issues.

Exact dependency versions are committed in `package.json` and `package-lock.json`. Patch-level versions may advance through reviewed dependency updates. A change of package manager, bundler, UI framework, extension surface, or architectural boundary requires an explicit decision update.

## Application shape

OKF Workbench will be one desktop VS Code-compatible extension package with two runtime surfaces:

```text
VS Code / VSCodium desktop
├── Node extension host
│   ├── commands and diagnostics
│   ├── URI-first workspace adapter
│   └── deterministic OKF core
└── isolated editor Webview
    ├── graph adapter
    ├── details and non-spatial navigation
    └── 3d-force-graph / WebGL
```

The architecture is a layered modular monolith with ports at the workspace and Webview boundaries. There is no server, database, authentication system, cloud service, queue, background worker, or browser-extension entry point in the MVP.

The shipped trust boundaries are:

1. Workspace content entering the extension host.
2. Privileged filesystem and editor actions behind VS Code APIs.
3. Serializable messages crossing between the extension host and Webview.
4. Untrusted bundle metadata entering DOM or WebGL presentation.

## Runtime and compatibility baseline

| Concern | Baseline | Reason |
| --- | --- | --- |
| Primary surface | VS Code-compatible desktop extension | MVP requires VS Code and VSCodium desktop testing |
| VS Code API floor | `engines.vscode: ^1.121.0` | Covers the current VSCodium stable line while remaining compatible with newer VS Code releases |
| Development and CI Node | Node.js `24.18.0` LTS | Supported LTS, pinned for reproducible tooling |
| Package manager | npm `11.16.0` | Bundled with the pinned Node release; one tool and one lockfile |
| Extension-host output target | Node.js 22 / CommonJS | Matches the Node type baseline used by VS Code 1.121 and avoids requiring newer extension-host syntax |
| Webview output target | ES2022 browser module | Conservative target for the Electron/Chromium Webview matrix |
| Type checker | TypeScript `6.0.3` | Mature stable line; TypeScript 7 adoption is deferred until extension tooling compatibility is verified |
| VS Code compile-time types | `@types/vscode` `1.120.0` | Conservative ceiling because npm does not publish `1.121.0`; this does not claim exact type coverage for the `1.121.0` API floor |
| Minimum editor test | VS Code `1.121.0` | Matches the manifest API floor |
| Current editor test | VS Code `1.127.0` | Stable VS Code release at the decision date |
| VSCodium test | VSCodium `1.121.03429` | Stable VSCodium release at the decision date |

Node.js 26 is Current rather than LTS at the decision date, so it is not the development baseline. The extension must not include native Node add-ons; the VSIX should remain platform-independent.

References:

- [Node.js release status and schedule](https://nodejs.org/en/about/previous-releases)
- [Node.js 24.18.0 archive metadata](https://nodejs.org/en/download/archive/v24.18.0)
- [VS Code 1.127 release notes](https://code.visualstudio.com/updates/v1_127)
- [VS Code 1.121 source manifest](https://github.com/microsoft/vscode/blob/1.121.0/package.json)
- [VSCodium releases](https://github.com/VSCodium/vscodium/releases)

## Repository and package management

Use one npm package at the repository root. Do not introduce npm workspaces, a monorepo orchestrator, pnpm, Yarn, Bun, Nix, or a container requirement for the initial extension.

The Phase 0 scaffold includes:

- `.nvmrc` and `.node-version` pinned to `24.18.0`.
- `packageManager: "npm@11.16.0"` in `package.json`.
- `.npmrc` with exact dependency saving and engine enforcement.
- A committed `package-lock.json` generated with the pinned npm version.
- `engines.node` for development tooling and `engines.vscode` for installation compatibility.
- Dependabot or an equivalent reviewed dependency-update workflow.

CI and local clean installs use `npm ci`. Production, development, and optional dependencies must remain visibly separated. Open VSX or marketplace tokens are release secrets only and are never required for build, test, or package validation.

The lockfile overrides Mocha's development-only transitive `diff` and `serialize-javascript`
packages to `8.0.4` and `7.0.7`. Those are the first reviewed releases outside Mocha's declared
major ranges that close the applicable advisories while retaining the CommonJS APIs used by the
pinned VS Code test runner. Both packages remain excluded from the VSIX. Clean install, the full
test matrix, and a full-tree `npm audit` must pass whenever either override changes.

## Source layout

The planned layout is refined as follows:

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
│   ├── activate.ts
│   ├── commands/
│   ├── diagnostics/
│   ├── workspace/
│   └── webview/
├── shared/
│   └── protocol/
└── webview/
    ├── main.ts
    ├── graph/
    ├── details/
    ├── navigation/
    ├── state/
    └── styles/
scripts/
├── build.mjs
└── package-check.mjs
test/
├── fixtures/
├── unit/
├── extension/
├── webview/
└── benchmarks/
```

Dependency direction is inward:

```text
webview -> shared protocol
extension -> shared protocol + core
core -> no VS Code or Webview dependency
```

The shared protocol contains serializable data and runtime decoders only. It must not become a general dumping ground for behavior shared by unrelated modules.

## TypeScript configuration

Use separate TypeScript configurations sharing one strict base:

- `tsconfig.base.json`: strict language rules and no emit.
- `tsconfig.extension.json`: Node 22 and VS Code types; no DOM globals.
- `tsconfig.webview.json`: ES2022, DOM, and DOM iterable types; no Node globals.
- `tsconfig.test.json`: test-runner globals and harness-specific types only.

The base configuration explicitly enables:

- `strict`.
- `noUncheckedIndexedAccess`.
- `exactOptionalPropertyTypes`.
- `noImplicitOverride`.
- `useUnknownInCatchVariables`.
- `noFallthroughCasesInSwitch`.
- `forceConsistentCasingInFileNames`.
- `noEmit`.

Source files use ESM import/export syntax. The root package may be ESM for build scripts, while the extension entry is bundled to CommonJS for the Node extension host.

## Build and bundle pipeline

Use the pinned `esbuild` `0.28.x` line through the repository-owned build script and two explicit build targets.

### Extension-host bundle

- Entry: `src/extension/activate.ts`.
- Output: `dist/extension.cjs`.
- Platform: Node.
- Format: CommonJS.
- Target: Node 22.
- External: `vscode` only, unless a reviewed dependency demonstrably cannot be bundled.

### Webview bundle

- Entry: `src/webview/main.ts`.
- Output: `dist/webview/main.js` and local CSS assets.
- Platform: browser.
- Format: ESM.
- Target: ES2022.
- No CDN, runtime package fetch, dynamic remote import, or remote font.

Development builds include source maps without embedded source content. Release builds are minified and omit source maps from the VSIX unless a later debugging decision explicitly includes them.

The TypeScript compiler performs type checking separately because esbuild transpiles TypeScript without type checking. This follows the [official VS Code extension bundling guidance](https://code.visualstudio.com/api/working-with-extensions/bundling-extension).

Vite, webpack, and Vite+ are not part of the initial pipeline. Esbuild directly supports the required Node and browser bundles and is documented by VS Code, so an additional application framework or build layer is not justified.

## Runtime dependency baseline

| Purpose | Package baseline | Usage boundary |
| --- | --- | --- |
| YAML parsing | `yaml` `2.9.x` | Core parser; parse AST nodes with error details, retain original source, and normalize supported tags without carrying YAML-created object prototypes into the serializable model |
| Markdown AST | `unified` `11.0.x`, `remark-parse` `11.0.x`, and focused unist visitors | Core parser; extract links and source positions without rendering HTML |
| 3D graph | `3d-force-graph` `1.80.x` | Webview renderer adapter only |

References:

- [`yaml`](https://www.npmjs.com/package/yaml)
- [`unified`](https://www.npmjs.com/package/unified)
- [`remark-parse`](https://www.npmjs.com/package/remark-parse)
- [`3d-force-graph`](https://www.npmjs.com/package/3d-force-graph)

Do not add React, a router, a state-management framework, a dependency-injection container, a CSS framework, or a runtime schema framework for the MVP.

The Webview uses plain TypeScript, DOM APIs, CSS, and a small reducer-style state store. User-controlled values are inserted with `textContent` or equivalent safe DOM APIs. The MVP details view does not render concept Markdown as HTML. If rich Markdown rendering is added later, sanitization requires a separate dependency and security review.

Extension/Webview messages use discriminated unions containing a protocol version and graph revision. Small hand-written runtime decoders narrow `unknown` at both sides of the boundary. If the protocol grows enough that manual decoders become error-prone, adopting a schema library requires a measured bundle and maintenance review.

## Workspace access and write safety

All workspace reads and writes go through an extension-side port implemented with `vscode.workspace.fs` and `vscode.Uri`. Core modules receive text, byte arrays, normalized concept IDs, and operation inputs rather than VS Code objects.

Generated changes are handled as a two-step flow:

1. Build an immutable proposal containing target URI, expected current content hash, and proposed bytes.
2. Preview, re-check the expected content, and apply only after explicit confirmation.

Diff previews use a read-only virtual document provider and the built-in VS Code diff editor. Approval is a modeless continuation so the user can switch among every opened diff before applying or cancelling. Provider-held before/after bodies are scoped to that confirmation session, released afterward, and replaced by an explicit expired-preview document if a stale virtual URI is requested later. The extension preflights all targets before starting a multi-file write. That preflight calls the workspace port's `stat` for the proposal write root and every existing intermediate segment; `FileType.SymbolicLink`, a normal file used as a parent, or an unknown entry refuses the entire proposal before the first write. Missing parents remain provider-creatable. Initialization anchors the proposal at the selected workspace target, while existing-bundle and agent operations anchor at their bundle or integration root, so the same URI-first rule covers every write workflow without assuming `file:` resources. Because virtual workspace providers do not guarantee a cross-file transaction, a partial failure after a successful preflight must stop remaining writes and report completed, failed, and untouched targets explicitly.

Creates use `WorkspaceEdit.createFile` with overwrite and ignore-if-exists both disabled and with the proposed bytes supplied as the initial content. This is the strongest provider-neutral no-overwrite create exposed by the supported VS Code API. The adapter does not fall back to `workspace.fs.writeFile` when a provider cannot apply that resource edit; it fails closed instead.

Updates retain the SHA-256 of the original provider bytes, including an optional UTF-8 BOM, instead of deriving the guard by decoding and re-encoding text. They re-read and compare that exact preview hash as the final awaited operation before starting `workspace.fs.writeFile`, then verify the resulting bytes. VS Code's public workspace filesystem API does not expose an expected version, ETag, hash precondition, or other compare-and-swap option for an existing resource. A provider or remote actor can therefore change an existing file in the narrow interval between the hash check and the write, and the write can overwrite that change. The MVP reports this limitation explicitly and does not claim full update CAS. Remote and virtual provider acceptance evidence must exercise collision and failure behavior for each supported editor/provider combination.

The extension maintains an in-memory parsed-bundle cache keyed by selected bundle and document revision. Markdown remains authoritative. No parsed concept body or frontmatter is stored in `globalState`, `workspaceState`, a database, or an external service.

## Webview security and lifecycle

The Webview HTML uses a per-render nonce and a CSP equivalent to:

```text
default-src 'none';
img-src <webview-source> data:;
style-src <webview-source>;
script-src 'nonce-<nonce>';
font-src <webview-source>;
connect-src 'none';
```

Only packaged resources are exposed through narrow `localResourceRoots`. The graph does not need network access. Message receivers validate the protocol version, message type, graph revision, IDs, and payload shape before any privileged action.

The graph renderer adapter owns the render loop, resize observer, subscriptions, WebGL resources, and disposal. Hiding, reopening, switching bundles, or closing the panel must not leave an active simulation or stale listener.

## State and async model

The extension host owns:

- Selected bundle context.
- Parsed bundle revision.
- Diagnostics.
- Graph payload and source-URI mapping.
- File watcher and debounce lifecycle.

The Webview owns presentation-only state:

- Camera and node coordinates.
- Search and filters.
- Selected node and visible details.
- Focus state for non-spatial navigation.

Every graph payload carries a monotonically increasing revision. Webview actions include the revision they were based on, and the extension rejects actions from a stale bundle or graph revision when acting on them would target the wrong resource.

File events are debounced and processed through cancelable refresh work. A newer refresh result always supersedes an older one. Failure to enumerate the selected bundle root, or another unhandled current-generation refresh failure, clears the prior diagnostics and graph rather than leaving stale derived state visible; later watcher activity can recover the still-selected context. The first fatal failure in one unavailable period also raises one modeless warning that identifies workspace availability or read permissions and tells the user to restore access, then save Markdown or run `OKF: Validate Bundle` to retry. Repeated watcher batches suppress that warning until a successful publication resets the notification state. An unreadable child subtree or individual Markdown file is instead retained as a URI- and provider-path-scoped read finding, and readable siblings still produce current diagnostics and graph state. The first implementation sends a full replacement graph; patch messages are introduced only after benchmark evidence shows they are needed.

## Testing environment

| Layer | Tool baseline | What it proves |
| --- | --- | --- |
| Core unit and fixture tests | Vitest `4.1.x`, Node environment | Parsing, preservation, resolution, validation, indexes, templates, graph model |
| Webview state unit tests | Vitest `4.1.x`, Node environment | Pure search, filtering, focus, presentation, color, and message-decoding state without claiming browser DOM behavior |
| Extension integration | `@vscode/test-cli` `0.0.x` and `@vscode/test-electron` `3.0.x` with Mocha | Commands, workspace FS, diagnostics, watchers, URI behavior, source navigation, and the registered non-`file:` read boundary |
| Webview browser harness | Playwright `1.61.x` on Chromium | Real DOM, WebGL smoke, CSP-compatible bundle loading, keyboard interaction |
| Release smoke | Packaged VSIX in VS Code and VSCodium | Installation, activation, packaged resources, upgrade, uninstall |
| Performance | Headed VS Code/VSCodium benchmark harness | QR-002 and QR-003 evidence on recorded hardware |

References:

- [Testing VS Code extensions](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
- [`@vscode/test-cli`](https://www.npmjs.com/package/@vscode/test-cli)
- [`@vscode/test-electron`](https://www.npmjs.com/package/@vscode/test-electron)
- [Vitest](https://www.npmjs.com/package/vitest)
- [Playwright Test](https://www.npmjs.com/package/@playwright/test)

Playwright is not treated as proof of Electron Webview performance. WebGL performance claims require the headed editor benchmark with hardware, GPU, editor, Electron, and fixture versions recorded.

The integration configuration exposes the narrow acceptance-completion API only in its isolated
test Extension Host. Its provider-boundary scenario registers a read-only `okfmem:`
`FileSystemProvider`, adds that URI as an actual workspace folder, invokes Validate Bundle and Open
3D Graph through their public resource-URI command arguments, checks Problems URI identity and the
Webview render acknowledgement, and rejects any provider mutation. This development-host evidence
does not substitute for packaged VSIX lifecycle evidence, an external remote provider, or write-flow
UI automation.

## Code quality

The scaffold uses ESLint 9 with the compatible `typescript-eslint` 8 line and Prettier 3. Formatting, linting, type checking, unit tests, integration tests, Webview tests, build, package validation, dependency review, and benchmark-harness entry points are exposed through package-local scripts.

The repository does not currently use `vp`, so Vite+ commands are not introduced. Documentation must reference script names only after those scripts exist in `package.json`.

Production code must not use `any`. Tests may use explicit unsafe casts only at a boundary being deliberately tested, with the reason visible in the test.

## CI and release environment

GitHub Actions is the initial CI platform.

Required pull-request gates:

- Clean `npm ci` using Node 24.18.0.
- Format, lint, and strict type checks.
- Core and Webview unit tests.
- Extension integration tests on a pinned minimum VS Code and the current stable VS Code.
- Production build and VSIX package inspection.
- Production dependency license classification and deterministic `THIRD_PARTY_NOTICES.md`
  freshness through `node scripts/security-check.mjs --check-notices` after the clean install.

Ubuntu 24.04 is the primary CI environment. Release smoke also runs on current supported GitHub-hosted Windows and macOS images, with exact runner images recorded by each workflow run. VSCodium validation installs the pinned VSCodium release rather than assuming `@vscode/test-electron` represents it.

Package with `@vscode/vsce` `3.9.x`. Validate and publish an already built VSIX with `ovsx` `1.0.x`. Publication uses `OVSX_PAT` only in a protected, manually approved release environment. Pull requests and ordinary branch builds never have publishing credentials or publish capability.

The ordinary pull-request CI and the protected Open VSX candidate job invoke that same repository-owned license and notice command after `npm ci`. License classification, production-graph traversal, and notice rendering therefore have one implementation and one allowlist; the release workflow adds packaged-VSIX checks but does not redefine the source gate.

The repository-owned package wrapper sets a fixed `SOURCE_DATE_EPOCH`, which makes pinned `vsce` sort ZIP entries lexicographically, and then normalizes every local-header and central-directory DOS timestamp to `1980-01-01 00:00:00` and every central-directory entry to the reviewed regular-file mode `0644`. This removes asynchronous file-discovery ordering, clock-dependent bytes, and the `0644` versus `0666` external-attribute difference emitted from Unix and Windows filesystems while preserving entry contents, CRCs, compression, extra fields, and comments. The normalizer fails closed for ZIP64, split archives, and timestamp-bearing ZIP extra fields. CI invokes that same wrapper a second time against the unchanged build and requires byte equality with the candidate before retaining it. Repository text is checked out with LF endings on every runner through `.gitattributes`; identical tracked inputs and pinned tool versions remain part of the cross-platform byte-identity contract. The package-smoke workflow then downloads the retained Ubuntu, macOS, and Windows VSIX files into one comparison job and fails unless all three byte sizes and SHA-256 digests are identical.

References:

- [`@vscode/vsce`](https://www.npmjs.com/package/@vscode/vsce)
- [`ovsx`](https://www.npmjs.com/package/ovsx)
- [Open VSX](https://github.com/eclipse-openvsx/openvsx)

## Local diagnostics without telemetry

Use one named VS Code output channel for support-relevant local diagnostics. Log stable operation events for command start, success, handled failure, watcher refresh, Webview lifecycle, and partial write failure.

Logs may contain an operation name, result, reason code, duration, safe concept count, graph revision, and retryability. They must not contain document bodies, raw frontmatter, secrets, tokens, complete generated content, or arbitrary user-controlled strings without sanitization. Debug detail is opt-in. No log is uploaded automatically.

## Initial dependency review checklist

Before merging the Phase 0 scaffold:

- Confirm every selected version supports Node 24 tooling and the Node 22 extension target.
- Confirm runtime dependency licenses and required notices.
- Confirm esbuild produces one extension bundle and one locally loadable Webview bundle.
- Inspect the VSIX and ensure source, fixtures, tests, and development-only dependencies are excluded where appropriate.
- Verify the extension runs without network access.
- Verify the manifest installs on VS Code 1.121 and VSCodium 1.121.
- Record any deviation from this baseline in an ADR update before adding overlapping tooling.

## Deferred decisions

- Browser-hosted VS Code extension support and a `browser` entry point.
- Microsoft Marketplace publication.
- Rich Markdown-to-HTML rendering in the Webview.
- Incremental graph patch protocol.
- Custom templates and third-party template packages.
- TypeScript 7 adoption.
- Backward compatibility below VS Code 1.121.
