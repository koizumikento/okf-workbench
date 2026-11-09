# Release checklist

- Candidate: OKF Workbench `0.4.2`
- Identifier: `straydog.okf-workbench`
- Status: Preparation; not tagged or published
- Authority: the maintainer requested release after PR processing on 2026-11-09;
  PR #91 remains deferred and excluded.
- Publication uses a matching version tag on reviewed `main`, per
  [ADR 0006](decisions/0006-publish-open-vsx-from-version-tags.md).

This release includes reviewed renderer and development-tool maintenance since
published [0.4.1](releases/0.4.1.md). It refreshes current editor qualification pins while preserving the API floor,
performance thresholds, and local-only product boundary. Historical evidence does
not qualify the new version's Wasm identity or package bytes.

## Before tagging

- [x] Maintainer requested release preparation and publication after PR processing.
- [x] Manifest, npm/Cargo lockfiles, package checks, and assertions use `0.4.2`.
- [x] Changelog has a dated `0.4.2` entry covering changes since released `0.4.1`.
- [ ] Exact final candidate passes source, Rust, unit, acceptance, security, browser,
      minimum/current editor integration, notices, full-tree audit, and package checks.
- [ ] Fresh Package smoke completes all six jobs, with reproducible universal/target
      VSIX contents, standalone/bundled CLI parity, and aggregate package-set checks.
- [ ] Fresh Compatibility completes all nine jobs, including seven editor/OS lifecycle
      lanes and checksum-verified published-0.4.1 upgrade (not the CI 0.0.0 fixture).
- [ ] Exact final candidate has strict-passing genuine headed-editor QR-002, QR-003,
      and network evidence. Retain raw capture, original build receipt, and byte parity.
- [ ] Candidate changes are reviewed and merged into protected main with required checks.
- [ ] Final reviewed main passes required checks and matches qualified package inputs.
- [ ] Confirm `v0.4.2` is absent locally, remotely, and in Open VSX immediately before tagging.

Record actual results in [the release record](releases/0.4.2.md). Documentation-only
final updates still require successful latest-head CI and protected merge.

## Publication

1. Recheck the exact reviewed main commit, qualified bytes, and successful required checks.
2. Create annotated tag `v0.4.2`, inspect its target, verify main containment, and push it.
3. Observe the existing tag-triggered release workflow. It validates and retains packages,
   creates the GitHub Release, and publishes Open VSX and Homebrew/Scoop manifests.
4. Verify all 18 released assets and checksums, CLI/VSIX parity, all five Open VSX
   packages, and package-manager manifest versions and archive digests.
5. Record actual post-publication lifecycle results and any remaining limits in
   [the 0.4.2 record](releases/0.4.2.md).

Do not print tokens, add credentials, bypass protection, publish locally as a fallback,
or reuse a version/tag for different bytes. Missing authorization fails closed.
