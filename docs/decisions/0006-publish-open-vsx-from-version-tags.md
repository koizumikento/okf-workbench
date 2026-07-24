# ADR 0006 — Publish Open VSX releases from version tags

- Status: Accepted
- Date: 2026-07-24

## Context

The initial release workflow required a manual dispatch, an exact candidate digest typed into the
workflow, and a protected GitHub Environment that had not been configured. The repository already
protects `main` with required CI checks, uses reproducible VSIX packaging, and stores an Open VSX
credential as the repository secret `OPEN_VSX_TOKEN`. The maintainer prefers the simpler release
model already proven by the `shosei` extension: publishing a version tag is the explicit release
action.

## Decision

Pushing a `v*` tag starts the only automated Open VSX release workflow.

The workflow:

1. requires the tag commit to be contained in `main`;
2. requires `v<package.json version>` and a dated changelog entry;
3. reruns the deterministic source, dependency, security, audit, package, and VSIX inspection
   gates;
4. retains the universal and target-platform VSIX packages and their SHA-256 files without
   rebuilding them in later jobs;
5. creates or updates the matching GitHub Release;
6. verifies `straydog` authorization with the locked `ovsx` CLI; and
7. publishes all retained VSIX packages with duplicate-safe retry behavior.

Only the authorization and publication steps receive `secrets.OPEN_VSX_TOKEN`. A missing or invalid
credential fails the workflow. Pull requests, ordinary branch pushes, and local builds do not
receive the credential or invoke publication.

## Consequences

- A maintainer release consists of preparing a reviewed main-branch commit and pushing its matching
  version tag.
- The tag replaces the former manual workflow inputs and protected-Environment approval as the
  release authorization boundary.
- The release workflow remains fail-closed for identity, changelog, package, checksum, credential,
  and publication errors.
- The repository no longer claims independent human approval of a separately supplied VSIX digest.
- Open VSX publication is external and irreversible for a version. Recovery uses a higher SemVer
  version; a tag or registry version must never be reused for different bytes.

ADR 0008 extends the retained artifact set to four target-platform VSIX packages, one universal
fallback VSIX, and four standalone CLI archives. It does not change the tag authorization boundary.
