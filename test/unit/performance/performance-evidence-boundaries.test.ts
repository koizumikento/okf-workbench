import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  publishPerformanceEvidence,
  withPerformanceDeadline,
} from '../../../scripts/performance-evidence-publisher.mjs';
import {
  assertInputSnapshotUnchanged,
  captureStableInputSnapshot,
  materializeInputSnapshot,
} from '../../../scripts/performance-input-snapshot.mjs';
import {
  FIRST_INTERACTIVE_FRAME_TIMEOUT_MS,
  waitForAnimationFramePredicate,
} from '../../benchmarks/headed-animation-frame-deadline.mjs';
import { scrubHeadedEvidenceEnvironment } from '../../benchmarks/headed-editor-evidence.mjs';

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'okf-performance-boundaries-'));

afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

describe('portable performance input snapshots', () => {
  it('binds an exact exclusion policy while ignoring only the host-native esbuild shim bytes', async () => {
    const firstRoot = createEsbuildFixture('darwin', 'Mach-O host binary');
    const secondRoot = createEsbuildFixture('linux', 'ELF host binary');
    const options = {
      directories: ['node_modules/esbuild'],
      excludedFiles: ['node_modules/esbuild/bin/esbuild'],
    };

    const first = await captureStableInputSnapshot(firstRoot, options);
    const second = await captureStableInputSnapshot(secondRoot, options);

    expect(first.sha256).toBe(second.sha256);
    expect(first.excludedFiles).toEqual(['node_modules/esbuild/bin/esbuild']);
    expect(first.entries.map((entry) => entry.relativePath)).toEqual([
      'node_modules/esbuild/lib/main.js',
      'node_modules/esbuild/package.json',
    ]);

    writeFileSync(
      join(firstRoot, 'node_modules', 'esbuild', 'bin', 'esbuild'),
      'changed host binary',
    );
    await expect(
      assertInputSnapshotUnchanged(first, firstRoot, 'Portable esbuild fixture'),
    ).resolves.toBeUndefined();

    const materialized = join(temporaryDirectory, 'portable-materialized');
    await materializeInputSnapshot(first, materialized);
    await expect(
      assertInputSnapshotUnchanged(first, materialized, 'Portable materialization'),
    ).resolves.toBeUndefined();

    writeFileSync(join(secondRoot, 'node_modules', 'esbuild', 'lib', 'main.js'), 'changed JS');
    await expect(
      assertInputSnapshotUnchanged(second, secondRoot, 'Portable esbuild fixture'),
    ).rejects.toThrow('modified node_modules/esbuild/lib/main.js');
  });

  it('rejects exclusions outside captured directories or duplicated as explicit files', async () => {
    const root = createEsbuildFixture('invalid-exclusion', 'native');
    await expect(
      captureStableInputSnapshot(root, {
        directories: ['node_modules/esbuild/lib'],
        excludedFiles: ['node_modules/esbuild/bin/esbuild'],
      }),
    ).rejects.toThrow('is not contained by a captured directory');
    await expect(
      captureStableInputSnapshot(root, {
        directories: ['node_modules/esbuild'],
        excludedFiles: ['node_modules/esbuild/package.json'],
        files: ['node_modules/esbuild/package.json'],
      }),
    ).rejects.toThrow('is also an explicit file');
  });
});

describe('headed measurement deadlines', () => {
  it('returns from the real deadline timer when requestAnimationFrame is suppressed', async () => {
    let cancelledFrame: number | undefined;
    const outcome = await waitForAnimationFramePredicate(() => false, 10, {
      cancelAnimationFrame(handle) {
        cancelledFrame = handle;
      },
      clearTimeout,
      requestAnimationFrame() {
        return 73;
      },
      setTimeout,
    });

    expect(outcome).toBe(false);
    expect(cancelledFrame).toBe(73);
    expect(FIRST_INTERACTIVE_FRAME_TIMEOUT_MS).toBe(5_000);
  });

  it('fails closed when an outer Webview evaluation never settles', async () => {
    await expect(
      withPerformanceDeadline(
        new Promise(() => undefined),
        10,
        'ngraph Webview evaluation and process-tree monitoring',
      ),
    ).rejects.toThrow(
      'ngraph Webview evaluation and process-tree monitoring exceeded its 10 ms deadline.',
    );
  });
});

describe('headed evidence bootstrap environment', () => {
  it('scrubs dangerous variables without trusting Windows environment-name casing', () => {
    expect(
      scrubHeadedEvidenceEnvironment({
        PATH: '/safe/bin',
        node_options: '--require=/untrusted/preload.cjs',
        NoDe_PaTh: '/untrusted/modules',
        okf_headed_staged_execution: '{"forged":true}',
        esbuild_binary_path: '/untrusted/esbuild',
        ld_preload: '/untrusted/preload.so',
        DyLd_InSeRt_LiBrArIeS: '/untrusted/preload.dylib',
      }),
    ).toEqual({ PATH: '/safe/bin' });
  });

  it.runIf(process.platform !== 'win32')(
    'executes fail-closed CLI main paths through symbolic-link aliases',
    () => {
      const reportAlias = join(temporaryDirectory, 'benchmark-report-alias.mjs');
      const bootstrapAlias = join(temporaryDirectory, 'headed-bootstrap-alias.mjs');
      symlinkSync(join(process.cwd(), 'scripts', 'benchmark-report.mjs'), reportAlias);
      symlinkSync(
        join(process.cwd(), 'test', 'benchmarks', 'headed-editor-evidence.mjs'),
        bootstrapAlias,
      );

      const report = spawnSync(process.execPath, [reportAlias, '--require-passing'], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      expect(report.status).toBe(2);
      expect(report.stdout).toContain('| QR-003 | unmeasured |');

      const bootstrap = spawnSync(process.execPath, [bootstrapAlias], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          OKF_HEADED_STAGED_EXECUTION: '{"forged":true}',
        },
      });
      expect(bootstrap.status).toBe(1);
      expect(bootstrap.stderr).toContain(
        'The headed evidence bootstrap refuses a nested staged execution.',
      );
    },
    30_000,
  );
});

