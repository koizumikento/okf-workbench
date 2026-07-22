import { TextDecoder } from 'node:util';

import type { ApplyFailure, OperationProblem } from '../../core/model/index.js';
import {
  AGENT_SKILL_PATH,
  planAgentIntegration,
  type AgentIntegrationPlan,
  type AgentIntegrationSelection,
  type BundleDirectoryInput,
} from '../../core/templates/index.js';
import { sha256Content } from '../workspace/contentHash.js';
import type { WorkspaceStat } from '../workspace/types.js';
import { agentPlanToProposal } from './proposals.js';
import { problemsMessage, refuseUntrustedWorkspace, runProposalWorkflow } from './run-proposal.js';
import type {
  CommandOutcome,
  ProposalPresentation,
  ProposalPreviewSession,
  ProposalWorkflowDependencies,
  SelectAgentIntegrationTarget,
  SelectionItem,
} from './types.js';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

interface ExistingTextSnapshot {
  readonly text: string;
  readonly contentHash: string;
}

const SELECTION_ITEMS: readonly SelectionItem<AgentIntegrationSelection>[] = [
  {
    value: 'agents-md',
    label: 'AGENTS.md',
    description: 'Add or update the managed repository guidance section.',
  },
  {
    value: 'agent-skill',
    label: 'Agent Skill',
    description: `Generate ${AGENT_SKILL_PATH}.`,
  },
  {
    value: 'both',
    label: 'Both',
    description: 'Generate the managed AGENTS.md section and the Agent Skill.',
  },
];

function displayBundlePath(bundlePath: BundleDirectoryInput): string {
  return typeof bundlePath === 'string' ? bundlePath : bundlePath.relativePath;
}

export interface SetupAgentIntegrationCommandDependencies<
  TUri,
> extends ProposalWorkflowDependencies<TUri> {
  readonly selectAgentIntegrationTarget: SelectAgentIntegrationTarget<TUri>;
}

async function optionalText<TUri>(
  root: TUri,
  relativePath: string,
  dependencies: ProposalWorkflowDependencies<TUri>,
): Promise<ExistingTextSnapshot | undefined> {
  const uri = dependencies.uris.joinContained(root, relativePath);
  const stat: WorkspaceStat | undefined = await dependencies.port.stat(uri);
  if (stat === undefined) {
    return undefined;
  }
  if (stat.type !== 'file') {
    throw new Error(`${relativePath} exists but is not a file.`);
  }
  const content = await dependencies.port.read(uri);
  return {
    text: decoder.decode(content),
    contentHash: sha256Content(content),
  };
}

function replacementPresentation(presentation: ProposalPresentation): ProposalPresentation {
  return {
    title: 'Preview existing Agent Skill replacement',
    summary: [...presentation.summary, 'No file will be written until replacement is confirmed.'],
  };
}

function preflightProblems(failures: readonly ApplyFailure[]): readonly OperationProblem[] {
  return failures.map((failure) => ({
    code: failure.code,
    message: `${failure.targetUri}: ${failure.message}`,
    correctiveAction: failure.retryable
      ? 'Refresh the preview and retry.'
      : 'Repair access to the target before retrying.',
  }));
}

