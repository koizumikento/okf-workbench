import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createCurrentCandidate,
  evaluateEvidence,
  isPassingReport,
  renderMarkdown,
  type PerformanceReportCandidate,
} from '../../../scripts/benchmark-report.mjs';
import { hashPerformanceBundleSet } from '../../../scripts/performance-bundle-hash.mjs';
import { COMPATIBILITY_PINS } from '../../../scripts/compatibility/pins.mjs';
import {
  captureCurrentPerformanceInputs,
  CURRENT_PERFORMANCE_VSCODE_VERSION,
} from '../../../scripts/performance-evidence-inputs.mjs';
import {
  assertInputSnapshotUnchanged,
  captureStableInputSnapshot,
  materializeInputSnapshot,
} from '../../../scripts/performance-input-snapshot.mjs';
import {
  captureHeadedEvidenceExecutionSnapshot,
  readCurrentEsbuildPlatformPackage,
} from '../../../scripts/performance-toolchain.mjs';

import {
  isQr002Passing,
  isQr003InteractionPassing,
  summarizeDurations,
} from '../../benchmarks/evidence-metrics.js';
import {
  generatePerformanceGraph,
  PERFORMANCE_FIXTURE_SEED,
  PERFORMANCE_FIXTURES,
} from '../../benchmarks/graph-fixtures.js';

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'okf-performance-evidence-'));
const candidateRoot = join(temporaryDirectory, 'candidate');
let currentPerformanceInputs: Awaited<ReturnType<typeof captureCurrentPerformanceInputs>>;
let currentExecutionInputs: Awaited<ReturnType<typeof captureHeadedEvidenceExecutionSnapshot>>;
let currentEsbuildPlatform: Awaited<ReturnType<typeof readCurrentEsbuildPlatformPackage>>;
let currentCandidate: PerformanceReportCandidate;

beforeAll(async () => {
  execFileSync(process.execPath, ['scripts/build.mjs', '--production'], {
    cwd: process.cwd(),
    stdio: 'pipe',
  });
  currentPerformanceInputs = await captureCurrentPerformanceInputs(process.cwd());
  currentCandidate = createCurrentCandidate(currentPerformanceInputs);
  currentExecutionInputs = await captureHeadedEvidenceExecutionSnapshot(process.cwd());
  currentEsbuildPlatform = await readCurrentEsbuildPlatformPackage(process.cwd());
  materializePerformanceCandidate(currentPerformanceInputs, currentExecutionInputs, candidateRoot);
  for (const relativePath of currentEsbuildPlatform.executableFiles) {
    chmodSync(
      join(
        candidateRoot,
        ...currentEsbuildPlatform.packagePath.split('/'),
        ...relativePath.split('/'),
      ),
      0o755,
    );
  }
});

afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

describe('deterministic performance fixtures', () => {
  it('uses the current compatibility-matrix VS Code pin for release evidence', () => {
    expect(CURRENT_PERFORMANCE_VSCODE_VERSION).toBe(COMPATIBILITY_PINS.vscodeVersions.at(-1));
  });

  it.each([
    ['small', 100, 500],
    ['representative', 1_000, 5_000],
    ['stress', 5_000, 25_000],
  ] as const)('generates the %s fixture with exact stable dimensions', (name, nodes, edges) => {
    const first = generatePerformanceGraph(PERFORMANCE_FIXTURES[name]);
    const second = generatePerformanceGraph(PERFORMANCE_FIXTURES[name]);

    expect(first).toEqual(second);
    expect(first.nodes).toHaveLength(nodes);
    expect(first.edges).toHaveLength(edges);
    expect(first.edges.every((edge) => edge.source !== edge.target)).toBe(true);
    expect(first.nodes.every((node) => node.orphan === false)).toBe(true);
  });
});

describe('performance thresholds', () => {
  it('uses nearest-rank p95 and the ADR sample/latency gates', () => {
    const samples = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(summarizeDurations(samples)).toMatchObject({ count: 20, p95Ms: 19 });
    expect(isQr002Passing(samples)).toBe(true);
    expect(isQr003InteractionPassing(samples)).toBe(true);
    expect(isQr002Passing(samples.slice(0, 19))).toBe(false);
  });
});

