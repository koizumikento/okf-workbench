# Release checklist

- Candidate: OKF Workbench `0.2.0`
- Target identifier: `straydog.okf-workbench`
- Registry: Open VSX
- Current disposition: **Release preparation is complete locally; publication remains blocked until
  fresh hosted compatibility and package-smoke evidence is retained for the immutable candidate**
- Publication authority: a matching signed `v*` tag pushed for a reviewed commit contained in
  `main`

This checklist prepares and records one release candidate; it does not make older evidence apply to
new bytes. Mark a gate only from retained evidence. A configured workflow, passing component test,
or absent observation is not a substitute for its named manual or hosted check.

The `0.2.0` candidate adds the Activity Bar/sidebar workflow and therefore changes the manifest,
Extension Host bytes, and packaged resource inventory. All `0.1.x` qualification and publication
records are historical evidence for those exact released bytes only.

## Release blockers

- [x] The maintainer selected MIT for the project, the root `LICENSE` and manifest agree, and the
      project code is approved for distribution under those terms.
- [x] The generated npm and Rust third-party notices exactly match the current locked production
      graphs: 78 npm runtime packages and 26 Rust/Wasm dependencies.
- [x] The production-only npm audit reports zero vulnerabilities. The previously accepted
      development-tool availability residual for `GHSA-mh99-v99m-4gvg` is not shipped.
- [x] PR #36 passed the required CI and CodeQL checks for the `0.2.0` release-preparation changes.
- [x] Local VS Code integration passed on minimum `1.121.0` and current `1.129.1`; all 16 Webview
      browser tests passed.
- [x] A fresh genuine headed VS Code `1.129.1` capture for the `0.2.0` candidate passed QR-002 at
      `672 ms` p95 across 20 samples, passed QR-003 with `d3` selected, and recorded zero remote
      HTTP(S)/WS or other-scheme Webview requests.
- [x] The local universal VSIX passed the closed-set package check, license/notices checks,
      packaged security check, and production audit. The observed package was `978017` bytes with
      SHA-256 `6fcda0bb7da0237d6cef31d4476178611234df6201a059aec366ff057264361b`;
      this is local pre-merge evidence, not the final hosted digest.
- [x] The sidebar was manually reviewed in dark, light, and high-contrast themes. Screen Reader
      Optimized Mode exposed the Bundle, Resources, and Actions views, and keyboard focus traversed
      the Bundle tree without pointer input.
- [ ] Record the immutable `main` candidate revision after the release-preparation PR is merged.
- [ ] Run the hosted Compatibility workflow for that revision and retain every required
      VS Code/VSCodium and OS lifecycle artifact.
- [ ] Run the hosted Package smoke workflow for that revision and retain all four target packages
      plus the aggregate package-set consistency result.
- [ ] Confirm the repository secret names `OPEN_VSX_TOKEN`, `TAP_REPO`, and `STRAY_TOOLS_TOKEN`
      exist. Their values remain unreadable through GitHub APIs and must be validated by the tagged
      workflow without being printed.
- [x] On 2026-07-28, the maintainer requested the release, authorized creation and merge of the
      release PR when checks pass, and authorized branch cleanup. Publication still remains
      fail-closed on every unchecked gate above.

## Version, changelog, and links

- [x] `package.json` has `publisher: "straydog"`, `name: "okf-workbench"`, and
      `version: "0.2.0"`.
- [x] `package-lock.json`, the Cargo workspace, the Rust lockfile, package validation, and version
      assertions agree on `0.2.0`.
- [x] `CHANGELOG.md` contains exactly one dated `0.2.0` entry and no `Unreleased` heading.
- [x] The extension identifier remains `straydog.okf-workbench` across the manifest, package
      checks, integration tests, workflows, and release documentation.
- [x] The public manifest retains the approved repository, issue, homepage, privacy, support,
      security, license, and notice routes.
- [x] The packaged README states local-only privacy behavior and MIT licensing, and the VSIX
      contains the corresponding project license and generated notice files.
- [x] The extension icon and OKF Workbench Activity Bar icon are local packaged resources; no CDN
      or remote runtime dependency was introduced.

## Build the immutable candidate

