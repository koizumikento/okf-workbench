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
  vscodeVersions: Object.freeze(['1.123.0', '1.143.1']),
  vscodium: Object.freeze({
    releaseVersion: '1.140.06880',
    /** Version printed by the VSCodium command-line wrapper. */
    expectedReportedVersion: '1.140.06880',
    /** Upstream VS Code API version visible inside the Extension Host. */
    expectedExtensionHostVersion: '1.140.0',
    publishedAt: '2026-10-13T17:03:30Z',
    releaseUrl: 'https://github.com/VSCodium/vscodium/releases/tag/1.140.06880',
    assets: Object.freeze({
      'linux-x64': Object.freeze({
        name: 'VSCodium-linux-x64-1.140.06880.tar.gz',
        sha256: '61223b74f9e40834117311ec4177cb386d09b84c1aae4f9e674c96580569cef3',
        size: 212538680,
      }),
      'linux-arm64': Object.freeze({
        name: 'VSCodium-linux-arm64-1.140.06880.tar.gz',
        sha256: 'a57be0d528adf7d6508318e37dbd982d695bf91501e324c37e97e11d5b375811',
        size: 208839127,
      }),
      'darwin-x64': Object.freeze({
        name: 'VSCodium-darwin-x64-1.140.06880.zip',
        sha256: 'e828c20847f4c00f0d9396f168a6cd536d0df5e32903b880541ddc8022264a97',
        size: 213449037,
      }),
      'darwin-arm64': Object.freeze({
        name: 'VSCodium-darwin-arm64-1.140.06880.zip',
        sha256: '3a0ba1a13b6d743f79ffc20bebd7a2ef8bab2b40e54bcc80fae123da9ed552e0',
        size: 206074452,
      }),
      'win32-x64': Object.freeze({
        name: 'VSCodium-win32-x64-1.140.06880.zip',
        sha256: '024ae1e88f431aee300e73c2ece92e42ebde80a7f3c484ff684f455ffa6a6a7f',
        size: 229054371,
      }),
      'win32-arm64': Object.freeze({
        name: 'VSCodium-win32-arm64-1.140.06880.zip',
        sha256: 'c0eb6a22e4c7bbf61b3be0d065496831ea9857cc2510111071eb4bab56e7ae29',
        size: 221724890,
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
