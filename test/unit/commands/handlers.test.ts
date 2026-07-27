import { describe, expect, it } from 'vitest';

import { OKF_SEMANTIC_LIMITS } from '../../../src/core/model/index.js';
import { typescriptOkfCore } from '../../../src/core/wasm/index.js';
import { createInitializeBundleCommand } from '../../../src/extension/commands/initialize-bundle.js';
import { createNewConceptCommand } from '../../../src/extension/commands/new-concept.js';
import { SerialProposalWorkflowScheduler } from '../../../src/extension/commands/proposal-workflow-scheduler.js';
import { createRegenerateIndexesCommand } from '../../../src/extension/commands/regenerate-indexes.js';
import { createSetupAgentIntegrationCommand } from '../../../src/extension/commands/setup-agent-integration.js';
import type { CommandOutcome } from '../../../src/extension/commands/types.js';
import {
  guardBundleWriteSelection,
  inspectBundleWriteAccess,
} from '../../../src/extension/composition/bundle-inspection.js';
import { bundlePathWithinIntegrationRoot } from '../../../src/extension/composition/bundle-path.js';
import { sha256Content } from '../../../src/extension/workspace/contentHash.js';
import { ProposalApplicator } from '../../../src/extension/workspace/proposalApplicator.js';
import { WorkspaceFolderMembershipTracker } from '../../../src/extension/workspace/workspaceFolderMembership.js';
import { FakeWorkspacePort, stringUriCodec } from '../extension-workspace/fakes.js';
import {
  captureOpenWorkspaceFolderMembership,
  FakeCommandUi,
  FakeProposalPreviewer,
} from './fakes.js';

const workspaceRoot = 'memfs://workspace';
const bundleRoot = `${workspaceRoot}/knowledge`;
const encoder = new TextEncoder();
const writableBundleSelection = {
  bundleRootUri: bundleRoot,
  workspaceSafetyRootUri: workspaceRoot,
} as const;

