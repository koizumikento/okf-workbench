# 0014 — Align the VS Code API floor with 1.140 types

- Status: Accepted
- Date: 2026-10-06

## Decision

The maintainer approved raising the editor minimum for Dependabot PR #67.
New source-built packages use `@types/vscode` `1.140.0` and
`engines.vscode: ^1.140.0`. This supersedes the API floor and type ceiling in
ADR 0012 and the floor-preservation constraint in ADR 0013. Node 24/CommonJS,
the Wasm boundary, and the product commands retain their existing contracts.

[VS Code 1.140.0](https://github.com/microsoft/vscode/releases/tag/1.140.0)
is the latest official stable release checked on this date. Both minimum and
current VS Code test roles therefore use that exact version. Keep both CI jobs:
their historical required-check identifiers (`minimum-1.123.0` and
`current-1.129.1`) remain stable to avoid changing branch protection. These
identifiers are not claims about the editor under test; each job records its
actual `VSCODE_TEST_VERSION`, and its matrix explicitly pins 1.140.0.

The package validator, manifest fixture, compatibility pins, and current headed
performance oracle use the new floor. Existing release and performance receipts
retain their original versions and do not qualify the new source build.

## Compatibility consequences and validation

Editors below API 1.140 cannot install new packages. Users of those editors must
retain published 0.4.0, whose immutable package still supports API 1.123. No
release version or tag is changed by this maintenance task.

The latest official [VSCodium release](https://github.com/VSCodium/vscodium/releases/tag/1.135.06055)
checked on this date uses API 1.135, below the new floor. The existing VSCodium
1.126.04524 packaged-lifecycle lanes remain enabled with their reviewed archive
digests. They cannot qualify a new package until an official API 1.140+ release
exists and its archive pins are reviewed. Do not bypass the editor's installation
check or report the older receipts as current compatibility evidence.

PR validation requires clean installation, formatting, lint, type checks, Rust,
unit and acceptance tests, security and dependency checks, audit, benchmark
harness, reproducible inspected VSIX packaging, and both real VS Code integration
jobs on 1.140.0. This does not establish VSCodium, macOS/Windows packaged lifecycle,
or headed performance qualification for the new floor; those remain release
qualification gaps. Registry publishing and release dispatch are outside this task.
