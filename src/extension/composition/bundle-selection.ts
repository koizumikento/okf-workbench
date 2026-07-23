export interface BundleCandidateChoice<TCandidate> {
  readonly choiceKind: 'candidate';
  readonly label: string;
  readonly description: string;
  readonly candidate: TCandidate;
}

export interface BrowseBundleChoice {
  readonly choiceKind: 'browse';
  readonly label: string;
  readonly description: string;
}

export type BundleSelectionChoice<TCandidate> =
  BundleCandidateChoice<TCandidate> | BrowseBundleChoice;

/** Keeps the explicit directory override reachable when automatic discovery is ambiguous. */
export function bundleSelectionChoices<TCandidate>(
  candidates: readonly TCandidate[],
  describe: (candidate: TCandidate) => { readonly label: string; readonly description: string },
): readonly BundleSelectionChoice<TCandidate>[] {
  return [
    ...candidates.map((candidate): BundleCandidateChoice<TCandidate> => ({
      choiceKind: 'candidate',
      ...describe(candidate),
      candidate,
    })),
    {
      choiceKind: 'browse',
      label: '$(folder-opened) Select another bundle root…',
      description: 'Choose any directory inside an open workspace',
    },
  ];
}
