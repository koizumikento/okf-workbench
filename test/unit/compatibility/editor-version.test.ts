import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  assertExtensionHostVersion,
  electronTestGraphicsArguments,
  electronTestSandboxArguments,
} from '../../../scripts/compatibility/editor-resolver.mjs';
import { COMPATIBILITY_PINS } from '../../../scripts/compatibility/pins.mjs';

describe('packaged editor version oracle', () => {
  it('keeps the manifest and type ceiling compatible with both pinned stable editors', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { engines: { vscode: string }; devDependencies: { '@types/vscode': string } };
    const floor = /^\^1\.(\d+)\.0$/u.exec(manifest.engines.vscode);
    expect(floor).not.toBeNull();
    const floorMinor = Number(floor?.[1]);
    const typeVersion = /^1\.(\d+)\.\d+$/u.exec(manifest.devDependencies['@types/vscode']);
    expect(typeVersion).not.toBeNull();
    expect(Number(typeVersion?.[1])).toBeLessThanOrEqual(floorMinor);
    for (const version of [
      ...COMPATIBILITY_PINS.vscodeVersions,
      COMPATIBILITY_PINS.vscodium.expectedExtensionHostVersion,
    ]) {
      const editor = /^1\.(\d+)\.\d+$/u.exec(version);
      expect(editor).not.toBeNull();
      expect(Number(editor?.[1])).toBeGreaterThanOrEqual(floorMinor);
    }
  });

  it('pins the API-floor and current-stable VS Code lanes', () => {
    expect(COMPATIBILITY_PINS.vscodeVersions).toEqual(['1.123.0', '1.140.0']);
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
      requestedVersion: '1.135.06055',
      expectedExtensionHostVersion: '1.135.0',
    };

    expect(assertExtensionHostVersion(editor, '1.135.0')).toEqual({
      requestedEditorVersion: '1.135.06055',
      expectedExtensionHostVersion: '1.135.0',
      reportedExtensionHostVersion: '1.135.0',
    });
    expect(() => assertExtensionHostVersion(editor, '1.135.06055')).toThrow(
      'Extension Host reported 1.135.06055; expected 1.135.0',
    );
  });

  it('rejects a VS Code Extension Host that differs from the requested pin', () => {
    const editor = {
      editor: 'vscode',
      requestedVersion: '1.140.0',
      expectedExtensionHostVersion: '1.140.0',
    };

    expect(() => assertExtensionHostVersion(editor, '1.139.0')).toThrow(
      'Extension Host reported 1.139.0; expected 1.140.0',
    );
  });
});
