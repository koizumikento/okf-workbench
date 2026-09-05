---
layout: default
title: OKF Workbench
description: Create, validate, index, and explore Open Knowledge Format bundles locally.
hero: true
eyebrow: Open Knowledge Format authoring
summary: A local-first VS Code-compatible workbench for creating, validating, indexing, and exploring OKF bundles.
permalink: /
---

OKF Workbench keeps Markdown as the source of truth and turns the complete authoring loop into
editor commands:

```text
initialize -> create -> edit -> validate -> explore -> repair
```

<div class="card-grid">
  <section class="card">
    <h3>Local by default</h3>
    <p>Bundle parsing, validation, generation, and graph construction run in the editor workspace without an account or hosted content service.</p>
    <a href="{{ '/privacy/' | relative_url }}">Privacy boundary</a>
  </section>
  <section class="card">
    <h3>Safe authoring</h3>
    <p>New files use guarded no-overwrite creation, while existing-file changes are previewed and unrelated Markdown and unknown frontmatter remain under user control.</p>
    <a href="https://github.com/koizumikento/okf-workbench#safety-and-file-ownership">Safety model</a>
  </section>
  <section class="card">
    <h3>Open implementation</h3>
    <p>The extension is published under the MIT License with its production dependency notices included in every VSIX.</p>
    <a href="{{ '/license/' | relative_url }}">License</a>
  </section>
</div>

## Public resources

- [Source code and README](https://github.com/koizumikento/okf-workbench)
- [Issue tracker](https://github.com/koizumikento/okf-workbench/issues)
- [Privacy statement]({{ '/privacy/' | relative_url }})
- [Support]({{ '/support/' | relative_url }})
- [Security policy]({{ '/security/' | relative_url }})
- [MIT License]({{ '/license/' | relative_url }})
- [Third-party notices]({{ '/notices/' | relative_url }})

## Project documentation

The repository keeps its product decisions, compatibility evidence, and implementation references
under [`docs/`](https://github.com/koizumikento/okf-workbench/tree/main/docs). The documents below
are the source of truth for the initial product and engineering direction.

## Product

| Document | Purpose |
| --- | --- |
| [Product brief](product-brief.md) | Target users, problem, value proposition, and product boundaries |
| [MVP scope](mvp-scope.md) | Initial commands, workflows, acceptance criteria, and exclusions |
| [Roadmap](roadmap.md) | Proposed delivery stages and release gates |

## Engineering

| Document | Purpose |
| --- | --- |
| [Functional requirements](functional-requirements.md) | Testable MVP behaviors, acceptance scenarios, constraints, and open questions |
| [Architecture](architecture.md) | Module boundaries, data flow, security, performance, and testing |
| [Implementation environment](implementation-environment.md) | Accepted runtimes, toolchain, dependencies, test layers, CI, and packaging baseline |
| [OKF v0.2 compatibility contract](okf-v0.2-contract.md) | The current specification interpretation, including v0.1 fallback behavior |
| [OKF v0.1 compatibility contract](okf-v0.1-contract.md) | Historical compatibility contract for legacy bundles |
| [Agent integration](agent-integration.md) | Safe generation of `AGENTS.md` and Agent Skill templates |

## Release and operations

| Document | Purpose |
| --- | --- |
| [Release checklist](release-checklist.md) | Immutable candidate, approval, publication, verification, and rollback gates |
| [0.4.0 release record](releases/0.4.0.md) | Node 24 release preparation and candidate-specific evidence |
| [0.3.0 release record](releases/0.3.0.md) | Completed signed-tag, publication, artifact, and lifecycle evidence for 0.3.0 |
| [0.2.1 release record](releases/0.2.1.md) | Completed signed-tag, publication, artifact, and lifecycle evidence for 0.2.1 |
| [Open VSX listing draft](open-vsx-listing.md) | Candidate metadata and listing copy for `straydog.okf-workbench` |
| [Compatibility matrix](compatibility-matrix.md) | Exact editor/OS lanes and required retained lifecycle evidence |
| [Acceptance evidence](acceptance-evidence.md) | Component coverage, packaged lifecycle evidence, and remaining scenario gaps |
| [Performance evidence](performance-evidence.md) | Reproducible fixtures, thresholds, and headed-editor measurement authority |
| [Security and privacy evidence](security-privacy-evidence.md) | Technical controls, findings, dependency inventory, and proof gaps |
| [Privacy statement]({{ '/privacy/' | relative_url }}) | User-facing data-processing and network boundary |
| [Support]({{ '/support/' | relative_url }}) | Bug, compatibility, and private vulnerability reporting guidance |
| [Security policy]({{ '/security/' | relative_url }}) | Private vulnerability reporting and disclosure expectations |
| [Changelog](../CHANGELOG.md) | Release-candidate changes and release status |

## Decisions

Accepted decisions are recorded under [decisions/](decisions/):

- [0001 — Build a workbench, not a standalone viewer](decisions/0001-workbench-product-scope.md)
- [0002 — Keep the core deterministic and AI-provider-free](decisions/0002-deterministic-local-first-core.md)
- [0003 — Use 3d-force-graph for the initial 3D renderer](decisions/0003-use-3d-force-graph.md)
- [0004 — Use a single-package npm, TypeScript, and esbuild toolchain](decisions/0004-use-npm-typescript-esbuild-toolchain.md)
- [0005 — Resolve the MVP implementation questions](decisions/0005-resolve-mvp-implementation-questions.md)
- [0006 — Publish Open VSX releases from version tags](decisions/0006-publish-open-vsx-from-version-tags.md)
- [0007 — Adopt a Rust/Wasm shared OKF core and native CLI](decisions/0007-adopt-rust-wasm-shared-core-and-cli.md)
- [0008 — Bundle the native CLI in platform VSIX packages and distribute it separately](decisions/0008-bundle-native-cli-in-platform-vsix.md)
- [0009 — Preview only proposals that may change existing files](decisions/0009-preview-only-existing-file-changes.md)
- [0010 — Support OKF v0.2 with a v0.1 compatibility fallback](decisions/0010-adopt-okf-v0.2-with-v0.1-fallback.md)
- [0011 — Provide explicit assisted v0.2 migration](decisions/0011-explicit-assisted-v0.2-migration.md)
- [0012 — Target Node 24 in the Extension Host](decisions/0012-node24-extension-host.md)

## Documentation rules

- Update the relevant document when a product or architecture decision changes.
- Add an architecture decision record when a choice constrains future implementation.
- Separate facts required by the OKF specification from OKF Workbench product decisions.
- Link to primary specifications rather than copying large portions of them.
