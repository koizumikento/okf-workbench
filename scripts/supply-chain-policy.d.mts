export interface SupplyChainPolicyResult {
  readonly installScriptDecisionCount: number;
  readonly workflowCount: number;
}

export interface InstallScriptPolicyInput {
  readonly npmrc: string;
  readonly packageManifest: Readonly<Record<string, unknown>>;
  readonly packageLock: Readonly<Record<string, unknown>>;
}

export const EXPECTED_INSTALL_SCRIPT_DECISIONS: Readonly<Record<string, boolean>>;

export function workflowActionReferenceFailures(
  workflowPath: string,
  workflowSource: string,
): readonly string[];

export function licenseNoticeWorkflowFailures(
  workflowPath: string,
  workflowSource: string,
): readonly string[];

export function securityWorkflowGateFailures(
  workflowPath: string,
  workflowSource: string,
): readonly string[];

export function releaseWorkflowSafetyFailures(
  workflowPath: string,
  workflowSource: string,
): readonly string[];

export function securityPackageScriptFailures(
  packageManifest: Readonly<Record<string, unknown>>,
): readonly string[];

export function installScriptPolicyFailures(input: InstallScriptPolicyInput): readonly string[];

export function validateRepositorySupplyChainPolicy(
  repositoryRoot: string,
): Promise<SupplyChainPolicyResult>;
