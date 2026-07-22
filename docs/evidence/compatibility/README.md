# Preserved local predecessor-candidate compatibility evidence

The hosted final candidate is the `582231`-byte VSIX from commit
`aa90832aab64dac1bccf9c9092fabc004991f7b1`, SHA-256
`cc8c994cd35cfe2017945c38d0019f330cb33f628a94bf6508b2930c5c57c866`. It
passed every required editor/OS lifecycle lane in
[Compatibility run 29900868002](https://github.com/koizumikento/okf-workbench/actions/runs/29900868002),
and its CI qualification passed in
[CI run 29900857588](https://github.com/koizumikento/okf-workbench/actions/runs/29900857588).
The macOS, Ubuntu, and Windows jobs in
[Package smoke run 29900868155](https://github.com/koizumikento/okf-workbench/actions/runs/29900868155)
independently reproduced that exact digest and size. The later workflow-only
commit `6505a7f7b017a44a851ab6edaaba28f6b6a72105` adds an aggregate byte-identity
gate without changing packaged content. At that revision,
[CI run 29901152549](https://github.com/koizumikento/okf-workbench/actions/runs/29901152549)
passed all four jobs and
[Package smoke run 29901183164](https://github.com/koizumikento/okf-workbench/actions/runs/29901183164)
passed all three OS jobs plus the aggregate comparison of the three artifacts.
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
