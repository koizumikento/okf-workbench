import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createVSIX } from '@vscode/vsce';

import { COMPATIBILITY_PINS } from './pins.mjs';
import {
  errorMessage,
  optionalArgument,
  parseArguments,
  requiredArgument,
  runnerEvidence,
  sha256File,
  writeJson,
} from './shared.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = resolve(repositoryRoot, 'test/compatibility/predecessor');
const sourceDateEpoch = '946684800';

function parseSemver(value, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/u.exec(value);
  if (match === null) throw new Error(`${label} must be a semantic version.`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isLowerVersion(predecessor, candidate) {
  const left = parseSemver(predecessor, 'Predecessor version');
  const right = parseSemver(candidate, 'Candidate version');
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index];
  }
  return false;
}

async function readManifest(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function manifestIdentity(manifest) {
  return `${manifest.publisher}.${manifest.name}`;
}

async function appendOutputs(path, destination, sha256) {
  await appendFile(path, `predecessor-vsix=${destination}\npredecessor-sha256=${sha256}\n`, 'utf8');
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const destination = resolve(requiredArgument(args, 'destination'));
  const evidencePath = resolve(requiredArgument(args, 'evidence'));
  const githubOutput = optionalArgument(args, 'github-output');
  const evidence = {
    schemaVersion: 1,
    kind: 'compatibility-test-predecessor',
    status: 'running',
    recordedAt: new Date().toISOString(),
    sourceDateEpoch,
    runner: runnerEvidence(),
  };
  const originalSourceDateEpoch = process.env.SOURCE_DATE_EPOCH;

  try {
    const [candidateManifest, predecessorManifest] = await Promise.all([
      readManifest(resolve(repositoryRoot, 'package.json')),
      readManifest(resolve(fixtureRoot, 'package.json')),
    ]);
    const candidateId = manifestIdentity(candidateManifest);
    const predecessorId = manifestIdentity(predecessorManifest);
    if (
      candidateId !== COMPATIBILITY_PINS.extensionId ||
      predecessorId !== COMPATIBILITY_PINS.extensionId
    ) {
      throw new Error(`Candidate and predecessor must both use ${COMPATIBILITY_PINS.extensionId}.`);
    }
    if (!isLowerVersion(predecessorManifest.version, candidateManifest.version)) {
      throw new Error(
        `Test predecessor ${predecessorManifest.version} is not lower than candidate ${candidateManifest.version}.`,
      );
    }

    await mkdir(dirname(destination), { recursive: true });
    process.env.SOURCE_DATE_EPOCH = sourceDateEpoch;
    await createVSIX({
      cwd: fixtureRoot,
      packagePath: destination,
      dependencies: false,
      skipLicense: true,
    });
    const sha256 = await sha256File(destination);
    Object.assign(evidence, {
      status: 'passed',
      candidate: { id: candidateId, version: candidateManifest.version },
      predecessor: {
        id: predecessorId,
        version: predecessorManifest.version,
        sha256,
      },
      purpose: 'test-only upgrade mechanics and workspace-preservation evidence',
    });
    if (githubOutput !== undefined) {
      await appendOutputs(resolve(githubOutput), destination, sha256);
    }
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = errorMessage(error);
    await rm(destination, { force: true });
    await writeJson(evidencePath, evidence);
    throw error;
  } finally {
    if (originalSourceDateEpoch === undefined) delete process.env.SOURCE_DATE_EPOCH;
    else process.env.SOURCE_DATE_EPOCH = originalSourceDateEpoch;
  }

  await writeJson(evidencePath, evidence);
}

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  await main();
}
