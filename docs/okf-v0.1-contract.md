# OKF v0.1 compatibility contract

## Authority

The canonical authority is the [Open Knowledge Format v0.1 specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md). This document records how OKF Workbench intends to consume the draft specification; it does not replace it.

## Bundle model

An OKF bundle is a directory tree of UTF-8 Markdown files.

- Every non-reserved `.md` file is a concept.
- A concept ID is its bundle-relative path without `.md`.
- `index.md` and `log.md` are reserved at every directory level.
- A root `index.md` may declare `okf_version: "0.1"`.

## Frontmatter

For concept documents:

- YAML frontmatter is required.
- `type` is the only required frontmatter field.
- `title`, `description`, `resource`, `tags`, and `timestamp` are recommended or optional.
- Producers may add arbitrary fields.
- Consumers must tolerate unknown types and fields.

Workbench implications:

- Validation cannot use a closed enumeration of concept types.
- Write operations must preserve fields they do not understand.
- Templates are authoring presets, not schemas.

## Links

Internal relationships use ordinary Markdown links.

- Bundle-relative links beginning with `/` resolve from the bundle root.
- Relative links resolve from the source document directory.
- A link from concept A to concept B asserts a relationship.
- OKF v0.1 does not give that relationship a machine-readable type.
- Broken links are tolerated by the format.

Workbench implications:

- The graph renders internal links as directed, untyped edges.
- Broken internal links produce curation warnings, not conformance errors.
- Surrounding prose may be shown to a user but is not used to invent a semantic edge type.

## Reserved files

### `index.md`

Indexes support progressive disclosure by listing concepts and subdirectories. The extension may synthesize missing indexes and update explicitly managed content.

### `log.md`

Logs are optional chronological histories with ISO date headings. The MVP validates existing logs but does not automatically maintain them.

## Validation levels

OKF Workbench separates two concerns:

### Conformance

Whether a bundle satisfies the hard interoperability contract of OKF v0.1.

### Curation

Whether a conformant bundle is easy to navigate and maintain. Examples include orphan concepts, missing recommended metadata, duplicate resources, and stale timestamps.

The Problems panel must make this distinction visible through severity and wording.

## Versioning

- The initial implementation targets OKF `0.1` only.
- Unknown future minor versions should trigger an informational compatibility notice and best-effort reading.
- Unsupported major versions should produce a clear warning before any write operation.
- Specification changes must be reviewed against parser, validator, templates, indexes, fixtures, and documentation.
