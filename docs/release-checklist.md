# Release checklist

- Candidate: OKF Workbench `0.2.1`
- Target identifier: `straydog.okf-workbench`
- Registry: Open VSX
- Current disposition: **Released on 2026-07-28; the signed tag, GitHub Release, Open VSX package
  set, package-manager manifests, and available post-publication lifecycle checks passed**
- Publication authority: a matching signed `v*` tag pushed for a reviewed commit contained in
  `main`

This checklist prepares and records the `0.2.1` patch release. It does not make `0.2.0` evidence
apply to new bytes. The candidate fixes orphan-only sidebar warning counts and hidden-Webview graph
refresh delivery without changing the OKF compatibility contract, dependencies, or renderer.

The completed `0.2.0` release record is archived at
[`docs/releases/0.2.0.md`](releases/0.2.0.md).

## Release blockers

- [x] The project remains MIT licensed and the root license and manifest agree.
- [x] The locked production graphs remain 78 npm runtime packages and 26 Rust/Wasm dependencies;
      generated notices are current.
- [x] The production-only npm audit reports zero vulnerabilities.
- [x] PR #40 passed required CI and CodeQL checks before the two fixes were merged to `main`.
- [x] Fixed-toolchain local source, Rust, unit, acceptance, dependency, security, and browser gates
      passed with Node.js `24.18.0`, npm `11.16.0`, and Rust `1.92.0`.
- [x] Local VS Code integration passed on minimum `1.121.0` and genuine current `1.129.1`; all 16
      Webview browser tests passed.
- [x] A fresh genuine headed VS Code `1.129.1` capture for `0.2.1` passed QR-002 at `677 ms` p95
      across 20 samples, passed QR-003 with `d3` selected, and recorded zero remote HTTP(S)/WS or
      other-scheme Webview requests.
- [x] The local universal VSIX passed the closed-set package, license/notices, packaged security,
      and production audit gates. It is `978322` bytes with SHA-256
      `7a88adb4091d2de5c5e5f99310257153f97cb829db8d9e2f6fd0d2d29e723073`; this is local
      pre-merge evidence, not the final hosted digest.
- [x] The orphan-only sidebar state and hidden-graph post-write refresh were manually verified in
      dark, light, and dark high-contrast themes. The sidebar exposed zero curation warnings and
      two separately identified orphan concepts, the restored graph reported current data without
      an interaction-error dialog, and keyboard focus traversed the Resources tree.
- [x] The immutable merged packaged candidate revision is
      `80ae7d560337cbe8d97af864c77aee410d5e5988`; this evidence update changes documentation only.
