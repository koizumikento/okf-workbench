import { describe, expect, it } from 'vitest';

import { createInitializeBundleCommand } from '../../../src/extension/commands/initialize-bundle.js';
import { createNewConceptCommand } from '../../../src/extension/commands/new-concept.js';
import { createRegenerateIndexesCommand } from '../../../src/extension/commands/regenerate-indexes.js';
import { createSetupAgentIntegrationCommand } from '../../../src/extension/commands/setup-agent-integration.js';
import type { ProposalPreviewer } from '../../../src/extension/commands/types.js';
import {
  guardBundleWriteSelection,
  inspectBundleWriteAccess,
} from '../../../src/extension/composition/bundle-inspection.js';
import { bundlePathWithinIntegrationRoot } from '../../../src/extension/composition/bundle-path.js';
import { sha256Content } from '../../../src/extension/workspace/contentHash.js';
import { ProposalApplicator } from '../../../src/extension/workspace/proposalApplicator.js';
import { FakeWorkspacePort, stringUriCodec } from '../extension-workspace/fakes.js';
import { FakeCommandUi, FakeProposalPreviewer } from './fakes.js';

const workspaceRoot = 'memfs://workspace';
const bundleRoot = `${workspaceRoot}/knowledge`;
const encoder = new TextEncoder();

function utf8BomText(text: string): Uint8Array {
  const encoded = encoder.encode(text);
  return Uint8Array.from([0xef, 0xbb, 0xbf, ...encoded]);
}

function expectUtf8Bom(content: Uint8Array | undefined): void {
  expect(content?.slice(0, 3)).toEqual(Uint8Array.from([0xef, 0xbb, 0xbf]));
}

function harness(port = new FakeWorkspacePort()) {
  const ui = new FakeCommandUi();
  const previewer = new FakeProposalPreviewer();
  return {
    port,
    ui,
    previewer,
    shared: {
      port,
      uris: stringUriCodec,
      applicator: new ProposalApplicator(port, stringUriCodec),
      ui,
      previewer,
      isWorkspaceTrusted: () => true,
    },
  };
}