function exactUtf8Prefix(suffix: string): string {
  const remaining = OKF_SEMANTIC_LIMITS.maxProviderPathBytes - encoder.encode(suffix).byteLength;
  const multibyteCount = Math.floor(remaining / 3);
  return `${'雪'.repeat(multibyteCount)}${'a'.repeat(remaining - multibyteCount * 3)}`;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function utf8BomText(text: string): Uint8Array {
  const encoded = encoder.encode(text);
  return Uint8Array.from([0xef, 0xbb, 0xbf, ...encoded]);
}

function expectUtf8Bom(content: Uint8Array | undefined): void {
  expect(content?.slice(0, 3)).toEqual(Uint8Array.from([0xef, 0xbb, 0xbf]));
}

function harness(port = new FakeWorkspacePort()) {
  port.putDirectory(workspaceRoot);
  port.putDirectory(bundleRoot);
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

describe('authoring command handlers', () => {
  it.each([
    {
      command: 'Initialize Bundle',
      prepare(ui: FakeCommandUi) {
        ui.inputs.push('knowledge');
        ui.selections.push('minimal');
      },
      expectedTarget: `${bundleRoot}/index.md`,
    },
    {
      command: 'New Concept',
      prepare(ui: FakeCommandUi) {
        ui.selections.push('generic-concept');
        ui.inputs.push('.', 'concept', 'Membership guarded concept', '', '', 'concept.md');
      },
      expectedTarget: `${bundleRoot}/concept.md`,
    },
    {
      command: 'Regenerate Indexes',
      prepare(ui: FakeCommandUi, port: FakeWorkspacePort) {
        port.putText(`${bundleRoot}/alpha.md`, '---\ntype: concept\ntitle: Alpha\n---\n# Alpha\n');
        ui.selections.push('missing-indexes-only');
      },
      expectedTarget: `${bundleRoot}/index.md`,
    },
    {
      command: 'Set Up Agent Integration',
      prepare(ui: FakeCommandUi) {
        ui.selections.push('agents-md');
      },
      expectedTarget: `${workspaceRoot}/AGENTS.md`,
    },
  ])(
    'routes $command through exact workspace membership invalidation',
    async ({ command, prepare, expectedTarget }) => {
      const { port, ui, previewer, shared } = harness();
      let openFolders: readonly string[] = [workspaceRoot, 'memfs://other'];
      const tracker = new WorkspaceFolderMembershipTracker(stringUriCodec, () => openFolders);
      const guardedShared = {
        ...shared,
        captureWorkspaceFolderMembership: (root: string) => tracker.capture(root),
      };

      prepare(ui, port);
      const stat = port.stat.bind(port);
      let invalidated = false;
      let targetStats = 0;
      port.stat = async (uri) => {
        const result = await stat(uri);
        if (uri === expectedTarget) {
          targetStats += 1;
        }
        const invalidationStat = command === 'Set Up Agent Integration' ? 2 : 1;
        if (!invalidated && targetStats === invalidationStat) {
          invalidated = true;
          openFolders = ['memfs://other'];
          tracker.handleWorkspaceFoldersChanged({ removed: [workspaceRoot] });
          // Re-adding the same URI cannot authorize a create admitted before removal.
          openFolders = [workspaceRoot, 'memfs://other'];
        }
        return result;
      };
      let authoringCommand: () => Promise<CommandOutcome>;
      if (command === 'Initialize Bundle') {
        authoringCommand = createInitializeBundleCommand({
          ...guardedShared,
          selectInitializationTarget: async () => ({
            targetRootUri: workspaceRoot,
            workspaceSafetyRootUri: workspaceRoot,
            label: 'workspace',
            suggestedBundleDirectory: 'knowledge',
          }),
          selectInitializedBundle: () => undefined,
          now: () => '2026-07-22T10:00:00+09:00',
        });
      } else if (command === 'New Concept') {
        authoringCommand = createNewConceptCommand({
          ...guardedShared,
          selectBundle: async () => writableBundleSelection,
        });
      } else if (command === 'Regenerate Indexes') {
        authoringCommand = createRegenerateIndexesCommand({
          ...guardedShared,
          selectBundle: async () => writableBundleSelection,
        });
      } else {
        authoringCommand = createSetupAgentIntegrationCommand({
          ...guardedShared,
          selectAgentIntegrationTarget: async () => ({
            integrationRootUri: workspaceRoot,
            bundlePath: 'knowledge',
          }),
        });
      }

      const result = await authoringCommand();

      expect(result).toMatchObject({
        kind: 'refused',
        problems: [{ code: 'workspace-folder-unavailable', uri: workspaceRoot }],
      });
      expect(port.text(expectedTarget)).toBeUndefined();
      expect(port.writes).toEqual([]);
      expect(previewer.shown).toEqual([]);
      expect(previewer.releasedSessions).toBe(0);
    },
  );

  it('fails same- and cross-command concurrency before selection, reads, or planning', async () => {
    const { port, ui, previewer, shared } = harness();
    const inputStarted = deferred<undefined>();
    const inputResult = deferred<string | undefined>();
    ui.input = async () => {
      inputStarted.resolve(undefined);
      return inputResult.promise;
    };

    const calls = {
      initializeTarget: 0,
      conceptBundle: 0,
      indexBundle: 0,
      indexPlan: 0,
      agentTarget: 0,
    };
    const initialize = createInitializeBundleCommand({
      ...shared,
      selectInitializationTarget: async () => {
        calls.initializeTarget += 1;
        return {
          targetRootUri: workspaceRoot,
          workspaceSafetyRootUri: workspaceRoot,
          label: 'workspace',
          suggestedBundleDirectory: 'knowledge',
        };
      },
      selectInitializedBundle: () => undefined,
      now: () => '2026-07-22T10:00:00+09:00',
    });
    const newConcept = createNewConceptCommand({
      ...shared,
      selectBundle: async () => {
        calls.conceptBundle += 1;
        return writableBundleSelection;
      },
    });
    const regenerate = createRegenerateIndexesCommand({
      ...shared,
      selectBundle: async () => {
        calls.indexBundle += 1;
        return writableBundleSelection;
      },
      collectIndexSource: async () => {
        calls.indexPlan += 1;
        return { ok: true, value: { concepts: [], existingIndexes: [] }, warnings: [] };
      },
    });
    const setupAgent = createSetupAgentIntegrationCommand({
      ...shared,
      selectAgentIntegrationTarget: async () => {
        calls.agentTarget += 1;
        return { integrationRootUri: workspaceRoot, bundlePath: 'knowledge' };
      },
    });

    const active = initialize();
    await inputStarted.promise;
    const readsWhileActive = port.reads.length;
    const writesWhileActive = port.writes.length;
    const busyCommands = [initialize, newConcept, regenerate, setupAgent] as const;
    const busyResults = await Promise.all(
      Array.from({ length: 100 }, (_, index) => busyCommands[index % busyCommands.length]?.()),
    );

    expect(
      busyResults.every(
        (result) =>
          result?.kind === 'refused' &&
          result.problems.some((problem) => problem.code === 'proposal-workflow-busy'),
      ),
    ).toBe(true);
    expect(calls).toEqual({
      initializeTarget: 1,
      conceptBundle: 0,
      indexBundle: 0,
      indexPlan: 0,
      agentTarget: 0,
    });
    expect(port.reads).toHaveLength(readsWhileActive);
    expect(port.writes).toHaveLength(writesWhileActive);
    expect(previewer.shown).toEqual([]);
    expect(ui.confirmationRequests).toEqual([]);
    expect(ui.warnings).toHaveLength(1);

    inputResult.resolve(undefined);
    await expect(active).resolves.toEqual({ kind: 'cancelled' });
    ui.input = async () => ui.inputs.shift();
    ui.selections.push('agent-skill');
    await expect(setupAgent()).resolves.toMatchObject({ kind: 'applied' });
    expect(calls.agentTarget).toBe(1);
    expect(previewer.shown).toEqual([]);
  });

  it('releases the public-command gate when an active command throws', async () => {
    const { ui, previewer, shared } = harness();
    const inputStarted = deferred<undefined>();
    const inputResult = deferred<string | undefined>();
    ui.input = async () => {
      inputStarted.resolve(undefined);
      return inputResult.promise;
    };
    let initializeSelections = 0;
    const initialize = createInitializeBundleCommand({
      ...shared,
      selectInitializationTarget: async () => {
        initializeSelections += 1;
        return {
          targetRootUri: workspaceRoot,
          workspaceSafetyRootUri: workspaceRoot,
          label: 'workspace',
          suggestedBundleDirectory: 'knowledge',
        };
      },
      selectInitializedBundle: () => undefined,
      now: () => '2026-07-22T10:00:00+09:00',
    });
    const failed = initialize();
    await inputStarted.promise;

    inputResult.reject(new Error('Input host failed.'));
    await expect(failed).rejects.toThrow('Input host failed.');
    ui.input = async () => ui.inputs.shift();
    ui.inputs.push('knowledge');
    ui.selections.push('minimal');
    await expect(initialize()).resolves.toMatchObject({ kind: 'applied' });

    expect(initializeSelections).toBe(2);
    expect(previewer.shown).toEqual([]);
    expect(previewer.releasedSessions).toBe(0);
  });

  it('initializes all three create-only presets without approval and selects the root', async () => {
    for (const preset of ['minimal', 'software-project', 'data-analytics'] as const) {
      const { port, ui, previewer, shared } = harness();
      ui.inputs.push('knowledge');
      ui.selections.push(preset);
      const selected: string[] = [];
      const command = createInitializeBundleCommand({
        ...shared,
        selectInitializationTarget: async () => ({
          targetRootUri: workspaceRoot,
          workspaceSafetyRootUri: workspaceRoot,
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
      expect(previewer.shown).toEqual([]);
      expect(ui.confirmationRequests).toEqual([]);
    }
  });

  it('releases the write gate while post-create bundle selection is still pending', async () => {
    const { port, ui, shared } = harness();
    const selectionStarted = deferred<undefined>();
    const selectionFinished = deferred<undefined>();
    ui.inputs.push('knowledge');
    ui.selections.push('minimal');
    const initialize = createInitializeBundleCommand({
      ...shared,
      selectInitializationTarget: async () => ({
        targetRootUri: workspaceRoot,
        workspaceSafetyRootUri: workspaceRoot,
        label: 'workspace',
        suggestedBundleDirectory: 'knowledge',
      }),
      selectInitializedBundle: async () => {
        selectionStarted.resolve(undefined);
        await selectionFinished.promise;
      },
      now: () => '2026-07-22T10:00:00+09:00',
    });

    await expect(initialize()).resolves.toMatchObject({ kind: 'applied' });
    await selectionStarted.promise;

    ui.selections.push('generic-concept');
    ui.inputs.push('.', 'concept', 'Created while selection is pending', '', '', 'next.md');
    const newConcept = createNewConceptCommand({
      ...shared,
      selectBundle: async () => writableBundleSelection,
    });
    await expect(newConcept()).resolves.toMatchObject({ kind: 'applied' });

    expect(port.text(`${bundleRoot}/next.md`)).toContain(
      'title: "Created while selection is pending"',
    );
    expect(ui.warnings).toEqual([]);
    selectionFinished.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
  });

  it('refuses an initialization collision without requesting approval', async () => {
    const { port, ui, previewer, shared } = harness();
    port.putText(`${bundleRoot}/index.md`, 'existing bundle\n');
    ui.inputs.push('knowledge');
    ui.selections.push('minimal');
    const selected: string[] = [];
    const command = createInitializeBundleCommand({
      ...shared,
      selectInitializationTarget: async () => ({
        targetRootUri: workspaceRoot,
        workspaceSafetyRootUri: workspaceRoot,
        label: 'workspace',
        suggestedBundleDirectory: 'knowledge',
      }),
      selectInitializedBundle: (uri) => {
        selected.push(uri);
      },
      now: () => '2026-07-22T10:00:00+09:00',
    });

    await expect(command()).resolves.toMatchObject({
      kind: 'failed',
      report: { failed: [{ code: 'collision' }] },
    });
    expect(port.writes).toEqual([]);
    expect(selected).toEqual([]);
    expect(ui.opened).toEqual([]);
    expect(previewer.shown).toEqual([]);
    expect(ui.confirmationRequests).toEqual([]);
    expect(ui.errors[0]).toContain('already exists');
  });

  it('creates at the exact initialization path boundary and refuses +1 before workspace I/O', async () => {
    const exactDirectory = 'a'.repeat(
      OKF_SEMANTIC_LIMITS.maxProviderPathCodeUnits - '/index.md'.length,
    );
    const exactHarness = harness();
    exactHarness.ui.inputs.push(exactDirectory);
    exactHarness.ui.selections.push('minimal');
    const exactCommand = createInitializeBundleCommand({
      ...exactHarness.shared,
      selectInitializationTarget: async () => ({
        targetRootUri: workspaceRoot,
        workspaceSafetyRootUri: workspaceRoot,
        label: 'workspace',
        suggestedBundleDirectory: 'knowledge',
      }),
      selectInitializedBundle: () => undefined,
      now: () => '2026-07-22T10:00:00+09:00',
    });

    await expect(exactCommand()).resolves.toMatchObject({ kind: 'applied' });
    expect(`${exactDirectory}/index.md`).toHaveLength(OKF_SEMANTIC_LIMITS.maxProviderPathCodeUnits);
    expect(exactHarness.previewer.shown).toEqual([]);
    expect(exactHarness.port.writes).toEqual([`${workspaceRoot}/${exactDirectory}/index.md`]);

    const exceededHarness = harness();
    exceededHarness.ui.inputs.push(`${exactDirectory}a`);
    exceededHarness.ui.selections.push('minimal');
    const exceededCommand = createInitializeBundleCommand({
      ...exceededHarness.shared,
      selectInitializationTarget: async () => ({
        targetRootUri: workspaceRoot,
        workspaceSafetyRootUri: workspaceRoot,
        label: 'workspace',
        suggestedBundleDirectory: 'knowledge',
      }),
      selectInitializedBundle: () => undefined,
      now: () => '2026-07-22T10:00:00+09:00',
    });

    expect(await exceededCommand()).toMatchObject({
      kind: 'refused',
      problems: [{ code: 'unsafe-relative-path' }],
    });
    expect(exceededHarness.previewer.shown).toEqual([]);
    expect(exceededHarness.port.writes).toEqual([]);
  });

  it('enforces the exact UTF-8 initialization output path and its first byte overage', async () => {
    const exactDirectory = exactUtf8Prefix('/index.md');
    const exactHarness = harness();
    exactHarness.ui.inputs.push(exactDirectory);
    exactHarness.ui.selections.push('minimal');
    const exactCommand = createInitializeBundleCommand({
      ...exactHarness.shared,
      selectInitializationTarget: async () => ({
        targetRootUri: workspaceRoot,
        workspaceSafetyRootUri: workspaceRoot,
        label: 'workspace',
        suggestedBundleDirectory: 'knowledge',
      }),
      selectInitializedBundle: () => undefined,
      now: () => '2026-07-22T10:00:00+09:00',
    });

    await expect(exactCommand()).resolves.toMatchObject({ kind: 'applied' });
    expect(encoder.encode(`${exactDirectory}/index.md`)).toHaveLength(
      OKF_SEMANTIC_LIMITS.maxProviderPathBytes,
    );
    expect(exactHarness.previewer.shown).toEqual([]);

    const exceededHarness = harness();
    exceededHarness.ui.inputs.push(`${exactDirectory}a`);
    exceededHarness.ui.selections.push('minimal');
    const exceededCommand = createInitializeBundleCommand({
      ...exceededHarness.shared,
      selectInitializationTarget: async () => ({
        targetRootUri: workspaceRoot,
        workspaceSafetyRootUri: workspaceRoot,
        label: 'workspace',
        suggestedBundleDirectory: 'knowledge',
      }),
      selectInitializedBundle: () => undefined,
      now: () => '2026-07-22T10:00:00+09:00',
    });

    expect(await exceededCommand()).toMatchObject({
      kind: 'refused',
      problems: [{ code: 'unsafe-relative-path' }],
    });
    expect(exceededHarness.previewer.shown).toEqual([]);
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
        workspaceSafetyRootUri: workspaceRoot,
        label: 'workspace',
        suggestedBundleDirectory: 'knowledge',
      }),
      selectInitializedBundle: () => undefined,
      now: () => '2026-07-22T10:00:00+09:00',
    });

    const result = await command();

    expect(result).toMatchObject({ kind: 'failed' });
    expect(port.writes).toEqual([]);
    expect(previewer.shown).toEqual([]);
    expect(ui.errors[0]).toContain('symbolic-link path segment');
  });

  it('reports an actionable error when the generated root index cannot be opened', async () => {
    const { port, ui, shared } = harness();
    ui.inputs.push('knowledge');
    ui.selections.push('minimal');
    ui.openFailure = new Error('Editor unavailable');
    const selected: string[] = [];
    const command = createInitializeBundleCommand({
      ...shared,
      selectInitializationTarget: async () => ({
        targetRootUri: workspaceRoot,
        workspaceSafetyRootUri: workspaceRoot,
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
      selectBundle: async () => writableBundleSelection,
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
    const command = createNewConceptCommand({
      ...shared,
      selectBundle: async () => writableBundleSelection,
    });

    const result = await command();

    const target = `${bundleRoot}/experiments/result.md`;
    expect(result.kind).toBe('applied');
    expect(port.text(target)).toContain('type: "experiment-result"');
    expect(port.text(target)).toContain('description: "Description"');
    expect(port.text(target)).toContain('tags:\n  - "test"\n  - "result"');
    expect(ui.opened).toEqual([target]);
    expect(ui.confirmationRequests).toEqual([]);
  });

  it('releases the write gate while VS Code is still opening the created concept', async () => {
    const { port, ui, shared } = harness();
    const firstOpen = deferred<undefined>();
    const firstTarget = `${bundleRoot}/first.md`;
    const secondTarget = `${bundleRoot}/second.md`;
    ui.selections.push('generic-concept', 'generic-concept');
    ui.inputs.push(
      '.',
      'concept',
      'First',
      '',
      '',
      'first.md',
      '.',
      'concept',
      'Second',
      '',
      '',
      'second.md',
    );
    ui.confirmations.push(true, true);
    ui.openDocument = async (uri) => {
      ui.opened.push(uri);
      if (uri === firstTarget) {
        await firstOpen.promise;
      }
    };
    const command = createNewConceptCommand({
      ...shared,
      selectBundle: async () => writableBundleSelection,
    });

    await expect(command()).resolves.toMatchObject({ kind: 'applied' });
    expect(ui.opened).toEqual([firstTarget]);

    await expect(command()).resolves.toMatchObject({ kind: 'applied' });

    expect(port.text(firstTarget)).toContain('title: "First"');
    expect(port.text(secondTarget)).toContain('title: "Second"');
    expect(ui.opened).toEqual([firstTarget, secondTarget]);
    expect(ui.warnings).toEqual([]);
    firstOpen.resolve(undefined);
  });

  it('creates at the exact concept path boundary and refuses a combined +1 path', async () => {
    const exactDestination = 'd'.repeat(
      OKF_SEMANTIC_LIMITS.maxProviderPathCodeUnits - '/a.md'.length,
    );
    const exactHarness = harness();
    exactHarness.ui.selections.push('generic-concept');
    exactHarness.ui.inputs.push(exactDestination, 'concept', 'Exact path', '', '', 'a.md');
    const exactCommand = createNewConceptCommand({
      ...exactHarness.shared,
      selectBundle: async () => writableBundleSelection,
    });

    await expect(exactCommand()).resolves.toMatchObject({ kind: 'applied' });
    expect(`${exactDestination}/a.md`).toHaveLength(OKF_SEMANTIC_LIMITS.maxProviderPathCodeUnits);
    expect(exactHarness.previewer.shown).toEqual([]);
    expect(exactHarness.port.writes).toEqual([`${bundleRoot}/${exactDestination}/a.md`]);

    const exceededHarness = harness();
    exceededHarness.ui.selections.push('generic-concept');
    exceededHarness.ui.inputs.push(
      `${exactDestination}d`,
      'concept',
      'Exceeded path',
      '',
      '',
      'a.md',
    );
    const exceededCommand = createNewConceptCommand({
      ...exceededHarness.shared,
      selectBundle: async () => writableBundleSelection,
    });

    expect(await exceededCommand()).toMatchObject({
      kind: 'refused',
      problems: [{ code: 'unsafe-relative-path' }],
    });
    expect(exceededHarness.previewer.shown).toEqual([]);
    expect(exceededHarness.port.writes).toEqual([]);
  });

  it('enforces the exact UTF-8 concept output path and its first byte overage', async () => {
    const exactDestination = exactUtf8Prefix('/a.md');
    const exactHarness = harness();
    exactHarness.ui.selections.push('generic-concept');
    exactHarness.ui.inputs.push(exactDestination, 'concept', 'Exact UTF-8 path', '', '', 'a.md');
    const exactCommand = createNewConceptCommand({
      ...exactHarness.shared,
      selectBundle: async () => writableBundleSelection,
    });

    await expect(exactCommand()).resolves.toMatchObject({ kind: 'applied' });
    expect(encoder.encode(`${exactDestination}/a.md`)).toHaveLength(
      OKF_SEMANTIC_LIMITS.maxProviderPathBytes,
    );
    expect(exactHarness.previewer.shown).toEqual([]);

    const exceededHarness = harness();
    exceededHarness.ui.selections.push('generic-concept');
    exceededHarness.ui.inputs.push(
      `${exactDestination}a`,
      'concept',
      'Exceeded UTF-8 path',
      '',
      '',
      'a.md',
    );
    const exceededCommand = createNewConceptCommand({
      ...exceededHarness.shared,
      selectBundle: async () => writableBundleSelection,
    });

    expect(await exceededCommand()).toMatchObject({
      kind: 'refused',
      problems: [{ code: 'unsafe-relative-path' }],
    });
    expect(exceededHarness.previewer.shown).toEqual([]);
  });

  it('refuses concept creation through a symlinked destination directory', async () => {
    const { port, ui, previewer, shared } = harness();
    port.putDirectory(bundleRoot);
    port.putSymbolicLink(`${bundleRoot}/linked`);
    ui.selections.push('generic-concept');
    ui.inputs.push('linked', 'concept', 'Unsafe target', '', '', 'outside.md');
    const command = createNewConceptCommand({
      ...shared,
      selectBundle: async () => writableBundleSelection,
    });

    const result = await command();

    expect(result).toMatchObject({ kind: 'failed' });
    expect(port.writes).toEqual([]);
    expect(previewer.shown).toEqual([]);
    expect(ui.opened).toEqual([]);
  });

  it('does not invent optional description or tags for blank or whitespace-only input', async () => {
    const { port, ui, shared } = harness();
    ui.selections.push('generic-concept');
    ui.inputs.push('.', 'concept', 'Minimal metadata', ' \t ', ' ,  , ', 'minimal.md');
    const command = createNewConceptCommand({
      ...shared,
      selectBundle: async () => writableBundleSelection,
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
      selectBundle: async () => writableBundleSelection,
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
      selectBundle: async () => writableBundleSelection,
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
      selectBundle: async () => writableBundleSelection,
    });

    const result = await command();

    expect(result.kind).toBe('applied');
    expect(previewer.shown[0]?.proposal.changes[0]?.expected).toEqual({
      kind: 'sha256',
      value: sha256Content(original),
      byteLength: original.byteLength,
    });
    const updated = port.files.get(`${bundleRoot}/index.md`);
    expectUtf8Bom(updated);
    expect(new TextDecoder('utf-8').decode(updated)).toContain('[Alpha](./alpha.md)');

    const writeCount = port.writes.length;
    ui.selections.push('update-all');
    await expect(command()).resolves.toEqual({ kind: 'unchanged' });
    expect(port.writes).toHaveLength(writeCount);
    expect(previewer.shown).toHaveLength(1);
  });

  it('refuses undecodable index bytes without omitting or rewriting them', async () => {
    const { port, ui, previewer, shared } = harness();
    const target = `${bundleRoot}/index.md`;
    const original = Uint8Array.from([0xff, 0xfe, 0xfd]);
    port.files.set(target, original);
    ui.selections.push('update-all');
    const command = createRegenerateIndexesCommand({
      ...shared,
      selectBundle: async () => writableBundleSelection,
    });

    const result = await command();

    expect(result.kind).toBe('refused');
    expect(previewer.shown).toEqual([]);
    expect(port.writes).toEqual([]);
    expect(port.files.get(target)).toEqual(original);
    expect(ui.errors[0]).toContain('Indexes could not be planned safely');
  });

  it('refuses a double-BOM index before planning or duplicating its frontmatter', async () => {
    const { port, ui, previewer, shared } = harness();
    const target = `${bundleRoot}/index.md`;
    const source = encoder.encode('---\nokf_version: "0.1"\n---\n# Knowledge\n');
    const original = Uint8Array.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, ...source]);
    port.files.set(target, original);
    port.putText(`${bundleRoot}/alpha.md`, '---\ntype: reference\n---\n# Alpha\n');
    ui.selections.push('update-all');
    const command = createRegenerateIndexesCommand({
      ...shared,
      selectBundle: async () => writableBundleSelection,
    });

    const result = await command();

    expect(result).toMatchObject({
      kind: 'refused',
      problems: [
        {
          code: 'index-source-parse-failed',
          message: expect.stringContaining('at most one leading byte-order mark'),
        },
      ],
    });
    expect(previewer.shown).toEqual([]);
    expect(port.writes).toEqual([]);
    expect(port.files.get(target)).toEqual(original);
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(original)).toContain(
      'okf_version: "0.1"',
    );
  });

  it('allows index regeneration to synthesize an explicitly selected missing root index', async () => {
    const { port, ui, shared } = harness();
    port.putDirectory(bundleRoot);
    port.putText(
      `${bundleRoot}/alpha.md`,
      '---\ntype: reference\ntitle: Alpha\ndescription: Existing knowledge\n---\n# Alpha\n',
    );
    ui.selections.push('missing-indexes-only');
    ui.confirmations.push(true);
    const command = createRegenerateIndexesCommand({
      ...shared,
      selectBundle: async () =>
        guardBundleWriteSelection(writableBundleSelection, port, stringUriCodec, async (problem) =>
          ui.showError(problem.message),
        ),
    });

    const result = await command();

    expect(result.kind).toBe('applied');
    expect(port.text(`${bundleRoot}/index.md`)).toContain('okf_version: "0.1"');
    expect(port.text(`${bundleRoot}/index.md`)).toContain('[Alpha](./alpha.md)');
  });

  it('previews, safely versions, and idempotently regenerates a versionless existing root', async () => {
    const { port, ui, previewer, shared } = harness();
    port.putDirectory(bundleRoot);
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
      guardBundleWriteSelection(writableBundleSelection, port, stringUriCodec, async (problem) =>
        ui.showError(problem.message),
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
      selectBundle: async () => writableBundleSelection,
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

  it('previews an existing Skill once and cancels its tied replacement-and-apply decision', async () => {
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
    expect(ui.confirmationRequests[0]?.confirmLabel).toBe('Replace Agent Skill and apply');
    expect(ui.confirmationRequests[0]?.previewIdentity).toEqual(previewer.shown[0]?.identity);
    expect(ui.confirmationRequests[0]?.modeless).toBe(true);
    expect(port.writes).toEqual([]);
    expect(port.text(`${workspaceRoot}/.agents/skills/maintain-okf-knowledge/SKILL.md`)).toBe(
      'owned\n',
    );
  });

  it('keeps the exact replacement preview alive through confirmation and application', async () => {
    const { port, ui, previewer, shared } = harness();
    const skillUri = `${workspaceRoot}/.agents/skills/maintain-okf-knowledge/SKILL.md`;
    port.putText(skillUri, 'owned\n');
    ui.selections.push('agent-skill');
    ui.confirmations.push(true);
    port.beforeWrite = () => {
      expect(previewer.releasedSessions).toBe(0);
      expect(ui.confirmationRequests[0]?.previewIdentity).toEqual(previewer.shown[0]?.identity);
    };
    const command = createSetupAgentIntegrationCommand({
      ...shared,
      selectAgentIntegrationTarget: async () => ({
        integrationRootUri: workspaceRoot,
        bundlePath: 'knowledge',
      }),
    });

    const result = await command();

    expect(result).toMatchObject({ kind: 'applied' });
    expect(previewer.shown).toHaveLength(1);
    expect(ui.confirmationRequests).toHaveLength(1);
    expect(ui.confirmationRequests[0]?.confirmLabel).toBe('Replace Agent Skill and apply');
    expect(previewer.releasedSessions).toBe(1);
    expect(port.text(skillUri)).not.toBe('owned\n');
    expect(port.text(skillUri)).toContain('name: maintain-okf-knowledge');
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

    expect(result).toMatchObject({ kind: 'failed' });
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
    expect(previewer.shown).toEqual([]);
    expect(ui.confirmationRequests).toEqual([]);
  });

  it('creates at the exact agent bundle path boundary and refuses +1 before workspace reads', async () => {
    const exactPath = 'b'.repeat(OKF_SEMANTIC_LIMITS.maxProviderPathCodeUnits);
    const exactHarness = harness();
    exactHarness.ui.selections.push('both');
    const exactCommand = createSetupAgentIntegrationCommand({
      ...exactHarness.shared,
      selectAgentIntegrationTarget: async () => ({
        integrationRootUri: workspaceRoot,
        bundlePath: { pathIdentity: 'provider', relativePath: exactPath },
      }),
    });

    await expect(exactCommand()).resolves.toMatchObject({ kind: 'applied' });
    expect(exactHarness.previewer.shown).toEqual([]);
    expect(exactHarness.ui.confirmationRequests).toEqual([]);
    expect(exactHarness.port.writes).toHaveLength(2);

    const exceededHarness = harness();
    exceededHarness.ui.selections.push('both');
    const exceededCommand = createSetupAgentIntegrationCommand({
      ...exceededHarness.shared,
      selectAgentIntegrationTarget: async () => ({
        integrationRootUri: workspaceRoot,
        bundlePath: { pathIdentity: 'provider', relativePath: `${exactPath}b` },
      }),
    });

    expect(await exceededCommand()).toMatchObject({
      kind: 'refused',
      problems: [{ code: 'unsafe-relative-path' }],
    });
    expect(exceededHarness.port.reads).toEqual([]);
    expect(exceededHarness.previewer.shown).toEqual([]);
    expect(exceededHarness.port.writes).toEqual([]);
  });

  it('enforces the exact UTF-8 agent bundle path and its first byte overage before reads', async () => {
    const exactPath = exactUtf8Prefix('');
    const exactHarness = harness();
    exactHarness.ui.selections.push('both');
    const exactCommand = createSetupAgentIntegrationCommand({
      ...exactHarness.shared,
      selectAgentIntegrationTarget: async () => ({
        integrationRootUri: workspaceRoot,
        bundlePath: { pathIdentity: 'provider', relativePath: exactPath },
      }),
    });

    await expect(exactCommand()).resolves.toMatchObject({ kind: 'applied' });
    expect(encoder.encode(exactPath)).toHaveLength(OKF_SEMANTIC_LIMITS.maxProviderPathBytes);
    expect(exactHarness.previewer.shown).toEqual([]);
    expect(exactHarness.ui.confirmationRequests).toEqual([]);

    const exceededHarness = harness();
    exceededHarness.ui.selections.push('both');
    const exceededCommand = createSetupAgentIntegrationCommand({
      ...exceededHarness.shared,
      selectAgentIntegrationTarget: async () => ({
        integrationRootUri: workspaceRoot,
        bundlePath: { pathIdentity: 'provider', relativePath: `${exactPath}a` },
      }),
    });

    expect(await exceededCommand()).toMatchObject({
      kind: 'refused',
      problems: [{ code: 'unsafe-relative-path' }],
    });
    expect(exceededHarness.port.reads).toEqual([]);
    expect(exceededHarness.previewer.shown).toEqual([]);
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
      byteLength: original.byteLength,
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
    port.putDirectory(bundleRoot);
    port.putText(`${bundleRoot}/index.md`, '---\nokf_version: "1.0"\n---\n# Future bundle\n');
    const refuse = async (problem: { readonly code: string; readonly message: string }) => {
      await ui.showError(`Write operation refused. ${problem.message}`);
    };
    const selectWritableBundle = async () =>
      guardBundleWriteSelection(writableBundleSelection, port, stringUriCodec, refuse);

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

  it('refuses a create-only concept write when the bundle becomes unsupported before apply', async () => {
    const { port, ui, previewer, shared } = harness();
    port.putDirectory(bundleRoot);
    const rootIndex = `${bundleRoot}/index.md`;
    const target = `${bundleRoot}/concept.md`;
    port.putText(rootIndex, '---\nokf_version: "0.1"\n---\n# Knowledge\n');
    ui.selections.push('generic-concept');
    ui.inputs.push('.', 'concept', 'Safe until approval', '', '', 'concept.md');

    const command = createNewConceptCommand({
      ...shared,
      selectBundle: async () => writableBundleSelection,
      revalidateBundleWrite: async (root) => {
        port.putText(rootIndex, '---\nokf_version: "1.0"\n---\n# Changed bundle\n');
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
    expect(previewer.shown).toEqual([]);
    expect(previewer.releasedSessions).toBe(0);
  });

  it('revalidates the selected bundle before applying agent integration outside that bundle', async () => {
    const { port, ui, shared } = harness();
    port.putText(`${bundleRoot}/index.md`, '---\nokf_version: "0.1"\n---\n# Knowledge\n');
    ui.selections.push('agents-md');
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
