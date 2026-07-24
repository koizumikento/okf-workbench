import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createVSIX } from '@vscode/vsce';

import { requireBundledCliTarget } from './cli-targets.mjs';
import { normalizeVsixFile } from './normalize-vsix.mjs';

export const VSIX_SOURCE_DATE_EPOCH = '946684800';

export async function packageVsix(outputPath, repositoryRoot = process.cwd(), options = {}) {
  const destination = resolve(repositoryRoot, outputPath);
  const originalSourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
  const bundledCli = await prepareBundledCli(repositoryRoot, options);

  try {
    // VSCE sorts archive entries only when SOURCE_DATE_EPOCH is present. Its
    // timestamps and platform file attributes are normalized again below so
    // package bytes remain independent of the runner's clock, time zone, and
    // filesystem mode defaults.
    process.env.SOURCE_DATE_EPOCH = VSIX_SOURCE_DATE_EPOCH;
    await createVSIX({
      allowMissingRepository: true,
      cwd: repositoryRoot,
      packagePath: destination,
      ...(options.target === undefined ? {} : { target: options.target }),
    });
    await normalizeVsixFile(destination, {
      executableEntries: bundledCli?.executable === 'okf' ? ['extension/dist/bin/okf'] : [],
    });
  } finally {
    if (originalSourceDateEpoch === undefined) delete process.env.SOURCE_DATE_EPOCH;
    else process.env.SOURCE_DATE_EPOCH = originalSourceDateEpoch;
  }

  return { destination, bundledCli };
}

export function parsePackageArguments(arguments_) {
  const outputPath = arguments_[0];
  if (outputPath === undefined) {
    throw new Error(
      'Usage: node scripts/package-vsix.mjs <output-vsix> [--target <target> --cli <native-binary>]',
    );
  }
  let target;
  let cliPath;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if ((argument !== '--target' && argument !== '--cli') || value === undefined) {
      throw new Error(
        'Usage: node scripts/package-vsix.mjs <output-vsix> [--target <target> --cli <native-binary>]',
      );
    }
    if (argument === '--target') target = value;
    else cliPath = value;
    index += 1;
  }
  if ((target === undefined) !== (cliPath === undefined)) {
    throw new Error('--target and --cli must be supplied together.');
  }
  return { outputPath, ...(target === undefined ? {} : { target, cliPath }) };
}

async function prepareBundledCli(repositoryRoot, options) {
  const distDirectory = resolve(repositoryRoot, 'dist');
  await rm(resolve(distDirectory, 'bin'), { force: true, recursive: true });
  await rm(resolve(distDirectory, 'bundled-cli.json'), { force: true });
  if (options.target === undefined && options.cliPath === undefined) return undefined;
  if (typeof options.target !== 'string' || typeof options.cliPath !== 'string') {
    throw new Error('A platform package requires both target and cliPath.');
  }

  const target = requireBundledCliTarget(options.target);
  const cliPath = resolve(repositoryRoot, options.cliPath);
  const packageManifest = JSON.parse(
    await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'),
  );
  let versionEnvelope;
  try {
    versionEnvelope = JSON.parse(
      execFileSync(cliPath, ['version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch (error) {
    throw new Error(
      `The native CLI did not return a valid version envelope: ${errorMessage(error)}`,
    );
  }
  if (
    versionEnvelope?.schemaVersion !== 1 ||
    versionEnvelope?.command !== 'version' ||
    versionEnvelope?.result?.cliVersion !== packageManifest.version ||
    typeof versionEnvelope?.result?.coreVersion !== 'string' ||
    versionEnvelope?.result?.abiVersion !== 1
  ) {
    throw new Error(
      'The native CLI version envelope does not match the extension package version and ABI contract.',
    );
  }

  const bytes = await readFile(cliPath);
  if (bytes.byteLength === 0) {
    throw new Error('The native CLI binary is empty.');
  }
  const outputDirectory = resolve(distDirectory, 'bin');
  const executablePath = resolve(outputDirectory, target.binary);
  await mkdir(outputDirectory, { recursive: true });
  await copyFile(cliPath, executablePath);
  if (target.binary === 'okf') {
    await chmod(executablePath, 0o755);
  }
  const bundledCli = {
    schemaVersion: 1,
    targetPlatform: options.target,
    executable: target.binary,
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    cliVersion: versionEnvelope.result.cliVersion,
    coreVersion: versionEnvelope.result.coreVersion,
    abiVersion: versionEnvelope.result.abiVersion,
  };
  await writeFile(
    resolve(distDirectory, 'bundled-cli.json'),
    `${JSON.stringify(bundledCli, null, 2)}\n`,
    'utf8',
  );
  return bundledCli;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const options = parsePackageArguments(process.argv.slice(2));
  const result = await packageVsix(options.outputPath, process.cwd(), options);
  console.log(
    `Created deterministic ${options.target ?? 'universal'} VSIX at ${result.destination}.`,
  );
}
