import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

import {
  EXPECTED_COMMAND_CATALOG,
  EXPECTED_WRITE_COMMAND_IDS,
} from '../../../scripts/compatibility/driver/command-catalog.cjs';
import { PUBLIC_MANIFEST_RESOURCES } from '../../../scripts/package-check.mjs';
import { OKF_COMMANDS } from '../../../src/extension/commands/ids.js';
import {
  BUNDLED_CLI_CONFIGURATION,
  OPEN_CLI_TERMINAL_COMMAND,
  SHOW_CLI_STATUS_COMMAND,
} from '../../../src/extension/cli/index.js';

const expectedCommands = EXPECTED_COMMAND_CATALOG.map(({ id, title }) => [id, title] as const);
const recoveryCommand = {
  command: 'okfWorkbench.reviewPendingChanges',
  title: 'Review Pending Changes',
  when: 'okfWorkbench.hasPendingProposal',
} as const;
const cliCommands = [
  [SHOW_CLI_STATUS_COMMAND, 'Show CLI Status'],
  [OPEN_CLI_TERMINAL_COMMAND, 'Open CLI Terminal'],
] as const;

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
    readonly configuration?: {
      readonly properties?: Record<
        string,
        {
          readonly default?: unknown;
          readonly description?: unknown;
          readonly type?: unknown;
        }
      >;
      readonly title?: unknown;
    };
    readonly menus?: {
      readonly commandPalette?: readonly ManifestMenuCommand[];
      readonly 'explorer/context'?: readonly ManifestMenuCommand[];
    };
  };
  readonly engines?: {
    readonly vscode?: unknown;
  };
  readonly extensionKind?: unknown;
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
    expect(manifest.extensionKind).toEqual(['workspace']);
  });

  test('uses the confirmed release-candidate identity and icon', async () => {
    const manifest = await readManifest();
    expect(manifest.publisher).toBe('straydog');
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.license).toBe('MIT');
    expect(manifest.icon).toBe('assets/icon.png');
  });

  test('publishes the approved public project resources', async () => {
    const manifest = await readManifest();
    expect({
      homepage: manifest.homepage,
      repository: manifest.repository,
      bugs: manifest.bugs,
    }).toEqual(PUBLIC_MANIFEST_RESOURCES);
  });

  test('contributes core, recovery, and bundled CLI commands', async () => {
    const manifest = await readManifest();
    const commands = manifest.contributes?.commands ?? [];
    expect(commands).toHaveLength(expectedCommands.length + 1 + cliCommands.length);
    expect(
      commands.slice(0, expectedCommands.length).map(({ command, title }) => [command, title]),
    ).toEqual(expectedCommands);
    expect(commands.every(({ category }) => category === 'OKF')).toBe(true);
    expect(
      commands
        .slice(0, expectedCommands.length)
        .every(({ enablement }) => enablement === 'workspaceFolderCount > 0'),
    ).toBe(true);
    expect(commands.at(expectedCommands.length)).toEqual({
      command: recoveryCommand.command,
      title: recoveryCommand.title,
      category: 'OKF',
      enablement: recoveryCommand.when,
    });
    expect(
      commands
        .slice(expectedCommands.length + 1)
        .map(({ command, title, category, enablement }) => ({
          command,
          title,
          category,
          enablement,
        })),
    ).toEqual(
      cliCommands.map(([command, title]) => ({
        command,
        title,
        category: 'OKF',
        enablement: undefined,
      })),
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

  test('activates and exposes the palette for core, recovery, and CLI commands', async () => {
    const manifest = await readManifest();
    const commandIds = expectedCommands.map(([id]) => id);
    expect(manifest.activationEvents).toEqual([
      ...commandIds.map((id) => `onCommand:${id}`),
      `onCommand:${recoveryCommand.command}`,
      ...cliCommands.map(([id]) => `onCommand:${id}`),
      'onStartupFinished',
    ]);
    expect(manifest.contributes?.menus?.commandPalette).toEqual([
      ...commandIds.map((command) => ({ command, when: 'workspaceFolderCount > 0' })),
      { command: recoveryCommand.command, when: recoveryCommand.when },
      ...cliCommands.map(([command]) => ({ command })),
    ]);
  });

  test('exposes bundled CLI terminal integration as an opt-out setting', async () => {
    const manifest = await readManifest();
    expect(manifest.contributes?.configuration?.title).toBe('OKF Workbench');
    expect(manifest.contributes?.configuration?.properties?.[BUNDLED_CLI_CONFIGURATION]).toEqual({
      type: 'boolean',
      default: true,
      description:
        'Append the bundled offline OKF CLI directory to PATH for new VS Code integrated terminals. Existing PATH commands keep precedence.',
    });
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
