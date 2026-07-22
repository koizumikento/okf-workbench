import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export function parseArguments(argv, booleanFlags = []) {
  const booleans = new Set(booleanFlags);
  const values = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${JSON.stringify(token)}.`);
    }

    const name = token.slice(2);
    if (booleans.has(name)) {
      values.set(name, true);
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${name}.`);
    }
    if (values.has(name)) {
      throw new Error(`Duplicate argument: --${name}.`);
    }
    values.set(name, value);
    index += 1;
  }

  return values;
}

export function requiredArgument(argumentsMap, name) {
  const value = argumentsMap.get(name);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`--${name} is required.`);
  }
  return value;
}

export function optionalArgument(argumentsMap, name) {
  const value = argumentsMap.get(name);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function assertSha256(value, label = 'SHA-256') {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be 64 lowercase hexadecimal characters.`);
  }
  return value;
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  const input = createReadStream(path);
  for await (const chunk of input) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function runnerEvidence() {
  return {
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    runnerOs: process.env.RUNNER_OS ?? null,
    runnerArchitecture: process.env.RUNNER_ARCH ?? null,
    imageOs: process.env.ImageOS ?? null,
    imageVersion: process.env.ImageVersion ?? null,
  };
}
