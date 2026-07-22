export {
  mergeManagedRegion,
  type ManagedRegionMarkers,
  type ManagedRegionMergeInput,
} from './managed-region.js';
export {
  planIndexes,
  planProviderIndexes,
  type ExistingIndexInput,
  type IndexChange,
  type IndexConceptInput,
  type IndexGenerationMode,
  type IndexPlan,
  type IndexPlanInput,
} from './plan.js';
export {
  INDEX_END_MARKER,
  INDEX_START_MARKER,
  renderManagedIndexRegion,
  renderNewIndexDocument,
  type IndexConceptEntry,
  type IndexDirectoryEntry,
  type IndexEntry,
} from './render.js';
