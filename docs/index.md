# Documentation

This directory is the source of truth for the initial OKF Workbench product and engineering direction.

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
| [Architecture](architecture.md) | Planned modules, data flow, security, performance, and testing |
| [Implementation environment](implementation-environment.md) | Accepted runtimes, toolchain, dependencies, test layers, CI, and packaging baseline |
| [OKF v0.1 compatibility contract](okf-v0.1-contract.md) | The subset and interpretation of the OKF specification the extension must honor |
| [Agent integration](agent-integration.md) | Safe generation of `AGENTS.md` and Agent Skill templates |

## Decisions

Accepted decisions are recorded under [decisions/](decisions/):

- [0001 — Build a workbench, not a standalone viewer](decisions/0001-workbench-product-scope.md)
- [0002 — Keep the core deterministic and AI-provider-free](decisions/0002-deterministic-local-first-core.md)
- [0003 — Use 3d-force-graph for the initial 3D renderer](decisions/0003-use-3d-force-graph.md)
- [0004 — Use a single-package npm, TypeScript, and esbuild toolchain](decisions/0004-use-npm-typescript-esbuild-toolchain.md)

## Documentation rules

- Update the relevant document when a product or architecture decision changes.
- Add an architecture decision record when a choice constrains future implementation.
- Separate facts required by the OKF specification from OKF Workbench product decisions.
- Link to primary specifications rather than copying large portions of them.
