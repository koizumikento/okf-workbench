import { TextDecoder } from 'node:util';

import {
  AGENTS_END_MARKER,
  AGENTS_START_MARKER,
  AGENT_SKILL_PATH,
  normalizeBundleDirectory,
  preserveProviderBundleDirectory,
  type AgentIntegrationPlan,
  type AgentIntegrationSelection,
  type BundleDirectoryInput,
} from '../../core/templates/index.js';
import { mergeManagedRegion } from '../../core/indexes/index.js';
import type { OperationResult } from '../../core/model/index.js';
import type { OkfCore } from '../../core/wasm/index.js';
import { sha256Content } from '../workspace/contentHash.js';
import {
  captureWorkspaceOptionalResourceParentChain,
  verifyWorkspaceDirectoryChain,
} from '../workspace/directorySafety.js';
import { BUNDLE_READ_LIMITS, readWorkspaceFileWithinLimit } from '../workspace/readSafety.js';
import type { WorkspaceStat } from '../workspace/types.js';
import { agentPlanToProposal } from './proposals.js';
import {
  problemsMessage,
  refuseUntrustedWorkspace,
  runProposalCommand,
  runProposalWorkflow,
} from './run-proposal.js';
import type {
  CommandOutcome,
  ProposalPresentation,
  ProposalWorkflowDependencies,
  ProposalWorkflowLease,
  SelectAgentIntegrationTarget,
  SelectionItem,
} from './types.js';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

