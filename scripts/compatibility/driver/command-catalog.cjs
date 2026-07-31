'use strict';

/* global module */

const EXPECTED_COMMAND_CATALOG = Object.freeze(
  [
    {
      id: 'okfWorkbench.initializeBundle',
      title: 'Initialize Bundle',
      workspaceAccess: 'write',
    },
    {
      id: 'okfWorkbench.newConcept',
      title: 'New Concept',
      workspaceAccess: 'write',
    },
    {
      id: 'okfWorkbench.validateBundle',
      title: 'Validate Bundle',
      workspaceAccess: 'read',
    },
    {
      id: 'okfWorkbench.regenerateIndexes',
      title: 'Regenerate Indexes',
      workspaceAccess: 'write',
    },
    {
      id: 'okfWorkbench.openGraph',
      title: 'Open 3D Graph',
      workspaceAccess: 'read',
    },
    {
      id: 'okfWorkbench.setupAgentIntegration',
      title: 'Set Up Agent Integration',
      workspaceAccess: 'write',
    },
    {
      id: 'okfWorkbench.migrateBundle',
      title: 'Migrate Bundle to v0.2',
      workspaceAccess: 'write',
    },
  ].map((command) => Object.freeze(command)),
);

const EXPECTED_COMMAND_IDS = Object.freeze(EXPECTED_COMMAND_CATALOG.map(({ id }) => id));
const EXPECTED_WRITE_COMMAND_IDS = Object.freeze(
  EXPECTED_COMMAND_CATALOG.filter(({ workspaceAccess }) => workspaceAccess === 'write').map(
    ({ id }) => id,
  ),
);
const EXPECTED_CLI_COMMANDS = Object.freeze(
  [
    {
      id: 'okfWorkbench.showCliStatus',
      title: 'Show CLI Status',
    },
    {
      id: 'okfWorkbench.openCliTerminal',
      title: 'Open CLI Terminal',
    },
  ].map((command) => Object.freeze(command)),
);
const EXPECTED_CLI_COMMAND_IDS = Object.freeze(EXPECTED_CLI_COMMANDS.map(({ id }) => id));
const EXPECTED_SIDEBAR_COMMANDS = Object.freeze(
  [
    {
      id: 'okfWorkbench.selectBundle',
      title: 'Select Bundle',
    },
    {
      id: 'okfWorkbench.refreshBundle',
      title: 'Refresh Bundle',
    },
    {
      id: 'okfWorkbench.openResource',
      title: 'Open Source',
    },
    {
      id: 'okfWorkbench.newConceptInFolder',
      title: 'New Concept in Folder',
    },
  ].map((command) => Object.freeze(command)),
);
const EXPECTED_SIDEBAR_COMMAND_IDS = Object.freeze(EXPECTED_SIDEBAR_COMMANDS.map(({ id }) => id));
const GENERATED_VIEW_COMMAND_SUFFIXES = Object.freeze([
  'focus',
  'open',
  'removeView',
  'resetViewLocation',
  'toggleVisibility',
]);

function deriveGeneratedViewCommandIds(packageJSON) {
  const viewGroups = packageJSON?.contributes?.views;
  if (!viewGroups || typeof viewGroups !== 'object') return [];

  const viewIds = Object.values(viewGroups)
    .flatMap((views) => (Array.isArray(views) ? views : []))
    .map((view) => view?.id)
    .filter((id) => typeof id === 'string' && id.length > 0);

  return [
    ...new Set(
      viewIds.flatMap((viewId) =>
        GENERATED_VIEW_COMMAND_SUFFIXES.map((suffix) => `${viewId}.${suffix}`),
      ),
    ),
  ].sort();
}

module.exports = {
  deriveGeneratedViewCommandIds,
  EXPECTED_CLI_COMMANDS,
  EXPECTED_CLI_COMMAND_IDS,
  EXPECTED_COMMAND_CATALOG,
  EXPECTED_COMMAND_IDS,
  EXPECTED_SIDEBAR_COMMANDS,
  EXPECTED_SIDEBAR_COMMAND_IDS,
  EXPECTED_WRITE_COMMAND_IDS,
};
