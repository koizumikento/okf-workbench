# Security, Privacy, and Dependency Release Evidence

- Status: **Hold for release**
- Reviewed: 2026-07-22
- Scope: STR-214 release preflight for the hosted-qualified VSIX candidate
- Audience: maintainers and release reviewers
- Decision controls: confirmed candidates `LIC-01`, `HOST-01`; remediated candidate `CI-01`;
  open proof gaps `PG-01`, `PG-03`, and `PG-04`; `PG-02` closed for the exact hosted-qualified
  candidate across all seven required editor/OS lanes

This is a bounded release preflight, not a claim that OKF Workbench is secure, compliant, certified, penetration-tested, or legally cleared. Local repository evidence, command output, browser-harness evidence, hosted settings, and human approval are kept separate.

## Findings

### F-01 — Project license is not declared

- Severity: **Medium; release-blocking**
- Candidate: `LIC-01` (`confirmed`)
- Evidence: `package.json` declares `UNLICENSED`; no root `LICENSE`, `LICENSE.md`, or `LICENSE.txt` exists; `vsce package` prints a missing-license warning; the packaged security gate reports zero project-license entries.
- Impact: a public Open VSX candidate has no maintainer-approved grant for this repository's own code. Third-party notices do not resolve the project license.
- Smallest remediation: the maintainer chooses the project license, updates `package.json`, adds the matching root license text, and obtains the required human license review. Rebuild the VSIX and rerun the packaged gate.
- Owner: maintainer / qualified license reviewer.

### F-02 — GitHub Actions are pinned to reviewed commits (resolved)

- Severity: **Resolved hardening finding**
- Candidate: `CI-01` (`remediated`)
- Evidence: every `uses:` entry in CI, package smoke, compatibility, and Open VSX release workflows is pinned to a reviewed 40-character commit SHA with its human-readable release tag in a comment. Workflow contract checks reject mutable references.
- Existing controls: ordinary workflows declare only `contents: read`; there is no `pull_request_target`, OIDC permission, or self-hosted runner. Only the dispatch-only publish job enters the separately named `open-vsx` Environment.
- Residual risk: future action updates still require dependency review, and hosted branch/environment protection remains covered by `HOST-01` and `PG-04`.
- Owner: repository maintainer.

### F-03 — The hosted repository has no protected-main or scanning baseline

- Severity: **Medium release governance; not a local-build blocker**
- Candidate: `HOST-01` (`confirmed`)
- Evidence: read-only GitHub API reported a private repository with `main` as default, zero repository rulesets, `main` not protected, secret scanning disabled, and code scanning not enabled.
- Impact: direct or insufficiently reviewed changes can reach the release branch, and GitHub is not producing provider secret/code-scanning alerts for this repository.
- Smallest remediation: configure a reviewed ruleset or branch protection with required checks/review, enable the security-analysis features available to the repository, define workflow ownership, and record the effective settings. If a feature is intentionally unavailable, the release owner must document an equivalent control and explicit risk acceptance.
- Owner: repository/organization administrator.

No other confirmed security finding was found in the reviewed local surface. That statement does not close the proof gaps below.

## Implemented release gates

### Deterministic static and dependency gate

Run:

```sh
node scripts/security-check.mjs --check-notices
```

The gate:

- derives the exact reachable production graph from `package-lock.json` and verifies that it matches the lockfile's production markers;
- requires the four approved direct runtime dependencies at exact versions;
- requires every production package to have a SHA-512 integrity value and an approved HTTPS npm-registry resolution;
- fails on production install scripts;
- classifies SPDX expressions as `allowed`, `manual-review`, `high-risk`, `forbidden`, or `missing`;
- fails unresolved, high-risk, forbidden, or missing dependency licenses;
- requires a top-level license or notice file for every production package;
- regenerates and compares `THIRD_PARTY_NOTICES.md` deterministically;
- scans first-party runtime source for remote URLs, network APIs, authentication or telemetry APIs, direct console output, unsafe Webview DOM sinks, and likely workspace-content or secret-bearing logging;
- rejects runtime AI-provider, account/authentication, telemetry, analytics, and general HTTP-client dependencies.

