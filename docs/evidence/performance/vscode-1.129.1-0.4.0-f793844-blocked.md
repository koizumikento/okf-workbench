# OKF Workbench performance evidence report

Generated: 2026-09-05T12:17:54.552Z

> This report treats only a complete `headed-editor` measurement as QR-002/QR-003 evidence. Node and Playwright harness results are non-authoritative.

## Result

| Target | Status | Evidence |
| --- | --- | --- |
| QR-002 | unmeasured | 1190.00 ms (20 samples) |
| QR-003 | unmeasured | Release engine: not selected |
| Headed Webview network | pass | CDP observation of packaged resources and outbound schemes |

The runtime adapter fallback is `d3` while release selection remains unmeasured. A passing report selects the measured candidate; it does not silently rewrite source.

QR-003 measurement: 2026-09-05T12:17:54.440Z; provenance: captured in this run.

## Headed-editor environment

| Field | Value |
| --- | --- |
| Captured at | 2026-09-05T12:17:54.552Z |
| Hardware | x86_64 x64 |
| OS | Windows_NT 10.0.26200 x64 |
| CPU | AMD Ryzen 9 9900X 12-Core Processor            ; 24 logical processors |
| Memory (GiB) | 31.15 |
| GPU | Google Inc. (NVIDIA) / ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 (0x00002F04) Direct3D11 vs_5_0 ps_5_0, D3D11) |
| Editor | VS Code 1.129.1 |
| Editor commit | 8a7abeba6e03ea3af87bfbce9a1b7e48fed567b8 |
| Electron | 42.6.0 |
| Chromium | 148.0.7778.280 |
| Fixture seed | 5196614 |
| Package versions | {"okf-workbench":"0.4.0","3d-force-graph":"1.80.0"} |
| Extension Host JavaScript SHA-256 | 4111a8694afde66decd5841338a099e7d1e6edf96dfbdaa6adb9b80ae8a6030a |
| Webview JavaScript SHA-256 | 8f1dc414ec051650c58126133744e0715b44f24d68f24b2604a63f045205671a |
| Webview CSS SHA-256 | 54feb87be31bdb9bb46aa776b483c2b5f6ce6a041b57ad7ca6f4ab06e1b9d155 |
| Domain-separated production bundle-set SHA-256 | 4c18d62c033b56930883c83d694444bc0c34e1fbb7ab64175fda19a37ab3ce3c |
| Full production runtime snapshot SHA-256 | 068e373dfa16ceb335fe2d936096284c673c6db74eb92ee2547a998dd41f0237 |
| Production build-input snapshot SHA-256 | 3f924a410780c769e8b1c51e5e14f4ac4d25e221ca621cf6f06b95cb8c5ae716 |
| QR-002 diagnostics-observer snapshot SHA-256 | b4902b14ea999ad00ef2ec8f723e2c55607a6d2262e844e71e56c9b8c29e2a21 |
| QR-003 harness-input snapshot SHA-256 | 606ebbc1f2eda650834a18c970b92888270d80e739db2bf15709fa9eb38aec4e |
| QR-003 harness definition SHA-256 | 56bab3d9a7f2656554e346b6be9437d05ce29027488c290187838705f0c364fa |
| QR-003 injected harness bundle SHA-256 | 3b3fe4ac79a3b70e06688632d8a3c65827aa9e42ba149cf614ad818c592c549b |

## Force-engine comparison

| Engine | Status | First frame | Cooldown | Search p95 | Filter p95 | Selection p95 | Navigation p95 | Idle frames |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| d3 | pass | 897.20 ms max | 3610.30 ms mean | 16.90 ms | 32.00 ms | 3.50 ms | 1.50 ms | 0 |
| ngraph | fail | captured graph-webgl-render-timeout after 5000 ms; 1 clears, 0 draws, canvas present | unmeasured | unmeasured | unmeasured | unmeasured | unmeasured | unmeasured |

## Webview network observation

| Class | Count | Sanitized origins/schemes |
| --- | ---: | --- |
| Remote HTTP(S)/WS | 0 | none |
| Local packaged resources | 2 | https://file+.vscode-resource.vscode-cdn.net |
| Internal Webview navigation | 2 | vscode-webview://1jrtbeqn7qiv3np7tgajbt7smtarq2h5rk4b2g58d8jj3uro8o10 |
| Other schemes | 0 | none |

Initial Webview resources plus CDP events during watcher refresh, search, filter, selection, engine comparison, and disposal.

## Missing or blocking evidence

- Evidence production build-input snapshot SHA-256 does not match the current candidate inputs.
- Evidence QR-003 harness-input snapshot SHA-256 does not match the current candidate inputs.
- QR-002 lacks authoritative headed-editor environment metadata.
- QR-003 lacks authoritative headed-editor environment metadata.
- No evidence-backed release force-engine default can be selected.
