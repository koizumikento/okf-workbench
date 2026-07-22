import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createVSIX } from '@vscode/vsce';

import { normalizeVsixFile } from './normalize-vsix.mjs';

export const VSIX_SOURCE_DATE_EPOCH = '946684800';

export async function packageVsix(outputPath, repositoryRoot = process.cwd()) {
  const destination = resolve(repositoryRoot, outputPath);
  const originalSourceDateEpoch = process.env.SOURCE_DATE_EPOCH;

  try {
    // VSCE sorts archive entries only when SOURCE_DATE_EPOCH is present. Its
    // timestamps and platform file attributes are normalized again below so
    // package bytes remain independent of the runner's clock, time zone, and
    // filesystem mode defaults.
    process.env.SOURCE_DATE_EPOCH = VSIX_SOURCE_DATE_EPOCH;
    await createVSIX({ cwd: repositoryRoot, packagePath: destination });
    await normalizeVsixFile(destination);
  } finally {
    if (originalSourceDateEpoch === undefined) delete process.env.SOURCE_DATE_EPOCH;
    else process.env.SOURCE_DATE_EPOCH = originalSourceDateEpoch;
  }

  return destination;
}

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const outputPath = process.argv[2];
  if (outputPath === undefined || process.argv.length !== 3) {
    throw new Error('Usage: node scripts/package-vsix.mjs <output-vsix>');
  }
  const destination = await packageVsix(outputPath);
  console.log(`Created deterministic VSIX at ${destination}.`);
}
