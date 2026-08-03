import type { ChangeSetProposal, FileChangeProposal } from '../../core/model/index.js';
import type { IndexChange } from '../../core/indexes/index.js';
import type { MigrationPlan } from '../../core/migration/index.js';
import type { AgentIntegrationPlan, RenderedTemplateFile } from '../../core/templates/index.js';
import type { WorkspaceUriCodec } from '../workspace/uriCodec.js';

export interface ExpectedContentSnapshot {
  /** SHA-256 computed from the exact provider bytes read before preview. */
  readonly sha256: string;
  /** Exact length of the same provider byte array. */
  readonly byteLength: number;
}

interface ExpectedContentSnapshotOptions {
  readonly expectedContentSnapshots: ReadonlyMap<string, ExpectedContentSnapshot>;
}

interface WorkspaceSafetyRootOptions<TUri> {
  /** Open workspace directory whose descendant chain contains the write root. */
  readonly workspaceSafetyRoot?: TUri;
}

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
  proposedText: string,
  uris: WorkspaceUriCodec<TUri>,
  expectedContent: ExpectedContentSnapshot,
): FileChangeProposal {
  return {
    targetUri: targetFor(root, relativePath, uris),
    relativePath,
    operation,
    expected: {
      kind: 'sha256',
      value: expectedContent.sha256,
      byteLength: expectedContent.byteLength,
    },
    encoding: 'utf8',
    proposedText,
  };
}

function expectedContentSnapshot(
  relativePath: string,
  snapshots: ReadonlyMap<string, ExpectedContentSnapshot>,
): ExpectedContentSnapshot {
  const snapshot = snapshots.get(relativePath);
  if (snapshot === undefined) {
    throw new Error(
      `Existing file ${relativePath} is missing the SHA-256 and byte length of its original provider bytes.`,
    );
  }
  return snapshot;
}

export function bundleFilesToProposal<TUri>(
  operation: string,
  root: TUri,
  files: readonly RenderedTemplateFile[],
  uris: WorkspaceUriCodec<TUri>,
  options: WorkspaceSafetyRootOptions<TUri> & { readonly relativePathPrefix?: string } = {},
): ChangeSetProposal {
  const prefix = options.relativePathPrefix;
  const relativePath = (path: string): string =>
    prefix === undefined || prefix === '.' ? path : `${prefix}/${path}`;
  return {
    operation,
    workspaceSafetyRootUri: uris.serialize(options.workspaceSafetyRoot ?? root),
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
  options: ExpectedContentSnapshotOptions & WorkspaceSafetyRootOptions<TUri>,
): ChangeSetProposal {
  return {
    operation: 'regenerate-indexes',
    workspaceSafetyRootUri: uris.serialize(options.workspaceSafetyRoot ?? root),
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
        change.proposedText,
        uris,
        expectedContentSnapshot(change.relativePath, options.expectedContentSnapshots),
      );
    }),
  };
}

/** Converts an index plan derived from provider enumeration without decoding provider names. */
export function providerIndexChangesToProposal<TUri>(
  root: TUri,
  changes: readonly IndexChange[],
  uris: WorkspaceUriCodec<TUri>,
  options: ExpectedContentSnapshotOptions & WorkspaceSafetyRootOptions<TUri>,
): ChangeSetProposal {
  return {
    operation: 'regenerate-indexes',
    workspaceSafetyRootUri: uris.serialize(options.workspaceSafetyRoot ?? root),
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
      const expected = expectedContentSnapshot(
        change.relativePath,
        options.expectedContentSnapshots,
      );
      return {
        ...base,
        operation: 'update',
        expected: {
          kind: 'sha256',
          value: expected.sha256,
          byteLength: expected.byteLength,
        },
      };
    }),
  };
}

/** Converts a migration plan derived from provider bytes into guarded in-place updates. */
export function providerMigrationPlanToProposal<TUri>(
  root: TUri,
  plan: MigrationPlan,
  uris: WorkspaceUriCodec<TUri>,
  options: ExpectedContentSnapshotOptions & WorkspaceSafetyRootOptions<TUri>,
): ChangeSetProposal {
  return {
    operation: 'migrate-bundle-to-v0.2',
    workspaceSafetyRootUri: uris.serialize(options.workspaceSafetyRoot ?? root),
    writeRootUri: uris.serialize(root),
    changes: plan.files.map((file): FileChangeProposal => {
      const expected = expectedContentSnapshot(file.relativePath, options.expectedContentSnapshots);
      return {
        targetUri: providerTargetFor(root, file.relativePath, uris),
        relativePath: file.relativePath,
        pathIdentity: 'provider',
        operation: 'update',
        expected: {
          kind: 'sha256',
          value: expected.sha256,
          byteLength: expected.byteLength,
        },
        encoding: 'utf8',
        proposedText: file.content,
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
    readonly expectedContentSnapshots: ReadonlyMap<string, ExpectedContentSnapshot>;
  } & WorkspaceSafetyRootOptions<TUri>,
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
          agents.proposedText,
          uris,
          expectedContentSnapshot(agents.relativePath, options.expectedContentSnapshots),
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
          skill.proposedText,
          uris,
          expectedContentSnapshot(skill.relativePath, options.expectedContentSnapshots),
        ),
      );
    }
  }

  return {
    operation: 'setup-agent-integration',
    workspaceSafetyRootUri: uris.serialize(options.workspaceSafetyRoot ?? root),
    writeRootUri: uris.serialize(root),
    changes,
  };
}
