# 0009 — Preview only proposals that may change existing files

- Status: Accepted
- Date: 2026-07-27

## Context

The initial authoring workflow previewed every proposal, including operations whose only possible
successful result was creation of absent files. Initialize Bundle, New Concept, missing-index
generation, and new Agent Integration outputs therefore required an extra Apply action after the
user had already supplied every input. The workspace adapter already provides an explicit
absent-target precondition and uses VS Code's provider-neutral no-overwrite create primitive.

The additional confirmation did not authorize replacement: a collision was refused before preview
and remained forbidden during application. It added friction without expanding the permitted write.

## Decision

- Apply a proposal without preview or confirmation only when every change has operation `create`
  and expected state `absent`.
- If any change updates or replaces an existing file, preview the complete proposal and require
  explicit approval. Do not split a mixed proposal into approved and unapproved subsets.
- Retain the same pure feasibility limits, complete target preflight, Workspace Trust check,
  workspace-folder membership authorization, bundle compatibility recheck, parent-path safety, and
  post-write verification for both flows.
- Recheck absence during application and use `WorkspaceEdit.createFile` with both overwrite and
  ignore-if-exists disabled. If a provider cannot enforce no-overwrite creation, fail closed.
- Treat bundle selection and editor navigation after a successful create as best-effort follow-up
  work that does not retain the write-command lease.

## Consequences

- Initialize Bundle and New Concept normally complete after their final input without an Apply
  prompt.
- Regenerate Indexes and Set Up Agent Integration skip preview only when their realized proposals
  contain new files exclusively.
- An initial or racing collision never overwrites the existing target and produces actionable
  guidance to choose another destination or filename.
- Pending-review recovery remains available only for proposals that actually opened a preview.
