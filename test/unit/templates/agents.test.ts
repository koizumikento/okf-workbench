import { describe, expect, it } from 'vitest';

import type { OperationResult } from '../../../src/core/model/index.js';
import {
  AGENTS_END_MARKER,
  AGENTS_START_MARKER,
  AGENT_SKILL_PATH,
  planAgentIntegration,
  planAgentSkill,
  planAgentsFile,
  preserveProviderBundleDirectory,
  renderAgentSkill,
  renderAgentsManagedBlock,
} from '../../../src/core/templates/index.js';

function valueOf<T>(result: OperationResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.problems.map((problem) => problem.message).join('\n'));
  }
  return result.value;
}

describe('AGENTS.md integration', () => {
  it('renders the documented managed block with the actual bundle path', () => {
    const block = valueOf(renderAgentsManagedBlock('knowledge/'));
    expect(block).toMatchInlineSnapshot(`
      "<!-- okf-workbench:start -->
      ## OKF knowledge

      - The OKF bundle is located at \`knowledge/\`.
      - Read \`knowledge/index.md\` before tasks that require project-wide context.
      - Update the relevant concept when a change affects durable project knowledge.
      - When an \`okf\` executable is available for a local bundle, prefer it for validation, planning, and create-only writes; review \`--check\` output before \`--apply\`, and use the editor or manual editing for existing-file updates.
      - Preserve unknown YAML frontmatter fields.
      - Use bundle-relative Markdown links between concepts.
      - Do not add speculative or temporary information to the bundle.
      <!-- okf-workbench:end -->
      "
    `);
  });

  it('updates an existing empty AGENTS.md and becomes idempotent', () => {
    const expectedBlock = valueOf(renderAgentsManagedBlock('knowledge'));
    const first = valueOf(
      planAgentsFile({
        bundlePath: 'knowledge',
        existingText: '',
      }),
    );

    expect(first).toMatchObject({
      relativePath: 'AGENTS.md',
      status: 'update',
      previousText: '',
      proposedText: expectedBlock,
    });

    const second = valueOf(
      planAgentsFile({
        bundlePath: 'knowledge',
        existingText: first.proposedText,
      }),
    );
    expect(second.status).toBe('unchanged');
    expect(second.proposedText).toBe(first.proposedText);
  });

  it('preserves an existing file without a final newline before appending idempotently', () => {
    const existing = '# Existing rules\n\nKeep this exact byte sequence.';
    const expectedBlock = valueOf(renderAgentsManagedBlock('knowledge'));
    const first = valueOf(
      planAgentsFile({
        bundlePath: 'knowledge',
        existingText: existing,
      }),
    );

    expect(first.status).toBe('update');
    expect(first.previousText).toBe(existing);
    expect(first.proposedText).toBe(`${existing}\n\n${expectedBlock}`);
    expect(first.proposedText.slice(0, existing.length)).toBe(existing);

    const second = valueOf(
      planAgentsFile({
        bundlePath: 'knowledge',
        existingText: first.proposedText,
      }),
    );
    expect(second.status).toBe('unchanged');
    expect(second.proposedText).toBe(first.proposedText);
  });

  it('preserves unrelated CRLF content and becomes idempotent', () => {
    const oldBlock =
      `${AGENTS_START_MARKER}\r\n` + 'old bundle guidance\r\n' + `${AGENTS_END_MARKER}\r\n`;
    const existing = `# Existing rules\r\n\r\n${oldBlock}\r\n## Tail\r\nKeep exactly.\r\n`;
    const first = valueOf(planAgentsFile({ bundlePath: '知識', existingText: existing }));

    expect(first.status).toBe('update');
    expect(first.proposedText.startsWith('# Existing rules\r\n\r\n')).toBe(true);
    expect(first.proposedText.endsWith('\r\n## Tail\r\nKeep exactly.\r\n')).toBe(true);
    expect(first.proposedText).toContain('`知識/`.\r\n');
    expect(first.proposedText.replaceAll('\r\n', '')).not.toContain('\n');

    const second = valueOf(
      planAgentsFile({
        bundlePath: '知識',
        existingText: first.proposedText,
      }),
    );
    expect(second.status).toBe('unchanged');
    expect(second.proposedText).toBe(first.proposedText);
  });

  it('refuses malformed or duplicate markers', () => {
    for (const existingText of [
      `${AGENTS_START_MARKER}\nmissing end\n`,
      `${AGENTS_END_MARKER}\n${AGENTS_START_MARKER}\n`,
      `${AGENTS_START_MARKER}\na\n${AGENTS_END_MARKER}\n${AGENTS_START_MARKER}\nb\n${AGENTS_END_MARKER}\n`,
    ]) {
      const result = planAgentsFile({ bundlePath: 'knowledge', existingText });
      expect(result.ok).toBe(false);
    }
  });

  it('preserves legal provider colon, percent, and Unicode identities in both outputs', () => {
    const providerPath = valueOf(
      preserveProviderBundleDirectory('docs:knowledge/literal%2Fsegment/知識'),
    );
    const block = valueOf(renderAgentsManagedBlock(providerPath));
    const skill = valueOf(renderAgentSkill(providerPath));

    for (const rendered of [block, skill]) {
      expect(rendered).toContain('`docs:knowledge/literal%2Fsegment/知識/`');
      expect(rendered).toContain('`docs:knowledge/literal%2Fsegment/知識/index.md`');
      expect(rendered).not.toContain('literal/segment');
    }

    expect(renderAgentsManagedBlock('docs:knowledge')).toMatchObject({ ok: false });
    expect(renderAgentSkill('docs:knowledge')).toMatchObject({ ok: false });
  });

  it('revalidates provider identities and keeps provider-backed plans idempotent', () => {
    const providerPath = valueOf(preserveProviderBundleDirectory('docs:knowledge/%2F/知識'));
    const first = valueOf(
      planAgentIntegration({
        selection: 'both',
        bundlePath: providerPath,
      }),
    );
    if (first.agentsFile === undefined || first.agentSkill === undefined) {
      throw new Error('A combined agent integration plan must contain both outputs.');
    }
    const second = valueOf(
      planAgentIntegration({
        selection: 'both',
        bundlePath: providerPath,
        existingAgentsText: first.agentsFile.proposedText,
        existingSkillText: first.agentSkill.proposedText,
      }),
    );

    expect(second.agentsFile?.status).toBe('unchanged');
    expect(second.agentSkill?.status).toBe('unchanged');
    expect(second.readyToApply).toBe(true);
    expect(
      renderAgentsManagedBlock({ pathIdentity: 'provider', relativePath: '../escape' }),
    ).toMatchObject({ ok: false });
    expect(
      renderAgentSkill({ pathIdentity: 'provider', relativePath: 'safe/\0control' }),
    ).toMatchObject({ ok: false });
  });
});

