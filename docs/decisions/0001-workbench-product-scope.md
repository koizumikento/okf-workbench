# 0001 — Build a workbench, not a standalone viewer

- Status: Accepted
- Date: 2026-07-22

## Context

The initial concept was a VS Code-compatible extension that renders an OKF bundle as a 3D graph. A viewer assumes that a bundle already exists and is sufficiently well maintained. New users also need initialization, concept templates, validation, and index maintenance.

The canonical OKF repository already demonstrates a graph consumer, and the early ecosystem includes separate CLI and browser tools for validation and visualization. Graph rendering alone is therefore not a strong product boundary.

## Decision

Build OKF Workbench around the full local authoring loop:

```text
initialize -> create -> edit -> validate -> explore -> repair
```

The 3D graph remains a headline feature, but it is one derived view within a broader workbench.

## Consequences

Positive:

- The extension is useful to new and existing OKF users.
- Editor-native navigation differentiates it from external viewers.
- Validation findings and graph exploration share one parser and model.
- The product supports an end-to-end workflow instead of a demonstration.

Costs:

- The MVP contains several commands and needs disciplined scope control.
- Safe file generation and merging require more tests than read-only viewing.
- Documentation must distinguish format requirements from product conventions.