describe('production performance bundle identity', () => {
  it('domain-separates labeled component boundaries instead of hashing raw concatenation', () => {
    const first = hashPerformanceBundleSet({
      extensionHostJavaScript: Buffer.from('ab'),
      webviewJavaScript: Buffer.from('c'),
      webviewCss: Buffer.from(''),
    });
    const second = hashPerformanceBundleSet({
      extensionHostJavaScript: Buffer.from('a'),
      webviewJavaScript: Buffer.from('bc'),
      webviewCss: Buffer.from(''),
    });

    expect(first).not.toBe(second);
  });

  it('materializes the exact captured bytes and detects later content mutation', async () => {
    const source = join(temporaryDirectory, 'snapshot-content-source');
    const staged = join(temporaryDirectory, 'snapshot-content-staged');
    mkdirSync(join(source, 'dist'), { recursive: true });
    writeFileSync(join(source, 'package.json'), '{"name":"snapshot-test"}\n');
    writeFileSync(join(source, 'dist', 'main.js'), 'export const value = 1;\n');

    const snapshot = await captureStableInputSnapshot(source, {
      files: ['package.json'],
      directories: ['dist'],
    });
    await materializeInputSnapshot(snapshot, staged);
    await expect(assertInputSnapshotUnchanged(snapshot, staged, 'Staged test')).resolves.toBe(
      undefined,
    );

    writeFileSync(join(source, 'dist', 'main.js'), 'export const value = 2;\n');
    await expect(assertInputSnapshotUnchanged(snapshot, source, 'Source test')).rejects.toThrow(
      'modified dist/main.js',
    );
  });

  it('detects files added to a captured directory after the snapshot', async () => {
    const source = join(temporaryDirectory, 'snapshot-inventory-source');
    mkdirSync(join(source, 'dist'), { recursive: true });
    writeFileSync(join(source, 'dist', 'main.js'), 'stable\n');
    const snapshot = await captureStableInputSnapshot(source, { directories: ['dist'] });

    writeFileSync(join(source, 'dist', 'unexpected.css'), 'added\n');
    await expect(assertInputSnapshotUnchanged(snapshot, source, 'Inventory test')).rejects.toThrow(
      'added dist/unexpected.css',
    );
  });

  it('captures the complete headed automation and native-esbuild execution closure', () => {
    const productionEntries = currentPerformanceInputs.productionBuildInputSnapshot.entries.map(
      (entry) => entry.relativePath,
    );
    for (const prefix of [
      'node_modules/@vscode/test-electron/',
      'node_modules/esbuild/',
      'node_modules/playwright/',
      'node_modules/playwright-core/',
    ]) {
      expect(productionEntries.some((relativePath) => relativePath.startsWith(prefix))).toBe(true);
    }
    const executionEntries = currentExecutionInputs.entries.map((entry) => entry.relativePath);
    expect(
      productionEntries.some((relativePath) => relativePath.startsWith('node_modules/@esbuild/')),
    ).toBe(false);
    expect(productionEntries).not.toContain('node_modules/esbuild/bin/esbuild');
    expect(currentPerformanceInputs.productionBuildInputSnapshot.excludedFiles).toContain(
      'node_modules/esbuild/bin/esbuild',
    );
    expect(currentPerformanceInputs.headedHarness.inputSnapshot.entries).not.toContainEqual(
      expect.objectContaining({ relativePath: 'node_modules/esbuild/bin/esbuild' }),
    );
    expect(currentPerformanceInputs.headedHarness.inputSnapshot.excludedFiles).toContain(
      'node_modules/esbuild/bin/esbuild',
    );
    expect(productionEntries).toContain('scripts/performance-toolchain-manifest.json');
    expect(
      Object.keys(currentEsbuildPlatform.files).every((relativePath) =>
        executionEntries.includes(`${currentEsbuildPlatform.packagePath}/${relativePath}`),
      ),
    ).toBe(true);
    for (const optionalPackage of currentEsbuildPlatform.optionalPackages) {
      expect(
        Object.keys(optionalPackage.files).every((relativePath) =>
          executionEntries.includes(`${optionalPackage.packagePath}/${relativePath}`),
        ),
      ).toBe(true);
    }
    const manifest = JSON.parse(
      readFileSync('scripts/performance-toolchain-manifest.json', 'utf8'),
    ) as { readonly platformPackages: Readonly<Record<string, unknown>> };
    expect(Object.keys(manifest.platformPackages)).toEqual(
      expect.arrayContaining(['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']),
    );
  });
});

