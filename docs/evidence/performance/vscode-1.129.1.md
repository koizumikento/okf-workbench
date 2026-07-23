# OKF Workbench performance evidence report

Generated: 2026-07-23T09:59:23.073Z

> This report treats only a complete `headed-editor` measurement as QR-002/QR-003 evidence. Node and Playwright harness results are non-authoritative.

## Result

| Target | Status | Evidence |
| --- | --- | --- |
| QR-002 | pass | 832.00 ms (20 samples) |
| QR-003 | pass | Release engine: d3 |
| Headed Webview network | pass | CDP observation of packaged resources and outbound schemes |

The evidence-backed release force-engine selection is `d3`. The report records this result but does not silently rewrite source.

QR-003 measurement: 2026-07-23T09:59:22.962Z; provenance: captured in this run.

## Headed-editor environment

| Field | Value |
| --- | --- |
| Captured at | 2026-07-23T09:59:23.073Z |
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
| Package versions | {"okf-workbench":"0.1.0","3d-force-graph":"1.80.0"} |
| Extension Host JavaScript SHA-256 | 3db49ef3f4bc2cf51bab7dfc6f8196cfa5596e3d5db3453fe6bd9bfc8483ef36 |
| Webview JavaScript SHA-256 | fe7fc2b9aa596f11a83f1c7fc5c414e420aadb5fd7e31049a4f0972ef53de188 |
| Webview CSS SHA-256 | 8f47124ac42ffdc619489d9b9a618bedad59e63eea9fcb5beb8d79b8facb7ce4 |
| Domain-separated production bundle-set SHA-256 | 8eed711120ae4d18e41dacd8d69c0c6f53a56ee4a4c5c5531e55e4d0c8c52262 |
| Full production runtime snapshot SHA-256 | b41d9505aa60f730189fe72458dc49489f2132a3bb0a742ecd1a42964392f5d2 |
| Production build-input snapshot SHA-256 | 11fb2c6747c8313fcf9d57716f742c0cc0f113dedc6a33fa9e7a0640410451f9 |
| QR-002 diagnostics-observer snapshot SHA-256 | b4902b14ea999ad00ef2ec8f723e2c55607a6d2262e844e71e56c9b8c29e2a21 |
| QR-003 harness-input snapshot SHA-256 | 979877ee34c27d9893377b33bbb17ad46f05a3368b0e143b90d88bc4b49f0f1d |
| QR-003 harness definition SHA-256 | 56bab3d9a7f2656554e346b6be9437d05ce29027488c290187838705f0c364fa |
| QR-003 injected harness bundle SHA-256 | 3de4179bb36b914f562094f269f674b3ea33309024d8c83c667a666be9f940c1 |

## Force-engine comparison

| Engine | Status | First frame | Cooldown | Search p95 | Filter p95 | Selection p95 | Navigation p95 | Idle frames |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| d3 | pass | 299.50 ms max | 2872.70 ms mean | 7.80 ms | 15.60 ms | 1.10 ms | 0.60 ms | 0 |
| ngraph | fail | captured graph-webgl-render-timeout after 5000 ms; 1 clears, 0 draws, canvas present | unmeasured | unmeasured | unmeasured | unmeasured | unmeasured | unmeasured |

## Webview network observation

| Class | Count | Sanitized origins/schemes |
| --- | ---: | --- |
| Remote HTTP(S)/WS | 0 | none |
| Local packaged resources | 2 | https://file+.vscode-resource.vscode-cdn.net |
| Internal Webview navigation | 2 | vscode-webview://0936lathp7sg2vupd1nm1cjqdfqtrfoil4r7dr8bktevsd2uubqk |
| Other schemes | 0 | none |

Initial Webview resources plus CDP events during watcher refresh, search, filter, selection, engine comparison, and disposal.

## Missing or blocking evidence

- None.
