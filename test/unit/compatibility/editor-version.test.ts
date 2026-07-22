import { describe, expect, it } from 'vitest';

import { assertExtensionHostVersion } from '../../../scripts/compatibility/editor-resolver.mjs';

describe('packaged editor version oracle', () => {
  it('distinguishes the VSCodium release tag from its upstream Extension Host API version', () => {
    const editor = {
      editor: 'vscodium',
      requestedVersion: '1.121.03429',
      expectedExtensionHostVersion: '1.121.0',
    };

    expect(assertExtensionHostVersion(editor, '1.121.0')).toEqual({
      requestedEditorVersion: '1.121.03429',
      expectedExtensionHostVersion: '1.121.0',
      reportedExtensionHostVersion: '1.121.0',
    });
    expect(() => assertExtensionHostVersion(editor, '1.121.03429')).toThrow(
      'Extension Host reported 1.121.03429; expected 1.121.0',
    );
  });

  it('rejects a VS Code Extension Host that differs from the requested pin', () => {
    const editor = {
      editor: 'vscode',
      requestedVersion: '1.127.0',
      expectedExtensionHostVersion: '1.127.0',
    };

    expect(() => assertExtensionHostVersion(editor, '1.126.0')).toThrow(
      'Extension Host reported 1.126.0; expected 1.127.0',
    );
  });
});
