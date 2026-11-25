# Release checklist

- Candidate: OKF Workbench `0.4.3`
- Identifier: `straydog.okf-workbench`
- Status: Published and distribution verified on 2026-11-25
- Authority: the maintainer requested release after PR processing on 2026-11-25;
  PR #91 remains deferred; #96 was closed unmerged. Neither is included.
- Publication uses a matching version tag on reviewed `main`, per
  [ADR 0006](decisions/0006-publish-open-vsx-from-version-tags.md).

This release includes reviewed development-tool and test-infrastructure maintenance since
published [0.4.2](releases/0.4.2.md). It refreshes current editor qualification pins while preserving the API floor,
performance thresholds, and local-only product boundary. Historical evidence does
not qualify the new version's Wasm identity or package bytes.

## Before tagging

- [x] Maintainer requested release preparation and publication after PR processing.
- [x] Manifest, npm/Cargo lockfiles, package checks, and assertions use `0.4.3`.
- [x] Changelog has a dated `0.4.3` entry covering changes since released `0.4.2`.
- [x] Exact final candidate passes source, Rust, unit, acceptance, security, browser,
      minimum/current editor integration, notices, full-tree audit, and package checks.
- [x] Fresh Package smoke completes all six jobs, with reproducible universal/target
      VSIX contents, native-build/bundled CLI parity, and aggregate package-set checks.
- [x] Fresh Compatibility completes all nine jobs, including seven editor/OS lifecycle
      lanes and checksum-verified published-0.4.2 upgrade (not the CI 0.0.0 fixture).
- [ ] Genuine local headed-editor QR-002, QR-003, and network evidence: not run for
      `0.4.3` at the maintainer's direction. This is a one-release exception, not a
      change to thresholds, the standing qualification procedure, or any hosted gate.
      Do not make a new local or physical performance claim for this release.
- [x] Candidate changes are reviewed and merged into protected main with required checks.
- [x] Final reviewed main passes required checks and matches qualified package inputs.
- [x] Confirm `v0.4.3` is absent locally, remotely, and in Open VSX immediately before tagging.

Record actual results in [the release record](releases/0.4.3.md). Documentation-only
final updates still require successful latest-head CI and protected merge.

## Publication

1. Recheck the exact reviewed main commit, qualified bytes, and successful required checks.
2. Create annotated tag `v0.4.3`, inspect its target, verify main containment, and push it.
3. Observe the existing tag-triggered release workflow. It validates and retains packages,
   creates the GitHub Release, and publishes Open VSX and Homebrew/Scoop manifests.
4. Verify all 18 released assets and checksums, CLI/VSIX parity, all five Open VSX
   packages, and package-manager manifest versions and archive digests.
5. Record actual post-publication lifecycle results and any remaining limits in
   [the 0.4.3 record](releases/0.4.3.md).

Do not print tokens, add credentials, bypass protection, publish locally as a fallback,
or reuse a version/tag for different bytes. Missing authorization fails closed.
