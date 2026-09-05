# Release checklist

- Candidate: OKF Workbench `0.4.0`
- Identifier: `straydog.okf-workbench`
- Status: Blocked by QR-002 performance and unavailable signing key; not published
- Authority: the maintainer requested this release on 2026-09-05; publication uses a
  matching signed tag on reviewed `main`, per [ADR 0006](decisions/0006-publish-open-vsx-from-version-tags.md).

This release raises the extension target to Node 24 and the VS Code floor to 1.123,
updates development dependencies, and qualifies VSCodium 1.126.04524. The minor version
advance makes the changed editor requirement visible. The native CLI and OKF contract
are unchanged. The completed predecessor record is [0.3.0](releases/0.3.0.md).

## Before tagging

- [x] Maintainer authorized release preparation and publication.
- [x] Manifest, npm/Cargo lockfiles, package checks, and version assertions use 0.4.0.
- [x] Changelog contains the dated 0.4.0 entry and explains the editor requirement.
- [ ] Current candidate passes source, Rust, unit, acceptance, security, browser,
      minimum/current editor integration, notices, production audit, and package checks.
- [ ] Genuine headed VS Code 1.129.1 schema-v3 evidence passes the strict evaluator
      for the current runtime and build-input identities; retain raw JSON and Markdown.
      The retained Windows capture fails at 1,252 ms p95 (limit: 1,000 ms); QR-003 and
      Webview network observation pass. See the [performance record](performance-evidence.md).
- [ ] Hosted Compatibility passes all seven editor/OS lifecycle lanes, using the
      published v0.3.0 universal VSIX and its verified checksum as the upgrade input.
- [ ] Hosted Package smoke passes the browser boundary, four target packages, and
      aggregate consistency on the same packaged-input revision.
- [ ] Version and evidence changes are reviewed and merged into protected main.
- [x] Repository secret names OPEN_VSX_TOKEN, STRAY_TOOLS_TOKEN, and TAP_REPO exist.
      Only the tagged workflow verifies their values and publisher authorization.
- [ ] A signing key is available; verify the signed tag locally before pushing it.

The previous PR #47 validation predates the version change. It does not qualify
0.4.0 package bytes. Any changed packaged input requires the affected gates to run again.

## Publication

1. Confirm v0.4.0 does not exist locally, remotely, or in Open VSX.
2. Confirm the final commit is reviewed, in main, and has passing required CI.
3. Create `git tag -s v0.4.0 -m "OKF Workbench 0.4.0"`, verify it with
   `git tag -v v0.4.0`, then push that tag.
4. Wait for all tagged release jobs to pass. They publish the GitHub Release,
   universal and four target VSIX packages, four CLI archives and checksums,
   Open VSX package set, and Homebrew/Scoop manifests.

Never print tokens, use local ovsx publication as a fallback, or reuse a version/tag
for different bytes. Missing credentials fail closed.

## After publication

- [ ] Verify tag identity, release workflow, all 18 release assets, and checksums.
- [ ] Match all five Open VSX packages to their GitHub Release bytes.
- [ ] Run a clean published VSCodium Windows lifecycle, including 0.3.0 upgrade,
      untrusted/offline behavior, uninstall, and workspace/settings preservation.
- [ ] Verify Homebrew/Scoop manifest version and archive checksums.
- [ ] Run an isolated clean Scoop install, `okf version`, and uninstall.
- [ ] Record any unavailable post-publication checks and credential-disposition gaps.

Record results in [the 0.4.0 release record](releases/0.4.0.md). Existing 0.3.0
receipts remain historical. Open VSX versions are immutable; preserve evidence and
fix forward with a higher version if publication reveals a defect.
