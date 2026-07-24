# Agent integration

## Decision

OKF Workbench does not embed an AI model or call an AI provider. It helps existing coding agents use the bundle by generating portable project instructions.

## Supported outputs

### `AGENTS.md` section

`AGENTS.md` contains concise, always-applicable repository guidance:

```markdown
<!-- okf-workbench:start -->
## OKF knowledge

- The OKF bundle is located at `knowledge/`.
- Read `knowledge/index.md` before tasks that require project-wide context.
- Update the relevant concept when a change affects durable project knowledge.
- Preserve unknown YAML frontmatter fields.
- Use bundle-relative Markdown links between concepts.
- Do not add speculative or temporary information to the bundle.
<!-- okf-workbench:end -->
```

The actual bundle path replaces `knowledge/`.

The location comes from the selected workspace provider, not from re-parsing a generated path as
user input. Legal provider segment identities such as `docs:knowledge`, literal `%2F`, spaces, and
Unicode are retained exactly in both generated outputs. The provider-safe branch still rejects an
empty path, control characters, absolute paths, non-POSIX separators, and empty, `.` or `..`
segments. Plain string inputs to the template API continue through the stricter user-input path
normalizer, including stable percent decoding and URI-like path rejection.

When the selected OKF bundle is also the workspace root, the generated root `AGENTS.md` remains
repository control metadata and is excluded from OKF concept parsing, validation, indexing, and the
graph. A nested `AGENTS.md` elsewhere in the bundle remains an ordinary concept candidate.

### Agent Skill

The default project-local path is:

```text
.agents/skills/maintain-okf-knowledge/SKILL.md
```

Every `.agents/` subtree is excluded from OKF bundle traversal. This prevents a generated Skill
from becoming a concept or conformance finding when the selected bundle occupies the workspace
root, and avoids charging excluded Skill content against OKF document limits.

The generated frontmatter is compatible with the Agent Skills specification:

```markdown
---
name: maintain-okf-knowledge
description: Maintain this repository's OKF knowledge bundle. Use when creating or updating durable project knowledge, recording decisions, repairing links, regenerating indexes, or reviewing knowledge quality.
---
```

The body covers:

- Finding and reading the bundle index.
- Reusing an existing concept before creating a duplicate.
- Required and optional frontmatter.
- Link and concept ID rules.
- Timestamp discipline.
- Index regeneration.
- Conformance and curation checks.

## Safe merge behavior

### Existing `AGENTS.md`

- If no managed block exists, append one after a preview.
- If one managed block exists, update only that block.
- If markers are malformed or duplicated, refuse automatic modification and explain how to repair them.
- Preserve all unrelated content byte-for-byte where practical.

### Existing Skill

- Never overwrite silently.
- Show the existing and proposed paths.
- Offer cancel, preview diff, or explicit replacement.
- Do not modify other skills.

## Why two files

- `AGENTS.md` states the repository-wide policy and bundle location.
- `SKILL.md` contains the task-specific workflow and is loaded on demand by compatible agents.

Keeping the `AGENTS.md` section short avoids permanent context overhead, while the Skill can provide enough detail for reliable OKF maintenance.

## Out of scope

- Provider-specific prompts as the only supported integration.
- API keys, model configuration, or authentication.
- Automatic agent execution.
- Generated scripts with broad file or shell permissions.
- An instruction that requires agents to update knowledge on every code change.
