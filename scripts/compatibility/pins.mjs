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
  vscodeVersions: Object.freeze(['1.121.0', '1.127.0']),
  vscodium: Object.freeze({
    releaseVersion: '1.121.03429',
    /** Version printed by the VSCodium command-line wrapper. */
    expectedReportedVersion: '1.121.03429',
    /** Upstream VS Code API version visible inside the Extension Host. */
    expectedExtensionHostVersion: '1.121.0',
    publishedAt: '2026-05-22T22:14:58Z',
    releaseUrl: 'https://github.com/VSCodium/vscodium/releases/tag/1.121.03429',
    assets: Object.freeze({
      'linux-x64': Object.freeze({
        name: 'VSCodium-linux-x64-1.121.03429.tar.gz',
        sha256: '2c9b06735d4c1face570935f4968d358f9f6269f5d9237813d0b825c7d70a143',
        size: 184234252,
      }),
      'linux-arm64': Object.freeze({
        name: 'VSCodium-linux-arm64-1.121.03429.tar.gz',
        sha256: '993e5dbf0f06399d069d968a452fd30334031046033a0723eb0ea534bcb9910d',
        size: 180064975,
      }),
      'darwin-x64': Object.freeze({
        name: 'VSCodium-darwin-x64-1.121.03429.zip',
        sha256: '6c2ec07c7d9e2a69ac58838789f346283fe4550098cae31f5374948a5d035e43',
        size: 190094492,
      }),
      'darwin-arm64': Object.freeze({
        name: 'VSCodium-darwin-arm64-1.121.03429.zip',
        sha256: '73c2b5ed72a9446d638b69947e8ca0dbe71117ea9cd4a54c61591a428508cfb6',
        size: 181833721,
      }),
      'win32-x64': Object.freeze({
        name: 'VSCodium-win32-x64-1.121.03429.zip',
        sha256: 'cde622b803be7e0e24742790a2f3583eeeadae91c9332ea78af579853625bd8d',
        size: 200850132,
      }),
      'win32-arm64': Object.freeze({
        name: 'VSCodium-win32-arm64-1.121.03429.zip',
        sha256: '661ba191c8f4a590275554c8d983fbde105b960656c55cc8929413a9935affff',
        size: 197184689,
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
