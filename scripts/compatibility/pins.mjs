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
  vscodeVersions: Object.freeze(['1.123.0', '1.129.1']),
  vscodium: Object.freeze({
    releaseVersion: '1.126.04524',
    /** Version printed by the VSCodium command-line wrapper. */
    expectedReportedVersion: '1.126.04524',
    /** Upstream VS Code API version visible inside the Extension Host. */
    expectedExtensionHostVersion: '1.126.0',
    publishedAt: '2026-07-07T13:01:09Z',
    releaseUrl: 'https://github.com/VSCodium/vscodium/releases/tag/1.126.04524',
    assets: Object.freeze({
      'linux-x64': Object.freeze({
        name: 'VSCodium-linux-x64-1.126.04524.tar.gz',
        sha256: 'adf3548df055d18e476cdee887488ba7486b879ad99a31a546c6b5c5ff296c24',
        size: 213520591,
      }),
      'linux-arm64': Object.freeze({
        name: 'VSCodium-linux-arm64-1.126.04524.tar.gz',
        sha256: '73d87d46d4dc208fe12c0497dc607aab0a6e2bf332f54a0b6826a3a1aa32bc34',
        size: 209405982,
      }),
      'darwin-x64': Object.freeze({
        name: 'VSCodium-darwin-x64-1.126.04524.zip',
        sha256: 'fa0637bf6fa511487611bc65dc47b0d4e247513e16309879bf9bd4677cf5243e',
        size: 219148727,
      }),
      'darwin-arm64': Object.freeze({
        name: 'VSCodium-darwin-arm64-1.126.04524.zip',
        sha256: 'f21ee52629eb5e39c055daea70118b7a6055c639aecf3dad05e1997a9ad83ac0',
        size: 210873558,
      }),
      'win32-x64': Object.freeze({
        name: 'VSCodium-win32-x64-1.126.04524.zip',
        sha256: '5b5bc348861ce861aed968b086233b45050694013c0607ea66b401f31b987c57',
        size: 231115354,
      }),
      'win32-arm64': Object.freeze({
        name: 'VSCodium-win32-arm64-1.126.04524.zip',
        sha256: 'f1b6c2303c6c69142aec6f0d4bb8048c7a9f664fcc535b0adc7ff02eac66dae7',
        size: 226260661,
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
