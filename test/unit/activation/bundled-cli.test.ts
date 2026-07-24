import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  applyBundledCliEnvironment,
  BUNDLED_CLI_ENVIRONMENT_VARIABLE,
  bundledCliStatusMessage,
  expectedTargetPlatform,
  inspectBundledCli,
  type TerminalEnvironmentCollection,
} from '../../../src/extension/cli/index.js';

const temporaryDirectories = new Set<string>();
const executableBytes = Buffer.from('deterministic native CLI fixture');

class FakeEnvironmentCollection implements TerminalEnvironmentCollection {
  public description = '';
  public readonly mutations: string[] = [];

  public append(variable: string, value: string): void {
    this.mutations.push(`append:${variable}:${value}`);
  }

  public delete(variable: string): void {
    this.mutations.push(`delete:${variable}`);
  }

  public replace(variable: string, value: string): void {
    this.mutations.push(`replace:${variable}:${value}`);
  }
}

async function distribution(
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<{ readonly directory: string; readonly executablePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'okf-bundled-cli-'));
  temporaryDirectories.add(directory);
  const bin = join(directory, 'bin');
  const executablePath = join(bin, 'okf');
  await mkdir(bin);
  await writeFile(executablePath, executableBytes);
  await chmod(executablePath, 0o755);
  await writeFile(
    join(directory, 'bundled-cli.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      targetPlatform: 'darwin-arm64',
      executable: 'okf',
      byteLength: executableBytes.byteLength,
      sha256: createHash('sha256').update(executableBytes).digest('hex'),
      cliVersion: '0.1.0',
      coreVersion: '0.1.0',
      abiVersion: 1,
      ...overrides,
    })}\n`,
  );
  return { directory, executablePath };
}

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

describe('bundled CLI inspection', () => {
  test('accepts an exact platform binary and manifest', async () => {
    const fixture = await distribution();
    const result = inspectBundledCli(fixture.directory, 'darwin', 'arm64');

    expect(result).toEqual({
      available: true,
      targetPlatform: 'darwin-arm64',
      executablePath: fixture.executablePath,
      sha256: createHash('sha256').update(executableBytes).digest('hex'),
      cliVersion: '0.1.0',
      coreVersion: '0.1.0',
      abiVersion: 1,
    });
    expect(bundledCliStatusMessage(result)).toContain('New integrated terminals can run okf');
    expect(bundledCliStatusMessage(result, false)).toContain(
      'integrated-terminal exposure is disabled',
    );
  });

  test('keeps a universal package functional without claiming CLI availability', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'okf-universal-cli-'));
    temporaryDirectories.add(directory);

    const result = inspectBundledCli(directory, 'darwin', 'arm64');

    expect(result).toEqual({ available: false, reason: 'not-packaged' });
    expect(bundledCliStatusMessage(result)).toContain('Wasm core');
  });

  test.each([
    ['hash mismatch', { sha256: '0'.repeat(64) }, 'invalid-executable'],
    ['target mismatch', { targetPlatform: 'linux-x64' }, 'platform-mismatch'],
    ['extra manifest key', { unexpected: true }, 'invalid-manifest'],
    ['unsupported ABI', { abiVersion: 2 }, 'invalid-manifest'],
  ] as const)('fails closed for %s', async (_label, overrides, reason) => {
    const fixture = await distribution(overrides);

    expect(inspectBundledCli(fixture.directory, 'darwin', 'arm64')).toEqual({
      available: false,
      reason,
    });
  });

  test('requires Unix execute permission', async () => {
    const fixture = await distribution();
    await chmod(fixture.executablePath, 0o644);

    expect(inspectBundledCli(fixture.directory, 'darwin', 'arm64')).toEqual({
      available: false,
      reason: 'invalid-executable',
    });
  });
});

describe('integrated terminal environment', () => {
  test('appends the bundled directory without shadowing an existing okf command', async () => {
    const fixture = await distribution();
    const inspection = inspectBundledCli(fixture.directory, 'darwin', 'arm64');
    const collection = new FakeEnvironmentCollection();

    applyBundledCliEnvironment(collection, inspection, true, ':');

    expect(collection.mutations).toEqual([
      'delete:PATH',
      `delete:${BUNDLED_CLI_ENVIRONMENT_VARIABLE}`,
      `append:PATH::${join(fixture.directory, 'bin')}`,
      `replace:${BUNDLED_CLI_ENVIRONMENT_VARIABLE}:${fixture.executablePath}`,
    ]);
    expect(collection.description).toContain('Existing PATH commands keep precedence');
  });

  test('clears its mutations when the user disables exposure', async () => {
    const fixture = await distribution();
    const inspection = inspectBundledCli(fixture.directory, 'darwin', 'arm64');
    const collection = new FakeEnvironmentCollection();

    applyBundledCliEnvironment(collection, inspection, false, ':');

    expect(collection.mutations).toEqual([
      'delete:PATH',
      `delete:${BUNDLED_CLI_ENVIRONMENT_VARIABLE}`,
    ]);
  });

  test('maps only the initially supported Extension Host targets', () => {
    expect(expectedTargetPlatform('darwin', 'arm64')).toBe('darwin-arm64');
    expect(expectedTargetPlatform('darwin', 'x64')).toBe('darwin-x64');
    expect(expectedTargetPlatform('linux', 'x64')).toBe('linux-x64');
    expect(expectedTargetPlatform('win32', 'x64')).toBe('win32-x64');
    expect(expectedTargetPlatform('linux', 'arm64')).toBeUndefined();
  });
});
