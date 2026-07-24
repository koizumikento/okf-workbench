# Release checklist

- Candidate: OKF Workbench `0.1.0`
- Target identifier: `straydog.okf-workbench`
- Registry: Open VSX
- Current disposition: **Hold**
- Publication authority: explicit approval from the maintainer for one recorded VSIX digest

This checklist prepares a release candidate; it does not authorize publication. Mark a gate only
from retained evidence. A configured workflow, passing component test, or absent observation is
not a substitute for its named manual or hosted check.

## Release blockers

- [x] The maintainer selected MIT for the project on 2026-07-23, added the matching root
      `LICENSE`, updated the manifest and lockfile identifier, and approved distributing the
      project's own code under those terms.
- [ ] The generated third-party notices and combined distribution obligations have received the
      required human review.
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
- [x] The current exact candidate has successful retained artifacts from every lane in the
      [compatibility matrix](compatibility-matrix.md): VS Code `1.121.0` on Ubuntu, VS Code
      `1.129.1` on Ubuntu/macOS/Windows, and VSCodium `1.121.03429` on Ubuntu/macOS/Windows,
      retained by
      [Compatibility run 30058922150](https://github.com/koizumikento/okf-workbench/actions/runs/30058922150).
- [x] Historical evidence: the workflow-level package gate compared all three retained OS artifacts and passed
      in [Package smoke run 29901183164](https://github.com/koizumikento/okf-workbench/actions/runs/29901183164)
      for the exact recorded digest and byte size.
- [x] The current exact candidate passes the cross-platform package-byte identity gate on Ubuntu,
      macOS, and Windows in
      [Package smoke run 30058925030](https://github.com/koizumikento/okf-workbench/actions/runs/30058925030);
      the digest and byte size match CI and Compatibility.
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
- [ ] The maintainer has explicitly approved publication of the exact candidate SHA-256.
- [ ] The GitHub `open-vsx` Environment is protected and independently reviewed as described
      below; its environment-scoped `OVSX_PAT` is not duplicated as a repository or organization
      secret.

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
2. Use Node.js `24.18.0` and npm `11.16.0`.
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
   mise x node@24.18.0 -- node scripts/security-check.mjs --vsix artifacts/okf-workbench.vsix
   mise x node@24.18.0 -- npm audit --omit=dev --audit-level=high
   ```

4. Record `shasum -a 256 artifacts/okf-workbench.vsix`, byte size, revision, build environment,
   exact package versions, and all command outputs in the release record.
   `package:check` and the packaged security gate must both confirm that `extension/LICENSE.txt` is
   the sole project-license entry, exactly matches the root `LICENSE`, and is paired with packaged
   manifest value `MIT`; `extension.vsixmanifest` must reference that exact path in its license
   declaration and addressable content-license asset and contain no private marketplace links.
5. Run the manual `Compatibility` workflow for that revision and retain every per-lane JSON
   artifact. Supply a genuinely older VSIX and digest when upgrade evidence is required.
6. Complete the headed GPU/network checks on the same immutable candidate and attach the raw
   evidence without adding workspace content or secrets to the repository.
7. Install the final VSIX by digest and manually inspect every user-visible command, listing page,
   icon, changelog, inline privacy statement, and approved public contact route.
8. After hosted qualification, a later evidence-record commit may change only receipt fields in
   `docs/acceptance-evidence.md`, `docs/compatibility-matrix.md`,
   `docs/release-checklist.md`, and `docs/security-privacy-evidence.md`. Review the complete
   intervening diff and reject changes to source, dependencies, manifests, locks, build/package
   scripts, workflows, gates, benchmark measurements, or any packaged file. Rebuild twice at that
   default-branch revision and require the same normalized VSIX digest and byte size. Record both
   the artifact-content revision and the later evidence/publication-workflow revision; link
   Compatibility and Package smoke to the artifact by digest rather than pretending the commit IDs
   are identical.

If any source, dependency, manifest, notice, icon, README, changelog, or packaged file changes,
discard the previous digest and repeat the relevant gates. Never publish a locally rebuilt
artifact under an already approved digest.

## Approval and publication

### Protected workflow boundary

The `Open VSX release` workflow in `.github/workflows/open-vsx-release.yml` is the only automated
publication path. It has only a `workflow_dispatch` trigger; pull requests, pushes, reusable
workflow calls, and the ordinary package workflows cannot invoke its publish job or receive its
credential. The candidate job has no Environment or publishing secret. It checks out one exact
40-character commit on the default branch, installs the exact Node/npm/lockfile toolchain, runs the
source, dependency, current-candidate performance, package, security, and minimum-editor
integration gates, then runs
`npm run package` exactly once. It records and retains the resulting VSIX, SHA-256, byte size,
revision, runner, and toolchain. The publish job downloads those same bytes and never checks out,
builds, or packages source.

The root `package.json` setting `"private": true` prevents accidental publication to the npm
registry only. GitHub repository visibility, the MIT license, and Open VSX publication of the
packaged VSIX are separate controls.

Before the workflow can be trusted, a repository administrator must configure a GitHub Environment
named exactly `open-vsx` with all of the following hosted controls:

1. Add required reviewers who are authorized to release `straydog.okf-workbench`. Prevent
   self-review and administrator bypass where the repository plan supports those controls.
   [GitHub's environment rules documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
   describes the available protection rules. The repository is public, so the earlier
   private-repository plan limitation no longer applies; the Environment and its independent
   reviewer still must be configured and verified. The typed workflow input does not replace that
   review.
2. Restrict deployments to the protected release branch or tag policy. Protect the default branch
   with required review and required release checks, and give workflow changes explicit ownership.
3. Store the Open VSX token only as the Environment secret `OVSX_PAT`. Do not create a repository
   or organization secret with that name. Use a new, narrowly scoped credential and verify its
   owner, `straydog` membership, Publisher Agreement status, expiry, and revocation plan out of
   band.
4. Require the Environment reviewer to open the completed candidate job summary and compare its
   extension ID, version, full commit, SHA-256, and retained approval record before approving the
   publish job. Reject the deployment if any value or prerequisite in this checklist is incomplete.
5. Retain the workflow URL, environment approval identity/time, immutable candidate, checksum,
   candidate evidence, and the required pre-publication evidence artifact. The workflow also
   attempts a best-effort publication-step receipt after the irreversible command; that receipt is
   not a substitute for the public post-publication checks below. Revoke or rotate the token after
   publication.

Dispatch the workflow only from its reviewed current default-branch revision. Supply that same
lowercase 40-character source/workflow commit, the exact version, lowercase 64-character normalized
VSIX SHA-256, and this single-line approval value with no substitutions or extra whitespace:

```text
PUBLISH straydog.okf-workbench@<version> SHA256:<digest> COMMIT:<40-character-commit>
```

The candidate job requires `github.ref`, `github.workflow_ref`, `github.workflow_sha`, the dispatch
revision, and the requested candidate commit to identify the same current default-branch workflow
revision. It then validates manifest and lockfile identity, typed approval, and rebuilt digest
before the protected publish job becomes eligible. It also queries the public Open VSX API without
a credential and with cache bypass, fails unless `straydog` is verified and restricted and the
exact target version is available, and retains that JSON inside the release evidence. Every
response must carry a strictly parsed HTTP `Date`; `Age` must be at most 30 seconds when present,
and otherwise `Date` must be no more than the inclusive 30-second window old and must not be in the
future. The retained record names the validation source, effective age, and validation time for
all three responses. After the
Environment approval wait, the publish job repeats the same no-token check immediately before PAT
authorization. It revalidates the downloaded checksum and approval, installs the locked `ovsx`
`1.0.2` CLI without lifecycle scripts, obtains `OVSX_PAT` only for the PAT-verification and
publication steps, and runs `ovsx verify-pat straydog`. After that succeeds, it creates token-free
evidence containing the immediate registry response, authorization result, exact approval binding,
revision, VSIX digest and byte size, toolchain, runner, and workflow identity. Uploading that
complete evidence is a required fail-closed barrier before `ovsx publish` can run. The workflow
then attempts an always-run, best-effort publication-step receipt; receipt creation or upload
cannot turn an otherwise successful irreversible publication into a red workflow that invites an
invalid rerun. The receipt records only the command outcome, not registry availability. A checksum
mismatch requires a new approval; editing the approval in logs or rebuilding in the publish job is
not an allowed recovery. A runner loss, cancellation, or timeout after the publish command starts
has an ambiguous external outcome: inspect the public registry and reconcile the retained
pre-publication evidence before taking any action, and never blindly rerun the same immutable
version.

The `<40-character-commit>` in the approval phrase is the current
evidence/publication-workflow revision, not necessarily the earlier artifact-content revision. A
difference is allowed only under the receipt-only rule in step 8 above, and only when a
deterministic rebuild at the publication-workflow revision reproduces the exact approved digest
and byte size.

**Current proof gap:** a read-only GitHub API check on 2026-07-23 reported zero Environments and
`404 Not Found` for `open-vsx`. The repository-level secret-name list contained
`OPEN_VSX_TOKEN` and `STRAY_TOOLS_TOKEN`, but neither establishes the required protected
Environment or its environment-scoped `OVSX_PAT`; secret values were not accessed. Making the
repository public removed the earlier private-plan eligibility uncertainty, but the hosted
`open-vsx` Environment, required reviewers, deployment restrictions, and environment-scoped
`OVSX_PAT` still have not been configured or observed. No
protected-environment approval, authenticated namespace authorization command, or publication
has been run. The value and purpose of the repository-level `OPEN_VSX_TOKEN` were not inspected:
before publication its owner must confirm whether it is a credential and, if so, revoke or remove
it from repository scope and provision a new narrowly scoped Environment credential; a misleading
name must instead be documented without exposing its value. A public Open VSX API check at
`2026-07-23T08:35:06.452Z` established that `straydog` exists, is verified and restricted, and that
`straydog.okf-workbench@0.1.0` is available. Public metadata still does not prove the current PAT,
exact namespace role, or current profile Agreement status. This remains release-blocking and does
not close security evidence gap `PG-04`. Configuring the Environment or secret and approving a
deployment are maintainer/administrator actions, not part of repository implementation.

The release owner records this statement before running a publishing command:

```text
I approve Open VSX publication of straydog.okf-workbench version 0.1.0,
VSIX SHA-256 <digest>, reproduced by publication-workflow commit <revision>.
Artifact-content commit: <artifact-content-revision>.
Approver: <identity>
Approved at: <timestamp with zone>
```

Use a newly generated or narrowly scoped token, store it only in the protected `open-vsx`
Environment, and expose it as `OVSX_PAT` for the shortest practical period. Do not print it, pass it
as a command argument, save it in shell history, or commit it. Normal publication is performed only
by the protected workflow. Do not run `ovsx publish` against a mutable local path as a fallback; a
failed or rejected workflow requires a new immutable candidate and approval, not a manual bypass.

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
- [ ] Publish the signed Git tag and GitHub release notes for the exact tested revision, attaching
      the approved VSIX and checksums if repository policy allows.
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
| Current candidate artifact-content revision | `e0c1f8895f3dc3391be3de47f1a517f82ae62f3c` |
| Current evidence/publication-workflow revision | `a5b2b75b7216d644f0d8d0f739db3a989bba7ca0` — the later changes from the artifact-content revision affected tests only; the hosted rebuilds reproduced the exact candidate bytes. |
| Current candidate VSIX SHA-256 | `d7be6180cd788b2ab5d9c7fc436de9eb2df97d967b16ccbc2578f48851f0b666` — local, CI, Compatibility, and all three Package smoke artifacts were byte-for-byte identical. |
| Current candidate VSIX byte size | `613637` bytes across the local candidate and all five downloaded hosted VSIX files. |
| Node / npm | `24.18.0` / `11.16.0` |
| Current hosted CI | [Pass — run 30058782170](https://github.com/koizumikento/okf-workbench/actions/runs/30058782170); quality/package, hostile-content Webview, and VS Code `1.121.0`/`1.129.1` integration jobs succeeded at `a5b2b75b7216d644f0d8d0f739db3a989bba7ca0`. |
| Current hosted compatibility | [Pass — run 30058922150](https://github.com/koizumikento/okf-workbench/actions/runs/30058922150); candidate, acceptance/Webview, and all seven current VS Code/VSCodium lifecycle jobs succeeded. Every lifecycle receipt binds the evidence revision, extension identity/version, and current candidate digest. |
| Current hosted package smoke | [Pass — run 30058925030](https://github.com/koizumikento/okf-workbench/actions/runs/30058925030); macOS, Ubuntu, Windows, browser security, and aggregate byte-identity jobs succeeded. |
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
| Publication approver and timestamp | Pending |
| Open VSX listing URL | Pending |
| Downloaded artifact SHA-256 | Pending |
| Post-publish VSCodium verification | Pending |
| Token revocation/rotation record | Pending |
