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

- [ ] The maintainer has selected the project license, added the matching root license file,
      updated the manifest license identifier, and approved public distribution.
- [ ] The generated third-party notices and combined distribution obligations have received the
      required human review.
- [ ] All confirmed findings and proof gaps in
      [security and privacy evidence](security-privacy-evidence.md) are fixed, accepted by the
      named authority, or closed with retained evidence; no release-blocking item remains.
- [x] A complete schema-v2 headed-editor measurement passes QR-002 and QR-003, compares or safely
      reuses the `d3` and `ngraph` measurements, matches the current manifest, exact graph
      dependency, Webview SHA-256, and combined Extension Host + Webview SHA-256, and records the
      reviewed release default in [performance evidence](performance-evidence.md).
- [ ] Every required editor/OS lane has a successful retained artifact from the
      [compatibility matrix](compatibility-matrix.md), including actual VSCodium runs.
- [ ] Packaged-editor evidence closes the required acceptance gaps in
      [acceptance evidence](acceptance-evidence.md).
- [ ] The publishing identity is an authorized member of the verified, restricted `straydog`
      namespace and has signed the current Open VSX Publisher Agreement.
- [ ] Marketplace-facing repository, support, privacy, license, and notice resources are readable
      without access to the private development repository, or the maintainer has approved and
      validated durable public replacements.
- [ ] The maintainer has explicitly approved publication of the exact candidate SHA-256.
- [ ] The GitHub `open-vsx` Environment is protected and independently reviewed as described
      below; its environment-scoped `OVSX_PAT` is not duplicated as a repository or organization
      secret.

## Version, changelog, and links

- [x] `package.json` has `publisher: "straydog"`, `name: "okf-workbench"`, and `version: "0.1.0"`.
- [x] The root `name`, `version`, `license`, and dependency metadata represented in
      `package-lock.json` match `package.json`. The current matching value is `UNLICENSED`; this
      consistency check does not close the separate project-license blocker.
- [x] The extension identifier is consistently `straydog.okf-workbench` in package checks,
      integration tests, workflows, evidence documents, and release notes.
- [ ] `CHANGELOG.md` contains exactly one `0.1.0` entry and `Unreleased` has been replaced with the
      actual release date immediately before publication.
- [ ] The release tag and GitHub release are planned as `v0.1.0`; the tag points to the tested
      commit and is not moved after publication.
- [ ] `README.md`, `docs/open-vsx-listing.md`, repository, issue, homepage, privacy, support,
      license, and third-party-notice links resolve from the packaged artifact.
- [x] The 128×128-or-larger PNG icon is referenced by the manifest and present in the VSIX.

## Build the immutable candidate

1. Start from the intended clean commit and record its full revision.
2. Use Node.js `24.18.0` and npm `11.16.0`.
3. Install from the committed lockfile and run all local release gates:

   ```sh
   mise x node@24.18.0 -- npm ci
   mise x node@24.18.0 -- npm run check
   mise x node@24.18.0 -- npm run test:acceptance
   mise x node@24.18.0 -- npm run test:security
   mise x node@24.18.0 -- npm run test:integration
   mise x node@24.18.0 -- npm run test:webview
   mise x node@24.18.0 -- npm run test:security:webview
   mise x node@24.18.0 -- npm run package
   mise x node@24.18.0 -- npm run benchmark:report -- --measurements docs/evidence/performance/vscode-1.127.0.json --require-passing
   mise x node@24.18.0 -- npm run package:check
   mise x node@24.18.0 -- node scripts/security-check.mjs --check-notices
   mise x node@24.18.0 -- node scripts/security-check.mjs --vsix artifacts/okf-workbench.vsix
   mise x node@24.18.0 -- npm audit --omit=dev --audit-level=high
   ```

4. Record `shasum -a 256 artifacts/okf-workbench.vsix`, byte size, revision, build environment,
   exact package versions, and all command outputs in the release record.
5. Run the manual `Compatibility` workflow for that revision and retain every per-lane JSON
   artifact. Supply a genuinely older VSIX and digest when upgrade evidence is required.
6. Complete the headed GPU/network checks on the same immutable candidate and attach the raw
   evidence without adding workspace content or secrets to the repository.
7. Install the final VSIX by digest and manually inspect every user-visible command, listing page,
   icon, changelog, privacy statement, and support link.

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

