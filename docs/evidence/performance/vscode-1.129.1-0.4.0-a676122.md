# OKF Workbench performance evidence report

Generated: 2026-09-05T12:01:22.462Z

> This report treats only a complete `headed-editor` measurement as QR-002/QR-003 evidence. Node and Playwright harness results are non-authoritative.

## Result

| Target | Status | Evidence |
| --- | --- | --- |
| QR-002 | pass | 961.00 ms (20 samples) |
| QR-003 | pass | Release engine: d3 |
| Headed Webview network | pass | CDP observation of packaged resources and outbound schemes |

The evidence-backed release force-engine selection is `d3`. The report records this result but does not silently rewrite source.

QR-003 measurement: 2026-09-05T12:01:22.350Z; provenance: captured in this run.

## Headed-editor environment

| Field | Value |
| --- | --- |
| Captured at | 2026-09-05T12:01:22.462Z |
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
| Extension Host JavaScript SHA-256 | a6c75ae21f17615b4d8536114a566b975602d743d6762982701542c96303292d |
| Webview JavaScript SHA-256 | 8f1dc414ec051650c58126133744e0715b44f24d68f24b2604a63f045205671a |
| Webview CSS SHA-256 | 54feb87be31bdb9bb46aa776b483c2b5f6ce6a041b57ad7ca6f4ab06e1b9d155 |
| Domain-separated production bundle-set SHA-256 | bbe48741570e2fdb3dcc2da1e17e22dace11123abd9ecff1b4b487d1da5533f6 |
| Full production runtime snapshot SHA-256 | 8a6d032b167a7ec95d07b73024c989bab6dbdff5f9a263f09ae44701f88d8d3f |
| Production build-input snapshot SHA-256 | 8d56335cceb71959548d97bb3b06329a3d21f163843ed92e976e6750b1e29607 |
| QR-002 diagnostics-observer snapshot SHA-256 | b4902b14ea999ad00ef2ec8f723e2c55607a6d2262e844e71e56c9b8c29e2a21 |
| QR-003 harness-input snapshot SHA-256 | ec6e93f97e384527cfb2732e6d7d8a650e6fd044743b6a0f3b70214a75e5b31b |
| QR-003 harness definition SHA-256 | 56bab3d9a7f2656554e346b6be9437d05ce29027488c290187838705f0c364fa |
| QR-003 injected harness bundle SHA-256 | 3b3fe4ac79a3b70e06688632d8a3c65827aa9e42ba149cf614ad818c592c549b |

## Force-engine comparison

| Engine | Status | First frame | Cooldown | Search p95 | Filter p95 | Selection p95 | Navigation p95 | Idle frames |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| d3 | pass | 799.70 ms max | 2940.90 ms mean | 10.00 ms | 19.70 ms | 2.40 ms | 1.00 ms | 0 |
| ngraph | fail | captured graph-webgl-render-timeout after 5000 ms; 1 clears, 0 draws, canvas present | unmeasured | unmeasured | unmeasured | unmeasured | unmeasured | unmeasured |

## Webview network observation

| Class | Count | Sanitized origins/schemes |
| --- | ---: | --- |
| Remote HTTP(S)/WS | 0 | none |
| Local packaged resources | 2 | https://file+.vscode-resource.vscode-cdn.net |
| Internal Webview navigation | 2 | vscode-webview://0nvov00645vri2c4c27d5cq21ca52hv5r5sauau3q4umg5f909mc |
| Other schemes | 0 | none |

Initial Webview resources plus CDP events during watcher refresh, search, filter, selection, engine comparison, and disposal.

## Missing or blocking evidence

- None.
