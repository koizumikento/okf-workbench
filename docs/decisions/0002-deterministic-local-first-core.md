# 0002 — Keep the core deterministic and AI-provider-free

- Status: Accepted
- Date: 2026-07-22

## Context

OKF is intended for both humans and agents, but initialization, parsing, validation, indexing, and graph construction do not require a language model. Adding a provider would introduce authentication, cost, network access, privacy concerns, and non-deterministic behavior before the core workflow is proven.

Coding agents can already consume repository instructions through `AGENTS.md` and portable Agent Skills.

## Decision

- Do not embed an AI provider in the MVP.
- Do not require an account, API key, or network request for core features.
- Implement parsing, validation, generation, and graph construction deterministically.
- Support external agents by generating a concise `AGENTS.md` section and an optional project-local Agent Skill.

## Consequences

Positive:

- The extension can operate on sensitive bundles without uploading content.
- Tests can assert exact outcomes.
- Open VSX users are not tied to a specific model vendor.
- Installation and onboarding remain lightweight.

Costs:

- Semantic enrichment and relationship inference are not included.
- Users who want generated knowledge must use a separate agent or tool.
- Agent templates need careful wording and safe merge behavior.
