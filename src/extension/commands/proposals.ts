import { TextEncoder } from 'node:util';

import type { ChangeSetProposal, FileChangeProposal } from '../../core/model/index.js';
import type { IndexChange } from '../../core/indexes/index.js';
import type { AgentIntegrationPlan, RenderedTemplateFile } from '../../core/templates/index.js';
import { sha256Content } from '../workspace/contentHash.js';
import type { WorkspaceUriCodec } from '../workspace/uriCodec.js';

const encoder = new TextEncoder();

function targetFor<TUri>(root: TUri, relativePath: string, uris: WorkspaceUriCodec<TUri>): string {
  return uris.serialize(uris.joinContained(root, relativePath));
}

function providerTargetFor<TUri>(
  root: TUri,
  relativePath: string,
  uris: WorkspaceUriCodec<TUri>,
): string {
  return uris.serialize(uris.joinProviderPath(root, relativePath));
}

export function createProposalChange<TUri>(
  root: TUri,
  file: RenderedTemplateFile,
  uris: WorkspaceUriCodec<TUri>,
): FileChangeProposal {
  return {
    targetUri: targetFor(root, file.relativePath, uris),
    relativePath: file.relativePath,
    operation: 'create',
    expected: { kind: 'absent' },
    encoding: 'utf8',
    proposedText: file.content,
  };
}

export function createFileProposal<TUri>(
  root: TUri,
  relativePath: string,
  proposedText: string,
  uris: WorkspaceUriCodec<TUri>,
): FileChangeProposal {
  return {
    targetUri: targetFor(root, relativePath, uris),
    relativePath,
    operation: 'create',
    expected: { kind: 'absent' },
    encoding: 'utf8',
    proposedText,
  };
}

export function existingFileProposal<TUri>(
  root: TUri,
  relativePath: string,
  operation: 'update' | 'replace',
  previousText: string,
  proposedText: string,
  uris: WorkspaceUriCodec<TUri>,
  expectedContentHash?: string,
): FileChangeProposal {
  return {
    targetUri: targetFor(root, relativePath, uris),
    relativePath,
    operation,
    expected: {
      kind: 'sha256',
      value: expectedContentHash ?? sha256Content(encoder.encode(previousText)),
    },
    encoding: 'utf8',
    proposedText,
  };
}

export function bundleFilesToProposal<TUri>(
  operation: string,
  root: TUri,
  files: readonly RenderedTemplateFile[],
  uris: WorkspaceUriCodec<TUri>,
  options: { readonly relativePathPrefix?: string } = {},
): ChangeSetProposal {
  const prefix = options.relativePathPrefix;
  const relativePath = (path: string): string =>
    prefix === undefined || prefix === '.' ? path : `${prefix}/${path}`;
  return {
    operation,
    writeRootUri: uris.serialize(root),
    changes: files.map((file) =>
      createProposalChange(root, { ...file, relativePath: relativePath(file.relativePath) }, uris),
    ),
  };
}

export function indexChangesToProposal<TUri>(
  root: TUri,
  changes: readonly IndexChange[],
  uris: WorkspaceUriCodec<TUri>,
  options: { readonly expectedContentHashes?: ReadonlyMap<string, string> } = {},
): ChangeSetProposal {
  return {
    operation: 'regenerate-indexes',
    writeRootUri: uris.serialize(root),
    changes: changes.map((change) => {
      if (change.operation === 'create') {
        return createFileProposal(root, change.relativePath, change.proposedText, uris);
      }
      if (change.previousText === undefined) {
        throw new Error(`Index update ${change.relativePath} is missing its previous text.`);
      }
      return existingFileProposal(
        root,
        change.relativePath,
        'update',
        change.previousText,
        change.proposedText,
        uris,
        options.expectedContentHashes?.get(change.relativePath),
      );
    }),
  };
}

/** Converts an index plan derived from provider enumeration without decoding provider names. */
export function providerIndexChangesToProposal<TUri>(
  root: TUri,
  changes: readonly IndexChange[],
  uris: WorkspaceUriCodec<TUri>,
  options: { readonly expectedContentHashes?: ReadonlyMap<string, string> } = {},
): ChangeSetProposal {
  return {
    operation: 'regenerate-indexes',
    writeRootUri: uris.serialize(root),
    changes: changes.map((change): FileChangeProposal => {
      const base = {
        targetUri: providerTargetFor(root, change.relativePath, uris),
        relativePath: change.relativePath,
        pathIdentity: 'provider' as const,
        encoding: 'utf8' as const,
        proposedText: change.proposedText,
      };
      if (change.operation === 'create') {
        return {
          ...base,
          operation: 'create',
          expected: { kind: 'absent' },
        };
      }
      if (change.previousText === undefined) {
        throw new Error(`Index update ${change.relativePath} is missing its previous text.`);
      }
      return {
        ...base,
        operation: 'update',
        expected: {
          kind: 'sha256',
          value:
            options.expectedContentHashes?.get(change.relativePath) ??
            sha256Content(encoder.encode(change.previousText)),
        },
      };
    }),
  };
}

/** Converts a pure agent plan to guarded workspace changes. Unchanged outputs are omitted. */
export function agentPlanToProposal<TUri>(
  root: TUri,
  plan: AgentIntegrationPlan,
  uris: WorkspaceUriCodec<TUri>,
  options: {
    readonly includeReplacementRequired?: boolean;
    readonly expectedContentHashes?: ReadonlyMap<string, string>;
  } = {},
): ChangeSetProposal {
  const changes: FileChangeProposal[] = [];
  const agents = plan.agentsFile;
  if (agents !== undefined && agents.status !== 'unchanged') {
    if (agents.status === 'create') {
      changes.push(createFileProposal(root, agents.relativePath, agents.proposedText, uris));
    } else {
      if (agents.previousText === undefined) {
        throw new Error('The AGENTS.md update is missing its previous text.');
      }
      changes.push(
        existingFileProposal(
          root,
          agents.relativePath,
          'update',
          agents.previousText,
          agents.proposedText,
          uris,
          options.expectedContentHashes?.get(agents.relativePath),
        ),
      );
    }
  }

  const skill = plan.agentSkill;
  if (
    skill !== undefined &&
    skill.status !== 'unchanged' &&
    (skill.status !== 'replacement-required' || options.includeReplacementRequired === true)
  ) {
    if (skill.status === 'create') {
      changes.push(createFileProposal(root, skill.relativePath, skill.proposedText, uris));
    } else {
      if (skill.previousText === undefined) {
        throw new Error('The Agent Skill replacement is missing its previous text.');
      }
      changes.push(
        existingFileProposal(
          root,
          skill.relativePath,
          'replace',
          skill.previousText,
          skill.proposedText,
          uris,
          options.expectedContentHashes?.get(skill.relativePath),
        ),
      );
    }
  }

  return {
    operation: 'setup-agent-integration',
    writeRootUri: uris.serialize(root),
    changes,
  };
}
