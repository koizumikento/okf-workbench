# OKF Workbench performance evidence report

Generated: 2026-08-03T07:58:45.653Z

> This report treats only a complete `headed-editor` measurement as QR-002/QR-003 evidence. Node and Playwright harness results are non-authoritative.

## Result

| Target | Status | Evidence |
| --- | --- | --- |
| QR-002 | pass | 862.00 ms (20 samples) |
| QR-003 | pass | Release engine: d3 |
| Headed Webview network | pass | CDP observation of packaged resources and outbound schemes |

The evidence-backed release force-engine selection is `d3`. The report records this result but does not silently rewrite source.

QR-003 measurement: 2026-08-03T07:58:45.540Z; provenance: captured in this run.

## Headed-editor environment

| Field | Value |
| --- | --- |
| Captured at | 2026-08-03T07:58:45.653Z |
| Hardware | Mac16,7 |
| OS | Darwin 25.5.0 arm64 |
| CPU | Apple M4 Pro; 14 logical processors |
| Memory (GiB) | 48 |
| GPU | Google Inc. (Apple) / ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version) |
| Editor | VS Code 1.129.1 |
| Editor commit | 8a7abeba6e03ea3af87bfbce9a1b7e48fed567b8 |
| Electron | 42.6.0 |
| Chromium | 148.0.7778.280 |
| Fixture seed | 5196614 |
| Package versions | {"okf-workbench":"0.3.0","3d-force-graph":"1.80.0"} |
| Extension Host JavaScript SHA-256 | a48398ffdf170d54666ca3e1af5bf77da7ae8b8f00b159df476d70768d5b4f77 |
| Webview JavaScript SHA-256 | 8f1dc414ec051650c58126133744e0715b44f24d68f24b2604a63f045205671a |
| Webview CSS SHA-256 | 54feb87be31bdb9bb46aa776b483c2b5f6ce6a041b57ad7ca6f4ab06e1b9d155 |
| Domain-separated production bundle-set SHA-256 | fb630a150b2d9c0e33208bbec90a878343790c7b306be1a08d999e47a647b428 |
| Full production runtime snapshot SHA-256 | 6fbcc3b2f004dcfd0f30bfcedd80aea76f79cd4c4e07a07edbf57596d64ab2b4 |
| Production build-input snapshot SHA-256 | c7c5189af35dc80c5ebdf1c92e6617dc3b2ec21f561c5f061c532d8742d06d6b |
| QR-002 diagnostics-observer snapshot SHA-256 | b4902b14ea999ad00ef2ec8f723e2c55607a6d2262e844e71e56c9b8c29e2a21 |
| QR-003 harness-input snapshot SHA-256 | 32cd973bdfe52fe211d134a334ab8a49adaf16cb959de16fe91d2e3a92edcec0 |
| QR-003 harness definition SHA-256 | 56bab3d9a7f2656554e346b6be9437d05ce29027488c290187838705f0c364fa |
| QR-003 injected harness bundle SHA-256 | 3b3fe4ac79a3b70e06688632d8a3c65827aa9e42ba149cf614ad818c592c549b |

## Force-engine comparison

| Engine | Status | First frame | Cooldown | Search p95 | Filter p95 | Selection p95 | Navigation p95 | Idle frames |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| d3 | pass | 298.00 ms max | 2494.40 ms mean | 9.20 ms | 24.10 ms | 2.00 ms | 0.80 ms | 0 |
| ngraph | fail | captured graph-webgl-render-timeout after 5000 ms; 1 clears, 0 draws, canvas present | unmeasured | unmeasured | unmeasured | unmeasured | unmeasured | unmeasured |

## Webview network observation

| Class | Count | Sanitized origins/schemes |
| --- | ---: | --- |
| Remote HTTP(S)/WS | 0 | none |
| Local packaged resources | 2 | https://file+.vscode-resource.vscode-cdn.net |
| Internal Webview navigation | 2 | vscode-webview://1aqpg9gn6c94bi9tvenrcvkardd1k4oha082ort4ssd2orla31gn |
| Other schemes | 0 | none |

Initial Webview resources plus CDP events during watcher refresh, search, filter, selection, engine comparison, and disposal.

## Missing or blocking evidence

- None.
