# Compatibility matrix

- Status: exact candidate qualified in the hosted editor/OS matrix
- Matrix date: 2026-07-22
- Extension identifier expected by the gate: `straydog.okf-workbench`

## What this matrix proves

The `Compatibility` GitHub Actions workflow builds one VSIX from the checked-out
revision, verifies the package, and runs the same install, activation, offline,
upgrade, and uninstall lifecycle against each configured editor and operating
system lane. A configured lane is not a compatibility claim by itself. The JSON
evidence uploaded by a successful workflow run is the proof for that candidate.

Upgrade is always tested with a semver-lower VSIX that has the same extension
identifier. When the dispatcher does not supply a published predecessor URL and
SHA-256 digest, the workflow packages the repository-owned, test-only `0.0.0`
fixture with a fixed `SOURCE_DATE_EPOCH`, records its digest, and upgrades from
that package. A same-version reinstall is recorded separately and is never
counted as upgrade evidence.

## Hosted final-candidate qualification

The normalized `0.1.0` candidate built from commit
`b0848e2c68ff28f1c12e1b9927d01a54c79542b5`, with byte size `581860` and
SHA-256 `b9125e6b56ce73de1e2ade10626f410f103ed7e421aa1b5d28cf0b565b2a36dd`,
passed every required editor/OS lifecycle lane in
[Compatibility run 29899159887](https://github.com/koizumikento/okf-workbench/actions/runs/29899159887).
The candidate and acceptance jobs in that run also passed. The same candidate
passed the quality/package, hostile-content Webview, and development Extension
Host jobs in
[CI run 29899142563](https://github.com/koizumikento/okf-workbench/actions/runs/29899142563).

The seven hosted lifecycle lanes prove clean installation and packaged
activation, six registered commands, execution of Validate Bundle and Open 3D
Graph, untrusted-workspace read availability with early write refusal, a real
upgrade from the repository-owned `0.0.0` predecessor, preservation of settings
and workspace files, uninstall, and zero attempts through the guarded
extension-host transports. These automated results do not by themselves prove
the manual editor-UI clauses tracked in
[acceptance evidence](acceptance-evidence.md).

## Preserved predecessor-candidate local qualification

The normalized `0.1.0` candidate built from commit
`524eca3f36e1a1b3da935495d3fbbd0eb0d03f56`, with byte size `581830` and
SHA-256 `65c137822052aa7f90ef08cc1300020fec4adcd7cbcec6aec88ae98fae64dad0`,
passed the packaged lifecycle on local macOS arm64. Each lane used the same
test-only `straydog.okf-workbench@0.0.0` predecessor with SHA-256
`7ca5f437fb846f636b51b933b53a55f57b229018bf17958781a661c8be6e6567`.

| Editor | Reported version | Extension Host API | Local macOS arm64 | Preserved evidence |
| --- | --- | --- | --- | --- |
| VS Code | `1.121.0` | `1.121.0` | Passed | [`vscode-1.121.0-macos-arm64.json`](evidence/compatibility/vscode-1.121.0-macos-arm64.json) |
| VS Code | `1.127.0` | `1.127.0` | Passed | [`vscode-1.127.0-macos-arm64.json`](evidence/compatibility/vscode-1.127.0-macos-arm64.json) |
| VSCodium | `1.121.03429` | `1.121.0` | Passed | [`vscodium-1.121.03429-macos-arm64.json`](evidence/compatibility/vscodium-1.121.03429-macos-arm64.json) |

These predecessor-candidate records are retained as local audit evidence. The
three primary records and their 18 linked activation/uninstall reports prove
clean installation, packaged activation, six registered commands, execution of
Validate Bundle and Open 3D Graph, zero guarded extension-host transport
attempts, untrusted-workspace read availability with early write refusal,
lower-version upgrade with a preserved user-setting sentinel, uninstall, and
workspace preservation. The editor CLI and extension API reported the extension
absent after uninstall. Where the editor left a verified installation directory,
the harness recorded that native residue separately and removed only the
identity-checked direct extension directory. The
[evidence README](evidence/compatibility/README.md) defines the scope and
sanitation. They do not describe the hosted final candidate above and must not
be used as cross-platform evidence. The `0.0.0` package is a test fixture, not
a published migration source.

## Executable lanes

| Editor | Exact version | Ubuntu 24.04 | macOS 15 | Windows 2025 | Acquisition |
| --- | --- | --- | --- | --- | --- |
| VS Code | `1.121.0` | Passed | N/A | N/A | Pinned editor test download |
| VS Code | `1.127.0` | Passed | Passed | Passed | Pinned editor test download |
| VSCodium | `1.121.03429` | Passed | Passed | Passed | Official archive with pinned SHA-256 |

The API-floor lane runs on the primary Ubuntu CI environment. Cross-platform
release smoke uses the current VS Code build and the compatible VSCodium build,
which avoids treating a package-only operating-system job as editor evidence.

The standard GitHub-hosted runner labels are `ubuntu-24.04`, `macos-15`, and
`windows-2025`. Evidence records `RUNNER_OS`, `RUNNER_ARCH`, `ImageOS`, and
`ImageVersion` at execution time instead of inferring the actual image or CPU
architecture from the label. The archive resolver has pins for both x64 and
arm64 where the official release provides them, so an unsupported runner
architecture fails closed rather than downloading a different build.

## VSCodium release pin

The compatible-editor lane uses the official
[VSCodium `1.121.03429` GitHub release](https://github.com/VSCodium/vscodium/releases/tag/1.121.03429),
published at `2026-05-22T22:14:58Z`. That release states that it updates its
upstream VS Code base to `1.121.0`.

The VSCodium command-line wrapper reports the release tag `1.121.03429`, while
the extension host reports its upstream API version as `1.121.0`. The gate
checks and records both values instead of treating either one as an alias.

Every supported desktop archive is pinned by its exact release URL and SHA-256.
The workflow verifies the digest before extraction or execution.

| Platform | Architecture | Official archive | SHA-256 |
| --- | --- | --- | --- |
| Linux | x64 | [`VSCodium-linux-x64-1.121.03429.tar.gz`](https://github.com/VSCodium/vscodium/releases/download/1.121.03429/VSCodium-linux-x64-1.121.03429.tar.gz) | `2c9b06735d4c1face570935f4968d358f9f6269f5d9237813d0b825c7d70a143` |
| Linux | arm64 | [`VSCodium-linux-arm64-1.121.03429.tar.gz`](https://github.com/VSCodium/vscodium/releases/download/1.121.03429/VSCodium-linux-arm64-1.121.03429.tar.gz) | `993e5dbf0f06399d069d968a452fd30334031046033a0723eb0ea534bcb9910d` |
| macOS | x64 | [`VSCodium-darwin-x64-1.121.03429.zip`](https://github.com/VSCodium/vscodium/releases/download/1.121.03429/VSCodium-darwin-x64-1.121.03429.zip) | `6c2ec07c7d9e2a69ac58838789f346283fe4550098cae31f5374948a5d035e43` |
| macOS | arm64 | [`VSCodium-darwin-arm64-1.121.03429.zip`](https://github.com/VSCodium/vscodium/releases/download/1.121.03429/VSCodium-darwin-arm64-1.121.03429.zip) | `73c2b5ed72a9446d638b69947e8ca0dbe71117ea9cd4a54c61591a428508cfb6` |
| Windows | x64 | [`VSCodium-win32-x64-1.121.03429.zip`](https://github.com/VSCodium/vscodium/releases/download/1.121.03429/VSCodium-win32-x64-1.121.03429.zip) | `cde622b803be7e0e24742790a2f3583eeeadae91c9332ea78af579853625bd8d` |
| Windows | arm64 | [`VSCodium-win32-arm64-1.121.03429.zip`](https://github.com/VSCodium/vscodium/releases/download/1.121.03429/VSCodium-win32-arm64-1.121.03429.zip) | `661ba191c8f4a590275554c8d983fbde105b960656c55cc8929413a9935affff` |

## Lifecycle evidence

Each lane writes a JSON evidence file even when a later lifecycle step fails,
and the workflow uploads that file with `if: always()`. The record includes:

- repository revision, candidate VSIX SHA-256, expected extension identifier,
  and package version;
- requested editor/version plus the editor's reported version, Electron,
  Chromium, Node, and architecture values when available;
- runner labels and the concrete GitHub runner image metadata;
- install, activation, offline acceptance, uninstall, and workspace-preservation
  results;
- the verified VSCodium archive URL and SHA-256 for VSCodium lanes;
- predecessor provenance, verified digest, and genuine lower-version upgrade
  result, distinguishing the test-only fixture from a published predecessor.

The gate must fail if an archive or predecessor digest does not match, if the
editor reports a version other than the requested pin, if the installed
extension identifier differs from `straydog.okf-workbench`, or if a required
lifecycle phase fails. Generated workspace files must remain after extension
uninstall.

## Running the gate

Run the `Compatibility` workflow manually for a release-candidate commit. For a
published migration proof, provide both `previous_vsix_url` and
`previous_vsix_sha256` in the dispatch form; the URL must identify a genuinely
older packaged version. Leaving both fields empty uses the deterministic test
predecessor and still executes the lower-version upgrade. Supplying only one is
an input error.

Retain the workflow URL and all per-lane JSON artifacts with the release review.
The hosted result above qualifies that exact candidate; a later candidate must
be rerun. Do not convert a planned lane, a local mock, or a failed workflow into
a support claim.
