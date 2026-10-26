# Release checklist

- Candidate: OKF Workbench `0.4.1`
- Identifier: `straydog.okf-workbench`
- Status: Preparation; not tagged or published
- Authority: the maintainer authorized this maintenance release on 2026-10-26.
- Publication uses a matching version tag on reviewed `main`, per
  [ADR 0006](decisions/0006-publish-open-vsx-from-version-tags.md).

The release updates development tooling and security overrides and refreshes current
stable editor qualification. It preserves the VS Code API floor and production dependency
boundary. The published predecessor remains [0.4.0](releases/0.4.0.md); its completed
checklist is retained in that version's Git history.

## Before tagging

- [x] Maintainer authorized release preparation and publication.
- [x] Manifest, npm/Cargo lockfiles, package checks, and assertions use `0.4.1`.
- [x] Changelog has a dated `0.4.1` entry.
- [ ] Final candidate passes source, Rust, unit, acceptance, security, browser,
      minimum/current editor integration, notices, full-tree audit, and package checks.
- [ ] Reproducible universal and target VSIX contents preserve the approved boundaries.
- [x] Current stable VS Code `1.143.1` and VSCodium `1.140.06880` pass local Linux packaged lifecycle
      tests, including upgrade from the checksum-verified published `v0.4.0` VSIX.
- [ ] Exact final candidate has strict-passing headed-editor QR-002, QR-003, and network
      evidence. Older or headless receipts cannot satisfy this gate.
- [ ] Required compatibility and platform package gates pass on the final packaged inputs.
- [ ] Candidate changes are reviewed and merged into protected main with required checks.
- [ ] Confirm `v0.4.1` is absent locally, remotely, and in Open VSX.

## Publication

1. Recheck the exact reviewed main commit and successful required checks.
2. Create annotated tag `v0.4.1`, inspect its target, verify main containment, and push it.
3. Observe the existing tag-triggered release workflow. It validates and retains packages,
   creates the GitHub Release, and publishes Open VSX and Homebrew/Scoop manifests.
4. Verify all 18 released assets and checksums, CLI/VSIX parity, all five Open VSX
   packages, and package-manager manifest versions and archive digests.
5. Record actual post-publication lifecycle results and any remaining limits in
   [the 0.4.1 record](releases/0.4.1.md).

Do not print tokens, add credentials, bypass protection, publish locally as a fallback,
or reuse a version/tag for different bytes. Missing authorization fails closed.
