# ADR 0011 — Provide explicit assisted v0.2 migration

- Status: Accepted
- Date: 2026-07-31
- Issue: STR-241

## Context

ADR 0010 keeps v0.1 bundles usable and forbids implicit rewrites. Users still need a repeatable way
to adopt v0.2 provenance without hand-editing every legacy timestamp or losing free-form Citations.
Some legacy evidence can be converted mechanically; actor identity and ambiguous citation meaning
cannot be inferred safely.

## Decision

Provide an optional migration planner in the shared deterministic core, exposed by
`OKF: Migrate Bundle to v0.2` and `okf migrate`.

- Require a caller-supplied actor in a documented producer convention.
- Convert a valid `timestamp` to `generated.at` only when `generated` is absent.
- Convert only simple URL bullets under `# Citations` into `sources`, retaining the original body.
- Report ambiguous fields and citation forms for manual follow-up without deleting or rewriting
  them.
- Preserve unknown frontmatter and Markdown content.
- Update the root version inside the same complete guarded plan, write that root change last, and
  make subsequent runs empty.
- Preview every extension migration because it updates existing files; keep CLI `--check`
  non-mutating and require explicit `--apply` for non-interactive mutation.
- Never infer verification, computation, execution, receipt, or attestation claims.

## Consequences

Migration remains local, reviewable, and safe for v0.1 bundles with custom metadata. Some documents
will intentionally require manual follow-up rather than a lossy best guess. Native Rust, Wasm, CLI,
and Extension Host tests must retain byte-plan parity, idempotence, and collision/revalidation
coverage.
