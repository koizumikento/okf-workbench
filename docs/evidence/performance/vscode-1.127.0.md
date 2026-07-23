# OKF Workbench performance evidence report

Generated: 2026-07-23T04:07:30.642Z

> **Historical, non-qualifying archive.** This report was generated under a superseded evaluator.
> Its status fields are not current release results, and the current strict evaluator rejects this
> record. See [`../../performance-evidence.md`](../../performance-evidence.md) for the required
> recapture and current release status.

> This report treats only a complete `headed-editor` measurement as QR-002/QR-003 evidence. Node and Playwright harness results are non-authoritative.

## Result

| Target | Status | Evidence |
| --- | --- | --- |
| QR-002 | pass | 719.00 ms (20 samples) |
| QR-003 | pass | Release engine: d3 |

Under the superseded evaluator, this historical record selected `d3`. It does not establish the
current release force-engine selection and does not silently rewrite source.

QR-003 measurement: 2026-07-23T04:07:30.642Z; provenance: captured in this run.

## Headed-editor environment

| Field | Value |
| --- | --- |
| Captured at | 2026-07-23T04:07:30.642Z |
| Hardware | Mac16,7 |
| OS | Darwin 25.5.0 arm64 |
| CPU | Apple M4 Pro; 14 logical processors |
| Memory (GiB) | 48 |
| GPU | Google Inc. (Apple) / ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version) |
| Editor | VS Code 1.127.0 |
| Editor commit | 4fe60c8b1cdac1c4c174f2fb180d0d758272d713 |
| Electron | 42.2.0 |
| Chromium | 148.0.7778.97 |
| Fixture seed | 5196614 |
| Package versions | {"okf-workbench":"0.1.0","3d-force-graph":"1.80.0"} |
| Extension Host JavaScript SHA-256 | 36cbc9669b790d4633a2277a257c5037281df25080fec758abe4c7ffd26c9ded |
| Webview JavaScript SHA-256 | 153b9891bdab9a1eb05357a2a1c8f58dc92bd48362839621b7c877d1ac5ffc35 |
| Webview CSS SHA-256 | 8f47124ac42ffdc619489d9b9a618bedad59e63eea9fcb5beb8d79b8facb7ce4 |
| Domain-separated production bundle-set SHA-256 | d1ceefe1a35532335b9d20bb691fe7144a354c0f2cb282c41504b6fd2d0ea9d6 |
| Full production runtime snapshot SHA-256 | 2e881d977b2f06e96f960003f7c3ed5df2cd1987363ac56329fb6db8efb7663d |
| Production build-input snapshot SHA-256 | 4582b2dd27e91cb320447208208b07e6695c938dfdfe031822097c57f2a9d447 |
| QR-002 diagnostics-observer snapshot SHA-256 | 7673ed26ca74fcaa1d6960c01c57b64d5b5637f384b00515bdee718825480e94 |
| QR-003 harness-input snapshot SHA-256 | db5fab6a6cd40e3d1c33621325a7dffeb191078be45b5c269861ca94e2fa6790 |
| QR-003 harness definition SHA-256 | 56bab3d9a7f2656554e346b6be9437d05ce29027488c290187838705f0c364fa |
| QR-003 injected harness bundle SHA-256 | 3e26a468e1d275765468f1fa882aeea53c296e56eae444310fc773be7726fc11 |

## Force-engine comparison

| Engine | Status | First frame | Cooldown | Search p95 | Filter p95 | Selection p95 | Navigation p95 | Idle frames |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| d3 | pass | 296.90 ms max | 2539.50 ms mean | 7.60 ms | 18.40 ms | 1.20 ms | 0.70 ms | 0 |
| ngraph | fail | 102.10 ms max | 120001.30 ms mean | 7.30 ms | 17.40 ms | 1.00 ms | 0.90 ms | 0 |

## Webview network observation

| Class | Count | Sanitized origins/schemes |
| --- | ---: | --- |
| Remote HTTP(S)/WS | 0 | none |
| Local packaged resources | 2 | https://file+.vscode-resource.vscode-cdn.net |
| Other schemes | 0 | none |

Initial Webview resources plus CDP events during watcher refresh, search, filter, selection, engine comparison, and disposal.

## Missing or blocking evidence under the superseded evaluator

- None was reported at capture time. The current evaluator has additional mandatory evidence and
  rejects this record; current blockers are listed in [`../../performance-evidence.md`](../../performance-evidence.md).
