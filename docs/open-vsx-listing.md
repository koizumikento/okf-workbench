# Open VSX listing record and future-release boundary

- Published status: **`straydog.okf-workbench@0.2.1` was published on 2026-07-28; this does not
  qualify or publish the current Rust/Wasm source candidate**
- Published version recorded here: `0.2.1`
- Unique identifier: `straydog.okf-workbench`
- Namespace: `straydog` — the retained `v0.2.1` release workflow verified publication authority
  and published the universal and four target packages. Credential, namespace-role, and Publisher
  Agreement readiness must be checked again for every future release.
- Release record: the [completed `0.2.1` checklist](release-checklist.md) links the signed tag,
  workflow, GitHub Release, public Open VSX listing, and post-publication checks.

## Listing metadata

| Field | Candidate value |
| --- | --- |
| Display name | OKF Workbench |
| Short description | Create, validate, index, and explore Open Knowledge Format bundles locally. |
| Categories | Other; Visualization |
| Keywords | `knowledge`; `markdown`; `okf`; `open-knowledge-format` |
| Icon | `assets/icon.png` |
| Repository | `https://github.com/koizumikento/okf-workbench.git` |
| Issues / support | `https://github.com/koizumikento/okf-workbench/issues` |
| Homepage | `https://koizumikento.github.io/okf-workbench/` |
| Privacy | `https://koizumikento.github.io/okf-workbench/privacy/` and the packaged README |
| License | MIT; VSCE packages the canonical root `LICENSE` as `extension/LICENSE.txt` |
| Third-party notices | Packaged as `extension/THIRD_PARTY_NOTICES.md` and linked from the public project site |

The manifest, README, changelog, icon, license identifier, candidate version, and exact public URLs
must match this table before the package is approved. The public source repository provides the
issue tracker and security-advisory route, while GitHub Pages provides durable privacy, support,
security, license, and notice pages. The packaged README and changelog contain no excluded
documentation or speculative release-tag links.

## Suggested listing copy

### Create, validate, and explore OKF knowledge without leaving your editor

OKF Workbench supports a complete local authoring loop for
[Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/3fcbb9f828c2f23d109c855ee403c3a4c81f3a96/okf/SPEC.md)
bundles with a v0.1 compatibility fallback: initialize, create, edit, validate, index, explore, and
repair.

Use three starter bundle presets and eight concept templates, keep arbitrary concept types and
unknown frontmatter, surface conformance errors separately from curation warnings, and regenerate
managed index regions after reviewing a local diff.

Open the read-only 3D graph to search and filter concepts, inspect directed links and backlinks,
find broken links and orphans, navigate through the accessible node list, and return directly to
source Markdown. Workspace changes refresh the selected bundle without turning the graph into an
editing surface.

Agent integration is intentionally lightweight: generate a managed `AGENTS.md` section, a portable
Agent Skill, or both. OKF Workbench does not embed or invoke an AI model.

### Local-first boundary

No account is required. The extension has no built-in telemetry, analytics, AI provider, content
upload, synchronization service, or runtime network client. Bundle parsing and generation happen
through editor workspace APIs, and Webview assets are packaged locally. It does not intentionally
send bundle content, filenames, frontmatter, links, prompts, diagnostics, or graph data to the
maintainer or a hosted service. Editor update checks, registries, remote-workspace providers,
synchronization tools, and external agents are outside the extension's bundle-processing boundary.

### Compatibility and performance

The manifest targets VS Code-compatible desktop editors with API floor `^1.121.0`. Compatibility
is specific to the editor version, operating system, and exact extension package; the API floor is
not a universal compatibility guarantee. A retained schema-v3 headed VS Code `1.129.1` capture for
the predecessor `0.2.1` inputs recorded QR-002 at `677 ms` p95, `d3` as the QR-003 selection, and
zero remote HTTP(S)/WS or other-scheme Webview requests on its recorded hardware. Strict
re-evaluation rejects its input identities for the current Rust/Wasm source candidate. Retained VS
Code `1.127.0` measurements are historical only. Fresh headed, hosted compatibility, and packaged
lifecycle qualification remain pending for the exact release candidate.

## Required resources in the packaged listing

- `README.md` describes implemented behavior, the local-first privacy boundary, MIT licensing, and
  bundled third-party notices.
- `CHANGELOG.md` contains the dated published `0.2.1` entry.
- `assets/icon.png` is included and referenced by the manifest.
- A future candidate must contain exactly one project-license entry, `extension/LICENSE.txt`, whose
  bytes match the canonical root `LICENSE`; its packaged JSON manifest declares exactly `MIT`, and
  `extension.vsixmanifest` points both license metadata entries to that same canonical path.
- The packaged manifest contains the exact approved public `repository`, `bugs`, and `homepage`
  values; the generated VSIX manifest contains only their corresponding marketplace resource
  links.
- The README and changelog contain no excluded documentation or uncreated release-tag link.
- The README states privacy behavior, project licensing, and bundled-notice availability inline.
- The package contains the public `SECURITY.md` but no local development artifact, secret, source
  map, or unapproved license claim.

## Publication boundary

The official Open VSX process requires a publishing identity that has signed the Publisher
Agreement, a personal access token, namespace membership, and an uploaded VSIX. The
[`publisher` manifest field controls the namespace](https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions),
and only namespace members can publish in a restricted namespace. Verified status also depends on
the namespace owner and publishing-user membership described by the
[namespace-access rules](https://github.com/eclipse-openvsx/openvsx/wiki/Namespace-Access).

The retained pre-`0.1.0` public API availability check is historical input to the initial release;
it is not current authorization evidence. The completed `v0.2.1` workflow and public listing prove
that version's publication. They do not prove a future PAT or exact namespace role; the protected
workflow checks those with `ovsx verify-pat`. Publisher Agreement status is a separate out-of-band
profile prerequisite, and Open VSX also enforces it at the publish endpoint.

Do not place a token on a command line or in a repository file. After all checklist gates pass, the
maintainer authorizes release by pushing the matching signed `v*` tag for the reviewed `main`
commit, as documented in the [release checklist](release-checklist.md). The workflow packages once,
retains the VSIX and checksum, creates the GitHub Release, then exposes `OPEN_VSX_TOKEN` only to
`ovsx verify-pat straydog` and the duplicate-safe publish command. A local `ovsx publish` command is
not an approved fallback. Publication is an external state change and is not part of building a
future release candidate.
