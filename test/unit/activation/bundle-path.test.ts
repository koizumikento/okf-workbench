import { describe, expect, it } from 'vitest';

import { renderAgentSkill, renderAgentsManagedBlock } from '../../../src/core/templates/index.js';
import { bundlePathWithinIntegrationRoot } from '../../../src/extension/composition/bundle-path.js';

function uri(path: string, authority = 'workspace') {
  return { scheme: 'memfs', authority, path };
}

describe('agent integration bundle path', () => {
  it('returns dot when the workspace root is the bundle root', () => {
    expect(bundlePathWithinIntegrationRoot(uri('/project'), uri('/project/'))).toEqual({
      pathIdentity: 'provider',
      relativePath: '.',
    });
  });

  it('keeps a nested Unicode path relative to the actual integration root', () => {
    expect(
      bundlePathWithinIntegrationRoot(uri('/project'), uri('/project/docs/ナレッジ bundle')),
    ).toEqual({
      pathIdentity: 'provider',
      relativePath: 'docs/ナレッジ bundle',
    });
  });

  it('flows literal colon, percent, and Unicode provider identities into both renderers', () => {
    const providerPath = bundlePathWithinIntegrationRoot(
      uri('/project'),
      uri('/project/docs:knowledge/literal%2Fsegment/知識'),
    );
    expect(providerPath).toEqual({
      pathIdentity: 'provider',
      relativePath: 'docs:knowledge/literal%2Fsegment/知識',
    });
    if (providerPath === undefined) {
      throw new Error('Expected a safe provider path.');
    }

    for (const result of [renderAgentsManagedBlock(providerPath), renderAgentSkill(providerPath)]) {
      expect(result).toMatchObject({ ok: true });
      if (result.ok) {
        expect(result.value).toContain('`docs:knowledge/literal%2Fsegment/知識/`');
        expect(result.value).toContain('`docs:knowledge/literal%2Fsegment/知識/index.md`');
      }
    }
  });

  it('rejects a different provider or a sibling path', () => {
    expect(
      bundlePathWithinIntegrationRoot(uri('/project'), uri('/project/knowledge', 'other')),
    ).toBeUndefined();
    expect(
      bundlePathWithinIntegrationRoot(uri('/project'), uri('/project-copy/knowledge')),
    ).toBeUndefined();
  });

  it.each([
    '/project/safe/../escape',
    '/project/safe/./same',
    '/project/safe//empty',
    '/project/safe/\0control',
  ])('rejects unsafe provider-relative identity %s', (path) => {
    expect(bundlePathWithinIntegrationRoot(uri('/project'), uri(path))).toBeUndefined();
  });
});
