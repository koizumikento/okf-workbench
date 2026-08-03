# Canonical OKF fixtures

These fixtures are small, checked-in inputs for the current OKF v0.2 compatibility contract and
its v0.1 fallback behavior. They are
consumed as bytes and never require VS Code, a network connection, or an AI provider.

Every fixture directory contains `expected.json` with:

- the physical and virtual files that belong to the bundle;
- the complete expected concept IDs, reserved files, and parse failures;
- the complete ordered conformance, curation, and compatibility findings using implementation codes;
- every parsed Markdown link with its classification and resolved concept ID when applicable;
- fixture-specific link, frontmatter, or path expectations.

The manifest schema is decoded strictly. Unit tests feed every declared file to the real core parser
as bytes, validate the resulting bundle at a fixed reference time, and compare the projected result
to `expected` exactly. Missing expected fields, extra schema keys, stale finding codes, changed link
classifications, or parser/validator drift fail the corpus contract.

`invalid-documents/expected.json` describes invalid UTF-8 as an octet array because Git cannot
portably review malformed text. The fixture helper materializes those bytes as `invalid-utf8.md`.
Its invalid UTF-8 and YAML files remain in the concept inventory as safe partial concepts while
their source-scoped parse failures remain the sole diagnostics for those files. Windows separator
inputs are data in `path-portability/expected.json`, not host-dependent paths.

| Fixture | Contract coverage |
| --- | --- |
| `minimal-valid` | Smallest conformant bundle |
| `nested-links` | Nested reserved documents, relative and bundle-relative links |
| `broken-links` | Broken, external, and out-of-bundle targets |
| `custom-metadata` | Arbitrary type and exact unknown-field preservation input |
| `invalid-documents` | Invalid YAML, missing type, invalid UTF-8, and unaffected valid input |
| `curation` | Duplicate resources, missing recommendations, and orphan concepts |
| `reserved-documents` | `index.md` and `log.md` at multiple levels |
| `path-portability` | Spaces, Unicode, nested directories, and Windows separator cases |

Finding codes in these manifests are the complete `okf.*` implementation codes. They do not change
conformance into curation or vice versa; the contract compares both `category` and `code`.
