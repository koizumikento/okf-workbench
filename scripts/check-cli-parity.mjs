import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateVsixFile } from './package-check.mjs';

export async function verifyCliParity(cliPath, vsixPath) {
  const cli = await readFile(resolve(cliPath));
  const cliSha256 = createHash('sha256').update(cli).digest('hex');
  const result = await validateVsixFile(resolve(vsixPath));
  if (result.bundledCli === undefined || result.targetPlatform === undefined) {
    throw new Error('CLI parity requires a platform-specific VSIX with one bundled CLI.');
  }
  if (result.bundledCli.byteLength !== cli.byteLength || result.bundledCli.sha256 !== cliSha256) {
    throw new Error(
      `Standalone and bundled CLI bytes differ: standalone ${cliSha256} (${String(cli.byteLength)} bytes), bundled ${result.bundledCli.sha256} (${String(result.bundledCli.byteLength)} bytes).`,
    );
  }
  return {
    byteLength: cli.byteLength,
    sha256: cliSha256,
    targetPlatform: result.targetPlatform,
  };
}

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const cliPath = process.argv[2];
  const vsixPath = process.argv[3];
  if (cliPath === undefined || vsixPath === undefined || process.argv.length !== 4) {
    throw new Error('Usage: node scripts/check-cli-parity.mjs <native-cli> <platform-vsix>');
  }
  const result = await verifyCliParity(cliPath, vsixPath);
  console.log(
    `CLI parity passed for ${result.targetPlatform}: ${result.sha256} (${String(result.byteLength)} bytes).`,
  );
}
