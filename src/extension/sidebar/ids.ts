export const SIDEBAR_CONTAINER_ID = 'okfWorkbench';
export const BUNDLE_VIEW_ID = 'okfWorkbench.bundle';
export const RESOURCES_VIEW_ID = 'okfWorkbench.resources';
export const ACTIONS_VIEW_ID = 'okfWorkbench.actions';

export const SELECT_BUNDLE_COMMAND = 'okfWorkbench.selectBundle';
export const REFRESH_BUNDLE_COMMAND = 'okfWorkbench.refreshBundle';
export const OPEN_RESOURCE_COMMAND = 'okfWorkbench.openResource';
export const NEW_CONCEPT_IN_FOLDER_COMMAND = 'okfWorkbench.newConceptInFolder';

export const SIDEBAR_COMMANDS = [
  { id: SELECT_BUNDLE_COMMAND, title: 'Select Bundle' },
  { id: REFRESH_BUNDLE_COMMAND, title: 'Refresh Bundle' },
  { id: OPEN_RESOURCE_COMMAND, title: 'Open Source' },
  { id: NEW_CONCEPT_IN_FOLDER_COMMAND, title: 'New Concept in Folder' },
] as const;

export const HAS_SELECTED_BUNDLE_CONTEXT = 'okfWorkbench.hasSelectedBundle';
export const SIDEBAR_STATE_CONTEXT = 'okfWorkbench.sidebarState';
