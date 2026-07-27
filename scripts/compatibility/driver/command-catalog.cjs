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

module.exports = {
  EXPECTED_CLI_COMMANDS,
  EXPECTED_CLI_COMMAND_IDS,
  EXPECTED_COMMAND_CATALOG,
  EXPECTED_COMMAND_IDS,
  EXPECTED_WRITE_COMMAND_IDS,
};
