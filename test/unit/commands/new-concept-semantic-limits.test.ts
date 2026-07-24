import { describe, expect, it } from 'vitest';

import { OKF_SEMANTIC_LIMITS } from '../../../src/core/model/index.js';
import { parseBundle } from '../../../src/core/parser/index.js';
import { typescriptOkfCore } from '../../../src/core/wasm/index.js';
import { createNewConceptCommand } from '../../../src/extension/commands/new-concept.js';
import { SerialProposalWorkflowScheduler } from '../../../src/extension/commands/proposal-workflow-scheduler.js';
import { ProposalApplicator } from '../../../src/extension/workspace/proposalApplicator.js';
import { FakeWorkspacePort, stringUriCodec } from '../extension-workspace/fakes.js';
import {
  captureOpenWorkspaceFolderMembership,
  FakeCommandUi,
  FakeProposalPreviewer,
} from './fakes.js';

const workspaceRoot = 'memfs://workspace';
const bundleRoot = `${workspaceRoot}/knowledge`;

function harness() {
  const port = new FakeWorkspacePort();
  port.putDirectory(workspaceRoot);
  port.putDirectory(bundleRoot);
  const ui = new FakeCommandUi();
  const previewer = new FakeProposalPreviewer();
  const command = createNewConceptCommand({
    core: typescriptOkfCore,
    port,
    uris: stringUriCodec,
    applicator: new ProposalApplicator(port, stringUriCodec),
    ui,
    previewer,
    workflowScheduler: new SerialProposalWorkflowScheduler(),
    isWorkspaceTrusted: () => true,
    captureWorkspaceFolderMembership: captureOpenWorkspaceFolderMembership,
    selectBundle: async () => ({
      bundleRootUri: bundleRoot,
      workspaceSafetyRootUri: workspaceRoot,
    }),
  });
  return { command, port, previewer, ui };
}

