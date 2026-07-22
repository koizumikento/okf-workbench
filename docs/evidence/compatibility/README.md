# Local compatibility evidence

These sanitized records were generated on 2026-07-22 from the same normalized
`straydog.okf-workbench@0.1.0` VSIX with SHA-256
`8a0c870def44844ea8c6f128cd975b2178a71f6d1c82917054360d0ad24450d3`.
They contain no absolute local path, workspace content, credential, or secret.

All three macOS arm64 records prove clean-profile installation, packaged
Extension Host activation, registration of the six stable commands, execution
of the read-only Validate Bundle and Open 3D Graph commands, zero transport
attempts from the guarded extension host, a real `0.0.0` to `0.1.0` VSIX
upgrade, uninstall, and preservation of the five-file test workspace.

The predecessor is a repository-owned test package, not a published release.
It uses the same extension identifier and a fixed `SOURCE_DATE_EPOCH`; two
independent builds were byte-identical at SHA-256
`7ca5f437fb846f636b51b933b53a55f57b229018bf17958781a661c8be6e6567`.

The records have `repositoryRevision: null` because they were captured from the
pre-commit working tree. Their candidate digest binds them to the tested VSIX.
Ubuntu and Windows remain pending until the hosted compatibility workflow runs;
these local files must not be used as cross-platform evidence.