Before the workflow can be trusted, a repository administrator must configure a GitHub Environment
named exactly `open-vsx` with all of the following hosted controls:

1. Add required reviewers who are authorized to release `straydog.okf-workbench`. Prevent
   self-review and administrator bypass where the repository plan supports those controls.
   [GitHub's environment rules documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
   states that required reviewers for private repositories are not available on GitHub Free, Pro,
   or Team. Confirm that this private repository's plan supports the control; if it does not,
   upgrade the plan or keep publication on hold. The typed workflow input does not replace an
   independent Environment review.
2. Restrict deployments to the protected release branch or tag policy. Protect the default branch
   with required review and required release checks, and give workflow changes explicit ownership.
3. Store the Open VSX token only as the Environment secret `OVSX_PAT`. Do not create a repository
   or organization secret with that name. Use a new, narrowly scoped credential and verify its
   owner, `straydog` membership, Publisher Agreement status, expiry, and revocation plan out of
   band.
4. Require the Environment reviewer to open the completed candidate job summary and compare its
   extension ID, version, full commit, SHA-256, and retained approval record before approving the
   publish job. Reject the deployment if any value or prerequisite in this checklist is incomplete.
5. Retain the workflow URL, environment approval identity/time, release evidence JSON, checksum,
   and immutable VSIX with the release record. Revoke or rotate the token after publication.

Dispatch the workflow only from its reviewed current default-branch revision. Supply that same
lowercase 40-character source/workflow commit, the exact version, lowercase 64-character normalized
VSIX SHA-256, and this single-line approval value with no substitutions or extra whitespace:

```text
PUBLISH straydog.okf-workbench@<version> SHA256:<digest> COMMIT:<40-character-commit>
```

The candidate job requires `github.ref`, `github.workflow_ref`, `github.workflow_sha`, the dispatch
revision, and the requested candidate commit to identify the same current default-branch workflow
revision. It then validates manifest and lockfile identity, typed approval, and rebuilt digest
before the protected publish job becomes eligible. The publish job revalidates the downloaded
checksum and approval, installs the locked `ovsx` `1.0.2` CLI without lifecycle scripts, obtains
`OVSX_PAT` only for the two registry command steps, runs `ovsx verify-pat straydog`, and publishes
the downloaded VSIX path. A checksum mismatch requires a new approval; editing the approval in
logs or rebuilding in the publish job is not an allowed recovery.

**Current proof gap:** a read-only GitHub API check on 2026-07-22 reported zero Environments and
`404 Not Found` for `open-vsx`; the repository secret-name list was empty. The API response did not
establish whether the current plan supports required reviewers for this private repository. Thus
the hosted `open-vsx` Environment, required reviewers, deployment restrictions, plan eligibility,
and environment-scoped `OVSX_PAT` have not been configured or observed. No protected-environment
approval, namespace authorization command, or publication has been run. This remains
release-blocking and does not close security evidence gap `PG-04`. Configuring the Environment or
secret and approving a deployment are maintainer/administrator actions, not part of repository
implementation.

The release owner records this statement before running a publishing command:

```text
I approve Open VSX publication of straydog.okf-workbench version 0.1.0,
VSIX SHA-256 <digest>, built from commit <revision>.
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
      state, version, icon, README, changelog, license, privacy, support, repository, and categories.
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

1. Stop promotion and announce the affected version and safe workaround through the GitHub release
   and issue tracker.
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
| Git revision | Pending |
| VSIX SHA-256 | Pending |
| VSIX byte size | Pending |
| Node / npm | `24.18.0` / `11.16.0` |
| Compatibility workflow URL | Pending |
| Headed performance evidence | Pass — QR-002 703 ms p95 / 20 samples; QR-003 `d3`; Webview `853502f50117c6b565b8a9befdb474e1cbaf39bf78b8b7eb6aa3d52f92266d7b`; combined `93c75712626c20bee2b77ad74810267733c6457da85ad89c595772ac6e6d92ad` |
| Security/license approver | Pending |
| Namespace/publishing identity | Pending |
| Publication approver and timestamp | Pending |
| Open VSX listing URL | Pending |
| Downloaded artifact SHA-256 | Pending |
| Post-publish VSCodium verification | Pending |
| Token revocation/rotation record | Pending |