Use `--write-notices` only after an intentional lockfile change. It has no timestamp input, so the generated notice is stable for the same lockfile and installed production graph.

The ordinary pull-request CI quality/package job runs this exact command immediately after
`npm ci`. The protected Open VSX candidate job uses the same command and script, so dependency
classification and notice freshness do not diverge between merge and release gates. The later
packaged-VSIX invocation adds artifact checks; it does not replace or redefine this source gate.

### Packaged VSIX gate

After packaging, run:

```sh
node scripts/security-check.mjs --vsix artifacts/okf-workbench.vsix
```

In addition to the static checks, this requires:

- one non-empty root project license in the VSIX;
- the exact generated `THIRD_PARTY_NOTICES.md` in the VSIX;
- local Webview JavaScript and CSS with no remote runtime asset reference;
- no host-only URI, proposed-content, or workspace API field in the Webview bundle.

The current candidate includes the exact notice file but intentionally fails because F-01 is unresolved.

### Security boundary tests

Run the node-level boundary suite:

```sh
npx vitest run --config test/security/vitest.config.ts
```

Coverage includes:

- CSP directive minimality for the accepted Webview shell;
- 32-byte base64url nonce shape and uniqueness;
- quoted local-asset URI escaping;
- strict protocol envelopes and unknown-field rejection;
- stale revisions, oversized action IDs, forged source URIs, invalid graph references, and unknown node IDs;
- host-authoritative node-to-source mapping without URI disclosure to the Webview;
- contained source-navigation failures without an unhandled listener rejection;
- encoded, multiply encoded, Windows, UNC, null-byte, absolute, and segment traversal attempts;
- exact URI scheme, authority, path-segment, query, and fragment containment;
- zero writes when a proposal path escapes or disagrees with its declared target URI.

Run the real-browser metadata-injection harness after the production build:

```sh
npm run build
npx playwright test --config test/security/playwright.config.ts
```

The harness injects hostile node ID, type, title, description, resource, tag, timestamp, broken-link label, and broken-link target strings. It verifies that they remain text, create no injected element or script, execute no event handler, and invoke no intercepted `fetch`. This is Chromium browser-harness evidence only; it is not VS Code/VSCodium DevTools network-monitor evidence.

## Dependency and package inventory

The checked production graph contains 78 third-party packages:

| SPDX expression | Packages | Gate classification |
| --- | ---: | --- |
| MIT | 60 | allowed |
| ISC | 14 | allowed |
| BSD-3-Clause | 4 | allowed |

Every production package currently has:

- exact lockfile version and SHA-512 integrity;
- HTTPS npm-registry resolution;
- license metadata;
- a checked-in package license/notice file in the installed package;
- no production install script.

The complete package-to-license mapping and deduplicated verbatim notice texts are in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md). License classification is release-engineering evidence, not legal advice.

On 2026-07-22, the live command below returned zero known vulnerabilities at every severity for the production graph:

```sh
npm audit --omit=dev --audit-level=high --json
```

An npm advisory result covers known advisories reported by that service at that time. It does not prove absence of unknown vulnerabilities, malicious packages, or context-specific reachability problems.

The full development graph also returned zero advisories after pinning the test runner's transitive
`diff` and `serialize-javascript` packages to reviewed fixed releases through `overrides`. These
development-only packages are not shipped in the VSIX; the override decision is nevertheless
validated by clean install, integration tests, and the full-tree audit.

## Candidate evidence receipts

