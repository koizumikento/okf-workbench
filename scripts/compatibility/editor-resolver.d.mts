export interface ExtensionHostVersionOracle {
  readonly editor: string;
  readonly requestedVersion: string;
  readonly expectedExtensionHostVersion: string;
}

export interface ExtensionHostVersionEvidence {
  readonly requestedEditorVersion: string;
  readonly expectedExtensionHostVersion: string;
  readonly reportedExtensionHostVersion: string;
}

export function assertExtensionHostVersion(
  editor: ExtensionHostVersionOracle,
  reportedVersion: unknown,
): ExtensionHostVersionEvidence;
