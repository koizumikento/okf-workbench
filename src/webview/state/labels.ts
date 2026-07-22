export const MISSING_TYPE_LABEL = 'Missing type';

/** Preserve the raw type in state and apply this fallback only at presentation boundaries. */
export function displayConceptType(type: string): string {
  return type.length === 0 ? MISSING_TYPE_LABEL : type;
}
