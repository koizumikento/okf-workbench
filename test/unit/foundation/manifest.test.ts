import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

import {
  EXPECTED_COMMAND_CATALOG,
  EXPECTED_WRITE_COMMAND_IDS,
} from '../../../scripts/compatibility/driver/command-catalog.cjs';
import { OKF_COMMANDS } from '../../../src/extension/commands/ids.js';

const expectedCommands = EXPECTED_COMMAND_CATALOG.map(({ id, title }) => [id, title] as const);

interface ManifestCommand {
  readonly category?: unknown;
  readonly command?: unknown;
  readonly enablement?: unknown;
  readonly title?: unknown;
}

interface ManifestMenuCommand {
  readonly command?: unknown;
  readonly group?: unknown;
  readonly when?: unknown;
}

interface ExtensionManifest {
  readonly activationEvents?: unknown;
  readonly browser?: unknown;
  readonly bugs?: unknown;
  readonly contributes?: {
    readonly commands?: readonly ManifestCommand[];
    readonly menus?: {
      readonly commandPalette?: readonly ManifestMenuCommand[];
      readonly 'explorer/context'?: readonly ManifestMenuCommand[];
    };
  };
  readonly engines?: {
    readonly vscode?: unknown;
  };
  readonly main?: unknown;
  readonly icon?: unknown;
  readonly homepage?: unknown;
  readonly license?: unknown;
  readonly publisher?: unknown;
  readonly repository?: unknown;
  readonly version?: unknown;
}

async function readManifest(): Promise<ExtensionManifest> {
  const source = await readFile(new URL('../../../package.json', import.meta.url), 'utf8');
  return JSON.parse(source) as ExtensionManifest;
}

describe('extension manifest', () => {
  test('defines the accepted desktop entry point and API floor', async () => {
    const manifest = await readManifest();
    expect(manifest.main).toBe('./dist/extension.cjs');
    expect(manifest.browser).toBeUndefined();
    expect(manifest.engines?.vscode).toBe('^1.121.0');
  });

  test('uses the confirmed release-candidate identity and icon', async () => {
    const manifest = await readManifest();
    expect(manifest.publisher).toBe('straydog');
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.license).toBe('MIT');
    expect(manifest.icon).toBe('assets/icon.png');
  });

  test('does not publish links that require access to the private source repository', async () => {
    const manifest = await readManifest();
    expect(manifest.repository).toBeUndefined();
    expect(manifest.bugs).toBeUndefined();
    expect(manifest.homepage).toBeUndefined();
  });

  test('contributes exactly six stable, workspace-gated commands', async () => {
    const manifest = await readManifest();
    const commands = manifest.contributes?.commands ?? [];
    expect(commands).toHaveLength(expectedCommands.length);
    expect(commands.map(({ command, title }) => [command, title])).toEqual(expectedCommands);
    expect(commands.every(({ category }) => category === 'OKF')).toBe(true);
    expect(commands.every(({ enablement }) => enablement === 'workspaceFolderCount > 0')).toBe(
      true,
    );
  });

  test('shares one exhaustive read/write command classification with packaged acceptance', () => {
    expect(OKF_COMMANDS).toEqual(EXPECTED_COMMAND_CATALOG);
    expect(
      OKF_COMMANDS.filter(({ workspaceAccess }) => workspaceAccess === 'write').map(({ id }) => id),
    ).toEqual(EXPECTED_WRITE_COMMAND_IDS);
    expect(EXPECTED_WRITE_COMMAND_IDS).toEqual([
      'okfWorkbench.initializeBundle',
      'okfWorkbench.newConcept',
      'okfWorkbench.regenerateIndexes',
      'okfWorkbench.setupAgentIntegration',
    ]);
  });

  test('activates and exposes the palette for those IDs only', async () => {
    const manifest = await readManifest();
    const commandIds = expectedCommands.map(([id]) => id);
    expect(manifest.activationEvents).toEqual(commandIds.map((id) => `onCommand:${id}`));
    expect(manifest.contributes?.menus?.commandPalette).toEqual(
      commandIds.map((command) => ({ command, when: 'workspaceFolderCount > 0' })),
    );
  });

  test('exposes all six commands from Explorer folders as explicit bundle entry points', async () => {
    const manifest = await readManifest();
    const commandIds = expectedCommands.map(([id]) => id).sort();
    const explorer = manifest.contributes?.menus?.['explorer/context'] ?? [];

    expect(explorer).toHaveLength(commandIds.length);
    expect(explorer.map(({ command }) => command).sort()).toEqual(commandIds);
    expect(
      explorer.every(({ when }) => when === 'explorerResourceIsFolder && workspaceFolderCount > 0'),
    ).toBe(true);
    expect(explorer.map(({ group }) => group)).toEqual([
      'navigation@10',
      'navigation@11',
      'navigation@12',
      'navigation@13',
      'navigation@14',
      'navigation@15',
    ]);
  });
});
