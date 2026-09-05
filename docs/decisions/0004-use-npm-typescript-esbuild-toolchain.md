# 0004 — Use a single-package npm, TypeScript, and esbuild toolchain

- Status: Accepted
- Date: 2026-07-22

## Context

The repository has approved product, architecture, and functional requirements but no implementation scaffold. The toolchain must build one privileged Node extension-host entry and one isolated browser Webview entry, keep the deterministic core framework-independent, run on VS Code and VSCodium, and package reproducibly for Open VSX.

At the decision date, Node.js 24 is LTS, VS Code stable is 1.127, and VSCodium stable is based on VS Code 1.121. The implementation therefore needs newer development tooling without emitting code that requires a newer extension host than the VSCodium baseline.

## Decision

The Node target and editor floor below are superseded by
[ADR 0012](0012-node24-extension-host.md) for post-0.3.0 builds.

- Use one npm package and one committed `package-lock.json`; do not start with a monorepo or alternate package manager.
- Pin local and CI tooling to Node.js 24.18.0 and npm 11.16.0.
- Set the VS Code API floor to `^1.121.0` and compile the extension-host bundle for Node 22.
- Use TypeScript 6.0 with explicit strict options. Defer TypeScript 7 until the extension, lint, and test toolchain has been validated against it.
- Use esbuild for separate extension-host CommonJS and Webview ESM bundles, with `vscode` externalized and all Webview assets local.
- Use plain TypeScript, DOM APIs, CSS, and reducer-style state in the Webview. Do not add React, a router, a state framework, or a CSS framework.
- Use Vitest for core and DOM unit tests, the VS Code Test CLI with `@vscode/test-electron` for extension integration, and Playwright for a standalone real-browser Webview harness.
- Package with `@vscode/vsce` and validate or publish the built VSIX with `ovsx` only from the
  repository release workflow. ADR 0006 supersedes this record's earlier protected-Environment
  requirement with version-tag authorization.
- Keep runtime dependencies initially limited to focused YAML, Markdown AST, and graph-renderer packages documented in [Implementation environment](../implementation-environment.md).
- Keep the MVP desktop-only. A VS Code Web `browser` entry is a separate compatibility decision.

## Consequences

Positive:

- The build follows VS Code's documented esbuild approach and has explicit Node and browser targets.
- One package and lockfile reduce setup, release, and dependency-review complexity.
- The core remains testable without the editor, Webview, network, or AI provider.
- The manifest can support the current VSCodium stable line while development uses a supported Node LTS.
- The test layers distinguish pure logic, extension-host integration, browser behavior, packaged-editor behavior, and performance evidence.

Costs:

- The extension and Webview require separate TypeScript libraries, bundle settings, and test harnesses.
- CommonJS remains a generated extension-host format even though source and build scripts use ESM.
- VSCodium release testing needs a dedicated installed-editor path rather than only the VS Code test downloader.
- Plain DOM state requires discipline as the Webview grows; framework adoption remains possible only after demonstrated complexity.
- TypeScript 7 features are intentionally unavailable in the initial scaffold.

## Alternatives considered

- **pnpm workspace or monorepo:** rejected until the repository has independently versioned packages or material workspace pressure.
- **Vite, webpack, or Vite+:** rejected for the initial scaffold because direct esbuild targets both required runtimes with less configuration and is covered by VS Code documentation.
- **React:** rejected because the graph library has a standalone API and the MVP UI does not justify a framework dependency.
- **Node.js 26:** rejected because it is Current rather than LTS at the decision date.
- **TypeScript 7:** deferred because it was newly released and the immediate priority is a stable extension toolchain.
- **Web extension first:** deferred because the approved MVP and compatibility gate target desktop VS Code and VSCodium.
