import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateRepositorySupplyChainPolicy } from './supply-chain-policy.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const supplyChainPolicy = await validateRepositorySupplyChainPolicy(repositoryRoot);
const packageManifest = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'));
const packageLock = JSON.parse(
  await readFile(resolve(repositoryRoot, 'package-lock.json'), 'utf8'),
);
const expectedRuntimeDependencies = new Set([
  '3d-force-graph',
  'micromark',
  'micromark-core-commonmark',
  'micromark-util-decode-string',
  'micromark-util-subtokenize',
  'remark-parse',
  'unified',
  'yaml',
]);

const runtimeDependencyNames = Object.keys(packageManifest.dependencies ?? {}).sort();
const unexpectedDependencies = runtimeDependencyNames.filter(
  (dependency) => !expectedRuntimeDependencies.has(dependency),
);
const missingDependencies = [...expectedRuntimeDependencies].filter(
  (dependency) => !runtimeDependencyNames.includes(dependency),
);

if (unexpectedDependencies.length > 0 || missingDependencies.length > 0) {
  throw new Error(
    `Runtime dependency boundary changed. Unexpected: ${unexpectedDependencies.join(', ') || 'none'}; missing: ${missingDependencies.join(', ') || 'none'}.`,
  );
}

const packageEntries = Object.entries(packageLock.packages ?? {})
  .filter(([path, metadata]) => path.startsWith('node_modules/') && metadata.dev !== true)
  .sort(([left], [right]) => left.localeCompare(right));

const licenseEvidence = [];
const missingLicenses = [];
const nativeArtifacts = [];

for (const [lockPath, lockMetadata] of packageEntries) {
  const packageDirectory = resolve(repositoryRoot, lockPath);
  const installedManifest = JSON.parse(
    await readFile(resolve(packageDirectory, 'package.json'), 'utf8'),
  );
  const license = installedManifest.license ?? lockMetadata.license;

  if (typeof license !== 'string' || license.trim() === '') {
    missingLicenses.push(`${installedManifest.name}@${installedManifest.version}`);
  }

  licenseEvidence.push({
    license: typeof license === 'string' ? license : null,
    name: installedManifest.name,
    version: installedManifest.version,
  });

  for (const candidate of ['binding.gyp']) {
    try {
      const candidatePath = resolve(packageDirectory, candidate);
      if ((await stat(candidatePath)).isFile()) {
        nativeArtifacts.push(candidatePath.slice(repositoryRoot.length + 1));
      }
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  const pendingDirectories = [packageDirectory];
  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop();
    if (currentDirectory === undefined) {
      continue;
    }
    for (const entry of await readdir(currentDirectory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') {
        continue;
      }
      const entryPath = resolve(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        pendingDirectories.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith('.node')) {
        nativeArtifacts.push(entryPath.slice(repositoryRoot.length + 1));
      }
    }
  }
}

if (missingLicenses.length > 0) {
  throw new Error(`Runtime packages without license metadata: ${missingLicenses.join(', ')}`);
}

if (nativeArtifacts.length > 0) {
  throw new Error(`Native Node artifacts are not allowed: ${nativeArtifacts.join(', ')}`);
}

await mkdir(resolve(repositoryRoot, 'artifacts'), { recursive: true });
await writeFile(
  resolve(repositoryRoot, 'artifacts/runtime-licenses.json'),
  `${JSON.stringify(licenseEvidence, null, 2)}\n`,
  'utf8',
);

console.log(
  `Reviewed ${licenseEvidence.length} runtime packages, ${supplyChainPolicy.workflowCount} workflows, and ${supplyChainPolicy.installScriptDecisionCount} install-script decisions; license metadata is present, action references are immutable, and no native Node artifacts were found.`,
);
