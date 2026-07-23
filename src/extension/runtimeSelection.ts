export interface RuntimeSelectionIdentity {
  readonly root: string;
  readonly workspaceSafetyRoot: string;
}

/**
 * Workspace-folder lifecycle is stronger than serialized URI equality.
 *
 * A host event may remove and add the same URI in one transition. The active
 * provider generation must still be discarded when its exact safety root
 * appears in `removedWorkspaceSafetyRoots`.
 */
export function activeWorkspaceSafetyRootWasRemoved(
  selection: RuntimeSelectionIdentity | undefined,
  removedWorkspaceSafetyRoots: readonly string[],
): boolean {
  if (selection === undefined) {
    return false;
  }
  return removedWorkspaceSafetyRoots.includes(selection.workspaceSafetyRoot);
}
