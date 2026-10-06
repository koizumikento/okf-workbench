# 0013 — Keep development tooling free of known dependency advisories

- Status: Accepted
- Date: 2026-10-04

## Context

The maintainer requested remediation of the twelve remaining development-dependency audit
entries after Dependabot PRs #61 and #62 were merged. The full-tree `npm audit` reported nine
high and three moderate entries; the production-only audit reported zero. Those entries include
affected packages and dependent packages, rather than twelve independent advisories. This
confirms vulnerable versions in the development tree, without establishing runtime exploitability.

Vitest `4.1.11` fixes the
[redirect-mock advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9).
Updating brace-expansion, js-yaml, and qs within their existing declared ranges removes their
audit entries. The remaining braces advisory has no fixed release in the available `3.x` line.
[`@vscode/vsce` 4.0.0](https://github.com/microsoft/vscode-vsce/releases/tag/v4.0.0) replaces the
affected secretlint/globby/fast-glob dependency chain and removes fast-uri from that tree, but
`ovsx` `1.0.2` still declares a `^3.7.1` packager dependency.

## Decision

- Pin Vitest `5.0.3` (see the amendment below) and `@vscode/vsce` `4.0.0` as development
  dependencies. Keep Node 24, the existing npm/esbuild/Cargo pipeline, and the published editor
  API floor.
- Override transitive `@vscode/vsce` with `$@vscode/vsce`, matching the exact direct version.
  Pin `ovsx` `1.2.0` (see the amendment below) and verify its CLI startup and the existing
  `createVSIX` API offline.
- Refresh affected indirect dependencies within their existing ranges. Preserve the approved
  production dependency graph and its notices.
- Review the `@vscode/vsce-sign` `2.1.0` installer and synchronize its exact allowlist entry with
  the repository policy and fixture. Remove the obsolete keytar install permission. New native
  keyring packages are development-only and have no install lifecycle script.
- Run `npm audit --audit-level=low` on the entire locked dependency tree in PR CI, compatibility
  candidate builds, and tagged release candidate builds. Do not suppress development advisories.

## Consequences and validation

The new packager requires Node 22 or newer, within the accepted Node 24 tooling baseline. Its
public `createVSIX` API retains the options used by the repository and by `ovsx`, but the override
crosses `ovsx`'s declared major range. Clean `npm ci`, CLI startup, unit and boundary tests,
VSIX content checks, and reproducibility checks are required before merge. Publishing an existing
VSIX must retain the current arguments; a live registry publish is outside this maintenance task.

All new packaging, installation, and scan evidence applies to the updated development tree.
Existing 0.4.0 release lifecycle and performance receipts continue to describe only their original
bytes. A zero-result npm audit is a time-bound known-advisory result, not a complete security claim.

## 2026-10-05 amendment: Vitest 5 benchmark migration

The maintainer authorized the major-version migration in Dependabot PR #71. This supersedes
the original Vitest `4.1.11` pin with `5.0.3`; the packager, overrides, installer policy, Node
baseline, and editor API floor retain their existing decisions.

Following the [Vitest 5 migration guide](https://vitest.dev/guide/migration.html) and the
[version-pinned benchmark API](https://github.com/vitest-dev/vitest/blob/v5.0.3/docs/guide/benchmarking.md),
the five harness workloads use async tests with the test-context `bench` fixture and explicitly
await each registration's `.run()`. Benchmark discovery is limited to `test/benchmarks`, separate
from ordinary unit tests. PR CI runs the existing `npm run benchmark` command so registration
alone cannot masquerade as an executed measurement.

Validation requires clean installation, formatting, lint, type checks, all test and security
gates, five completed benchmark measurements, full-tree audit, and reproducible inspected VSIX
packaging. These harness measurements remain overhead evidence, not headed-editor QR evidence.

## 2026-10-06 amendment: Open VSX CLI 1.2.0

Dependabot PR #69 updates the development-only `ovsx` pin from `1.0.2` to `1.2.0`.
Its Node 22 minimum fits the Node 24 baseline. It still declares `@vscode/vsce` `^3.7.1`,
so the reviewed override to `4.0.0` remains necessary. The added prompt and keychain
helpers remain development-only; the production dependency graph is unchanged.

The tagged workflow's CLI version assertion must match `1.2.0`. Keep the existing
`verify-pat straydog` and retained-VSIX `publish --skip-duplicate` arguments, token scope,
and tag-only authorization unchanged. Validation covers clean locked installation,
CLI version/help, the overridden packager API, supply-chain checks, full-tree audit,
and reproducible inspected VSIX packaging. No registry publication or credential
verification is performed as part of this dependency maintenance.
