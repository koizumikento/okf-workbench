# OKF Workbench performance evidence report

Generated: 2026-07-22T06:29:06.598Z

> This report treats only a complete `headed-editor` measurement as QR-002/QR-003 evidence. Node and Playwright harness results are non-authoritative.

## Result

| Target | Status | Evidence |
| --- | --- | --- |
| QR-002 | pass | 703.00 ms (20 samples) |
| QR-003 | pass | Release engine: d3 |

The evidence-backed release force-engine selection is `d3`. The report records this result but does not silently rewrite source.

QR-003 measurement: 2026-07-22T06:26:54.690Z; provenance: captured in this run.

## Headed-editor environment

| Field | Value |
| --- | --- |
| Captured at | 2026-07-22T06:26:54.690Z |
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
| Production Webview bundle SHA-256 | 853502f50117c6b565b8a9befdb474e1cbaf39bf78b8b7eb6aa3d52f92266d7b |
| Production extension + Webview SHA-256 | 93c75712626c20bee2b77ad74810267733c6457da85ad89c595772ac6e6d92ad |

## Force-engine comparison

| Engine | Status | First frame | Cooldown | Search p95 | Filter p95 | Selection p95 | Navigation p95 | Idle frames |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| d3 | pass | 328.90 ms max | 3054.70 ms mean | 8.10 ms | 3.20 ms | 1.00 ms | 27.50 ms | 0 |
| ngraph | fail | 102.70 ms max | 120000.30 ms mean | 6.60 ms | 2.90 ms | 0.80 ms | 16.10 ms | 0 |

## Webview network observation

| Class | Count | Sanitized origins/schemes |
| --- | ---: | --- |
| Remote HTTP(S)/WS | 0 | none |
| Local packaged resources | 2 | https://file+.vscode-resource.vscode-cdn.net |
| Other schemes | 0 | none |

Initial Webview resources plus CDP events during watcher refresh, search, filter, selection, engine comparison, and disposal.

## Missing or blocking evidence

- None.

## Report-generator host (not performance evidence)

- OS: darwin 25.5.0 arm64
- CPU: Apple M4 Pro; 14 logical processors
- Memory: 48.0 GiB
- Node: v24.18.0
- Package: okf-workbench@0.1.0
- 3d-force-graph: 1.80.0

