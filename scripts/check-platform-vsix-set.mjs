import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateVsixFile } from './package-check.mjs';

export const EXPECTED_PLATFORM_ARTIFACTS = Object.freeze([
  Object.freeze({
    artifactLabel: 'okf-workbench-package-smoke-Linux-X64',
    targetPlatform: 'linux-x64',
  }),
  Object.freeze({
    artifactLabel: 'okf-workbench-package-smoke-Windows-X64',
    targetPlatform: 'win32-x64',
  }),
  Object.freeze({
    artifactLabel: 'okf-workbench-package-smoke-macOS-ARM64',
    targetPlatform: 'darwin-arm64',
  }),
  Object.freeze({
    artifactLabel: 'okf-workbench-package-smoke-macOS-X64',
    targetPlatform: 'darwin-x64',
  }),
]);

export async function verifyPlatformVsixSet(rootDirectory) {
  const root = resolve(rootDirectory);
  const rootEntries = await readdir(root, { withFileTypes: true });
  const expectedLabels = new Set(
    EXPECTED_PLATFORM_ARTIFACTS.map(({ artifactLabel }) => artifactLabel),
  );
  const actualDirectories = rootEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const missing = [...expectedLabels].filter((label) => !actualDirectories.includes(label));
  const unexpected = rootEntries.filter(
    (entry) => !entry.isDirectory() || !expectedLabels.has(entry.name),
  );
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Platform VSIX artifact set is incomplete or unexpected. Missing: ${missing.join(', ') || '(none)'}; unexpected: ${unexpected.map((entry) => entry.name).join(', ') || '(none)'}.`,
    );
  }

  const candidates = [];
  for (const expected of EXPECTED_PLATFORM_ARTIFACTS) {
    const directory = resolve(root, expected.artifactLabel);
    const entries = await readdir(directory, { withFileTypes: true });
    const candidatesInDirectory = entries.filter(
      (entry) => entry.isFile() && entry.name.endsWith('.vsix'),
    );
    if (candidatesInDirectory.length !== 1 || entries.some((entry) => !entry.isFile())) {
      throw new Error(
        `${expected.artifactLabel} must contain exactly one direct VSIX and only regular files.`,
      );
    }
    const path = resolve(directory, candidatesInDirectory[0].name);
    const result = await validateVsixFile(path);
    if (result.targetPlatform !== expected.targetPlatform || result.bundledCli === undefined) {
      throw new Error(
        `${expected.artifactLabel} contains ${String(result.targetPlatform)} instead of ${expected.targetPlatform}.`,
      );
    }
    candidates.push({
      ...expected,
      path,
      wasmSha256: result.wasmSha256,
      cliSha256: result.bundledCli.sha256,
    });
  }

  const wasmSha256 = candidates[0]?.wasmSha256;
  if (
    wasmSha256 === undefined ||
    candidates.some((candidate) => candidate.wasmSha256 !== wasmSha256)
  ) {
    throw new Error(
      `Platform VSIX packages do not share one canonical Wasm core:\n${candidates
        .map((candidate) => `${candidate.targetPlatform}: ${candidate.wasmSha256}`)
        .join('\n')}`,
    );
  }
  return { candidates, wasmSha256 };
}

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const rootDirectory = process.argv[2];
  if (rootDirectory === undefined || process.argv.length !== 3) {
    throw new Error('Usage: node scripts/check-platform-vsix-set.mjs <artifact-root>');
  }
  const result = await verifyPlatformVsixSet(rootDirectory);
  console.log(
    `Platform VSIX set passed: ${String(result.candidates.length)} targets share Wasm ${result.wasmSha256}.`,
  );
}
