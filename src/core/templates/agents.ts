import type { OperationProblem, OperationResult } from '../model/index.js';
import { mergeManagedRegion } from '../indexes/index.js';
import {
  normalizeBundleDirectory,
  preserveProviderBundleDirectory,
  type BundleDirectoryInput,
} from './path.js';

export const AGENTS_START_MARKER = '<!-- okf-workbench:start -->';
export const AGENTS_END_MARKER = '<!-- okf-workbench:end -->';
export const AGENT_SKILL_PATH = '.agents/skills/maintain-okf-knowledge/SKILL.md';

export type AgentIntegrationSelection = 'agents-md' | 'agent-skill' | 'both';

export interface AgentsFilePlanInput {
  readonly bundlePath: BundleDirectoryInput;
  /** Omit when AGENTS.md does not exist; pass an empty string for an empty existing file. */
  readonly existingText?: string;
}

export interface AgentsFilePlan {
  readonly relativePath: 'AGENTS.md';
  readonly status: 'create' | 'update' | 'unchanged';
  readonly proposedText: string;
  readonly previousText?: string;
}

export interface AgentSkillPlanInput {
  readonly bundlePath: BundleDirectoryInput;
  /** Omit when the Skill does not exist. */
  readonly existingText?: string;
  /** Must be true before a differing existing Skill receives a replace proposal. */
  readonly confirmReplacement?: boolean;
}

export interface AgentSkillPlan {
  readonly relativePath: typeof AGENT_SKILL_PATH;
  readonly status: 'create' | 'replace' | 'unchanged' | 'replacement-required';
  readonly proposedText: string;
  readonly previousText?: string;
}

export interface AgentIntegrationPlanInput {
  readonly selection: AgentIntegrationSelection;
  readonly bundlePath: BundleDirectoryInput;
  readonly existingAgentsText?: string;
  readonly existingSkillText?: string;
  readonly confirmSkillReplacement?: boolean;
}

export interface AgentIntegrationPlan {
  readonly selection: AgentIntegrationSelection;
  readonly agentsFile?: AgentsFilePlan;
  readonly agentSkill?: AgentSkillPlan;
  readonly readyToApply: boolean;
}

function failure(code: string, message: string, correctiveAction: string): OperationResult<never> {
  const item: OperationProblem = { code, message, correctiveAction };
  return { ok: false, problems: [item] };
}

