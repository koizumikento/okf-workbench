# Acceptance evidence

- Target: MVP acceptance scenarios AC-001 through AC-008
- Packaged extension ID: `straydog.okf-workbench`
- Evidence date: 2026-07-27
- Component harness: `test/acceptance/vitest.config.ts`
- Historical hosted packaged lifecycle run: [Compatibility 29900868002](https://github.com/koizumikento/okf-workbench/actions/runs/29900868002)
- Historical hosted package byte-identity run: [Package smoke 29901183164](https://github.com/koizumikento/okf-workbench/actions/runs/29901183164)
- Current exact-candidate hosted qualification:
  [Compatibility 30232289948](https://github.com/koizumikento/okf-workbench/actions/runs/30232289948)
  and
  [Package smoke 30232290835](https://github.com/koizumikento/okf-workbench/actions/runs/30232290835)
  passed every configured lane and aggregate check for revision
  `2ba03b1f9bdbcf2a49418829255ac829936a8eb2`
- Predecessor schema-v3 headed Webview observation: the VS Code `1.129.1` capture in
  `docs/evidence/performance/vscode-1.129.1.{json,md}` passed for its recorded inputs. Strict
  re-evaluation on 2026-07-27 reports production and harness identity mismatches against the final
  candidate, so final-candidate headed performance/network evidence is unmeasured and assigned to
  post-publication verification.
- Preserved predecessor-candidate local evidence: `docs/evidence/compatibility/`

## Evidence semantics

This document deliberately separates deterministic component automation,
packaged lifecycle automation, and full user-scenario evidence.

- **Component automated** means a checked-in Vitest scenario exercises the repository's pure core, an injectable command/workspace boundary, or Webview presentation state. The command tests use in-memory doubles, not VS Code UI. A passing result supports only the assertions named in the table.
- **Development Extension Host provider automated** means the built development extension ran in a real VS Code Extension Host against a test-owned, registered, read-only `okfmem:` `FileSystemProvider`. It proves the read-only command boundary named below, but it is neither a packaged-VSIX result nor evidence for an external remote provider.
- **Current packaged lifecycle automated** means the exact `972540`-byte universal VSIX with
  SHA-256 `54468ec2f4d1f28189552aecde581cea52e3a37a337e1c3c8f61d248f0a3ed52`
  passed the current seven-lane hosted matrix for revision
  `2ba03b1f9bdbcf2a49418829255ac829936a8eb2`. Each retained report binds that revision,
  extension `straydog.okf-workbench@0.1.0`, and the same candidate digest. The reports prove clean,
  untrusted, upgrade, and uninstall lifecycles; request-correlated Validate Bundle and Open 3D
  Graph completion; catalog-derived refusal of all four write commands in an untrusted workspace;
  zero calls through the listed CommonJS-owner/global hooks during the observed active phases; and
  hooks retained until Extension Host exit. Independent CI, Compatibility, macOS, Ubuntu, and
  Windows artifacts were byte-for-byte identical.
- **Historical packaged lifecycle automated** means the exact `582231`-byte normalized VSIX from commit `aa90832aab64dac1bccf9c9092fabc004991f7b1` (SHA-256 `cc8c994cd35cfe2017945c38d0019f330cb33f628a94bf6508b2930c5c57c866`) passed its then-required hosted matrix: VS Code 1.121.0 on Ubuntu; VS Code 1.127.0 on Ubuntu, macOS, and Windows; and VSCodium 1.121.03429 on Ubuntu, macOS, and Windows. The retained schema proves six registered commands; dispatch of Validate Bundle followed by a newer runtime publication; dispatch of Open 3D Graph followed by a graph data-application acknowledgement; zero calls through the acceptance driver's listed CommonJS builtin export-owner/global hooks while they were installed; untrusted-workspace read availability and one early Initialize Bundle refusal; a real `0.0.0` → `0.1.0` VSIX upgrade; uninstall; and settings/workspace preservation. It did not correlate either asynchronous signal to the request that initiated it, and it restored the hooks after the report on success. It is therefore not request-correlated command-completion or host-exit-lifetime evidence. Independent macOS, Ubuntu, and Windows package-smoke jobs reproduced the same digest and byte size. A later historical workflow-only commit, `6505a7f7b017a44a851ab6edaaba28f6b6a72105`, left packaged content unchanged and added an aggregate gate that explicitly passed those three artifacts. Current source and exact package bytes do not inherit this evidence.
- **Historical schema-v3 headed Webview observation** means the older VS Code 1.127.0 record
  observed zero remote HTTP(S)/WS requests, two local packaged-resource loads, and no other scheme
  for its recorded identities. It predates the mandatory security envelope and the current
  diagnostics/WebGL/interaction contract, so it is neither current release evidence, packaged
  Extension Host network evidence, nor a cross-editor guarantee.
- **Preserved local predecessor evidence** means the checked-in JSON files describe the earlier `581830`-byte candidate from commit `524eca3f36e1a1b3da935495d3fbbd0eb0d03f56` (SHA-256 `65c137822052aa7f90ef08cc1300020fec4adcd7cbcec6aec88ae98fae64dad0`) on local macOS arm64. They remain useful audit evidence but are not records for either the historical hosted candidate or the current candidate.
- **Full scenario not evidenced** means the observable workflow has not yet been driven end to end through the actual editor UI and workspace provider. Component and lifecycle coverage can coexist without completing the scenario.

All eight scenarios remain **Partial** because their remaining UI/provider clauses
are material. Here, **Partial describes evidence completeness, not implementation
status**. The qualifiers in the table state whether the partial result has component
evidence only or also packaged lifecycle evidence. Do not use this file to claim full
MVP acceptance.

## Automated component command

Run the dedicated suite without changing `package.json`:

```sh
mise x node@24.18.0 -- npm exec -- vitest run --config test/acceptance/vitest.config.ts
```

The suite is deterministic: it injects its clock, uses an in-memory workspace and `memfs:` logical bundle URIs, reads no external fixture, and makes no network request. AC-008 additionally replaces the JavaScript `fetch` boundary with a throwing test double. That check does not establish operating-system or Electron process network isolation.

The Extension Host suite separately registers an actual non-`file:` workspace provider and executes
the public commands with its Explorer/root URI:

```sh
mise x node@24.18.0 -- env VSCODE_TEST_VERSION=1.121.0 npm run test:integration
mise x node@24.18.0 -- env VSCODE_TEST_VERSION=1.129.1 npm run test:integration
```

That test requires provider reads for the selected bundle, publishes the broken-link diagnostic at
the exact `okfmem://` concept URI (including authority, Unicode, and a literal `%2F` filename
segment), waits for the graph Webview's render acknowledgement for the published revision, and
asserts that Validate Bundle and Open 3D Graph make no provider mutation. It does not automate a
write command, an external remote extension, or packaged installation.

The hosted packaged matrix and preserved local records are linked from the
[compatibility matrix](compatibility-matrix.md). The current run closes the cross-platform
lifecycle, request-correlated read-command completion, untrusted write-command refusal, and guarded
Extension Host CommonJS-owner/global hook subset for its exact candidate. It does not complete the
manual UI/provider clauses in the table or establish full user-scenario acceptance.

The current lifecycle harness reports its exact intercepted-property/global inventory. It replaces
these properties on the CommonJS builtin export-owner objects returned by `require`:
`node:http.get/request`, `node:https.get/request`, `node:http2.connect`,
`node:net.connect/createConnection`, `node:tls.connect`,
`node:dns.lookup/resolve/resolve4/resolve6`, `node:dgram.createSocket`, and the available
`globalThis.fetch` and `globalThis.WebSocket` globals. It retains those hooks until Extension Host
exit. This is not operating-system isolation and does not observe ESM named bindings, cached
references, prototypes, raw bindings, `dns.promises`, child processes, editor-owned traffic, or Webview traffic. The
persisted attempt list ends when the report is created; the hooks remain installed to deny later
tail calls until process exit. The post-uninstall phase installs no observer and records network attempts and guarded quiescence as
not observed; that phase proves extension API absence only. The current retained run attributes
the stricter schema and exhaustive four-command untrusted refusal probe to the exact current
candidate.

## Scenario evidence map

| ID | Component-automated assertions | Packaged-editor proof still required | Overall |
| --- | --- | --- | --- |
| AC-001 | Injectable command handlers initialize the Minimal preset, preview/apply both operations, select the root, create a concept, request its URI be opened, and produce a bundle with no conformance error in an in-memory workspace. The current hosted matrix additionally proves clean packaged activation, the six-command catalog, and request-correlated Validate Bundle completion for the exact candidate. | Actual QuickPick/input/preview UI, physical or remote workspace writes, active-editor state, and the under-two-minute first-use target. | Partial — component + current packaged lifecycle |
| AC-002 | A custom `experiment-result` type and nested producer fields survive parse → index regeneration → reparse unchanged; unknown values cause no finding. | A real supported command/write flow against workspace storage, including byte-level verification after save and reload. | Partial — component |
| AC-003 | Invalid YAML and a broken link produce category/severity/URI/range-addressable findings; a repaired revision clears both findings. The development Extension Host additionally publishes the broken-link Problems diagnostic at the exact registered `okfmem:` provider URI. The current hosted matrix proves request-correlated Validate Bundle diagnostics/runtime publication for the exact packaged candidate. | Problems-panel navigation, save-event debounce, watcher convergence, packaged non-`file:` execution, and external provider coverage. | Partial — component + development provider boundary + current packaged lifecycle |
| AC-004 | The injectable index command previews and applies one managed-region update in memory, preserves bytes outside the region, and returns unchanged without a second preview/write. | Diff preview rendering, cancellation/apply behavior through actual editor UI, and physical or remote workspace writes. | Partial — component |
| AC-005 | The graph model exposes directed backlinks, broken-link counts, and orphan state; Webview state supports NFKC search, type/tag filters, selection, and focus without mutating source input. The development Extension Host additionally waits for the graph render acknowledgement for the same provider-backed revision and observes no provider write. The current hosted matrix proves request-correlated Open 3D Graph data application and no five-file workspace change for the exact packaged candidate. | Actual 3D/Webview interaction, keyboard-only traversal, details UI, source opening, and packaged external-provider execution. | Partial — component + development provider boundary + current packaged lifecycle |
| AC-006 | Successive create, edit, rename, and delete graph revisions converge in presentation state; renamed/deleted selection clears; stale delivery is ignored. | Workspace file watchers, the 250 ms debounce, extension-to-Webview delivery, rendered details convergence, and extension-host continuity. | Partial — component |
| AC-007 | The injectable agent command previews, approves, and applies both outputs in memory, preserves unrelated `AGENTS.md` text, and returns unchanged on its second run. A root-level bundle reload proves that the generated root `AGENTS.md` and `.agents/` Skill stay outside the concept and conformance inventory. The packaged lifecycle also preserves pre-existing `AGENTS.md` and Skill sentinels through upgrade and uninstall, but does not execute the authoring command. | Actual preview/confirmation UI, physical or remote workspace application, collision handling, and a differing-Skill replacement decision in a packaged editor. | Partial — component + lifecycle preservation |
| AC-008 | Representative template, parse, validation, index, graph-state, and agent-plan components complete while the JavaScript `fetch` boundary is disabled. The predecessor headed VS Code record observed zero remote HTTP(S)/WS and other-scheme requests for its recorded identities, which do not match the final candidate. In all seven current hosted lanes, activation and request-correlated Validate/Open completion made zero calls through the listed CommonJS builtin export-owner/global hooks; the hooks remained installed until Extension Host exit, and all four write commands were refused in the untrusted-workspace probe. | Capture the final-candidate headed Webview and execute every trusted write-command flow under the hooks. ESM named bindings, cached references, raw/prototype bindings, `dns.promises`, child processes, and editor-owned traffic remain outside the Extension Host hook assertion. | Partial — component + current packaged CommonJS-owner/global hook window; final-candidate headed observation deferred |

## Remaining release evidence

On 2026-07-27, the maintainer accepted the bounded remaining interactive UI, trusted-write
observation, and external-provider gaps for the initial release and assigned the following checks
to post-publication verification. This acceptance does not convert any unobserved clause into a
pass.

Packaged acceptance should record, at minimum:

1. VSIX digest and the installed identifier `straydog.okf-workbench`.
2. Editor name/version, operating system, workspace scheme, and test fixture revision.
3. Pass/fail evidence for every user-observable clause listed above.
4. For AC-008, the exact intercepted entry points, observer lifetime and limitations, and which
   separately observed process-level traffic was captured.
5. Any deviation, failure, or manual judgment; an absence of evidence must remain **not evidenced**, not inferred as a pass.
