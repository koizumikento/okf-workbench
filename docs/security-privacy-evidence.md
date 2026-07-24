# Security, Privacy, and Dependency Release Evidence

- Status: **Hold for release**
- Reviewed: 2026-07-24
- Scope: STR-214 release preflight for the current source, including fresh schema-v3 headed
  evidence, the final rebuilt VSIX, and current hosted receipts
- Audience: maintainers and release reviewers
- Decision controls: confirmed candidate `HOST-01`; remediated candidates `LIC-01`, `CI-01`;
  open proof gaps `PG-01`, `PG-02`, `PG-03`, and `PG-04`; the strict schema-v3 headed Webview and
  current packaged read/untrusted-refusal observations are complete while trusted write-command
  observation remains outside packaged `PG-02`

This is a bounded release preflight, not a claim that OKF Workbench is secure, compliant, certified, penetration-tested, or legally cleared. Local repository evidence, command output, browser-harness evidence, hosted settings, and human approval are kept separate.

## Findings

### F-01 — Project license was not declared (resolved)

- Severity: **Resolved release blocker**
- Candidate: `LIC-01` (`remediated`)
- Evidence: on 2026-07-23 the maintainer selected MIT; `package.json` and the lockfile declare
  `MIT`, and the repository root contains the matching `LICENSE`.
- Remaining boundary: the final local and hosted-identical VSIX passed the packaged license gate.
  The separate generated third-party notice inventory still requires its recorded human release
  review.
- Owner: maintainer / qualified license reviewer.

### F-02 — GitHub Actions are pinned to reviewed commits (resolved)

- Severity: **Resolved hardening finding**
- Candidate: `CI-01` (`remediated`)
- Evidence: every `uses:` entry in CI, package smoke, compatibility, and Open VSX release workflows is pinned to a reviewed 40-character commit SHA with its human-readable release tag in a comment. Workflow contract checks reject mutable references, and the hosted repository setting now enforces `sha_pinning_required: true` for GitHub Actions.
- Existing controls: ordinary workflows declare only `contents: read`; there is no `pull_request_target`, OIDC permission, or self-hosted runner. Only the dispatch-only publish job enters the separately named `open-vsx` Environment.
- Residual risk: future action updates still require dependency review, and hosted branch/environment protection remains covered by `HOST-01` and `PG-04`.
- Owner: repository maintainer.

### F-03 — The hosted repository has no protected-main or scanning baseline

- Severity: **Medium release governance; not a local-build blocker**
- Candidate: `HOST-01` (`confirmed`)
- Evidence: read-only GitHub API reported a private repository with `main` as default, zero repository rulesets, `main` not protected, secret scanning disabled, and code scanning not enabled. The separate Actions SHA-pinning policy is enabled and closes action-reference mutability, but does not replace branch protection or scanning.
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
- requires the eight approved direct runtime dependencies at exact versions;
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

- exactly one VSCE-canonical `extension/LICENSE.txt` in the VSIX, byte-identical to the repository
  `LICENSE`, paired with an exact packaged `license: "MIT"` manifest value;
- exact `extension.vsixmanifest` license declaration and addressable license-asset references to
  that path, with no private source, support, learning, GitHub, or getting-started link properties;
- the exact generated `THIRD_PARTY_NOTICES.md` in the VSIX;
- local Webview JavaScript and CSS with no remote runtime asset reference;
- no host-only URI, proposed-content, or workspace API field in the Webview bundle.

The source candidate contains the MIT project license and exact notice file. On 2026-07-23 the
final local candidate passed the canonical filename, exact-byte, manifest-value, duplicate-entry,
security, notice, and reproducibility checks at SHA-256
`d7be6180cd788b2ab5d9c7fc436de9eb2df97d967b16ccbc2578f48851f0b666` and `613637`
bytes. An earlier post-MIT artifact remains historical input-readiness evidence. Neither local
result replaces human third-party review. Current CI, Compatibility, and macOS/Ubuntu/Windows
Package smoke artifacts reproduced these exact bytes.

### Security boundary tests

After installing the pinned Chromium binary once, the local aggregate runs both dedicated suites
around a fresh production build:

```sh
npx --no-install playwright install chromium
npm run test:security:all
```

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
- exact and one-over provider resource limits for document count, reported/actual per-file and
  aggregate bytes, path depth and identity, 16 KiB serialized URIs, retained failures, and bounded
  eight-way physical I/O;
