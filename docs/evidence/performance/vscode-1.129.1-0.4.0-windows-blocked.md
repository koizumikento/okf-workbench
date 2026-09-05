# OKF Workbench performance evidence report

Generated: 2026-09-05T11:18:55.261Z

> This report treats only a complete `headed-editor` measurement as QR-002/QR-003 evidence. Node and Playwright harness results are non-authoritative.

## Result

| Target | Status | Evidence |
| --- | --- | --- |
| QR-002 | fail | 1252.00 ms (20 samples) |
| QR-003 | pass | Release engine: d3 |
| Headed Webview network | pass | CDP observation of packaged resources and outbound schemes |

The evidence-backed release force-engine selection is `d3`. The report records this result but does not silently rewrite source.

QR-003 measurement: 2026-09-05T11:18:55.146Z; provenance: captured in this run.

## Headed-editor environment

| Field | Value |
| --- | --- |
| Captured at | 2026-09-05T11:18:55.261Z |
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
| Extension Host JavaScript SHA-256 | fc5e35f5b45a39cd3c500e3e688f2fa75f927ce9f7db60aa6f39309f2502682b |
| Webview JavaScript SHA-256 | 8f1dc414ec051650c58126133744e0715b44f24d68f24b2604a63f045205671a |
| Webview CSS SHA-256 | 54feb87be31bdb9bb46aa776b483c2b5f6ce6a041b57ad7ca6f4ab06e1b9d155 |
| Domain-separated production bundle-set SHA-256 | 41991fa52c851cba89207040513d59ca88c00fa44540b89a4b05d3a3ae88c89b |
| Full production runtime snapshot SHA-256 | 4199e8af47f641d248c55a499b334bf5884696c7abe7ee0c1223be70a97510ac |
| Production build-input snapshot SHA-256 | d562324d3f9f6a5148656159f66c15dd86dcf9d83e267b2da07baa000a69dda8 |
| QR-002 diagnostics-observer snapshot SHA-256 | b4902b14ea999ad00ef2ec8f723e2c55607a6d2262e844e71e56c9b8c29e2a21 |
| QR-003 harness-input snapshot SHA-256 | 2edc38c0a5282e89f27d6657232dfeb3a30f11b883562a01f4d6a9f42b10df78 |
| QR-003 harness definition SHA-256 | 56bab3d9a7f2656554e346b6be9437d05ce29027488c290187838705f0c364fa |
| QR-003 injected harness bundle SHA-256 | 3b3fe4ac79a3b70e06688632d8a3c65827aa9e42ba149cf614ad818c592c549b |

## Force-engine comparison

| Engine | Status | First frame | Cooldown | Search p95 | Filter p95 | Selection p95 | Navigation p95 | Idle frames |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| d3 | pass | 856.10 ms max | 3439.90 ms mean | 12.60 ms | 26.80 ms | 2.30 ms | 1.60 ms | 0 |
| ngraph | fail | captured graph-webgl-render-timeout after 5000 ms; 1 clears, 0 draws, canvas present | unmeasured | unmeasured | unmeasured | unmeasured | unmeasured | unmeasured |

## Webview network observation

| Class | Count | Sanitized origins/schemes |
| --- | ---: | --- |
| Remote HTTP(S)/WS | 0 | none |
| Local packaged resources | 2 | https://file+.vscode-resource.vscode-cdn.net |
| Internal Webview navigation | 2 | vscode-webview://021eanb2bpnevh144sen5f3grjcjkv45r020b0i047q5offc2f8n |
| Other schemes | 0 | none |

Initial Webview resources plus CDP events during watcher refresh, search, filter, selection, engine comparison, and disposal.

## Missing or blocking evidence

- None.
