# Acceptance evidence

- Target: MVP acceptance scenarios AC-001 through AC-009
- Packaged extension ID: `straydog.okf-workbench`
- Evidence date: 2026-08-03
- Component harness: `test/acceptance/vitest.config.ts`
- Historical hosted packaged lifecycle run: [Compatibility 29900868002](https://github.com/koizumikento/okf-workbench/actions/runs/29900868002)
- Historical hosted package byte-identity run: [Package smoke 29901183164](https://github.com/koizumikento/okf-workbench/actions/runs/29901183164)
- Latest retained `0.2.1` predecessor hosted qualification:
  [Compatibility 30335399539](https://github.com/koizumikento/okf-workbench/actions/runs/30335399539)
  and
  [Package smoke 30335400890](https://github.com/koizumikento/okf-workbench/actions/runs/30335400890)
  passed every configured lane and aggregate check for revision
  `80ae7d560337cbe8d97af864c77aee410d5e5988`. The current OKF-v0.2 source candidate includes the
  Rust/Wasm migration and does not inherit these receipts; fresh Compatibility and package-smoke
  qualification is pending.
- Latest retained schema-v3 headed Webview observation: a current-candidate `0.3.0` VS Code
  `1.129.1` capture recorded QR-002 at `862 ms` p95 across 20 samples, selected `d3` for QR-003,
  and recorded zero remote HTTP(S)/WS or other-scheme Webview requests. The
  [raw record](evidence/performance/vscode-1.129.1-0.3.0.json), SHA-256
  `9b1ca57310da715de1ba5cc83b92ba28e9faaf6fdcc7f7111c7f96696f1c20d7`, and
  [generated report](evidence/performance/vscode-1.129.1-0.3.0.md) pass the strict evaluator for
  the recorded current production/build/harness identities.
- Preserved predecessor-candidate local evidence: `docs/evidence/compatibility/`
- The Activity Bar/sidebar implementation has current component/manifest coverage, retained predecessor hosted
  package and activation coverage, and manual VS Code `1.129.1` dark/light/high-contrast,
  orphan/warning distinction, hidden-graph refresh, and Resources-tree keyboard-focus evidence.
  The hosted lifecycle does not drive sidebar items or establish external-provider UI behavior.
  Fresh hosted compatibility and package-smoke qualification for the current candidate is pending.

## Evidence semantics

This document deliberately separates deterministic component automation,
packaged lifecycle automation, and full user-scenario evidence.

- **Component automated** means a checked-in Vitest scenario exercises the repository's pure core, an injectable command/workspace boundary, or Webview presentation state. The command tests use in-memory doubles, not VS Code UI. A passing result supports only the assertions named in the table.
- **Development Extension Host provider automated** means the built development extension ran in a real VS Code Extension Host against a test-owned, registered, read-only `okfmem:` `FileSystemProvider`. It proves the read-only command boundary named below, but it is neither a packaged-VSIX result nor evidence for an external remote provider.
- **Retained `0.2.1` predecessor packaged lifecycle automated** means the exact `978168`-byte universal VSIX with
  SHA-256 `6c45cd00e620730d9c023764e822077a4444264ac1f3d4f88e8139a9df79dc32`
  passed the then-current seven-lane hosted matrix for revision
  `80ae7d560337cbe8d97af864c77aee410d5e5988`. Each retained report binds that revision,
  extension `straydog.okf-workbench@0.2.1`, and the same candidate digest. The reports prove clean,
  untrusted, upgrade, and uninstall lifecycles; request-correlated Validate Bundle and Open 3D
  Graph completion; catalog-derived refusal of all four write commands in an untrusted workspace;
  zero calls through the listed CommonJS-owner/global hooks during the observed active phases; and
  hooks retained until Extension Host exit. The genuine upgrade predecessor is the published
  `v0.2.0` universal VSIX. The target-platform package-smoke run separately proves canonical Wasm,
  target identity, native CLI/VSIX byte parity, and aggregate completeness; target packages are
  intentionally not byte-identical because each contains its platform-native CLI.
  These receipts qualify only revision `80ae7d560337cbe8d97af864c77aee410d5e5988`; they do not
  qualify the current Rust/Wasm source candidate.
- **Historical packaged lifecycle automated** means the exact `582231`-byte normalized VSIX from commit `aa90832aab64dac1bccf9c9092fabc004991f7b1` (SHA-256 `cc8c994cd35cfe2017945c38d0019f330cb33f628a94bf6508b2930c5c57c866`) passed its then-required hosted matrix: VS Code 1.121.0 on Ubuntu; VS Code 1.127.0 on Ubuntu, macOS, and Windows; and VSCodium 1.121.03429 on Ubuntu, macOS, and Windows. The retained schema proves six registered commands; dispatch of Validate Bundle followed by a newer runtime publication; dispatch of Open 3D Graph followed by a graph data-application acknowledgement; zero calls through the acceptance driver's listed CommonJS builtin export-owner/global hooks while they were installed; untrusted-workspace read availability and one early Initialize Bundle refusal; a real `0.0.0` → `0.1.0` VSIX upgrade; uninstall; and settings/workspace preservation. It did not correlate either asynchronous signal to the request that initiated it, and it restored the hooks after the report on success. It is therefore not request-correlated command-completion or host-exit-lifetime evidence. Independent macOS, Ubuntu, and Windows package-smoke jobs reproduced the same digest and byte size. A later historical workflow-only commit, `6505a7f7b017a44a851ab6edaaba28f6b6a72105`, left packaged content unchanged and added an aggregate gate that explicitly passed those three artifacts. Current source and exact package bytes do not inherit this evidence.
- **Historical schema-v3 headed Webview observation** means the older VS Code 1.127.0 record
  observed zero remote HTTP(S)/WS requests, two local packaged-resource loads, and no other scheme
  for its recorded identities. It predates the mandatory security envelope and the current
  diagnostics/WebGL/interaction contract, so it is neither current release evidence, packaged
  Extension Host network evidence, nor a cross-editor guarantee.
- **Preserved local predecessor evidence** means the checked-in JSON files describe the earlier `581830`-byte candidate from commit `524eca3f36e1a1b3da935495d3fbbd0eb0d03f56` (SHA-256 `65c137822052aa7f90ef08cc1300020fec4adcd7cbcec6aec88ae98fae64dad0`) on local macOS arm64. They remain useful audit evidence but are not records for either the historical hosted candidate or the current candidate.
- **Full scenario not evidenced** means the observable workflow has not yet been driven end to end through the actual editor UI and workspace provider. Component and lifecycle coverage can coexist without completing the scenario.

All nine scenarios remain **Partial** because their remaining UI/provider clauses
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
[compatibility matrix](compatibility-matrix.md). The retained predecessor run closes the cross-platform
lifecycle, request-correlated read-command completion, untrusted write-command refusal, and guarded
Extension Host CommonJS-owner/global hook subset for its exact candidate. It does not complete the
manual UI/provider clauses in the table or establish full user-scenario acceptance.

The retained predecessor lifecycle harness reports its exact intercepted-property/global inventory. It replaces
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
the stricter schema and exhaustive four-command untrusted refusal probe to its exact predecessor
candidate. No current-candidate packaged lifecycle claim is made until the fresh matrix passes.

## Scenario evidence map

| ID | Component-automated assertions | Packaged-editor proof still required | Overall |
| --- | --- | --- | --- |
| AC-001 | Injectable command handlers initialize the Minimal preset and create one concept through guarded create-only application with no preview or confirmation, select the root, request both generated URIs be opened, and produce a bundle with no conformance error in an in-memory workspace. The retained predecessor hosted matrix additionally proves clean packaged activation, the six-command catalog, and request-correlated Validate Bundle completion for its exact candidate. | Actual QuickPick/input UI, physical or remote no-overwrite workspace creates, active-editor state, the under-two-minute first-use target, and fresh current-candidate hosted qualification. | Partial — component + retained predecessor packaged lifecycle |
| AC-002 | A custom `experiment-result` type and nested producer fields survive parse → index regeneration → reparse unchanged; unknown values cause no finding. | A real supported command/write flow against workspace storage, including byte-level verification after save and reload. | Partial — component |
| AC-003 | Invalid YAML and a broken link produce category/severity/URI/range-addressable findings; a repaired revision clears both findings. The development Extension Host additionally publishes the broken-link Problems diagnostic at the exact registered `okfmem:` provider URI. The retained predecessor hosted matrix proves request-correlated Validate Bundle diagnostics/runtime publication for its exact packaged candidate. | Problems-panel navigation, save-event debounce, watcher convergence, packaged non-`file:` execution, external provider coverage, and fresh current-candidate hosted qualification. | Partial — component + development provider boundary + retained predecessor packaged lifecycle |
| AC-004 | The injectable index command previews and applies one managed-region update in memory, preserves bytes outside the region, and returns unchanged without a second preview/write. | Diff preview rendering, cancellation/apply behavior through actual editor UI, and physical or remote workspace writes. | Partial — component |
| AC-005 | The graph model exposes directed backlinks, broken-link counts, and orphan state; Webview state supports NFKC search, type/tag filters, selection, and focus without mutating source input. The development Extension Host additionally waits for the graph render acknowledgement for the same provider-backed revision and observes no provider write. The retained predecessor hosted matrix proves request-correlated Open 3D Graph data application and no five-file workspace change for its exact packaged candidate. | Actual 3D/Webview interaction, keyboard-only traversal, details UI, source opening, packaged external-provider execution, and fresh current-candidate hosted qualification. | Partial — component + development provider boundary + retained predecessor packaged lifecycle |
| AC-006 | Successive create, edit, rename, and delete graph revisions converge in presentation state; renamed/deleted selection clears; stale delivery is ignored. | Workspace file watchers, the 250 ms debounce, extension-to-Webview delivery, rendered details convergence, and extension-host continuity. | Partial — component |
| AC-007 | The injectable agent command previews, approves, and applies both outputs in memory, preserves unrelated `AGENTS.md` text, and returns unchanged on its second run. A root-level bundle reload proves that the generated root `AGENTS.md` and `.agents/` Skill stay outside the concept and conformance inventory. The packaged lifecycle also preserves pre-existing `AGENTS.md` and Skill sentinels through upgrade and uninstall, but does not execute the authoring command. | Actual preview/confirmation UI, physical or remote workspace application, collision handling, and a differing-Skill replacement decision in a packaged editor. | Partial — component + lifecycle preservation |
| AC-008 | Representative template, parse, validation, index, graph-state, and agent-plan components complete while the JavaScript `fetch` boundary is disabled. The current-candidate headed VS Code record observed zero remote HTTP(S)/WS and other-scheme requests for its exact `0.3.0` inputs. In all seven retained predecessor hosted lanes, activation and request-correlated Validate/Open completion made zero calls through the listed CommonJS builtin export-owner/global hooks; the hooks remained installed until Extension Host exit, and all four write commands were refused in the untrusted-workspace probe. | Execute every trusted write-command flow under the hooks and repeat hosted packaged qualification for the current candidate. ESM named bindings, cached references, raw/prototype bindings, `dns.promises`, child processes, and editor-owned traffic remain outside the Extension Host hook assertion. | Partial — component + current headed/predecessor package observations |
| AC-009 | Unit and dedicated acceptance-component coverage verify deterministic folder-first sidebar hierarchy, summary counts, unknown type visibility, reserved documents, orphan separation, and bounded text labels. Manifest coverage verifies the Activity Bar container, three native views, empty-state/actions content, command menus, and packaged SVG requirement. The New Concept command test verifies a validated folder-originated initial destination. The retained manual review covers dark, light, and dark high-contrast themes, confirms orphan-only items remain separate from curation warnings, verifies hidden-graph refresh without an interaction-error dialog, and traverses the Resources tree with keyboard focus; the predecessor hosted matrix proves packaged activation and command registration across all seven lanes. | Current/stale item source opening, complete keyboard/screen-reader traversal of Actions, watcher convergence, untrusted actions, provider-backed URIs, 3D Graph handoff, and fresh current-candidate qualification in packaged VS Code/VSCodium. | Partial — component + retained manual/predecessor packaged evidence |

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
