# 0003 — Use 3d-force-graph for the initial 3D renderer

- Status: Accepted
- Date: 2026-07-22

## Context

OKF Workbench needs an interactive 3D view for directed concept graphs inside a VS Code Webview. The renderer must support local bundling, node and edge interaction, source navigation, dynamic data updates, and representative performance testing without coupling the OKF model to a presentation library.

The main alternatives considered were:

- [`3d-force-graph`](https://github.com/vasturiano/3d-force-graph), a ready-to-use Three.js/WebGL graph component.
- [`three-forcegraph`](https://github.com/vasturiano/three-forcegraph), a lower-level Three.js graph object requiring more scene and render-loop management.
- Direct [`Three.js`](https://github.com/mrdoob/three.js) and [`d3-force-3d`](https://github.com/vasturiano/d3-force-3d) integration, offering maximum control at greater implementation cost.
- `react-force-graph-3d`, which would add value only if the Webview were already committed to React.

## Decision

- Use the standalone `3d-force-graph` package for the initial 3D renderer.
- Do not introduce React solely for graph rendering.
- Place the library behind a repository-owned renderer adapter so the serializable graph model and Webview message contract do not depend on library-specific node or link types.
- Bundle the renderer and its assets locally with the extension; do not load runtime code from a CDN.
- Start with simple node geometry, directed links, selection, search-driven focus, and source navigation. Avoid always-visible labels and decorative link animation by default.
- Treat the provisional target of 1,000 concepts and 5,000 edges as unverified until measured in the VS Code Webview. Compare the available force engines with representative fixtures before declaring the target achieved.
- Reconsider the renderer only if profiling, accessibility needs, or required interaction behavior cannot be addressed through the adapter without excessive customization.

This decision selects the library family, not a permanently pinned package version. Dependency versions and license metadata will be locked and reviewed when implementation begins.

## Consequences

Positive:

- Camera controls, force layout, picking, directional links, and dynamic graph updates are available without building a rendering engine from scratch.
- The MVP can focus on OKF parsing, validation, navigation, and useful graph interactions.
- The adapter preserves a path to direct Three.js rendering or an additional 2D renderer later.
- The standalone package avoids making React an architectural dependency.

Costs:

- Webview bundle size and transitive Three.js behavior must be measured.
- Large-graph performance remains a prototype question rather than a guaranteed capability.
- Library-specific lifecycle, disposal, and Electron/WebGL behavior require integration tests.
- The spatial canvas cannot be the only navigation mechanism; an accessible searchable node list remains necessary.
