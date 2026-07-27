# Security, Privacy, and Dependency Release Evidence

- Status: **Approved for the `v0.1.0` tagged release attempt; live publication checks and
  post-publication editor verification remain required**
- Reviewed: 2026-07-27
- Scope: STR-214 release preflight for the current source, including fresh schema-v3 headed
  evidence, the final rebuilt VSIX, and current hosted receipts
- Audience: maintainers and release reviewers
- Decision controls: remediated candidates `LIC-01`, `CI-01`, and `HOST-01`; maintainer-approved
  `PG-01`; maintainer-accepted bounded residuals under `PG-02`; and fail-closed live validation for
  `PG-04`. Current packaged read/untrusted-refusal observations are complete. Strict re-evaluation
  shows the retained schema-v3 headed Webview record does not match the final candidate identities;
  fresh headed performance/network, trusted write-command, and interactive editor observations are
  assigned to post-publication verification.

This is a bounded release preflight, not a claim that OKF Workbench is secure, compliant, certified, penetration-tested, or legally cleared. Local repository evidence, command output, browser-harness evidence, hosted settings, and human approval are kept separate.

## Findings

### F-01 — Project license was not declared (resolved)

- Severity: **Resolved release blocker**
- Candidate: `LIC-01` (`remediated`)
- Evidence: on 2026-07-23 the maintainer selected MIT; `package.json` and the lockfile declare
  `MIT`, and the repository root contains the matching `LICENSE`.
- Remaining boundary: the final local and hosted-identical VSIX passed the packaged license gate.
  On 2026-07-27, the exact notice gates passed for 78 npm runtime packages and 26 Rust/Wasm
  dependencies, and the maintainer approved the generated inventories for the `0.1.0` release.
- Owner: maintainer / qualified license reviewer.

### F-02 — GitHub Actions are pinned to reviewed commits (resolved)

- Severity: **Resolved hardening finding**
- Candidate: `CI-01` (`remediated`)
- Evidence: every `uses:` entry in CI, package smoke, compatibility, and Open VSX release workflows is pinned to a reviewed 40-character commit SHA with its human-readable release tag in a comment. Workflow contract checks reject mutable references, and the hosted repository setting now enforces `sha_pinning_required: true` for GitHub Actions.
- Existing controls: ordinary workflows and the release workflow default to `contents: read`; there
  is no `pull_request_target`, OIDC permission, or self-hosted runner. Only the GitHub Release job
  receives job-scoped `contents: write`, and only the two Open VSX CLI steps receive
  `OPEN_VSX_TOKEN`.
- Residual risk: future action updates still require dependency review, and the tagged external
  publication boundary remains covered by `PG-04`.
- Owner: repository maintainer.

### F-03 — The hosted repository had no protected-main or scanning baseline (resolved)

- Severity: **Resolved release-governance finding**
- Candidate: `HOST-01` (`remediated`)
- Evidence: the repository is public and `main` protection applies to administrators, requires the
  four CI jobs and conversation resolution, and prohibits force-push and deletion. CODEOWNERS
  names the maintainer for the repository, workflows, security policy, and package/security gates.
  Secret scanning, push protection, Dependabot alerts/security updates, CodeQL default setup, and
  private vulnerability reporting are enabled.
