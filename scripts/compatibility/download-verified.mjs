import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL, URL } from 'node:url';

import {
  assertSha256,
  errorMessage,
  optionalArgument,
  parseArguments,
  requiredArgument,
  sha256File,
  writeJson,
} from './shared.mjs';

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function downloadVerified({ url, expectedSha256, destination, expectedSize }) {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== 'https:') {
    throw new Error('Compatibility downloads require an HTTPS URL.');
  }
  assertSha256(expectedSha256);
  await mkdir(dirname(destination), { recursive: true });

  if (await exists(destination)) {
    const currentSha256 = await sha256File(destination);
    if (currentSha256 !== expectedSha256) {
      throw new Error(`Existing download at ${destination} has an unexpected SHA-256.`);
    }
    const metadata = await stat(destination);
    if (expectedSize !== undefined && metadata.size !== expectedSize) {
      throw new Error(`Existing download at ${destination} has an unexpected byte size.`);
    }
    return { destination, sha256: currentSha256, size: metadata.size, reused: true };
  }

  const temporary = `${destination}.partial-${process.pid}-${randomUUID()}`;
  try {
    const response = await globalThis.fetch(parsedUrl, {
      redirect: 'follow',
      headers: { 'user-agent': 'okf-workbench-compatibility/1' },
      signal: globalThis.AbortSignal.timeout(10 * 60 * 1_000),
    });
    if (!response.ok || response.body === null) {
      throw new Error(`Download failed with HTTP ${response.status} for ${url}.`);
    }
    if (new URL(response.url).protocol !== 'https:') {
      throw new Error('The download redirected to a non-HTTPS URL.');
    }

    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }));
    const metadata = await stat(temporary);
    const actualSha256 = await sha256File(temporary);
    if (actualSha256 !== expectedSha256) {
      throw new Error(
        `SHA-256 mismatch for ${url}: expected ${expectedSha256}, received ${actualSha256}.`,
      );
    }
    if (expectedSize !== undefined && metadata.size !== expectedSize) {
      throw new Error(
        `Size mismatch for ${url}: expected ${expectedSize}, received ${metadata.size}.`,
      );
    }
    await rename(temporary, destination);
    return { destination, sha256: actualSha256, size: metadata.size, reused: false };
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const url = requiredArgument(args, 'url');
  const expectedSha256 = assertSha256(requiredArgument(args, 'sha256'));
  const destination = resolve(requiredArgument(args, 'destination'));
  const evidencePath = optionalArgument(args, 'evidence');
  const evidence = {
    schemaVersion: 1,
    kind: 'verified-download',
    status: 'running',
    recordedAt: new Date().toISOString(),
    url,
    expectedSha256,
    destinationName: destination.split(/[\\/]/u).at(-1),
  };

  try {
    const result = await downloadVerified({ url, expectedSha256, destination });
    Object.assign(evidence, {
      status: 'passed',
      actualSha256: result.sha256,
      size: result.size,
      reused: result.reused,
    });
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = errorMessage(error);
    if (evidencePath !== undefined) await writeJson(resolve(evidencePath), evidence);
    throw error;
  }

  if (evidencePath !== undefined) await writeJson(resolve(evidencePath), evidence);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  await main();
}
