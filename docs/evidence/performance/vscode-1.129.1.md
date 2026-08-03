# OKF Workbench performance evidence report

Generated: 2026-07-28T06:23:03.350Z

> **Retained predecessor report.** These pass statuses describe only the recorded `0.2.1` inputs.
> The current strict `--require-passing` evaluator exits `2`, marks QR-002 and QR-003 unmeasured,
> and does not accept the record as bound to the current production inputs. This file does not
> qualify the current Rust/Wasm source candidate. Its raw JSON SHA-256 is
> `a8917c18c12c3ee8d00efa27254e6f5114779dc8a5f4589c62d015c128436eb6`.

## Recorded result for predecessor inputs

| Target | Status | Evidence |
| --- | --- | --- |
| QR-002 | recorded pass | 677.00 ms (20 samples) |
| QR-003 | recorded pass | Release engine: d3 |
| Headed Webview network | recorded pass | CDP observation of packaged resources and outbound schemes |

The predecessor-input force-engine selection was `d3`. It is not a current-candidate selection.

QR-003 measurement: 2026-07-28T06:23:03.239Z; provenance: captured in this run.

## Headed-editor environment

| Field | Value |
| --- | --- |
| Captured at | 2026-07-28T06:23:03.350Z |
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
| Package versions | {"okf-workbench":"0.2.1","3d-force-graph":"1.80.0"} |
| Extension Host JavaScript SHA-256 | acb353157abafb9c896304025e4c3635966b04926f7a23b331f34f75ed94ec32 |
| Webview JavaScript SHA-256 | a8a7cc82260469763148eec4b8381b15d4aea6699250e72638567d57ceff6732 |
| Webview CSS SHA-256 | 54feb87be31bdb9bb46aa776b483c2b5f6ce6a041b57ad7ca6f4ab06e1b9d155 |
| Domain-separated production bundle-set SHA-256 | 73342e055e304f840c8f464775aa1fea44010731405b5dabe1f7e34e729f00f1 |
| Full production runtime snapshot SHA-256 | 67f12e1fc40c547ffa44b82c40f7124eaf98ca4f5175d12f72a33ce664ac3eeb |
| Production build-input snapshot SHA-256 | 1d8900cc2ec70d862bfd583faddea1296084b663b7f6d990d81925fdca6be810 |
| QR-002 diagnostics-observer snapshot SHA-256 | b4902b14ea999ad00ef2ec8f723e2c55607a6d2262e844e71e56c9b8c29e2a21 |
| QR-003 harness-input snapshot SHA-256 | 3e0db2c58bd66103d2cb9852763198e41d9c0bc7872331bce12fe89bcda6144b |
| QR-003 harness definition SHA-256 | 56bab3d9a7f2656554e346b6be9437d05ce29027488c290187838705f0c364fa |
| QR-003 injected harness bundle SHA-256 | 3ab4c80701da27661369658ed8226aa50a5b32f4765b7dd28b5942e03004ec63 |

## Force-engine comparison

| Engine | Status | First frame | Cooldown | Search p95 | Filter p95 | Selection p95 | Navigation p95 | Idle frames |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| d3 | pass | 297.10 ms max | 2744.80 ms mean | 9.10 ms | 16.60 ms | 2.10 ms | 0.80 ms | 0 |
| ngraph | fail | captured graph-webgl-render-timeout after 5000 ms; 1 clears, 0 draws, canvas present | unmeasured | unmeasured | unmeasured | unmeasured | unmeasured | unmeasured |

## Webview network observation

| Class | Count | Sanitized origins/schemes |
| --- | ---: | --- |
| Remote HTTP(S)/WS | 0 | none |
| Local packaged resources | 2 | https://file+.vscode-resource.vscode-cdn.net |
| Internal Webview navigation | 2 | vscode-webview://16883ol4vjh4gjaurn07rs4ip2svukk5v7l57irdkfb7dvoltq7v |
| Other schemes | 0 | none |

Initial Webview resources plus CDP events during watcher refresh, search, filter, selection, engine comparison, and disposal.

## Current-candidate blocking evidence

- This retained record does not satisfy current production/runtime/build/harness binding checks.
- Fresh current-candidate QR-002, QR-003, and headed Webview network qualification is pending.