| Candidate | Boundary | Claim | Evidence and disposition | Status | Decision impact |
| --- | --- | --- | --- | --- | --- |
| `LIC-01` | Artifact/license | The extension has no maintainer-approved project license. | `package.json`, missing root license, `vsce` warning, packaged gate failure. | confirmed | Blocks public release. |
| `CI-01` | CI/CD | Workflow actions are not immutable. | All workflow action references are pinned to reviewed full commit SHAs; static workflow checks reject mutable references. | remediated | Re-review action updates; no current finding. |
| `CSP-01` | Webview | Workspace content can relax CSP or execute inline code. | HTML is a static shell, the nonce is random base64url, content is not interpolated, and the policy has `default-src 'none'`, nonce-only scripts, and `connect-src 'none'`. Tests pass. | suppressed | No finding. |
| `NET-01` | Privacy/network | A core workflow sends bundle content to a remote service. | First-party source contains no network API or remote runtime URL; there is no runtime HTTP client; Chromium interception observed zero fetch calls. The real headed VS Code Webview CDP capture observed zero HTTP(S)/WS requests across open, refresh, interactions, engine comparison, and disposal. The exact hosted-qualified VSIX completed all seven required editor/OS lanes with zero guarded Extension Host transport attempts. `3d-force-graph` receives in-memory `graphData`, and CSP denies connections. | suppressed | `PG-02` is closed for the exact hosted-qualified candidate; repeat the observation when packaged runtime content or a required lane changes. |
| `XSS-01` | Webview/DOM | Metadata or link text reaches an executable HTML sink. | First-party Webview uses `textContent`, DOM creation, and `replaceChildren`; source scan finds no unsafe sink; hostile browser test passes. | suppressed | No finding. |
| `PROTO-01` | Message boundary | A Webview can supply a privileged URI or malformed graph. | Strict decoders reject unknown keys, stale revisions, bad references, and source URI fields. Host maps current node IDs to private URI objects. | suppressed | No finding. |
| `NAV-01` | Message boundary | A navigation-provider error becomes an unhandled promise rejection. | Controller catches navigator rejection, reports only the error type through the configured observer, and returns `rejected`; listener-path regression test passes. | suppressed | No finding after remediation. |
| `PATH-01` | Workspace write | Generated paths can escape the selected bundle or reach an external filesystem location through an existing symbolic-link ancestor. | URI-first containment plus proposal preflight rejects traversal, encoded separators, mismatched targets, cross-authority URIs, symbolic-link ancestors, and non-directory parents before writing. The common applicator and representative Initialize, New Concept, and Agent Integration command tests exercise refusal; a real temporary `file:` workspace links to an external directory and proves zero applicator writes and no external file generation. | suppressed | Remote and third-party virtual-provider behavior remains compatibility evidence; providers must accurately expose symbolic links through `stat`. |
| `LOG-01` | Secrets/data | Workspace bodies or secret-bearing fields are written to logs. | Source scan rejects direct console output and sensitive fields in logger calls. Current activation logs only event names, counts, revisions, refusal reasons, and error types; previews remain local editor documents. | suppressed | Hosted log review remains `PG-03`. |
| `PRIV-01` | Auth/account/telemetry/AI | The MVP introduces an account, authentication, telemetry, or AI-provider boundary. | No server, auth contribution/API, account flow, telemetry API, AI dependency, API-key flow, or runtime network client exists. | not_applicable | A new decision and new preflight are required if scope changes. |
| `PUBLIC-01` | Public exposure | The candidate exposes an inbound network service. | The artifact is a desktop workspace extension with no server, listener, route, webhook, or cloud resource. | not_applicable | No public-service surface reviewed. |
| `DEP-01` | Dependency license | A production dependency has missing, forbidden, high-risk, or unresolved licensing. | Exact 78-package gate reports only MIT, ISC, and BSD-3-Clause and includes each notice text. | suppressed | Human license review remains `PG-01`. |
| `VULN-01` | Known advisories | npm reports a known production or development vulnerability. | Live production-only and full-tree npm audits returned zero advisories on the review date after reviewed test-only transitive overrides. | suppressed | Point-in-time and known-advisory limitation applies. |
| `COMPAT-01` | Packaged editor lifecycle | The exact candidate does not complete the required editor/OS lifecycle matrix. | [Compatibility run 29900868002](https://github.com/koizumikento/okf-workbench/actions/runs/29900868002) passed the candidate, acceptance/Webview, and all seven required VS Code/VSCodium lifecycle lanes on Ubuntu, macOS, and Windows for commit `aa90832aab64dac1bccf9c9092fabc004991f7b1` and SHA-256 `cc8c994cd35cfe2017945c38d0019f330cb33f628a94bf6508b2930c5c57c866`; [Package smoke run 29900868155](https://github.com/koizumikento/okf-workbench/actions/runs/29900868155) independently reproduced the exact `582231`-byte artifact on all three operating systems. | suppressed | Hosted cross-platform compatibility and package-byte gaps closed for these exact bytes. |
| `HOST-01` | Repository/hosted settings | Protected-main and provider scanning controls are absent. | Read-only GitHub API returned zero rulesets, unprotected `main`, secret scanning disabled, and code scanning not enabled. | confirmed | Harden or explicitly accept before publication; linked to `PG-03`. |
| `RELEASE-01` | Open VSX publishing | Publication uses protected short-lived credentials and reviewed artifacts. | The dispatch-only workflow binds approval to version, commit, and normalized VSIX digest, packages once, and exposes `OVSX_PAT` only in the publish job. The named Environment, reviewers, branch policy, credential, and namespace authorization are not configured or evidenced. | deferred | Repository control is implemented; hosted boundary remains `PG-04`. |

## Coverage ledger

| Boundary | Status | Evidence | Receipts | Exclusions / remaining gaps |
| --- | --- | --- | --- | --- |
| Webview CSP, content injection, and local assets | covered | Host HTML, DOM source, protocol source, unit tests, Chromium harness, production bundle, headed VS Code Webview CDP network capture | `CSP-01`, `NET-01`, `XSS-01` | The zero-egress observation is candidate/editor-specific, not a universal guarantee. |
| Privileged source navigation and messaging | covered | Strict decoder, controller, host source map, navigation rejection regression | `PROTO-01`, `NAV-01` | No active exploit testing was performed. |
| Workspace path/write containment | covered for pure, memory-backed, and local `file:` symlink boundaries | Path guard, proposal applicator, authoring-command regressions, VS Code `FileType.SymbolicLink` mapping, and real temporary-workspace escape regression | `PATH-01` | Remote and third-party virtual-provider behavior is owned by compatibility evidence. |
| Secrets, logs, telemetry, and content egress | covered for the exact hosted-qualified candidate | First-party static scan, activation log review, browser interception, exact-candidate packaged Extension Host transport guards, headed Webview CDP capture, hosted compatibility artifacts, hosted settings API | `NET-01`, `LOG-01`, `PRIV-01`, `COMPAT-01`, `HOST-01` | The headed-Webview check and all seven required hosted editor/OS lanes pass for the exact VSIX. Hosted repository scanning is confirmed disabled. |
| Production dependency and license inventory | covered technically | Lock graph, installed manifests, license texts, integrity, install-script gate, npm audit | `DEP-01`, `VULN-01` | Human legal/license judgment: `PG-01`. |
| Project license and packaged notices | partial | VSIX entry inspection and exact notice comparison | `LIC-01` | Project license unresolved: `PG-01`. |
| CI workflows and hosted repository policy | partial | Full-SHA action pins, local YAML permissions/triggers/artifacts, digest-bound release workflow; read-only ruleset/protection/scanning/environment API | `CI-01`, `HOST-01`, `RELEASE-01` | Action mutability is remediated. Protection/scanning are confirmed absent; release environment remains `PG-04`. |
| Authentication/authorization and inbound public service | covered as absent | Manifest, architecture, source and runtime dependency inventory | `PRIV-01`, `PUBLIC-01` | Re-review if scope changes. |

## Proof gaps and required human verification

### PG-01 — Project and dependency license approval

- Unproven fact: the maintainer-selected project license and the combined third-party distribution obligations are approved for Open VSX publication.
- Why local automation cannot close it: SPDX allowlisting and notice collection are technical inventory, not legal judgment or maintainer authorization.
- Potential impact: unauthorized or non-compliant public distribution.
- Owner: maintainer and qualified license reviewer.
- Smallest safe evidence: committed project license, matching manifest identifier, reviewed notice inventory, and an explicit approval record.
- Release before closure: **no**.

### PG-02 — Actual editor network and data-egress observation (closed for the exact hosted candidate)

- Established evidence: the `582231`-byte VSIX from commit `aa90832aab64dac1bccf9c9092fabc004991f7b1` and SHA-256 `cc8c994cd35cfe2017945c38d0019f330cb33f628a94bf6508b2930c5c57c866` completed the packaged Extension Host lifecycle on VS Code 1.121.0 on Ubuntu; VS Code 1.127.0 on Ubuntu, macOS, and Windows; and VSCodium 1.121.03429 on Ubuntu, macOS, and Windows. Every clean, untrusted, and upgrade activation installed transport guards for HTTP, HTTPS, HTTP/2, TCP, TLS, DNS, UDP, `fetch`, and WebSocket; activation plus Validate Bundle and Open 3D Graph completed with zero attempts. The [Compatibility run](https://github.com/koizumikento/okf-workbench/actions/runs/29900868002) retained the per-lane result artifacts. The [Package smoke run](https://github.com/koizumikento/okf-workbench/actions/runs/29900868155) also reproduced those exact bytes independently on macOS, Ubuntu, and Windows.
- Headed Webview evidence: the exact measured VS Code 1.127.0 Webview bundle (`853502f50117c6b565b8a9befdb474e1cbaf39bf78b8b7eb6aa3d52f92266d7b`; combined Extension Host + Webview SHA-256 `93c75712626c20bee2b77ad74810267733c6457da85ad89c595772ac6e6d92ad`) was observed through its CDP target during initial packaged-resource loading, watcher refresh, search, filter, selection, engine comparison, and disposal. It made zero remote HTTP(S)/WS requests, loaded two local VS Code Webview resources, and used no other scheme.
- Preserved historical evidence: the earlier `581830`-byte candidate from commit `524eca3f36e1a1b3da935495d3fbbd0eb0d03f56`, SHA-256 `65c137822052aa7f90ef08cc1300020fec4adcd7cbcec6aec88ae98fae64dad0`, passed the same lifecycle on all three local macOS arm64 editor lanes. Those checked-in records remain predecessor audit evidence and are not represented as records for the hosted-qualified candidate.
- Privacy of evidence: the tracked record retains only sanitized origins and counts; it contains no workspace body or URL path.
- Scope limit: the headed Webview result and hosted packaged lifecycle observations close egress observation only for the recorded bundle hashes, exact VSIX bytes, and named editor/OS lanes. Any future runtime dependency, CSP change, editor family, or packaged-content change requires the applicable checks again.
- Owner: release tester / security reviewer.
- Disposition: **closed for this candidate**. This closure does not resolve project licensing, hosted repository protection/scanning, or Open VSX publication authorization.

### PG-03 — Hosted GitHub protection, scanning, and alert review

- Unproven fact: after protection/scanning remediation, required review/checks, workflow ownership, alert handling, and retained logs/artifacts will match repository policy and show no unresolved release-affecting alert.
- Current established state: the repository has no ruleset or main protection, and both secret scanning and code scanning are disabled or not enabled.
- Why the remaining fact is not established here: changing hosted policy is outside this preflight, and a disabled scanner has no meaningful clean alert state.
- Potential impact: unreviewed changes, undetected credential exposure, or unsafe release inputs.
- Owner: GitHub organization/repository administrator.
- Smallest safe evidence: enable or document equivalent controls, then retain a read-only settings export or screenshots plus scanning alert status and workflow/ruleset review.
- Release before closure: only after the release owner explicitly accepts or closes the gap.

### PG-04 — Open VSX hosted publication boundary

- Unproven fact: the `straydog` publisher namespace, credential ownership, approval environment, artifact identity, and publication process are controlled by the intended maintainer.
- Current established state: the repository contains a dispatch-only, digest-bound workflow that packages once and scopes the secret to the publish job; all action references are immutable. The maintainer reports that a namespace named `straydog` exists.
- Why not established here: namespace-name existence does not establish that the publishing identity is an authorized member or that the current Publisher Agreement is signed. The named GitHub Environment, required reviewers, deployment policy, environment-scoped credential, namespace authorization, and exact-digest publication approval have not been configured or validated, and no artifact was published during this preflight.
- Potential impact: namespace misuse, credential leakage, or publication of an unreviewed artifact.
- Owner: Open VSX namespace owner and release maintainer.
- Smallest safe evidence: configure and inspect the `open-vsx` Environment and independent review policy, confirm namespace ownership and Publisher Agreement state, add only the environment-scoped credential, and retain approval for the exact workflow commit and VSIX digest immediately before publication.
- Release before closure: **no**.

## Commands and observed results

| Command | Result on 2026-07-22 |
| --- | --- |
| `node scripts/security-check.mjs --check-notices` | Pass; 78 exact production packages. |
| `npx vitest run --config test/security/vitest.config.ts` | Pass; security boundary suite. |
| `npm run build` | Pass; production extension and Webview bundles. |
| `npx playwright test --config test/security/playwright.config.ts` | Pass in Chromium; hostile metadata remained inert and intercepted fetch count was zero. |
| `node test/benchmarks/headed-editor-evidence.mjs ...` | Pass in headed VS Code 1.127.0; Webview CDP recorded zero remote HTTP(S)/WS requests and two local packaged-resource loads. |
| [CI run 29900857588](https://github.com/koizumikento/okf-workbench/actions/runs/29900857588) | Pass; all four quality/package, hostile-content Webview, VS Code 1.121.0 integration, and VS Code 1.127.0 integration jobs succeeded. |
| [Compatibility run 29900868002](https://github.com/koizumikento/okf-workbench/actions/runs/29900868002) | Pass for the exact `582231`-byte, SHA-256 `cc8c994cd35cfe2017945c38d0019f330cb33f628a94bf6508b2930c5c57c866` candidate; all nine candidate, acceptance/Webview, and seven required VS Code/VSCodium lifecycle jobs succeeded across Ubuntu, macOS, and Windows with zero guarded Extension Host transport attempts. |
| [Package smoke run 29900868155](https://github.com/koizumikento/okf-workbench/actions/runs/29900868155) | Pass; macOS, Ubuntu, and Windows independently produced the exact recorded digest and byte size. |
| [CI run 29901152549](https://github.com/koizumikento/okf-workbench/actions/runs/29901152549) | Pass at workflow-only commit `6505a7f7b017a44a851ab6edaaba28f6b6a72105`; all four jobs succeeded, and packaged content remained unchanged. |
| [Package smoke run 29901183164](https://github.com/koizumikento/okf-workbench/actions/runs/29901183164) | Pass at the workflow-only commit; all three OS jobs and the aggregate byte-identity job succeeded for SHA-256 `cc8c994cd35cfe2017945c38d0019f330cb33f628a94bf6508b2930c5c57c866`, `582231` bytes, and three artifacts. |
| Preserved local `node scripts/compatibility/run-package-lifecycle.mjs ...` records | Pass for predecessor SHA-256 `65c137822052aa7f90ef08cc1300020fec4adcd7cbcec6aec88ae98fae64dad0` on local macOS arm64 in VS Code 1.121.0, VS Code 1.127.0, and VSCodium 1.121.03429. |
| `npm audit --omit=dev --audit-level=high --json` | Pass; zero reported production vulnerabilities. |
| `npm run package` | Package produced; `vsce` warned that the project license is missing. |
| `node scripts/security-check.mjs --vsix artifacts/okf-workbench.vsix` | Expected fail: exact notice present, but zero project-license entries. |
| Read-only GitHub repository/ruleset/protection/scanning API calls | Repository private; zero rulesets; `main` unprotected; secret scanning disabled; code scanning not enabled. |

## Decision reconciliation

Current recommendation: **hold public release**.

- `LIC-01` is a confirmed release blocker and controls the hold decision.
- `CI-01` is remediated. `HOST-01` must be hardened or explicitly accepted before a privileged publication path is trusted.
- `PG-02` is closed for the exact hosted-qualified candidate on all seven required editor/OS lanes.
  `PG-01`, `PG-03`, and `PG-04` remain open and have named owners and safe closure evidence.
- The reported existence of the `straydog` namespace does not close publishing-identity
  authorization or Publisher Agreement verification. Public marketplace resources and explicit
  maintainer approval for the exact digest also remain unchecked in the release checklist.
- Suppressed candidates have explicit counter-evidence; not-applicable candidates identify absent surfaces; deferred candidates map to proof gaps.

After F-01 is remediated, rerun the exact-notice check, full security test suite, production build, package creation, packaged VSIX gate, and npm audit. Do not convert this document to `ready` until the required human and hosted verification evidence is attached.
