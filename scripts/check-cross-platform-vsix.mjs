import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXPECTED_CROSS_PLATFORM_ARTIFACT_LABELS = Object.freeze([
  'okf-workbench-package-smoke-Linux-X64',
  'okf-workbench-package-smoke-Windows-X64',
  'okf-workbench-package-smoke-macOS-ARM64',
]);

export const CROSS_PLATFORM_VSIX_FILENAME = 'okf-workbench.vsix';

function entryKind(entry) {
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  if (entry.isSymbolicLink()) return 'symbolic link';
  return 'other';
}

function formatDirectoryInventory(entries) {
  if (entries.length === 0) return '  (empty)';
  return entries.map((entry) => `  ${JSON.stringify(entry.name)} [${entryKind(entry)}]`).join('\n');
}

function validateRootLayout(root, entries) {
  const expectedLabels = new Set(EXPECTED_CROSS_PLATFORM_ARTIFACT_LABELS);
  const missing = EXPECTED_CROSS_PLATFORM_ARTIFACT_LABELS.filter(
    (label) => !entries.some((entry) => entry.name === label && entry.isDirectory()),
  );
  const unexpected = entries.filter(
    (entry) => !expectedLabels.has(entry.name) || !entry.isDirectory(),
  );

  if (missing.length === 0 && unexpected.length === 0) return;

  const details = [];
  if (missing.length > 0) details.push(`Missing artifact directories: ${missing.join(', ')}`);
  if (unexpected.length > 0) {
    details.push(
      `Unexpected root entries: ${unexpected
        .map((entry) => `${JSON.stringify(entry.name)} [${entryKind(entry)}]`)
        .join(', ')}`,
    );
  }
  throw new Error(
    `Cross-platform artifact layout is invalid under ${root}.\n${details.join('\n')}\nRoot inventory:\n${formatDirectoryInventory(entries)}`,
  );
}

async function locateCandidate(root, artifactLabel) {
  const artifactDirectory = resolve(root, artifactLabel);
  const entries = await readdir(artifactDirectory, { withFileTypes: true });
  const candidateEntries = entries.filter((entry) => entry.name === CROSS_PLATFORM_VSIX_FILENAME);
  const additionalVsixEntries = entries.filter(
    (entry) => entry.name !== CROSS_PLATFORM_VSIX_FILENAME && entry.name.endsWith('.vsix'),
  );
  const nestedDirectories = entries.filter((entry) => entry.isDirectory());
  const unsafeEntries = entries.filter((entry) => !entry.isDirectory() && !entry.isFile());
  const hasOneDirectRegularCandidate =
    candidateEntries.length === 1 && candidateEntries[0]?.isFile() === true;

  if (
    !hasOneDirectRegularCandidate ||
    additionalVsixEntries.length > 0 ||
    nestedDirectories.length > 0 ||
    unsafeEntries.length > 0
  ) {
    throw new Error(
      `Artifact directory ${artifactLabel} is invalid at ${artifactDirectory}.\n` +
        `Expected exactly one direct regular ${CROSS_PLATFORM_VSIX_FILENAME}, no additional .vsix files, and no nested or non-regular entries.\n` +
        `Artifact inventory:\n${formatDirectoryInventory(entries)}`,
    );
  }

  return resolve(artifactDirectory, CROSS_PLATFORM_VSIX_FILENAME);
}

export async function verifyCrossPlatformVsix(rootDirectory) {
  const root = resolve(rootDirectory);
  const rootEntries = await readdir(root, { withFileTypes: true });
  validateRootLayout(root, rootEntries);

  const candidates = await Promise.all(
    EXPECTED_CROSS_PLATFORM_ARTIFACT_LABELS.map(async (artifactLabel) => {
      const path = await locateCandidate(root, artifactLabel);
      const content = await readFile(path);
      return {
        artifactLabel,
        path,
        sha256: createHash('sha256').update(content).digest('hex'),
        size: content.length,
      };
    }),
  );
  const first = candidates[0];
  if (first === undefined) throw new Error('No VSIX candidate was found.');

  const mismatch = candidates.find(
    (candidate) => candidate.sha256 !== first.sha256 || candidate.size !== first.size,
  );
  if (mismatch !== undefined) {
    const inventory = candidates
      .map(
        (candidate) =>
          `${candidate.artifactLabel}: ${candidate.sha256} ${String(candidate.size)} ${candidate.path}`,
      )
      .join('\n');
    throw new Error(`Cross-platform VSIX bytes differ:\n${inventory}`);
  }

  return { candidates, sha256: first.sha256, size: first.size };
}

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const rootDirectory = process.argv[2];
  if (rootDirectory === undefined || process.argv.length > 3) {
    throw new Error('Usage: node scripts/check-cross-platform-vsix.mjs <artifact-root>');
  }
  const result = await verifyCrossPlatformVsix(rootDirectory);
  console.log(
    `Cross-platform VSIX byte identity passed: ${result.sha256} (${String(result.size)} bytes, ${String(result.candidates.length)} artifacts).`,
  );
}