interface ExistingTextSnapshot {
  readonly text: string;
  readonly contentHash: string;
  readonly contentByteLength: number;
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

function planAgentIntegrationWithCore(
  core: OkfCore,
  input: {
    readonly selection: AgentIntegrationSelection;
    readonly bundlePath: BundleDirectoryInput;
    readonly existingAgentsText?: string;
    readonly existingSkillText?: string;
  },
): OperationResult<AgentIntegrationPlan> {
  const target =
    input.selection === 'agents-md'
      ? 'agents'
      : input.selection === 'agent-skill'
        ? 'skill'
        : 'both';
  const files = core.renderAgent(target, input.bundlePath);
  const agents = files.find((file) => file.relativePath === 'AGENTS.md');
  const skill = files.find((file) => file.relativePath === AGENT_SKILL_PATH);
  let agentsFile: AgentIntegrationPlan['agentsFile'];
  if (agents !== undefined) {
    if (input.existingAgentsText === undefined) {
      agentsFile = {
        relativePath: 'AGENTS.md',
        status: 'create',
        proposedText: agents.content,
      };
    } else {
      const merged = mergeManagedRegion({
        existingText: input.existingAgentsText,
        renderedRegion: agents.content,
        markers: {
          start: AGENTS_START_MARKER,
          end: AGENTS_END_MARKER,
          name: 'AGENTS.md',
        },
        appendWhenMissing: true,
      });
      if (!merged.ok) return merged;
      agentsFile = {
        relativePath: 'AGENTS.md',
        status: merged.value === input.existingAgentsText ? 'unchanged' : 'update',
        proposedText: merged.value,
        previousText: input.existingAgentsText,
      };
    }
  }
  let agentSkill: AgentIntegrationPlan['agentSkill'];
  if (skill !== undefined) {
    agentSkill =
      input.existingSkillText === undefined
        ? {
            relativePath: AGENT_SKILL_PATH,
            status: 'create',
            proposedText: skill.content,
          }
        : input.existingSkillText === skill.content
          ? {
              relativePath: AGENT_SKILL_PATH,
              status: 'unchanged',
              proposedText: skill.content,
              previousText: input.existingSkillText,
            }
          : {
              relativePath: AGENT_SKILL_PATH,
              status: 'replacement-required',
              proposedText: skill.content,
              previousText: input.existingSkillText,
            };
  }
  return {
    ok: true,
    value: {
      selection: input.selection,
      ...(agentsFile === undefined ? {} : { agentsFile }),
      ...(agentSkill === undefined ? {} : { agentSkill }),
      readyToApply: agentSkill?.status !== 'replacement-required',
    },
    warnings: [],
  };
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
  const directoryChain = await captureWorkspaceOptionalResourceParentChain(
    root,
    uri,
    dependencies.port,
    dependencies.uris,
  );
  if (!directoryChain.ok) {
    throw new Error(directoryChain.failure.message);
  }
  if (!directoryChain.parentExists) {
    return undefined;
  }
  const stat: WorkspaceStat | undefined = await dependencies.port.stat(uri);
  const changedBeforeRead = await verifyWorkspaceDirectoryChain(
    directoryChain.snapshot,
    dependencies.port,
    dependencies.uris,
  );
  if (changedBeforeRead !== undefined) {
    throw new Error(changedBeforeRead.message);
  }
  if (stat === undefined) {
    return undefined;
  }
  if (stat.type !== 'file') {
    throw new Error(`${relativePath} exists but is not a file.`);
  }
  const content = await readWorkspaceFileWithinLimit(dependencies.port, uri, {
    maxBytes: BUNDLE_READ_LIMITS.maxDocumentBytes,
    subject: relativePath,
    reportedStat: stat,
  });
  const changedDirectory = await verifyWorkspaceDirectoryChain(
    directoryChain.snapshot,
    dependencies.port,
    dependencies.uris,
  );
  if (changedDirectory !== undefined) {
    throw new Error(changedDirectory.message);
  }
  return {
    text: decoder.decode(content),
    contentHash: sha256Content(content),
    contentByteLength: content.byteLength,
  };
}

export function createSetupAgentIntegrationCommand<TUri>(
  dependencies: SetupAgentIntegrationCommandDependencies<TUri>,
  admittedLease?: ProposalWorkflowLease,
): () => Promise<CommandOutcome> {
  return async () =>
    runProposalCommand(
      dependencies,
      async (lease) => {
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
        const boundedBundlePath =
          typeof target.bundlePath === 'string'
            ? normalizeBundleDirectory(target.bundlePath)
            : preserveProviderBundleDirectory(target.bundlePath.relativePath);
        if (!boundedBundlePath.ok) {
          await dependencies.ui.showError(
            problemsMessage(
              'The selected bundle path exceeds an agent-template safety limit.',
              boundedBundlePath.problems,
            ),
          );
          return { kind: 'refused', problems: boundedBundlePath.problems };
        }

        let existingAgents: ExistingTextSnapshot | undefined;
        let existingSkill: ExistingTextSnapshot | undefined;
        try {
          if (selection === 'agents-md' || selection === 'both') {
            existingAgents = await optionalText(
              target.integrationRootUri,
              'AGENTS.md',
              dependencies,
            );
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
        const expectedContentSnapshots = new Map<
          string,
          { readonly sha256: string; readonly byteLength: number }
        >();
        if (existingAgents !== undefined) {
          expectedContentSnapshots.set('AGENTS.md', {
            sha256: existingAgents.contentHash,
            byteLength: existingAgents.contentByteLength,
          });
        }
        if (existingSkill !== undefined) {
          expectedContentSnapshots.set(AGENT_SKILL_PATH, {
            sha256: existingSkill.contentHash,
            byteLength: existingSkill.contentByteLength,
          });
        }
        if (dependencies.core === undefined) {
          await dependencies.ui.showError(
            'Agent integration could not be generated because the production Wasm core was not supplied.',
          );
          return { kind: 'failed' };
        }
        const initialPlan = planAgentIntegrationWithCore(dependencies.core, planInput);
        if (!initialPlan.ok) {
          await dependencies.ui.showError(
            problemsMessage('Agent integration could not be merged safely.', initialPlan.problems),
          );
          return { kind: 'refused', problems: initialPlan.problems };
        }

        const replacementRequired = initialPlan.value.agentSkill?.status === 'replacement-required';
        const presentation: ProposalPresentation = {
          title: 'Set up OKF agent integration',
          summary: [
            `Target: ${target.label ?? dependencies.uris.serialize(target.integrationRootUri)}`,
            `Actual bundle path: ${displayBundlePath(target.bundlePath)}`,
            `Outputs: ${SELECTION_ITEMS.find((item) => item.value === selection)?.label ?? selection}`,
            ...(replacementRequired
              ? [
                  `Existing ${AGENT_SKILL_PATH} differs; approval explicitly replaces it and applies the complete proposal.`,
                ]
              : []),
          ],
        };

        const proposal = agentPlanToProposal(
          target.integrationRootUri,
          initialPlan.value,
          dependencies.uris,
          {
            workspaceSafetyRoot: target.integrationRootUri,
            expectedContentSnapshots,
            ...(replacementRequired ? { includeReplacementRequired: true } : {}),
          },
        );
        const revalidateBundleWrite = dependencies.revalidateBundleWrite;
        const bundleRootUri = target.bundleRootUri;
        return runProposalWorkflow(dependencies, lease, proposal, presentation, {
          ...(replacementRequired ? { confirmLabel: 'Replace Agent Skill and apply' } : {}),
          ...(revalidateBundleWrite === undefined || bundleRootUri === undefined
            ? {}
            : {
                beforeApply: () => revalidateBundleWrite(bundleRootUri),
              }),
        });
      },
      admittedLease,
    );
}