describe('Agent Skill integration', () => {
  it('renders the fixed path, valid frontmatter, and complete maintenance workflow', () => {
    const content = valueOf(renderAgentSkill('docs/知識'));
    expect(AGENT_SKILL_PATH).toBe('.agents/skills/maintain-okf-knowledge/SKILL.md');
    expect(
      content.startsWith(
        '---\n' +
          'name: maintain-okf-knowledge\n' +
          "description: Maintain this repository's OKF knowledge bundle.",
      ),
    ).toBe(true);
    expect(content).toContain('`docs/知識/index.md`');
    expect(content).toContain('update it instead of creating a duplicate');
    expect(content).toContain('The `okf` CLI is optional');
    expect(content).toContain('okf validate <bundle-root> --format json');
    expect(content).toContain(
      'okf new <bundle-root> --template decision --title "<title>" --check',
    );
    expect(content).toContain('okf index <bundle-root> --mode missing --check');
    expect(content).toContain('with `--apply` instead of `--check`');
    expect(content).toContain('existing-file update fails closed');
    expect(content).toContain('bundle at `docs/知識/`');
    expect(content).toContain('Preserve every unknown frontmatter field');
    expect(content).toContain('may be any non-empty value');
    expect(content).toContain('explicit `Z` or numeric offset');
    expect(content).toContain('conformance errors');
    expect(content).toContain('curation warnings');
    expect(content).not.toContain('knowledge/');
    expect(content.endsWith('\n')).toBe(true);
    expect(content).not.toContain('\r');
  });

  it('requires explicit replacement for a differing existing Skill', () => {
    const collision = valueOf(
      planAgentSkill({
        bundlePath: 'knowledge',
        existingText: 'user-owned skill\n',
      }),
    );
    expect(collision).toMatchObject({
      relativePath: AGENT_SKILL_PATH,
      status: 'replacement-required',
      previousText: 'user-owned skill\n',
    });

    const replacement = valueOf(
      planAgentSkill({
        bundlePath: 'knowledge',
        existingText: 'user-owned skill\n',
        confirmReplacement: true,
      }),
    );
    expect(replacement.status).toBe('replace');

    const unchanged = valueOf(
      planAgentSkill({
        bundlePath: 'knowledge',
        existingText: replacement.proposedText,
      }),
    );
    expect(unchanged.status).toBe('unchanged');
  });

  it('marks a combined plan unready until the Skill collision is confirmed', () => {
    const blocked = valueOf(
      planAgentIntegration({
        selection: 'both',
        bundlePath: 'knowledge',
        existingAgentsText: '# Existing\n',
        existingSkillText: 'different\n',
      }),
    );
    expect(blocked.agentsFile?.status).toBe('update');
    expect(blocked.agentSkill?.status).toBe('replacement-required');
    expect(blocked.readyToApply).toBe(false);

    const ready = valueOf(
      planAgentIntegration({
        selection: 'both',
        bundlePath: 'knowledge',
        existingAgentsText: '# Existing\n',
        existingSkillText: 'different\n',
        confirmSkillReplacement: true,
      }),
    );
    expect(ready.agentSkill?.status).toBe('replace');
    expect(ready.readyToApply).toBe(true);
  });
});
