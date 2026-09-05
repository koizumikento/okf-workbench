# 0012 — Target Node 24 in the Extension Host

- Status: Accepted
- Date: 2026-09-05

## Context

The maintainer approved Dependabot PR #47 (`@types/node` 24.13.3) and raising the
extension runtime target. Node types and emitted syntax must match the supported editor runtime.

VS Code [1.122.0](https://github.com/microsoft/vscode/blob/1.122.0/.npmrc) still uses
Electron 39.8.8. VS Code [1.123.0](https://github.com/microsoft/vscode/blob/1.123.0/.npmrc)
uses [Electron 42.3.0](https://releases.electronjs.org/release/v42.3.0), which includes
Node 24.15.0. VSCodium [1.126.04524](https://github.com/VSCodium/vscodium/releases/tag/1.126.04524)
is based on [VS Code 1.126.0](https://github.com/VSCodium/vscodium/blob/1.126.04524/upstream/stable.json),
which also pins Electron 42.3.0.

## Decision

- Supersede the Node 22 target and API floor in ADR 0004 and OQ-007 of ADR 0005:
  use Node 24/CommonJS, `@types/node` 24.13.3, and `engines.vscode: ^1.123.0`.
- Test VS Code 1.123.0 and the existing current-editor pin, 1.129.1. Assert Node 24
  or newer in the real Extension Host integration suite.
- Update the packaged VSCodium lane to 1.126.04524 (Extension Host API 1.126.0),
  with official archive sizes and SHA-256 digests pinned before execution.
- Keep the conservative `@types/vscode` 1.120.0 API ceiling, development tooling,
  ES2022 Webview target, Wasm ABI, and native CLI contract unchanged.

## Consequences

The next extension package requires VS Code 1.123 or newer. Older editors can keep
the published 0.3.0 package. The runtime change does not alter OKF semantics or add
features. Existing 0.3.0 lifecycle and performance receipts remain historical evidence
for those exact bytes; they do not qualify the new build.
