# Performance evidence

- Status: **retained predecessor-bound local headed observation**; the current strict evaluator
  exits `2` for that record, and fresh evidence for the current Rust/Wasm source candidate is pending
- Date: 2026-07-28
- Governing decision:
  [ADR 0005, OQ-008](decisions/0005-resolve-mvp-implementation-questions.md#oq-008--performance-fixtures-and-thresholds)

## Retained schema-v3 measurement and binding status

The tracked [schema-v3 report](evidence/performance/vscode-1.129.1.md) and
[raw samples](evidence/performance/vscode-1.129.1.json), SHA-256
`a8917c18c12c3ee8d00efa27254e6f5114779dc8a5f4589c62d015c128436eb6`, were captured in a genuine
headed VS Code `1.129.1` session on 2026-07-28. They recorded passing results for their exact
predecessor `0.2.1` production runtime, build inputs, diagnostics observer, QR-003 harness inputs
and definition, injected harness bytes, and editor/runtime metadata. Samples were captured in one
run; none were copied or synthesized. The current `--require-passing` evaluator exits `2`, marks
QR-002 and QR-003 unmeasured, and does not accept the record as bound to the current production
inputs. The record does not qualify the current OKF-v0.2 Rust/Wasm source candidate.

| Target | Recorded predecessor status | Evidence |
| --- | --- | --- |
| QR-002 — update p95 at or below 1,000 ms | **Recorded pass** | `677.00 ms` nearest-rank p95 across 20 create/change/rename/delete samples, with runtime-originated same-revision Problems and graph correlation. |
| QR-003 — representative graph remains interactive | **Recorded pass** | `d3` first-frame maximum `297.10 ms`, cooldown mean `2,744.80 ms`, interaction p95 values `9.10/16.60/2.10/0.80 ms`, and zero idle frames. |
| Headed Webview network | **Recorded pass** | Strict pre-navigation CDP observation recorded zero remote HTTP(S)/WS requests, two packaged-resource loads, two internal Webview navigations, and zero other-scheme requests. |
| Release force-engine default | **`d3` recorded for predecessor inputs** | Same-Electron comparison passed `d3`; `ngraph` recorded a structured WebGL draw timeout after 5,000 ms and was not selected. |

This local record applies only to the recorded Mac16,7 / Apple M4 Pro environment, VS Code
`1.129.1` commit `8a7abeba6e03ea3af87bfbce9a1b7e48fed567b8`, and the exact bound inputs. It is
not a guarantee for other machines, editors, current source, or future candidate bytes, and it does not replace
the separate hosted compatibility, packaged lifecycle, manual UI, license, or publication gates.
A unit test, Node benchmark, or headless Chromium run must not be relabeled as headed-editor
evidence.

The [former schema-v3 report](evidence/performance/vscode-1.127.0.md) and
[former raw samples](evidence/performance/vscode-1.127.0.json) remain historical,
non-qualifying measurements. Their identities no longer match, and the old record lacks the
newly mandatory runtime diagnostics correlation, WebGL frame/draw proof, interaction outcome
assertions, coherent timestamps, and strict Webview-network envelope. `--require-passing` rejects
it.

### Historical QR-002 measurement boundary

The former runner performed five cycles of create, change, rename, and delete operations for 20
total structured samples. Each sample records both publication durations, the graph revision, a
strictly increasing diagnostics-observer sequence, the revision to which the diagnostics were
correlated, and the expected bundle-relative diagnostic path/code pairs. `durationMs` is the maximum
of the diagnostics and graph publication durations, so a sample cannot end before both current
results are observed. That run reported 719 ms p95, but its correlation field was assigned by the
runner after independently observing the two publications. It therefore does not satisfy the
current same-revision correlation contract and is not release evidence for the current candidate.

The Problems observation comes from the test-only extension under
`test/benchmarks/diagnostics-observer`. It subscribes to VS Code's diagnostics API and records only
the OKF diagnostic sources needed for correlation. The headed runner loads it as a separate
extension-development path; it is not part of the production extension bundle or packaged VSIX.

## Former schema-v3 environment (historical, non-qualifying)

| Field | Recorded value |
| --- | --- |
| Hardware | Mac16,7; Apple M4 Pro; 48 GiB |
| OS | Darwin 25.5.0 arm64 |
| GPU | ANGLE Metal Renderer: Apple M4 Pro |
| Editor | VS Code 1.127.0, commit `4fe60c8b1cdac1c4c174f2fb180d0d758272d713` |
| Electron / Chromium | 42.2.0 / 148.0.7778.97 |
| Package versions | OKF Workbench 0.1.0; `3d-force-graph` 1.80.0 |
| Product graph command-to-interactive | 2,497 ms |
| `d3` peak process-tree RSS / idle CPU / camera | 2,665.92 MB / 0.83% / 69.13716813703441 fps |
| Extension Host JavaScript SHA-256 | `36cbc9669b790d4633a2277a257c5037281df25080fec758abe4c7ffd26c9ded` |
| Webview JavaScript SHA-256 | `153b9891bdab9a1eb05357a2a1c8f58dc92bd48362839621b7c877d1ac5ffc35` |
| Webview CSS SHA-256 | `8f47124ac42ffdc619489d9b9a618bedad59e63eea9fcb5beb8d79b8facb7ce4` |
| Domain-separated production bundle-set SHA-256 | `d1ceefe1a35532335b9d20bb691fe7144a354c0f2cb282c41504b6fd2d0ea9d6` |
| Full production runtime snapshot SHA-256 | `2e881d977b2f06e96f960003f7c3ed5df2cd1987363ac56329fb6db8efb7663d` |
| Production build-input snapshot SHA-256 | `4582b2dd27e91cb320447208208b07e6695c938dfdfe031822097c57f2a9d447` |
| QR-002 diagnostics-observer snapshot SHA-256 | `7673ed26ca74fcaa1d6960c01c57b64d5b5637f384b00515bdee718825480e94` |
| QR-003 harness-input snapshot SHA-256 | `db5fab6a6cd40e3d1c33621325a7dffeb191078be45b5c269861ca94e2fa6790` |
| QR-003 harness-definition SHA-256 | `56bab3d9a7f2656554e346b6be9437d05ce29027488c290187838705f0c364fa` |
| QR-003 injected harness bundle SHA-256 | `3e26a468e1d275765468f1fa882aeea53c296e56eae444310fc773be7726fc11` |
| Webview remote network requests | 0 HTTP(S)/WS requests; 2 local packaged-resource loads |

The former record includes the individual SHA-256 for `dist/extension.cjs`,
`dist/webview/main.js`, and `dist/webview/main.css`, plus the framed bundle-set hash defined under
[Current-candidate binding](#current-candidate-binding). The six input identities bind the complete
runtime tree, production build inputs, diagnostics observer, QR-003 harness inputs and definition,
and the exact injected harness bundle.

The runner used three recorded Chromium automation flags to prevent an unattended headed window
from being throttled in the background. It did not disable GPU acceleration. These are present in
the raw evidence and do not create a cross-machine guarantee.

The former run also attached CDP `Network` events directly to the real OKF Webview target. It
combined those events with the Webview's initial resource timing entries across refresh, search,
filter, selection, engine comparison, and disposal. It observed zero remote HTTP(S)/WS requests,
two local packaged-resource loads from the VS Code Webview resource origin, and no other schemes.
Only sanitized origins and counts are retained; no workspace content or URL paths are recorded.
Those observations are historical because the old recorder attached after initial graph load and
did not prove pre-navigation coverage, WebSocket-specific events, a live final CDP barrier, the
mandatory security envelope, or current input identities.

## Reproducible fixtures

`test/benchmarks/graph-fixtures.ts` generates every payload from seed `0x004f4b46` without reading
the clock, filesystem, or device randomness.

| Fixture | Nodes | Directed edges | Use |
| --- | ---: | ---: | --- |
| `small` | 100 | 500 | Fast harness and regression checks |
| `representative` | 1,000 | 5,000 | QR-003 and force-engine comparison |
| `stress` | 5,000 | 25,000 | Diagnostic headroom; no release guarantee |

Each fixture contains stable IDs, source ranges, types, tags, statistics, and backlinks. The initial
ring prevents accidental orphans; the remaining edges use a checked-in xorshift32 sequence. Unit
tests verify exact dimensions, repeatability, and link invariants.

## Commands and evidence authority

Run with the repository-pinned Node.js 24.18.0 and npm 11.16.0 environment:

```sh
mise x node@24.18.0 -- npm run benchmark
mise x node@24.18.0 -- npm run test:webview:performance
mise x node@24.18.0 -- npm run benchmark:report
mise x node@24.18.0 -- npm run benchmark:report -- --measurements /absolute/path/to/headed-editor.json --require-passing
mise x node@24.18.0 -- node test/benchmarks/headed-editor-evidence.mjs --vscode-executable /absolute/path/to/VS-Code-executable --output artifacts/performance/headed-editor.json
```

The retained predecessor qualification was captured with the full comparison against the pinned VS
Code 1.129.1 executable. It is not current-candidate qualification. Re-run the same commands and
retain a new strict-passing pair whenever a bound input changes:

```sh
mise x node@24.18.0 -- node test/benchmarks/headed-editor-evidence.mjs \
  --version 1.129.1 \
  --vscode-executable "/absolute/path/to/VS-Code-1.129.1-executable" \
  --output artifacts/performance/vscode-1.129.1-final.json

mise x node@24.18.0 -- npm run benchmark:report -- \
  --measurements artifacts/performance/vscode-1.129.1-final.json \
  --require-passing
```

The runner snapshots the exact final `package.json`, `assets/icon.png`, complete `dist/` tree,
esbuild production inputs, test-only diagnostics observer, graph fixture, headed harness entry and
build definition, runner/report/network-recorder scripts, emitted harness bytes, and the complete
runtime dependency closure of Playwright, `@vscode/test-electron`, and esbuild. A checked-in
platform-neutral toolchain manifest records the exact authorized native esbuild and installed
platform-optional package file inventories. Any later change to one of those inputs requires
another full capture.

| Command | What it measures | Can pass QR-002/QR-003? |
| --- | --- | --- |
| `npm run benchmark` | Generator, protocol decoder, and pure presentation-state overhead in Node | No |
| `npm run test:webview:performance` | Real WebGL construction, `d3`/`ngraph` cooldown, idle-loop behavior, and accessible interactions in headless Playwright Chromium | No; useful for regression and harness validation only |
| `npm run benchmark:report` | Strict evaluation of an optional measurement file against the current manifest and production bundle bytes | Only when the input is complete schema-v3 headed-editor evidence bound to the current candidate |
| `--require-passing` | Returns exit code 2 unless QR-002, QR-003, and the headed Webview network observation all pass | Release/manual gate |
| `node test/benchmarks/headed-editor-evidence.mjs ...` | Isolated headed VS Code, real watcher, test-only diagnostics observer, production Webview, same-Electron engine candidates, process tree, GPU, and interactions | Yes |

Playwright attaches `browser-interaction-harness.json` and
`browser-force-engine-comparison.json` to its test results. Both attachments include an
`authority: browser-harness-only` marker. The graph test uses the production adapter and same
payload/settings for both engines. It verifies that the configured 120-tick cooldown fires and that
no additional render-loop callback is scheduled after the drain window. These Chromium results are
not Electron Webview evidence.

## Thresholds

The report generator applies the accepted thresholds without widening them:

- QR-002 requires exactly 20 end-to-end one-file refresh samples in five ordered
  create/change/rename/delete cycles. Each starts at the file mutation and ends only after current
  Problems diagnostics and the replacement graph are published, including the fixed 250 ms
  debounce. Each event has a non-empty exact diagnostic contract, coherent non-overlapping epoch
  timestamps, and a stable production-runtime correlation whose revision equals the graph
  revision. Nearest-rank p95 of `durationMs` must be at or below 1,000 ms.
- QR-003 uses the 1,000-node / 5,000-edge fixture. Its single recorded
  first-interactive-frame sample must be at or below 5,000 ms and must observe positive graph
  WebGL clear and draw counts. If an engine does not establish that proof within 5,000 ms, the
  headed harness records the exact timeout envelope shown below. That is a complete measured
  candidate failure, never a zero-valued passing sample.
- Search, filtering, selection, and non-spatial navigation each require exactly 20 samples;
  every operation must assert its resulting UI state and nearest-rank p95 must be at or below
  100 ms.
- The engine must reach cooldown, and the single post-drain idle animation sample must be zero.
- Camera FPS must be positive and equal the observed WebGL-clear count divided by its measurement
  duration. `cameraDrawCallCount` must be at least the clear count, and total draw calls must cover
  first-frame plus camera-period draws; a draw-once/blank-clear measurement fails. This aggregate
  comparison is a conservative proxy for at least one graph draw per observed clear.
- The schema-v1 security envelope must report zero HTTP(S)/WS requests, zero other-scheme requests,
  a bounded positive local packaged-resource observation, and a separate bounded opaque
  `vscode-webview` navigation observation. The browser-level CDP recorder must pause the new OKF
  target, enable `Network` before resume, collect WebSocket/WebTransport events, remain connected,
  and complete same-session barriers before snapshot.
- Peak memory, idle CPU, camera frame rate, GPU, editor, Electron, Chromium, OS, fixture seed, and
  package versions are mandatory evidence fields but do not receive invented cross-machine limits.

## Schema-v3 headed-editor measurement input

The report accepts one JSON document with this abbreviated shape. Ellipses are explanatory and are
not valid JSON input:

```json
{
  "schemaVersion": 3,
  "measurementKind": "headed-editor",
  "capturedAt": "2026-07-22T12:00:00+09:00",
  "environment": {
    "hardware": "machine model",
    "os": "OS name, version, architecture",
    "cpu": "CPU model and logical processor count",
    "memoryGb": 0,
    "gpu": "GPU model and active renderer",
    "editorName": "VS Code",
    "editorVersion": "exact version",
    "editorCommit": "exact commit",
    "electronVersion": "exact version",
    "chromiumVersion": "exact version",
    "fixtureSeed": 5196614,
    "packageVersions": {
      "okf-workbench": "current manifest version",
      "3d-force-graph": "exact current dependency version"
    },
    "extensionHostBundleSha256": "64 lowercase hexadecimal characters",
    "webviewJavaScriptBundleSha256": "64 lowercase hexadecimal characters",
    "webviewCssBundleSha256": "64 lowercase hexadecimal characters",
    "productionBundleSetSha256": "64 lowercase hexadecimal characters"
  },
  "inputIdentity": {
    "productionRuntimeSnapshotSha256": "64 lowercase hexadecimal characters",
    "productionBuildInputSnapshotSha256": "64 lowercase hexadecimal characters",
    "diagnosticsObserverSnapshotSha256": "64 lowercase hexadecimal characters",
    "qr003HarnessInputSnapshotSha256": "64 lowercase hexadecimal characters",
    "qr003HarnessDefinitionSha256": "64 lowercase hexadecimal characters",
    "qr003HarnessBundleSha256": "64 lowercase hexadecimal characters"
  },
  "qr002": {
    "debounceMs": 250,
    "updateSamples": [
      {
        "eventKind": "create",
        "durationMs": 700,
        "graphPublicationMs": 700,
        "diagnosticsPublicationMs": 680,
        "startedAtEpochMs": 1784685600000,
        "mutationCompletedAtEpochMs": 1784685600005,
        "graphObservedAtEpochMs": 1784685600700,
        "diagnosticsObservedAtEpochMs": 1784685600680,
        "graphRevision": 2,
        "diagnosticsSequence": 1,
        "diagnosticsCorrelation": {
          "authority": "okf-acceptance-runtime-publication",
          "revision": 2,
          "diagnosticsPublished": true,
          "findingCount": 2,
          "conceptCount": 1001,
          "edgeCount": 5001
        },
        "expectedDiagnostics": [
          {
            "relativePath": "concepts/concept-0000.md",
            "code": "okf.curation.broken-link"
          },
          {
            "relativePath": "concepts/qr002-probe.md",
            "code": "okf.curation.missing-description"
          }
        ],
        "observedDiagnostics": [
          {
            "relativePath": "concepts/concept-0000.md",
            "code": "okf.curation.broken-link"
          },
          {
            "relativePath": "concepts/qr002-probe.md",
            "code": "okf.curation.missing-description"
          }
        ]
      }
    ]
  },
  "qr003": {
    "capturedAt": "2026-07-22T12:00:00+09:00",
    "provenance": {
      "kind": "captured"
    },
    "fixture": {
      "nodeCount": 1000,
      "edgeCount": 5000,
      "seed": 5196614
    },
    "engines": {
      "d3": {
        "firstInteractiveFrameMs": [400],
        "firstInteractiveFrameWebglClears": [1],
        "firstInteractiveFrameWebglDrawCalls": [100],
        "cooldownReached": true,
        "cooldownMs": [2500],
        "idleAnimationFramesAfterCooldown": [0],
        "interactions": {
          "searchMs": ["20 positive samples"],
          "filterMs": ["20 positive samples"],
          "selectionMs": ["20 positive samples"],
          "navigationMs": ["20 positive samples"]
        },
        "interactionOutcomes": {
          "search": ["20 true values"],
          "filter": ["20 true values"],
          "selection": ["20 true values"],
          "navigation": ["20 true values"]
        },
        "memoryPeakMb": 256,
        "idleCpuPercent": 0,
        "cameraDurationMs": 700,
        "cameraFrameCount": 42,
        "cameraDrawCallCount": 84,
        "cameraFps": 60,
        "totalWebglClearCount": 200,
        "totalWebglDrawCallCount": 10000
      },
      "ngraph": {
        "measurementFailure": {
          "authority": "headed-vscode-webview-harness",
          "phase": "first-interactive-frame",
          "code": "graph-webgl-render-timeout",
          "timeoutMs": 5000,
          "observedClearCount": 0,
          "observedDrawCallCount": 0,
          "canvasPresent": true,
          "nodeCount": 1000,
          "edgeCount": 5000
        },
        "memoryPeakMb": 256,
        "idleCpuPercent": 0,
        "processTreePeakRssMb": 256,
        "processTreeSampleCount": 10
      }
    }
  },
  "security": {
    "schemaVersion": 1,
    "webviewNetwork": {
      "authority": "headed-vscode-webview-cdp",
      "captureScope": "Initial Webview resources plus CDP events during ...",
      "remoteRequestCount": 0,
      "remoteOrigins": [],
      "localResourceRequestCount": 2,
      "localOrigins": ["https://file+.vscode-resource.vscode-cdn.net"],
      "webviewNavigationRequestCount": 1,
      "webviewNavigationOrigins": [
        "vscode-webview://07ah2qk3gn0a6knrq6q3pnd6p9d310f8gqc9g48lfsosvfbe2dc2"
      ],
      "otherRequestCount": 0,
      "otherSchemes": []
    }
  }
}
```

QR-002 must contain exactly five serialized create/change/rename/delete cycles. Every sample starts
at or after the prior sample's final mutation/publication timestamp. Graph revisions and
diagnostics sequences must increase strictly.
The diagnostics observer must obtain `diagnosticsCorrelation` from a stable production acceptance
runtime publication before and after reading Problems; its revision must equal `graphRevision`, and
actual diagnostics must equal the non-empty event-specific expectation. Every QR-003 interaction
array requires 20 positive durations and 20 successful outcome assertions. `measurementKind` must
be exactly `headed-editor`; changing a Playwright attachment label is not a valid substitute.

Each force engine receives a freshly generated deterministic representative graph. An engine that
times out before the first proven WebGL frame may use only the exact `measurementFailure` object
above: the authority, phase, code, 5,000 ms timeout, non-negative observed clear/draw deltas,
canvas presence, and exact fixture dimensions are all mandatory, and extra keys inside that object
are rejected. The containing failed-engine record must also have the runner's exact monitored
top-level shape: `measurementFailure`, finite non-negative `memoryPeakMb` and `idleCpuPercent`, the
equal `processTreePeakRssMb`, and a positive safe-integer `processTreeSampleCount`; success metrics
or unknown keys cannot be mixed into that record. The evaluator classifies a valid envelope as
that candidate's measured `fail` and keeps its selection score ineligible. It classifies a
malformed envelope as `unmeasured`, which makes the comparison and strict gate fail. Thus one
honestly failed candidate does not prevent the other passing candidate from being selected, while
missing metrics and fabricated zero-duration timeouts cannot complete the comparison.

The first-frame poll races every requested animation frame against an independent 5,000 ms timer,
so a Webview that stops delivering animation-frame callbacks still emits the structured timeout
when its JavaScript event loop remains live. The runner also applies a 150,000 ms outer ceiling to
each complete Webview evaluation plus process-tree monitor. That ceiling leaves room for the
intentional 120-second engine-cooldown bound but fails closed if the renderer process is fully
frozen and neither browser callback can complete.

Schema-v2 evidence is historical-only. The schema-v3 evaluator rejects it fail closed, and the
headed runner will not reuse its QR-003 samples. The former tracked schema-v3 record also fails the
current stricter contract and is historical-only.

## Current-candidate binding

Strict evaluation first compares the evidence to the repository's current build inputs and
production outputs. A report is non-authoritative when any required value is absent or different:

1. `environment.editorName` and `environment.editorVersion` must identify VS Code at the current
   release-candidate pin, `1.129.1`. The runner also compares `--version` with the version reported
   by the selected executable before launch.
2. `environment.packageVersions.okf-workbench` must equal the current `package.json` version.
3. `environment.packageVersions["3d-force-graph"]` must equal the exact current dependency version.
4. `environment.extensionHostBundleSha256` must equal SHA-256 of the current
   `dist/extension.cjs` bytes.
5. `environment.webviewJavaScriptBundleSha256` must equal SHA-256 of the current
   `dist/webview/main.js` bytes.
6. `environment.webviewCssBundleSha256` must equal SHA-256 of the current
   `dist/webview/main.css` bytes.
7. `environment.productionBundleSetSha256` must equal the repository-defined, domain-separated
   bundle-set SHA-256 over all three files.
8. `inputIdentity.productionRuntimeSnapshotSha256` must equal the domain-separated snapshot of
   `package.json`, `assets/icon.png`, and every regular file under `dist/`. Each of the five
   remaining identities must also equal the evaluator's current, independently recomputed snapshot
   of the production build inputs, diagnostics observer, QR-003 input/configuration, and exact
   injected harness bytes. The evaluator's QR-003 builds use esbuild `write: false` and do not
   rebuild or mutate `dist/`.

The bundle-set algorithm starts SHA-256 with the UTF-8 domain
`okf-workbench.performance-production-bundle-set.v1` followed by a NUL byte. In fixed order—
`dist/extension.cjs`, `dist/webview/main.js`, then `dist/webview/main.css`—it appends a 4-byte
big-endian UTF-8 label length, an 8-byte big-endian content length, the label bytes, and the raw
content bytes. Labels and lengths prevent different component boundaries from producing the same
identity through raw concatenation.

All three production files must exist, so run the production build before evaluating separately.
The headed runner performs that build itself before capture. Individual hashes make the changed
surface explicit; the bundle-set hash binds the Extension Host parser, diagnostics, watcher,
protocol, Webview renderer, layout, and interaction styling exercised by QR-002/QR-003. A matching
version string without matching bytes is not sufficient. `--require-passing` exits with status 2 on
missing or mismatched bindings, including a CSS-only change.

The headed runner uses the live repository only for one non-authoritative esbuild input-discovery
build. It captures the resulting complete input inventory and exact source bytes, materializes that
snapshot under the owner-only benchmark root, and runs both authoritative production binding builds
against that private tree. The private input snapshot is checked before, between, and after those
builds, and both complete runtime trees must have the same identity. A transient live-repository
change therefore cannot supply output bytes while a restored source tree supplies the recorded
identity.

Before any measurement module is imported, a built-in-only bootstrap captures exact bytes for the
runner, build/report helpers, CDP recorder, package lock, Playwright, `@vscode/test-electron`,
esbuild, their required runtime dependencies, and authorized installed optional dependencies. It
rejects symlinks, captures twice, and materializes those bytes under an owner-only private temporary
root outside the repository. The child imports only from that root and verifies package resolution
stays there. The staged build script receives the private production-input root for authoritative
builds; the original repository is retained only for discovery, current-candidate comparison, and
end-of-run mutation checks. Environment-variable names are compared case-insensitively before
launch, so `NODE_OPTIONS`, `NODE_PATH`, preload variables, and `ESBUILD_BINARY_PATH` are not
inherited by the child even when a Windows caller supplies mixed-case names. Standalone report
evaluation also refuses `ESBUILD_BINARY_PATH` before building the comparison harness.

Native esbuild bytes remain cross-platform-verifiable: both persisted build/harness identities
contain `performance-toolchain-manifest.json`, whose exact per-platform file hashes and executable
policy bind Darwin arm64/x64, Linux x64, and Windows x64 packages. The portable persisted snapshots
retain esbuild's JavaScript and package metadata but carry a hash-bound exclusion for the
postinstall-created host-native mirror at `node_modules/esbuild/bin/esbuild`. Before any build,
capture and evaluation require the npm lock integrity plus the manifest's exact inventory and
hashes for every other portable esbuild file. This rejects an install-time `ESBUILD_BINARY_PATH`
prefix persisted into `lib/main.js` and any unmanifested downloaded binary. The excluded host
mirror remains bound by the private execution snapshot, while the current platform package is
verified against the manifest before use; the private stage restores its authorized executable
mode. Darwin's installed Playwright `fsevents` optional package is bound the same way. Thus macOS
evidence can be verified by the Ubuntu release gate without substituting Ubuntu native bytes into
the macOS measurement identity, while a mutated installed binary fails closed.

The captured production runtime and diagnostics observer are materialized separately under the
benchmark run directory, and VS Code launches only against those staged copies. QR-003 likewise
uses its live build only to discover the esbuild input graph. Its captured resolver manifests and
input bytes are materialized to a separate private tree; two identical authoritative esbuild passes
run only there using the checked-in `headed-harness-build.json` configuration and
`headed-harness-entry.mjs` entry. The runner and evaluator share this input-discovery,
materialization, and build-definition implementation. At the end, original and private executable,
production, and harness inputs—including the original repository runtime—are rehashed before and
after strict report generation and again through final publication. Final output is restricted to
`artifacts/performance/*.json`; symbolic targets or descendants outside that directory are refused.
The JSON and Markdown are written to owner-private temporary files, read back, and each atomically
renamed with rollback of its prior file. Pair success is reported only after both final files are
committed, read back, and followed by another complete input verification. A normal error restores
the prior pair; a process kill cannot report success and leaves private temporary or backup files
for explicit recovery. Mutation, nondeterministic output, remote Webview traffic, a publication
error, or strict-gate failure therefore withholds success. Report Markdown derives its `Generated`
value from evidence `capturedAt` and excludes report-generator host metadata, so identical evidence
and candidate bytes produce byte-identical output.

## Capturing QR-003

Every headed run records `qr003.capturedAt` and
`qr003.provenance: { "kind": "captured" }`. The runner always measures both engines in the current
headed editor process; it has no QR-003 reuse mode. Review the generated JSON and Markdown in
`artifacts/performance/`; replace tracked current-candidate evidence only after strict evaluation
passes and the evidence is approved. Do not overwrite retained evidence during an exploratory run.

The tracked VS Code 1.129.1 pair is the immutable capture-time report for the published `v0.2.1`
candidate, not a report for the current Rust/Wasm source candidate. Its generated Markdown
therefore retains the capture-time `pass` statuses. Interpret those statuses only through the
predecessor scope stated above; do not hand-edit the generated report with current-candidate
commentary. To prove that the tracked Markdown is still the deterministic rendering of its raw JSON,
reconstruct the exact tagged candidate in a private temporary directory and compare the generated
bytes:

```sh
proof_root=$(mktemp -d "${TMPDIR:-/tmp}/okf-v021-proof.XXXXXX")
git archive v0.2.1 | tar -x -C "$proof_root"
cmp docs/evidence/performance/vscode-1.129.1.json \
  "$proof_root/docs/evidence/performance/vscode-1.129.1.json"
(
  cd "$proof_root"
  mise x node@24.18.0 -- npm ci --ignore-scripts
  mise x node@24.18.0 -- npm run build
)
mise x node@24.18.0 -- node "$proof_root/scripts/benchmark-report.mjs" \
  --candidate-root "$proof_root" \
  --measurements docs/evidence/performance/vscode-1.129.1.json \
  --require-passing \
  > "$proof_root/vscode-1.129.1-regenerated.md"
cmp docs/evidence/performance/vscode-1.129.1.md \
  "$proof_root/vscode-1.129.1-regenerated.md"
```

Both `cmp` commands and the tagged strict evaluator must succeed. The first comparison binds the
tracked raw JSON to the tagged evidence record; the second proves the tracked Markdown is generated,
not editorialized. The temporary directory contains a dependency install and build and may be
discarded after the comparison.

Evaluate that same raw JSON against the current checked-out candidate separately:

```sh
mise x node@24.18.0 -- node scripts/benchmark-report.mjs \
  --measurements docs/evidence/performance/vscode-1.129.1.json \
  --require-passing \
  > artifacts/performance/vscode-1.129.1-current-candidate-check.md
```

For the current Rust/Wasm source candidate this command exits `2`, reports QR-002 and QR-003 as
unmeasured, and must not be compared with or copied over the predecessor report. Fresh headed
evidence must instead produce a new strict-passing JSON/Markdown pair bound to the exact candidate.

## Force-engine selection

The adapter exposes `d3` and `ngraph` behind the repository-owned renderer boundary and applies the
same 120-tick cooldown to both. Given complete current-candidate-bound headed evidence, the report:

1. evaluates each candidate against the same fixture and thresholds;
2. counts an exact headed first-frame timeout envelope as a measured failing candidate, while
   rejecting a missing or malformed engine measurement as unmeasured;
3. considers only passing candidates;
4. selects the candidate with the lower normalized first-frame and worst-interaction score.

If neither engine passes, no release default is selected. The checked-in adapter fallback remains
`d3`, but the former VS Code 1.127.0 comparison no longer qualifies under the strengthened contract.
A fresh full comparison must select the current release default.

The retained historical VS Code 1.127.0 measurement used these renderer defaults:

| Concern | Default used by the measured candidate |
| --- | --- |
| Controls / renderer | Orbit controls; antialiasing on; opaque WebGL canvas (`alpha: false`) |
| Node presentation | Stable type color; selected black or white according to background contrast; value `1`, `1.4` for orphan/broken-link nodes, `2.4` when selected; opacity `0.9`; HTML tooltip disabled |
| Link presentation | Opacity `0.38`; directional arrow length `3.5`; arrow position `1` |
| Force simulation | `d3`; `120` cooldown ticks; full graph replacement resets the countdown |
| Camera | Focus distance `80`; transition `600 ms` |
| Idle behavior | Pause after engine cooldown and after a temporary camera-focus animation; pause while hidden or disposed |

Any change to these defaults requires a new headed engine comparison.

## Headed run checklist

1. Start from the intended candidate with the pinned Node/npm versions. Let the runner build the
   production outputs; retain the Extension Host JavaScript, Webview JavaScript, Webview CSS, and
   domain-separated bundle-set hashes.
2. Use the pinned VS Code `1.129.1` build with hardware acceleration unchanged. The runner rejects
   a selected executable whose reported version differs. Record editor commit, Electron, Chromium,
   GPU renderer, OS, hardware, CPU, and memory.
3. For QR-002, run five create/change/rename/delete cycles through the real watcher. Observe current
   OKF Problems via the separate test-only diagnostics extension and the corresponding production
   Webview replacement graph. Retain all 20 structured samples, exact actual diagnostics, stable
   acceptance-runtime correlation, and causal timestamps.
4. For QR-003, instantiate each engine through `ForceGraphRenderer` with the same representative
   payload and options in the current headed editor process.
5. For a fresh QR-003 capture, wait for actual graph WebGL clears and draw calls; assert the UI
   result of every measured interaction; then record cooldown, post-drain animation, peak memory,
   idle CPU, and a positive internally consistent camera frame rate whose camera-period draw count
   is at least its observed clear count. If a candidate cannot prove its first frame within
   5,000 ms, retain the harness-generated timeout envelope as that candidate's measured failure;
   do not insert zero samples or abort the comparison before measuring the other candidate.
6. Arm browser-level CDP before opening the graph, pause the initial OKF Webview target, enable
   `Network` before resume, and retain the schema-v1 envelope only after live same-session final
   barriers. It must contain zero remote/other requests, bounded packaged local resources, and the
   separate internal navigation observation.
7. Save the raw JSON in a release artifact, run the strict report command, and retain sanitized raw
   evidence and generated Markdown for the immutable release candidate.
8. Repeat any failing or noisy run before changing a threshold. A threshold change requires an
   accepted decision update, not an edited measurement.

## Scope of the retained evidence

The tagged predecessor run completes the strengthened headed gate for its exact published `0.2.1`
inputs: strict evaluation exits `0`, all three rows pass, and regenerated Markdown is byte-identical
to the tracked report. It recorded `677 ms` QR-002 p95 and selected `d3`. The same raw JSON does not
bind the current Rust/Wasm source candidate; current-candidate strict evaluation exits `2` because
the production/runtime, build, and harness identities differ. A fresh schema-v3 capture must bind
those current identities and pass all three strict rows before any current-candidate performance
claim is made.
