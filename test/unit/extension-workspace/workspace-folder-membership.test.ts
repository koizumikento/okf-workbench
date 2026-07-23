import { describe, expect, it } from 'vitest';

import { WorkspaceFolderMembershipTracker } from '../../../src/extension/workspace/workspaceFolderMembership.js';
import { stringUriCodec } from './fakes.js';

describe('workspace folder membership authorization', () => {
  it('invalidates only the exact removed nested root in a multi-root workspace', () => {
    const parent = 'memfs://workspace';
    const nested = `${parent}/knowledge`;
    const sibling = `${parent}/other`;
    let openFolders: readonly string[] = [parent, nested, sibling];
    const tracker = new WorkspaceFolderMembershipTracker(stringUriCodec, () => openFolders);
    const nestedSession = tracker.capture(nested);
    const siblingSession = tracker.capture(sibling);

    openFolders = [nested, sibling];
    tracker.handleWorkspaceFoldersChanged({ removed: [parent] });
    expect(nestedSession.currentProblem()).toBeUndefined();
    expect(siblingSession.currentProblem()).toBeUndefined();

    openFolders = [parent, sibling];
    tracker.handleWorkspaceFoldersChanged({ removed: [nested] });
    expect(nestedSession.currentProblem()).toMatchObject({
      code: 'workspace-folder-unavailable',
      uri: nested,
    });
    expect(siblingSession.currentProblem()).toBeUndefined();
  });

  it('does not revive an authorization when the same root is removed and re-added', () => {
    const root = 'memfs://authority/knowledge';
    let openFolders: readonly string[] = [root];
    const tracker = new WorkspaceFolderMembershipTracker(stringUriCodec, () => openFolders);
    const session = tracker.capture(root);
    let invalidations = 0;
    session.onDidInvalidate(() => {
      invalidations += 1;
    });

    // VS Code may report remove/add together while the live set already contains the re-added URI.
    openFolders = [root];
    tracker.handleWorkspaceFoldersChanged({ removed: [root] });
    expect(session.currentProblem()?.code).toBe('workspace-folder-unavailable');
    expect(invalidations).toBe(1);

    tracker.handleWorkspaceFoldersChanged({ removed: [] });
    expect(session.currentProblem()?.code).toBe('workspace-folder-unavailable');
    expect(invalidations).toBe(1);
    expect(tracker.capture(root).currentProblem()).toBeUndefined();
  });

  it('requires exact provider URI identity instead of parent containment or path similarity', () => {
    const root = 'memfs://authority-a/knowledge';
    const parent = 'memfs://authority-a';
    const otherAuthority = 'memfs://authority-b/knowledge';
    let openFolders: readonly string[] = [parent, otherAuthority];
    const tracker = new WorkspaceFolderMembershipTracker(stringUriCodec, () => openFolders);

    expect(tracker.capture(root).currentProblem()).toMatchObject({
      code: 'workspace-folder-unavailable',
      uri: root,
    });

    openFolders = [root, otherAuthority];
    const session = tracker.capture(root);
    tracker.handleWorkspaceFoldersChanged({ removed: [otherAuthority] });
    expect(session.currentProblem()).toBeUndefined();

    openFolders = [otherAuthority];
    expect(session.currentProblem()).toMatchObject({
      code: 'workspace-folder-unavailable',
      uri: root,
    });
  });
});
