export const OKF_COMMANDS = [
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
] as const;

export type OkfCommandId = (typeof OKF_COMMANDS)[number]['id'];
export type OkfCommandWorkspaceAccess = (typeof OKF_COMMANDS)[number]['workspaceAccess'];
export type OkfCommandMetadata = (typeof OKF_COMMANDS)[number];