export function createSetupAgentIntegrationCommand<TUri>(
  dependencies: SetupAgentIntegrationCommandDependencies<TUri>,
): () => Promise<CommandOutcome> {
  return async () => {
    const trustRefusal = await refuseUntrustedWorkspace(dependencies);
    if (trustRefusal !== undefined) {
      return trustRefusal;
    }

    const target = await dependencies.selectAgentIntegrationTarget();
    if (target === undefined) {
      return { kind: 'cancelled' };
    }
    const selection = await dependencies.ui.select(
      'OKF: Set Up Agent Integration',
      'Choose project-local instruction outputs',
      SELECTION_ITEMS,
    );
    if (selection === undefined) {
      return { kind: 'cancelled' };
    }

    let existingAgents: ExistingTextSnapshot | undefined;
    let existingSkill: ExistingTextSnapshot | undefined;
    try {
      if (selection === 'agents-md' || selection === 'both') {
        existingAgents = await optionalText(target.integrationRootUri, 'AGENTS.md', dependencies);
      }
      if (selection === 'agent-skill' || selection === 'both') {
        existingSkill = await optionalText(
          target.integrationRootUri,
          AGENT_SKILL_PATH,
          dependencies,
        );
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'An integration target is unreadable.';
      await dependencies.ui.showError(
        `Agent integration could not be planned. ${message} Check the file and workspace permissions.`,
      );
      return { kind: 'failed' };
    }

    const planInput = {
      selection,
      bundlePath: target.bundlePath,
      ...(existingAgents === undefined ? {} : { existingAgentsText: existingAgents.text }),
      ...(existingSkill === undefined ? {} : { existingSkillText: existingSkill.text }),
    };
    const expectedContentHashes = new Map<string, string>();
    if (existingAgents !== undefined) {
      expectedContentHashes.set('AGENTS.md', existingAgents.contentHash);
    }
    if (existingSkill !== undefined) {
      expectedContentHashes.set(AGENT_SKILL_PATH, existingSkill.contentHash);
    }
    const initialPlan = planAgentIntegration(planInput);
    if (!initialPlan.ok) {
      await dependencies.ui.showError(
        problemsMessage('Agent integration could not be merged safely.', initialPlan.problems),
      );
      return { kind: 'refused', problems: initialPlan.problems };
    }

    const presentation: ProposalPresentation = {
      title: 'Set up OKF agent integration',
      summary: [
        `Target: ${target.label ?? dependencies.uris.serialize(target.integrationRootUri)}`,
        `Actual bundle path: ${displayBundlePath(target.bundlePath)}`,
        `Outputs: ${SELECTION_ITEMS.find((item) => item.value === selection)?.label ?? selection}`,
      ],
    };

    let finalPlan: AgentIntegrationPlan = initialPlan.value;
    let previewAlreadyShown = false;
    if (initialPlan.value.agentSkill?.status === 'replacement-required') {
      const replacementProposal = agentPlanToProposal(
        target.integrationRootUri,
        initialPlan.value,
        dependencies.uris,
        { includeReplacementRequired: true, expectedContentHashes },
      );
      const preflight = await dependencies.applicator.preflight(replacementProposal);
      if (!preflight.ready) {
        const problems = preflightProblems(preflight.failed);
        await dependencies.ui.showError(
          problemsMessage('No files were written because preflight checks failed.', problems),
        );
        return { kind: 'refused', problems };
      }

      let replacementPreview: ProposalPreviewSession;
      try {
        replacementPreview = await dependencies.previewer.show(
          replacementProposal,
          replacementPresentation(presentation),
          dependencies.port,
          dependencies.uris,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The preview could not be opened.';
        await dependencies.ui.showError(
          `No files were written because the Agent Skill preview failed. ${message}`,
        );
        return { kind: 'failed' };
      }
      previewAlreadyShown = true;

      try {
        const replace = await dependencies.ui.confirm({
          title: 'Replace existing Agent Skill?',
          detail: [
            `The existing ${AGENT_SKILL_PATH} differs from the generated Skill.`,
            'Its complete before-and-after diff has been opened.',
            'This confirmation permits replacement but does not apply any file yet.',
          ].join('\n'),
          confirmLabel: 'Permit Skill replacement',
          modeless: true,
        });
        if (!replace) {
          return { kind: 'cancelled' };
        }

        const confirmedPlan = planAgentIntegration({
          ...planInput,
          confirmSkillReplacement: true,
        });
        if (!confirmedPlan.ok) {
          await dependencies.ui.showError(
            problemsMessage(
              'Agent integration could not be merged safely.',
              confirmedPlan.problems,
            ),
          );
          return { kind: 'refused', problems: confirmedPlan.problems };
        }
        finalPlan = confirmedPlan.value;
      } finally {
        replacementPreview.dispose();
      }
    }

    const proposal = agentPlanToProposal(target.integrationRootUri, finalPlan, dependencies.uris, {
      expectedContentHashes,
    });
    const revalidateBundleWrite = dependencies.revalidateBundleWrite;
    const bundleRootUri = target.bundleRootUri;
    return runProposalWorkflow(dependencies, proposal, presentation, {
      skipPreview: previewAlreadyShown,
      ...(revalidateBundleWrite === undefined || bundleRootUri === undefined
        ? {}
        : {
            beforeApply: () => revalidateBundleWrite(bundleRootUri),
          }),
    });
  };
}
