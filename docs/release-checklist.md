# Release checklist

- Candidate: OKF Workbench `0.1.0`
- Target identifier: `straydog.okf-workbench`
- Registry: Open VSX
- Current disposition: **Hold**
- Publication authority: a matching `v*` tag pushed for a reviewed commit contained in `main`

This checklist prepares a release candidate; it does not authorize publication. Mark a gate only
from retained evidence. A configured workflow, passing component test, or absent observation is
not a substitute for its named manual or hosted check.

## Release blockers

- [x] The maintainer selected MIT for the project on 2026-07-23, added the matching root
      `LICENSE`, updated the manifest and lockfile identifier, and approved distributing the
      project's own code under those terms.
- [ ] The generated third-party notices and combined distribution obligations have received the
      required human review, including the separate locked Rust/Wasm inventory in
      `RUST_THIRD_PARTY_NOTICES.md`.
- [ ] All confirmed findings and proof gaps in
      [security and privacy evidence](security-privacy-evidence.md) are fixed, accepted by the
      named authority, or closed with retained evidence; no release-blocking item remains.
- [x] A fresh full schema-v3 headed-editor measurement passes QR-002, QR-003, and the strict CDP
      Webview-network observation; compares `d3` and `ngraph`; matches the current manifest,
      production/runtime, diagnostics-observer, runner, and harness identities; obtains genuine
      same-revision diagnostics correlation; proves graph WebGL clears/draws and interaction
      outcomes; and records the reviewed release default in
      [performance evidence](performance-evidence.md). The retained older capture predates this
      strengthened contract and is historical-only.
- [x] The exact `581830`-byte candidate from commit
      `524eca3f36e1a1b3da935495d3fbbd0eb0d03f56`, SHA-256
      `65c137822052aa7f90ef08cc1300020fec4adcd7cbcec6aec88ae98fae64dad0`, passed clean,
      untrusted, upgrade, and uninstall lifecycles in all three local macOS arm64 editor lanes;
      this is preserved local predecessor evidence, not evidence for either the historical hosted
      candidate or the current candidate.