describe('headed evidence publication', () => {
  it('restricts final evidence to the dedicated artifacts/performance directory', async () => {
    const root = createRepositoryFixture('publication-contained');
    await expect(
      publishPerformanceEvidence({
        repositoryRoot: root,
        outputPath: join(root, 'package.json'),
        evidenceBytes: '{}\n',
        reportBytes: '# report\n',
      }),
    ).rejects.toThrow(
      'Performance evidence output must be a .json file inside artifacts/performance.',
    );
  });

  it('rejects symbolic output targets and restores both prior files when verification fails', async () => {
    const root = createRepositoryFixture('publication-rollback');
    const outputDirectory = join(root, 'artifacts', 'performance');
    mkdirSync(outputDirectory, { recursive: true });
    const outputPath = join(outputDirectory, 'evidence.json');
    const reportPath = join(outputDirectory, 'evidence.md');
    writeFileSync(outputPath, 'old evidence\n');
    writeFileSync(reportPath, 'old report\n');

    await expect(
      publishPerformanceEvidence({
        repositoryRoot: root,
        outputPath,
        evidenceBytes: 'new evidence\n',
        reportBytes: 'new report\n',
        verify() {
          throw new Error('post-publication snapshot mutation');
        },
      }),
    ).rejects.toThrow('post-publication snapshot mutation');
    expect(readFileSync(outputPath, 'utf8')).toBe('old evidence\n');
    expect(readFileSync(reportPath, 'utf8')).toBe('old report\n');

    rmSync(outputPath);
    symlinkSync(join(root, 'package.json'), outputPath);
    await expect(
      publishPerformanceEvidence({
        repositoryRoot: root,
        outputPath,
        evidenceBytes: 'new evidence\n',
        reportBytes: 'new report\n',
      }),
    ).rejects.toThrow('must be a regular, non-symbolic file');
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe('{}\n');
  });

  it('publishes and verifies a complete pair before discarding its backups', async () => {
    const root = createRepositoryFixture('publication-success');
    const outputDirectory = join(root, 'artifacts', 'performance');
    mkdirSync(outputDirectory, { recursive: true });
    const outputPath = join(outputDirectory, 'evidence.json');
    const reportPath = join(outputDirectory, 'evidence.md');
    writeFileSync(outputPath, 'old evidence\n');
    writeFileSync(reportPath, 'old report\n');
    let verified = false;

    await publishPerformanceEvidence({
      repositoryRoot: root,
      outputPath,
      evidenceBytes: 'new evidence\n',
      reportBytes: 'new report\n',
      verify() {
        verified = true;
      },
    });

    expect(verified).toBe(true);
    expect(readFileSync(outputPath, 'utf8')).toBe('new evidence\n');
    expect(readFileSync(reportPath, 'utf8')).toBe('new report\n');
    expect(readdirSync(outputDirectory).sort()).toEqual(['evidence.json', 'evidence.md']);
  });

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'preserves prior backups when filesystem permissions prevent rollback',
    async () => {
      const root = createRepositoryFixture('publication-failed-rollback');
      const outputDirectory = join(root, 'artifacts', 'performance');
      mkdirSync(outputDirectory, { recursive: true });
      const outputPath = join(outputDirectory, 'evidence.json');
      const reportPath = join(outputDirectory, 'evidence.md');
      writeFileSync(outputPath, 'recoverable evidence\n');
      writeFileSync(reportPath, 'recoverable report\n');

      try {
        await expect(
          publishPerformanceEvidence({
            repositoryRoot: root,
            outputPath,
            evidenceBytes: 'uncommitted evidence\n',
            reportBytes: 'uncommitted report\n',
            verify() {
              chmodSync(outputDirectory, 0o500);
              throw new Error('forced verification failure');
            },
          }),
        ).rejects.toThrow(
          'Performance evidence publication failed and could not be fully rolled back.',
        );
      } finally {
        chmodSync(outputDirectory, 0o700);
      }

      const backups = readdirSync(outputDirectory)
        .filter((name) => name.endsWith('.bak'))
        .sort();
      expect(backups).toHaveLength(2);
      expect(
        backups.map((name) => readFileSync(join(outputDirectory, name), 'utf8')).sort(),
      ).toEqual(['recoverable evidence\n', 'recoverable report\n']);
    },
  );
});

function createEsbuildFixture(name: string, nativeBytes: string): string {
  const root = join(temporaryDirectory, name);
  mkdirSync(join(root, 'node_modules', 'esbuild', 'bin'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'esbuild', 'lib'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'), nativeBytes);
  writeFileSync(join(root, 'node_modules', 'esbuild', 'lib', 'main.js'), 'portable JS');
  writeFileSync(join(root, 'node_modules', 'esbuild', 'package.json'), '{"version":"0.28.1"}\n');
  return root;
}

function createRepositoryFixture(name: string): string {
  const root = join(temporaryDirectory, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}\n');
  return root;
}
