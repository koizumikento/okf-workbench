import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  ChangeSetProposal,
  ExpectedContent,
  FileChangeProposal,
} from '../../src/core/model/index.js';
import {
  normalizeContainedRelativePath,
  preserveProviderRelativePath,
} from '../../src/extension/workspace/pathSafety.js';
import { ProposalApplicator } from '../../src/extension/workspace/proposalApplicator.js';
import type {
  WorkspaceEntry,
  WorkspaceEnumerationOptions,
  WorkspacePort,
  WorkspaceStat,
  WorkspaceTraversalEvent,
  WorkspaceTraversalOptions,
  WorkspaceWriteOptions,
} from '../../src/extension/workspace/types.js';
import { WorkspaceAccessError } from '../../src/extension/workspace/types.js';
import type { WorkspaceUriCodec } from '../../src/extension/workspace/uriCodec.js';

const temporaryRoots: string[] = [];

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

const fileUriCodec: WorkspaceUriCodec<string> = {
  parse(value) {
    const parsed = new URL(value);
    if (parsed.protocol !== 'file:') {
      throw new Error('The security harness accepts file URIs only.');
    }
    return pathToFileURL(fileURLToPath(parsed)).toString();
  },
  serialize(uri) {
    return uri;
  },
  joinContained(root, relativePath) {
    const normalized = normalizeContainedRelativePath(relativePath);
    return pathToFileURL(join(fileURLToPath(root), ...normalized.split('/'))).toString();
  },
  joinProviderPath(root, relativePath) {
    const preserved = preserveProviderRelativePath(relativePath);
    return pathToFileURL(join(fileURLToPath(root), ...preserved.split('/'))).toString();
  },
  equals(left, right) {
    return left === right;
  },
};

class RealFileWorkspacePort implements WorkspacePort<string> {
  readonly writes: string[] = [];

  async read(uri: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(fileURLToPath(uri)));
  }

  async *traverse(
    root: string,
    options: WorkspaceTraversalOptions = {},
  ): AsyncIterable<WorkspaceTraversalEvent<string>> {
    void root;
    void options;
    const events: readonly WorkspaceTraversalEvent<string>[] = [];
    for (const event of events) {
      yield event;
    }
  }

  async enumerate(
    root: string,
    options: WorkspaceEnumerationOptions = {},
  ): Promise<readonly WorkspaceEntry<string>[]> {
    void root;
    void options;
    return [];
  }

  async stat(uri: string): Promise<WorkspaceStat | undefined> {
    try {
      const value = await lstat(fileURLToPath(uri));
      const type = value.isSymbolicLink()
        ? 'symbolic-link'
        : value.isDirectory()
          ? 'directory'
          : value.isFile()
            ? 'file'
            : 'unknown';
      return {
        type,
        size: value.size,
        ctime: value.ctimeMs,
        mtime: value.mtimeMs,
      };
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return undefined;
      }
      throw new WorkspaceAccessError('unknown', 'Real filesystem stat failed.', { cause: error });
    }
  }

  async write(uri: string, content: Uint8Array, options: WorkspaceWriteOptions): Promise<void> {
    this.writes.push(uri);
    const path = fileURLToPath(uri);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, {
      flag: options.expected.kind === 'absent' ? 'wx' : 'w',
    });
  }
}

function createChange(root: string, relativePath: string): FileChangeProposal {
  return {
    targetUri: fileUriCodec.joinContained(root, relativePath),
    relativePath,
    operation: 'create',
    expected: { kind: 'absent' } satisfies ExpectedContent,
    encoding: 'utf8',
    proposedText: `generated ${relativePath}\n`,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('real file-workspace proposal containment', () => {
  it('rejects an external directory symlink and parent-file collision before every write', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'okf-workbench-write-safety-'));
    temporaryRoots.push(temporaryRoot);
    const workspacePath = join(temporaryRoot, 'workspace');
    const externalPath = join(temporaryRoot, 'external');
    await mkdir(workspacePath);
    await mkdir(externalPath);
    await symlink(
      externalPath,
      join(workspacePath, 'linked-outside'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await writeFile(join(workspacePath, 'occupied-parent'), 'ordinary file', 'utf8');

    const writeRootUri = pathToFileURL(workspacePath).toString();
    const proposal: ChangeSetProposal = {
      operation: 'real-file-write-safety',
      writeRootUri,
      changes: [
        createChange(writeRootUri, 'safe.md'),
        createChange(writeRootUri, 'linked-outside/escaped.md'),
        createChange(writeRootUri, 'occupied-parent/child.md'),
      ],
    };
    const port = new RealFileWorkspacePort();
    const applicator = new ProposalApplicator(port, fileUriCodec);

    const report = await applicator.apply(proposal);

    expect(report.completed).toEqual([]);
    expect(report.failed).toEqual([
      expect.objectContaining({
        targetUri: createChange(writeRootUri, 'linked-outside/escaped.md').targetUri,
        code: 'unsafe-path',
      }),
      expect.objectContaining({
        targetUri: createChange(writeRootUri, 'occupied-parent/child.md').targetUri,
        code: 'unsafe-path',
      }),
    ]);
    expect(report.untouched).toEqual([createChange(writeRootUri, 'safe.md').targetUri]);
    expect(port.writes).toEqual([]);
    await expect(exists(join(externalPath, 'escaped.md'))).resolves.toBe(false);
    await expect(exists(join(workspacePath, 'safe.md'))).resolves.toBe(false);
  });
});
