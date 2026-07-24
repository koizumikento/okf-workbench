import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

export const BUNDLED_CLI_MANIFEST = 'bundled-cli.json';
export const BUNDLED_CLI_ENVIRONMENT_VARIABLE = 'OKF_WORKBENCH_CLI';
export const BUNDLED_CLI_CONFIGURATION = 'okfWorkbench.cli.exposeInIntegratedTerminal';
export const SHOW_CLI_STATUS_COMMAND = 'okfWorkbench.showCliStatus';
export const OPEN_CLI_TERMINAL_COMMAND = 'okfWorkbench.openCliTerminal';

const SHA256_PATTERN = /^[a-f\d]{64}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const SUPPORTED_CLI_ABI_VERSION = 1;

export interface BundledCliDescriptor {
  readonly available: true;
  readonly abiVersion: number;
  readonly cliVersion: string;
  readonly coreVersion: string;
  readonly executablePath: string;
  readonly sha256: string;
  readonly targetPlatform: string;
}

export interface BundledCliUnavailable {
  readonly available: false;
  readonly reason: 'not-packaged' | 'invalid-manifest' | 'platform-mismatch' | 'invalid-executable';
}

export type BundledCliInspection = BundledCliDescriptor | BundledCliUnavailable;

export interface TerminalEnvironmentCollection {
  description?: unknown;
  append(variable: string, value: string): void;
  delete(variable: string): void;
  replace(variable: string, value: string): void;
}

interface BundledCliManifest {
  readonly schemaVersion: 1;
  readonly targetPlatform: string;
  readonly executable: 'okf' | 'okf.exe';
  readonly byteLength: number;
  readonly sha256: string;
  readonly cliVersion: string;
  readonly coreVersion: string;
  readonly abiVersion: number;
}

export function expectedTargetPlatform(
  platform: NodeJS.Platform,
  architecture: string,
): string | undefined {
  if (platform === 'darwin' && architecture === 'arm64') return 'darwin-arm64';
  if (platform === 'darwin' && architecture === 'x64') return 'darwin-x64';
  if (platform === 'linux' && architecture === 'x64') return 'linux-x64';
  if (platform === 'win32' && architecture === 'x64') return 'win32-x64';
  return undefined;
}

export function inspectBundledCli(
  distributionDirectory: string,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): BundledCliInspection {
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(
      readFileSync(join(distributionDirectory, BUNDLED_CLI_MANIFEST), 'utf8'),
    );
  } catch (error: unknown) {
    return isMissingFile(error)
      ? { available: false, reason: 'not-packaged' }
      : { available: false, reason: 'invalid-manifest' };
  }
  const manifest = decodeManifest(manifestValue);
  if (manifest === undefined) {
    return { available: false, reason: 'invalid-manifest' };
  }

  const expectedTarget = expectedTargetPlatform(platform, architecture);
  if (expectedTarget === undefined || manifest.targetPlatform !== expectedTarget) {
    return { available: false, reason: 'platform-mismatch' };
  }
  const expectedExecutable = platform === 'win32' ? 'okf.exe' : 'okf';
  if (manifest.executable !== expectedExecutable) {
    return { available: false, reason: 'invalid-manifest' };
  }

  const executablePath = join(distributionDirectory, 'bin', manifest.executable);
  try {
    const metadata = statSync(executablePath);
    if (!metadata.isFile() || metadata.size !== manifest.byteLength) {
      return { available: false, reason: 'invalid-executable' };
    }
    if (platform !== 'win32' && (metadata.mode & 0o111) === 0) {
      return { available: false, reason: 'invalid-executable' };
    }
    const sha256 = createHash('sha256').update(readFileSync(executablePath)).digest('hex');
    if (sha256 !== manifest.sha256) {
      return { available: false, reason: 'invalid-executable' };
    }
  } catch {
    return { available: false, reason: 'invalid-executable' };
  }

  return {
    available: true,
    targetPlatform: manifest.targetPlatform,
    executablePath,
    sha256: manifest.sha256,
    cliVersion: manifest.cliVersion,
    coreVersion: manifest.coreVersion,
    abiVersion: manifest.abiVersion,
  };
}

export function applyBundledCliEnvironment(
  collection: TerminalEnvironmentCollection,
  inspection: BundledCliInspection,
  enabled: boolean,
  pathDelimiter: string = delimiter,
): void {
  collection.description =
    'OKF Workbench exposes its offline CLI to new integrated terminals. Existing PATH commands keep precedence.';
  collection.delete('PATH');
  collection.delete(BUNDLED_CLI_ENVIRONMENT_VARIABLE);
  if (!enabled || !inspection.available) return;

  collection.append('PATH', `${pathDelimiter}${dirname(inspection.executablePath)}`);
  collection.replace(BUNDLED_CLI_ENVIRONMENT_VARIABLE, inspection.executablePath);
}

export function bundledCliStatusMessage(
  inspection: BundledCliInspection,
  exposedInIntegratedTerminal = true,
): string {
  if (inspection.available) {
    if (!exposedInIntegratedTerminal) {
      return `Bundled OKF CLI ${inspection.cliVersion} is available for ${inspection.targetPlatform}, but integrated-terminal exposure is disabled by ${BUNDLED_CLI_CONFIGURATION}.`;
    }
    return `Bundled OKF CLI ${inspection.cliVersion} is available for ${inspection.targetPlatform}. New integrated terminals can run okf; OKF_WORKBENCH_CLI points to this exact bundled executable.`;
  }
  const reason = {
    'not-packaged': 'this universal extension package does not contain a native CLI',
    'invalid-manifest': 'the bundled CLI manifest is invalid',
    'platform-mismatch': 'the packaged CLI does not match this Extension Host platform',
    'invalid-executable': 'the packaged CLI failed its file, permission, size, or SHA-256 check',
  }[inspection.reason];
  return `The bundled OKF CLI is unavailable because ${reason}. Extension commands remain available through the packaged Wasm core.`;
}

function decodeManifest(value: unknown): BundledCliManifest | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 8) return undefined;
  const executable = value['executable'];
  if (
    value['schemaVersion'] !== 1 ||
    typeof value['targetPlatform'] !== 'string' ||
    (executable !== 'okf' && executable !== 'okf.exe') ||
    !Number.isSafeInteger(value['byteLength']) ||
    (value['byteLength'] as number) <= 0 ||
    typeof value['sha256'] !== 'string' ||
    !SHA256_PATTERN.test(value['sha256']) ||
    typeof value['cliVersion'] !== 'string' ||
    !VERSION_PATTERN.test(value['cliVersion']) ||
    typeof value['coreVersion'] !== 'string' ||
    !VERSION_PATTERN.test(value['coreVersion']) ||
    value['abiVersion'] !== SUPPORTED_CLI_ABI_VERSION
  ) {
    return undefined;
  }
  return value as unknown as BundledCliManifest;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}
