import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

import {
  deriveGeneratedViewCommandIds,
  EXPECTED_CLI_COMMANDS,
  EXPECTED_COMMAND_CATALOG,
  EXPECTED_SIDEBAR_COMMANDS,
  EXPECTED_WRITE_COMMAND_IDS,
} from '../../../scripts/compatibility/driver/command-catalog.cjs';
import { PUBLIC_MANIFEST_RESOURCES } from '../../../scripts/package-check.mjs';
import { OKF_COMMANDS } from '../../../src/extension/commands/ids.js';
import {
  BUNDLED_CLI_CONFIGURATION,
  OPEN_CLI_TERMINAL_COMMAND,
  SHOW_CLI_STATUS_COMMAND,
} from '../../../src/extension/cli/index.js';
import {
  ACTIONS_VIEW_ID,
  BUNDLE_VIEW_ID,
  NEW_CONCEPT_IN_FOLDER_COMMAND,
  OPEN_RESOURCE_COMMAND,
  REFRESH_BUNDLE_COMMAND,
  RESOURCES_VIEW_ID,
  SELECT_BUNDLE_COMMAND,
  SIDEBAR_COMMANDS,
  SIDEBAR_CONTAINER_ID,
} from '../../../src/extension/sidebar/ids.js';

const expectedCommands = EXPECTED_COMMAND_CATALOG.map(({ id, title }) => [id, title] as const);
const recoveryCommand = {
  command: 'okfWorkbench.reviewPendingChanges',
  title: 'Review Pending Changes',
  when: 'okfWorkbench.hasPendingProposal',
} as const;
const cliCommands = EXPECTED_CLI_COMMANDS.map(({ id, title }) => [id, title] as const);
const sidebarCommands = SIDEBAR_COMMANDS.map(({ id, title }) => [id, title] as const);

interface ManifestCommand {
  readonly category?: unknown;
  readonly command?: unknown;
  readonly enablement?: unknown;
  readonly icon?: unknown;
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
      readonly 'view/item/context'?: readonly ManifestMenuCommand[];
      readonly 'view/title'?: readonly ManifestMenuCommand[];
    };
    readonly views?: Record<string, readonly { readonly id?: unknown; readonly name?: unknown }[]>;
    readonly viewsContainers?: {
      readonly activitybar?: readonly {
        readonly icon?: unknown;
        readonly id?: unknown;
        readonly title?: unknown;
      }[];
    };
    readonly viewsWelcome?: readonly {
      readonly contents?: unknown;
      readonly group?: unknown;
      readonly view?: unknown;
      readonly when?: unknown;
    }[];
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
    expect(manifest.version).toBe('0.2.1');
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

  test('contributes core, recovery, sidebar, and bundled CLI commands', async () => {
    const manifest = await readManifest();
    const commands = manifest.contributes?.commands ?? [];
    expect(commands).toHaveLength(
      expectedCommands.length + 1 + sidebarCommands.length + cliCommands.length,
    );
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
        .slice(expectedCommands.length + 1, expectedCommands.length + 1 + sidebarCommands.length)
        .map(({ command, title }) => [command, title]),
    ).toEqual(sidebarCommands);
    expect(
      commands
        .slice(expectedCommands.length + 1 + sidebarCommands.length)
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
    expect(EXPECTED_CLI_COMMANDS).toEqual([
      { id: SHOW_CLI_STATUS_COMMAND, title: 'Show CLI Status' },
      { id: OPEN_CLI_TERMINAL_COMMAND, title: 'Open CLI Terminal' },
    ]);
    expect(SIDEBAR_COMMANDS).toEqual(EXPECTED_SIDEBAR_COMMANDS);
    expect(
      OKF_COMMANDS.filter(({ workspaceAccess }) => workspaceAccess === 'write').map(({ id }) => id),
    ).toEqual(EXPECTED_WRITE_COMMAND_IDS);
    expect(EXPECTED_WRITE_COMMAND_IDS).toEqual([
      'okfWorkbench.initializeBundle',
      'okfWorkbench.newConcept',
      'okfWorkbench.regenerateIndexes',
      'okfWorkbench.setupAgentIntegration',
      'okfWorkbench.migrateBundle',
    ]);
  });

  test('activates and exposes the palette for core, recovery, sidebar, and CLI commands', async () => {
    const manifest = await readManifest();
    const commandIds = expectedCommands.map(([id]) => id);
    expect(manifest.activationEvents).toEqual([
      ...commandIds.map((id) => `onCommand:${id}`),
      `onCommand:${recoveryCommand.command}`,
      ...sidebarCommands.map(([id]) => `onCommand:${id}`),
      ...cliCommands.map(([id]) => `onCommand:${id}`),
      'onStartupFinished',
    ]);
    expect(manifest.contributes?.menus?.commandPalette).toEqual([
      ...commandIds.map((command) => ({ command, when: 'workspaceFolderCount > 0' })),
      { command: recoveryCommand.command, when: recoveryCommand.when },
      { command: SELECT_BUNDLE_COMMAND, when: 'workspaceFolderCount > 0' },
      { command: REFRESH_BUNDLE_COMMAND, when: 'okfWorkbench.hasSelectedBundle' },
      { command: OPEN_RESOURCE_COMMAND, when: 'false' },
      { command: NEW_CONCEPT_IN_FOLDER_COMMAND, when: 'false' },
      ...cliCommands.map(([command]) => ({ command })),
    ]);
  });

  test('contributes the Activity Bar container, three native views, and bounded view actions', async () => {
    const manifest = await readManifest();
    expect(manifest.contributes?.viewsContainers?.activitybar).toEqual([
      {
        id: SIDEBAR_CONTAINER_ID,
        title: 'OKF Workbench',
        icon: 'assets/workbench.svg',
      },
    ]);
    expect(manifest.contributes?.views?.[SIDEBAR_CONTAINER_ID]).toEqual([
      { id: BUNDLE_VIEW_ID, name: 'Bundle' },
      { id: RESOURCES_VIEW_ID, name: 'Resources' },
      { id: ACTIONS_VIEW_ID, name: 'Actions' },
    ]);
    expect(deriveGeneratedViewCommandIds(manifest)).toEqual(
      [BUNDLE_VIEW_ID, RESOURCES_VIEW_ID, ACTIONS_VIEW_ID]
        .flatMap((viewId) =>
          ['focus', 'open', 'removeView', 'resetViewLocation', 'toggleVisibility'].map(
            (suffix) => `${viewId}.${suffix}`,
          ),
        )
        .sort(),
    );

    const titleCommands = manifest.contributes?.menus?.['view/title'] ?? [];
    expect(titleCommands.map(({ command }) => command)).toEqual([
      SELECT_BUNDLE_COMMAND,
      'okfWorkbench.validateBundle',
      'okfWorkbench.openGraph',
      REFRESH_BUNDLE_COMMAND,
      'okfWorkbench.newConcept',
      REFRESH_BUNDLE_COMMAND,
    ]);

    const itemCommands = manifest.contributes?.menus?.['view/item/context'] ?? [];
    expect(itemCommands.map(({ command }) => command)).toEqual([
      OPEN_RESOURCE_COMMAND,
      NEW_CONCEPT_IN_FOLDER_COMMAND,
      'okfWorkbench.validateBundle',
      'okfWorkbench.openGraph',
    ]);
    expect(manifest.contributes?.viewsWelcome?.some(({ view }) => view === ACTIONS_VIEW_ID)).toBe(
      true,
    );
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

  test('exposes all seven commands from Explorer folders as explicit bundle entry points', async () => {
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
      'navigation@16',
    ]);
  });
});
