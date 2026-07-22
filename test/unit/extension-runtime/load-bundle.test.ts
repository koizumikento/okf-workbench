import { describe, expect, it } from 'vitest';

import { loadBundle } from '../../../src/extension/runtime/loadBundle.js';
import { WorkspaceAccessError } from '../../../src/extension/workspace/types.js';
import { FakeWorkspacePort, stringUriCodec } from '../extension-workspace/fakes.js';

const root = 'memfs://workspace/bundle';

describe('loadBundle', () => {
  it('keeps readable siblings when one subtree and one Markdown file cannot be read', async () => {
    const port = new FakeWorkspacePort();
    const blockedSubtree = `${root}/blocked%2Fsubtree`;
    const unreadableFile = `${root}/unreadable.md`;
    port.putText(`${root}/index.md`, '# Bundle\n');
    port.putText(`${root}/alpha.md`, '# Alpha\n');
    port.putText(`${blockedSubtree}/beta.md`, '# Beta\n');
    port.putText(unreadableFile, '# Unreadable\n');
    port.traversalFailures.set(blockedSubtree, new Error('Provider refused this subtree.'));
    port.readFailures.set(unreadableFile, new Error('Provider refused this file.'));

    const loaded = await loadBundle(port, stringUriCodec, root);

    expect(loaded.rootUri).toBe(root);
    expect(loaded.documents.map(({ bundlePath }) => bundlePath)).toEqual(['alpha.md', 'index.md']);
    expect(loaded.failures).toEqual([
      {
        kind: 'parse-failure',
        uri: blockedSubtree,
        bundlePath: 'blocked%2Fsubtree',
        reason: 'read',
        message: expect.stringContaining('Provider refused this subtree.'),
      },
      {
        kind: 'parse-failure',
        uri: unreadableFile,
        bundlePath: 'unreadable.md',
        reason: 'read',
        message: expect.stringContaining('Provider refused this file.'),
      },
    ]);
  });

  it('keeps a failure at the selected root fatal', async () => {
    const port = new FakeWorkspacePort();
    port.putText(`${root}/index.md`, '# Bundle\n');
    port.traversalFailures.set(root, new Error('Provider cannot enumerate the selected root.'));

    const error = await loadBundle(port, stringUriCodec, root).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(WorkspaceAccessError);
    expect(error).toMatchObject({
      code: 'unavailable',
      message: 'Provider cannot enumerate the selected root.',
    });
  });
});