1. Freeze every packaged reader-facing file first: manifest, license, generated notices, README,
   changelog, icons, approved public contact routes, and runtime bundles. Start from that intended
   clean commit and record its full revision.
2. Use Node.js `24.18.0`, npm `11.16.0`, Rust `1.92.0`, and the installed
   `wasm32-unknown-unknown` target.
3. Install from the committed lockfiles and run all local release gates:

   ```sh
   mise x node@24.18.0 -- npm ci
   mise x node@24.18.0 -- npx --no-install playwright install chromium
   mise x node@24.18.0 -- npm run check
   mise x node@24.18.0 -- env VSCODE_TEST_VERSION=1.121.0 npm run test:integration
   mise x node@24.18.0 -- env VSCODE_TEST_VERSION=1.129.1 npm run test:integration
   mise x node@24.18.0 -- npm run test:webview
   mise x node@24.18.0 -- npm run package
   mise x node@24.18.0 -- node scripts/benchmark-report.mjs \
     --measurements artifacts/performance/vscode-1.129.1-0.2.0.json \
     --require-passing \
     > artifacts/performance/vscode-1.129.1-0.2.0-release-check.md
   cmp artifacts/performance/vscode-1.129.1-0.2.0.md \
     artifacts/performance/vscode-1.129.1-0.2.0-release-check.md
   mise x node@24.18.0 -- npm run package:check
   mise x node@24.18.0 -- node scripts/security-check.mjs --check-notices
   mise x node@24.18.0 -- npm run rust:notices:check
   mise x node@24.18.0 -- node scripts/security-check.mjs \
     --vsix artifacts/okf-workbench.vsix
   mise x node@24.18.0 -- npm audit --omit=dev --audit-level=high
   ```

4. Record the universal VSIX SHA-256, byte size, revision, build environment, exact package
   versions, and command results. Treat locally rebuilt bytes as local evidence until the hosted
   package-set workflow establishes the release artifacts.
5. Run the manual `Compatibility` workflow for the immutable candidate. Supply a genuinely older
   VSIX and digest when upgrade evidence is required.
6. Run the manual `Package smoke` workflow for the same revision and require all target lanes plus
   the aggregate consistency job to pass.
7. Review the fresh headed GPU/network evidence and the theme/accessibility screenshots without
   adding workspace content, profiles, or secrets to the repository.
8. Apply evidence-only release-record updates before tagging. If any source, dependency, manifest,
   notice, icon, README, changelog, or packaged file changes, discard the prior digest and repeat
   the affected gates.

## Approval and publication

Per [ADR 0006](decisions/0006-publish-open-vsx-from-version-tags.md), the `Open VSX release`
workflow is the only automated publication path. It runs only when a `v*` tag is pushed. The tag is
the maintainer's release authorization; pull requests, ordinary branch pushes, and reusable
workflow calls cannot invoke publication.

Before pushing the tag:

1. complete every unchecked release blocker above;
2. merge the reviewed release and evidence commits into protected `main`;
3. confirm the tag is exactly `v0.2.0`, matches `package.json`, and does not already exist;
4. verify the signed tag locally and confirm its commit is contained in `main`; and
5. confirm the release credential names exist and the Open VSX Publisher Agreement remains
   current.

Push the tag only after those checks:

```sh
git tag -s v0.2.0 -m "OKF Workbench 0.2.0"
git tag -v v0.2.0
git push origin v0.2.0
```

The workflow rejects a tag whose commit is not contained in `main`, whose version does not match
the manifest, or whose changelog entry is still `Unreleased`. It reruns the deterministic source,
dependency, security, audit, reproducibility, and package gates; creates the universal and four
target VSIX packages plus four native CLI archives and checksums; creates the GitHub Release;
updates the Homebrew and Scoop manifests; and publishes the VSIX set to Open VSX.

Do not print a token, pass it as a command argument, save it in shell history, or commit it. Do not
run `ovsx publish` against a mutable local path as a fallback. If a runner is lost after publishing
starts, inspect Open VSX before retrying because the external outcome may already have succeeded.

## Post-publication verification

