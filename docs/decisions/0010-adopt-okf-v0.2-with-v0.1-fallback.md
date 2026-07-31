# ADR 0010 — Adopt OKF v0.2 with v0.1 fallback

- Status: Accepted
- Date: 2026-07-31
- Issue: STR-240

## Context

The upstream Open Knowledge Format specification now identifies itself as v0.2. The new revision
retains the permissive Markdown bundle model while adding conventional provenance, generation,
verification, lifecycle, and Attested Computation metadata. Existing Workbench users may still
have bundles declaring v0.1, and an editor upgrade must not make those bundles unreadable or
silently rewrite their declared version.

The current local-first, deterministic, unknown-field-preserving safety boundary remains required.
In particular, producer-supplied computation, executor, and attester references cannot acquire
filesystem, network, editor, or execution capabilities merely because the format can describe
them.

## Decision

Adopt the upstream OKF v0.2 specification pinned at
`3fcbb9f828c2f23d109c855ee403c3a4c81f3a96` as the current format authority.

- New bundle and synthesized root-index output declares `okf_version: "0.2"`.
- Declared v0.1 and v0.2 bundles remain supported for reading and guarded authoring.
- Workbench does not rewrite an existing v0.1 declaration as an implicit migration.
- The shared model normalizes the v0.2 provenance, generation, verification, lifecycle, and
  computation families while preserving the complete unknown frontmatter map.
- `generated.at` supersedes the legacy `timestamp`; the latter is consulted only when `generated`
  is absent.
- Verification actors derive a presentation trust tier without turning trust into a conformance
  requirement.
- Malformed optional v0.2 families remain curation findings rather than conformance errors.
- Attested Computation references remain inert data. Execution, fetching, receipt/verdict
  protocols, and sandboxing require a later accepted design.

The detailed compatibility interpretation is recorded in
[the OKF v0.2 contract](../okf-v0.2-contract.md). ADR 0010 supersedes the v0.1 authority portions of
ADR 0005 and ADR 0007; their implementation and release decisions remain in force.

## Consequences

Positive:

- Newly generated bundles follow the current upstream specification.
- Existing v0.1 bundles remain usable without a forced migration.
- Graph details and diagnostics can expose current provenance, trust, lifecycle, and computation
  context while Markdown remains the source of truth.
- The extension and CLI retain one Rust/Wasm interpretation of both supported declarations.

Costs:

- Fixtures and parity tests must cover v0.1 fallback as well as v0.2 metadata.
- Additive graph payload fields must remain bounded and protocol-decoded.
- Future executable Attested Computation support cannot reuse this parsing decision as authority;
  it requires an explicit capability and security design.