describe('New Concept semantic input bounds', () => {
  it('refuses an oversized type before collecting later fields or creating a proposal', async () => {
    const { command, port, previewer, ui } = harness();
    ui.selections.push('generic-concept');
    ui.inputs.push('.', 't'.repeat(OKF_SEMANTIC_LIMITS.maxTypeCodeUnits + 1), 'unconsumed title');

    await expect(command()).resolves.toMatchObject({
      kind: 'refused',
      problems: [{ code: 'concept-type-code-unit-limit' }],
    });
    expect(ui.inputs).toEqual(['unconsumed title']);
    expect(ui.errors[0]).toContain('256-code-unit');
    expect(previewer.shown).toEqual([]);
    expect(port.writes).toEqual([]);
  });

  it.each([
    {
      name: 'multibyte type over its UTF-8 limit',
      value: `${'界'.repeat(85)}aa`,
      code: 'concept-type-utf8-limit',
    },
    {
      name: 'type with a graph-unsafe control',
      value: 'unsafe\nvalue',
      code: 'unsafe-concept-type-control',
    },
  ])('refuses a $name before collecting later fields', async ({ value, code }) => {
    const { command, port, previewer, ui } = harness();
    ui.selections.push('generic-concept');
    ui.inputs.push('.', value, 'unconsumed title');

    await expect(command()).resolves.toMatchObject({
      kind: 'refused',
      problems: [{ code }],
    });
    expect(ui.inputs).toEqual(['unconsumed title']);
    expect(previewer.shown).toEqual([]);
    expect(port.writes).toEqual([]);
  });

  it.each([
    {
      field: 'title',
      inputs: [
        '.',
        'concept',
        't'.repeat(OKF_SEMANTIC_LIMITS.maxTitleCodeUnits + 1),
        'unconsumed description',
      ],
      code: 'concept-title-code-unit-limit',
      remaining: ['unconsumed description'],
    },
    {
      field: 'description',
      inputs: [
        '.',
        'concept',
        'Bounded metadata',
        'd'.repeat(OKF_SEMANTIC_LIMITS.maxDescriptionCodeUnits + 1),
        'unconsumed tags',
      ],
      code: 'concept-description-code-unit-limit',
      remaining: ['unconsumed tags'],
    },
  ])(
    'refuses an oversized $field before collecting the next field or creating a proposal',
    async ({ inputs, code, remaining }) => {
      const { command, port, previewer, ui } = harness();
      ui.selections.push('generic-concept');
      ui.inputs.push(...inputs);

      await expect(command()).resolves.toMatchObject({
        kind: 'refused',
        problems: [{ code }],
      });
      expect(ui.inputs).toEqual(remaining);
      expect(previewer.shown).toEqual([]);
      expect(port.writes).toEqual([]);
    },
  );

  it('bounds normalized comma-separated tags before collecting a filename', async () => {
    const { command, port, previewer, ui } = harness();
    const tags = Array.from(
      { length: OKF_SEMANTIC_LIMITS.maxTagsPerConcept + 1 },
      (_, index) => `tag-${String(index)}`,
    ).join(',');
    ui.selections.push('generic-concept');
    ui.inputs.push('.', 'concept', 'Bounded tags', '', tags, 'unconsumed.md');

    await expect(command()).resolves.toMatchObject({
      kind: 'refused',
      problems: [{ code: 'concept-tag-count-limit' }],
    });
    expect(ui.inputs).toEqual(['unconsumed.md']);
    expect(ui.errors[0]).toContain('128 tags');
    expect(previewer.shown).toEqual([]);
    expect(port.writes).toEqual([]);
  });

  it.each([
    {
      name: 'multibyte tag over its UTF-8 limit',
      value: `${'界'.repeat(85)}aa`,
      code: 'concept-tag-utf8-limit',
    },
    {
      name: 'tag with a graph-unsafe control',
      value: 'unsafe\u0085value',
      code: 'unsafe-concept-tag-control',
    },
  ])('refuses a $name before collecting a filename', async ({ value, code }) => {
    const { command, port, previewer, ui } = harness();
    ui.selections.push('generic-concept');
    ui.inputs.push('.', 'concept', 'Bounded tag', '', value, 'unconsumed.md');

    await expect(command()).resolves.toMatchObject({
      kind: 'refused',
      problems: [{ code }],
    });
    expect(ui.inputs).toEqual(['unconsumed.md']);
    expect(previewer.shown).toEqual([]);
    expect(port.writes).toEqual([]);
  });

  it('refuses aggregate generated YAML amplification before constructing a proposal', async () => {
    const { command, port, previewer, ui } = harness();
    const tags = Array.from({ length: OKF_SEMANTIC_LIMITS.maxTagsPerConcept }, () =>
      '\\'.repeat(OKF_SEMANTIC_LIMITS.maxTagCodeUnits),
    ).join(',');
    ui.selections.push('generic-concept');
    ui.inputs.push('.', 'concept', 'Bounded aggregate', '', tags, 'bounded.md');

    await expect(command()).resolves.toMatchObject({
      kind: 'refused',
      problems: [{ code: 'generated-concept-frontmatter-limit' }],
    });
    expect(ui.inputs).toEqual([]);
    expect(previewer.shown).toEqual([]);
    expect(port.writes).toEqual([]);
  });

  it('writes normalized descriptions and tags that immediately parse successfully', async () => {
    const { command, port, ui } = harness();
    ui.selections.push('generic-concept');
    ui.inputs.push(
      '.',
      'experiment-result',
      '  Normalized\r\n title  ',
      'line one\r\nline two',
      ' experiment, , result ,, ',
      'normalized.md',
    );
    ui.confirmations.push(true);

    await expect(command()).resolves.toMatchObject({ kind: 'applied' });
    const content = port.text(`${bundleRoot}/normalized.md`);
    if (content === undefined) {
      throw new Error('Expected the normalized concept to be written.');
    }
    expect(content).toContain('title: "Normalized title"');
    expect(content).toContain('description: "line one\\nline two"');
    expect(content).toContain('tags:\n  - "experiment"\n  - "result"');

    const parsed = parseBundle({
      rootUri: bundleRoot,
      revision: 1,
      documents: [
        {
          uri: `${bundleRoot}/normalized.md`,
          bundlePath: 'normalized.md',
          content,
        },
      ],
    });
    expect(parsed.failures).toEqual([]);
    expect(parsed.concepts).toMatchObject([
      {
        type: 'experiment-result',
        title: 'Normalized title',
        description: 'line one\nline two',
        tags: ['experiment', 'result'],
      },
    ]);
  });
});