- dishonest-provider and cancellation cases proving every issued call is drained, oversized source
  bytes are neither hashed nor parsed, one source becomes an identity-only failure, and readable
  siblings remain publishable; bytes discarded after parent-access revalidation remain charged to
  the actual-content aggregate, including the deterministic 17 × 2 MiB rejection;
- memory-provider and real `file:` ancestor-swap regressions proving each runtime refresh captures
  the complete workspace-to-bundle directory generation before traversal and checks it after
  enumeration, after each read batch, and before publication; deterministic transient tests replace
  root and deep descendant parents with an external symlink during native open, fresh stat, and
  directory enumeration, restore them before the operation returns, and prove that command refresh,
  watcher refresh, and automatic discovery return no external bytes, names, or metadata, publish no
  external title, label, or safe-sibling partial replacement, and resolve every handle close
  explicitly, including injected close rejection;
- parser pre-AST limits for YAML/Markdown depth, lines, structural/syntax/link work, retained
  semantic output, and document-versus-bundle failure scope; per-document Markdown guards include
  1,024 attention delimiter runs and marker code units, 8,388,608 attention grammar-event work
  units, 65,536 list/blockquote continuation work units, and 8,388,608 prospective link-label
  closing scan units, including exact/one-over aggregate Markdown limits of 8 MiB body code units,
  100,000 lines, 33,554,432 attention grammar-event work units, 262,144 list/blockquote continuation
  work units, 33,554,432 link-label closing work units, 80,000 syntax candidates, and 20,000 link
  candidates; reserved and document-failing inspections are charged before their local outcome and
  later sources retain identity-only entries after overflow;
- zero writes when a proposal path escapes or disagrees with its declared target URI;
- exact multi-root workspace-membership invalidation for all four write commands, including
  removal during modeless approval, same-URI re-add, containing-parent substitution, provider
  pre-commit races, and stopping every remaining target after a completed first write.

Run the real-browser metadata-injection harness after the production build:

```sh
npm run build
npx playwright test --config test/security/playwright.config.ts
```

The harness injects hostile node ID, type, title, description, resource, tag, timestamp, broken-link label, and broken-link target strings. It verifies that they remain text, create no injected element or script, execute no event handler, and invoke no intercepted `fetch`. This is Chromium browser-harness evidence only; it is not VS Code/VSCodium DevTools network-monitor evidence.

