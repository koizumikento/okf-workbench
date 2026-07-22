import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build.mjs', '--production'], {
    cwd: process.cwd(),
    stdio: 'pipe',
  });
});

afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

describe('deterministic performance fixtures', () => {
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

describe('performance evidence report', () => {
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

  it('makes the strict release gate fail when evidence is absent', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/benchmark-report.mjs', '--require-passing'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
  });

  it('makes the strict gate fail when the production Webview bundle hash is missing', () => {
    const evidencePath = join(temporaryDirectory, 'missing-bundle-hash.json');
    writeFileSync(
      evidencePath,
      JSON.stringify(syntheticPassingEvidence({ includeWebviewHash: false })),
      'utf8',
    );
    const result = spawnSync(
      process.execPath,
      ['scripts/benchmark-report.mjs', '--measurements', evidencePath, '--require-passing'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('Environment Webview bundle SHA-256 is missing or malformed.');
  });

  it('makes the strict gate fail when the combined extension bundle hash is missing', () => {
    const evidencePath = join(temporaryDirectory, 'missing-extension-bundle-hash.json');
    writeFileSync(
      evidencePath,
      JSON.stringify(syntheticPassingEvidence({ includeExtensionHash: false })),
      'utf8',
    );
    const result = spawnSync(
      process.execPath,
      ['scripts/benchmark-report.mjs', '--measurements', evidencePath, '--require-passing'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toContain(
      'Environment extension bundle SHA-256 is missing or malformed.',
    );
  });

  it('makes the strict gate fail for synthetic package version 0.0.1', () => {
    const evidencePath = join(temporaryDirectory, 'stale-package-version.json');
    writeFileSync(
      evidencePath,
      JSON.stringify(syntheticPassingEvidence({ packageVersion: '0.0.1' })),
      'utf8',
    );
    const result = spawnSync(
      process.execPath,
      ['scripts/benchmark-report.mjs', '--measurements', evidencePath, '--require-passing'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('Evidence package version does not match current manifest');
  });

  it('makes the strict gate fail for a different 3d-force-graph version', () => {
    const evidencePath = join(temporaryDirectory, 'stale-graph-version.json');
    writeFileSync(
      evidencePath,
      JSON.stringify(syntheticPassingEvidence({ graphVersion: '1.79.0' })),
      'utf8',
    );
    const result = spawnSync(
      process.execPath,
      ['scripts/benchmark-report.mjs', '--measurements', evidencePath, '--require-passing'],
      { cwd: process.cwd(), encoding: 'utf8' },
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
    const evidencePath = join(temporaryDirectory, 'legacy-qr002.json');
    writeFileSync(evidencePath, JSON.stringify(evidence), 'utf8');
    const result = spawnSync(
      process.execPath,
      ['scripts/benchmark-report.mjs', '--measurements', evidencePath, '--require-passing'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('QR-002 requires at least 20 update samples.');
  });
});

function syntheticPassingEvidence(
  options: {
    readonly includeExtensionHash?: boolean;
    readonly includeWebviewHash?: boolean;
    readonly graphVersion?: string;
    readonly packageVersion?: string;
  } = {},
): Readonly<Record<string, unknown>> {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
    readonly dependencies: Readonly<Record<string, string>>;
    readonly version: string;
  };
  const webviewBundleSha256 = createHash('sha256')
    .update(readFileSync(join('dist', 'webview', 'main.js')))
    .digest('hex');
  const extensionBundleSha256 = createHash('sha256')
    .update(readFileSync(join('dist', 'extension.cjs')))
    .update(readFileSync(join('dist', 'webview', 'main.js')))
    .digest('hex');
  return {
    schemaVersion: 2,
    measurementKind: 'headed-editor',
    capturedAt: '2026-07-22T12:00:00+09:00',
    environment: {
      hardware: 'synthetic-test-hardware',
      os: 'synthetic-test-os',
      cpu: 'synthetic-test-cpu',
      memoryGb: 32,
      gpu: 'synthetic-test-gpu',
      editorName: 'VS Code',
      editorVersion: '1.127.0',
      editorCommit: 'synthetic-test-commit',
      electronVersion: 'synthetic-test-electron',
      chromiumVersion: 'synthetic-test-chromium',
      fixtureSeed: PERFORMANCE_FIXTURE_SEED,
      packageVersions: {
        '3d-force-graph': options.graphVersion ?? manifest.dependencies['3d-force-graph'],
        'okf-workbench': options.packageVersion ?? manifest.version,
      },
      ...(options.includeExtensionHash === false ? {} : { extensionBundleSha256 }),
      ...(options.includeWebviewHash === false ? {} : { webviewBundleSha256 }),
    },
    qr002: {
      debounceMs: 250,
      updateSamples: Array.from({ length: 20 }, (_, index) => {
        const eventKind = ['create', 'change', 'rename', 'delete'][index % 4];
        const graphRevision = index + 2;
        return {
          eventKind,
          durationMs: 300,
          graphPublicationMs: 280,
          diagnosticsPublicationMs: 300,
          graphRevision,
          diagnosticsSequence: index + 1,
          diagnosticsCorrelatedRevision: graphRevision,
          expectedDiagnostics:
            eventKind === 'delete'
              ? []
              : [
                  {
                    relativePath: `concepts/qr002-probe-${String(index).padStart(2, '0')}.md`,
                    code: 'okf.curation.broken-link',
                  },
                ],
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
  };
}

function syntheticEngine(
  firstFrameMs: number,
  interactionMs: number,
): Readonly<Record<string, unknown>> {
  const interactions = Array.from({ length: 20 }, () => interactionMs);
  return {
    firstInteractiveFrameMs: [firstFrameMs],
    cooldownReached: true,
    cooldownMs: [1_000],
    idleAnimationFramesAfterCooldown: [0],
    interactions: {
      searchMs: interactions,
      filterMs: interactions,
      selectionMs: interactions,
      navigationMs: interactions,
    },
    memoryPeakMb: 256,
    idleCpuPercent: 0,
    cameraFps: 60,
  };
}
