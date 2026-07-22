import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { normalizeVsixFile } from './normalize-vsix.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function runVsce(outputPath) {
  const vscePath = resolve(repositoryRoot, 'node_modules/@vscode/vsce/vsce');
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [vscePath, 'package', '--out', outputPath], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(
        new Error(
          `vsce reproducibility package failed (${signal === null ? `exit ${String(code)}` : `signal ${signal}`}).`,
        ),
      );
    });
  });
}

const candidateArgument = process.argv[2];
if (candidateArgument === undefined || process.argv.length !== 3) {
  throw new Error('Usage: node scripts/check-vsix-reproducibility.mjs <normalized-candidate-vsix>');
}

const candidatePath = resolve(candidateArgument);
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'okf-workbench-vsix-repro-'));

try {
  const repeatedPath = join(temporaryDirectory, 'repeated.vsix');
  await runVsce(repeatedPath);
  await normalizeVsixFile(repeatedPath);

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
