import { describe, expect, it } from 'vitest';

import type { ChangeSetProposal, FileChangeProposal } from '../../../src/core/model/index.js';
import { sha256Content } from '../../../src/extension/workspace/contentHash.js';
import { ProposalApplicator } from '../../../src/extension/workspace/proposalApplicator.js';
import { WorkspaceAccessError } from '../../../src/extension/workspace/types.js';
import { FakeWorkspacePort, stringUriCodec } from './fakes.js';

const root = 'memfs://workspace/knowledge';

function proposal(...changes: readonly FileChangeProposal[]): ChangeSetProposal {
  return {
    operation: 'test-operation',
    workspaceSafetyRootUri: root,
    writeRootUri: root,
    changes,
  };
}

function createChange(relativePath: string, proposedText: string): FileChangeProposal {
  return {
    targetUri: `${root}/${relativePath}`,
    relativePath,
    operation: 'create',
    expected: { kind: 'absent' },
    encoding: 'utf8',
    proposedText,
  };
}

function updateChange(
  relativePath: string,
  current: Uint8Array,
  proposedText: string,
): FileChangeProposal {
  return {
    targetUri: `${root}/${relativePath}`,
    relativePath,
    operation: 'update',
    expected: {
      kind: 'sha256',
      value: sha256Content(current),
      byteLength: current.byteLength,
    },
    encoding: 'utf8',
    proposedText,
  };
}

