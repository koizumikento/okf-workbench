import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  errorMessage,
  optionalArgument,
  parseArguments,
  requiredArgument,
  runnerEvidence,
  writeJson,
} from './shared.mjs';

export const COMPATIBILITY_PINS = Object.freeze({
  schemaVersion: 1,
  extensionId: 'straydog.okf-workbench',
  nodeVersion: '24.18.0',
  npmVersion: '11.16.0',
  vscodeVersions: Object.freeze(['1.123.0', '1.145.2']),
  vscodium: Object.freeze({
    releaseVersion: '1.143.17232',
    /** Version printed by the VSCodium command-line wrapper. */
    expectedReportedVersion: '1.143.17232',
    /** Upstream VS Code API version visible inside the Extension Host. */
    expectedExtensionHostVersion: '1.143.1',
    publishedAt: '2026-10-28T08:54:31Z',
    releaseUrl: 'https://github.com/VSCodium/vscodium/releases/tag/1.143.17232',
    assets: Object.freeze({
      'linux-x64': Object.freeze({
        name: 'VSCodium-linux-x64-1.143.17232.tar.gz',
        sha256: 'ca1895aa040bd91a09c709d79eac7862d8c1aa0237fdc25b503deeb8bcd87efd',
        size: 214776735,
      }),
      'linux-arm64': Object.freeze({
        name: 'VSCodium-linux-arm64-1.143.17232.tar.gz',
        sha256: '9f270ae242561812acd02be9cf5c13c848da359b356327adfe44b815a9532309',
        size: 210926588,
      }),
      'darwin-x64': Object.freeze({
        name: 'VSCodium-darwin-x64-1.143.17232.zip',
        sha256: '6f11e188a16decf417623a94593370ee87fc40445d09c0ff49e30af57a5087f5',
        size: 215768189,
      }),
      'darwin-arm64': Object.freeze({
        name: 'VSCodium-darwin-arm64-1.143.17232.zip',
        sha256: 'ade8f5e0ebf47e5ea9e2478844f150c68e43def192b6f8be05d0329d25ec0917',
        size: 208196082,
      }),
      'win32-x64': Object.freeze({
        name: 'VSCodium-win32-x64-1.143.17232.zip',
        sha256: 'a1090868af8ac0ac04c22d79fdd02246fa115a78daf38a741d8db06df1753c1d',
        size: 231406156,
      }),
      'win32-arm64': Object.freeze({
        name: 'VSCodium-win32-arm64-1.143.17232.zip',
        sha256: 'fa90eb32767212403885e01aa1b8b872ed786fa000e6ef96570f95ffbc8bb3eb',
        size: 223765351,
      }),
    }),
  }),
});

export function normalizePlatform(value = process.platform) {
  const normalized = value.toLowerCase();
  if (normalized === 'linux' || normalized === 'darwin' || normalized === 'win32') {
    return normalized;
  }
  throw new Error(`Unsupported desktop platform: ${JSON.stringify(value)}.`);
}

export function normalizeArchitecture(value = process.arch) {
  const normalized = value.toLowerCase();
  if (normalized === 'x64' || normalized === 'amd64') return 'x64';
  if (normalized === 'arm64' || normalized === 'aarch64') return 'arm64';
  throw new Error(`Unsupported desktop architecture: ${JSON.stringify(value)}.`);
}

export function getVscodiumAsset(platform = process.platform, architecture = process.arch) {
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedArchitecture = normalizeArchitecture(architecture);
  const key = `${normalizedPlatform}-${normalizedArchitecture}`;
  const asset = COMPATIBILITY_PINS.vscodium.assets[key];
  if (asset === undefined) {
    throw new Error(`No pinned VSCodium asset exists for ${key}.`);
  }
  return {
    ...asset,
    platform: normalizedPlatform,
    architecture: normalizedArchitecture,
    url: `https://github.com/VSCodium/vscodium/releases/download/${COMPATIBILITY_PINS.vscodium.releaseVersion}/${asset.name}`,
  };
}

function validateRequestedEditor(editor, version) {
  if (editor === 'vscode') {
    if (!COMPATIBILITY_PINS.vscodeVersions.includes(version)) {
      throw new Error(`VS Code ${version} is not in the pinned compatibility matrix.`);
    }
    return;
  }
  if (editor === 'vscodium' && version === COMPATIBILITY_PINS.vscodium.releaseVersion) {
    return;
  }
  throw new Error(`Unsupported editor pin: ${editor} ${version}.`);
}

async function main() {
  const args = parseArguments(process.argv.slice(2), ['json']);
  if (args.get('json') === true) {
    process.stdout.write(`${JSON.stringify(COMPATIBILITY_PINS, null, 2)}\n`);
    return;
  }

  const evidencePath = requiredArgument(args, 'evidence');
  const editor = requiredArgument(args, 'editor');
  const version = requiredArgument(args, 'version');
  const expectedExtensionId =
    optionalArgument(args, 'expected-extension-id') ?? COMPATIBILITY_PINS.extensionId;
  const evidence = {
    schemaVersion: 1,
    kind: 'compatibility-workflow',
    status: 'passed',
    recordedAt: new Date().toISOString(),
    repositoryRevision: process.env.GITHUB_SHA ?? null,
    editor,
    version,
    expectedExtensionId,
    pins: COMPATIBILITY_PINS,
    runner: runnerEvidence(),
  };

  try {
    validateRequestedEditor(editor, version);
    if (expectedExtensionId !== COMPATIBILITY_PINS.extensionId) {
      throw new Error(
        `Extension ID ${expectedExtensionId} does not match the pinned ID ${COMPATIBILITY_PINS.extensionId}.`,
      );
    }
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = errorMessage(error);
    await writeJson(evidencePath, evidence);
    throw error;
  }

  await writeJson(evidencePath, evidence);
}

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  await main();
}
