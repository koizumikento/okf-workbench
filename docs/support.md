---
layout: default
title: Support
description: How to report OKF Workbench bugs, compatibility problems, and security vulnerabilities.
permalink: /support/
---

OKF Workbench is a release-candidate project without a support SLA. Before reporting a problem,
check the [MVP scope](https://github.com/koizumikento/okf-workbench/blob/main/docs/mvp-scope.md),
[compatibility matrix](https://github.com/koizumikento/okf-workbench/blob/main/docs/compatibility-matrix.md),
and [known release evidence](https://github.com/koizumikento/okf-workbench/blob/main/docs/acceptance-evidence.md).

## Bugs and feature requests

Use the [GitHub issue tracker](https://github.com/koizumikento/okf-workbench/issues) for
reproducible bugs and scoped feature requests.

Include:

- OKF Workbench version and installation source;
- editor name, exact version, operating system, and architecture;
- workspace scheme (`file`, remote, or virtual provider) and workspace-trust state;
- the command used and expected versus observed behavior;
- relevant **OKF Workbench** output-channel metadata; and
- the smallest sanitized bundle or reproduction that demonstrates the problem.

Do not attach proprietary bundle content, credentials, API keys, personal data, or complete editor
logs without reviewing and redacting them first. A minimal synthetic reproduction is preferred.

## Security vulnerabilities

Do not disclose an unpatched vulnerability or sensitive reproduction in a public issue. Follow the
[Security policy]({{ '/security/' | relative_url }}) and use GitHub's private vulnerability
reporting entry on the repository **Security** tab.

Issues in the public Open VSX registry itself should follow the
[Open VSX security policy](https://researcher-recognition.open-vsx.org/open-vsx-security-policy/),
not this repository's general issue tracker.

## Compatibility reports

The package manifest declares VS Code API floor `^1.121.0`, but support claims require retained
evidence from the exact [compatibility matrix](https://github.com/koizumikento/okf-workbench/blob/main/docs/compatibility-matrix.md).
When reporting a compatibility problem, include the editor-reported Electron, Chromium, and Node
versions when available. Do not infer support from a package-only build or a configured CI lane.


## Troubleshooting

1. Confirm the workspace contains a root `index.md` with `okf_version: "0.2"` or the supported
   legacy declaration `okf_version: "0.1"`.
2. Run `OKF: Validate Bundle` and review the OKF diagnostic collections in Problems.
3. Open **View: Output**, select **OKF Workbench**, and inspect the non-content operational events.
4. Retry after confirming workspace availability, permissions, and trust state.
5. For a graph problem, close a stale graph tab and run `OKF: Open 3D Graph` again.

Generated bundle and instruction files are user data. Disabling or uninstalling OKF Workbench does
not remove them.
