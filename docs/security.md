---
layout: default
title: Security policy
description: How to report a vulnerability in OKF Workbench without exposing users or sensitive data.
permalink: /security/
---

## Reporting a vulnerability

Do not open a public issue for an unpatched vulnerability, exploit details, credentials, private
bundle content, or another sensitive reproduction.

Use
[GitHub private vulnerability reporting](https://github.com/koizumikento/okf-workbench/security/advisories/new)
to send the affected version, impact, reproduction conditions, and the smallest sanitized evidence
needed to understand the report. Do not include real workspace secrets or proprietary knowledge
bundles.

If private vulnerability reporting is temporarily unavailable, contact the repository owner
through GitHub to request a private channel. Do not include exploit details in that initial
message.

## Response expectations

OKF Workbench is maintained without a security response SLA. Reports will be assessed according to
their likely impact on workspace confidentiality, integrity, extension-host privileges, generated
file safety, Webview isolation, and distribution integrity.

The maintainer may request a reduced reproduction, coordinate a fix and disclosure date, or close a
report that is outside the extension's boundary. Please allow time for a fix to be prepared and
distributed before public disclosure.

## Scope

Examples of in-scope reports include:

- workspace content or credentials leaving the documented local processing boundary;
- unsafe file writes, path traversal, or silent overwrite behavior;
- script execution or privilege crossing through OKF content or the 3D Webview;
- extension-to-Webview message validation failures with a concrete security impact; and
- tampering or credential exposure in the project's build and release path.

Open VSX service vulnerabilities belong to the
[Open VSX security program](https://researcher-recognition.open-vsx.org/open-vsx-security-policy/).
Vulnerabilities in VS Code, VSCodium, Git, remote-workspace providers, external agents, or other
software should be reported to their respective maintainers.

## Supported versions

Before the first public Open VSX release, only the current `main` release candidate is assessed.
After publication, this section will identify supported release lines explicitly.
