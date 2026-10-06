# 0014 — Preserve current stable editor compatibility

- Status: Accepted
- Date: 2026-10-06

## Correction

PR #67 raised the manifest minimum to API 1.140 with its type update. Although the
maintainer allowed a higher minimum, that did not authorize making the extension
unusable on current stable VSCodium. The 1.140 decision was therefore incorrect.
This correction reverses that floor/type change while preserving PRs #66 and #69.

## Decision

- Restore `engines.vscode: ^1.123.0` and `@types/vscode: 1.120.0`. Keep Node 24,
  the package version, production dependencies, commands, and security boundaries.
- Retain the VS Code 1.123.0 minimum lane. Pin the current lane to official
  [VS Code 1.140.0](https://github.com/microsoft/vscode/releases/tag/1.140.0).
- Pin VSCodium to official stable
  [1.135.06055](https://github.com/VSCodium/vscodium/releases/tag/1.135.06055),
  published 2026-09-09. Its
  [upstream pin](https://github.com/VSCodium/vscodium/blob/1.135.06055/upstream/stable.json)
  is VS Code 1.135.0. Preserve the distinct CLI and Extension Host version checks.
  Pin all six supported desktop archives using the official release asset sizes
  and SHA-256 digests; verify before extracting or executing an archive.
- Run the existing packaged lifecycle harness on both current stable editors in
  Ubuntu PR CI, using the exact VSIX produced and inspected by the quality job.
  Check clean installation, real activation and commands, untrusted-workspace
  behavior, upgrade, uninstall, network observations, and workspace preservation.
  The upgrade predecessor is the explicit test-only 0.0.0 fixture, not evidence of
  migration from a published version.
- Keep every existing gate enabled. Preserve protected check identifiers, including
  the historical `current-1.129.1` identifier; that job records and tests 1.140.0.
  No engine check, branch protection, or security setting is bypassed or changed.

The manifest floor must fit both supported stable editor APIs, and the type ceiling
must fit the floor. A unit invariant checks these relationships, while packaged
lifecycle tests establish actual installability and behavior. A type update that
cannot satisfy this contract must wait instead of dropping stable-editor support.

## Evidence limits

The current headed-performance oracle follows VS Code 1.140.0, but no new headed
performance result is claimed. Historical release receipts retain their original
versions and exact bytes. The two Ubuntu package lanes do not establish current
macOS/Windows editor lifecycle results; the full compatibility workflow remains
enabled with refreshed pins for that qualification. This correction publishes no
release and changes no immutable 0.4.0 release asset.