- [ ] Confirm the signed `v0.2.0` tag and GitHub Release identify the tested revision.
- [ ] Confirm the GitHub Release contains the universal and four target VSIX packages, all four
      native CLI archives, licenses/notices, and every corresponding checksum.
- [ ] Confirm Open VSX reports `straydog.okf-workbench` version `0.2.0`, the verified publisher,
      icon, README, changelog, license, privacy text, public contact route, and all target packages.
- [ ] Download the published universal VSIX, inspect its metadata and contents, and compare its
      SHA-256 with the release checksum.
- [ ] Install `0.2.0` from Open VSX in a clean supported VSCodium profile and run the minimal
      offline workflow without a development or preinstalled VSIX.
- [ ] Confirm generated workspace files remain after uninstall and no extension-owned background
      process remains.
- [ ] Confirm `koizumikento/stray-tools` contains the `0.2.0` Homebrew formula and Scoop manifest
      with matching GitHub Release checksums.
- [ ] Confirm clean Homebrew and Scoop installs run `okf version` successfully on their supported
      targets.
- [ ] Revoke the one-time token, or record the owner, scope, storage, and rotation date for a
      retained release credential.

## Rollback and unpublish process

Open VSX CLI `1.0.2` exposes publish, download, token, and namespace commands but no unpublish
command. Do not run `vsce unpublish`: that manages the Microsoft Marketplace, not Open VSX.

For a defective but non-malicious release:

1. Stop promotion and announce the affected version and safe workaround through the approved
   public support and release channels.
2. Preserve the published artifact, digest, logs, evidence, and incident timeline.
3. Fix forward with a higher SemVer version, repeat this checklist, and publish only after new
   explicit approval. Registry versions are immutable; never reuse `0.2.0` for different bytes.
4. Ask users to update or uninstall. The extension itself never deletes generated bundles or agent
   instructions.

For a security, privacy, credential, or licensing incident:

1. Revoke the Open VSX token immediately and remove unauthorized namespace members when applicable.
2. Open a private security incident channel; do not put secrets or sensitive bundle data in a
   public issue.
3. Contact the Open VSX project/service support channel and request removal of the exact namespace,
   extension, version, and digest. Record who authorized the request and the registry response.
4. Verify registry search, metadata, and download behavior after the registry action. Do not assume
   removal from search revokes already downloaded or installed copies.
5. Notify affected users with the version, exposure window, indicators, uninstall/update guidance,
   and a known-good digest when available.

## Release record

| Field | `0.2.0` value |
| --- | --- |
| Extension ID | `straydog.okf-workbench` |
| Immutable candidate revision | Pending merge of PR #36 |
| Hosted CI | [PR #36 checks](https://github.com/koizumikento/okf-workbench/pull/36/checks) |
| Hosted compatibility | Pending |
| Hosted package smoke | Pending |
| Headed performance/network | Pass — VS Code `1.129.1`, QR-002 `672 ms` p95/20 samples, QR-003 `d3`, remote `0`, packaged local `2`, internal Webview `2`, other `0` |
| Local universal VSIX | `978017` bytes; SHA-256 `6fcda0bb7da0237d6cef31d4476178611234df6201a059aec366ff057264361b` |
| Node / npm / Rust | `24.18.0` / `11.16.0` / `1.92.0` |
| Signed tag | Pending `v0.2.0` |
| Release workflow | Pending |
| Open VSX listing | <https://open-vsx.org/extension/straydog/okf-workbench> |
| Homebrew / Scoop repository | <https://github.com/koizumikento/stray-tools> |

## Historical publication evidence

- `v0.1.2` is the latest release before this candidate. Its release workflow
  [30245399853](https://github.com/koizumikento/okf-workbench/actions/runs/30245399853)
  completed successfully from tagged commit `b8b6c17`.
- Signed tag `v0.1.0` ran release workflow
  [30233342837](https://github.com/koizumikento/okf-workbench/actions/runs/30233342837),
  which published the GitHub Release, universal and four target Open VSX packages, four CLI
  archives, and the Homebrew/Scoop manifests.
- The prior headed VS Code `1.129.1` record passed QR-002 at `832 ms` p95 across 20 samples and
  QR-003 with `d3`; it remains historical-only and is not used to qualify `0.2.0`.