describe('authoring command handlers', () => {
  it('initializes one of all three presets only after approval and selects its root', async () => {
    for (const preset of ['minimal', 'software-project', 'data-analytics'] as const) {
      const { port, ui, shared } = harness();
      ui.inputs.push('knowledge');
      ui.selections.push(preset);
      ui.confirmations.push(true);
      const selected: string[] = [];
      const command = createInitializeBundleCommand({
        ...shared,
        selectInitializationTarget: async () => ({
          targetRootUri: workspaceRoot,
          label: 'workspace',
          suggestedBundleDirectory: 'knowledge',
        }),
        selectInitializedBundle: (uri) => {
          selected.push(uri);
        },
        now: () => '2026-07-22T10:00:00+09:00',
      });

      const result = await command();

      expect(result.kind).toBe('applied');
      expect(port.text(`${bundleRoot}/index.md`)).toContain('okf_version: "0.1"');
      expect(selected).toEqual([bundleRoot]);
      expect(ui.opened).toEqual([`${bundleRoot}/index.md`]);
    }
  });

  it('does not initialize or select a bundle when approval is cancelled', async () => {
    const { port, ui, shared } = harness();
    ui.inputs.push('knowledge');
    ui.selections.push('minimal');
    ui.confirmations.push(false);
    const selected: string[] = [];
    const command = createInitializeBundleCommand({
      ...shared,
      selectInitializationTarget: async () => ({
        targetRootUri: workspaceRoot,
        label: 'workspace',
        suggestedBundleDirectory: 'knowledge',
      }),
      selectInitializedBundle: (uri) => {
        selected.push(uri);
      },
      now: () => '2026-07-22T10:00:00+09:00',
    });

    expect(await command()).toEqual({ kind: 'cancelled' });
    expect(port.writes).toEqual([]);
    expect(selected).toEqual([]);
    expect(ui.opened).toEqual([]);
  });

  it('refuses initialization through an existing symlinked bundle directory', async () => {
    const { port, ui, previewer, shared } = harness();
    port.putDirectory(workspaceRoot);
    port.putSymbolicLink(`${workspaceRoot}/linked-bundle`);
    ui.inputs.push('linked-bundle');
    ui.selections.push('minimal');
    const command = createInitializeBundleCommand({
      ...shared,
      selectInitializationTarget: async () => ({
        targetRootUri: workspaceRoot,
        label: 'workspace',
        suggestedBundleDirectory: 'knowledge',
      }),
      selectInitializedBundle: () => undefined,
      now: () => '2026-07-22T10:00:00+09:00',
    });

    const result = await command();

    expect(result).toMatchObject({ kind: 'failed', report: { completed: [] } });
    expect(port.writes).toEqual([]);
    expect(previewer.shown).toEqual([]);
    expect(ui.errors[0]).toContain('symbolic-link path segment');
  });

  it('reports an actionable error when the generated root index cannot be opened', async () => {
    const { port, ui, shared } = harness();
    ui.inputs.push('knowledge');
    ui.selections.push('minimal');
    ui.confirmations.push(true);
    ui.openFailure = new Error('Editor unavailable');
    const selected: string[] = [];
    const command = createInitializeBundleCommand({
      ...shared,
      selectInitializationTarget: async () => ({
        targetRootUri: workspaceRoot,
        label: 'workspace',
        suggestedBundleDirectory: 'knowledge',
      }),
      selectInitializedBundle: (uri) => {
        selected.push(uri);
      },
      now: () => '2026-07-22T10:00:00+09:00',
    });

    const result = await command();

    expect(result.kind).toBe('applied');
    expect(port.text(`${bundleRoot}/index.md`)).toContain('okf_version: "0.1"');
    expect(selected).toEqual([bundleRoot]);
    expect(ui.opened).toEqual([]);
    expect(ui.errors).toEqual([
      expect.stringContaining('could not open the generated root index.md'),
    ]);
  });

  it('accepts an arbitrary concept type, guards collision, and opens only a created document', async () => {
    const { port, ui, shared } = harness();
    port.putText(`${bundleRoot}/experiments/result.md`, 'existing\n');
    ui.selections.push('generic-concept');
    ui.inputs.push(
      'experiments',
      'experiment-result',
      'Result',
      'Description',
      'test, result',
      'result.md',
    );
    const command = createNewConceptCommand({
      ...shared,
      selectBundle: async () => ({ bundleRootUri: bundleRoot }),
    });

    const result = await command();

    expect(result.kind).toBe('failed');
    expect(port.text(`${bundleRoot}/experiments/result.md`)).toBe('existing\n');
    expect(port.writes).toEqual([]);
    expect(ui.opened).toEqual([]);
  });

  it('opens a successfully created custom-type concept in the editor', async () => {
    const { port, ui, shared } = harness();
    ui.selections.push('reference');
    ui.inputs.push(
      'experiments',
      'experiment-result',
      'Result',
      'Description',
      'test, result',
      'result.md',
    );
    ui.confirmations.push(true);
    const command = createNewConceptCommand({
      ...shared,
      selectBundle: async () => ({ bundleRootUri: bundleRoot }),
    });

    const result = await command();

    const target = `${bundleRoot}/experiments/result.md`;
    expect(result.kind).toBe('applied');
    expect(port.text(target)).toContain('type: "experiment-result"');
    expect(port.text(target)).toContain('description: "Description"');
    expect(port.text(target)).toContain('tags:\n  - "test"\n  - "result"');
    expect(ui.opened).toEqual([target]);
  });

  it('refuses concept creation through a symlinked destination directory', async () => {
    const { port, ui, previewer, shared } = harness();
    port.putDirectory(bundleRoot);
    port.putSymbolicLink(`${bundleRoot}/linked`);
    ui.selections.push('generic-concept');
    ui.inputs.push('linked', 'concept', 'Unsafe target', '', '', 'outside.md');
    const command = createNewConceptCommand({
      ...shared,
      selectBundle: async () => ({ bundleRootUri: bundleRoot }),
    });

    const result = await command();

    expect(result).toMatchObject({ kind: 'failed', report: { completed: [] } });
    expect(port.writes).toEqual([]);
    expect(previewer.shown).toEqual([]);
    expect(ui.opened).toEqual([]);
  });

  it('does not invent optional description or tags for blank or whitespace-only input', async () => {
    const { port, ui, shared } = harness();
    ui.selections.push('generic-concept');
    ui.inputs.push('.', 'concept', 'Minimal metadata', ' \t ', ' ,  , ', 'minimal.md');
    ui.confirmations.push(true);
    const command = createNewConceptCommand({
      ...shared,
      selectBundle: async () => ({ bundleRootUri: bundleRoot }),
    });

    const result = await command();

    const content = port.text(`${bundleRoot}/minimal.md`);
    expect(result.kind).toBe('applied');
    expect(content).toContain('type: "concept"');
    expect(content).not.toContain('\ndescription:');
    expect(content).not.toContain('\ntags:');
  });

  it('refuses a New Concept filename that would produce an empty concept ID', async () => {
    const { port, ui, previewer, shared } = harness();
    ui.selections.push('generic-concept');
    ui.inputs.push('.', 'concept', 'Empty ID must fail', '', '', '.md');
    const command = createNewConceptCommand({
      ...shared,
      selectBundle: async () => ({ bundleRootUri: bundleRoot }),
    });

    const result = await command();

    expect(result).toMatchObject({
      kind: 'refused',
      problems: [{ code: 'unsafe-relative-path' }],
    });
    expect(port.writes).toEqual([]);
    expect(previewer.shown).toEqual([]);
    expect(ui.opened).toEqual([]);
    expect(ui.errors[0]).toContain('filename before the .md extension');
  });

  it('treats a second identical index plan as an idempotent no-change result', async () => {
    const { port, ui, shared } = harness();
    const current =
      '---\nokf_version: "0.1"\n---\n' +
      '<!-- okf-workbench:index:start -->\n' +
      '## Contents\n\n' +
      '- [Alpha](./alpha.md)\n' +
      '<!-- okf-workbench:index:end -->\n';
    port.putText(`${bundleRoot}/index.md`, current);
    port.putText(`${bundleRoot}/alpha.md`, '---\ntype: concept\ntitle: Alpha\n---\n# Alpha\n');
    ui.selections.push('update-all');
    const command = createRegenerateIndexesCommand({
      ...shared,
      selectBundle: async () => ({ bundleRootUri: bundleRoot }),
    });

    const result = await command();

    expect(result).toEqual({ kind: 'unchanged' });
    expect(port.writes).toEqual([]);
    expect(ui.confirmationRequests).toEqual([]);
  });

  it('updates a BOM-prefixed index using its original byte hash and preserves the BOM', async () => {
    const { port, ui, previewer, shared } = harness();
    const original = utf8BomText(
      '---\nokf_version: "0.1"\n---\n# Knowledge\n\nHuman-authored introduction.\n',
    );
    port.files.set(`${bundleRoot}/index.md`, original);
    port.putText(`${bundleRoot}/alpha.md`, '---\ntype: concept\ntitle: Alpha\n---\n# Alpha\n');
    ui.selections.push('update-all');
    ui.confirmations.push(true);
    const command = createRegenerateIndexesCommand({
      ...shared,
      selectBundle: async () => ({ bundleRootUri: bundleRoot }),
    });

    const result = await command();

    expect(result.kind).toBe('applied');
    expect(previewer.shown[0]?.proposal.changes[0]?.expected).toEqual({
      kind: 'sha256',
      value: sha256Content(original),
    });
    const updated = port.files.get(`${bundleRoot}/index.md`);
    expectUtf8Bom(updated);
    expect(new TextDecoder('utf-8').decode(updated)).toContain('[Alpha](./alpha.md)');
  });

  it('refuses undecodable index bytes without omitting or rewriting them', async () => {
    const { port, ui, previewer, shared } = harness();
    const target = `${bundleRoot}/index.md`;
    const original = Uint8Array.from([0xff, 0xfe, 0xfd]);
    port.files.set(target, original);
    ui.selections.push('update-all');
    const command = createRegenerateIndexesCommand({
      ...shared,
      selectBundle: async () => ({ bundleRootUri: bundleRoot }),
    });

    const result = await command();

    expect(result.kind).toBe('refused');
    expect(previewer.shown).toEqual([]);
    expect(port.writes).toEqual([]);
    expect(port.files.get(target)).toEqual(original);
    expect(ui.errors[0]).toContain('Indexes could not be planned safely');
  });

  it('allows index regeneration to synthesize an explicitly selected missing root index', async () => {
    const { port, ui, shared } = harness();
    port.putText(
      `${bundleRoot}/alpha.md`,
      '---\ntype: reference\ntitle: Alpha\ndescription: Existing knowledge\n---\n# Alpha\n',
    );
    ui.selections.push('missing-indexes-only');
    ui.confirmations.push(true);
    const command = createRegenerateIndexesCommand({
      ...shared,
      selectBundle: async () =>
        guardBundleWriteSelection(
          { bundleRootUri: bundleRoot },
          port,
          stringUriCodec,
          async (problem) => ui.showError(problem.message),
        ),
    });

    const result = await command();

    expect(result.kind).toBe('applied');
    expect(port.text(`${bundleRoot}/index.md`)).toContain('okf_version: "0.1"');
    expect(port.text(`${bundleRoot}/index.md`)).toContain('[Alpha](./alpha.md)');
  });

  it('previews, safely versions, and idempotently regenerates a versionless existing root', async () => {
    const { port, ui, previewer, shared } = harness();
    const indexUri = `${bundleRoot}/index.md`;
    const existing =
      '---\n' +
      '# preserve this producer comment\n' +
      'title: "Human-owned root"\n' +
      'custom: {owner: "knowledge-team", priority: 2}\n' +
      '---\n' +
      '# Human introduction\n\n' +
      'Keep this body exactly.\n';
    port.putText(indexUri, existing);
    port.putText(`${bundleRoot}/alpha.md`, '---\ntype: reference\ntitle: Alpha\n---\n# Alpha\n');
    const selectBundle = async () =>
      guardBundleWriteSelection(
        { bundleRootUri: bundleRoot },
        port,
        stringUriCodec,
        async (problem) => ui.showError(problem.message),
      );
    const command = createRegenerateIndexesCommand({
      ...shared,
      selectBundle,
      revalidateBundleWrite: async (root) => {
        const access = await inspectBundleWriteAccess(root, port, stringUriCodec);
        return access.ok ? undefined : access.problem;
      },
    });

    ui.selections.push('update-all');
    ui.confirmations.push(false);
    await expect(command()).resolves.toEqual({ kind: 'cancelled' });
    expect(port.text(indexUri)).toBe(existing);
    expect(port.writes).toEqual([]);
    const previewed = previewer.shown[0]?.proposal.changes.find(
      ({ relativePath }) => relativePath === 'index.md',
    )?.proposedText;
    expect(previewed).toContain('okf_version: "0.1"\n');
    expect(previewed).toContain('# preserve this producer comment\n');
    expect(previewed).toContain('custom: {owner: "knowledge-team", priority: 2}\n');
    expect(previewed).toContain('# Human introduction\n\nKeep this body exactly.\n');
    expect(previewed).toContain('- [Alpha](./alpha.md)');

    ui.selections.push('update-all');
    ui.confirmations.push(true);
    const applied = await command();
    expect(applied.kind).toBe('applied');
    expect(port.text(indexUri)).toBe(previewed);
    expect(port.writes).toEqual([indexUri]);

    ui.selections.push('update-all');
    await expect(command()).resolves.toEqual({ kind: 'unchanged' });
    expect(previewer.shown).toHaveLength(2);
    expect(port.writes).toEqual([indexUri]);
  });

  it('regenerates indexes at exact provider paths without decoding percent-bearing siblings', async () => {
    const { port, ui, shared } = harness();
    port.putText(`${bundleRoot}/index.md`, '---\nokf_version: "0.1"\n---\n# Knowledge\n');
    const concepts = [
      ['literal%/alpha.md', 'Literal percent'],
      ['encoded%2Fsegment/alpha.md', 'Literal encoded separator'],
      ['encoded%252Fsegment/alpha.md', 'Literal double encoding'],
      ['encoded/segment/alpha.md', 'Actual nested segment'],
      ['space dir/日本 語.md', 'Unicode and space'],
    ] as const;
    for (const [relativePath, title] of concepts) {
      port.putText(
        `${bundleRoot}/${relativePath}`,
        `---\ntype: concept\ntitle: ${title}\n---\n# ${title}\n`,
      );
    }
    ui.selections.push('update-all');
    ui.confirmations.push(true);
    const command = createRegenerateIndexesCommand({
      ...shared,
      selectBundle: async () => ({ bundleRootUri: bundleRoot }),
    });

    const result = await command();

    expect(result.kind).toBe('applied');
    expect(port.text(`${bundleRoot}/literal%/index.md`)).toContain('Literal percent');
    expect(port.text(`${bundleRoot}/encoded%2Fsegment/index.md`)).toContain(
      'Literal encoded separator',
    );
    expect(port.text(`${bundleRoot}/encoded%252Fsegment/index.md`)).toContain(
      'Literal double encoding',
    );
    expect(port.text(`${bundleRoot}/encoded/segment/index.md`)).toContain('Actual nested segment');
    expect(port.text(`${bundleRoot}/space dir/index.md`)).toContain(
      './%E6%97%A5%E6%9C%AC%20%E8%AA%9E.md',
    );
    expect(port.text(`${bundleRoot}/encoded/segment/index.md`)).not.toContain(
      'Literal encoded separator',
    );
  });

  it('previews an existing Skill and requires a separate replacement confirmation', async () => {
    const { port, ui, previewer, shared } = harness();
    port.putText(`${workspaceRoot}/.agents/skills/maintain-okf-knowledge/SKILL.md`, 'owned\n');
    ui.selections.push('agent-skill');
    ui.confirmations.push(false);
    const command = createSetupAgentIntegrationCommand({
      ...shared,
      selectAgentIntegrationTarget: async () => ({
        integrationRootUri: workspaceRoot,
        bundlePath: 'knowledge',
      }),
    });

    const result = await command();

    expect(result).toEqual({ kind: 'cancelled' });
    expect(previewer.shown).toHaveLength(1);
    expect(previewer.releasedSessions).toBe(1);
    expect(ui.confirmationRequests[0]?.confirmLabel).toBe('Permit Skill replacement');
    expect(ui.confirmationRequests[0]?.modeless).toBe(true);
    expect(port.writes).toEqual([]);
    expect(port.text(`${workspaceRoot}/.agents/skills/maintain-okf-knowledge/SKILL.md`)).toBe(
      'owned\n',
    );
  });

  it('refuses Agent Skill generation through a symlinked instruction directory', async () => {
    const { port, ui, previewer, shared } = harness();
    port.putDirectory(workspaceRoot);
    port.putSymbolicLink(`${workspaceRoot}/.agents`);
    ui.selections.push('agent-skill');
    const command = createSetupAgentIntegrationCommand({
      ...shared,
      selectAgentIntegrationTarget: async () => ({
        integrationRootUri: workspaceRoot,
        bundlePath: 'knowledge',
      }),
    });

    const result = await command();

    expect(result).toMatchObject({ kind: 'failed', report: { completed: [] } });
    expect(port.writes).toEqual([]);
    expect(previewer.shown).toEqual([]);
  });

  it('applies provider-derived colon, percent, and Unicode bundle paths without aliasing', async () => {
    const { port, ui, previewer, shared } = harness();
    const providerBundlePath = bundlePathWithinIntegrationRoot(
      { scheme: 'memfs', authority: 'workspace', path: '/' },
      {
        scheme: 'memfs',
        authority: 'workspace',
        path: '/docs:knowledge/literal%2Fsegment/知識',
      },
    );
    if (providerBundlePath === undefined) {
      throw new Error('Expected the provider bundle path to be safe.');
    }
    ui.selections.push('both');
    ui.confirmations.push(true);
    const command = createSetupAgentIntegrationCommand({
      ...shared,
      selectAgentIntegrationTarget: async () => ({
        integrationRootUri: workspaceRoot,
        bundlePath: providerBundlePath,
      }),
    });

    expect(await command()).toMatchObject({ kind: 'applied' });
    const agents = port.text(`${workspaceRoot}/AGENTS.md`);
    const skill = port.text(`${workspaceRoot}/.agents/skills/maintain-okf-knowledge/SKILL.md`);
    for (const output of [agents, skill]) {
      expect(output).toContain('`docs:knowledge/literal%2Fsegment/知識/`');
      expect(output).toContain('`docs:knowledge/literal%2Fsegment/知識/index.md`');
      expect(output).not.toContain('literal/segment');
    }
    expect(previewer.shown[0]?.presentation.summary).toContain(
      'Actual bundle path: docs:knowledge/literal%2Fsegment/知識',
    );
  });

  it('updates BOM-prefixed AGENTS.md with its original byte hash and preserves the BOM', async () => {
    const { port, ui, previewer, shared } = harness();
    const target = `${workspaceRoot}/AGENTS.md`;
    const original = utf8BomText('# Local instructions\n');
    port.files.set(target, original);
    ui.selections.push('agents-md');
    ui.confirmations.push(true);
    const command = createSetupAgentIntegrationCommand({
      ...shared,
      selectAgentIntegrationTarget: async () => ({
        integrationRootUri: workspaceRoot,
        bundlePath: 'knowledge',
      }),
    });

    const result = await command();

    expect(result.kind).toBe('applied');
    expect(previewer.shown[0]?.proposal.changes[0]?.expected).toEqual({
      kind: 'sha256',
      value: sha256Content(original),
    });
    const updated = port.files.get(target);
    expectUtf8Bom(updated);
    expect(new TextDecoder('utf-8').decode(updated)).toContain('# Local instructions');
    expect(new TextDecoder('utf-8').decode(updated)).toContain('<!-- okf-workbench:start -->');
  });

  it('refuses undecodable existing agent bytes without previewing or writing', async () => {
    const { port, ui, previewer, shared } = harness();
    const target = `${workspaceRoot}/AGENTS.md`;
    port.files.set(target, Uint8Array.from([0xff, 0xfe, 0xfd]));
    ui.selections.push('agents-md');
    const command = createSetupAgentIntegrationCommand({
      ...shared,
      selectAgentIntegrationTarget: async () => ({
        integrationRootUri: workspaceRoot,
        bundlePath: 'knowledge',
      }),
    });

    await expect(command()).resolves.toEqual({ kind: 'failed' });
    expect(previewer.shown).toEqual([]);
    expect(port.writes).toEqual([]);
    expect(port.files.get(target)).toEqual(Uint8Array.from([0xff, 0xfe, 0xfd]));
    expect(ui.errors[0]).toContain('could not be planned');
  });

  it('refuses malformed AGENTS.md markers before previewing any output', async () => {
    const { port, ui, previewer, shared } = harness();
    port.putText(`${workspaceRoot}/AGENTS.md`, '<!-- okf-workbench:start -->\nmissing end\n');
    ui.selections.push('both');
    const command = createSetupAgentIntegrationCommand({
      ...shared,
      selectAgentIntegrationTarget: async () => ({
        integrationRootUri: workspaceRoot,
        bundlePath: 'knowledge',
      }),
    });

    const result = await command();

    expect(result.kind).toBe('refused');
    expect(previewer.shown).toEqual([]);
    expect(port.writes).toEqual([]);
    expect(ui.errors[0]).toContain('remove both markers');
  });

  it('keeps every existing-bundle write workflow inert for an unsupported major version', async () => {
    const { port, ui, previewer, shared } = harness();
    port.putText(`${bundleRoot}/index.md`, '---\nokf_version: "1.0"\n---\n# Future bundle\n');
    const refuse = async (problem: { readonly code: string; readonly message: string }) => {
      await ui.showError(`Write operation refused. ${problem.message}`);
    };
    const selectWritableBundle = async () =>
      guardBundleWriteSelection({ bundleRootUri: bundleRoot }, port, stringUriCodec, refuse);

    const newConcept = createNewConceptCommand({
      ...shared,
      selectBundle: selectWritableBundle,
    });
    const regenerateIndexes = createRegenerateIndexesCommand({
      ...shared,
      selectBundle: selectWritableBundle,
    });
    const setupAgentIntegration = createSetupAgentIntegrationCommand({
      ...shared,
      selectAgentIntegrationTarget: async () => {
        const bundle = await selectWritableBundle();
        return bundle === undefined
          ? undefined
          : { integrationRootUri: workspaceRoot, bundlePath: 'knowledge' };
      },
    });

    await expect(newConcept()).resolves.toEqual({ kind: 'cancelled' });
    await expect(regenerateIndexes()).resolves.toEqual({ kind: 'cancelled' });
    await expect(setupAgentIntegration()).resolves.toEqual({ kind: 'cancelled' });
    expect(ui.errors).toHaveLength(3);
    expect(ui.errors.every((message) => message.includes('unsupported OKF version "1.0"'))).toBe(
      true,
    );
    expect(previewer.shown).toEqual([]);
    expect(ui.confirmationRequests).toEqual([]);
    expect(port.writes).toEqual([]);
  });

  it('refuses a concept write when the bundle becomes unsupported during modeless preview', async () => {
    const { port, ui, previewer, shared } = harness();
    const rootIndex = `${bundleRoot}/index.md`;
    const target = `${bundleRoot}/concept.md`;
    port.putText(rootIndex, '---\nokf_version: "0.1"\n---\n# Knowledge\n');
    ui.selections.push('generic-concept');
    ui.inputs.push('.', 'concept', 'Safe until approval', '', '', 'concept.md');
    ui.confirmations.push(true);

    const changingPreviewer: ProposalPreviewer<string> = {
      async show(proposal, presentation) {
        const session = await previewer.show(proposal, presentation);
        port.putText(rootIndex, '---\nokf_version: "1.0"\n---\n# Changed bundle\n');
        return session;
      },
    };
    const command = createNewConceptCommand({
      ...shared,
      previewer: changingPreviewer,
      selectBundle: async () => ({ bundleRootUri: bundleRoot }),
      revalidateBundleWrite: async (root) => {
        const access = await inspectBundleWriteAccess(root, port, stringUriCodec);
        return access.ok ? undefined : access.problem;
      },
    });

    const result = await command();

    expect(result).toMatchObject({
      kind: 'refused',
      problems: [{ code: 'unsupported-okf-version-write' }],
    });
    expect(port.text(target)).toBeUndefined();
    expect(port.writes).toEqual([]);
    expect(ui.opened).toEqual([]);
    expect(ui.errors.at(-1)).toContain('unsupported OKF version "1.0"');
    expect(previewer.releasedSessions).toBe(1);
  });

  it('revalidates the selected bundle before applying agent integration outside that bundle', async () => {
    const { port, ui, shared } = harness();
    port.putText(`${bundleRoot}/index.md`, '---\nokf_version: "0.1"\n---\n# Knowledge\n');
    ui.selections.push('agents-md');
    ui.confirmations.push(true);
    const checkedRoots: string[] = [];
    const command = createSetupAgentIntegrationCommand({
      ...shared,
      selectAgentIntegrationTarget: async () => ({
        integrationRootUri: workspaceRoot,
        bundleRootUri: bundleRoot,
        bundlePath: 'knowledge',
      }),
      revalidateBundleWrite: async (root) => {
        checkedRoots.push(root);
        return {
          code: 'unsupported-okf-version-write',
          message: 'The selected bundle now declares unsupported OKF version "1.0".',
          correctiveAction: 'Validate and migrate the bundle before writing.',
        };
      },
    });

    const result = await command();

    expect(result).toMatchObject({
      kind: 'refused',
      problems: [{ code: 'unsupported-okf-version-write' }],
    });
    expect(checkedRoots).toEqual([bundleRoot]);
    expect(port.text(`${workspaceRoot}/AGENTS.md`)).toBeUndefined();
    expect(port.writes).toEqual([]);
  });
});
