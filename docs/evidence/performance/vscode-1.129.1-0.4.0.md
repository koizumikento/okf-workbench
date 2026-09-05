# OKF Workbench performance evidence report

Generated: 2026-09-05T12:26:53.393Z

> This report treats only a complete `headed-editor` measurement as QR-002/QR-003 evidence. Node and Playwright harness results are non-authoritative.

## Result

| Target | Status | Evidence |
| --- | --- | --- |
| QR-002 | pass | 851.00 ms (20 samples) |
| QR-003 | pass | Release engine: d3 |
| Headed Webview network | pass | CDP observation of packaged resources and outbound schemes |

The evidence-backed release force-engine selection is `d3`. The report records this result but does not silently rewrite source.

QR-003 measurement: 2026-09-05T12:26:53.282Z; provenance: captured in this run.

## Headed-editor environment

| Field | Value |
| --- | --- |
| Captured at | 2026-09-05T12:26:53.393Z |
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
| Extension Host JavaScript SHA-256 | 33d84d472c3f81d599e5e7b7d7ba12afed170c55dc5ba2fa3e2c420ac3a8fecd |
| Webview JavaScript SHA-256 | 8f1dc414ec051650c58126133744e0715b44f24d68f24b2604a63f045205671a |
| Webview CSS SHA-256 | 54feb87be31bdb9bb46aa776b483c2b5f6ce6a041b57ad7ca6f4ab06e1b9d155 |
| Domain-separated production bundle-set SHA-256 | 23a2ea11ad4c68fab4fdec907e224fed78947e9dd56c29c5d2d424a912a45880 |
| Full production runtime snapshot SHA-256 | d5b2436cba1ee474a97b208242fdea2300ff23b8446d28214fca40e79c30e704 |
| Production build-input snapshot SHA-256 | a22b99a07a6adca3d5b459670ce03f02b1f85dd905b6d892ff6c9d758baca1ba |
| QR-002 diagnostics-observer snapshot SHA-256 | b4902b14ea999ad00ef2ec8f723e2c55607a6d2262e844e71e56c9b8c29e2a21 |
| QR-003 harness-input snapshot SHA-256 | c3fe60631a205f3de2c154af611058fd62dc4f1ec6d4b5508e925677723d4b85 |
| QR-003 harness definition SHA-256 | 56bab3d9a7f2656554e346b6be9437d05ce29027488c290187838705f0c364fa |
| QR-003 injected harness bundle SHA-256 | 3b3fe4ac79a3b70e06688632d8a3c65827aa9e42ba149cf614ad818c592c549b |

## Force-engine comparison

| Engine | Status | First frame | Cooldown | Search p95 | Filter p95 | Selection p95 | Navigation p95 | Idle frames |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| d3 | pass | 798.00 ms max | 3124.50 ms mean | 11.20 ms | 21.20 ms | 2.10 ms | 1.20 ms | 0 |
| ngraph | fail | captured graph-webgl-render-timeout after 5000 ms; 1 clears, 0 draws, canvas present | unmeasured | unmeasured | unmeasured | unmeasured | unmeasured | unmeasured |

## Webview network observation

| Class | Count | Sanitized origins/schemes |
| --- | ---: | --- |
| Remote HTTP(S)/WS | 0 | none |
| Local packaged resources | 2 | https://file+.vscode-resource.vscode-cdn.net |
| Internal Webview navigation | 2 | vscode-webview://1d4ik4g8gb1fi8fcqfltnna2bah2t59c531rc8qg72p170jef3gg |
| Other schemes | 0 | none |

Initial Webview resources plus CDP events during watcher refresh, search, filter, selection, engine comparison, and disposal.

## Missing or blocking evidence

- None.
