import { describe, expect, it } from 'vitest';

import { OKF_SEMANTIC_LIMITS } from '../../../src/core/model/index.js';
import {
  isUriContained,
  normalizeContainedRelativePath,
  preserveProviderRelativePath,
  relativeParentPaths,
} from '../../../src/extension/workspace/pathSafety.js';

describe('workspace path safety', () => {
  it.each([
    ['concepts/nested.md', 'concepts/nested.md'],
    ['concepts\\nested.md', 'concepts/nested.md'],
    ['資料/知識 graph.md', '資料/知識 graph.md'],
  ])('normalizes safe relative path %s', (input, expected) => {
    expect(normalizeContainedRelativePath(input)).toBe(expected);
  });

  it.each([
    '',
    '/absolute.md',
    'C:\\absolute.md',
    '../outside.md',
    'concepts/../outside.md',
    'concepts/./same.md',
    'concepts//empty.md',
    '%2e%2e/outside.md',
    '%252e%252e/outside.md',
    '%252525252525252525252525252525252e%252525252525252525252525252525252e/outside.md',
    'concepts%2foutside.md',
    'concepts%5coutside.md',
    'C%3a/absolute.md',
    '%zz/invalid.md',
    'safe/\u001fname.md',
    'safe/\u0080name.md',
    'safe/%00name.md',
    'safe/%1fname.md',
    'safe/%C2%80name.md',
    'safe/%2500name.md',
    'safe/%25C2%2580name.md',
  ])('rejects unsafe relative path %s', (input) => {
    expect(() => normalizeContainedRelativePath(input)).toThrow();
  });

  it('checks containment using URI identity rather than OS paths', () => {
    const root = {
      scheme: 'vscode-remote',
      authority: 'ssh-remote+host',
      path: '/workspace/knowledge',
    };

    expect(
      isUriContained(root, {
        ...root,
        path: '/workspace/knowledge/資料/nested.md',
      }),
    ).toBe(true);
    expect(isUriContained(root, { ...root, path: '/workspace/knowledge-other/a.md' })).toBe(false);
    expect(isUriContained(root, { ...root, authority: 'ssh-remote+other' })).toBe(false);
    expect(isUriContained(root, { ...root, path: root.path, fragment: 'section' })).toBe(false);
  });

  it('preserves provider URI query and fragment identity during containment checks', () => {
    const root = {
      scheme: 'memfs',
      authority: 'workspace',
      path: '/knowledge',
      query: 'session=alpha%2Fbeta',
      fragment: 'provider-scope',
    };

    expect(isUriContained(root, { ...root, path: '/knowledge/concepts/a.md' })).toBe(true);
    expect(
      isUriContained(root, {
        ...root,
        path: '/knowledge/concepts/a.md',
        query: 'session=other',
      }),
    ).toBe(false);
    expect(
      isUriContained(root, {
        scheme: root.scheme,
        authority: root.authority,
        path: '/knowledge/concepts/a.md',
        query: root.query,
      }),
    ).toBe(false);
    expect(
      isUriContained(
        { scheme: root.scheme, authority: root.authority, path: root.path },
        { ...root, path: '/knowledge/concepts/a.md' },
      ),
    ).toBe(false);
  });

  it.each([
    'literal%/index.md',
    'encoded%2Fsegment/index.md',
    'encoded%252Fsegment/index.md',
    'space dir/日本 語.md',
    '%2e%2e/literal-provider-name.md',
  ])('preserves provider path identity %s verbatim', (input) => {
    expect(preserveProviderRelativePath(input)).toBe(input);
  });

  it.each(['', '../outside.md', '/absolute.md', 'a//b.md', 'a/./b.md', 'a\\b.md', 'a/\0.md'])(
    'rejects structurally unsafe provider path %s',
    (input) => {
      expect(() => preserveProviderRelativePath(input)).toThrow();
    },
  );

  it('does not weaken encoded user-path escape checks when provider identities are supported', () => {
    expect(() => normalizeContainedRelativePath('%2e%2e/outside.md')).toThrow();
    expect(() => normalizeContainedRelativePath('encoded%2Fsegment.md')).toThrow();
    expect(preserveProviderRelativePath('%2e%2e/outside.md')).toBe('%2e%2e/outside.md');
    expect(preserveProviderRelativePath('encoded%2Fsegment.md')).toBe('encoded%2Fsegment.md');
  });

  it('derives every normalized parent segment without including the target', () => {
    expect(relativeParentPaths('knowledge\\concepts/nested.md')).toEqual([
      'knowledge',
      'knowledge/concepts',
    ]);
    expect(relativeParentPaths('index.md')).toEqual([]);
  });

  it('keeps provider parent identities verbatim and rejects structural aliases', () => {
    expect(relativeParentPaths('encoded%2Fsegment/nested/index.md', 'provider')).toEqual([
      'encoded%2Fsegment',
      'encoded%2Fsegment/nested',
    ]);
    expect(() => relativeParentPaths('nested/../index.md', 'provider')).toThrow();
  });

  it('enforces the shared exact write-path length and depth boundaries', () => {
    const exactAscii = 'a'.repeat(OKF_SEMANTIC_LIMITS.maxProviderPathCodeUnits);
    expect(normalizeContainedRelativePath(exactAscii)).toBe(exactAscii);
    expect(() => normalizeContainedRelativePath(`a${exactAscii}`)).toThrow(/UTF-16 code units/u);

    const exactUtf8 = '雪'.repeat(OKF_SEMANTIC_LIMITS.maxProviderPathBytes / 4);
    const adjustedExactUtf8 = `${exactUtf8}${'a'.repeat(
      OKF_SEMANTIC_LIMITS.maxProviderPathBytes - new TextEncoder().encode(exactUtf8).byteLength,
    )}`;
    expect(new TextEncoder().encode(adjustedExactUtf8)).toHaveLength(
      OKF_SEMANTIC_LIMITS.maxProviderPathBytes,
    );
    expect(normalizeContainedRelativePath(adjustedExactUtf8)).toBe(adjustedExactUtf8);
    expect(() => normalizeContainedRelativePath(`雪${adjustedExactUtf8}`)).toThrow(/UTF-8 bytes/u);
    expect(preserveProviderRelativePath(adjustedExactUtf8)).toBe(adjustedExactUtf8);
    expect(() => preserveProviderRelativePath(`雪${adjustedExactUtf8}`)).toThrow(/UTF-8 bytes/u);

    const exactSegments = `${'a/'.repeat(
      OKF_SEMANTIC_LIMITS.maxProviderPathSegments - 1,
    )}target.md`;
    expect(normalizeContainedRelativePath(exactSegments)).toBe(exactSegments);
    expect(() => normalizeContainedRelativePath(`a/${exactSegments}`)).toThrow(/segments/u);
    expect(preserveProviderRelativePath(exactSegments)).toBe(exactSegments);
    expect(() => preserveProviderRelativePath(`a/${exactSegments}`)).toThrow(/segments/u);
  });

  it('rejects unpaired surrogates through user and provider workspace path APIs', () => {
    expect(() => normalizeContainedRelativePath('bad\ud800/output.md')).toThrow(
      /unpaired UTF-16 surrogate/u,
    );
    expect(() => preserveProviderRelativePath('bad\ud800/output.md')).toThrow(
      /unpaired UTF-16 surrogate/u,
    );
    expect(() => relativeParentPaths('bad\ud800/output.md')).toThrow(/unpaired UTF-16 surrogate/u);
    expect(() => relativeParentPaths('bad\ud800/output.md', 'provider')).toThrow(
      /unpaired UTF-16 surrogate/u,
    );
  });
});