function maxBacktickRun(value: string): number {
  let maximum = 0;
  for (const match of value.matchAll(/`+/gu)) {
    maximum = Math.max(maximum, match[0].length);
  }
  return maximum;
}

function inlineCode(value: string): string {
  const delimiter = '`'.repeat(Math.max(1, maxBacktickRun(value) + 1));
  const pad =
    value.startsWith('`') || value.endsWith('`') || value.startsWith(' ') || value.endsWith(' ');
  return `${delimiter}${pad ? ' ' : ''}${value}${pad ? ' ' : ''}${delimiter}`;
}

function normalizedBundlePath(input: BundleDirectoryInput): OperationResult<string> {
  let relativePath: string;
  if (typeof input === 'string') {
    const normalized = normalizeBundleDirectory(input);
    if (!normalized.ok) {
      return normalized;
    }
    relativePath = normalized.value;
  } else {
    const preserved = preserveProviderBundleDirectory(input.relativePath);
    if (!preserved.ok) {
      return preserved;
    }
    relativePath = preserved.value.relativePath;
  }

  return {
    ok: true,
    value: relativePath === '.' ? './' : `${relativePath}/`,
    warnings: [],
  };
}

/** Renders the exact concise repository guidance documented in docs/agent-integration.md. */
export function renderAgentsManagedBlock(
  bundlePath: BundleDirectoryInput,
): OperationResult<string> {
  const path = normalizedBundlePath(bundlePath);
  if (!path.ok) {
    return path;
  }

  const bundle = inlineCode(path.value);
  const index = inlineCode(`${path.value}index.md`);
  const lines = [
    AGENTS_START_MARKER,
    '## OKF knowledge',
    '',
    `- The OKF bundle is located at ${bundle}.`,
    `- Read ${index} before tasks that require project-wide context.`,
    '- Update the relevant concept when a change affects durable project knowledge.',
    '- When an `okf` executable is available for a local bundle, prefer it for validation, new-concept planning, and managed-index updates; review `--check` output before `--apply`.',
    '- Preserve unknown YAML frontmatter fields.',
    '- Use bundle-relative Markdown links between concepts.',
    '- Do not add speculative or temporary information to the bundle.',
    AGENTS_END_MARKER,
  ];
  return { ok: true, value: `${lines.join('\n')}\n`, warnings: [] };
}

export function planAgentsFile(input: AgentsFilePlanInput): OperationResult<AgentsFilePlan> {
  const block = renderAgentsManagedBlock(input.bundlePath);
  if (!block.ok) {
    return block;
  }

  if (input.existingText === undefined) {
    return {
      ok: true,
      value: { relativePath: 'AGENTS.md', status: 'create', proposedText: block.value },
      warnings: [],
    };
  }

  const merged = mergeManagedRegion({
    existingText: input.existingText,
    renderedRegion: block.value,
    markers: {
      start: AGENTS_START_MARKER,
      end: AGENTS_END_MARKER,
      name: 'AGENTS.md OKF guidance',
    },
    appendWhenMissing: true,
  });
  if (!merged.ok) {
    return merged;
  }

  return {
    ok: true,
    value: {
      relativePath: 'AGENTS.md',
      status: merged.value === input.existingText ? 'unchanged' : 'update',
      proposedText: merged.value,
      previousText: input.existingText,
    },
    warnings: [],
  };
}

export function renderAgentSkill(bundlePath: BundleDirectoryInput): OperationResult<string> {
  const path = normalizedBundlePath(bundlePath);
  if (!path.ok) {
    return path;
  }

  const bundle = inlineCode(path.value);
  const index = inlineCode(`${path.value}index.md`);
  const lines = [
    '---',
    'name: maintain-okf-knowledge',
    "description: Maintain this repository's OKF knowledge bundle. Use when creating or updating durable project knowledge, recording decisions, repairing links, regenerating indexes, or reviewing knowledge quality.",
    '---',
    '',
    '# Maintain OKF knowledge',
    '',
    `The repository's OKF bundle is located at ${bundle}.`,
    '',
    '## Workflow',
    '',
    `1. Read ${index} and follow its links before changing durable project knowledge.`,
    '2. Search for an existing concept and update it instead of creating a duplicate.',
    '3. Create a new concept only when no existing concept has the same durable purpose.',
    '4. Add bundle-relative Markdown links to related concepts.',
    '5. Regenerate managed indexes and run both conformance and curation checks.',
    '',
    '## CLI-assisted workflow',
    '',
    "The `okf` CLI is optional. Prefer it when an `okf` executable is available in the agent's terminal and the bundle has a local filesystem path. Otherwise use OKF Workbench editor commands and follow the document rules below.",
    '',
    `Replace \`<bundle-root>\` with a correctly shell-quoted local path for the bundle at ${bundle}.`,
    '',
    '```text',
    'okf validate <bundle-root> --format json',
    'okf new <bundle-root> --template decision --title "<title>" --check',
    'okf index <bundle-root> --mode missing --check',
    '```',
    '',
    'Inspect every reported path and change before rerunning a write command with `--apply` instead of `--check`. Edit existing concept Markdown directly while preserving unknown frontmatter.',
    '',
    '## Concept documents',
    '',
    '- Every concept is a non-reserved `.md` file with YAML frontmatter.',
    '- `type` is required and may be any non-empty value; do not enforce a closed type list.',
    '- `title`, `description`, `resource`, and `tags` are optional or recommended fields.',
    '- Use `generated`, `verified`, `status`, `stale_after`, and `sources` for OKF v0.2 provenance, trust, and lifecycle metadata.',
    '- Read legacy `timestamp` only as the v0.1 fallback when `generated` is absent.',
    '- Preserve every unknown frontmatter field and tolerate unknown concept types.',
    '- Reuse a stable concept ID: its bundle-relative POSIX path without the `.md` suffix.',
    '',
    '## Links, provenance, and time',
    '',
    '- Use `/path/to/concept.md` for bundle-root links or relative paths from the current document.',
    '- Keep internal relationships as ordinary directed Markdown links; do not invent relationship types.',
    '- Use ISO 8601 date-times with an explicit `Z` or numeric offset for `generated.at` and `verified[].at`.',
    '- Treat `type: Attested Computation` as a declarative contract; do not execute its executor or attester without a separate trusted runtime.',
    '- Do not treat a broken link as a conformance failure; repair it as a curation problem.',
    '',
    '## Indexes and checks',
    '',
    '- Let OKF Workbench update only the explicit `okf-workbench:index` managed region in each `index.md`.',
    '- Do not hand-edit or duplicate managed-region markers.',
    '- Fix conformance errors before relying on the bundle for interoperability.',
    '- Review curation warnings for missing metadata, orphan concepts, duplicate resources, malformed trust families, suspicious times, and stale concepts.',
    '- Keep speculative notes and short-lived task state outside the durable bundle.',
  ];
  return { ok: true, value: `${lines.join('\n')}\n`, warnings: [] };
}

export function planAgentSkill(input: AgentSkillPlanInput): OperationResult<AgentSkillPlan> {
  const skill = renderAgentSkill(input.bundlePath);
  if (!skill.ok) {
    return skill;
  }

  if (input.existingText === undefined) {
    return {
      ok: true,
      value: { relativePath: AGENT_SKILL_PATH, status: 'create', proposedText: skill.value },
      warnings: [],
    };
  }

  if (input.existingText === skill.value) {
    return {
      ok: true,
      value: {
        relativePath: AGENT_SKILL_PATH,
        status: 'unchanged',
        proposedText: skill.value,
        previousText: input.existingText,
      },
      warnings: [],
    };
  }

  const status = input.confirmReplacement === true ? 'replace' : 'replacement-required';
  return {
    ok: true,
    value: {
      relativePath: AGENT_SKILL_PATH,
      status,
      proposedText: skill.value,
      previousText: input.existingText,
    },
    warnings:
      status === 'replacement-required'
        ? [
            {
              code: 'agent-skill-replacement-required',
              message: `${AGENT_SKILL_PATH} already exists and differs from the proposed Skill.`,
              correctiveAction:
                'Preview the existing and proposed content, then explicitly confirm replacement or cancel.',
            },
          ]
        : [],
  };
}

export function planAgentIntegration(
  input: AgentIntegrationPlanInput,
): OperationResult<AgentIntegrationPlan> {
  if (
    input.selection !== 'agents-md' &&
    input.selection !== 'agent-skill' &&
    input.selection !== 'both'
  ) {
    return failure(
      'unknown-agent-integration-selection',
      `Unknown agent integration selection: ${JSON.stringify(input.selection)}.`,
      'Choose AGENTS.md, Agent Skill, or both.',
    );
  }

  let agentsFile: AgentsFilePlan | undefined;
  let agentSkill: AgentSkillPlan | undefined;
  const warnings: OperationProblem[] = [];
  if (input.selection === 'agents-md' || input.selection === 'both') {
    const agents = planAgentsFile({
      bundlePath: input.bundlePath,
      ...(input.existingAgentsText === undefined ? {} : { existingText: input.existingAgentsText }),
    });
    if (!agents.ok) {
      return agents;
    }
    agentsFile = agents.value;
    warnings.push(...agents.warnings);
  }

  if (input.selection === 'agent-skill' || input.selection === 'both') {
    const skill = planAgentSkill({
      bundlePath: input.bundlePath,
      ...(input.existingSkillText === undefined ? {} : { existingText: input.existingSkillText }),
      ...(input.confirmSkillReplacement === undefined
        ? {}
        : { confirmReplacement: input.confirmSkillReplacement }),
    });
    if (!skill.ok) {
      return skill;
    }
    agentSkill = skill.value;
    warnings.push(...skill.warnings);
  }

  const readyToApply = agentSkill?.status !== 'replacement-required';
  return {
    ok: true,
    value: {
      selection: input.selection,
      ...(agentsFile === undefined ? {} : { agentsFile }),
      ...(agentSkill === undefined ? {} : { agentSkill }),
      readyToApply,
    },
    warnings,
  };
}
