export type CommandWorkspaceAccess = 'read' | 'write';

export interface ExpectedCommandMetadata {
  readonly id: string;
  readonly title: string;
  readonly workspaceAccess: CommandWorkspaceAccess;
}

export interface ExpectedCliCommandMetadata {
  readonly id: string;
  readonly title: string;
}

export const EXPECTED_CLI_COMMANDS: readonly ExpectedCliCommandMetadata[];
export const EXPECTED_CLI_COMMAND_IDS: readonly string[];
export const EXPECTED_COMMAND_CATALOG: readonly ExpectedCommandMetadata[];
export const EXPECTED_COMMAND_IDS: readonly string[];
export const EXPECTED_WRITE_COMMAND_IDS: readonly string[];