describe('performance evidence report', { timeout: 30_000 }, () => {
  it('reports absent headed-editor evidence as unmeasured', () => {
    const output = execFileSync(process.execPath, ['scripts/benchmark-report.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(output).toContain('| QR-002 | unmeasured |');
    expect(output).toContain('| QR-003 | unmeasured |');
    expect(output).toContain('Release engine: not selected');
  });

  it('selects the faster passing candidate only from complete headed-editor evidence', () => {
    const evidencePath = join(temporaryDirectory, 'synthetic-headed-evidence.json');
    writeFileSync(evidencePath, JSON.stringify(syntheticPassingEvidence()), 'utf8');
    const output = execFileSync(
      process.execPath,
      ['scripts/benchmark-report.mjs', '--measurements', evidencePath, '--require-passing'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(output).toContain('| QR-002 | pass |');
    expect(output).toContain('| QR-003 | pass | Release engine: d3 |');
    expect(output).toContain('| d3 | pass |');
    expect(output).toContain('| ngraph | pass |');
  });

  it('selects d3 when ngraph has a complete captured first-frame timeout', () => {
    const evidence = structuredClone(syntheticPassingEvidence()) as Record<string, unknown>;
    const qr003 = evidence.qr003 as Record<string, unknown>;
    const engines = qr003.engines as Record<string, unknown>;
    engines.ngraph = syntheticFirstFrameTimeout();

    const result = runStrictEvidence('captured-ngraph-first-frame-timeout', evidence);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('| QR-003 | pass | Release engine: d3 |');
    expect(result.stdout).toContain(
      '| ngraph | fail | captured graph-webgl-render-timeout after 5000 ms; 0 clears, 0 draws, canvas present |',
    );
    expect(result.stdout).not.toContain(
      'ngraph: exactly one first-interactive-frame sample is required.',
    );
  });

  it('rejects QR-003 measurements reused from another run', () => {
    const evidence = structuredClone(syntheticPassingEvidence()) as Record<string, unknown>;
    const qr003 = evidence.qr003 as Record<string, unknown>;
    qr003.provenance = {
      kind: 'reused',
      sourceMeasurementSha256: 'a'.repeat(64),
    };

    const result = runStrictEvidence('reused-qr003', evidence);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('| QR-003 | unmeasured | Release engine: not selected |');
    expect(result.stdout).toContain(
      'QR-003 provenance must be captured in the current headed run.',
    );
  });

  it('rejects headed evidence captured with the historical editor pin', () => {
    const evidence = structuredClone(syntheticPassingEvidence()) as Record<string, unknown>;
    (evidence.environment as Record<string, unknown>).editorVersion = '1.127.0';

    const result = runStrictEvidence('historical-editor-version', evidence);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain(
      `Headed performance evidence must use current pinned VS Code ${CURRENT_PERFORMANCE_VSCODE_VERSION}.`,
    );
  });

  it('rejects a zero-timeout measurement-failure envelope as unmeasured', () => {
    const evidence = structuredClone(syntheticPassingEvidence()) as Record<string, unknown>;
    const qr003 = evidence.qr003 as Record<string, unknown>;
    const engines = qr003.engines as Record<string, unknown>;
    const malformedFailure = structuredClone(syntheticFirstFrameTimeout()) as Record<
      string,
      unknown
    >;
    (malformedFailure.measurementFailure as Record<string, unknown>).timeoutMs = 0;
    engines.ngraph = malformedFailure;

    const result = runStrictEvidence('zero-timeout-ngraph-measurement-failure', evidence);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('| QR-003 | unmeasured | Release engine: not selected |');
    expect(result.stdout).toContain('| ngraph | unmeasured |');
    expect(result.stdout).toContain(
      'ngraph: measurementFailure must be the exact headed first-interactive-frame timeout envelope.',
    );
  });

  it.each([
    [
      'missing memory',
      'memoryPeakMb',
      undefined,
      'memoryPeakMb must be recorded for a captured engine failure.',
    ],
    [
      'non-finite idle CPU',
      'idleCpuPercent',
      Number.NaN,
      'idleCpuPercent must be recorded for a captured engine failure.',
    ],
    [
      'negative process-tree peak',
      'processTreePeakRssMb',
      -1,
      'processTreePeakRssMb must be recorded for a captured engine failure.',
    ],
    [
      'zero process-tree sample count',
      'processTreeSampleCount',
      0,
      'processTreeSampleCount must be a positive safe integer.',
    ],
    [
      'inconsistent process-tree peak',
      'processTreePeakRssMb',
      128,
      'memoryPeakMb must equal the monitored processTreePeakRssMb.',
    ],
    [
      'mixed passing fields',
      'firstInteractiveFrameMs',
      [1],
      'captured engine failure must use the exact monitored top-level shape.',
    ],
  ] as const)(
    'rejects a captured first-frame timeout with %s evidence',
    (name, field, value, reason) => {
      const evidence = structuredClone(syntheticPassingEvidence()) as Record<string, unknown>;
      const qr003 = evidence.qr003 as Record<string, unknown>;
      const engines = qr003.engines as Record<string, unknown>;
      const failure = structuredClone(syntheticFirstFrameTimeout()) as Record<string, unknown>;
      if (value === undefined) Reflect.deleteProperty(failure, field);
      else failure[field] = value;
      engines.ngraph = failure;

      const result = runStrictEvidence(
        `incomplete-ngraph-measurement-failure-${name.replaceAll(' ', '-')}`,
        evidence,
      );

      expect(result.status).toBe(2);
      expect(result.stdout).toContain('| ngraph | unmeasured |');
      expect(result.stdout).toContain(`ngraph: ${reason}`);
    },
  );

  it('selects no release engine when both candidates have captured first-frame timeouts', () => {
    const evidence = structuredClone(syntheticPassingEvidence()) as Record<string, unknown>;
    const qr003 = evidence.qr003 as Record<string, unknown>;
    const engines = qr003.engines as Record<string, unknown>;
    engines.d3 = syntheticFirstFrameTimeout();
    engines.ngraph = syntheticFirstFrameTimeout();

    const result = runStrictEvidence('both-engines-first-frame-timeout', evidence);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('| QR-003 | fail | Release engine: not selected |');
    expect(result.stdout).toContain('| d3 | fail | captured graph-webgl-render-timeout');
    expect(result.stdout).toContain('| ngraph | fail | captured graph-webgl-render-timeout');
  });

  it('renders byte-identical Markdown without mutating the production runtime', async () => {
    const evidencePath = join(temporaryDirectory, 'deterministic-report-evidence.json');
    writeFileSync(evidencePath, JSON.stringify(syntheticPassingEvidence()), 'utf8');
    const runtimeBefore = await captureStableInputSnapshot(process.cwd(), {
      files: ['package.json', 'assets/icon.png'],
      directories: ['dist'],
    });
    const arguments_ = [
      'scripts/benchmark-report.mjs',
      '--measurements',
      evidencePath,
      '--require-passing',
    ];
    const first = execFileSync(process.execPath, arguments_, { cwd: process.cwd() });
    const second = execFileSync(process.execPath, arguments_, { cwd: process.cwd() });

    expect(Buffer.compare(first, second)).toBe(0);
    expect(first.toString('utf8')).toContain('Generated: 2026-07-22T12:00:00+09:00');
    expect(first.toString('utf8')).not.toContain('Report-generator host');
    const runtimeAfter = await captureStableInputSnapshot(process.cwd(), {
      files: ['package.json', 'assets/icon.png'],
      directories: ['dist'],
    });
    expect(runtimeAfter.sha256).toBe(runtimeBefore.sha256);
  });

  it('fails closed for historical schema-v2 evidence', () => {
    const result = runStrictEvidence('legacy-schema-v2', {
      ...syntheticPassingEvidence(),
      schemaVersion: 2,
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('| QR-002 | unmeasured |');
    expect(result.stdout).toContain('| QR-003 | unmeasured |');
    expect(result.stdout).toContain('schemaVersion must be 3.');
  });

  it('makes the strict release gate fail when evidence is absent', () => {
    const result = runStrictEvidence('absent-evidence', undefined);
    expect(result.status).toBe(2);
  });

  it('makes schema-v3 evidence fail when immutable input identity is missing', () => {
    const evidence = syntheticPassingEvidence() as Record<string, unknown>;
    delete evidence.inputIdentity;
    const result = runStrictEvidence('missing-input-identity', evidence);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('Evidence field inputIdentity is missing.');
  });

  it('makes the strict gate fail when the Extension Host JavaScript hash is missing', () => {
    const result = runStrictEvidence(
      'missing-extension-host-hash',
      syntheticPassingEvidence({ includeExtensionHostHash: false }),
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toContain(
      'Environment Extension Host JavaScript bundle SHA-256 is missing or malformed.',
    );
  });

  it('makes the strict gate fail when the Webview JavaScript hash is missing', () => {
    const result = runStrictEvidence(
      'missing-bundle-hash',
      syntheticPassingEvidence({ includeWebviewJavaScriptHash: false }),
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toContain(
      'Environment Webview JavaScript bundle SHA-256 is missing or malformed.',
    );
  });

  it('makes the strict gate fail when the Webview CSS hash is missing', () => {
    const result = runStrictEvidence(
      'missing-css-bundle-hash',
      syntheticPassingEvidence({ includeWebviewCssHash: false }),
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toContain(
      'Environment Webview CSS bundle SHA-256 is missing or malformed.',
    );
  });

  it('makes the strict gate fail when the domain-separated bundle-set hash is missing', () => {
    const result = runStrictEvidence(
      'missing-production-bundle-set-hash',
      syntheticPassingEvidence({ includeProductionBundleSetHash: false }),
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toContain(
      'Environment domain-separated production bundle set SHA-256 is missing or malformed.',
    );
  });

  it('makes the strict gate fail when the full production runtime identity differs', () => {
    const evidence = syntheticPassingEvidence() as Record<string, unknown>;
    evidence.inputIdentity = {
      ...(evidence.inputIdentity as Record<string, unknown>),
      productionRuntimeSnapshotSha256: '0'.repeat(64),
    };
    const result = runStrictEvidence('different-production-runtime', evidence);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain(
      'Evidence production runtime snapshot SHA-256 does not match the current candidate inputs.',
    );
  });

  it.each([
    [
      'QR-003 graph fixture',
      'test/benchmarks/graph-fixtures.ts',
      '\n// strict identity mutation probe: graph fixture\n',
      'Evidence QR-003 harness-input snapshot SHA-256 does not match the current candidate inputs.',
    ],
    [
      'QR-002 diagnostics observer',
      'test/benchmarks/diagnostics-observer/extension.cjs',
      '\n// strict identity mutation probe: diagnostics observer\n',
      'Evidence QR-002 diagnostics-observer snapshot SHA-256 does not match the current candidate inputs.',
    ],
    [
      'headed CDP network recorder',
      'test/benchmarks/webview-network-recorder.mjs',
      '\n// strict identity mutation probe: CDP network recorder\n',
      'Evidence production build-input snapshot SHA-256 does not match the current candidate inputs.',
    ],
    [
      'headed benchmark runner',
      'test/benchmarks/headed-editor-evidence-runner.mjs',
      '\n// strict identity mutation probe: headed measurement runner\n',
      'Evidence production build-input snapshot SHA-256 does not match the current candidate inputs.',
    ],
    [
      'headed benchmark bootstrap',
      'test/benchmarks/headed-editor-evidence.mjs',
      '\n// strict identity mutation probe: headed bootstrap\n',
      'Evidence production build-input snapshot SHA-256 does not match the current candidate inputs.',
    ],
    [
      'Playwright core runtime',
      'node_modules/playwright-core/index.js',
      '\n// strict identity mutation probe: Playwright core\n',
      'Evidence production build-input snapshot SHA-256 does not match the current candidate inputs.',
    ],
    [
      'VS Code test-electron runtime',
      'node_modules/@vscode/test-electron/out/index.js',
      '\n// strict identity mutation probe: test-electron\n',
      'Evidence production build-input snapshot SHA-256 does not match the current candidate inputs.',
    ],
    [
      'esbuild JavaScript runtime',
      'node_modules/esbuild/lib/main.js',
      '\n// strict identity mutation probe: esbuild JavaScript runtime\n',
      'Current production build-input snapshot identity is unavailable',
    ],
  ] as const)(
    'rejects a current-candidate mutation to the %s',
    (_, relativePath, suffix, reason) => {
      const candidatePath = join(candidateRoot, ...relativePath.split('/'));
      const original = readFileSync(candidatePath);
      try {
        writeFileSync(candidatePath, Buffer.concat([original, Buffer.from(suffix)]));
        const evidencePath = join(
          temporaryDirectory,
          `mutated-${relativePath.replaceAll('/', '-')}.json`,
        );
        writeFileSync(evidencePath, JSON.stringify(syntheticPassingEvidence()), 'utf8');
        const result = spawnSync(
          process.execPath,
          [
            'scripts/benchmark-report.mjs',
            '--candidate-root',
            candidateRoot,
            '--measurements',
            evidencePath,
            '--require-passing',
          ],
          { cwd: process.cwd(), encoding: 'utf8' },
        );

        expect(result.status).toBe(2);
        expect(result.stdout).toContain(reason);
      } finally {
        writeFileSync(candidatePath, original);
      }
    },
  );

  it('rejects mutation of the authorized native esbuild executable', () => {
    const executableRelativePath = currentEsbuildPlatform.executableFiles[0];
    const platformRelativePath =
      executableRelativePath ??
      Object.keys(currentEsbuildPlatform.files).find((relativePath) =>
        /(?:^|\/)esbuild(?:\.exe)?$/u.test(relativePath),
      );
    expect(platformRelativePath).toBeDefined();
    const candidatePath = join(
      candidateRoot,
      ...currentEsbuildPlatform.packagePath.split('/'),
      ...(platformRelativePath ?? '').split('/'),
    );
    const original = readFileSync(candidatePath);
    try {
      writeFileSync(
        candidatePath,
        Buffer.concat([original, Buffer.from('\nnative-esbuild-mutation\n')]),
      );
      if (executableRelativePath !== undefined) chmodSync(candidatePath, 0o755);
      const result = runStrictEvidenceCli(
        'mutated-native-esbuild',
        syntheticPassingEvidence(),
        candidateRoot,
      );

      expect(result.status).toBe(2);
      expect(result.stdout).toContain(
        'Current production build-input snapshot identity is unavailable',
      );
    } finally {
      writeFileSync(candidatePath, original);
      if (executableRelativePath !== undefined) chmodSync(candidatePath, 0o755);
    }
  });

  it('rejects an esbuild install-time external binary override persisted in portable JavaScript', () => {
    const relativePath = 'node_modules/esbuild/lib/main.js';
    const candidatePath = join(candidateRoot, ...relativePath.split('/'));
    const original = readFileSync(candidatePath);
    try {
      writeFileSync(
        candidatePath,
        Buffer.concat([
          Buffer.from('var ESBUILD_BINARY_PATH = "/untrusted/external-esbuild";\n'),
          original,
        ]),
      );
      const result = runStrictEvidenceCli(
        'persisted-esbuild-binary-override',
        syntheticPassingEvidence(),
        candidateRoot,
      );

      expect(result.status).toBe(2);
      expect(result.stdout).toContain(
        'Current production build-input snapshot identity is unavailable',
      );
    } finally {
      writeFileSync(candidatePath, original);
    }
  });

  it('rejects the persisted esbuild override in the built-in bootstrap before private staging', () => {
    const relativePath = 'node_modules/esbuild/lib/main.js';
    const candidatePath = join(candidateRoot, ...relativePath.split('/'));
    const original = readFileSync(candidatePath);
    const unavailableStagingRoot = join(temporaryDirectory, 'bootstrap-staging-must-not-run');
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      TEMP: unavailableStagingRoot,
      TMP: unavailableStagingRoot,
      TMPDIR: unavailableStagingRoot,
    };
    delete environment.OKF_HEADED_STAGED_EXECUTION;
    try {
      writeFileSync(
        candidatePath,
        Buffer.concat([
          Buffer.from('var ESBUILD_BINARY_PATH = "/untrusted/external-esbuild";\n'),
          original,
        ]),
      );
      const result = spawnSync(
        process.execPath,
        [join(candidateRoot, 'test', 'benchmarks', 'headed-editor-evidence.mjs')],
        {
          cwd: candidateRoot,
          encoding: 'utf8',
          env: environment,
          timeout: 30_000,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'The installed toolchain package node_modules/esbuild has unexpected bytes.',
      );
      expect(result.stderr).not.toContain('bootstrap-staging-must-not-run');
    } finally {
      writeFileSync(candidatePath, original);
    }
  });

  it('rejects an extra downloaded native file inside the portable esbuild package', () => {
    const unexpectedPath = join(candidateRoot, 'node_modules', 'esbuild', 'lib', 'downloaded-test');
    try {
      writeFileSync(unexpectedPath, 'unmanifested native bytes');
      const result = runStrictEvidenceCli(
        'unmanifested-portable-esbuild-file',
        syntheticPassingEvidence(),
        candidateRoot,
      );

      expect(result.status).toBe(2);
      expect(result.stdout).toContain(
        'Current production build-input snapshot identity is unavailable',
      );
    } finally {
      rmSync(unexpectedPath, { force: true });
    }
  });

  it('binds every authorized platform definition through the portable toolchain manifest', () => {
    const relativePath = 'scripts/performance-toolchain-manifest.json';
    const candidatePath = join(candidateRoot, ...relativePath.split('/'));
    const original = readFileSync(candidatePath, 'utf8');
    try {
      const manifest = JSON.parse(original) as {
        platformPackages: Record<string, { files: Record<string, string> }>;
      };
      const windowsDefinition = manifest.platformPackages['win32-x64'];
      expect(windowsDefinition).toBeDefined();
      if (windowsDefinition === undefined) throw new Error('Missing Windows toolchain fixture.');
      windowsDefinition.files['README.md'] = 'f'.repeat(64);
      writeFileSync(candidatePath, `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8');
      const result = runStrictEvidenceCli(
        'mutated-portable-toolchain-manifest',
        syntheticPassingEvidence(),
        candidateRoot,
      );

      expect(result.status).toBe(2);
      expect(result.stdout).toContain(
        'Evidence production build-input snapshot SHA-256 does not match the current candidate inputs.',
      );
      expect(result.stdout).toContain(
        'Evidence QR-003 harness-input snapshot SHA-256 does not match the current candidate inputs.',
      );
    } finally {
      writeFileSync(candidatePath, original, 'utf8');
    }
  });

  it('refuses a forged staged-execution authority when the runner is loaded from the repository', () => {
    const result = spawnSync(
      process.execPath,
      ['test/benchmarks/headed-editor-evidence-runner.mjs'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          OKF_HEADED_STAGED_EXECUTION: JSON.stringify({
            schemaVersion: 1,
            snapshotSha256: currentExecutionInputs.sha256,
          }),
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Headed measurement must execute from a private stage outside the repository.',
    );
  });

  it('refuses an ESBUILD_BINARY_PATH override in standalone evidence evaluation', () => {
    const evidencePath = join(temporaryDirectory, 'esbuild-binary-override.json');
    writeFileSync(evidencePath, JSON.stringify(syntheticPassingEvidence()), 'utf8');
    const result = spawnSync(
      process.execPath,
      ['scripts/benchmark-report.mjs', '--measurements', evidencePath, '--require-passing'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, ESBUILD_BINARY_PATH: '/untrusted/esbuild' },
      },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toContain(
      'Current production build-input snapshot identity is unavailable',
    );
  });

  it('rejects a semantic QR-003 harness build-configuration mutation', () => {
    const relativePath = 'test/benchmarks/headed-harness-build.json';
    const candidatePath = join(candidateRoot, ...relativePath.split('/'));
    const original = readFileSync(candidatePath, 'utf8');
    try {
      const mutated = original.replace(
        '"compilerOptions": {}',
        '"compilerOptions": { "useDefineForClassFields": false }',
      );
      expect(mutated).not.toBe(original);
      writeFileSync(candidatePath, mutated, 'utf8');
      const evidencePath = join(temporaryDirectory, 'mutated-headed-harness-build.json');
      writeFileSync(evidencePath, JSON.stringify(syntheticPassingEvidence()), 'utf8');
      const result = spawnSync(
        process.execPath,
        [
          'scripts/benchmark-report.mjs',
          '--candidate-root',
          candidateRoot,
          '--measurements',
          evidencePath,
          '--require-passing',
        ],
        { cwd: process.cwd(), encoding: 'utf8' },
      );

      expect(result.status).toBe(2);
      expect(result.stdout).toContain(
        'Evidence QR-003 harness definition SHA-256 does not match the current candidate inputs.',
      );
    } finally {
      writeFileSync(candidatePath, original, 'utf8');
    }
  });

  it('makes the strict gate fail for evidence from a CSS-only production change', () => {
    const result = runStrictEvidence(
      'css-only-different-candidate',
      syntheticPassingEvidence({ webviewCssSuffix: 'html{filter:blur(1px)}' }),
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toContain(
      'Evidence Webview CSS bundle SHA-256 does not match the current production build.',
    );
    expect(result.stdout).toContain(
      'Evidence domain-separated production bundle set SHA-256 does not match the current production build.',
    );
  });

  it('makes the strict gate fail for synthetic package version 0.0.1', () => {
    const result = runStrictEvidence(
      'stale-package-version',
      syntheticPassingEvidence({ packageVersion: '0.0.1' }),
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('Evidence package version does not match current manifest');
  });

  it('makes the strict gate fail for a different 3d-force-graph version', () => {
    const result = runStrictEvidence(
      'stale-graph-version',
      syntheticPassingEvidence({ graphVersion: '1.79.0' }),
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('Evidence 3d-force-graph version does not match');
  });

  it('rejects legacy QR-002 durations without Problems and replacement-graph correlation', () => {
    const evidence = syntheticPassingEvidence() as Record<string, unknown>;
    evidence.qr002 = {
      debounceMs: 250,
      updateSamplesMs: Array.from({ length: 20 }, () => 300),
    };
    const result = runStrictEvidence('legacy-qr002', evidence);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('QR-002 requires exactly 20 update samples.');
  });

  it.each([
    {
      name: 'a missing headed-Webview security observation',
      mutate(evidence: Record<string, unknown>) {
        delete evidence.security;
      },
      reason: 'Headed-Webview security observation is missing.',
    },
    {
      name: 'a malformed headed-Webview security observation',
      mutate(evidence: Record<string, unknown>) {
        evidence.security = [];
      },
      reason: 'must be an object using the exact schemaVersion 1 envelope',
    },
    {
      name: 'a remote headed-Webview request',
      mutate(evidence: Record<string, unknown>) {
        const network = webviewNetwork(evidence);
        network.remoteRequestCount = 1;
        network.remoteOrigins = ['https://example.com'];
      },
      reason: 'zero remote HTTP(S)/WS requests',
    },
    {
      name: 'an arbitrary Webview authority counted as a packaged resource',
      mutate(evidence: Record<string, unknown>) {
        webviewNetwork(evidence).localOrigins = ['vscode-webview://trusted-source'];
      },
      reason: 'only sanitized packaged-resource origins',
    },
    {
      name: 'a first-frame sample without a WebGL clear',
      mutate(evidence: Record<string, unknown>) {
        engineEvidence(evidence, 'd3').firstInteractiveFrameWebglClears = [0];
      },
      reason: 'must observe one or more graph WebGL clears',
    },
    {
      name: 'a zero camera frame rate',
      mutate(evidence: Record<string, unknown>) {
        engineEvidence(evidence, 'd3').cameraFps = 0;
      },
      reason: 'cameraFps must be positive',
    },
    {
      name: 'blank camera clears after a single initial draw',
      mutate(evidence: Record<string, unknown>) {
        const engine = engineEvidence(evidence, 'd3');
        engine.cameraDrawCallCount = 1;
        engine.totalWebglDrawCallCount = 101;
      },
      reason: 'a WebGL draw for every observed clear',
    },
    {
      name: 'a post-hoc QR-002 revision claim',
      mutate(evidence: Record<string, unknown>) {
        const sample = qr002Sample(evidence, 0);
        sample.diagnosticsCorrelation = {
          ...(sample.diagnosticsCorrelation as Record<string, unknown>),
          revision: 999,
        };
      },
      reason: 'same runtime revision',
    },
    {
      name: 'an overlapping QR-002 timestamp tuple',
      mutate(evidence: Record<string, unknown>) {
        const previous = qr002Sample(evidence, 0);
        const sample = qr002Sample(evidence, 1);
        for (const field of [
          'startedAtEpochMs',
          'mutationCompletedAtEpochMs',
          'graphObservedAtEpochMs',
          'diagnosticsObservedAtEpochMs',
        ]) {
          sample[field] = previous[field];
        }
      },
      reason: 'overlaps or predates the prior serialized update sample',
    },
    {
      name: 'a skewed QR-002 event cycle',
      mutate(evidence: Record<string, unknown>) {
        qr002Sample(evidence, 1).eventKind = 'create';
      },
      reason: 'must preserve the five create/change/rename/delete cycles',
    },
    {
      name: 'a zero-millisecond QR-002 sample',
      mutate(evidence: Record<string, unknown>) {
        const sample = qr002Sample(evidence, 0);
        sample.durationMs = 0;
        sample.graphPublicationMs = 0;
        sample.diagnosticsPublicationMs = 0;
        sample.graphObservedAtEpochMs = sample.startedAtEpochMs;
        sample.diagnosticsObservedAtEpochMs = sample.startedAtEpochMs;
      },
      reason: 'positive publication durations',
    },
    {
      name: 'an empty expected diagnostics set',
      mutate(evidence: Record<string, unknown>) {
        qr002Sample(evidence, 0).expectedDiagnostics = [];
      },
      reason: 'event-specific probe contract',
    },
    {
      name: 'fabricated low interaction samples that dilute p95',
      mutate(evidence: Record<string, unknown>) {
        const engine = engineEvidence(evidence, 'd3');
        const interactions = engine.interactions as Record<string, unknown>;
        const outcomes = engine.interactionOutcomes as Record<string, unknown>;
        interactions.searchMs = [
          ...(interactions.searchMs as number[]),
          ...Array.from({ length: 20 }, () => 1),
        ];
        outcomes.search = [
          ...(outcomes.search as boolean[]),
          ...Array.from({ length: 20 }, () => true),
        ];
      },
      reason: 'searchMs requires exactly 20 samples',
    },
    {
      name: 'an extra first-frame sample',
      mutate(evidence: Record<string, unknown>) {
        const engine = engineEvidence(evidence, 'd3');
        engine.firstInteractiveFrameMs = [400, 1];
        engine.firstInteractiveFrameWebglClears = [2, 1];
        engine.firstInteractiveFrameWebglDrawCalls = [100, 1];
      },
      reason: 'exactly one first-interactive-frame sample',
    },
    {
      name: 'a future QR-003 measurement timestamp',
      mutate(evidence: Record<string, unknown>) {
        (evidence.qr003 as Record<string, unknown>).capturedAt = '2026-07-23T00:00:00Z';
      },
      reason: 'cannot occur after the containing evidence capture',
    },
  ])('fails closed for $name', ({ name, mutate, reason }) => {
    const evidence = structuredClone(syntheticPassingEvidence()) as Record<string, unknown>;
    mutate(evidence);
    const result = runStrictEvidence(`mutation-${name.replaceAll(/\W+/gu, '-')}`, evidence);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain(reason);
  });
});

function syntheticPassingEvidence(
  options: {
    readonly graphVersion?: string;
    readonly includeExtensionHostHash?: boolean;
    readonly includeProductionBundleSetHash?: boolean;
    readonly includeWebviewCssHash?: boolean;
    readonly includeWebviewJavaScriptHash?: boolean;
    readonly packageVersion?: string;
    readonly webviewCssSuffix?: string;
  } = {},
): Readonly<Record<string, unknown>> {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
    readonly dependencies: Readonly<Record<string, string>>;
    readonly version: string;
  };
  const extensionHostBundle = readFileSync(join('dist', 'extension.cjs'));
  const webviewJavaScriptBundle = readFileSync(join('dist', 'webview', 'main.js'));
  const webviewCssBundle = Buffer.concat([
    readFileSync(join('dist', 'webview', 'main.css')),
    Buffer.from(options.webviewCssSuffix ?? ''),
  ]);
  const extensionHostBundleSha256 = sha256(extensionHostBundle);
  const webviewJavaScriptBundleSha256 = sha256(webviewJavaScriptBundle);
  const webviewCssBundleSha256 = sha256(webviewCssBundle);
  const productionBundleSetSha256 = hashPerformanceBundleSet({
    extensionHostJavaScript: extensionHostBundle,
    webviewJavaScript: webviewJavaScriptBundle,
    webviewCss: webviewCssBundle,
  });
  return {
    schemaVersion: 3,
    measurementKind: 'headed-editor',
    capturedAt: '2026-07-22T12:00:00+09:00',
    environment: {
      hardware: 'synthetic-test-hardware',
      os: 'synthetic-test-os',
      cpu: 'synthetic-test-cpu',
      memoryGb: 32,
      gpu: 'synthetic-test-gpu',
      editorName: 'VS Code',
      editorVersion: CURRENT_PERFORMANCE_VSCODE_VERSION,
      editorCommit: 'synthetic-test-commit',
      electronVersion: 'synthetic-test-electron',
      chromiumVersion: 'synthetic-test-chromium',
      fixtureSeed: PERFORMANCE_FIXTURE_SEED,
      packageVersions: {
        '3d-force-graph': options.graphVersion ?? manifest.dependencies['3d-force-graph'],
        'okf-workbench': options.packageVersion ?? manifest.version,
      },
      ...(options.includeExtensionHostHash === false ? {} : { extensionHostBundleSha256 }),
      ...(options.includeWebviewJavaScriptHash === false ? {} : { webviewJavaScriptBundleSha256 }),
      ...(options.includeWebviewCssHash === false ? {} : { webviewCssBundleSha256 }),
      ...(options.includeProductionBundleSetHash === false ? {} : { productionBundleSetSha256 }),
    },
    inputIdentity: {
      ...currentPerformanceInputs.inputIdentity,
    },
    qr002: {
      debounceMs: 250,
      updateSamples: Array.from({ length: 20 }, (_, index) => {
        const eventKind = ['create', 'change', 'rename', 'delete'][index % 4];
        const graphRevision = index + 2;
        const expectedDiagnostics = expectedQr002Diagnostics(eventKind);
        const startedAtEpochMs = Date.parse('2026-07-22T02:00:00Z') + index * 1_000;
        return {
          eventKind,
          durationMs: 300,
          graphPublicationMs: 280,
          diagnosticsPublicationMs: 300,
          startedAtEpochMs,
          mutationCompletedAtEpochMs: startedAtEpochMs + 5,
          graphObservedAtEpochMs: startedAtEpochMs + 280,
          diagnosticsObservedAtEpochMs: startedAtEpochMs + 300,
          graphRevision,
          diagnosticsSequence: index + 1,
          diagnosticsCorrelation: {
            authority: 'okf-acceptance-runtime-publication',
            revision: graphRevision,
            diagnosticsPublished: true,
            findingCount: expectedDiagnostics.length,
            conceptCount: eventKind === 'delete' ? 1_000 : 1_001,
            edgeCount: eventKind === 'delete' ? 5_000 : eventKind === 'rename' ? 5_002 : 5_001,
          },
          expectedDiagnostics,
          observedDiagnostics: expectedDiagnostics,
        };
      }),
    },
    qr003: {
      capturedAt: '2026-07-22T12:00:00+09:00',
      provenance: { kind: 'captured' },
      fixture: PERFORMANCE_FIXTURES.representative,
      engines: {
        d3: syntheticEngine(400, 12),
        ngraph: syntheticEngine(550, 18),
      },
    },
    security: {
      schemaVersion: 1,
      webviewNetwork: {
        authority: 'headed-vscode-webview-cdp',
        captureScope:
          'Initial Webview resources plus CDP events during watcher refresh and engine interaction.',
        remoteRequestCount: 0,
        remoteOrigins: [],
        localResourceRequestCount: 2,
        localOrigins: ['https://file+.vscode-resource.vscode-cdn.net'],
        webviewNavigationRequestCount: 1,
        webviewNavigationOrigins: [
          'vscode-webview://07ah2qk3gn0a6knrq6q3pnd6p9d310f8gqc9g48lfsosvfbe2dc2',
        ],
        otherRequestCount: 0,
        otherSchemes: [],
      },
    },
  };
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function materializePerformanceCandidate(
  inputs: Awaited<ReturnType<typeof captureCurrentPerformanceInputs>>,
  executionInputs: Awaited<ReturnType<typeof captureHeadedEvidenceExecutionSnapshot>>,
  destinationRoot: string,
): void {
  const files = new Map<string, Uint8Array>();
  const addSnapshot = (
    snapshot: (typeof inputs)['productionRuntimeSnapshot'],
    prefix = '',
  ): void => {
    for (const entry of snapshot.entries) {
      const relativePath = prefix === '' ? entry.relativePath : `${prefix}/${entry.relativePath}`;
      const existing = files.get(relativePath);
      if (existing !== undefined && !Buffer.from(existing).equals(Buffer.from(entry.content))) {
        throw new Error(`Candidate snapshots disagree for ${relativePath}.`);
      }
      files.set(relativePath, entry.content);
    }
  };
  addSnapshot(inputs.productionRuntimeSnapshot);
  addSnapshot(inputs.productionBuildInputSnapshot);
  addSnapshot(inputs.headedHarness.inputSnapshot);
  addSnapshot(inputs.diagnosticsObserverSnapshot, 'test/benchmarks/diagnostics-observer');
  addSnapshot(executionInputs);
  for (const [relativePath, content] of files) {
    const destination = join(destinationRoot, ...relativePath.split('/'));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
}

function syntheticEngine(
  firstFrameMs: number,
  interactionMs: number,
): Readonly<Record<string, unknown>> {
  const interactions = Array.from({ length: 20 }, () => interactionMs);
  return {
    firstInteractiveFrameMs: [firstFrameMs],
    firstInteractiveFrameWebglClears: [2],
    firstInteractiveFrameWebglDrawCalls: [100],
    cooldownReached: true,
    cooldownMs: [1_000],
    idleAnimationFramesAfterCooldown: [0],
    interactions: {
      searchMs: interactions,
      filterMs: interactions,
      selectionMs: interactions,
      navigationMs: interactions,
    },
    interactionOutcomes: {
      search: Array.from({ length: 20 }, () => true),
      filter: Array.from({ length: 20 }, () => true),
      selection: Array.from({ length: 20 }, () => true),
      navigation: Array.from({ length: 20 }, () => true),
    },
    memoryPeakMb: 256,
    idleCpuPercent: 0,
    cameraDurationMs: 700,
    cameraFrameCount: 42,
    cameraDrawCallCount: 84,
    cameraFps: 60,
    totalWebglClearCount: 200,
    totalWebglDrawCallCount: 10_000,
  };
}

function syntheticFirstFrameTimeout(): Readonly<Record<string, unknown>> {
  return {
    measurementFailure: {
      authority: 'headed-vscode-webview-harness',
      phase: 'first-interactive-frame',
      code: 'graph-webgl-render-timeout',
      timeoutMs: 5_000,
      observedClearCount: 0,
      observedDrawCallCount: 0,
      canvasPresent: true,
      nodeCount: 1_000,
      edgeCount: 5_000,
    },
    memoryPeakMb: 256,
    idleCpuPercent: 0,
    processTreePeakRssMb: 256,
    processTreeSampleCount: 10,
  };
}

function expectedQr002Diagnostics(
  eventKind: string | undefined,
): readonly Readonly<{ relativePath: string; code: string }>[] {
  const control = {
    relativePath: 'concepts/concept-0000.md',
    code: 'okf.curation.broken-link',
  };
  const byEvent: Readonly<
    Record<string, readonly Readonly<{ relativePath: string; code: string }>[]>
  > = {
    create: [
      control,
      {
        relativePath: 'concepts/qr002-probe.md',
        code: 'okf.curation.missing-description',
      },
    ],
    change: [
      control,
      {
        relativePath: 'concepts/qr002-probe.md',
        code: 'okf.curation.broken-link',
      },
    ],
    rename: [
      {
        relativePath: 'concepts/qr002-probe-renamed.md',
        code: 'okf.curation.broken-link',
      },
    ],
    delete: [control],
  };
  return byEvent[eventKind ?? ''] ?? [];
}

function runStrictEvidence(_name: string, evidence: unknown) {
  const report = evaluateEvidence(evidence, currentCandidate);
  return {
    status: isPassingReport(report) ? 0 : 2,
    stderr: '',
    stdout: renderMarkdown(report),
  };
}

function runStrictEvidenceCli(
  name: string,
  evidence: Record<string, unknown>,
  candidate = process.cwd(),
) {
  const evidencePath = join(temporaryDirectory, `${name}.json`);
  writeFileSync(evidencePath, JSON.stringify(evidence), 'utf8');
  const candidateArguments = candidate === process.cwd() ? [] : ['--candidate-root', candidate];
  return spawnSync(
    process.execPath,
    [
      'scripts/benchmark-report.mjs',
      ...candidateArguments,
      '--measurements',
      evidencePath,
      '--require-passing',
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
}

function webviewNetwork(evidence: Record<string, unknown>): Record<string, unknown> {
  return ((evidence.security as Record<string, unknown>).webviewNetwork ?? {}) as Record<
    string,
    unknown
  >;
}

function engineEvidence(
  evidence: Record<string, unknown>,
  engine: 'd3' | 'ngraph',
): Record<string, unknown> {
  return (
    (evidence.qr003 as Record<string, unknown>).engines as Record<string, Record<string, unknown>>
  )[engine] as Record<string, unknown>;
}

function qr002Sample(evidence: Record<string, unknown>, index: number): Record<string, unknown> {
  return ((evidence.qr002 as Record<string, unknown>).updateSamples as Record<string, unknown>[])[
    index
  ] as Record<string, unknown>;
}