describe('ProposalApplicator', () => {
  it('preflights every target and applies guarded create and update changes', async () => {
    const port = new FakeWorkspacePort();
    port.putDirectory(root);
    port.putText(`${root}/index.md`, 'before');
    const current = await port.read(`${root}/index.md`);
    const applicator = new ProposalApplicator(port, stringUriCodec);
    const changes = proposal(
      updateChange('index.md', current, 'after'),
      createChange('concepts/hello.md', 'hello'),
    );

    await expect(applicator.preflight(changes)).resolves.toEqual({ ready: true, failed: [] });
    await expect(applicator.apply(changes)).resolves.toEqual({
      completed: [`${root}/index.md`, `${root}/concepts/hello.md`],
      failed: [],
      untouched: [],
    });
    expect(port.text(`${root}/index.md`)).toBe('after');
    expect(port.text(`${root}/concepts/hello.md`)).toBe('hello');
  });

  it('does not write any target when preflight detects a collision', async () => {
    const port = new FakeWorkspacePort();
    port.putDirectory(root);
    port.putText(`${root}/existing.md`, 'producer content');
    const applicator = new ProposalApplicator(port, stringUriCodec);

    await expect(
      applicator.apply(
        proposal(createChange('existing.md', 'replacement'), createChange('untouched.md', 'new')),
      ),
    ).resolves.toEqual({
      completed: [],
      failed: [expect.objectContaining({ targetUri: `${root}/existing.md`, code: 'collision' })],
      untouched: [`${root}/untouched.md`],
    });
    expect(port.text(`${root}/existing.md`)).toBe('producer content');
    expect(port.writes).toEqual([]);
  });

  it('rejects the complete proposal when one target is another target ancestor', async () => {
    const port = new FakeWorkspacePort();
    port.putDirectory(root);
    const applicator = new ProposalApplicator(port, stringUriCodec);
    const changes = proposal(
      createChange('a', 'would become a file'),
      createChange('a/b.md', 'cannot have the other target as its parent'),
      createChange('safe.md', 'must remain untouched with the complete proposal'),
    );

    await expect(applicator.apply(changes)).resolves.toMatchObject({
      completed: [],
      failed: [
        { targetUri: `${root}/a`, code: 'collision' },
        { targetUri: `${root}/a/b.md`, code: 'collision' },
      ],
      untouched: [`${root}/safe.md`],
    });
    expect(port.writes).toEqual([]);
  });

  it('detects target overlap in work proportional to resolved parent segments', async () => {
    const port = new FakeWorkspacePort();
    port.putDirectory(root);
    let containedPathCalls = 0;
    const countingCodec = {
      ...stringUriCodec,
      containedPathSegments(anchor: string, descendant: string) {
        containedPathCalls += 1;
        return stringUriCodec.containedPathSegments(anchor, descendant);
      },
    };
    const applicator = new ProposalApplicator(port, countingCodec);
    const changes = proposal(
      ...Array.from({ length: 2_048 }, (_, index) =>
        createChange(`siblings/item-${String(index)}.md`, 'bounded'),
      ),
    );

    await expect(applicator.preflight(changes)).resolves.toEqual({ ready: true, failed: [] });
    // One call resolves proposal targets, one captures the write root, and one
    // captures the shared existing parent; none grows with 2,048 siblings.
    expect(containedPathCalls).toBe(3);
  });

  it('rejects a symbolic-link ancestor for every affected proposal before any write', async () => {
    const port = new FakeWorkspacePort();
    port.putDirectory(root);
    port.putSymbolicLink(`${root}/linked`);
    const applicator = new ProposalApplicator(port, stringUriCodec);

    await expect(
      applicator.apply(
        proposal(
          createChange('safe.md', 'safe only if the whole proposal is safe'),
          createChange('linked/external.md', 'must not escape'),
        ),
      ),
    ).resolves.toEqual({
      completed: [],
      failed: [
        expect.objectContaining({
          targetUri: `${root}/linked/external.md`,
          code: 'unsafe-path',
          retryable: false,
        }),
      ],
      untouched: [`${root}/safe.md`],
    });
    expect(port.writes).toEqual([]);
  });

  it('rejects an optional parent that appears before its directory baseline is captured', async () => {
    const parentUri = `${root}/appeared`;
    const targetUri = `${parentUri}/external.md`;
    const externalContent = new TextEncoder().encode('external content');

    class OptionalParentRacePort extends FakeWorkspacePort {
      raceTriggered = false;
      targetStats = 0;

      override async stat(uri: string) {
        if (uri === parentUri && !this.raceTriggered) {
          const absent = await super.stat(uri);
          this.raceTriggered = true;
          this.putSymbolicLink(parentUri);
          return absent;
        }
        if (uri === targetUri && this.entryTypes.get(parentUri) === 'symbolic-link') {
          this.targetStats += 1;
          return {
            type: 'file' as const,
            size: externalContent.byteLength,
            ctime: 0,
            mtime: 0,
          };
        }
        return super.stat(uri);
      }

      override async read(uri: string): Promise<Uint8Array> {
        if (uri === targetUri) {
          this.reads.push(uri);
          return externalContent.slice();
        }
        return super.read(uri);
      }
    }

    const makeHarness = () => {
      const port = new OptionalParentRacePort();
      port.putDirectory(root);
      const applicator = new ProposalApplicator(port, stringUriCodec);
      const changes = proposal(
        updateChange('appeared/external.md', externalContent, 'replacement'),
      );
      return { port, applicator, changes };
    };

    const preflightHarness = makeHarness();
    await expect(preflightHarness.applicator.preflight(preflightHarness.changes)).resolves.toEqual({
      ready: false,
      failed: [
        expect.objectContaining({
          targetUri,
          code: 'unsafe-path',
          retryable: false,
        }),
      ],
    });
    expect(preflightHarness.port.raceTriggered).toBe(true);
    expect(preflightHarness.port.targetStats).toBe(0);
    expect(preflightHarness.port.reads).toEqual([]);
    expect(preflightHarness.port.writes).toEqual([]);

    const applyHarness = makeHarness();
    await expect(applyHarness.applicator.apply(applyHarness.changes)).resolves.toEqual({
      completed: [],
      failed: [
        expect.objectContaining({
          targetUri,
          code: 'unsafe-path',
          retryable: false,
        }),
      ],
      untouched: [],
    });
    expect(applyHarness.port.raceTriggered).toBe(true);
    expect(applyHarness.port.targetStats).toBe(0);
    expect(applyHarness.port.reads).toEqual([]);
    expect(applyHarness.port.writes).toEqual([]);
  });

  it('rejects a non-directory parent before applying any proposal target', async () => {
    const port = new FakeWorkspacePort();
    port.putDirectory(root);
    port.putText(`${root}/occupied`, 'ordinary file');
    const applicator = new ProposalApplicator(port, stringUriCodec);

    const report = await applicator.apply(
      proposal(
        createChange('first.md', 'must remain untouched'),
        createChange('occupied/child.md', 'cannot be created'),
      ),
    );

    expect(report.completed).toEqual([]);
    expect(report.failed).toEqual([
      expect.objectContaining({
        targetUri: `${root}/occupied/child.md`,
        code: 'unsafe-path',
      }),
    ]);
    expect(report.untouched).toEqual([`${root}/first.md`]);
    expect(port.writes).toEqual([]);
  });

  it('also refuses a symbolic-link write root', async () => {
    const port = new FakeWorkspacePort();
    port.putSymbolicLink(root);
    const applicator = new ProposalApplicator(port, stringUriCodec);

    const report = await applicator.apply(proposal(createChange('index.md', 'must not write')));

    expect(report).toMatchObject({
      completed: [],
      failed: [{ code: 'unsafe-path', targetUri: `${root}/index.md` }],
    });
    expect(port.writes).toEqual([]);
  });

  it('rechecks expected content immediately before writing', async () => {
    const port = new FakeWorkspacePort();
    port.putDirectory(root);
    port.putText(`${root}/index.md`, 'previewed');
    const current = await port.read(`${root}/index.md`);
    let changed = false;
    port.beforeWrite = (uri) => {
      if (uri === `${root}/index.md` && !changed) {
        changed = true;
        port.putText(uri, 'changed after preflight');
      }
    };
    const applicator = new ProposalApplicator(port, stringUriCodec);

    await expect(
      applicator.apply(
        proposal(
          updateChange('index.md', current, 'replacement'),
          createChange('later.md', 'later'),
        ),
      ),
    ).resolves.toEqual({
      completed: [],
      failed: [expect.objectContaining({ targetUri: `${root}/index.md`, code: 'content-changed' })],
      untouched: [`${root}/later.md`],
    });
    expect(port.text(`${root}/index.md`)).toBe('changed after preflight');
    expect(port.text(`${root}/later.md`)).toBeUndefined();
  });

  it('reports completed, failed, and untouched targets after a partial failure', async () => {
    const port = new FakeWorkspacePort();
    port.putDirectory(root);
    port.failWrites.set(
      `${root}/second.md`,
      new WorkspaceAccessError('permission', 'Second target is read-only.'),
    );
    const applicator = new ProposalApplicator(port, stringUriCodec);

    await expect(
      applicator.apply(
        proposal(
          createChange('first.md', 'first'),
          createChange('second.md', 'second'),
          createChange('third.md', 'third'),
        ),
      ),
    ).resolves.toEqual({
      completed: [`${root}/first.md`],
      failed: [expect.objectContaining({ targetUri: `${root}/second.md`, code: 'permission' })],
      untouched: [`${root}/third.md`],
    });
    expect(port.text(`${root}/first.md`)).toBe('first');
    expect(port.text(`${root}/third.md`)).toBeUndefined();
  });

  it('rechecks every target ancestor and reports a symlink introduced between writes', async () => {
    const port = new FakeWorkspacePort();
    port.putDirectory(root);
    port.putDirectory(`${root}/mutable-parent`);
    let changedParent = false;
    port.beforeWrite = (uri) => {
      if (uri === `${root}/first.md` && !changedParent) {
        changedParent = true;
        port.putSymbolicLink(`${root}/mutable-parent`);
      }
    };
    const applicator = new ProposalApplicator(port, stringUriCodec);

    const report = await applicator.apply(
      proposal(
        createChange('first.md', 'first'),
        createChange('mutable-parent/second.md', 'second'),
        createChange('third.md', 'third'),
      ),
    );

    expect(report).toEqual({
      completed: [`${root}/first.md`],
      failed: [
        expect.objectContaining({
          targetUri: `${root}/mutable-parent/second.md`,
          code: 'unsafe-path',
        }),
      ],
      untouched: [`${root}/third.md`],
    });
    expect(port.text(`${root}/first.md`)).toBe('first');
    expect(port.text(`${root}/mutable-parent/second.md`)).toBeUndefined();
    expect(port.text(`${root}/third.md`)).toBeUndefined();
  });

  it('refuses the first write when the write root disappears after the compatibility guard', async () => {
    const port = new FakeWorkspacePort();
    port.putDirectory(root);
    const applicator = new ProposalApplicator(port, stringUriCodec);

    const result = await applicator.applyGuarded(
      proposal(createChange('first.md', 'first'), createChange('second.md', 'second')),
      async () => {
        port.entryTypes.delete(root);
        return undefined;
      },
    );

    expect(result).toEqual({
      kind: 'completed',
      report: {
        completed: [],
        failed: [
          expect.objectContaining({
            targetUri: `${root}/first.md`,
            code: 'unsafe-path',
          }),
          expect.objectContaining({
            targetUri: `${root}/second.md`,
            code: 'unsafe-path',
          }),
        ],
        untouched: [],
      },
    });
    expect(port.writes).toEqual([]);
  });

  it('rechecks the workspace-to-selected-root chain after an asynchronous guard', async () => {
    const workspaceSafetyRoot = 'memfs://workspace';
    const selectedRoot = `${workspaceSafetyRoot}/linked/bundle`;
    const linkedAncestor = `${workspaceSafetyRoot}/linked`;
    const port = new FakeWorkspacePort();
    port.putDirectory(workspaceSafetyRoot);
    port.putDirectory(linkedAncestor);
    port.putDirectory(selectedRoot);
    const targetUri = `${selectedRoot}/first.md`;
    const anchoredProposal: ChangeSetProposal = {
      operation: 'ancestor-toctou',
      workspaceSafetyRootUri: workspaceSafetyRoot,
      writeRootUri: selectedRoot,
      changes: [
        {
          targetUri,
          relativePath: 'first.md',
          operation: 'create',
          expected: { kind: 'absent' },
          encoding: 'utf8',
          proposedText: 'must not escape',
        },
      ],
    };
    const applicator = new ProposalApplicator(port, stringUriCodec);

    const result = await applicator.applyGuarded(anchoredProposal, async () => {
      port.putSymbolicLink(linkedAncestor);
      return undefined;
    });

    expect(result).toMatchObject({
      kind: 'completed',
      report: { completed: [], failed: [{ targetUri, code: 'unsafe-path' }] },
    });
    expect(port.writes).toEqual([]);
  });

  it('rejects traversal and mismatched declared target URIs', async () => {
    const port = new FakeWorkspacePort();
    const applicator = new ProposalApplicator(port, stringUriCodec);
    const traversal = {
      ...createChange('safe.md', 'unsafe'),
      relativePath: '%2e%2e/outside.md',
    };
    const mismatched = {
      ...createChange('safe.md', 'unsafe'),
      targetUri: `${root}/other.md`,
    };

    const report = await applicator.apply(proposal(traversal, mismatched));

    expect(report.completed).toEqual([]);
    expect(report.failed).toHaveLength(2);
    expect(port.writes).toEqual([]);
  });

  it('applies provider-identity paths verbatim while user paths retain encoded escape checks', async () => {
    const port = new FakeWorkspacePort();
    port.putDirectory(root);
    const applicator = new ProposalApplicator(port, stringUriCodec);
    const providerChanges = proposal(
      {
        ...createChange('encoded%2Fsegment/index.md', 'literal separator'),
        pathIdentity: 'provider',
      },
      {
        ...createChange('literal%/index.md', 'literal percent'),
        pathIdentity: 'provider',
      },
      {
        ...createChange('team%20knowledge/index.md', 'encoded-looking sibling'),
        pathIdentity: 'provider',
      },
      {
        ...createChange('team knowledge/index.md', 'space sibling'),
        pathIdentity: 'provider',
      },
    );

    await expect(applicator.apply(providerChanges)).resolves.toMatchObject({
      completed: providerChanges.changes.map(({ targetUri }) => targetUri),
      failed: [],
    });
    expect(port.text(`${root}/encoded%2Fsegment/index.md`)).toBe('literal separator');
    expect(port.text(`${root}/literal%/index.md`)).toBe('literal percent');
    expect(port.text(`${root}/team%20knowledge/index.md`)).toBe('encoded-looking sibling');
    expect(port.text(`${root}/team knowledge/index.md`)).toBe('space sibling');

    const unsafeUser = proposal(createChange('encoded%2Fsegment.md', 'must not write'));
    await expect(applicator.apply(unsafeUser)).resolves.toMatchObject({
      completed: [],
      failed: [expect.objectContaining({ code: 'unknown' })],
    });
  });
});