`npm run check` includes the aggregate security command. Hosted CI owns the Node and browser suites
in its quality and Webview jobs respectively; Compatibility runs them in `candidate` and
`acceptance`; every Package smoke OS lane runs the Node suite so Windows junction and
platform-specific path behavior stay covered, while one Chromium `security-boundaries` job gates
all three lanes; and the Open VSX `build-candidate` job runs both before retaining candidate bytes.
Repository policy tests reject missing, misplaced, duplicate, conditional, or failure-tolerating
commands, so ordinary unit or Webview behavior tests are not counted as dedicated security
coverage.

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
| `LIC-01` | Artifact/license | The extension lacked a maintainer-approved project license. | The maintainer selected MIT on 2026-07-23; the manifest, lockfile, and root `LICENSE` agree, the final candidate passed the packaged license gate, and all downloaded hosted VSIX files were byte-identical to it. | remediated | Third-party review remains `PG-01`. |
| `CI-01` | CI/CD | Workflow actions are not immutable. | All workflow action references are pinned to reviewed full commit SHAs; static workflow checks reject mutable references. | remediated | Re-review action updates; no current finding. |
| `CSP-01` | Webview | Workspace content can relax CSP or execute inline code. | HTML is a static shell, the nonce is random base64url, content is not interpolated, and the policy has `default-src 'none'`, nonce-only scripts, and `connect-src 'none'`. Tests pass. | suppressed | No finding. |
| `NET-01` | Privacy/network | A core workflow sends bundle content to a remote service. | First-party source contains no network API or remote runtime URL; there is no runtime HTTP client; Chromium interception observed zero fetch calls. The genuine current-input schema-v3 headed VS Code `1.129.1` Webview record used the strict pre-navigation CDP envelope and observed zero remote HTTP(S)/WS requests, two local packaged-resource loads, two internal Webview navigations, and zero other-scheme requests across refresh and interactions. Current seven-lane packaged captures recorded zero calls through the acceptance driver's listed CommonJS builtin export-owner/global hooks during activation and request-correlated Validate/Open completion, retained the hooks until Extension Host exit, and refused all four write commands in untrusted workspaces. `3d-force-graph` receives in-memory `graphData`, and CSP denies connections. | partially suppressed for current candidate | The current headed-Webview and packaged read/untrusted-refusal surfaces pass; `PG-02` retains trusted write-command observation and the documented hook limitations. |
| `XSS-01` | Webview/DOM | Metadata or link text reaches an executable HTML sink. | First-party Webview uses `textContent`, DOM creation, and `replaceChildren`; source scan finds no unsafe sink; hostile browser test passes. | suppressed | No finding. |
| `PROTO-01` | Message boundary | A Webview can supply a privileged URI or malformed graph. | Strict decoders reject unknown keys, stale revisions, bad references, and source URI fields. Host maps current node IDs to private URI objects. | suppressed | No finding. |
| `NAV-01` | Message boundary | A navigation-provider error becomes an unhandled promise rejection. | Controller catches navigator rejection, reports only the error type through the configured observer, and returns `rejected`; listener-path regression test passes. | suppressed | No finding after remediation. |
| `PATH-01` | Workspace read/write | Generated paths can escape the selected bundle, an approved proposal can outlive removal of its workspace folder, or a retained read selection can be redirected outside its workspace through an existing, transient, or restored symbolic-link ancestor. | URI-first containment plus proposal preflight rejects traversal, encoded separators, mismatched targets, cross-authority URIs, symbolic-link ancestors, non-directory parents, and optional parents that appear while the existing baseline is captured. Write workflows capture exact workspace-folder membership, invalidate their preview on removal, reject containing-parent or same-URI-readd substitution, recheck before each change, and carry authorization and target-parent read boundaries through provider preparation, expected-content comparison, and post-write verification. Local `file:` stats retain native device/inode/mode/nanosecond-ctime/birthtime generations. Reads require that generation, open one handle with terminal no-follow where available, verify with `fstat` before reading, read through the verified handle, compare handle and pathname generations afterward, and return bytes only after confirmed close. Runtime and authoring reads capture each distinct resource parent; traversal withholds every directory result until its root-to-current chain passes, and nested generation failures invalidate the load. Real temporary regressions prove zero applicator writes to a linked directory; zero external bytes, enumerated names, titles, labels, graph state, diagnostics, or partial replacement from transient command/watcher/discovery swap-and-restore attacks at root and deep parents; and explicit success/failure tracking for every injected handle close. | suppressed for the tested local-file read and fail-detect write boundary | Non-`file:` providers expose no handle, inode, ETag, conditional read, or existing-file compare-and-swap in the VS Code API and are an explicit trusted-provider metadata-sandwich boundary. Node exposes no `openat` pathname walk, so this is not a universal atomic-filesystem or update-CAS claim against privileged mount changes or mutations in the interval between comparison and provider write. Remote and third-party provider behavior remains compatibility evidence. |
| `LOG-01` | Secrets/data | Workspace bodies or secret-bearing fields are written to logs. | Source scan rejects direct console output and sensitive fields in logger calls. Current activation logs only event names, counts, revisions, refusal reasons, and error types; previews remain local editor documents. | suppressed | Hosted log review remains `PG-03`. |
| `PRIV-01` | Auth/account/telemetry/AI | The MVP introduces an account, authentication, telemetry, or AI-provider boundary. | No server, auth contribution/API, account flow, telemetry API, AI dependency, API-key flow, or runtime network client exists. | not_applicable | A new decision and new preflight are required if scope changes. |
| `PUBLIC-01` | Public exposure | The candidate exposes an inbound network service. | The artifact is a desktop workspace extension with no server, listener, route, webhook, or cloud resource. | not_applicable | No public-service surface reviewed. |
| `DEP-01` | Dependency license | A production dependency has missing, forbidden, high-risk, or unresolved licensing. | Exact 78-package gate reports only MIT, ISC, and BSD-3-Clause and includes each notice text. | suppressed | Human license review remains `PG-01`. |
| `VULN-01` | Known advisories | npm reports a known production or development vulnerability. | Live production-only and full-tree npm audits returned zero advisories on the review date after reviewed test-only transitive overrides. | suppressed | Point-in-time and known-advisory limitation applies. |
| `COMPAT-01` | Packaged editor lifecycle | The exact candidate does not complete the required editor/OS lifecycle matrix. | Current [Compatibility run 30058922150](https://github.com/koizumikento/okf-workbench/actions/runs/30058922150) passed the candidate, acceptance/Webview, and all seven VS Code/VSCodium lifecycle jobs at evidence revision `a5b2b75b7216d644f0d8d0f739db3a989bba7ca0`. Current [Package smoke run 30058925030](https://github.com/koizumikento/okf-workbench/actions/runs/30058925030) passed all three operating systems and aggregate byte identity. The CI, Compatibility, package-smoke, and local VSIX files were byte-identical at SHA-256 `d7be6180cd788b2ab5d9c7fc436de9eb2df97d967b16ccbc2578f48851f0b666`, `613637` bytes. | suppressed for current candidate | Re-run for any packaged-content or required-matrix change. |
| `HOST-01` | Repository/hosted settings | Protected-main and provider scanning controls are absent. | Read-only GitHub API returned zero rulesets, unprotected `main`, secret scanning disabled, and code scanning not enabled. Actions SHA pinning is now enforced at repository level. | confirmed | Action-reference mutability is closed; harden or explicitly accept the remaining branch/scanning gap before publication. Linked to `PG-03`. |
| `RELEASE-01` | Open VSX publishing | Publication uses protected short-lived credentials and reviewed artifacts. | The dispatch-only workflow binds approval to version, commit, and normalized VSIX digest, packages once, performs credential-free public registry preflights, and exposes `OVSX_PAT` only to PAT verification and publication. After authorization it must durably upload token-free, approval/digest/revision/registry-bound pre-publication evidence before the irreversible command. Public evidence confirms `straydog` is verified/restricted and the exact target version is available. The named Environment, reviewers, branch policy, credential, authenticated authorization, and Agreement state are not configured or evidenced. | deferred | Repository control is implemented; hosted boundary remains `PG-04`. |

## Coverage ledger

| Boundary | Status | Evidence | Receipts | Exclusions / remaining gaps |
| --- | --- | --- | --- | --- |
| Webview CSP, content injection, and local assets | covered | Host HTML, DOM source, protocol source, unit tests, Chromium harness, production bundle, headed VS Code Webview CDP network capture | `CSP-01`, `NET-01`, `XSS-01` | The zero-egress observation is candidate/editor-specific, not a universal guarantee. |
| Privileged source navigation and messaging | covered | Strict decoder, controller, host source map, navigation rejection regression | `PROTO-01`, `NAV-01` | No active exploit testing was performed. |
| Workspace path/read-and-write containment | covered for pure, memory-backed, and tested local `file:` symlink boundaries | Exact open-folder membership tracker, modeless-workflow invalidation, provider pre-commit authorization, path guard, native identity-bound read handles with close-failure tests, per-resource and per-traversed-directory parent generations, proposal applicator read boundaries, runtime/authoring regressions, VS Code `FileType.SymbolicLink` mapping, and real temporary-workspace permanent plus root/deep transient swap-and-restore regressions for command, watcher, discovery, and enumeration paths | `PATH-01` | Non-`file:` providers are an explicit trusted-provider boundary owned by compatibility evidence; no universal `openat`/privileged-mount atomicity or existing-file update-CAS claim is made. |
| Secrets, logs, telemetry, and content egress | covered statically, in the current strict headed Webview, and for current packaged activation/read/untrusted-refusal phases | First-party static scan, activation log review, browser interception, current schema-v3 headed Webview CDP capture, current packaged Extension Host CommonJS-owner/global hooks, hosted settings API | `NET-01`, `LOG-01`, `PRIV-01`, `COMPAT-01`, `HOST-01` | The current observations are candidate/editor/lane-specific. The Extension Host hooks are not OS isolation and exclude ESM named bindings, cached references, raw/prototype bindings, `dns.promises`, child processes, editor-owned traffic, Webview traffic, and trusted write-command execution. Hosted repository scanning is confirmed disabled. |
| Production dependency and license inventory | covered technically | Lock graph, installed manifests, license texts, integrity, install-script gate, npm audit | `DEP-01`, `VULN-01` | Human legal/license judgment: `PG-01`. |
| Project license and packaged notices | covered technically in the final hosted-identical artifact | MIT manifest/root license plus exact final local and hosted VSIX license and notice inspection | `LIC-01` | Human third-party review remains `PG-01`. |
| CI workflows and hosted repository policy | partial | Full-SHA action pins, local YAML permissions/triggers/artifacts, digest-bound release workflow; read-only ruleset/protection/scanning/environment API | `CI-01`, `HOST-01`, `RELEASE-01` | Action mutability is remediated. Protection/scanning are confirmed absent; release environment remains `PG-04`. |
| Authentication/authorization and inbound public service | covered as absent | Manifest, architecture, source and runtime dependency inventory | `PRIV-01`, `PUBLIC-01` | Re-review if scope changes. |

## Proof gaps and required human verification

### PG-01 — Third-party license and notice approval

- Established fact: the maintainer selected MIT for the project's own code on 2026-07-23.
- Unproven fact: the generated third-party notice inventory and combined dependency distribution
  obligations are approved for Open VSX publication.
- Why local automation cannot close it: SPDX allowlisting and notice collection are technical inventory, not legal judgment or maintainer authorization.
- Potential impact: unauthorized or non-compliant public distribution.
- Owner: maintainer and qualified license reviewer.
- Smallest safe evidence: a passing final packaged-license gate plus reviewed notice inventory and
  an explicit approval record.
- Release before closure: **no**.

### PG-02 — Actual editor network and data-egress observation (packaged surface remains open)

- Current headed Webview evidence: the genuine schema-v3 capture at
  `2026-07-23T09:59:23.073Z` attached the strict pre-navigation CDP recorder to VS Code `1.129.1`
  commit `8a7abeba6e03ea3af87bfbce9a1b7e48fed567b8` and retained the exact current
  production/input identities. Across initial loading, watcher refresh, search, filter, selection,
  engine comparison, and disposal it observed zero remote HTTP(S)/WS requests, two local packaged
  resources, two internal Webview navigations, and zero other-scheme requests. The tracked raw
  record is `docs/evidence/performance/vscode-1.129.1.json`, SHA-256
  `0fd512512c0ff3d8fecbecd1c50d87bc6a727f2dad68fca3403ed8b400f7d3f5`.
- Current packaged evidence: the `613637`-byte VSIX from artifact-content revision
  `e0c1f8895f3dc3391be3de47f1a517f82ae62f3c` and SHA-256
  `d7be6180cd788b2ab5d9c7fc436de9eb2df97d967b16ccbc2578f48851f0b666` completed the
  current seven-lane packaged lifecycle in
  [Compatibility run 30058922150](https://github.com/koizumikento/okf-workbench/actions/runs/30058922150).
  Every clean, untrusted, and upgrade activation installed the recorded CommonJS-owner/global
  hooks. Activation, request-correlated Validate/Open completion, and guarded quiescence recorded
  zero calls; the hooks remained installed until Extension Host exit. The catalog-derived
  untrusted probe refused Initialize Bundle, New Concept, Regenerate Indexes, and Set Up Agent
  Integration. Every lifecycle report binds evidence revision
  `a5b2b75b7216d644f0d8d0f739db3a989bba7ca0`, candidate identity/version, and the digest above.
- Historical established evidence: the `582231`-byte VSIX from commit `aa90832aab64dac1bccf9c9092fabc004991f7b1` and SHA-256 `cc8c994cd35cfe2017945c38d0019f330cb33f628a94bf6508b2930c5c57c866` completed the packaged Extension Host lifecycle on VS Code 1.121.0 on Ubuntu; VS Code 1.127.0 on Ubuntu, macOS, and Windows; and VSCodium 1.121.03429 on Ubuntu, macOS, and Windows. Every clean, untrusted, and upgrade activation hooked these properties on the CommonJS builtin export-owner objects returned by `require`: `node:http.get/request`, `node:https.get/request`, `node:http2.connect`, `node:net.connect/createConnection`, `node:tls.connect`, `node:dns.lookup/resolve/resolve4/resolve6`, and `node:dgram.createSocket`; it also hooked the available `globalThis.fetch` and `globalThis.WebSocket`. Activation, Validate Bundle dispatch followed by a newer runtime publication, Open 3D Graph dispatch followed by a graph data-application acknowledgement, and the quiescence window recorded zero calls through those hooks. The retained schema did not correlate the asynchronous signals to their initiating requests and restored the hooks after a successful report, so this is not request-correlated completion or host-exit-lifetime evidence. The [Compatibility run](https://github.com/koizumikento/okf-workbench/actions/runs/29900868002) retained the per-lane result artifacts. The [Package smoke run](https://github.com/koizumikento/okf-workbench/actions/runs/29900868155) also reproduced those exact bytes independently on macOS, Ubuntu, and Windows. Current source does not inherit this evidence.
- Historical headed Webview evidence: the schema-v3 capture at `2026-07-23T04:07:30.642Z`
  observed the real VS Code 1.127.0 Webview CDP target during initial packaged-resource loading,
  watcher refresh, search, filter, selection, engine comparison, and disposal. It made zero remote
  HTTP(S)/WS requests, loaded two local VS Code Webview resources from the sanitized
  `https://file+.vscode-resource.vscode-cdn.net` origin, and used no other scheme. The exact
  Extension Host JavaScript, Webview JavaScript, Webview CSS, and domain-separated bundle-set
  SHA-256 values are respectively
  `36cbc9669b790d4633a2277a257c5037281df25080fec758abe4c7ffd26c9ded`,
  `153b9891bdab9a1eb05357a2a1c8f58dc92bd48362839621b7c877d1ac5ffc35`,
  `8f47124ac42ffdc619489d9b9a618bedad59e63eea9fcb5beb8d79b8facb7ce4`, and
  `d1ceefe1a35532335b9d20bb691fe7144a354c0f2cb282c41504b6fd2d0ea9d6`. The retained raw
  evidence also binds the full runtime tree and five build/observer/harness input identities. It is
  now historical because the current strict evaluator requires a schema-v1 security envelope and
  changed observer/runner/harness identities.
- Preserved local predecessor evidence: the earlier `581830`-byte candidate from commit `524eca3f36e1a1b3da935495d3fbbd0eb0d03f56`, SHA-256 `65c137822052aa7f90ef08cc1300020fec4adcd7cbcec6aec88ae98fae64dad0`, passed the same lifecycle on all three local macOS arm64 editor lanes. Those checked-in records remain predecessor audit evidence and are not records for either the historical hosted candidate or the current candidate.
- Privacy of evidence: the tracked record retains only sanitized origins and counts; it contains no workspace body or URL path.
- Scope limit: the JavaScript hooks mutate listed CommonJS builtin export-owner properties and available globals; they are not operating-system isolation. They do not observe ESM named bindings, cached references, prototype or raw bindings, `dns.promises`, child processes, editor-owned traffic, or Webview traffic. The current and older headed Webview results are separate candidate-bound observations. Each observation closes its named surface only for the recorded production/input identities or exact VSIX bytes and editor/OS lanes. Any future runtime dependency, CSP change, editor family, packaged-content change, or evidence-contract change requires the applicable checks again.
- Current harness semantics: active-phase reports inventory every installed hook, keeps the hooks installed until Extension Host exit, and fails closed on malformed evidence. The persisted attempt list ends at report creation; the still-installed hooks deny later tail calls but cannot amend that file. Post-uninstall reports explicitly set network attempts and quiescence to `null` with observer status `not-installed`; that phase verifies extension API absence only. The current retained candidate run contains these stricter fields; the historical records do not gain them retroactively.
- Owner: release tester / security reviewer.
- Disposition: **headed Webview and current packaged activation/read/untrusted-refusal boundaries
  passed; trusted write-command observation remains open**. The
  current-input VS Code `1.129.1` pre-navigation CDP record is retained at
  `docs/evidence/performance/vscode-1.129.1.{json,md}` and passes the strengthened envelope. The
  current packaged run supplies request-correlated completion and host-exit-lifetime hook evidence,
  but it does not execute the trusted write-command workflows under those hooks. Historical
  packaged observations remain bounded evidence for their old exact bytes only.

### PG-03 — Hosted GitHub protection, scanning, and alert review

- Unproven fact: after protection/scanning remediation, required review/checks, workflow ownership, alert handling, and retained logs/artifacts will match repository policy and show no unresolved release-affecting alert.
- Current established state: the repository enforces full-SHA GitHub Action references, but has no ruleset or main protection, and both secret scanning and code scanning are disabled or not enabled.
- Why the remaining fact is not established here: changing hosted policy is outside this preflight, and a disabled scanner has no meaningful clean alert state.
- Potential impact: unreviewed changes, undetected credential exposure, or unsafe release inputs.
- Owner: GitHub organization/repository administrator.
- Smallest safe evidence: enable or document equivalent controls, then retain a read-only settings export or screenshots plus scanning alert status and workflow/ruleset review.
- Release before closure: only after the release owner explicitly accepts or closes the gap.

### PG-04 — Open VSX hosted publication boundary

- Unproven fact: the `straydog` credential ownership, authenticated authorization, approval environment, artifact identity, and publication process are controlled by the intended maintainer.
- Current established state: the repository contains a dispatch-only, digest-bound workflow that packages once, performs no-store public registry preflights before candidate retention and again after Environment approval, scopes the secret to the two authenticated CLI steps, and requires token-free approval/digest/revision/registry/authorization evidence to be durably uploaded before publication; all action references are immutable and repository SHA pinning is enforced. A post-command receipt is always attempted on a best-effort basis so its upload cannot turn a successful irreversible publication into a rerun-only failure. Retained public evidence reports `straydog` as verified/restricted and `straydog.okf-workbench@0.1.0` as available. Read-only GitHub metadata reports zero Environments and repository-level secret names `OPEN_VSX_TOKEN` and `STRAY_TOOLS_TOKEN`; secret values were not accessed and the workflow references neither name.
- Why not established here: public metadata does not establish the current PAT, exact namespace role, or current Publisher Agreement profile state. The named GitHub Environment, required reviewers, deployment policy, environment-scoped credential, authenticated namespace authorization, and exact-digest publication approval have not been configured or validated, and no artifact was published during this preflight. The owner and purpose of the repository-level `OPEN_VSX_TOKEN` name are also unverified; if it is a credential, it must be revoked or removed from repository scope before a new narrowly scoped Environment credential is provisioned.
- Potential impact: namespace misuse, credential leakage, or publication of an unreviewed artifact.
- Owner: Open VSX namespace owner and release maintainer.
- Smallest safe evidence: identify the owner and purpose of `OPEN_VSX_TOKEN` without exposing its value, revoke or remove it if it is a credential, configure and inspect the `open-vsx` Environment and independent review policy, confirm namespace ownership and Publisher Agreement state, add only a new environment-scoped credential, and retain approval for the exact workflow commit and VSIX digest immediately before publication.
- Release before closure: **no**.

## Commands and observed results

| Command | Result retained through 2026-07-24 |
| --- | --- |
| `node scripts/security-check.mjs --check-notices` | Pass; 78 exact production packages. |
| `npx vitest run --config test/security/vitest.config.ts` | Pass; security boundary suite. |
| `npm run build` | Pass; production extension and Webview bundles. |
| `npx playwright test --config test/security/playwright.config.ts` | Pass in Chromium; hostile metadata remained inert and intercepted fetch count was zero. |
| Fresh `node test/benchmarks/headed-editor-evidence.mjs ...` run | Pass at `2026-07-23T09:59:23.073Z` in genuine headed VS Code `1.129.1`: QR-002 `832 ms` p95 across 20 samples, QR-003 `d3` selected, and strict CDP network counts remote `0`, packaged local `2`, internal Webview `2`, other `0`. The tracked raw evidence SHA-256 is `0fd512512c0ff3d8fecbecd1c50d87bc6a727f2dad68fca3403ed8b400f7d3f5`. |
| [Current CI run 30058782170](https://github.com/koizumikento/okf-workbench/actions/runs/30058782170) | Pass at evidence revision `a5b2b75b7216d644f0d8d0f739db3a989bba7ca0`; quality/package, hostile-content Webview, and VS Code `1.121.0`/`1.129.1` integration jobs succeeded. |
| [Current Compatibility run 30058922150](https://github.com/koizumikento/okf-workbench/actions/runs/30058922150) | Pass; candidate, acceptance/Webview, and all seven current VS Code/VSCodium lifecycle jobs succeeded. Every `lifecycle.json` reports `status: passed` and binds the evidence revision, `straydog.okf-workbench@0.1.0`, and SHA-256 `d7be6180cd788b2ab5d9c7fc436de9eb2df97d967b16ccbc2578f48851f0b666`. |
| [Current Package smoke run 30058925030](https://github.com/koizumikento/okf-workbench/actions/runs/30058925030) | Pass; macOS, Ubuntu, Windows, browser security, and aggregate byte-identity jobs succeeded. Its three VSIX files, the CI artifact, Compatibility candidate, and local candidate were byte-for-byte identical at `613637` bytes. |
| [Historical CI run 29900857588](https://github.com/koizumikento/okf-workbench/actions/runs/29900857588) | Pass; all four quality/package, hostile-content Webview, VS Code 1.121.0 integration, and VS Code 1.127.0 integration jobs succeeded for the recorded old source. |
| [Historical Compatibility run 29900868002](https://github.com/koizumikento/okf-workbench/actions/runs/29900868002) | Pass for the exact `582231`-byte, SHA-256 `cc8c994cd35cfe2017945c38d0019f330cb33f628a94bf6508b2930c5c57c866` candidate; all nine candidate, acceptance/Webview, and seven then-required VS Code/VSCodium lifecycle jobs succeeded across Ubuntu, macOS, and Windows with zero calls through the listed Extension Host CommonJS builtin export-owner/global hooks. |
| [Historical Package smoke run 29900868155](https://github.com/koizumikento/okf-workbench/actions/runs/29900868155) | Pass; macOS, Ubuntu, and Windows independently produced the exact recorded old digest and byte size. |
| [Historical CI run 29901152549](https://github.com/koizumikento/okf-workbench/actions/runs/29901152549) | Pass at workflow-only commit `6505a7f7b017a44a851ab6edaaba28f6b6a72105`; all four jobs succeeded, and packaged content remained unchanged. |
| [Historical Package smoke run 29901183164](https://github.com/koizumikento/okf-workbench/actions/runs/29901183164) | Pass at the workflow-only commit; all three OS jobs and the aggregate byte-identity job succeeded for SHA-256 `cc8c994cd35cfe2017945c38d0019f330cb33f628a94bf6508b2930c5c57c866`, `582231` bytes, and three artifacts. |
| Preserved local `node scripts/compatibility/run-package-lifecycle.mjs ...` records | Pass for predecessor SHA-256 `65c137822052aa7f90ef08cc1300020fec4adcd7cbcec6aec88ae98fae64dad0` on local macOS arm64 in VS Code 1.121.0, VS Code 1.127.0, and VSCodium 1.121.03429. |
| `npm audit --omit=dev --audit-level=high --json` | Pass; zero reported production vulnerabilities. |
| Final local candidate quality/security/package gates | Pass on 2026-07-23 under Node `24.18.0`: global format/lint/typecheck; unit `840/840`; acceptance `8/8`; Node security `29/29`; hostile Webview `1/1`; Webview `12/12`; development Extension Host `2/2` on both VS Code `1.121.0` and `1.129.1`; source and packaged license/notice gates for 78 production packages; full-tree and production-only npm audits with zero vulnerabilities; and deterministic VSIX reproduction. The local VSIX has 11 entries, SHA-256 `d7be6180cd788b2ab5d9c7fc436de9eb2df97d967b16ccbc2578f48851f0b666`, and size `613637` bytes. Artifact-content revision: `e0c1f8895f3dc3391be3de47f1a517f82ae62f3c`; hosted evidence revision: `a5b2b75b7216d644f0d8d0f739db3a989bba7ca0`. |
| Historical `npm run package` before the 2026-07-23 MIT decision | Package produced; `vsce` warned that the project license was missing. Superseded source state. |
| Historical packaged license gate before the 2026-07-23 MIT decision | Expected failure: exact notice present, but zero project-license entries. Superseded by the post-MIT pre-final artifact result below. |
| Historical post-MIT pre-final local `package:check`, packaged security, notice, and reproducibility gates | Pass on 2026-07-23 for 11 entries, SHA-256 `94f71a906c964857ab5df3d971c744be1300bd17d25671df7935f298983ee200`, and `605189` bytes. The canonical `extension/LICENSE.txt` was byte-identical to the MIT root license and the exact notices were packaged. Superseded by the final local candidate row above. |
| Read-only GitHub repository/ruleset/protection/scanning API calls | Repository private; zero rulesets; `main` unprotected; secret scanning disabled; code scanning not enabled. |
| GitHub Actions permissions API | Pass; repository policy reports `enabled: true`, `allowed_actions: all`, and `sha_pinning_required: true`. |
| `node scripts/check-open-vsx-registry.mjs straydog okf-workbench 0.1.0 docs/evidence/open-vsx-registry.json` | Pass at `2026-07-23T08:35:06.452Z`; all three responses passed strict `Date` parsing and the `Age`-absent inclusive 30-second freshness/future-time guard, namespace verified/restricted, extension absent, and target version available. |

## Decision reconciliation

Current recommendation: **hold public release**.

- `LIC-01` is remediated in source and the final local candidate passed the packaged license,
  notice, and reproducibility gates. Hosted cross-platform byte identity also passed; human
  third-party review remains open.
- `CI-01` is remediated. `HOST-01` must be hardened or explicitly accepted before a privileged publication path is trusted.
- `PG-02` is closed for the current strict headed-Webview and packaged activation/read/untrusted-
  refusal surfaces. It remains open for trusted write-command execution and the documented hook
  exclusions. Older headed and hosted observations remain historical evidence only for their
  exact identities/bytes and named observation surfaces.
  `PG-01`, `PG-03`, and `PG-04` also remain open and have named owners and safe closure evidence.
- The retained public state of the `straydog` namespace and target version does not close current
  PAT authorization or Publisher Agreement verification. Public marketplace resources and explicit
  maintainer approval for the exact digest also remain unchecked in the release checklist.
- Suppressed candidates have explicit counter-evidence; not-applicable candidates identify absent surfaces; deferred candidates map to proof gaps.

The final local exact-notice, security, build, package, packaged-VSIX, reproducibility, npm audit,
and required hosted candidate gates pass. Do not convert this document to `ready` until the
remaining human and hosted publication-control evidence is attached.
