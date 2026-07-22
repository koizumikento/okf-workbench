# Privacy statement

- Applies to: OKF Workbench MVP release candidate
- Candidate identifier: `straydog.okf-workbench`
- Last reviewed: 2026-07-22

## Summary

OKF Workbench processes Open Knowledge Format bundles locally in the editor workspace. The
extension has no built-in account, authentication flow, telemetry, analytics, advertising, AI
provider, content upload, synchronization service, or runtime HTTP client.

The extension does not intentionally send bundle content, filenames, frontmatter, links, prompts,
diagnostics, or graph data to the maintainer or to a hosted service.

## Data processed locally

To provide its commands, OKF Workbench reads workspace Markdown and file metadata through VS Code
workspace APIs. It derives, in memory:

- parsed frontmatter and Markdown links;
- conformance and curation findings;
- index and template proposals;
- graph nodes, edges, backlinks, filters, and statistics; and
- a private extension-host mapping from graph node IDs to source document URIs.

Only the serializable graph presentation payload crosses into the Webview. Source URIs and
proposed file contents stay behind the extension-host boundary. The Webview receives locally
packaged scripts and styles and uses a Content Security Policy with network connections disabled.

## Files and retention

When a user confirms an authoring operation, the extension writes the selected bundle, concept,
managed index region, `AGENTS.md` block, or Agent Skill into the workspace. Those files belong to
the user and remain after the extension is disabled or uninstalled.

The extension does not maintain a remote database. Session-scoped bundle selection, graph state,
and in-memory proposals are discarded when the relevant editor or extension-host lifecycle ends.
Editor backups, workspace storage, source control, remote-workspace providers, and filesystem
retention are controlled by the user's editor and environment, not by OKF Workbench.

## Logs and diagnostics

The **OKF Workbench** output channel records operational metadata such as command identifiers,
result categories, revision numbers, concept and finding counts, and error types. It is designed
not to log workspace bodies, proposed content, source URIs, credentials, or secret-bearing fields.

Problems-panel diagnostics identify relevant workspace documents and source ranges because that is
necessary for local navigation. They are managed by the editor and are not uploaded by the
extension.

## Network boundary

Core extension workflows do not require network access. Separate software may make its own
requests, including:

- the editor when checking for extension updates or accessing an extension registry;
- Git, a remote-workspace provider, or filesystem synchronization configured by the user;
- a browser opened by the user from documentation, repository, support, or specification links;
  and
- development tools such as npm, Playwright, VS Code Test, or Open VSX publishing commands.

Those requests are outside the extension's bundle-processing workflow. OKF Workbench does not
embed a CDN or fetch runtime assets from the Webview.

## External agents

`OKF: Set Up Agent Integration` only generates local instructions. It does not install, invoke, or
configure an AI model. If a user later gives workspace access to an external coding agent, that
agent's processing, transmission, and retention practices are governed by the user's chosen agent
and configuration, not by OKF Workbench.

## Verification and changes

The implemented controls and remaining editor-level proof gaps are recorded in
[Security, Privacy, and Dependency Release Evidence](security-privacy-evidence.md). A future
feature that adds telemetry, an account, an AI provider, content upload, or another network
boundary requires an explicit project decision and an updated privacy review before release.

Questions and vulnerability-reporting guidance are in [Support](support.md).
