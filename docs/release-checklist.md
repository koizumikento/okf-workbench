# Release checklist

- Candidate: OKF Workbench `0.3.0`
- Target identifier: `straydog.okf-workbench`
- Registry: Open VSX
- Candidate disposition: **Not yet published**
- Publication authority: a matching signed `v*` tag pushed for a reviewed commit contained in
  `main`

This checklist prepares the `0.3.0` feature release. The candidate adds OKF v0.2 semantics,
retains a guarded v0.1 compatibility fallback, adds Attested Computation, and provides explicit
previewed v0.1-to-v0.2 migration. Evidence retained for `0.2.1` is predecessor evidence only and
does not qualify these bytes. The completed `0.2.1` record is archived at
[`docs/releases/0.2.1.md`](releases/0.2.1.md).

## Release blockers

- [x] The project remains MIT licensed and the root license and manifest agree.
- [x] The locked production graphs remain 78 npm runtime packages and 26 Rust/Wasm dependencies;
      generated notices are current.
- [x] The production-only npm audit reports zero high-or-greater vulnerabilities.
- [x] PR #44 and PR #45 were independently reviewed to zero actionable findings and passed their
      required CI before merge.
- [x] Immutable packaged-input revision `802e400c5bfec9174131b44e42fab6db3ee2fec0` is merged to
      `main` and passed [CI 30803984331](https://github.com/koizumikento/okf-workbench/actions/runs/30803984331)
      and [CodeQL 30803982896](https://github.com/koizumikento/okf-workbench/actions/runs/30803982896)
      on 2026-08-03.
- [x] Fixed-toolchain local source, Rust, unit, acceptance, dependency, security, browser, and
      package gates pass for the version candidate.
- [x] A fresh genuine headed VS Code `1.129.1` schema-v3 capture passes QR-002 at `873 ms` p95
      across 20 samples, selects `d3` for QR-003, passes the interaction contract,
      and strict no-remote-egress requirements for the exact candidate identities. The retained
      [generated report](evidence/performance/vscode-1.129.1-0.3.0.md) and
      [raw schema-v3 record](evidence/performance/vscode-1.129.1-0.3.0.json), SHA-256
      `3514a963459ac213728d6baed1d697f8ae75da676b2d386c3c66bb1eb5cd3985`, bind the result to
      production runtime snapshot `6fbcc3b2f004dcfd0f30bfcedd80aea76f79cd4c4e07a07edbf57596d64ab2b4`
      and build-input snapshot `08bd76db5b6ce735472fb9c2780c6e8fe5c28aa7efa38c1778d65290bad147bb`.
- [x] Hosted [Compatibility 30804352708](https://github.com/koizumikento/okf-workbench/actions/runs/30804352708)
      passes acceptance/Webview and all seven editor/OS lifecycle lanes for the exact candidate,
      using the published `v0.2.1` universal VSIX as the verified predecessor.
- [x] Hosted [Package smoke 30804007918](https://github.com/koizumikento/okf-workbench/actions/runs/30804007918)
      passes the browser boundary, all four target packages, and aggregate package-set consistency
      for the same exact candidate.
- [ ] Evidence-only documentation updates are reviewed and merged without changing packaged inputs.
- [x] Repository secret names `OPEN_VSX_TOKEN`, `TAP_REPO`, and `STRAY_TOOLS_TOKEN` exist; the
      tagged workflow remains the only authority that may validate their values.
- [ ] The maintainer authorizes publication after every preceding blocker is complete.

## Version, changelog, and links

- [x] `package.json`, `package-lock.json`, the Cargo workspace, the Rust lockfile, package
      validation, and version assertions agree on `0.3.0`.
- [x] `CHANGELOG.md` contains one dated `0.3.0` entry and no `Unreleased` heading.
- [x] The extension identifier remains `straydog.okf-workbench`.
- [x] The public manifest retains the approved repository, issue, homepage, privacy, support,
      security, license, and notice routes.
- [x] No remote runtime resource, telemetry, account, upload, or AI-provider flow was added.

## Build the immutable candidate

1. Freeze all packaged inputs, merge the version candidate PR, and record its exact `main`
   revision.
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
   mise x node@24.18.0 -- node scripts/security-check.mjs --vsix artifacts/okf-workbench.vsix
   mise x node@24.18.0 -- npm audit --omit=dev --audit-level=high
   ```

4. Capture genuine headed `1.129.1` evidence and require the generated report to pass:

   ```sh
   mise x node@24.18.0 -- node test/benchmarks/headed-editor-evidence.mjs \
     --version 1.129.1 \
     --vscode-executable "/absolute/path/to/VS-Code-1.129.1-executable" \
     --output artifacts/performance/vscode-1.129.1-0.3.0.json
   mise x node@24.18.0 -- npm run benchmark:report -- \
     --measurements artifacts/performance/vscode-1.129.1-0.3.0.json \
     --require-passing
   ```

5. Run hosted `Compatibility` with the published `v0.2.1` universal VSIX URL and exact checksum,
   then run hosted `Package smoke` for the same `main` revision.
6. Apply evidence-only documentation updates. If any packaged input changes, discard prior
   qualification and repeat the affected gates.

## Approval and publication

Per [ADR 0006](decisions/0006-publish-open-vsx-from-version-tags.md), the `Open VSX release`
workflow is the only automated publication path. It runs only when a `v*` tag is pushed.

Before pushing the tag:

1. complete every unchecked release blocker above;
2. merge reviewed candidate and evidence commits into protected `main`;
3. confirm `v0.3.0` matches `package.json` and does not already exist;
4. verify the signed tag locally and confirm its commit is contained in `main`; and
5. confirm the release credential names and current Open VSX publisher authorization.

Publish only after those checks:

```sh
git tag -s v0.3.0 -m "OKF Workbench 0.3.0"
git tag -v v0.3.0
git push origin v0.3.0
```

The workflow reruns deterministic source, dependency, security, audit, reproducibility, and package
gates; creates the universal and four target VSIX packages plus four native CLI archives and
checksums; creates the GitHub Release; updates Homebrew and Scoop manifests; and publishes the VSIX
set to Open VSX.

Never print or pass release tokens as command arguments. Do not run `ovsx publish` locally as a
fallback. Open VSX versions are immutable; recover from a defective release with a higher version.

## Post-publication verification

- [ ] Confirm the signed `v0.3.0` tag and GitHub Release identify the qualified revision.
- [ ] Confirm the release contains the universal and four target VSIX packages, four CLI archives,
      and all checksum files.
- [ ] Confirm Open VSX reports `straydog.okf-workbench` version `0.3.0` and all target packages.
- [ ] Download the published universal VSIX and compare it with the release checksum.
- [ ] Install `0.3.0` from Open VSX in a clean supported VSCodium profile and run the minimal
      offline workflow.
- [ ] Verify upgrade from `0.2.1`, uninstall behavior, and workspace-content preservation.
- [ ] Confirm `koizumikento/stray-tools` contains matching `0.3.0` Homebrew and Scoop manifests.
- [ ] Run clean Homebrew and Scoop installs, verify `okf version`, and uninstall afterward.
- [ ] Revoke the one-time token, or record the owner, scope, storage, and rotation date for a
      retained release credential.

## Release record

| Field | `0.3.0` value |
| --- | --- |
| Extension ID | `straydog.okf-workbench` |
| Immutable packaged-input revision | `802e400c5bfec9174131b44e42fab6db3ee2fec0` |
| Local qualification | Pass — fixed Node `24.18.0`, npm `11.16.0`, Rust `1.92.0`; source, Rust, 1,046 unit, 9 acceptance, 29 security, 16 Webview, minimum/current editor integration, package, reproducibility, notice, and production-audit gates passed |
| Hosted CI | Pass — [CI 30803984331](https://github.com/koizumikento/okf-workbench/actions/runs/30803984331) and [CodeQL 30803982896](https://github.com/koizumikento/okf-workbench/actions/runs/30803982896) |
| Hosted compatibility | Pass — [Compatibility 30804352708](https://github.com/koizumikento/okf-workbench/actions/runs/30804352708), acceptance/Webview and seven lifecycle lanes |
| Hosted package smoke | Pass — [Package smoke 30804007918](https://github.com/koizumikento/okf-workbench/actions/runs/30804007918), browser boundary, four targets, aggregate consistency |
| Headed performance/network | Pass — genuine VS Code `1.129.1`, QR-002 `873 ms` p95/20 samples, QR-003 `d3`, remote `0`, local packaged `2`, internal Webview `2`, other `0` |
| Qualified universal VSIX candidate | `1,309,227` bytes; SHA-256 `d96aa19cc3ada5d4e34618d41bedc4195efa368e2b51b8ff8977984e815caf57` |
| Canonical Wasm | SHA-256 `a5df92505393436fb3a7676d0f7c9c03756ffd225f65ba889efdf0ce81f935fe` |
| Node / npm / Rust | `24.18.0` / `11.16.0` / `1.92.0` |
| Signed tag | Pending |
| Release workflow | Pending |
| GitHub Release | Pending |
| Open VSX listing | Pending |
| Post-publication lifecycle | Pending |
| Homebrew / Scoop repository | Pending |

## Rollback

Open VSX has no supported unpublish command. For a defective non-security release, preserve the
artifacts and evidence, stop promotion, and fix forward with a higher SemVer version. For a
security, privacy, credential, or licensing incident, revoke credentials, use the private security
route, contact Open VSX for the exact version, and publish clear update or uninstall guidance.
