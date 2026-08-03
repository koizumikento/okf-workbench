# OKF v0.2 compatibility contract

## Authority

The canonical authority is the [Open Knowledge Format v0.2 specification at
`3fcbb9f828c2f23d109c855ee403c3a4c81f3a96`](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/3fcbb9f828c2f23d109c855ee403c3a4c81f3a96/okf/SPEC.md),
observed on 2026-07-31. This document records how OKF Workbench consumes that specification; it
does not replace it. The former [v0.1 contract](okf-v0.1-contract.md) remains the historical record
for legacy bundles.

## Compatibility boundary

- New Workbench bundles declare `okf_version: "0.2"`.
- Declared `0.1` and `0.2` bundles are supported for reading and guarded authoring.
- A later `0.x` declaration receives an informational best-effort compatibility notice.
- Unsupported major, malformed, and non-string declarations remain selectable for validation and
  graph inspection, but existing-bundle writes fail closed.
- A missing root index or absent declaration remains eligible for best-effort authoring. Index
  synthesis adds `okf_version: "0.2"` while preserving unrelated root content.
- Workbench never rewrites an existing `0.1` declaration merely because it can read v0.2.

## Bundle and concept model

The v0.1 bundle structure remains in force: UTF-8 Markdown, reserved `index.md` and `log.md`, POSIX
concept IDs, required concept frontmatter, arbitrary non-empty `type`, and directed untyped
Markdown links. Broken links, unknown types, unknown fields, and missing optional metadata do not
make a bundle non-conformant.

The pinned specification says every other `.md` file is a concept. Workbench deliberately excludes
the root `AGENTS.md` and every `.agents/` subtree from automatic bundle discovery because its agent
integration writes project-control metadata there; a nested `AGENTS.md` outside `.agents/` remains
a concept. This is a Workbench inventory deviation, not an additional OKF reserved-filename rule:
other consumers may treat those files as concepts, and Workbench does not claim conformance
coverage for content hidden by the exclusion.

Workbench preserves the complete JSON-safe frontmatter map and normalizes these v0.2 families:

- provenance: `sources` and `usage_window`;
- production and verification: `generated` and bare- or list-form `verified`;
- lifecycle: `status` and `stale_after`;
- computation contracts: `runtime`, `parameters`, `computation`, `executor`, and `attester`.

A bare `verified` mapping is normalized as one event. Actors in `generated.by` and `verified.by`
use `human:<id>`, `process:<id>`, or `<producer>/<version>` with non-empty ASCII token segments and
a maximum length of 256 characters. The pinned specification also describes `sources.author` as an
actor but demonstrates `team:ga4-docs`, which is outside that three-form grammar. Workbench accepts
that `team:<id>` source-author form under the same bounded token envelope so the canonical example
remains consumable; this compatibility interpretation applies only to source credibility metadata
and never elevates a verification trust tier. Trust tier is derived only from valid verifier actors:
no valid actor is `unverified`, a valid non-`human:` actor is `machine-confirmed`, and any valid
`human:` actor is `human-reviewed`.

`generated.at` is the current content-change time. A legacy `timestamp` remains normalized for v0.1
interoperability and is used as a fallback only when `generated` is absent. Templates that receive
an injected time render:

```yaml
generated:
  by: "process:okf-workbench"
  at: "<explicit-zone ISO 8601 date-time>"
```

They do not emit a new legacy `timestamp`.

## Validation

The hard conformance boundary remains deliberately small:

- every concept has parseable YAML frontmatter;
- `type` is a non-empty string;
- present reserved documents follow their structural rules.

Optional v0.2 family problems are curation warnings, never conformance errors. Workbench reports
malformed `generated`, `verified`, `status`, `stale_after`, `sources`, `usage_window`, source
credibility signals, and Attested Computation contracts; future generation or verification times;
and concepts that have reached `stale_after`. Absence of any optional family is valid.

Diagnostics continue to distinguish conformance, curation, and compatibility. Unknown producer
fields and types remain accepted and preserved.

## Attested Computation

`Attested Computation` is an open concept type with additional conventional contract fields.
Workbench normalizes and displays the contract and provides an authoring template with a visible
runtime placeholder and `# Computation` section.

When present, a computation contract is curated for a non-empty runtime, typed parameters, either a
file path or a fenced computation under `# Computation`, and well-formed executor and attester
resource mappings.

Workbench does not execute `computation`, `executor`, or `attester` resources. Execution,
receipt/verdict protocols, sandboxing, and attester portability remain outside the local
deterministic core and require a separate accepted design before becoming product capabilities.

## Presentation

The graph remains a derived read-only view. Concept details may show generator, generation time,
derived trust tier, lifecycle status, stale date, source count, runtime, and computation path. The
main graph still contains only concept nodes and directed Markdown-link edges; provenance and
computation fields do not create invented semantic edges.

## Safety invariants

The v0.2 migration does not change the local-first boundary, URI-first workspace access, guarded
proposal workflow, source-preserving merge rules, restrictive Webview CSP, or no-network/no-AI
core behavior.