- Verification: initial
  [CodeQL run 30060996475](https://github.com/koizumikento/okf-workbench/actions/runs/30060996475)
  passed Actions and JavaScript/TypeScript analysis. Read-only alert queries returned zero open
  CodeQL, secret-scanning, or Dependabot alerts on 2026-07-24.
- Residual risk: the maintainer's version tag is the accepted Open VSX publication authorization;
  credential ownership and live namespace authorization remain `PG-04`.
- Owner: repository maintainer.

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
`npm ci`. The tagged Open VSX candidate job uses the same command and script, so dependency
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

The source candidate contains the MIT project license and exact notice files. On 2026-07-27, the
universal VSIX retained by Compatibility run `30232289948` for revision
`2ba03b1f9bdbcf2a49418829255ac829936a8eb2` passed the canonical filename, exact-byte,
manifest-value, duplicate-entry, security, notice, and reproducibility checks at SHA-256
`54468ec2f4d1f28189552aecde581cea52e3a37a337e1c3c8f61d248f0a3ed52` and `972540`
bytes. Package smoke run `30232290835` independently passed all four target packages and aggregate
Wasm/CLI consistency. Earlier post-MIT artifacts remain historical input-readiness evidence.

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

The full development graph returned zero advisories during the earlier review after pinning the
test runner's transitive `diff` and `serialize-javascript` packages to reviewed fixed releases
through `overrides`. On 2026-07-27, a fresh full-tree audit reported
[`GHSA-mh99-v99m-4gvg`](https://github.com/advisories/GHSA-mh99-v99m-4gvg), a high-severity
availability-only `brace-expansion` advisory published after that review. The directly updatable
5.x development path is locked to patched `5.0.8`; older 1.x/2.x copies remain under the current
ESLint and VS Code test-runner dependency constraints with no compatible automated fix. They are
excluded from the VSIX and native CLI, receive only repository-controlled glob patterns in the
reviewed build/test workflow, and the production-only audit remains clean. The maintainer accepted
this bounded development-tool process-availability residual for `0.1.0`; update the parent tools
when compatible patched dependency paths become available.

## Candidate evidence receipts

| Candidate | Boundary | Claim | Evidence and disposition | Status | Decision impact |
| --- | --- | --- | --- | --- | --- |
| `LIC-01` | Artifact/license | The extension lacked a maintainer-approved project license. | The maintainer selected MIT on 2026-07-23; the manifest, lockfile, and root `LICENSE` agree, the final candidate passed the packaged license gate, all downloaded hosted VSIX files were byte-identical to it, and the maintainer approved the third-party inventory for publication on 2026-07-27. | remediated | Re-review notices when the production dependency graph changes. |
| `CI-01` | CI/CD | Workflow actions are not immutable. | All workflow action references are pinned to reviewed full commit SHAs; static workflow checks reject mutable references. | remediated | Re-review action updates; no current finding. |
| `CSP-01` | Webview | Workspace content can relax CSP or execute inline code. | HTML is a static shell, the nonce is random base64url, content is not interpolated, and the policy has `default-src 'none'`, nonce-only scripts, and `connect-src 'none'`. Tests pass. | suppressed | No finding. |
| `NET-01` | Privacy/network | A core workflow sends bundle content to a remote service. | First-party source contains no network API or remote runtime URL; there is no runtime HTTP client; Chromium interception observed zero fetch calls. The retained schema-v3 headed VS Code `1.129.1` Webview record used the strict pre-navigation CDP envelope and observed zero remote HTTP(S)/WS requests for its recorded identities, but strict re-evaluation shows those identities do not match the final candidate. Current seven-lane packaged captures recorded zero calls through the acceptance driver's listed CommonJS builtin export-owner/global hooks during activation and request-correlated Validate/Open completion, retained the hooks until Extension Host exit, and refused all four write commands in untrusted workspaces. `3d-force-graph` receives in-memory `graphData`, and CSP denies connections. | partially suppressed for current candidate | Packaged read/untrusted-refusal surfaces pass; fresh final-candidate headed Webview and trusted write-command observation remain under `PG-02` and are assigned to post-publication verification. |
| `XSS-01` | Webview/DOM | Metadata or link text reaches an executable HTML sink. | First-party Webview uses `textContent`, DOM creation, and `replaceChildren`; source scan finds no unsafe sink; hostile browser test passes. | suppressed | No finding. |
| `PROTO-01` | Message boundary | A Webview can supply a privileged URI or malformed graph. | Strict decoders reject unknown keys, stale revisions, bad references, and source URI fields. Host maps current node IDs to private URI objects. | suppressed | No finding. |
| `NAV-01` | Message boundary | A navigation-provider error becomes an unhandled promise rejection. | Controller catches navigator rejection, reports only the error type through the configured observer, and returns `rejected`; listener-path regression test passes. | suppressed | No finding after remediation. |
| `PATH-01` | Workspace read/write | Generated paths can escape the selected bundle, an approved proposal can outlive removal of its workspace folder, or a retained read selection can be redirected outside its workspace through an existing, transient, or restored symbolic-link ancestor. | URI-first containment plus proposal preflight rejects traversal, encoded separators, mismatched targets, cross-authority URIs, symbolic-link ancestors, non-directory parents, and optional parents that appear while the existing baseline is captured. Write workflows capture exact workspace-folder membership, invalidate their preview on removal, reject containing-parent or same-URI-readd substitution, recheck before each change, and carry authorization and target-parent read boundaries through provider preparation, expected-content comparison, and post-write verification. Local `file:` stats retain native device/inode/mode/nanosecond-ctime/birthtime generations. Reads require that generation, open one handle with terminal no-follow where available, verify with `fstat` before reading, read through the verified handle, compare handle and pathname generations afterward, and return bytes only after confirmed close. Runtime and authoring reads capture each distinct resource parent; traversal withholds every directory result until its root-to-current chain passes, and nested generation failures invalidate the load. Real temporary regressions prove zero applicator writes to a linked directory; zero external bytes, enumerated names, titles, labels, graph state, diagnostics, or partial replacement from transient command/watcher/discovery swap-and-restore attacks at root and deep parents; and explicit success/failure tracking for every injected handle close. | suppressed for the tested local-file read and fail-detect write boundary | Non-`file:` providers expose no handle, inode, ETag, conditional read, or existing-file compare-and-swap in the VS Code API and are an explicit trusted-provider metadata-sandwich boundary. Node exposes no `openat` pathname walk, so this is not a universal atomic-filesystem or update-CAS claim against privileged mount changes or mutations in the interval between comparison and provider write. Remote and third-party provider behavior remains compatibility evidence. |
| `LOG-01` | Secrets/data | Workspace bodies or secret-bearing fields are written to logs. | Source scan rejects direct console output and sensitive fields in logger calls. Current activation logs only event names, counts, revisions, refusal reasons, and error types; previews remain local editor documents. | suppressed | Hosted log review remains `PG-03`. |
| `PRIV-01` | Auth/account/telemetry/AI | The MVP introduces an account, authentication, telemetry, or AI-provider boundary. | No server, auth contribution/API, account flow, telemetry API, AI dependency, API-key flow, or runtime network client exists. | not_applicable | A new decision and new preflight are required if scope changes. |
| `PUBLIC-01` | Public exposure | The candidate exposes an inbound network service. | The artifact is a desktop workspace extension with no server, listener, route, webhook, or cloud resource. | not_applicable | No public-service surface reviewed. |
| `DEP-01` | Dependency license | A production dependency has missing, forbidden, high-risk, or unresolved licensing. | Exact 78-package gate reports only MIT, ISC, and BSD-3-Clause and includes each notice text. | suppressed | Human license review remains `PG-01`. |
| `VULN-01` | Known advisories | npm reports a known production or development vulnerability. | The 2026-07-27 production-only audit reports zero vulnerabilities. The full development graph reports `GHSA-mh99-v99m-4gvg` through ESLint/Mocha glob tooling; the directly updatable 5.x path is fixed at `5.0.8`, while constrained 1.x/2.x paths remain excluded from release artifacts and receive reviewed repository-controlled patterns. | suppressed for production; accepted development-tool availability residual | Track compatible upstream ESLint/VS Code test-runner updates; do not pass attacker-controlled brace patterns to the affected development tools. |
| `COMPAT-01` | Packaged editor lifecycle | The exact candidate does not complete the required editor/OS lifecycle matrix. | Final revision `2ba03b1f9bdbcf2a49418829255ac829936a8eb2` passed CI `30232280114`, all seven editor/OS lifecycle lanes plus the acceptance/Webview gate in Compatibility `30232289948`, and all four target packages plus aggregate consistency in Package smoke `30232290835`. Release workflow `30233342837` reproduced and retained the packages from the tagged source state. | remediated for the qualified revision | Fresh final-candidate interactive editor verification remains assigned to the post-publication checklist. |
| `HOST-01` | Repository/hosted settings | Protected-main and provider scanning controls are absent. | The public repository protects `main` with four required CI checks, administrator enforcement, conversation resolution, and force-push/deletion denial. CODEOWNERS is present; secret scanning with push protection, Dependabot, CodeQL default setup, and private vulnerability reporting are enabled. Initial CodeQL passed and all three open-alert queries returned zero. | remediated | Recheck settings and alerts before future releases; live `0.1.0` publication authorization is retained under `PG-04`. |
| `RELEASE-01` | Open VSX publishing | A release tag publishes only reviewed, retained bytes with a narrowly exposed credential. | The `v*`-only workflow requires the tagged commit to be contained in protected `main`, binds the tag to the manifest version and dated changelog, retains one universal and four target VSIX packages plus four standalone CLI archives, verifies checksums and CLI byte parity, creates the GitHub Release, and exposes `OPEN_VSX_TOKEN` only to PAT verification and publication. Signed tag `v0.1.0` completed workflow `30233342837`: live PAT verification passed, all five Open VSX packages were published, the GitHub Release was created, and the package manifests were pushed. The public universal VSIX digest matches the retained candidate. | remediated for `0.1.0` | Repeat the fail-closed workflow and authorization review for every release. |

## Coverage ledger

| Boundary | Status | Evidence | Receipts | Exclusions / remaining gaps |
| --- | --- | --- | --- | --- |
| Webview CSP, content injection, and local assets | covered | Host HTML, DOM source, protocol source, unit tests, Chromium harness, production bundle, headed VS Code Webview CDP network capture | `CSP-01`, `NET-01`, `XSS-01` | The zero-egress observation is candidate/editor-specific, not a universal guarantee. |
| Privileged source navigation and messaging | covered | Strict decoder, controller, host source map, navigation rejection regression | `PROTO-01`, `NAV-01` | No active exploit testing was performed. |
| Workspace path/read-and-write containment | covered for pure, memory-backed, and tested local `file:` symlink boundaries | Exact open-folder membership tracker, modeless-workflow invalidation, provider pre-commit authorization, path guard, native identity-bound read handles with close-failure tests, per-resource and per-traversed-directory parent generations, proposal applicator read boundaries, runtime/authoring regressions, VS Code `FileType.SymbolicLink` mapping, and real temporary-workspace permanent plus root/deep transient swap-and-restore regressions for command, watcher, discovery, and enumeration paths | `PATH-01` | Non-`file:` providers are an explicit trusted-provider boundary owned by compatibility evidence; no universal `openat`/privileged-mount atomicity or existing-file update-CAS claim is made. |
| Secrets, logs, telemetry, and content egress | covered statically, in the current strict headed Webview, and for current packaged activation/read/untrusted-refusal phases | First-party static scan, activation log review, browser interception, current schema-v3 headed Webview CDP capture, current packaged Extension Host CommonJS-owner/global hooks, hosted settings and alert APIs | `NET-01`, `LOG-01`, `PRIV-01`, `COMPAT-01`, `HOST-01` | The current observations are candidate/editor/lane-specific. The Extension Host hooks are not OS isolation and exclude ESM named bindings, cached references, raw/prototype bindings, `dns.promises`, child processes, editor-owned traffic, Webview traffic, and trusted write-command execution. Hosted scanning is enabled and its initial open-alert queries are clean, but remains point-in-time evidence. |
| Production dependency and license inventory | covered technically and approved for `0.1.0` | Lock graph, installed manifests, license texts, integrity, install-script gate, npm audit, and maintainer approval | `DEP-01`, `VULN-01` | Re-run technical and human review when the production graph changes. |
| Project license and packaged notices | covered and approved in the final hosted-identical artifact | MIT manifest/root license plus exact final local and hosted VSIX license and notice inspection | `LIC-01` | Re-review changed notices before later releases. |
| CI workflows and hosted repository policy | covered for `0.1.0` | Full-SHA action pins, local YAML permissions/triggers/artifacts, version-tag release workflow, protected-main/scanning APIs, and successful tagged publication | `CI-01`, `HOST-01`, `RELEASE-01` | Hosted controls and credentials remain point-in-time; repeat their review for later releases. |
| Authentication/authorization and inbound public service | covered as absent | Manifest, architecture, source and runtime dependency inventory | `PRIV-01`, `PUBLIC-01` | Re-review if scope changes. |

## Proof gaps and required human verification

### PG-01 — Third-party license and notice approval (closed for `0.1.0`)

- Established fact: the maintainer selected MIT for the project's own code on 2026-07-23 and
  approved the generated third-party inventory for publication on 2026-07-27.
- Retained technical evidence: the tagged candidate passed the exact production license inventory,
  notice freshness, packaged-license, and production-only audit gates in release workflow
  `30233342837`.
- Remaining boundary: repeat both technical inventory and maintainer review whenever the production
  dependency or distributed-notice set changes.
- Owner: maintainer and qualified license reviewer.
- Smallest safe evidence: a passing final packaged-license gate plus reviewed notice inventory and
  an explicit approval record.
- Closure: on 2026-07-27, the exact notice gates passed for 78 npm runtime packages and 26
  Rust/Wasm dependencies, and the maintainer explicitly approved distribution of the reviewed
  inventories for `0.1.0`.
- Release before closure: **no; closed for `0.1.0`**.

### PG-02 — Actual editor network and data-egress observation (packaged surface remains open)

- Predecessor headed Webview evidence: the genuine schema-v3 capture at
  `2026-07-23T09:59:23.073Z` attached the strict pre-navigation CDP recorder to VS Code `1.129.1`
  commit `8a7abeba6e03ea3af87bfbce9a1b7e48fed567b8` and retained the exact current
  production/input identities. Across initial loading, watcher refresh, search, filter, selection,
  engine comparison, and disposal it observed zero remote HTTP(S)/WS requests, two local packaged
  resources, two internal Webview navigations, and zero other-scheme requests. The tracked raw
  record is `docs/evidence/performance/vscode-1.129.1.json`, SHA-256
  `0fd512512c0ff3d8fecbecd1c50d87bc6a727f2dad68fca3403ed8b400f7d3f5`.
  Strict re-evaluation on 2026-07-27 reports Extension Host JavaScript, Webview JavaScript/CSS,
  domain-separated bundle-set, runtime, build-input, and harness identity mismatches against the
  final `0.1.0` candidate. It is not final-candidate performance or network evidence.
- Current packaged evidence: the `972540`-byte universal VSIX from revision
  `2ba03b1f9bdbcf2a49418829255ac829936a8eb2` and SHA-256
  `54468ec2f4d1f28189552aecde581cea52e3a37a337e1c3c8f61d248f0a3ed52` completed the
  current seven-lane packaged lifecycle in
  [Compatibility run 30232289948](https://github.com/koizumikento/okf-workbench/actions/runs/30232289948).
  Every clean, untrusted, and upgrade activation installed the recorded CommonJS-owner/global
  hooks. Activation, request-correlated Validate/Open completion, and guarded quiescence recorded
  zero calls; the hooks remained installed until Extension Host exit. The catalog-derived
  untrusted probe refused Initialize Bundle, New Concept, Regenerate Indexes, and Set Up Agent
  Integration. Every lifecycle report binds the candidate identity/version and qualified revision;
  [Package smoke run 30232290835](https://github.com/koizumikento/okf-workbench/actions/runs/30232290835)
  independently passed every target package and the aggregate canonical-Wasm/CLI-parity check.
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
- Disposition: **current packaged activation/read/untrusted-refusal boundaries passed; fresh
  final-candidate headed Webview and trusted write-command observations remain open**. The
  VS Code `1.129.1` pre-navigation CDP record is retained at
  `docs/evidence/performance/vscode-1.129.1.{json,md}` for its predecessor identities. The current
  packaged run supplies request-correlated completion and host-exit-lifetime hook evidence, but it
  does not execute the trusted write-command workflows under those hooks.
- Release decision: on 2026-07-27, the maintainer accepted these bounded residuals for the initial
  release and assigned actual trusted write-command UI, external-provider, and clean installed
  extension verification to the post-publication checklist. This is risk acceptance, not evidence
  that the unobserved surfaces passed.

### PG-03 — Hosted GitHub protection, scanning, and alert review (closed)

- Established state: the public repository enforces immutable Action references and protects
  `main` with the four required CI checks, administrator enforcement, conversation resolution, and
  force-push/deletion denial. CODEOWNERS identifies workflow and release-gate ownership. Secret
  scanning with push protection, Dependabot, CodeQL default setup, and private vulnerability
  reporting are enabled.
- Retained verification: initial CodeQL passed and read-only CodeQL, secret-scanning, and Dependabot
  queries returned zero open alerts on 2026-07-24.
- Remaining boundary: these are point-in-time hosted controls and alerts. Recheck them before
  future releases. The live `0.1.0` credential and namespace result is retained separately under
  `PG-04`.

### PG-04 — Open VSX hosted publication boundary (closed for `0.1.0`)

- Established state: ADR 0006 makes a matching `v*` tag on a reviewed `main` commit the
  publication authorization. The workflow reruns deterministic package/security gates, retains one
  VSIX and checksum, creates the GitHub Release, verifies the retained checksum, and exposes the
  secret only to `ovsx verify-pat straydog` and the duplicate-safe publish command. All action
  references are immutable and repository SHA pinning is enforced.
- Retained live evidence: signed tag `v0.1.0` completed release workflow `30233342837`.
  `ovsx verify-pat straydog` passed, universal plus four target VSIX packages were published, the
  public API identifies publisher `koizumikento` under the verified/restricted `straydog`
  namespace, and the downloaded universal digest matches the retained candidate.
- Remaining boundary: GitHub does not reveal the secret value, and the Publisher Agreement is an
  out-of-band account record. Credential ownership, scope, storage, and agreement readiness must be
  rechecked for future releases.
- Owner: Open VSX namespace owner and release maintainer.
- Release authorization: on 2026-07-27, the maintainer authorized the configured credential for
  the controlled tagged release and represented the publishing prerequisites as valid. The
  fail-closed workflow supplied the retained live confirmation required for `0.1.0`.

## Commands and observed results

| Command | Result retained through 2026-07-27 |
| --- | --- |
| `node scripts/security-check.mjs --check-notices` | Pass; 78 exact production packages. |
| `npx vitest run --config test/security/vitest.config.ts` | Pass; security boundary suite. |
| `npm run build` | Pass; production extension and Webview bundles. |
| `npx playwright test --config test/security/playwright.config.ts` | Pass in Chromium; hostile metadata remained inert and intercepted fetch count was zero. |
| Fresh `node test/benchmarks/headed-editor-evidence.mjs ...` run | Pass at `2026-07-23T09:59:23.073Z` in genuine headed VS Code `1.129.1`: QR-002 `832 ms` p95 across 20 samples, QR-003 `d3` selected, and strict CDP network counts remote `0`, packaged local `2`, internal Webview `2`, other `0`. The tracked raw evidence SHA-256 is `0fd512512c0ff3d8fecbecd1c50d87bc6a727f2dad68fca3403ed8b400f7d3f5`. |
| [Prior universal CI run 30058782170](https://github.com/koizumikento/okf-workbench/actions/runs/30058782170) | Pass at evidence revision `a5b2b75b7216d644f0d8d0f739db3a989bba7ca0`; quality/package, hostile-content Webview, and VS Code `1.121.0`/`1.129.1` integration jobs succeeded. |
| [Prior universal Compatibility run 30058922150](https://github.com/koizumikento/okf-workbench/actions/runs/30058922150) | Pass; candidate, acceptance/Webview, and all seven current VS Code/VSCodium lifecycle jobs succeeded. Every `lifecycle.json` reports `status: passed` and binds the evidence revision, `straydog.okf-workbench@0.1.0`, and SHA-256 `d7be6180cd788b2ab5d9c7fc436de9eb2df97d967b16ccbc2578f48851f0b666`. |
| [Prior universal Package smoke run 30058925030](https://github.com/koizumikento/okf-workbench/actions/runs/30058925030) | Pass; macOS, Ubuntu, Windows, browser security, and aggregate byte-identity jobs succeeded. Its three VSIX files, the CI artifact, Compatibility candidate, and local candidate were byte-for-byte identical at `613637` bytes. |
| [Historical CI run 29900857588](https://github.com/koizumikento/okf-workbench/actions/runs/29900857588) | Pass; all four quality/package, hostile-content Webview, VS Code 1.121.0 integration, and VS Code 1.127.0 integration jobs succeeded for the recorded old source. |
| [Historical Compatibility run 29900868002](https://github.com/koizumikento/okf-workbench/actions/runs/29900868002) | Pass for the exact `582231`-byte, SHA-256 `cc8c994cd35cfe2017945c38d0019f330cb33f628a94bf6508b2930c5c57c866` candidate; all nine candidate, acceptance/Webview, and seven then-required VS Code/VSCodium lifecycle jobs succeeded across Ubuntu, macOS, and Windows with zero calls through the listed Extension Host CommonJS builtin export-owner/global hooks. |
| [Historical Package smoke run 29900868155](https://github.com/koizumikento/okf-workbench/actions/runs/29900868155) | Pass; macOS, Ubuntu, and Windows independently produced the exact recorded old digest and byte size. |
| [Historical CI run 29901152549](https://github.com/koizumikento/okf-workbench/actions/runs/29901152549) | Pass at workflow-only commit `6505a7f7b017a44a851ab6edaaba28f6b6a72105`; all four jobs succeeded, and packaged content remained unchanged. |
| [Historical Package smoke run 29901183164](https://github.com/koizumikento/okf-workbench/actions/runs/29901183164) | Pass at the workflow-only commit; all three OS jobs and the aggregate byte-identity job succeeded for SHA-256 `cc8c994cd35cfe2017945c38d0019f330cb33f628a94bf6508b2930c5c57c866`, `582231` bytes, and three artifacts. |
| Preserved local `node scripts/compatibility/run-package-lifecycle.mjs ...` records | Pass for predecessor SHA-256 `65c137822052aa7f90ef08cc1300020fec4adcd7cbcec6aec88ae98fae64dad0` on local macOS arm64 in VS Code 1.121.0, VS Code 1.127.0, and VSCodium 1.121.03429. |
| `npm audit --omit=dev --audit-level=high --json` | Pass; zero reported production vulnerabilities. |
| `npm audit --audit-level=high` | Development-only exception: `GHSA-mh99-v99m-4gvg` remains through constrained ESLint/Mocha glob paths. The updatable 5.x copy is fixed at `5.0.8`; no affected copy is shipped. |
| [Release workflow 30233342837](https://github.com/koizumikento/okf-workbench/actions/runs/30233342837) | Pass for signed tag `v0.1.0`; candidate gates, four native CLI/target VSIX jobs, every retained checksum, GitHub Release creation, authenticated Open VSX publication, and Homebrew/Scoop manifest publication succeeded. |
| Public Open VSX universal download and `node scripts/package-check.mjs` | Pass on 2026-07-27; 14 entries and SHA-256 `54468ec2f4d1f28189552aecde581cea52e3a37a337e1c3c8f61d248f0a3ed52`, identical to the retained hosted candidate. |
| Prior universal local candidate quality/security/package gates | Pass on 2026-07-23 under Node `24.18.0`: global format/lint/typecheck; unit `840/840`; acceptance `8/8`; Node security `29/29`; hostile Webview `1/1`; Webview `12/12`; development Extension Host `2/2` on both VS Code `1.121.0` and `1.129.1`; source and packaged license/notice gates for 78 production packages; full-tree and production-only npm audits with zero vulnerabilities; and deterministic VSIX reproduction. The local VSIX has 11 entries, SHA-256 `d7be6180cd788b2ab5d9c7fc436de9eb2df97d967b16ccbc2578f48851f0b666`, and size `613637` bytes. Artifact-content revision: `e0c1f8895f3dc3391be3de47f1a517f82ae62f3c`; hosted evidence revision: `a5b2b75b7216d644f0d8d0f739db3a989bba7ca0`. |
| Current local bundled-CLI package gate | Pass on 2026-07-24 for `darwin-arm64`: 16-entry target VSIX at SHA-256 `c17cc9b1f15614fb53d88f42552c70a71be4f4015c3b4662c4e67f5c4c26624e`, `1571230` bytes; Unix mode `0755`; deterministic reproduction; and exact standalone/bundled CLI parity at SHA-256 `f0f4138ab3259244e3ac600b83464950e4a9300013e9328f5cb1792998be1c10`, `1164944` bytes. An isolated VS Code `1.130.0` install reported the bundled CLI available for `darwin-arm64`; `OKF: Open CLI Terminal` resolved `okf` and `OKF_WORKBENCH_CLI` to the same installed extension executable and returned the version envelope. Superseded as release authority by workflow `30233342837`. |
| Historical `npm run package` before the 2026-07-23 MIT decision | Package produced; `vsce` warned that the project license was missing. Superseded source state. |
| Historical packaged license gate before the 2026-07-23 MIT decision | Expected failure: exact notice present, but zero project-license entries. Superseded by the post-MIT pre-final artifact result below. |
| Historical post-MIT pre-final local `package:check`, packaged security, notice, and reproducibility gates | Pass on 2026-07-23 for 11 entries, SHA-256 `94f71a906c964857ab5df3d971c744be1300bd17d25671df7935f298983ee200`, and `605189` bytes. The canonical `extension/LICENSE.txt` was byte-identical to the MIT root license and the exact notices were packaged. Superseded by the final local candidate row above. |
| Read-only GitHub repository/protection/scanning API calls | Repository public; `main` protected for administrators by four required CI checks, conversation resolution, and force-push/deletion denial; CODEOWNERS present; secret scanning/push protection, Dependabot, CodeQL default setup, and private vulnerability reporting enabled; initial CodeQL passed; zero open CodeQL, secret-scanning, or Dependabot alerts. |
| GitHub Actions permissions API | Pass; repository policy reports `enabled: true`, `allowed_actions: all`, and `sha_pinning_required: true`. |
| `node scripts/check-open-vsx-registry.mjs straydog okf-workbench 0.1.0 docs/evidence/open-vsx-registry.json` | Pass at `2026-07-23T08:35:06.452Z`; all three responses passed strict `Date` parsing and the `Age`-absent inclusive 30-second freshness/future-time guard, namespace verified/restricted, extension absent, and target version available. |

## Decision reconciliation

Current state: **`v0.1.0` publication is complete; finish the remaining clean-editor,
package-manager install, uninstall, and credential-lifecycle checks in post-publication
verification**.

- `LIC-01` is remediated in source. The exact npm and Rust/Wasm notice gates passed on 2026-07-27,
  and the maintainer approved the generated inventories for `0.1.0`.
- `CI-01` and `HOST-01` are remediated. Hosted branch protection, workflow ownership, scanning,
  private vulnerability reporting, and initial alert review close `PG-03`; point-in-time rechecks
  remain part of release operation.
- `PG-02` is closed for current packaged activation/read/untrusted-refusal surfaces. Strict
  re-evaluation demotes the retained headed record to predecessor evidence because its identities
  do not match the final candidate. Fresh final-candidate headed Webview, trusted write-command
  execution, and the documented hook exclusions remain open. The maintainer accepted these
  bounded residuals for the initial release and assigned actual editor verification to the
  post-publication checklist.
- `PG-01` and `PG-04` are closed for `0.1.0`. The successful tagged workflow retains current PAT
  authorization, checksum verification, all five Open VSX publications, the GitHub Release, and
  the package-repository update.
- Public marketplace and CLI resources are available, and the maintainer authorized the
  `v0.1.0` release on 2026-07-27.
- Suppressed candidates have explicit counter-evidence; not-applicable candidates identify absent surfaces; deferred candidates map to proof gaps.

The final local exact-notice, security, build, package, packaged-VSIX, reproducibility,
production-only npm audit, and required hosted candidate gates pass. The accepted full-development
audit exception is recorded above. The tagged workflow retains successful credential, checksum,
GitHub Release, package-repository, and Open VSX evidence. The accepted interactive editor and
package-manager install gaps remain explicitly assigned to post-publication verification.
