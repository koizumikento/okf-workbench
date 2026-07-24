import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { packageVsix, parsePackageArguments } from './package-vsix.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

const packageArguments = parsePackageArguments(process.argv.slice(2));
const candidateArgument = packageArguments.outputPath;

const candidatePath = resolve(candidateArgument);
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'okf-workbench-vsix-repro-'));

try {
  const repeatedPath = join(temporaryDirectory, 'repeated.vsix');
  await packageVsix(repeatedPath, repositoryRoot, packageArguments);

  const [candidate, repeated] = await Promise.all([
    readFile(candidatePath),
    readFile(repeatedPath),
  ]);
  const candidateSha256 = sha256(candidate);
  const repeatedSha256 = sha256(repeated);

  if (!candidate.equals(repeated)) {
    throw new Error(
      `VSIX reproducibility check failed: candidate ${candidateSha256}, repeated package ${repeatedSha256}.`,
    );
  }

  console.log(`VSIX reproducibility check passed: ${candidateSha256} (${candidate.length} bytes).`);
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
