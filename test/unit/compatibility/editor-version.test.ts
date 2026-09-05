import { describe, expect, it } from 'vitest';

import {
  assertExtensionHostVersion,
  electronTestGraphicsArguments,
  electronTestSandboxArguments,
} from '../../../scripts/compatibility/editor-resolver.mjs';
import { COMPATIBILITY_PINS } from '../../../scripts/compatibility/pins.mjs';

describe('packaged editor version oracle', () => {
  it('pins the API-floor and current-stable VS Code lanes', () => {
    expect(COMPATIBILITY_PINS.vscodeVersions).toEqual(['1.123.0', '1.129.1']);
  });

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
      requestedVersion: '1.126.04524',
      expectedExtensionHostVersion: '1.126.0',
    };

    expect(assertExtensionHostVersion(editor, '1.126.0')).toEqual({
      requestedEditorVersion: '1.126.04524',
      expectedExtensionHostVersion: '1.126.0',
      reportedExtensionHostVersion: '1.126.0',
    });
    expect(() => assertExtensionHostVersion(editor, '1.126.04524')).toThrow(
      'Extension Host reported 1.126.04524; expected 1.126.0',
    );
  });

  it('rejects a VS Code Extension Host that differs from the requested pin', () => {
    const editor = {
      editor: 'vscode',
      requestedVersion: '1.129.1',
      expectedExtensionHostVersion: '1.129.1',
    };

    expect(() => assertExtensionHostVersion(editor, '1.129.0')).toThrow(
      'Extension Host reported 1.129.0; expected 1.129.1',
    );
  });
});
