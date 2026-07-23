import { describe, expect, it } from 'vitest';

import { bundleSelectionChoices } from '../../../src/extension/composition/bundle-selection.js';

describe('bundle selection choices', () => {
  it('keeps an explicit directory override after ambiguous automatic candidates', () => {
    const candidates = [{ root: 'memfs://workspace/a' }, { root: 'memfs://workspace/b' }];

    const choices = bundleSelectionChoices(candidates, (candidate) => ({
      label: candidate.root.split('/').at(-1) ?? candidate.root,
      description: `${candidate.root}/index.md`,
    }));

    expect(choices).toEqual([
      {
        choiceKind: 'candidate',
        label: 'a',
        description: 'memfs://workspace/a/index.md',
        candidate: candidates[0],
      },
      {
        choiceKind: 'candidate',
        label: 'b',
        description: 'memfs://workspace/b/index.md',
        candidate: candidates[1],
      },
      {
        choiceKind: 'browse',
        label: '$(folder-opened) Select another bundle root…',
        description: 'Choose any directory inside an open workspace',
      },
    ]);
  });
});
