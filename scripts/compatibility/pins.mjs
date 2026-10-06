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
  vscodeVersions: Object.freeze(['1.123.0', '1.140.0']),
  vscodium: Object.freeze({
    releaseVersion: '1.135.06055',
    /** Version printed by the VSCodium command-line wrapper. */
    expectedReportedVersion: '1.135.06055',
    /** Upstream VS Code API version visible inside the Extension Host. */
    expectedExtensionHostVersion: '1.135.0',
    publishedAt: '2026-09-09T08:19:21Z',
    releaseUrl: 'https://github.com/VSCodium/vscodium/releases/tag/1.135.06055',
    assets: Object.freeze({
      'linux-x64': Object.freeze({
        name: 'VSCodium-linux-x64-1.135.06055.tar.gz',
        sha256: 'c09d8ac8dd7f52b09ee159ee24b440541dfd8f937a0f6f88cc428c78e48ee1f2',
        size: 243185899,
      }),
      'linux-arm64': Object.freeze({
        name: 'VSCodium-linux-arm64-1.135.06055.tar.gz',
        sha256: '9765cea4f707ff7dc83a40be408a7318a59abb6996b359631639d9aab2f48a90',
        size: 237904555,
      }),
      'darwin-x64': Object.freeze({
        name: 'VSCodium-darwin-x64-1.135.06055.zip',
        sha256: '2fce180317a011576dc7e0910e1033d3287472b56e362b33175f5416415b604a',
        size: 243084648,
      }),
      'darwin-arm64': Object.freeze({
        name: 'VSCodium-darwin-arm64-1.135.06055.zip',
        sha256: '61ff9ebc3ac5563c63a0a9e1b479822647e7f2c3303b0629f15fefe9e291f7cc',
        size: 237868790,
      }),
      'win32-x64': Object.freeze({
        name: 'VSCodium-win32-x64-1.135.06055.zip',
        sha256: '0bec978f201238624bc9ad43966f5e201ed8afacc37d77035a822252d9c9c200',
        size: 250898961,
      }),
      'win32-arm64': Object.freeze({
        name: 'VSCodium-win32-arm64-1.135.06055.zip',
        sha256: '079aafaf0a141abd3a0b2078eca0a86b502cee38089014b81415ebb8e3675f21',
        size: 250511125,
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
