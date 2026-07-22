import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function collectCandidates(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const candidates = [];

  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      candidates.push(...(await collectCandidates(entryPath)));
    } else if (entry.isFile() && entry.name === 'okf-workbench.vsix') {
      candidates.push(entryPath);
    }
  }

  return candidates;
}

export async function verifyCrossPlatformVsix(rootDirectory, expectedCount = 3) {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 2) {
    throw new Error('The expected VSIX count must be an integer of at least two.');
  }

  const root = resolve(rootDirectory);
  const paths = (await collectCandidates(root)).sort((left, right) => left.localeCompare(right));
  if (paths.length !== expectedCount) {
    throw new Error(
      `Expected ${String(expectedCount)} cross-platform VSIX files under ${root}; found ${String(paths.length)}.`,
    );
  }

  const candidates = await Promise.all(
    paths.map(async (path) => {
      const content = await readFile(path);
      return {
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
      .map((candidate) => `${candidate.sha256} ${String(candidate.size)} ${candidate.path}`)
      .join('\n');
    throw new Error(`Cross-platform VSIX bytes differ:\n${inventory}`);
  }

  return { candidates, sha256: first.sha256, size: first.size };
}

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const rootDirectory = process.argv[2];
  const expectedCountArgument = process.argv[3];
  if (rootDirectory === undefined || process.argv.length > 4) {
    throw new Error(
      'Usage: node scripts/check-cross-platform-vsix.mjs <artifact-root> [expected-count]',
    );
  }
  const expectedCount = expectedCountArgument === undefined ? 3 : Number(expectedCountArgument);
  const result = await verifyCrossPlatformVsix(rootDirectory, expectedCount);
  console.log(
    `Cross-platform VSIX byte identity passed: ${result.sha256} (${String(result.size)} bytes, ${String(result.candidates.length)} artifacts).`,
  );
}
