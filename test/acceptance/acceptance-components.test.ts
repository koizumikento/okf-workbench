import { describe, expect, it, vi } from 'vitest';

import { buildGraphPayload } from '../../src/core/graph/index.js';
import { INDEX_END_MARKER, INDEX_START_MARKER, planIndexes } from '../../src/core/indexes/index.js';
import {
  planAgentIntegration,
  renderBundlePreset,
  renderConceptTemplate,
} from '../../src/core/templates/index.js';
import { parseBundle } from '../../src/core/parser/index.js';
import { VALIDATION_CODES, validateBundle } from '../../src/core/validation/index.js';
import { typescriptOkfCore } from '../../src/core/wasm/index.js';
import { createInitializeBundleCommand } from '../../src/extension/commands/initialize-bundle.js';
import { SerialProposalWorkflowScheduler } from '../../src/extension/commands/proposal-workflow-scheduler.js';
import { createNewConceptCommand } from '../../src/extension/commands/new-concept.js';
import { createRegenerateIndexesCommand } from '../../src/extension/commands/regenerate-indexes.js';
import { createSetupAgentIntegrationCommand } from '../../src/extension/commands/setup-agent-integration.js';
import { loadBundle } from '../../src/extension/runtime/loadBundle.js';
import { ProposalApplicator } from '../../src/extension/workspace/proposalApplicator.js';
import {
  createInitialPresentationState,
  presentationReducer,
  selectedNode,
  visibleNodes,
} from '../../src/webview/state/index.js';
import {
  ACCEPTANCE_NOW,
  ACCEPTANCE_ROOT_URI,
  acceptanceDocument,
  conceptDocument,
  parseAcceptanceBundle,
  rootIndex,
  valueOf,
} from './helpers.js';
import {
  captureOpenWorkspaceFolderMembership,
  FakeCommandUi,
  FakeProposalPreviewer,
} from '../unit/commands/fakes.js';
import { FakeWorkspacePort, stringUriCodec } from '../unit/extension-workspace/fakes.js';

const COMMAND_WORKSPACE_ROOT = 'memfs://workspace';
const COMMAND_BUNDLE_ROOT = `${COMMAND_WORKSPACE_ROOT}/knowledge`;

function commandHarness(port = new FakeWorkspacePort()) {
  port.putDirectory(COMMAND_WORKSPACE_ROOT);
  port.putDirectory(COMMAND_BUNDLE_ROOT);
  const ui = new FakeCommandUi();
  const previewer = new FakeProposalPreviewer();
  return {
    port,
    ui,
    previewer,
    shared: {
      core: typescriptOkfCore,
      port,
      uris: stringUriCodec,
      applicator: new ProposalApplicator(port, stringUriCodec),
      ui,
      previewer,
      workflowScheduler: new SerialProposalWorkflowScheduler(),
      isWorkspaceTrusted: () => true,
      captureWorkspaceFolderMembership: captureOpenWorkspaceFolderMembership,
    },
  };
}

function renderedMinimalDocuments() {
  return valueOf(
    renderBundlePreset({
      preset: 'minimal',
      timestamp: ACCEPTANCE_NOW,
    }),
  ).map((file) => acceptanceDocument(file.relativePath, file.content));
}

function graphFor(revision: number, documents: Readonly<Record<string, string>>) {
  return buildGraphPayload(
    parseAcceptanceBundle(revision, [
      rootIndex(),
      ...Object.entries(documents).map(([path, content]) => acceptanceDocument(path, content)),
    ]),
  );
}

