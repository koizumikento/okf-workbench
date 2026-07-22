# Acceptance evidence

- Target: MVP acceptance scenarios AC-001 through AC-008
- Packaged extension ID: `straydog.okf-workbench`
- Evidence date: 2026-07-22
- Component harness: `test/acceptance/vitest.config.ts`
- Packaged lifecycle evidence: `docs/evidence/compatibility/`

## Evidence semantics

This document deliberately separates deterministic component automation,
packaged lifecycle automation, and full user-scenario evidence.

- **Component automated** means a checked-in Vitest scenario exercises the repository's pure core, an injectable command/workspace boundary, or Webview presentation state. The command tests use in-memory doubles, not VS Code UI. A passing result supports only the assertions named in the table.
- **Development Extension Host provider automated** means the built development extension ran in a real VS Code Extension Host against a test-owned, registered, read-only `okfmem:` `FileSystemProvider`. It proves the read-only command boundary named below, but it is neither a packaged-VSIX result nor evidence for an external remote provider.
- **Packaged lifecycle automated** means the exact `581830`-byte normalized VSIX from commit `524eca3f36e1a1b3da935495d3fbbd0eb0d03f56` (SHA-256 `65c137822052aa7f90ef08cc1300020fec4adcd7cbcec6aec88ae98fae64dad0`) was installed in clean, untrusted, and upgrade profiles in VS Code 1.121.0, VS Code 1.127.0, and VSCodium 1.121.03429 on macOS arm64. The records prove six registered commands, execution of Validate Bundle and Open 3D Graph, zero attempts through guarded Node/Electron transports, untrusted-workspace read availability and early write refusal, a real `0.0.0` → `0.1.0` VSIX upgrade, uninstall, and workspace preservation.
- **Full scenario not evidenced** means the observable workflow has not yet been driven end to end through the actual editor UI and workspace provider. Component and lifecycle coverage can coexist without completing the scenario.

All eight scenarios remain **Partial** because their remaining UI/provider clauses
are material. The qualifiers in the table state whether the partial result has
component evidence only or also packaged lifecycle evidence. Do not use this
file to claim full MVP acceptance.

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
mise x node@24.18.0 -- env VSCODE_TEST_VERSION=1.127.0 npm run test:integration
```

That test requires provider reads for the selected bundle, publishes the broken-link diagnostic at
the exact `okfmem://` concept URI (including authority, Unicode, and a literal `%2F` filename
segment), waits for the graph Webview's render acknowledgement for the published revision, and
asserts that Validate Bundle and Open 3D Graph make no provider mutation. It does not automate a
write command, an external remote extension, or packaged installation.

The packaged macOS records are linked from the
[compatibility matrix](compatibility-matrix.md). Linux and Windows remain
pending until the hosted workflow runs. These local exact-candidate records
close the packaged lifecycle and local transport-observation subset only; they
do not complete the UI/provider clauses in the table or establish
cross-platform acceptance.

## Scenario evidence map

| ID | Component-automated assertions | Packaged-editor proof still required | Overall |
| --- | --- | --- | --- |
| AC-001 | Injectable command handlers initialize the Minimal preset, preview/apply both operations, select the root, create a concept, request its URI be opened, and produce a bundle with no conformance error in an in-memory workspace. Packaged macOS evidence additionally proves clean activation, command registration, and Validate Bundle execution. | Actual QuickPick/input/preview UI, physical or remote workspace writes, active-editor state, and the under-two-minute first-use target. | Partial — component + packaged lifecycle |
| AC-002 | A custom `experiment-result` type and nested producer fields survive parse → index regeneration → reparse unchanged; unknown values cause no finding. | A real supported command/write flow against workspace storage, including byte-level verification after save and reload. | Partial — component |
| AC-003 | Invalid YAML and a broken link produce category/severity/URI/range-addressable findings; a repaired revision clears both findings. The development Extension Host additionally publishes the broken-link Problems diagnostic at the exact registered `okfmem:` provider URI. Packaged macOS evidence proves Validate Bundle completes after installed activation. | Problems-panel navigation, save-event debounce, watcher convergence, packaged non-`file:` execution, and external provider coverage. | Partial — component + development provider boundary + packaged lifecycle |
| AC-004 | The injectable index command previews and applies one managed-region update in memory, preserves bytes outside the region, and returns unchanged without a second preview/write. | Diff preview rendering, cancellation/apply behavior through actual editor UI, and physical or remote workspace writes. | Partial — component |
| AC-005 | The graph model exposes directed backlinks, broken-link counts, and orphan state; Webview state supports NFKC search, type/tag filters, selection, and focus without mutating source input. The development Extension Host additionally waits for the graph render acknowledgement for the same provider-backed revision and observes no provider write. Packaged macOS evidence proves Open 3D Graph completes without changing the five-file workspace. | Actual 3D/Webview interaction, keyboard-only traversal, details UI, source opening, and packaged external-provider execution. | Partial — component + development provider boundary + packaged lifecycle |
| AC-006 | Successive create, edit, rename, and delete graph revisions converge in presentation state; renamed/deleted selection clears; stale delivery is ignored. | Workspace file watchers, the 250 ms debounce, extension-to-Webview delivery, rendered details convergence, and extension-host continuity. | Partial — component |
| AC-007 | The injectable agent command previews, approves, and applies both outputs in memory, preserves unrelated `AGENTS.md` text, and returns unchanged on its second run. The packaged lifecycle also preserves pre-existing `AGENTS.md` and Skill sentinels through upgrade and uninstall, but does not execute the authoring command. | Actual preview/confirmation UI, physical or remote workspace application, collision handling, and a differing-Skill replacement decision in a packaged editor. | Partial — component + lifecycle preservation |
| AC-008 | Representative template, parse, validation, index, graph-state, and agent-plan components complete while the JavaScript `fetch` boundary is disabled. In all three exact-candidate packaged macOS lanes, activation plus Validate Bundle and Open 3D Graph made zero attempts through guarded `http`, `https`, `http2`, `net`, `tls`, `dns`, `dgram`, `fetch`, and `WebSocket` transports. The recorded headed VS Code Webview CDP capture also observed zero remote HTTP(S)/WS requests during load and interaction. | Execute every write command flow under the packaged Extension Host guard and run hosted Linux/Windows lanes. Repeat the candidate-specific Webview observation whenever its bundle changes. Editor-owned background requests are outside this extension-host assertion. | Partial — component + exact-candidate packaged transport guard + headed Webview observation |

## Remaining release evidence

Packaged acceptance should record, at minimum:

1. VSIX digest and the installed identifier `straydog.okf-workbench`.
2. Editor name/version, operating system, workspace scheme, and test fixture revision.
3. Pass/fail evidence for every user-observable clause listed above.
4. For AC-008, how network access was disabled and which process-level traffic was observed.
5. Any deviation, failure, or manual judgment; an absence of evidence must remain **not evidenced**, not inferred as a pass.
