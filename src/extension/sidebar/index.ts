export {
  ACTIONS_VIEW_ID,
  BUNDLE_VIEW_ID,
  HAS_SELECTED_BUNDLE_CONTEXT,
  NEW_CONCEPT_IN_FOLDER_COMMAND,
  OPEN_RESOURCE_COMMAND,
  REFRESH_BUNDLE_COMMAND,
  RESOURCES_VIEW_ID,
  SELECT_BUNDLE_COMMAND,
  SIDEBAR_COMMANDS,
  SIDEBAR_CONTAINER_ID,
  SIDEBAR_STATE_CONTEXT,
} from './ids.js';
export {
  VscodeSidebarService,
  type SidebarResourceElement,
  type VscodeSidebarOptions,
} from './vscodeSidebar.js';
export {
  buildSidebarBundleSummary,
  buildSidebarResourceTree,
  displayText,
  type SidebarBundleSummary,
  type SidebarConceptResource,
  type SidebarFindingCounts,
  type SidebarFolderResource,
  type SidebarReservedResource,
  type SidebarResource,
} from './model.js';