describe('MVP acceptance scenarios — deterministic component evidence', () => {
  it('[AC-001] initializes, creates, opens, and validates through command/core boundaries', async () => {
    const { port, ui, previewer, shared } = commandHarness();
    const selectedRoots: string[] = [];
    ui.inputs.push('knowledge');
    ui.selections.push('minimal');
    ui.confirmations.push(true);
    const initialize = createInitializeBundleCommand({
      ...shared,
      selectInitializationTarget: async () => ({
        targetRootUri: COMMAND_WORKSPACE_ROOT,
        workspaceSafetyRootUri: COMMAND_WORKSPACE_ROOT,
        label: 'in-memory workspace',
        suggestedBundleDirectory: 'knowledge',
      }),
      selectInitializedBundle: (uri) => {
        selectedRoots.push(uri);
      },
      now: () => ACCEPTANCE_NOW,
    });
    expect((await initialize()).kind).toBe('applied');

    ui.selections.push('generic-concept');
    ui.inputs.push(
      '.',
      'getting-started',
      'Welcome',
      'The first concept in this bundle.',
      'start',
      'welcome.md',
    );
    ui.confirmations.push(true);
    const createConcept = createNewConceptCommand({
      ...shared,
      selectBundle: async () => ({
        bundleRootUri: COMMAND_BUNDLE_ROOT,
        workspaceSafetyRootUri: COMMAND_WORKSPACE_ROOT,
      }),
    });
    expect((await createConcept()).kind).toBe('applied');

    const entries = await port.enumerate(COMMAND_BUNDLE_ROOT);
    const documents = await Promise.all(
      entries.map(async (entry) => ({
        uri: entry.uri,
        bundlePath: entry.relativePath,
        content: await port.read(entry.uri),
      })),
    );
    const bundle = parseBundle({ rootUri: COMMAND_BUNDLE_ROOT, revision: 1, documents });
    const findings = validateBundle(bundle, { now: ACCEPTANCE_NOW });

    expect(selectedRoots).toEqual([COMMAND_BUNDLE_ROOT]);
    expect(bundle.concepts.map(({ id }) => id)).toEqual(['welcome']);
    expect(ui.opened).toEqual([
      `${COMMAND_BUNDLE_ROOT}/index.md`,
      `${COMMAND_BUNDLE_ROOT}/welcome.md`,
    ]);
    expect(previewer.shown).toHaveLength(2);
    expect(findings.filter(({ category }) => category === 'conformance')).toEqual([]);
  });

  it('[AC-002] keeps custom type and producer fields unchanged across index regeneration', () => {
    const customText = conceptDocument({
      type: 'experiment-result',
      title: 'Experiment 42',
      description: 'A producer-defined knowledge shape.',
      additionalFrontmatter:
        'producer:\n  enabled: true\n  threshold: 0.75\n  dimensions: [latency, quality]\n',
      body: '# Experiment 42\n',
    });
    const initialIndex = rootIndex('# Knowledge\n\nHuman introduction.\n');
    const before = parseAcceptanceBundle(1, [
      initialIndex,
      acceptanceDocument('experiments/result.md', customText),
    ]);
    const parsedBefore = before.concepts[0];
    expect(parsedBefore).toBeDefined();

    const indexPlan = valueOf(
      planIndexes({
        mode: 'update-all',
        concepts: before.concepts.map((concept) => ({
          relativePath: concept.source.bundlePath,
          ...(concept.title === undefined ? {} : { title: concept.title }),
          ...(concept.description === undefined ? {} : { description: concept.description }),
        })),
        existingIndexes: [{ relativePath: initialIndex.bundlePath, content: initialIndex.content }],
      }),
    );
    const updatedRoot = indexPlan.changes.find(({ relativePath }) => relativePath === 'index.md');
    expect(updatedRoot).toBeDefined();

    const after = parseAcceptanceBundle(2, [
      acceptanceDocument('index.md', updatedRoot?.proposedText ?? initialIndex.content),
      acceptanceDocument('experiments/result.md', customText),
    ]);
    const parsedAfter = after.concepts[0];

    expect(parsedAfter?.type).toBe('experiment-result');
    expect(parsedAfter?.frontmatter.raw).toEqual(parsedBefore?.frontmatter.raw);
    expect(parsedAfter?.frontmatter.source).toBe(parsedBefore?.frontmatter.source);
    expect(parsedAfter?.frontmatter.raw.producer).toEqual({
      enabled: true,
      threshold: 0.75,
      dimensions: ['latency', 'quality'],
    });
    expect(
      validateBundle(after, { now: ACCEPTANCE_NOW }).filter(
        ({ message }) => message.includes('experiment-result') || message.includes('producer'),
      ),
    ).toEqual([]);
  });

  it('[AC-003] reports source-addressable failures and clears them after a repaired reparse', () => {
    const sourceText = conceptDocument({
      type: 'reference',
      title: 'Source',
      description: 'Links to the repair target.',
      body: '# Source\n\n[Repair target](./target.md)\n[Missing target](./missing.md)\n',
    });
    const invalidTarget = '---\ntype: [unterminated\n---\n# Target\n';
    const initial = parseAcceptanceBundle(1, [
      rootIndex(),
      acceptanceDocument('source.md', sourceText),
      acceptanceDocument('target.md', invalidTarget),
    ]);
    const initialFindings = validateBundle(initial, { now: ACCEPTANCE_NOW });
    const frontmatterFinding = initialFindings.find(
      ({ code }) => code === VALIDATION_CODES.frontmatter,
    );
    const brokenLinkFinding = initialFindings.find(
      ({ code }) => code === VALIDATION_CODES.brokenLink,
    );

    expect(initial.concepts.map(({ id }) => id)).toEqual(['source', 'target']);
    expect(initial.concepts.find(({ id }) => id === 'source')?.links).toMatchObject([
      { rawTarget: './target.md', classification: 'internal', targetId: 'target' },
      { rawTarget: './missing.md', classification: 'broken' },
    ]);
    expect(frontmatterFinding).toMatchObject({
      category: 'conformance',
      severity: 'error',
      uri: `${ACCEPTANCE_ROOT_URI}/target.md`,
    });
    expect(frontmatterFinding?.range).toBeDefined();
    expect(brokenLinkFinding).toMatchObject({
      category: 'curation',
      severity: 'warning',
      uri: `${ACCEPTANCE_ROOT_URI}/source.md`,
    });
    expect(brokenLinkFinding?.range).toBeDefined();

    const repairedTarget = conceptDocument({
      type: 'reference',
      title: 'Target',
      description: 'The repaired target.',
      body: '# Target\n\n[Source](./source.md)\n',
    });
    const repairedSource = conceptDocument({
      type: 'reference',
      title: 'Source',
      description: 'Links to the repaired target.',
      body: '# Source\n\n[Repair target](./target.md)\n',
    });
    const repaired = parseAcceptanceBundle(2, [
      rootIndex(),
      acceptanceDocument('source.md', repairedSource),
      acceptanceDocument('target.md', repairedTarget),
    ]);
    const repairedFindings = validateBundle(repaired, { now: ACCEPTANCE_NOW });

    expect(repaired.failures).toEqual([]);
    expect(
      repairedFindings.filter(
        ({ code }) => code === VALIDATION_CODES.frontmatter || code === VALIDATION_CODES.brokenLink,
      ),
    ).toEqual([]);
    expect(repairedFindings).toEqual([]);
  });

  it('[AC-004] previews and applies one safe command update, then reports no second diff', async () => {
    const { port, ui, previewer, shared } = commandHarness();
    const prefix =
      '---\r\nokf_version: "0.1"\r\n---\r\n# Team knowledge\r\n\r\n' +
      'This introduction is owned by the team.\r\n\r\n';
    const suffix = '\r\n## Notes\r\n\r\nDo not replace this text.\r\n';
    const existing =
      `${prefix}${INDEX_START_MARKER}\r\n- stale generated entry\r\n` +
      `${INDEX_END_MARKER}\r\n${suffix}`;
    port.putText(`${COMMAND_BUNDLE_ROOT}/index.md`, existing);
    port.putText(
      `${COMMAND_BUNDLE_ROOT}/architecture.md`,
      conceptDocument({
        type: 'architecture',
        title: 'Architecture',
        description: 'System boundaries.',
        body: '# Architecture\n',
      }),
    );
    ui.selections.push('update-all');
    ui.confirmations.push(true);
    const regenerate = createRegenerateIndexesCommand({
      ...shared,
      selectBundle: async () => ({
        bundleRootUri: COMMAND_BUNDLE_ROOT,
        workspaceSafetyRootUri: COMMAND_WORKSPACE_ROOT,
      }),
    });
    expect((await regenerate()).kind).toBe('applied');

    const proposed = port.text(`${COMMAND_BUNDLE_ROOT}/index.md`);
    expect(previewer.shown).toHaveLength(1);
    expect(previewer.shown[0]?.proposal.changes).toHaveLength(1);
    expect(proposed?.startsWith(prefix)).toBe(true);
    expect(proposed?.endsWith(suffix)).toBe(true);
    expect(proposed).toContain('- [Architecture](./architecture.md) - System boundaries.\r\n');

    ui.selections.push('update-all');
    expect(await regenerate()).toEqual({ kind: 'unchanged' });
    expect(previewer.shown).toHaveLength(1);
    expect(port.writes).toEqual([`${COMMAND_BUNDLE_ROOT}/index.md`]);
  });

  it('[AC-005] searches, filters, selects, and exposes backlinks and orphan state without source mutation', () => {
    const documents = {
      'alpha.md': conceptDocument({
        type: 'note',
        title: 'Alpha service',
        description: 'Entry point.',
        tags: ['red', 'service'],
        body: '# Alpha\n\n[Beta](./beta.md)\n',
      }),
      'beta.md': conceptDocument({
        type: 'decision',
        title: 'Beta decision',
        description: 'Decision reached from Alpha.',
        tags: ['blue'],
        body: '# Beta\n\n[Missing](./missing.md)\n',
      }),
      'orphan.md': conceptDocument({
        type: 'note',
        title: 'Orphan note',
        description: 'Intentionally disconnected.',
        tags: ['red'],
        body: '# Orphan\n',
      }),
    } as const;
    const sourceSnapshot = JSON.stringify(documents);
    const graph = graphFor(1, documents);
    let state = presentationReducer(createInitialPresentationState(), {
      type: 'replaceGraph',
      graph,
    });
    state = presentationReducer(state, { type: 'setSearch', query: 'ＡＬＰＨＡ' });
    state = presentationReducer(state, { type: 'toggleType', value: 'note' });
    state = presentationReducer(state, { type: 'toggleTag', value: 'red' });

    expect(visibleNodes(state).map(({ id }) => id)).toEqual(['alpha']);
    expect(graph.backlinks.beta).toEqual(['alpha']);
    expect(graph.nodes.find(({ id }) => id === 'orphan')?.orphan).toBe(true);
    expect(graph.nodes.find(({ id }) => id === 'beta')?.brokenLinkCount).toBe(1);

    state = presentationReducer(state, { type: 'selectNode', nodeId: 'beta' });
    state = presentationReducer(state, { type: 'focusNode', nodeId: 'beta' });
    expect(selectedNode(state)).toMatchObject({ id: 'beta', title: 'Beta decision' });
    expect(state.focusedNodeId).toBe('beta');
    expect(JSON.stringify(documents)).toBe(sourceSnapshot);
  });

  it('[AC-006] converges presentation state through create, edit, rename, and delete revisions', () => {
    const alpha = (target: string) =>
      conceptDocument({
        type: 'note',
        title: 'Alpha',
        description: 'Stable source concept.',
        body: `# Alpha\n\n[Current target](./${target}.md)\n`,
      });
    const target = (title: string, backTarget: string) =>
      conceptDocument({
        type: 'reference',
        title,
        description: 'Mutable target concept.',
        body: `# ${title}\n\n[Alpha](./${backTarget}.md)\n`,
      });

    let state = presentationReducer(createInitialPresentationState(), {
      type: 'replaceGraph',
      graph: graphFor(1, {
        'alpha.md': conceptDocument({
          type: 'note',
          title: 'Alpha',
          description: 'Initial concept.',
          body: '# Alpha\n',
        }),
      }),
    });

    state = presentationReducer(state, {
      type: 'replaceGraph',
      graph: graphFor(2, {
        'alpha.md': alpha('beta'),
        'beta.md': target('Beta', 'alpha'),
      }),
    });
    expect(state.graph?.nodes.map(({ id }) => id)).toEqual(['alpha', 'beta']);
    state = presentationReducer(state, { type: 'selectNode', nodeId: 'beta' });

    state = presentationReducer(state, {
      type: 'replaceGraph',
      graph: graphFor(3, {
        'alpha.md': alpha('beta'),
        'beta.md': target('Beta edited', 'alpha'),
      }),
    });
    expect(selectedNode(state)?.title).toBe('Beta edited');

    state = presentationReducer(state, {
      type: 'replaceGraph',
      graph: graphFor(4, {
        'alpha.md': alpha('gamma'),
        'gamma.md': target('Gamma renamed', 'alpha'),
      }),
    });
    expect(state.graph?.nodes.map(({ id }) => id)).toEqual(['alpha', 'gamma']);
    expect(state.selectedNodeId).toBeUndefined();
    state = presentationReducer(state, { type: 'selectNode', nodeId: 'gamma' });

    state = presentationReducer(state, {
      type: 'replaceGraph',
      graph: graphFor(5, {
        'alpha.md': conceptDocument({
          type: 'note',
          title: 'Alpha',
          description: 'Target deleted.',
          body: '# Alpha\n',
        }),
      }),
    });
    expect(state.graph?.nodes.map(({ id }) => id)).toEqual(['alpha']);
    expect(state.selectedNodeId).toBeUndefined();

    const afterStaleDelivery = presentationReducer(state, {
      type: 'replaceGraph',
      graph: graphFor(2, {
        'alpha.md': alpha('beta'),
        'beta.md': target('Stale Beta', 'alpha'),
      }),
    });
    expect(afterStaleDelivery).toBe(state);
    expect(afterStaleDelivery.revision).toBe(5);
  });

  it('[AC-007] previews and applies both agent outputs while preserving unrelated text', async () => {
    const { port, ui, previewer, shared } = commandHarness();
    const unrelated =
      '# Repository instructions\n\nKeep deployment approvals and security review intact.\n';
    port.putText(`${COMMAND_WORKSPACE_ROOT}/AGENTS.md`, unrelated);
    ui.selections.push('both');
    ui.confirmations.push(true);
    const setup = createSetupAgentIntegrationCommand({
      ...shared,
      selectAgentIntegrationTarget: async () => ({
        integrationRootUri: COMMAND_WORKSPACE_ROOT,
        bundlePath: 'knowledge',
      }),
    });

    expect((await setup()).kind).toBe('applied');
    const agentsText = port.text(`${COMMAND_WORKSPACE_ROOT}/AGENTS.md`);
    const skillText = port.text(
      `${COMMAND_WORKSPACE_ROOT}/.agents/skills/maintain-okf-knowledge/SKILL.md`,
    );
    expect(agentsText?.startsWith(unrelated)).toBe(true);
    expect(skillText).toContain('`knowledge/index.md`');
    expect(agentsText).toContain('When an `okf` executable is available for a local bundle');
    expect(skillText).toContain('okf validate <bundle-root> --format json');
    expect(skillText).toContain('with `--apply` instead of `--check`');
    expect(previewer.shown).toHaveLength(1);

    ui.selections.push('both');
    expect(await setup()).toEqual({ kind: 'unchanged' });
    expect(previewer.shown).toHaveLength(1);
    expect(port.text(`${COMMAND_WORKSPACE_ROOT}/AGENTS.md`)).toBe(agentsText);
    expect(
      port.text(`${COMMAND_WORKSPACE_ROOT}/.agents/skills/maintain-okf-knowledge/SKILL.md`),
    ).toBe(skillText);

    port.putText(
      `${COMMAND_WORKSPACE_ROOT}/index.md`,
      '---\nokf_version: "0.1"\n---\n# Root bundle\n',
    );
    port.putText(
      `${COMMAND_WORKSPACE_ROOT}/root-concept.md`,
      conceptDocument({
        type: 'concept',
        title: 'Root concept',
        description: 'Confirms agent controls stay outside the bundle inventory.',
      }),
    );
    const loadedRoot = await loadBundle(
      port,
      stringUriCodec,
      COMMAND_WORKSPACE_ROOT,
      COMMAND_WORKSPACE_ROOT,
    );
    const parsedRoot = parseBundle({
      rootUri: loadedRoot.rootUri,
      revision: 1,
      documents: loadedRoot.documents,
    });

    expect(loadedRoot.documents.map(({ bundlePath }) => bundlePath)).toEqual([
      'index.md',
      'root-concept.md',
    ]);
    expect(parsedRoot.concepts.map(({ id }) => id)).toEqual(['root-concept']);
    expect(
      validateBundle(parsedRoot, { now: ACCEPTANCE_NOW }).filter(
        ({ category }) => category === 'conformance',
      ),
    ).toEqual([]);
  });

  it('[AC-008] runs representative acceptance components with the fetch boundary disabled', () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('Network access is disabled for this acceptance test.');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const concept = valueOf(
      renderConceptTemplate({
        template: 'reference',
        relativePath: 'offline.md',
        type: 'offline-reference',
        title: 'Offline reference',
        description: 'Exercises local deterministic flows.',
      }),
    );
    const bundle = parseAcceptanceBundle(1, [
      ...renderedMinimalDocuments(),
      acceptanceDocument(concept.relativePath, concept.content),
    ]);
    const findings = validateBundle(bundle, { now: ACCEPTANCE_NOW });
    const indexPlan = valueOf(
      planIndexes({
        mode: 'update-all',
        concepts: [{ relativePath: concept.relativePath, title: 'Offline reference' }],
        existingIndexes: renderedMinimalDocuments().map((document) => ({
          relativePath: document.bundlePath,
          content: document.content,
        })),
      }),
    );
    const graph = buildGraphPayload(bundle);
    const presentation = presentationReducer(createInitialPresentationState(), {
      type: 'replaceGraph',
      graph,
    });
    const agentPlan = valueOf(
      planAgentIntegration({
        selection: 'both',
        bundlePath: 'knowledge',
        existingAgentsText: '# Local instructions\n',
      }),
    );

    expect(findings.filter(({ category }) => category === 'conformance')).toEqual([]);
    expect(indexPlan.mode).toBe('update-all');
    expect(presentation.graph?.statistics.conceptCount).toBe(1);
    expect(agentPlan.readyToApply).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
