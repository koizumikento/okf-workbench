# Preserved local predecessor-candidate compatibility evidence

The hosted final candidate is the `581860`-byte VSIX from commit
`b0848e2c68ff28f1c12e1b9927d01a54c79542b5`, SHA-256
`b9125e6b56ce73de1e2ade10626f410f103ed7e421aa1b5d28cf0b565b2a36dd`. It
passed every required editor/OS lifecycle lane in
[Compatibility run 29899159887](https://github.com/koizumikento/okf-workbench/actions/runs/29899159887),
and its CI qualification passed in
[CI run 29899142563](https://github.com/koizumikento/okf-workbench/actions/runs/29899142563).
The JSON files in this directory predate that candidate and are retained only
as local audit evidence; they must not be attributed to the hosted candidate.

These sanitized records were generated on 2026-07-22 from the same normalized
`straydog.okf-workbench@0.1.0` VSIX built from commit
`524eca3f36e1a1b3da935495d3fbbd0eb0d03f56`. The artifact is `581830` bytes and
has SHA-256 `65c137822052aa7f90ef08cc1300020fec4adcd7cbcec6aec88ae98fae64dad0`.
The records contain no absolute local path, workspace content, credential, or
secret.

All three macOS arm64 primary records have `status: "passed"`. They prove
clean-profile installation, packaged Extension Host activation, registration of
the six stable commands, execution of the read-only Validate Bundle and Open 3D
Graph commands, zero transport attempts from the guarded extension host,
read-only operation in an untrusted workspace with early refusal of Initialize
Bundle, a real `0.0.0` to `0.1.0` VSIX upgrade with its user-setting sentinel
preserved, uninstall, and preservation of the five-file test workspace.

Each primary record names three activation reports and three uninstall reports
for its clean, untrusted, and upgrade profiles. The directory therefore retains
18 auxiliary reports in addition to the three primary lane records. After each
uninstall, both the editor extension list and Extension API reported the
extension absent. The editors retained one or more physical extension
directories in some profiles; the evidence records that editor-native residue
before a harness cleanup that removes only a direct, non-symlink directory whose
package identity and versioned directory name match the tested extension.

The predecessor is a repository-owned test package, not a published release.
It uses the same extension identifier and a fixed `SOURCE_DATE_EPOCH`; two
independent builds were byte-identical at SHA-256
`7ca5f437fb846f636b51b933b53a55f57b229018bf17958781a661c8be6e6567`.

Every checked-in primary record has
`repositoryRevision: "524eca3f36e1a1b3da935495d3fbbd0eb0d03f56"` and the same
predecessor-candidate digest above. These local files must not be used as
cross-platform evidence; the hosted workflow and its per-lane artifacts are the
cross-platform evidence for the final candidate.
