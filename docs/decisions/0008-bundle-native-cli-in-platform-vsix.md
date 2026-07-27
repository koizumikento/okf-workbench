# ADR 0008 — Bundle the native CLI in platform VSIX packages and distribute it separately

## Status

Accepted — 2026-07-24; Homebrew and Scoop publication added 2026-07-27

## Context

ADR 0007 established a native Rust `okf` CLI beside the capability-free Wasm core used by the
extension. A separately downloaded CLI is useful for CI, scripts, and shells outside the editor,
but it does not provide an immediate command-line path after installing the extension.

VS Code and Open VSX support target-platform VSIX packages. The extension is a workspace
extension, so the applicable target is the operating system and architecture of the Extension
Host. For a local window that is the local machine; for a remote workspace it is normally the
remote host.

## Decision

Release each version through two complementary distribution paths:

1. Target-platform VSIX packages bundle one native `okf` executable so a new integrated terminal
   can use the CLI immediately.
2. Standalone native CLI archives remain available for CI, external terminals, servers, and users
   who do not install the extension. Tagged releases also update `Formula/okf.rb` and
   `bucket/okf.json` in `koizumikento/stray-tools`; those manifests reference the retained GitHub
   Release archives and checksums rather than rebuilding the CLI.

The initial target set is:

- `darwin-arm64`;
- `darwin-x64`;
- `linux-x64`; and
- `win32-x64`.

A universal VSIX without a native executable remains a supported fallback for other Extension Host
targets. Extension commands continue to use the packaged capability-free Wasm core on every target;
they never spawn the native CLI.

Each platform release job builds one Rust executable and feeds those exact bytes to both the
standalone archive and the target-platform VSIX. Packaging records the byte length, SHA-256,
extension/CLI version, core version, and ABI version in `dist/bundled-cli.json`. Release gates reject
a VSIX whose target, executable name, mode, bytes, or manifest metadata differ, and require the raw
standalone and bundled executable hashes to match.

On activation, the extension validates the manifest and executable before exposing it. When
`okfWorkbench.cli.exposeInIntegratedTerminal` is enabled, it appends the bundled binary directory to
`PATH` for newly created integrated terminals and sets `OKF_WORKBENCH_CLI` to the exact validated
binary. Appending preserves an already installed `okf` earlier in `PATH`; scripts that require the
bundled version can invoke `OKF_WORKBENCH_CLI`. The extension does not modify shell profiles,
machine-level environment variables, or external terminals.

`OKF: Show CLI Status` reports whether the current Extension Host has a validated bundled CLI.
`OKF: Open CLI Terminal` opens an integrated terminal and pre-fills `okf version` without executing
it. Startup activation is used only to establish terminal environment mutations; Wasm loading stays
lazy until a core operation is requested.

## Consequences

- Extension installation provides an immediate, offline CLI path on supported targets.
- Standalone use remains independent of VS Code and Open VSX.
- Homebrew on macOS and Scoop on Windows provide package-manager discovery for the same retained
  standalone archives; GitHub Release remains their artifact authority.
- One release carries five VSIX files: four target packages and one universal fallback.
- Native executable size is paid once per installed target package, not for every target.
- Existing terminals must be recreated after installing, updating, or changing the exposure
  setting because VS Code applies environment mutations to new terminals.
- A platform package is selected for the Extension Host, which may differ from the desktop platform
  in remote workspaces.
- Additional architectures require an explicit target mapping, runner, package gate, and release
  qualification before publication.

## Rejected alternatives

- **Standalone CLI only:** does not satisfy immediate use after extension installation.
- **Bundled CLI only:** excludes CI, external-shell, and editor-free workflows.
- **Download the CLI on first use:** introduces network, provenance, proxy, and lifecycle failure
  modes into an otherwise offline tool.
- **Have extension commands spawn the CLI:** duplicates process and filesystem boundaries and
  abandons the reviewed capability-free Wasm architecture.
- **Prepend the bundled CLI to `PATH`:** unexpectedly shadows an administrator- or user-managed
  standalone installation.