- [x] Historical evidence: the exact `582231`-byte candidate from commit
      `aa90832aab64dac1bccf9c9092fabc004991f7b1`, SHA-256
      `cc8c994cd35cfe2017945c38d0019f330cb33f628a94bf6508b2930c5c57c866`, passed the
      [hosted Compatibility run](https://github.com/koizumikento/okf-workbench/actions/runs/29900868002)
      with VS Code `1.127.0` as its then-current lane. This does not qualify the current candidate.
- [ ] The current bundled-CLI candidate has successful retained artifacts from every lane in the
      [compatibility matrix](compatibility-matrix.md): VS Code `1.121.0` on Ubuntu, VS Code
      `1.129.1` on Ubuntu/macOS/Windows, and VSCodium `1.121.03429` on Ubuntu/macOS/Windows.
      [Compatibility run 30058922150](https://github.com/koizumikento/okf-workbench/actions/runs/30058922150)
      qualifies only the prior universal candidate.
- [x] Historical evidence: the workflow-level package gate compared all three retained OS artifacts and passed
      in [Package smoke run 29901183164](https://github.com/koizumikento/okf-workbench/actions/runs/29901183164)
      for the exact recorded digest and byte size.
- [ ] The current candidate passes the four-target package-set gate for macOS arm64/x64, Linux
      x64, and Windows x64, including canonical Wasm identity and standalone/bundled CLI parity.
      [Package smoke run 30058925030](https://github.com/koizumikento/okf-workbench/actions/runs/30058925030)
      qualifies only the prior universal candidate.
- [ ] Packaged-editor evidence plus manual inspection closes the remaining user-scenario gaps in
      [acceptance evidence](acceptance-evidence.md); current-candidate hosted lifecycle evidence is
      retained, but the workflow does not exercise every interactive command UI.
- [x] The public Open VSX registry reports namespace `straydog` as verified and restricted, and
      `straydog.okf-workbench@0.1.0` as available; the retained check is
      [Open VSX registry evidence](evidence/open-vsx-registry.json), and the candidate workflow
      repeats it without a token.
- [ ] The authenticated publishing identity has current `straydog` authorization, a valid PAT,
      and a signed current Open VSX Publisher Agreement.
- [x] The listing provides durable public repository, issue, homepage, privacy, support, security,
      license, and notice routes. GitHub private vulnerability reporting is enabled, and the
      project license, security policy, and generated third-party notices are packaged.
- [x] The repository secret name `OPEN_VSX_TOKEN` exists and is referenced only by the
      authorization and publication steps. Its value remains unreadable through GitHub APIs and
      is validated at release time with `ovsx verify-pat straydog`.
- [x] The repository secret names `TAP_REPO` and `STRAY_TOOLS_TOKEN` exist. They are exposed only
      to the package-repository push step; their values and current write authorization remain
      unreadable through GitHub APIs and are validated by the tagged workflow.
- [ ] The maintainer has reviewed the final `main` commit and is ready to authorize publication by
      pushing its matching version tag.
- [ ] The Rust/Wasm core migration has fresh current-candidate CI, compatibility, package-smoke,
      headed Webview performance/network, and packaged-editor evidence; predecessor candidate
      results do not qualify the new Wasm bytes.

## Version, changelog, and links

- [x] `package.json` has `publisher: "straydog"`, `name: "okf-workbench"`, and `version: "0.1.0"`.
- [x] The root `name`, `version`, `license`, and dependency metadata represented in
      `package-lock.json` match `package.json`. The current matching license value is `MIT`.
- [x] The extension identifier is consistently `straydog.okf-workbench` in package checks,
      integration tests, workflows, evidence documents, and release notes.
- [ ] `CHANGELOG.md` contains exactly one `0.1.0` entry and `Unreleased` is replaced with the
      intended publication date before the immutable candidate is built. If that date changes,
      rebuild, requalify, and reapprove the new bytes.
- [x] The public manifest contains the exact approved public `repository`, `bugs`, and `homepage`
      values; the packaged README and changelog contain no excluded-documentation or speculative
      release-tag links.
- [x] The public GitHub Pages support and security routes return successfully without requiring
      authentication, the issue tracker is public, and GitHub private vulnerability reporting is
      enabled.
- [x] The packaged README states privacy behavior, MIT licensing, and bundled third-party notices
      inline; the VSIX carries the corresponding license and notice files.
- [x] The 128×128-or-larger PNG icon is referenced by the manifest and present in the VSIX.

## Build the immutable candidate

1. Freeze every packaged reader-facing file first: manifest, MIT license, generated third-party
   notices, README, changelog (including intended publication date), icon, approved public contact
   route, and runtime bundles. Start from that intended clean commit and record its full revision.
2. Use Node.js `24.18.0`, npm `11.16.0`, Rust `1.92.0`, and the pinned
   `wasm32-unknown-unknown` target.
3. Install from the committed lockfile and run all local release gates:

   The retained `vscode-1.127.0` JSON and Markdown are versioned historical archives and
   intentionally fail the strict command. The canonical current-candidate paths are
   `docs/evidence/performance/vscode-1.129.1.json` and `.md`; create them only from a fresh genuine
   current-run headed capture of the frozen candidate before treating this step as passable.

   ```sh
   mise x node@24.18.0 -- npm ci
   mise x node@24.18.0 -- npx --no-install playwright install chromium
   mise x node@24.18.0 -- npm run check
   mise x node@24.18.0 -- env VSCODE_TEST_VERSION=1.121.0 npm run test:integration
   mise x node@24.18.0 -- env VSCODE_TEST_VERSION=1.129.1 npm run test:integration
   mise x node@24.18.0 -- npm run test:webview
   mise x node@24.18.0 -- npm run package
   mise x node@24.18.0 -- node scripts/benchmark-report.mjs \
     --measurements docs/evidence/performance/vscode-1.129.1.json \
     --require-passing \
     > artifacts/performance/vscode-1.129.1-release-check.md
   cmp docs/evidence/performance/vscode-1.129.1.md artifacts/performance/vscode-1.129.1-release-check.md
   mise x node@24.18.0 -- npm run package:check
   mise x node@24.18.0 -- node scripts/security-check.mjs --check-notices
   mise x node@24.18.0 -- npm run rust:notices:check
   mise x node@24.18.0 -- node scripts/security-check.mjs --vsix artifacts/okf-workbench.vsix
   mise x node@24.18.0 -- npm audit --omit=dev --audit-level=high
   ```

4. Record `shasum -a 256 artifacts/okf-workbench.vsix`, byte size, revision, build environment,
   exact package versions, and all command outputs in the release record.
   `package:check` and the packaged security gate must both confirm that `extension/LICENSE.txt` is
   the sole project-license entry, exactly matches the root `LICENSE`, and is paired with packaged
   manifest value `MIT`; both npm and Rust/Wasm notice files must exactly match their reviewed
   locked graphs; `extension.vsixmanifest` must reference that exact path in its license declaration
   and addressable content-license asset and contain no private marketplace links.
5. Run the manual `Compatibility` workflow for that revision and retain every per-lane JSON
   artifact. Supply a genuinely older VSIX and digest when upgrade evidence is required.
6. Complete the headed GPU/network checks on the same immutable candidate and attach the raw
   evidence without adding workspace content or secrets to the repository.
7. Install the final VSIX by digest and manually inspect every user-visible command, listing page,
   icon, changelog, inline privacy statement, and approved public contact route.
8. Apply any final evidence or release-record edits before tagging, review the complete diff, and
   rerun the affected checks. The tagged `main` commit is the release revision; do not move or reuse
   the tag after publication.

If any source, dependency, manifest, notice, icon, README, changelog, or packaged file changes,
discard the previous digest and repeat the relevant gates. Never publish a locally rebuilt
artifact under an already approved digest.

## Approval and publication

### Version-tag workflow boundary

Per [ADR 0006](decisions/0006-publish-open-vsx-from-version-tags.md), the `Open VSX release`
workflow is the only automated publication path. It runs only when a `v*` tag is pushed. The tag is
the maintainer's release authorization; pull requests, ordinary branch pushes, and reusable
workflow calls cannot invoke publication.

Before pushing the tag:

1. complete every unchecked release blocker above;
2. update `CHANGELOG.md` from `Unreleased` to the intended publication date;
3. merge the reviewed release commit into protected `main`;
4. confirm the tag will be exactly `v<package.json version>`; and
5. confirm `OPEN_VSX_TOKEN` is the intended narrowly scoped credential, its owner remains a
   `straydog` namespace member, and the Open VSX Publisher Agreement is current.

Push the tag only after those checks:

```sh
git tag -s v0.1.0 -m "OKF Workbench 0.1.0"
git push origin v0.1.0
```

The workflow rejects a tag whose commit is not contained in `main`, whose version does not match
the manifest, or whose changelog entry is still `Unreleased`. It installs the exact lockfiles,
reruns the deterministic source, dependency, Node security, audit, package, reproducibility, and
packaged security gates, and retains the universal VSIX plus its checksum and canonical Wasm.
Native jobs test and build the `okf` CLI on macOS arm64/x86-64, Linux x86-64, and Windows x86-64.
Each job feeds the exact same executable bytes into a target-platform VSIX and a standalone archive
with the MIT license, Rust third-party notices, and checksums. Raw copy, manifest, byte-length, and
SHA-256 parity must pass before a separate job creates or updates the matching GitHub Release.

After the GitHub Release exists, one publication job verifies the retained macOS and Windows CLI
archive checksums, generates the Homebrew formula and Scoop manifest twice, requires byte-identical
outputs, validates their Ruby and JSON structure, and exposes `TAP_REPO` plus
`STRAY_TOOLS_TOKEN` only while updating `Formula/okf.rb` and `bucket/okf.json`. A separate job
downloads all five retained VSIX packages, verifies their checksums, installs the locked `ovsx`
`1.0.2` CLI without lifecycle scripts, and exposes `OPEN_VSX_TOKEN` only to
`ovsx verify-pat straydog` and `ovsx publish`. Missing or invalid authorization fails the workflow.
The Open VSX publish command uses duplicate-safe retry behavior, but a registry version remains
immutable; changed bytes require a higher SemVer version and a new tag.

Do not print the token, pass it as a command argument, save it in shell history, or commit it. Do
not run `ovsx publish` against a mutable local path as a fallback. If a runner is lost after the
publish command starts, inspect Open VSX before retrying because the external outcome may already
have succeeded.

**Current proof gap:** the repository-level secret name `OPEN_VSX_TOKEN` exists, and the same
`straydog` publishing pattern has succeeded in the `shosei` repository. GitHub does not reveal
secret values, so OKF Workbench's credential and current namespace authorization remain unproven
until the tagged workflow runs `ovsx verify-pat straydog`. The current Publisher Agreement state
also remains an out-of-band maintainer check. No OKF Workbench release tag, GitHub Release, or Open
VSX publication has been created.

The official process and current account requirements are documented in
[Publishing Extensions](https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions).

## Post-publication verification

- [ ] Open `https://open-vsx.org/extension/straydog/okf-workbench` and confirm publisher, verified
      state, version, icon, README, changelog, license, inline privacy text, public contact route,
      deliberate source-link omissions, and categories.
- [ ] Confirm the registry reports `straydog.okf-workbench` version `0.1.0` and the publishing
      identity expected by the approval record.
- [ ] Download the published version with `ovsx get`, inspect its metadata and contents, and record
      the downloaded SHA-256. Investigate any difference from the approved artifact before calling
      the release complete.
- [ ] Install from Open VSX in a clean supported VSCodium profile, activate every command, and run
      the minimal offline workflow without using a development or preinstalled VSIX.
- [ ] Confirm generated workspace files remain after uninstall and that uninstall leaves no
      extension-owned background process.
- [ ] Confirm the signed Git tag and generated GitHub Release identify the tested revision and
      contain the universal and four target VSIX packages, all four native CLI archives, their licenses and notices, and
      every corresponding checksum.
- [ ] Confirm `koizumikento/stray-tools` contains the released `Formula/okf.rb` and
      `bucket/okf.json`, that both reference the matching GitHub Release checksums, and that clean
      Homebrew and Scoop installs run `okf version` successfully on their supported targets.
- [ ] Revoke the one-time token, or record the owner, scope, storage, and rotation date for a
      retained release credential.

## Rollback and unpublish process

Open VSX CLI `1.0.2` exposes publish, download, token, and namespace commands but no unpublish
command. Do not run `vsce unpublish`: that manages the Microsoft Marketplace, not Open VSX.

For a defective but non-malicious release:

1. Stop promotion and announce the affected version and safe workaround through the approved
   public support and release channels.
2. Preserve the published artifact, digest, logs, evidence, and incident timeline.
3. Fix forward with a higher SemVer version, repeat this entire checklist, and publish only after a
   new explicit approval. A registry version is immutable; never reuse `0.1.0` for different bytes.
4. Ask users to update or uninstall. The extension itself never deletes their generated bundles or
   agent instructions.

For a security, privacy, credential, or licensing incident:

1. Revoke the Open VSX token immediately and remove unauthorized namespace members when applicable.
2. Open a private security incident channel; do not put secrets or sensitive bundle data in a
   public issue.
3. Contact the public Open VSX service through its documented project/service support channel and
   request unpublication or removal of the exact namespace, extension, version, and digest. Record
   who authorized the request and the registry response.
4. Verify registry search, metadata, and download behavior after the registry action. Do not assume
   removal from search revokes already downloaded or installed copies.
5. Notify affected users with version, exposure window, indicators, uninstall/update guidance, and
   a known-good digest when available.

The [Open VSX project page](https://open-vsx.org/about) points namespace and publishing questions
to the registry's wiki and support channels. Destructive registry removal is a maintainer action,
not an automated fallback in this repository.

## Release record

| Field | Value |
| --- | --- |
| Version | `0.1.0` |
| Extension ID | `straydog.okf-workbench` |
| Current candidate artifact-content revision | Pending merge commit |
| Current hosted-evidence revision | Pending fresh CI, Compatibility, and four-target Package smoke |
| Current candidate VSIX SHA-256 | Local `darwin-arm64`: `c17cc9b1f15614fb53d88f42552c70a71be4f4015c3b4662c4e67f5c4c26624e`; other target and hosted digests pending |
| Current candidate VSIX byte size | Local `darwin-arm64`: `1571230` bytes; other target and hosted sizes pending |
| Node / npm | `24.18.0` / `11.16.0` |
| Current hosted CI | Pending |
| Current hosted compatibility | Pending |
| Current hosted package smoke | Pending four-target run |
| Prior universal hosted qualification | [CI 30058782170](https://github.com/koizumikento/okf-workbench/actions/runs/30058782170), [Compatibility 30058922150](https://github.com/koizumikento/okf-workbench/actions/runs/30058922150), and [Package smoke 30058925030](https://github.com/koizumikento/okf-workbench/actions/runs/30058925030) passed for SHA-256 `d7be6180cd788b2ab5d9c7fc436de9eb2df97d967b16ccbc2578f48851f0b666`, `613637` bytes. |
| Historical hosted-qualified artifact | Commit `aa90832aab64dac1bccf9c9092fabc004991f7b1`; SHA-256 `cc8c994cd35cfe2017945c38d0019f330cb33f628a94bf6508b2930c5c57c866`; `582231` bytes. |
| Historical hosted CI | [Pass — run 29900857588](https://github.com/koizumikento/okf-workbench/actions/runs/29900857588); all four jobs for that historical candidate succeeded. |
| Historical hosted compatibility | [Pass — run 29900868002](https://github.com/koizumikento/okf-workbench/actions/runs/29900868002); all seven then-required lifecycle lanes, including VS Code `1.127.0`, succeeded for that historical candidate. |
| Historical hosted package smoke | [Pass — run 29900868155](https://github.com/koizumikento/okf-workbench/actions/runs/29900868155); macOS, Ubuntu, and Windows independently produced the historical `582231`-byte digest. |
| Historical cross-platform package gate revision | `6505a7f7b017a44a851ab6edaaba28f6b6a72105`; workflow, checker, test, and documentation only, so the historical qualified VSIX content and digest were unchanged. |
| Historical workflow-gate CI | [Pass — run 29901152549](https://github.com/koizumikento/okf-workbench/actions/runs/29901152549); all four jobs succeeded at that historical cross-platform package gate revision. |
| Historical aggregate package gate | [Pass — run 29901183164](https://github.com/koizumikento/okf-workbench/actions/runs/29901183164); all three OS jobs and the aggregate byte-identity job succeeded for the historical SHA-256 `cc8c994cd35cfe2017945c38d0019f330cb33f628a94bf6508b2930c5c57c866`, `582231` bytes, and three artifacts. |
| Preserved local predecessor evidence | Pass — commit `524eca3f36e1a1b3da935495d3fbbd0eb0d03f56`, `581830` bytes, SHA-256 `65c137822052aa7f90ef08cc1300020fec4adcd7cbcec6aec88ae98fae64dad0`; VS Code `1.121.0`, VS Code `1.127.0`, and VSCodium `1.121.03429` on macOS arm64. |
| Headed performance evidence | Pass — genuine headed VS Code `1.129.1` schema-v3 capture at `2026-07-23T09:59:23.073Z`; QR-002 `832 ms` p95 across 20 samples, QR-003 selected `d3`, and strict CDP counts were remote `0`, packaged local `2`, internal Webview `2`, other `0`. Raw evidence SHA-256: `0fd512512c0ff3d8fecbecd1c50d87bc6a727f2dad68fca3403ed8b400f7d3f5`. |
| Security/license approver | Pending |
| Namespace/publishing identity | Public API pass at `2026-07-23T08:35:06.452Z`: `straydog` verified/restricted and `straydog.okf-workbench@0.1.0` available; authenticated PAT/role and Publisher Agreement evidence pending. |
| Version-tag authorization | Pending — no release tag has been pushed. |
| Open VSX listing URL | Pending |
| Downloaded artifact SHA-256 | Pending |
| Post-publish VSCodium verification | Pending |
| Token revocation/rotation record | Pending |
