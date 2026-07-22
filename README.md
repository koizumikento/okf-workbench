# OKF Workbench

Create, validate, and explore Open Knowledge Format bundles in VS Code-compatible editors.

> Status: product definition and architecture planning. Implementation has not started yet.

OKF Workbench is a planned local-first editor extension for working with [Open Knowledge Format (OKF) v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) bundles. It covers the complete authoring loop rather than acting only as a graph viewer:

```text
initialize -> create -> edit -> validate -> explore -> repair
```

## Planned MVP

- Initialize a conformant OKF bundle from a small set of starter templates.
- Create concept files from editable knowledge templates.
- Validate conformance and report curation warnings in the Problems panel.
- Regenerate `index.md` files with a preview before writing.
- Explore concepts and links in an interactive 3D graph.
- Open source Markdown directly from graph nodes and diagnostics.
- Generate lightweight `AGENTS.md` and Agent Skill integration templates.
- Operate locally without an AI provider, account, or remote service.

## Product principles

1. **Local first** — bundle contents do not leave the workspace.
2. **Format faithful** — unknown concept types and frontmatter fields remain valid.
3. **Source oriented** — every visualization and diagnostic leads back to Markdown.
4. **Deterministic core** — initialization, parsing, validation, and generation do not depend on an LLM.
5. **Portable extension** — prefer VS Code APIs that work across compatible desktop, remote, and virtual workspaces.

## Documentation

- [Documentation index](docs/index.md)
- [Product brief](docs/product-brief.md)
- [MVP scope](docs/mvp-scope.md)
- [Architecture](docs/architecture.md)
- [OKF v0.1 compatibility contract](docs/okf-v0.1-contract.md)
- [Agent integration](docs/agent-integration.md)
- [Roadmap](docs/roadmap.md)
- [Architecture decisions](docs/decisions/)

## References

- [Open Knowledge Format v0.1 specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
- [Google Cloud announcement](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing)
- [VS Code Extension API](https://code.visualstudio.com/api)
- [Open VSX Registry](https://open-vsx.org/)
- [AGENTS.md](https://agents.md/)
- [Agent Skills specification](https://agentskills.io/specification)