- [x] [Compatibility run 30335399539](https://github.com/koizumikento/okf-workbench/actions/runs/30335399539)
      passed acceptance/Webview and all seven editor/OS lifecycle lanes for that revision, using
      the published `v0.2.0` universal VSIX as the verified upgrade predecessor.
- [x] [Package smoke run 30335400890](https://github.com/koizumikento/okf-workbench/actions/runs/30335400890)
      passed the browser boundary, all four target packages, and aggregate package-set consistency
      for the same revision.
- [x] Repository secret names `OPEN_VSX_TOKEN`, `TAP_REPO`, and `STRAY_TOOLS_TOKEN` exist. Their
      values remain unreadable and must be validated only by the tagged workflow.
- [x] On 2026-07-28, the maintainer requested this release. Publication remains fail-closed on
      every unchecked gate above.

## Version, changelog, and links

- [x] `package.json`, `package-lock.json`, the Cargo workspace, the Rust lockfile, package
      validation, and version assertions agree on `0.2.1`.
- [x] `CHANGELOG.md` contains one dated `0.2.1` entry and no `Unreleased` heading.
- [x] The extension identifier remains `straydog.okf-workbench`.
- [x] The public manifest retains the approved repository, issue, homepage, privacy, support,
      security, license, and notice routes.
- [x] No dependency, remote runtime resource, telemetry, account, upload, or AI-provider flow was
      added.

## Build the immutable candidate

1. Freeze all packaged inputs, merge the release PR, and record its exact `main` revision.
2. Use Node.js `24.18.0`, npm `11.16.0`, Rust `1.92.0`, and the installed
   `wasm32-unknown-unknown` target.
3. Install from committed lockfiles and run:

   ```sh
   mise x node@24.18.0 -- npm ci
   mise x node@24.18.0 -- npx --no-install playwright install chromium
   mise x node@24.18.0 -- npm run check
   mise x node@24.18.0 -- env VSCODE_TEST_VERSION=1.121.0 npm run test:integration
   mise x node@24.18.0 -- env VSCODE_TEST_VERSION=1.129.1 npm run test:integration
   mise x node@24.18.0 -- npm run test:webview
   mise x node@24.18.0 -- npm run package
   mise x node@24.18.0 -- npm run package:check
   mise x node@24.18.0 -- node scripts/security-check.mjs --check-notices
   mise x node@24.18.0 -- npm run rust:notices:check
   mise x node@24.18.0 -- node scripts/security-check.mjs \
     --vsix artifacts/okf-workbench.vsix
   mise x node@24.18.0 -- npm audit --omit=dev --audit-level=high
   ```

4. Capture the genuine headed `1.129.1` evidence and require the generated report to pass:

   ```sh
   mise x node@24.18.0 -- node test/benchmarks/headed-editor-evidence.mjs \
     --version 1.129.1 \
     --vscode-executable "/absolute/path/to/VS-Code-1.129.1-executable" \
     --output artifacts/performance/vscode-1.129.1-0.2.1.json
   mise x node@24.18.0 -- npm run benchmark:report -- \
     --measurements artifacts/performance/vscode-1.129.1-0.2.1.json \
     --require-passing
   ```

5. Run hosted `Compatibility` with the published `v0.2.0` universal VSIX URL and exact checksum,
   then run hosted `Package smoke` for the same `main` revision.
6. Apply evidence-only documentation updates. If any packaged input changes, discard prior
   qualification and repeat the affected gates.

## Approval and publication

Per [ADR 0006](decisions/0006-publish-open-vsx-from-version-tags.md), the `Open VSX release`
workflow is the only automated publication path. It runs only when a `v*` tag is pushed.

Before pushing the tag:

1. complete every unchecked release blocker above;
2. merge reviewed candidate and evidence commits into protected `main`;
3. confirm `v0.2.1` matches `package.json` and does not already exist;
4. verify the signed tag locally and confirm its commit is contained in `main`; and
5. confirm the release credential names and current Open VSX publisher authorization.

Publish only after those checks:

```sh
git tag -s v0.2.1 -m "OKF Workbench 0.2.1"
git tag -v v0.2.1
git push origin v0.2.1
```

The workflow reruns the deterministic source, dependency, security, audit, reproducibility, and
package gates; creates the universal and four target VSIX packages plus four native CLI archives
and checksums; creates the GitHub Release; updates Homebrew and Scoop manifests; and publishes the
VSIX set to Open VSX.

Never print or pass release tokens as command arguments. Do not run `ovsx publish` locally as a
fallback. Open VSX versions are immutable; recover from a defective release with a higher version.

## Post-publication verification

- [x] Confirm the signed `v0.2.1` tag and GitHub Release identify the qualified revision.
- [x] Confirm the release contains the universal and four target VSIX packages, four CLI archives,
      and all checksum files.
- [x] Confirm Open VSX reports `straydog.okf-workbench` version `0.2.1` and all target packages.
- [x] Download the published universal VSIX and compare it with the release checksum.
- [x] Install `0.2.1` from Open VSX in a clean supported VSCodium profile and run the minimal
      offline workflow.
- [x] Verify upgrade from `0.2.0`, uninstall behavior, and workspace-content preservation.
- [x] Confirm `koizumikento/stray-tools` contains matching `0.2.1` Homebrew and Scoop manifests.
- [x] Run a clean Homebrew install, verify `okf version`, and uninstall it afterward.
- [ ] Run a clean Scoop install and verify `okf version`; this requires a Windows environment and
      was not available for the macOS post-publication check.
- [ ] Revoke the one-time token, or record the owner, scope, storage, and rotation date for a
      retained release credential.

## Release record

| Field | `0.2.1` value |
| --- | --- |
| Extension ID | `straydog.okf-workbench` |
| Packaged-input candidate commit | `aaef648754ce0bcef18bc0259966ae4875aa21a7` |
| Immutable merged candidate revision | `80ae7d560337cbe8d97af864c77aee410d5e5988` |
| Hosted CI | [PR #40 checks](https://github.com/koizumikento/okf-workbench/pull/40/checks) and [release PR #41 checks](https://github.com/koizumikento/okf-workbench/pull/41/checks) passed |
| Hosted compatibility | [Pass — run 30335399539](https://github.com/koizumikento/okf-workbench/actions/runs/30335399539); acceptance/Webview and all seven editor/OS lifecycle lanes using published `v0.2.0` as the predecessor |
| Hosted package smoke | [Pass — run 30335400890](https://github.com/koizumikento/okf-workbench/actions/runs/30335400890); browser boundary, four targets, and aggregate consistency |
| Headed performance/network | Pass — VS Code `1.129.1`, QR-002 `677 ms` p95/20 samples, QR-003 `d3`, remote `0`, local packaged `2`, internal Webview `2`, other `0` |
| Local universal VSIX | `978322` bytes; SHA-256 `7a88adb4091d2de5c5e5f99310257153f97cb829db8d9e2f6fd0d2d29e723073` |
| Hosted qualified universal VSIX | `978168` bytes; SHA-256 `6c45cd00e620730d9c023764e822077a4444264ac1f3d4f88e8139a9df79dc32` |
| Node / npm / Rust | `24.18.0` / `11.16.0` / `1.92.0` |
| Signed tag | `v0.2.1` on `ebb696a6bf80e8ca3f5f83c3ccc769400459b288`; local SSH signature verification passed |
| Release workflow | [Pass — run 30336464452](https://github.com/koizumikento/okf-workbench/actions/runs/30336464452); all validation, packaging, GitHub Release, manifest, and Open VSX jobs passed |
| GitHub Release | [Published](https://github.com/koizumikento/okf-workbench/releases/tag/v0.2.1) as latest with 18 assets; all nine published checksum files verified |
| Open VSX listing | [Published and verified](https://open-vsx.org/extension/straydog/okf-workbench) as `0.2.1` with the universal and four target packages |
| Post-publication lifecycle | Pass — Open VSX universal VSIX, VSCodium `1.121.03429` on macOS arm64, clean install, offline activation, untrusted-workspace behavior, `0.2.0` upgrade, uninstall, settings preservation, and workspace preservation |
| Homebrew / Scoop repository | [`koizumikento/stray-tools`](https://github.com/koizumikento/stray-tools) commit `682cd3b9b9d102379e30a4f95ca2dbbb376cb932`; Homebrew clean install returned CLI/core `0.2.1` and was removed; Scoop manifest verified but clean Windows install remains pending |

## Rollback

Open VSX has no supported unpublish command. For a defective non-security release, preserve the
artifacts and evidence, stop promotion, and fix forward with a higher SemVer version. For a
security, privacy, credential, or licensing incident, revoke credentials, use the private security
route, contact Open VSX for the exact version, and publish clear update or uninstall guidance.
