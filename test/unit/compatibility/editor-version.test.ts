import { describe, expect, it } from 'vitest';

import {
  assertExtensionHostVersion,
  electronTestGraphicsArguments,
  electronTestSandboxArguments,
} from '../../../scripts/compatibility/editor-resolver.mjs';

describe('packaged editor version oracle', () => {
  it('disables Electron sandboxes only for the isolated Linux editor test harness', () => {
    expect(electronTestSandboxArguments('linux')).toEqual([
      '--no-sandbox',
      '--disable-gpu-sandbox',
    ]);
    expect(electronTestSandboxArguments('darwin')).toEqual([]);
    expect(electronTestSandboxArguments('win32')).toEqual([]);
  });

  it('opts the isolated Linux graph test harness into software WebGL explicitly', () => {
    const githubActions = { GITHUB_ACTIONS: 'true' };

    expect(electronTestGraphicsArguments('linux', githubActions)).toEqual([
      '--enable-unsafe-swiftshader',
    ]);
    expect(electronTestGraphicsArguments('linux', {})).toEqual([]);
    expect(electronTestGraphicsArguments('darwin', githubActions)).toEqual([]);
    expect(electronTestGraphicsArguments('win32', githubActions)).toEqual([]);
  });

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
