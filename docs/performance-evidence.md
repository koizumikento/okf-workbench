# Performance evidence

- Status: current-candidate schema-v2 headed evidence passes QR-002 and QR-003; `d3` selected
- Date: 2026-07-22
- Governing decision:
  [ADR 0005, OQ-008](decisions/0005-resolve-mvp-implementation-questions.md#oq-008--performance-fixtures-and-thresholds)

## Current result

| Target | Current status | Evidence |
| --- | --- | --- |
| QR-002 — update p95 at or below 1,000 ms | **Pass for the recorded candidate** | 703 ms nearest-rank p95 over 20 end-to-end samples: five each of create, change, rename, and delete. Every sample correlates current Problems diagnostics and graph publication to the same revision after the 250 ms debounce. |
| QR-003 — representative graph remains interactive | **Pass for the recorded candidate** | On the 1,000-node / 5,000-edge fixture, `d3` reached its first interactive frame in 328.9 ms, cooled down in 3,054.7 ms, kept interaction p95 values at or below 27.5 ms, and scheduled zero post-cooldown idle frames. |
| Release force-engine default | **`d3` selected** | `d3` passed every threshold. `ngraph` reached its first interactive frame in 102.7 ms but failed the required cooldown signal after 120,000.3 ms, so it was not an eligible release default. |

The tracked [schema-v2 report](evidence/performance/vscode-1.127.0.md) and
[sanitized raw samples](evidence/performance/vscode-1.127.0.json) pass the strict evaluator against
the current manifest, exact `3d-force-graph` dependency, Webview bundle, and combined Extension Host
and Webview bytes. The result is evidence for the recorded Mac16,7 / Apple M4 Pro / VS Code 1.127.0
environment and exact candidate only; it is not a guarantee for other machines, editors, or future
candidate bytes. A unit test, Node benchmark, or headless Chromium run must not be relabeled as
headed-editor evidence.

### What the tracked QR-002 result establishes

The headed runner performed five cycles of create, change, rename, and delete operations for 20
total structured samples. Each sample records both publication durations, the graph revision, a
strictly increasing diagnostics-observer sequence, the revision to which the diagnostics were
correlated, and the expected bundle-relative diagnostic path/code pairs. `durationMs` is the maximum
of the diagnostics and graph publication durations, so a sample cannot end before both current
results are observed. The resulting 703 ms p95 is below the accepted 1,000 ms threshold in the
recorded environment.

The Problems observation comes from the test-only extension under
`test/benchmarks/diagnostics-observer`. It subscribes to VS Code's diagnostics API and records only
the OKF diagnostic sources needed for correlation. The headed runner loads it as a separate
extension-development path; it is not part of the production extension bundle or packaged VSIX.

## Recorded schema-v2 environment

| Field | Recorded value |
| --- | --- |
| Hardware | Mac16,7; Apple M4 Pro; 48 GiB |
| OS | Darwin 25.5.0 arm64 |
| GPU | ANGLE Metal Renderer: Apple M4 Pro |
| Editor | VS Code 1.127.0, commit `4fe60c8b1cdac1c4c174f2fb180d0d758272d713` |
| Electron / Chromium | 42.2.0 / 148.0.7778.97 |
| Package versions | OKF Workbench 0.1.0; `3d-force-graph` 1.80.0 |
| Product graph command-to-interactive | 3,420 ms |
| `d3` peak process-tree RSS / idle CPU / camera | 2,433.55 MB / 4.23% / 57.04 fps |
| Recorded Webview SHA-256 | `853502f50117c6b565b8a9befdb474e1cbaf39bf78b8b7eb6aa3d52f92266d7b` |
| Recorded extension + Webview SHA-256 | `93c75712626c20bee2b77ad74810267733c6457da85ad89c595772ac6e6d92ad` |
| Webview remote network requests | 0 HTTP(S)/WS requests; 2 local packaged-resource loads |

The combined SHA-256 is over the bytes of `dist/extension.cjs` followed by the bytes of
`dist/webview/main.js`. The separately recorded Webview hash binds the renderer bytes directly.

The runner used three recorded Chromium automation flags to prevent an unattended headed window
from being throttled in the background. It did not disable GPU acceleration. These are present in
the raw evidence and do not create a cross-machine guarantee.

The schema-v2 run also attached CDP `Network` events directly to the real OKF Webview target. It
combined those events with the Webview's initial resource timing entries across refresh, search,
filter, selection, engine comparison, and disposal. It observed zero remote HTTP(S)/WS requests,
two local packaged-resource loads from the VS Code Webview resource origin, and no other schemes.
Only sanitized origins and counts are retained; no workspace content or URL paths are recorded.

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

| Command | What it measures | Can pass QR-002/QR-003? |
| --- | --- | --- |
| `npm run benchmark` | Generator, protocol decoder, and pure presentation-state overhead in Node | No |
| `npm run test:webview:performance` | Real WebGL construction, `d3`/`ngraph` cooldown, idle-loop behavior, and accessible interactions in headless Playwright Chromium | No; useful for regression and harness validation only |
| `npm run benchmark:report` | Strict evaluation of an optional measurement file against the current manifest and production bundle bytes | Only when the input is complete schema-v2 headed-editor evidence bound to the current candidate |
| `--require-passing` | Returns exit code 2 unless both QR-002 and QR-003 pass | Release/manual gate |
| `node test/benchmarks/headed-editor-evidence.mjs ...` | Isolated headed VS Code, real watcher, test-only diagnostics observer, production Webview, same-Electron engine candidates, process tree, GPU, and interactions | Yes |

Playwright attaches `browser-interaction-harness.json` and
`browser-force-engine-comparison.json` to its test results. Both attachments include an
`authority: browser-harness-only` marker. The graph test uses the production adapter and same
payload/settings for both engines. It verifies that the configured 120-tick cooldown fires and that
no additional render-loop callback is scheduled after the drain window. These Chromium results are
not Electron Webview evidence.

## Thresholds

The report generator applies the accepted thresholds without widening them:

- QR-002 requires at least 20 end-to-end one-file refresh samples and at least one create, change,
  rename, and delete sample. Each starts at the file mutation and ends only after current Problems
  diagnostics and the replacement graph are published, including the fixed 250 ms debounce.
  Nearest-rank p95 of `durationMs` must be at or below 1,000 ms.
- QR-003 uses the 1,000-node / 5,000-edge fixture. Every recorded first-interactive-frame sample
  must be at or below 5,000 ms.
- Search, filtering, selection, and non-spatial navigation each require at least 20 samples;
  nearest-rank p95 must be at or below 100 ms.
- The engine must reach cooldown, and every post-drain idle animation sample must be zero.
- Peak memory, idle CPU, camera frame rate, GPU, editor, Electron, Chromium, OS, fixture seed, and
  package versions are mandatory evidence fields but do not receive invented cross-machine limits.

## Schema-v2 headed-editor measurement input

The report accepts one JSON document with this shape. The zero-valued arrays are illustrative and
do not satisfy the required sample counts:

```json
{
  "schemaVersion": 2,
  "measurementKind": "headed-editor",
  "capturedAt": "2026-07-22T12:00:00+09:00",
  "environment": {
    "hardware": "machine model",
    "os": "OS name, version, architecture",
    "cpu": "CPU model and logical processor count",
    "memoryGb": 0,
    "gpu": "GPU model and active renderer",
    "editorName": "VS Code or VSCodium",
    "editorVersion": "exact version",
    "editorCommit": "exact commit",
    "electronVersion": "exact version",
    "chromiumVersion": "exact version",
    "fixtureSeed": 5196614,
    "packageVersions": {
      "okf-workbench": "current manifest version",
      "3d-force-graph": "exact current dependency version"
    },
    "webviewBundleSha256": "64 lowercase hexadecimal characters",
    "extensionBundleSha256": "64 lowercase hexadecimal characters"
  },
  "qr002": {
    "debounceMs": 250,
    "updateSamples": [
      {
        "eventKind": "create",
        "durationMs": 0,
        "graphPublicationMs": 0,
        "diagnosticsPublicationMs": 0,
        "graphRevision": 2,
        "diagnosticsSequence": 1,
        "diagnosticsCorrelatedRevision": 2,
        "expectedDiagnostics": [
          {
            "relativePath": "concepts/qr002-probe-00.md",
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
        "firstInteractiveFrameMs": [0],
        "cooldownReached": true,
        "cooldownMs": [0],
        "idleAnimationFramesAfterCooldown": [0],
        "interactions": {
          "searchMs": [0],
          "filterMs": [0],
          "selectionMs": [0],
          "navigationMs": [0]
        },
        "memoryPeakMb": 0,
        "idleCpuPercent": 0,
        "cameraFps": 0
      },
      "ngraph": {
        "firstInteractiveFrameMs": [0],
        "cooldownReached": true,
        "cooldownMs": [0],
        "idleAnimationFramesAfterCooldown": [0],
        "interactions": {
          "searchMs": [0],
          "filterMs": [0],
          "selectionMs": [0],
          "navigationMs": [0]
        },
        "memoryPeakMb": 0,
        "idleCpuPercent": 0,
        "cameraFps": 0
      }
    }
  }
}
```

Every QR-002 observation must use one of `create`, `change`, `rename`, or `delete` and all four must
be represented. Graph revisions and diagnostics sequences must increase strictly.
`diagnosticsCorrelatedRevision` must equal `graphRevision`; `expectedDiagnostics` may be empty only
when the current operation is expected to clear all relevant findings. Every QR-003 interaction
array requires 20 finite, non-negative values. `measurementKind` must be exactly `headed-editor`;
changing a Playwright attachment label is not a valid substitute.

## Current-candidate binding

Strict evaluation first compares the evidence to the repository's current build inputs and
production outputs. A report is non-authoritative when any required value is absent or different:

1. `environment.packageVersions.okf-workbench` must equal the current `package.json` version.
2. `environment.packageVersions["3d-force-graph"]` must equal the exact current dependency version.
3. `environment.webviewBundleSha256` must equal SHA-256 of the current
   `dist/webview/main.js` bytes.
4. `environment.extensionBundleSha256` must equal SHA-256 over the current
   `dist/extension.cjs` bytes followed immediately by the current `dist/webview/main.js` bytes.

Both production files must exist, so run the production build before evaluating separately. The
headed runner performs that build itself before capture. The Webview-only hash binds renderer
behavior directly; the combined hash also binds the Extension Host parser, diagnostics, watcher,
protocol, and Webview path exercised by QR-002. A matching version string without matching bytes is
not sufficient. `--require-passing` exits with status 2 on missing or mismatched bindings.

## Capturing or reusing QR-003

A full headed run records `qr003.capturedAt` and
`qr003.provenance: { "kind": "captured" }`. When only QR-002 needs recapture, the runner can avoid
an unnecessary engine comparison by accepting `--reuse-qr003`:

```sh
mise x node@24.18.0 -- node test/benchmarks/headed-editor-evidence.mjs \
  --vscode-executable /absolute/path/to/VS-Code-executable \
  --reuse-qr003 docs/evidence/performance/vscode-1.127.0.json \
  --output artifacts/performance/vscode-1.127.0-v2.json

mise x node@24.18.0 -- npm run benchmark:report -- \
  --measurements artifacts/performance/vscode-1.127.0-v2.json \
  --require-passing
```

Reuse does not skip QR-002; the runner always captures the 20 current schema-v2 watcher samples.
Before copying QR-003 measurements, it requires exact equality for hardware, OS, CPU, memory, GPU,
editor name/version/commit, Electron, Chromium, fixture seed, package versions, and the combined
production extension + Webview SHA-256. It preserves the original QR-003 capture time and records:

```json
{
  "kind": "reused",
  "sourceMeasurementSha256": "SHA-256 of the complete source evidence file"
}
```

If any reuse field differs, run the full headed comparison instead of editing or copying samples.
Review the generated JSON and Markdown in `artifacts/performance/`; replace the tracked evidence
only after strict evaluation passes and the evidence is approved. Do not overwrite the retained
authoritative files during an exploratory run.

## Force-engine selection

The adapter exposes `d3` and `ngraph` behind the repository-owned renderer boundary and applies the
same 120-tick cooldown to both. Given complete current-candidate-bound headed evidence, the report:

1. evaluates each candidate against the same fixture and thresholds;
2. rejects incomplete engine measurements rather than treating missing values as zero;
3. considers only passing candidates;
4. selects the candidate with the lower normalized first-frame and worst-interaction score.

If neither engine passes, no release default is selected. In the retained schema-v2 VS Code 1.127.0
comparison, `d3` passed and was selected, matching the checked-in adapter default. `ngraph` rendered
its first interactive frame faster but failed the required cooldown signal after 120,000.3 ms and
was excluded. The comparison completes this gate only for the exact candidate hashes above.

The measured bundle used these renderer defaults:

| Concern | Default used by the measured candidate |
| --- | --- |
| Controls / renderer | Orbit controls; antialiasing on; opaque WebGL canvas (`alpha: false`) |
| Node presentation | Stable type color; selected black or white according to background contrast; value `1`, `1.4` for orphan/broken-link nodes, `2.4` when selected; opacity `0.9`; HTML tooltip disabled |
| Link presentation | Opacity `0.38`; directional arrow length `3.5`; arrow position `1` |
| Force simulation | `d3`; `120` cooldown ticks; full graph replacement resets the countdown |
| Camera | Focus distance `80`; transition `600 ms` |
| Idle behavior | Pause after engine cooldown and after a temporary camera-focus animation; pause while hidden or disposed |

Any change to these defaults invalidates reuse through the combined-bundle hash and requires a new
headed engine comparison.

## Headed run checklist

1. Start from the intended candidate with the pinned Node/npm versions. Let the runner build the
   production outputs; retain the Webview-only and combined Extension Host + Webview hashes.
2. Use a headed supported VS Code or VSCodium build with hardware acceleration unchanged. Record
   editor commit, Electron, Chromium, GPU renderer, OS, hardware, CPU, and memory.
3. For QR-002, run five create/change/rename/delete cycles through the real watcher. Observe current
   OKF Problems via the separate test-only diagnostics extension and the corresponding production
   Webview replacement graph. Retain all 20 structured samples.
4. For QR-003, either instantiate each engine through `ForceGraphRenderer` with the same
   representative payload and options, or use `--reuse-qr003` only when the runner accepts every
   exact environment/package/combined-hash check.
5. For a fresh QR-003 capture, record first interactive frame, cooldown, post-drain animation
   callbacks, peak memory, idle CPU, camera frame rate, and 20 samples for every interaction.
6. Save the raw JSON in a release artifact, run the strict report command, and retain sanitized raw
   evidence and generated Markdown for the immutable release candidate.
7. Repeat any failing or noisy run before changing a threshold. A threshold change requires an
   accepted decision update, not an edited measurement.

## Scope of the retained evidence

The retained schema-v2 run passes QR-002 and QR-003 for the exact recorded production bundle hashes
on Mac16,7 / Apple M4 Pro / VS Code 1.127.0. QR-002 recorded 703 ms p95 across 20 correlated samples;
QR-003 selected `d3` after it passed and `ngraph` failed cooldown. This completes the headed
performance gate for that candidate, not a general performance or compatibility guarantee.
VSCodium and OS compatibility lanes remain separate release-matrix evidence.
