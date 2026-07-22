# Open VSX listing draft

- Status: **release-candidate copy; do not publish without explicit maintainer approval**
- Target version: `0.1.0`
- Unique identifier: `straydog.okf-workbench`
- Namespace: `straydog` — verified and restricted; owner/member authorization still must be
  checked for the publishing identity immediately before release
- Name availability: `straydog.okf-workbench` was unoccupied when checked on 2026-07-22; recheck
  immediately before publication

## Listing metadata

| Field | Candidate value |
| --- | --- |
| Display name | OKF Workbench |
| Short description | Create, validate, index, and explore Open Knowledge Format bundles locally. |
| Categories | Other; Visualization |
| Keywords | `knowledge`; `markdown`; `okf`; `open-knowledge-format` |
| Icon | `assets/icon.png` |
| Repository | <https://github.com/koizumikento/okf-workbench> |
| Issues / support | <https://github.com/koizumikento/okf-workbench/issues> |
| Homepage | <https://github.com/koizumikento/okf-workbench#readme> |
| Privacy | <https://github.com/koizumikento/okf-workbench/blob/main/docs/privacy.md> |
| License | **Unresolved release gate; do not substitute or publish until approved** |
| Third-party notices | <https://github.com/koizumikento/okf-workbench/blob/main/THIRD_PARTY_NOTICES.md> |

The manifest, README, changelog, icon, repository links, license identifier, and candidate version
must match this table before the package is approved. The repository is private while this draft is
being prepared. Before publication, either make marketplace-facing resources readable without
repository access or replace these URLs with durable public support, privacy, license, and source
locations approved by the maintainer.

## Suggested listing copy

### Create, validate, and explore OKF knowledge without leaving your editor

OKF Workbench supports a complete local authoring loop for
[Open Knowledge Format v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/ee67a5ca27044ebe7c38385f5b6cffc2305a9c1a/okf/SPEC.md)
bundles: initialize, create, edit, validate, index, explore, and repair.

Use three starter bundle presets and seven concept templates, keep arbitrary concept types and
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
through editor workspace APIs, and Webview assets are packaged locally. Read the full
[privacy statement](https://github.com/koizumikento/okf-workbench/blob/main/docs/privacy.md) and
[security evidence](https://github.com/koizumikento/okf-workbench/blob/main/docs/security-privacy-evidence.md).

### Compatibility and performance

The manifest targets VS Code-compatible desktop editors with API floor `^1.121.0`. Exact support
claims are governed by the retained
[compatibility-matrix evidence](https://github.com/koizumikento/okf-workbench/blob/main/docs/compatibility-matrix.md),
not by the configured lanes alone. The retained schema-v2
[headed-editor evidence](https://github.com/koizumikento/okf-workbench/blob/main/docs/performance-evidence.md)
passes QR-002 at 703 ms p95 over 20 correlated file-event samples and passes QR-003 with `d3` as
the release engine for the exact measured production bundles. This result is limited to Mac16,7 /
Apple M4 Pro / VS Code 1.127.0 and is not a general performance guarantee.

## Required resources in the packaged listing

- `README.md` describes implemented behavior and unresolved gates.
- `CHANGELOG.md` contains the `0.1.0` candidate entry and a publication date at release time.
- `assets/icon.png` is included and referenced by the manifest.
- Repository, issue, homepage, privacy, project-license, and third-party-notice links resolve.
- The package contains no local development artifact, secret, source map, or unapproved license
  claim.

## Publication boundary

The official Open VSX process requires a publishing identity that has signed the Publisher
Agreement, a personal access token, namespace membership, and an uploaded VSIX. The
[`publisher` manifest field controls the namespace](https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions),
and only namespace members can publish in a restricted namespace. Verified status also depends on
the namespace owner and publishing-user membership described by the
[namespace-access rules](https://github.com/eclipse-openvsx/openvsx/wiki/Namespace-Access).

Do not place a token on a command line or in a repository file. After all checklist gates pass and
the maintainer explicitly approves the exact commit, version, and digest, dispatch the reviewed
`Open VSX release` workflow from that same default-branch revision with the four inputs documented
in the [release checklist](release-checklist.md). Only its protected `open-vsx` Environment may
provide `OVSX_PAT`; the workflow verifies `straydog` authorization and publishes the retained,
rehash-verified VSIX without rebuilding it. A local `ovsx publish` command is not an approved
fallback. Publication is an external state change and is not part of building this release
candidate.
