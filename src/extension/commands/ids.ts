export const OKF_COMMANDS = [
  {
    id: 'okfWorkbench.initializeBundle',
    title: 'Initialize Bundle',
  },
  {
    id: 'okfWorkbench.newConcept',
    title: 'New Concept',
  },
  {
    id: 'okfWorkbench.validateBundle',
    title: 'Validate Bundle',
  },
  {
    id: 'okfWorkbench.regenerateIndexes',
    title: 'Regenerate Indexes',
  },
  {
    id: 'okfWorkbench.openGraph',
    title: 'Open 3D Graph',
  },
  {
    id: 'okfWorkbench.setupAgentIntegration',
    title: 'Set Up Agent Integration',
  },
] as const;

export type OkfCommandId = (typeof OKF_COMMANDS)[number]['id'];
