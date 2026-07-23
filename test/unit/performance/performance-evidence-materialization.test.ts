import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  buildHeadedHarnessFromCapturedInputs,
  preparePrivatePerformanceMaterializationRoot,
} from '../../../scripts/performance-evidence-inputs.mjs';
import {
  assertInputSnapshotUnchanged,
  captureStableInputSnapshot,
  materializeInputSnapshot,
} from '../../../scripts/performance-input-snapshot.mjs';

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'okf-performance-materialization-test-'));

afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

describe('immutable performance build materialization', () => {
  it('builds production bundles from captured bytes across a live-source ABA mutation', async () => {
    const sourceRoot = fixtureRoot('production-aba-source');
    const materializationRoot = join(temporaryDirectory, 'production-aba-materialized');
    writeProductionFixture(sourceRoot, 'captured-A');
    const inputSnapshot = await captureStableInputSnapshot(sourceRoot, {
      files: ['assets/icon.png', 'package.json'],
      directories: ['src'],
    });

    writeProductionFixture(sourceRoot, 'transient-B');
    await preparePrivatePerformanceMaterializationRoot(sourceRoot, materializationRoot);
    await materializeInputSnapshot(inputSnapshot, materializationRoot);
    execFileSync(
      process.execPath,
      [
        join(process.cwd(), 'scripts', 'build.mjs'),
        '--production',
        '--repository-root',
        materializationRoot,
      ],
      { cwd: materializationRoot, stdio: 'pipe' },
    );
    writeProductionFixture(sourceRoot, 'captured-A');

    for (const relativePath of ['dist/extension.cjs', 'dist/webview/main.js']) {
      const output = readFileSync(join(materializationRoot, ...relativePath.split('/')), 'utf8');
      expect(output).toContain('captured-A');
      expect(output).not.toContain('transient-B');
    }
    await expect(
      assertInputSnapshotUnchanged(inputSnapshot, sourceRoot, 'Production ABA source'),
    ).resolves.toBeUndefined();
    await expect(
      assertInputSnapshotUnchanged(
        inputSnapshot,
        materializationRoot,
        'Frozen production materialization',
      ),
    ).resolves.toBeUndefined();
  }, 30_000);

  it('builds QR-003 from captured bytes across a live-source ABA mutation', async () => {
    const sourceRoot = fixtureRoot('aba-source');
    const materializationRoot = join(temporaryDirectory, 'aba-materialized');
    writeHarnessFixture(sourceRoot, `globalThis.__okfFrozenMarker = 'captured-A';\n`);
    const inputSnapshot = await captureStableInputSnapshot(sourceRoot, {
      files: ['src/entry.js', 'test/benchmarks/headed-harness-build.json'],
    });

    writeFileSync(
      join(sourceRoot, 'src', 'entry.js'),
      `globalThis.__okfFrozenMarker = 'transient-B';\n`,
    );
    const capture = await buildHeadedHarnessFromCapturedInputs(
      { discoveredInputPaths: ['src/entry.js'], inputSnapshot },
      materializationRoot,
    );
    writeFileSync(
      join(sourceRoot, 'src', 'entry.js'),
      `globalThis.__okfFrozenMarker = 'captured-A';\n`,
    );

    expect(capture.javascript).toContain('captured-A');
    expect(capture.javascript).not.toContain('transient-B');
    await expect(
      assertInputSnapshotUnchanged(inputSnapshot, sourceRoot, 'ABA source'),
    ).resolves.toBeUndefined();
    await expect(
      assertInputSnapshotUnchanged(inputSnapshot, materializationRoot, 'Frozen materialization'),
    ).resolves.toBeUndefined();
  }, 30_000);

  it('fails closed when live discovery omits an input used by the private build', async () => {
    const sourceRoot = fixtureRoot('omitted-input-source');
    const materializationRoot = join(temporaryDirectory, 'omitted-input-materialized');
    writeHarnessFixture(
      sourceRoot,
      `import { marker } from './dependency.js';\nglobalThis.__okfFrozenMarker = marker;\n`,
    );
    writeFileSync(
      join(sourceRoot, 'src', 'dependency.js'),
      `export const marker = 'captured-dependency';\n`,
    );
    const inputSnapshot = await captureStableInputSnapshot(sourceRoot, {
      files: ['src/dependency.js', 'src/entry.js', 'test/benchmarks/headed-harness-build.json'],
    });

    await expect(
      buildHeadedHarnessFromCapturedInputs(
        { discoveredInputPaths: ['src/entry.js'], inputSnapshot },
        materializationRoot,
      ),
    ).rejects.toThrow(
      'QR-003 harness input inventory changed between live discovery and a private binding build.',
    );
  }, 30_000);

  it('rejects a materialization root nested inside the live source', async () => {
    const sourceRoot = fixtureRoot('overlap-source');
    writeHarnessFixture(sourceRoot, `globalThis.__okfFrozenMarker = 'captured';\n`);
    const inputSnapshot = await captureStableInputSnapshot(sourceRoot, {
      files: ['src/entry.js', 'test/benchmarks/headed-harness-build.json'],
    });

    await expect(
      buildHeadedHarnessFromCapturedInputs(
        { discoveredInputPaths: ['src/entry.js'], inputSnapshot },
        join(sourceRoot, 'private-materialization'),
      ),
    ).rejects.toThrow(
      'Performance input materialization root must be disjoint from its source repository.',
    );
  }, 30_000);
});

function fixtureRoot(name: string): string {
  const root = join(temporaryDirectory, name);
  mkdirSync(join(root, 'src'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'test', 'benchmarks'), { recursive: true });
  return root;
}

function writeHarnessFixture(root: string, entrySource: string): void {
  writeFileSync(join(root, 'src', 'entry.js'), entrySource);
  writeFileSync(
    join(root, 'test', 'benchmarks', 'headed-harness-build.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        entryPoint: 'src/entry.js',
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: 'es2022',
        write: false,
        tsconfigRaw: { compilerOptions: {} },
      },
      undefined,
      2,
    )}\n`,
  );
}

function writeProductionFixture(root: string, marker: string): void {
  mkdirSync(join(root, 'src', 'extension'), { recursive: true });
  mkdirSync(join(root, 'src', 'webview'), { recursive: true });
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'production-aba-fixture', version: '1.0.0' })}\n`,
  );
  writeFileSync(join(root, 'assets', 'icon.png'), 'fixture-icon');
  writeFileSync(
    join(root, 'src', 'extension', 'activate.ts'),
    `export const frozenMarker = '${marker}';\n`,
  );
  writeFileSync(
    join(root, 'src', 'webview', 'main.ts'),
    `globalThis.document?.documentElement.setAttribute('data-frozen-marker', '${marker}');\n`,
  );
}
