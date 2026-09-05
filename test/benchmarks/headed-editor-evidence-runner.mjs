/* eslint-disable no-undef -- Playwright evaluate callbacks execute inside the VS Code Webview. */

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
} from '@vscode/test-electron';
import { chromium } from 'playwright';

import { hashPerformanceBundleSet } from '../../scripts/performance-bundle-hash.mjs';
import {
  publishPerformanceEvidence,
  withPerformanceDeadline,
} from '../../scripts/performance-evidence-publisher.mjs';
import {
  assertProductionBuildInputSnapshotUnchanged,
  captureDiagnosticsObserverSnapshot,
  captureHeadedHarness as captureSharedHeadedHarness,
  captureProductionBuildInputSnapshot as captureSharedProductionBuildInputSnapshot,
  captureProductionRuntimeSnapshot,
  createPerformanceInputIdentity,
  CURRENT_PERFORMANCE_VSCODE_VERSION,
  preparePrivatePerformanceMaterializationRoot,
} from '../../scripts/performance-evidence-inputs.mjs';
import {
  assertInputSnapshotUnchanged,
  materializeInputSnapshot,
} from '../../scripts/performance-input-snapshot.mjs';
import { captureHeadedEvidenceExecutionSnapshot } from '../../scripts/performance-toolchain.mjs';
import { createWebviewNetworkRecorder } from './webview-network-recorder.mjs';

const execFileAsync = promisify(execFile);
const FIXTURE_SEED = 0x004f_4b46;
const NODE_COUNT = 1_000;
const EDGE_COUNT = 5_000;
const UPDATE_SAMPLES = 20;
const UPDATE_CYCLES = 5;
const CDP_TIMEOUT_MS = 60_000;
const GRAPH_TIMEOUT_MS = 120_000;
const ENGINE_EVALUATION_TIMEOUT_MS = 147_000;
const ENGINE_MONITOR_TIMEOUT_MS = 150_000;
const PROCESS_TREE_SAMPLE_TIMEOUT_MS = 5_000;
const QR002_DIAGNOSTICS_CORRELATION_AUTHORITY = 'okf-acceptance-runtime-publication';
const STAGED_EXECUTION_ENVIRONMENT_VARIABLE = 'OKF_HEADED_STAGED_EXECUTION';
const HEADLESS_REPORT_WARNING =
  'This runner launches headed VS Code and measures its real Electron Webview; it does not use Playwright Chromium.';
const BENCHMARK_EDITOR_FLAGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    version: { type: 'string', default: CURRENT_PERFORMANCE_VSCODE_VERSION },
    'vscode-executable': { type: 'string' },
    'keep-workspace': { type: 'boolean', default: false },
  },
  strict: true,
});

const repositoryRoot = process.cwd();
const stagedExecutionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const stagedExecutionAuthority = parseStagedExecutionAuthority();
delete process.env.OKF_HEADED_STAGED_EXECUTION;
await assertPrivateStagedExecutionRoot();
const stagedExecutionSnapshot = await captureHeadedEvidenceExecutionSnapshot(stagedExecutionRoot);
if (stagedExecutionSnapshot.sha256 !== stagedExecutionAuthority.snapshotSha256) {
  throw new Error('The private headed execution stage does not match its bootstrap snapshot.');
}
await assertStagedToolResolution();
const originalExecutionSnapshot = await captureHeadedEvidenceExecutionSnapshot(repositoryRoot);
if (originalExecutionSnapshot.sha256 !== stagedExecutionSnapshot.sha256) {
  throw new Error('Repository executable inputs do not match the private headed execution stage.');
}
const version = values.version;
if (version !== CURRENT_PERFORMANCE_VSCODE_VERSION) {
  throw new Error(
    `Headed release evidence requires pinned VS Code ${CURRENT_PERFORMANCE_VSCODE_VERSION}; received ${version}.`,
  );
}
const outputPath = path.resolve(
  values.output ?? `artifacts/performance/headed-editor-vscode-${version}.json`,
);
const runRoot = await mkdtemp(path.join(os.tmpdir(), 'okf-headed-performance-'));
const workspaceRoot = path.join(runRoot, 'workspace');
const userDataDirectory = path.join(runRoot, 'user-data');
const extensionsDirectory = path.join(runRoot, 'extensions');
const diagnosticsTracePath = path.join(runRoot, 'qr002-diagnostics.jsonl');
const materializedProductionDirectory = path.join(runRoot, 'production-build-snapshot');
const materializedHeadedHarnessDirectory = path.join(runRoot, 'qr003-harness-snapshot');
const stagedDiagnosticsObserverDirectory = path.join(runRoot, 'diagnostics-observer-snapshot');
const temporaryEvidencePath = path.join(runRoot, 'headed-editor-evidence.json');
let vscodeProcess;
let browser;
let networkRecorder;

try {
  process.stdout.write(`Preparing deterministic OKF workspace at ${workspaceRoot}\n`);
  await createOkfWorkspace(workspaceRoot);
  await runBoundProductionBuild(repositoryRoot);

  const productionBuildInputSnapshot =
    await captureSharedProductionBuildInputSnapshot(repositoryRoot);
  await preparePrivatePerformanceMaterializationRoot(
    repositoryRoot,
    materializedProductionDirectory,
  );
  await materializeInputSnapshot(productionBuildInputSnapshot, materializedProductionDirectory);
  await verifyProductionBuildInputs(productionBuildInputSnapshot);
  await runBoundProductionBuild(materializedProductionDirectory);
  await verifyProductionBuildInputs(productionBuildInputSnapshot);
  const firstProductionRuntimeSnapshot = await captureProductionRuntimeSnapshot(
    materializedProductionDirectory,
  );
  await runBoundProductionBuild(materializedProductionDirectory);
  await verifyProductionBuildInputs(productionBuildInputSnapshot);
  const productionRuntimeSnapshot = await captureProductionRuntimeSnapshot(
    materializedProductionDirectory,
  );
  if (firstProductionRuntimeSnapshot.sha256 !== productionRuntimeSnapshot.sha256) {
    throw new Error(
      'Production runtime output was not deterministic across the private binding builds.',
    );
  }
  const diagnosticsObserverSnapshot = await captureDiagnosticsObserverSnapshot(repositoryRoot);
  const headedHarness = await captureSharedHeadedHarness(
    repositoryRoot,
    materializedHeadedHarnessDirectory,
  );
  const inputIdentity = createPerformanceInputIdentity({
    diagnosticsObserverSnapshot,
    headedHarness,
    productionBuildInputSnapshot,
    productionRuntimeSnapshot,
  });

  await materializeInputSnapshot(diagnosticsObserverSnapshot, stagedDiagnosticsObserverDirectory);
  await verifyPerformanceInputs({
    diagnosticsObserverSnapshot,
    headedHarness,
    productionBuildInputSnapshot,
    productionRuntimeSnapshot,
  });
  process.stdout.write(
    `Bound immutable inputs: production ${productionRuntimeSnapshot.sha256}; QR-003 ${headedHarness.inputSnapshot.sha256}; harness ${headedHarness.bundleSha256}\n`,
  );

  const packageManifest = JSON.parse(
    snapshotEntry(productionRuntimeSnapshot, 'package.json').content.toString('utf8'),
  );
  const extensionHostBundle = snapshotEntry(
    productionRuntimeSnapshot,
    'dist/extension.cjs',
  ).content;
  const webviewJavaScriptBundle = snapshotEntry(
    productionRuntimeSnapshot,
    'dist/webview/main.js',
  ).content;
  const webviewCssBundle = snapshotEntry(
    productionRuntimeSnapshot,
    'dist/webview/main.css',
  ).content;

  const executablePath =
    values['vscode-executable'] ??
    (await downloadAndUnzipVSCode({
      version,
      cachePath: path.join(repositoryRoot, '.vscode-test'),
    }));
  const editorMetadata = await readEditorMetadata(executablePath);
  if (editorMetadata.version !== version) {
    throw new Error(
      `The selected VS Code executable reports ${editorMetadata.version}; expected ${version}.`,
    );
  }
  const port = await reservePort();
  const launch = launchVscode(
    executablePath,
    port,
    diagnosticsTracePath,
    materializedProductionDirectory,
    stagedDiagnosticsObserverDirectory,
  );
  vscodeProcess = launch.process;

  process.stdout.write(`Connecting to headed VS Code ${version} on CDP port ${String(port)}\n`);
  browser = await connectToEditor(port, vscodeProcess, launch.logs);
  const mainPage = await findWorkbenchPage(browser);
  networkRecorder = await createWebviewNetworkRecorder(port);
  const networkTargetReady = networkRecorder.waitForOkfTarget();
  const commandStartedAt = Date.now();
  await openGraphFromCommandPalette(mainPage);
  const [graphFrame] = await Promise.all([findGraphFrame(browser), networkTargetReady]);
  await graphFrame
    .locator('.okf-statistics')
    .filter({ hasText: `${String(NODE_COUNT)} concepts` })
    .waitFor({ state: 'visible', timeout: GRAPH_TIMEOUT_MS });
  await graphFrame
    .locator('.okf-statistics')
    .filter({ hasText: `${String(EDGE_COUNT)} links` })
    .waitFor({ state: 'visible', timeout: GRAPH_TIMEOUT_MS });
  const productGraphInteractiveMs = Date.now() - commandStartedAt;

  await waitForDiagnosticsObserver(diagnosticsTracePath);
  process.stdout.write(
    'Collecting 20 headed create/change/rename/delete samples through Problems and graph publication\n',
  );
  const qr002 = await measureWatcherUpdates(graphFrame, workspaceRoot, diagnosticsTracePath);
  const gpu = await captureWebviewEnvironment(graphFrame);

  const environment = {
    hardware: await hardwareModel(),
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: `${os.cpus()[0]?.model ?? 'unknown'}; ${String(os.cpus().length)} logical processors`,
    memoryGb: round(os.totalmem() / 1024 ** 3, 2),
    gpu: `${gpu.vendor} / ${gpu.renderer}`,
    editorName: 'VS Code',
    editorVersion: editorMetadata.version,
    editorCommit: editorMetadata.commit,
    electronVersion: gpu.electronVersion,
    chromiumVersion: gpu.chromiumVersion,
    fixtureSeed: FIXTURE_SEED,
    packageVersions: {
      'okf-workbench': packageManifest.version,
      '3d-force-graph': packageManifest.dependencies?.['3d-force-graph'] ?? 'unknown',
    },
    extensionHostBundleSha256: sha256Bytes(extensionHostBundle),
    webviewJavaScriptBundleSha256: sha256Bytes(webviewJavaScriptBundle),
    webviewCssBundleSha256: sha256Bytes(webviewCssBundle),
    productionBundleSetSha256: hashPerformanceBundleSet({
      extensionHostJavaScript: extensionHostBundle,
      webviewJavaScript: webviewJavaScriptBundle,
      webviewCss: webviewCssBundle,
    }),
    productGraphInteractiveMs,
    runnerNote: HEADLESS_REPORT_WARNING,
    benchmarkEditorFlags: BENCHMARK_EDITOR_FLAGS,
  };

  process.stdout.write('Injecting same-Electron d3/ngraph adapter harness\n');
  const webviewNonce = await graphFrame.evaluate(() => {
    return document.querySelector('script[nonce]')?.nonce;
  });
  await graphFrame.evaluate(() => {
    window.dispatchEvent(new Event('beforeunload'));
    document.body.replaceChildren();
  });
  await injectNonceAuthorizedHarness(graphFrame, headedHarness.javascript, webviewNonce);

  const engineResults = {};
  for (const engine of ['d3', 'ngraph']) {
    process.stdout.write(`Measuring ${engine} in the VS Code Webview\n`);
    const evaluation = graphFrame.evaluate((candidate) => {
      return globalThis.__okfHeadedHarness.measureEngine(candidate);
    }, engine);
    const boundedEvaluation = withPerformanceDeadline(
      evaluation,
      ENGINE_EVALUATION_TIMEOUT_MS,
      `${engine} Webview evaluation`,
    );
    const monitored = await withPerformanceDeadline(
      monitorProcessTree(vscodeProcess.pid, boundedEvaluation),
      ENGINE_MONITOR_TIMEOUT_MS,
      `${engine} Webview evaluation and process-tree monitoring`,
    );
    engineResults[engine] = {
      ...monitored.value,
      memoryPeakMb: monitored.peakRssMb,
      idleCpuPercent: monitored.idleCpuPercent,
      processTreePeakRssMb: monitored.peakRssMb,
      processTreeSampleCount: monitored.sampleCount,
    };
  }
  const qr003 = {
    capturedAt: new Date().toISOString(),
    provenance: { kind: 'captured' },
    fixture: {
      name: 'representative',
      nodeCount: NODE_COUNT,
      edgeCount: EDGE_COUNT,
      seed: FIXTURE_SEED,
    },
    engines: engineResults,
  };
  const networkCaptureScope =
    'Initial Webview resources plus CDP events during watcher refresh, search, filter, selection, engine comparison, and disposal.';

  const webviewNetwork = await networkRecorder.snapshot(networkCaptureScope);
  const capturedAt = new Date().toISOString();
  const evidence = {
    schemaVersion: 3,
    measurementKind: 'headed-editor',
    capturedAt,
    environment,
    inputIdentity,
    qr002,
    qr003,
    security: { schemaVersion: 1, webviewNetwork },
  };

  networkRecorder.close();
  networkRecorder = undefined;
  await browser.close();
  browser = undefined;
  await stopEditorProcess(vscodeProcess);
  vscodeProcess = undefined;

  if (webviewNetwork.remoteRequestCount !== 0) {
    throw new Error('The headed OKF Webview made a remote network request; evidence was withheld.');
  }
  await verifyPerformanceInputs({
    diagnosticsObserverSnapshot,
    headedHarness,
    productionBuildInputSnapshot,
    productionRuntimeSnapshot,
  });
  const evidenceBytes = `${JSON.stringify(evidence, undefined, 2)}\n`;
  await writeFile(temporaryEvidencePath, evidenceBytes, 'utf8');
  const strict = await execFileAsync(
    process.execPath,
    [
      resolveStagedPath('scripts/benchmark-report.mjs'),
      '--candidate-root',
      repositoryRoot,
      '--measurements',
      temporaryEvidencePath,
      '--require-passing',
    ],
    { cwd: repositoryRoot, maxBuffer: 4 * 1024 * 1024 },
  );
  await verifyPerformanceInputs({
    diagnosticsObserverSnapshot,
    headedHarness,
    productionBuildInputSnapshot,
    productionRuntimeSnapshot,
  });
  const published = await publishPerformanceEvidence({
    repositoryRoot,
    outputPath,
    evidenceBytes,
    reportBytes: strict.stdout,
    verify: async () =>
      verifyPerformanceInputs({
        diagnosticsObserverSnapshot,
        headedHarness,
        productionBuildInputSnapshot,
        productionRuntimeSnapshot,
      }),
  });
  await verifyPerformanceInputs({
    diagnosticsObserverSnapshot,
    headedHarness,
    productionBuildInputSnapshot,
    productionRuntimeSnapshot,
  });
  process.stdout.write(
    `${strict.stdout}\nRaw evidence: ${published.outputPath}\nReport: ${published.reportPath}\n`,
  );
} finally {
  networkRecorder?.close();
  await browser?.close().catch(() => undefined);
  await stopEditorProcess(vscodeProcess).catch(() => undefined);
  if (!values['keep-workspace']) {
    await rm(runRoot, { recursive: true, force: true });
  } else {
    process.stdout.write(`Retained benchmark workspace: ${runRoot}\n`);
  }
}

async function createOkfWorkspace(root) {
  const conceptsDirectory = path.join(root, 'concepts');
  await mkdir(conceptsDirectory, { recursive: true });
  await writeFile(
    path.join(root, 'index.md'),
    `---\nokf_version: "0.1"\n---\n# Deterministic headed performance bundle\n`,
    'utf8',
  );
  const writes = [];
  for (let index = 0; index < NODE_COUNT; index += 1) {
    const links = Array.from({ length: 5 }, (_, offset) => {
      const target = (index + offset + 1) % NODE_COUNT;
      return `[Concept ${String(target).padStart(4, '0')}](./concept-${String(target).padStart(4, '0')}.md)`;
    });
    const content = [
      '---',
      `type: ${index % 7 === 0 ? 'decision' : 'concept'}`,
      `title: Concept ${String(index).padStart(4, '0')}`,
      'description: Deterministic headed-editor performance fixture concept.',
      `tags: [performance, group-${String(index % 20).padStart(2, '0')}]`,
      '---',
      `# Concept ${String(index).padStart(4, '0')}`,
      '',
      ...links.map((link) => `- ${link}`),
      ...(index === 0 ? ['', '- [QR-002 delete-event control](./qr002-probe-renamed.md)'] : []),
      '',
    ].join('\n');
    writes.push(
      writeFile(
        path.join(conceptsDirectory, `concept-${String(index).padStart(4, '0')}.md`),
        content,
        'utf8',
      ),
    );
  }
  await Promise.all(writes);
}

async function measureWatcherUpdates(frame, workspace, diagnosticsTrace) {
  await frame.evaluate(() => {
    const events = [];
    globalThis.__okfRefreshEvents = events;
    window.addEventListener('message', (event) => {
      const value = event.data;
      if (
        typeof value === 'object' &&
        value !== null &&
        value.type === 'replaceGraph' &&
        Number.isSafeInteger(value.revision)
      ) {
        events.push({
          revision: value.revision,
          at: Date.now(),
          concepts: value.payload?.statistics?.conceptCount,
          edges: value.payload?.statistics?.edgeCount,
          probes: Array.isArray(value.payload?.nodes)
            ? value.payload.nodes
                .filter(
                  (node) =>
                    typeof node?.id === 'string' && node.id.startsWith('concepts/qr002-probe'),
                )
                .map((node) => ({ id: node.id, brokenLinkCount: node.brokenLinkCount }))
            : [],
        });
      }
    });
  });

  const samples = [];
  let revision = 0;
  for (let cycle = 0; cycle < UPDATE_CYCLES; cycle += 1) {
    const suffix = String(cycle).padStart(2, '0');
    const createdRelativePath = 'concepts/qr002-probe.md';
    const renamedRelativePath = 'concepts/qr002-probe-renamed.md';
    const createdId = createdRelativePath.slice(0, -3);
    const renamedId = renamedRelativePath.slice(0, -3);
    const createdPath = path.join(workspace, ...createdRelativePath.split('/'));
    const renamedPath = path.join(workspace, ...renamedRelativePath.split('/'));

    revision = await measureUpdateSample({
      diagnosticsTrace,
      frame,
      previousRevision: revision,
      eventKind: 'create',
      expectedDiagnostics: [
        { relativePath: 'concepts/concept-0000.md', code: 'okf.curation.broken-link' },
        { relativePath: createdRelativePath, code: 'okf.curation.missing-description' },
      ],
      expectedGraph: {
        concepts: NODE_COUNT + 1,
        edges: EDGE_COUNT + 1,
        probeId: createdId,
        brokenLinkCount: 0,
      },
      mutate: () =>
        writeFile(createdPath, qr002ProbeContent(suffix, { brokenLink: false }), {
          encoding: 'utf8',
          flag: 'wx',
        }),
      samples,
    });
    revision = await measureUpdateSample({
      diagnosticsTrace,
      frame,
      previousRevision: revision,
      eventKind: 'change',
      expectedDiagnostics: [
        { relativePath: 'concepts/concept-0000.md', code: 'okf.curation.broken-link' },
        { relativePath: createdRelativePath, code: 'okf.curation.broken-link' },
      ],
      expectedGraph: {
        concepts: NODE_COUNT + 1,
        edges: EDGE_COUNT + 1,
        probeId: createdId,
        brokenLinkCount: 1,
      },
      mutate: () => writeFile(createdPath, qr002ProbeContent(suffix, { brokenLink: true }), 'utf8'),
      samples,
    });
    revision = await measureUpdateSample({
      diagnosticsTrace,
      frame,
      previousRevision: revision,
      eventKind: 'rename',
      expectedDiagnostics: [
        { relativePath: renamedRelativePath, code: 'okf.curation.broken-link' },
      ],
      expectedGraph: {
        concepts: NODE_COUNT + 1,
        edges: EDGE_COUNT + 2,
        probeId: renamedId,
        brokenLinkCount: 1,
      },
      mutate: () => rename(createdPath, renamedPath),
      samples,
    });
    revision = await measureUpdateSample({
      diagnosticsTrace,
      frame,
      previousRevision: revision,
      eventKind: 'delete',
      expectedDiagnostics: [
        { relativePath: 'concepts/concept-0000.md', code: 'okf.curation.broken-link' },
      ],
      expectedGraph: { concepts: NODE_COUNT, edges: EDGE_COUNT },
      mutate: () => rm(renamedPath),
      samples,
    });
  }
  if (samples.length !== UPDATE_SAMPLES) {
    throw new Error(`Expected ${String(UPDATE_SAMPLES)} QR-002 samples.`);
  }
  return { debounceMs: 250, updateSamples: samples };
}

async function measureUpdateSample(options) {
  const diagnosticsBefore = await latestDiagnosticsRecord(options.diagnosticsTrace);
  const startedAt = Date.now();
  const graphWait = waitForGraphPublication(
    options.frame,
    options.previousRevision,
    options.expectedGraph,
  );
  const diagnosticsWait = waitForDiagnosticsPublication(
    options.diagnosticsTrace,
    diagnosticsBefore.sequence,
    options.expectedDiagnostics,
  );
  await options.mutate();
  const mutationCompletedAt = Date.now();
  const [graphPublication, diagnosticsPublication] = await Promise.all([
    graphWait,
    diagnosticsWait,
  ]).catch(async (cause) => {
    const events = await options.frame.evaluate(() => globalThis.__okfRefreshEvents);
    throw new Error(
      `QR-002 ${options.eventKind} failed; graph publications: ${JSON.stringify(events)}`,
      { cause },
    );
  });
  const graphPublicationMs = graphPublication.at - startedAt;
  const diagnosticsPublicationMs = diagnosticsPublication.observedAtEpochMs - startedAt;
  if (graphPublicationMs < 0 || diagnosticsPublicationMs < 0) {
    throw new Error('A QR-002 observer timestamp preceded its file mutation.');
  }
  if (diagnosticsPublication.diagnosticsCorrelation.revision !== graphPublication.revision) {
    throw new Error(
      `Problems revision ${String(diagnosticsPublication.diagnosticsCorrelation.revision)} did not match graph revision ${String(graphPublication.revision)}.`,
    );
  }
  const observedDiagnostics = diagnosticsForEvidence(
    diagnosticsPublication.diagnostics,
    workspaceRoot,
  );
  if (!diagnosticsMatchEvidence(observedDiagnostics, options.expectedDiagnostics)) {
    throw new Error('The diagnostics observer result changed before evidence serialization.');
  }
  options.samples.push({
    eventKind: options.eventKind,
    durationMs: Math.max(graphPublicationMs, diagnosticsPublicationMs),
    graphPublicationMs,
    diagnosticsPublicationMs,
    startedAtEpochMs: startedAt,
    mutationCompletedAtEpochMs: mutationCompletedAt,
    graphObservedAtEpochMs: graphPublication.at,
    diagnosticsObservedAtEpochMs: diagnosticsPublication.observedAtEpochMs,
    graphRevision: graphPublication.revision,
    diagnosticsSequence: diagnosticsPublication.sequence,
    diagnosticsCorrelation: diagnosticsPublication.diagnosticsCorrelation,
    expectedDiagnostics: options.expectedDiagnostics,
    observedDiagnostics,
  });
  return graphPublication.revision;
}

async function waitForGraphPublication(frame, previousRevision, expected) {
  const matches = ({ revision, graph }) =>
    globalThis.__okfRefreshEvents.some(
      (event) =>
        event.revision > revision &&
        event.concepts === graph.concepts &&
        event.edges === graph.edges &&
        (graph.probeId === undefined
          ? event.probes.length === 0
          : event.probes.some(
              (probe) =>
                probe.id === graph.probeId && probe.brokenLinkCount === graph.brokenLinkCount,
            )),
    );
  await frame.waitForFunction(
    matches,
    { revision: previousRevision, graph: expected },
    {
      timeout: 30_000,
    },
  );
  const event = await frame.evaluate(
    ({ revision, graph }) =>
      globalThis.__okfRefreshEvents.find(
        (candidate) =>
          candidate.revision > revision &&
          candidate.concepts === graph.concepts &&
          candidate.edges === graph.edges &&
          (graph.probeId === undefined
            ? candidate.probes.length === 0
            : candidate.probes.some(
                (probe) =>
                  probe.id === graph.probeId && probe.brokenLinkCount === graph.brokenLinkCount,
              )),
      ),
    { revision: previousRevision, graph: expected },
  );
  if (event === undefined) throw new Error('The current replacement graph event disappeared.');
  return event;
}

async function waitForDiagnosticsObserver(tracePath) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const records = await readDiagnosticsRecords(tracePath);
    if (records.length > 0) return records.at(-1);
    await delay(25);
  }
  throw new Error('The headed diagnostics observer did not activate.');
}

async function latestDiagnosticsRecord(tracePath) {
  const records = await readDiagnosticsRecords(tracePath);
  const latest = records.at(-1);
  if (latest === undefined) throw new Error('The headed diagnostics observer has no baseline.');
  return latest;
}

async function waitForDiagnosticsPublication(tracePath, previousSequence, expected) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const records = await readDiagnosticsRecords(tracePath);
    const match = records.find(
      (record) =>
        record.sequence > previousSequence &&
        record.diagnosticsCorrelation !== null &&
        record.diagnosticsCorrelation.authority === QR002_DIAGNOSTICS_CORRELATION_AUTHORITY &&
        record.diagnosticsCorrelation.findingCount === record.diagnostics.length &&
        diagnosticsMatch(record.diagnostics, expected),
    );
    if (match !== undefined) return match;
    await delay(25);
  }
  throw new Error(`Problems did not publish current diagnostics: ${JSON.stringify(expected)}.`);
}

async function readDiagnosticsRecords(tracePath) {
  let content;
  try {
    content = await readFile(tracePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return content
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const record = JSON.parse(line);
        return record?.schemaVersion === 2 &&
          Number.isSafeInteger(record.sequence) &&
          Number.isFinite(record.observedAtEpochMs) &&
          Array.isArray(record.diagnostics) &&
          validDiagnosticsCorrelation(record.diagnosticsCorrelation)
          ? [record]
          : [];
      } catch {
        return [];
      }
    });
}

function diagnosticsMatch(actual, expected) {
  if (actual.length !== expected.length) return false;
  return expected.every((candidate) =>
    actual.some(
      (diagnostic) =>
        diagnostic.code === candidate.code &&
        uriEndsWithPath(diagnostic.uri, candidate.relativePath),
    ),
  );
}

function diagnosticsForEvidence(actual, workspace) {
  return actual
    .map((diagnostic) => {
      const filePath = fileURLToPath(diagnostic.uri);
      const relativePath = path.relative(workspace, filePath).replaceAll(path.sep, '/');
      if (
        relativePath.length === 0 ||
        relativePath.startsWith('../') ||
        path.isAbsolute(relativePath)
      ) {
        throw new Error('The diagnostics observer returned a URI outside the benchmark workspace.');
      }
      return { relativePath, code: diagnostic.code };
    })
    .sort(
      (left, right) =>
        left.relativePath.localeCompare(right.relativePath) || left.code.localeCompare(right.code),
    );
}

function diagnosticsMatchEvidence(actual, expected) {
  const sortedExpected = [...expected].sort(
    (left, right) =>
      left.relativePath.localeCompare(right.relativePath) || left.code.localeCompare(right.code),
  );
  return (
    actual.length === sortedExpected.length &&
    actual.every(
      (diagnostic, index) =>
        diagnostic.relativePath === sortedExpected[index]?.relativePath &&
        diagnostic.code === sortedExpected[index]?.code,
    )
  );
}

function validDiagnosticsCorrelation(value) {
  return (
    value === null ||
    (typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      value.authority === QR002_DIAGNOSTICS_CORRELATION_AUTHORITY &&
      value.diagnosticsPublished === true &&
      Number.isSafeInteger(value.revision) &&
      value.revision >= 0 &&
      Number.isSafeInteger(value.findingCount) &&
      value.findingCount >= 0 &&
      Number.isSafeInteger(value.conceptCount) &&
      value.conceptCount >= 0 &&
      Number.isSafeInteger(value.edgeCount) &&
      value.edgeCount >= 0)
  );
}

function uriEndsWithPath(uri, relativePath) {
  try {
    const pathname = decodeURIComponent(new URL(uri).pathname).replaceAll('\\', '/');
    return pathname.endsWith(`/${relativePath}`);
  } catch {
    return false;
  }
}

function qr002ProbeContent(suffix, { brokenLink }) {
  return [
    '---',
    'type: performance-probe',
    `title: QR-002 probe ${suffix}`,
    ...(brokenLink ? ['description: Current diagnostics and graph publication probe.'] : []),
    'tags: [performance, qr002]',
    '---',
    `# QR-002 probe ${suffix}`,
    '',
    '[Existing concept](./concept-0000.md)',
    ...(brokenLink ? ['', '[Expected broken target](./missing-qr002-target.md)'] : []),
    '',
  ].join('\n');
}

function parseStagedExecutionAuthority() {
  const raw = process.env[STAGED_EXECUTION_ENVIRONMENT_VARIABLE];
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(
      'Run headed-editor-evidence.mjs so measurement code executes from a private immutable stage.',
    );
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`The headed staged-execution authority is not valid JSON: ${String(error)}`);
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    value.schemaVersion !== 1 ||
    typeof value.snapshotSha256 !== 'string' ||
    !/^[a-f\d]{64}$/u.test(value.snapshotSha256)
  ) {
    throw new Error('The headed staged-execution authority has an unexpected shape.');
  }
  return value;
}

async function assertStagedToolResolution() {
  const packageNames = [
    '@vscode/test-electron',
    'agent-base',
    'esbuild',
    'jszip',
    'playwright',
    'playwright-core',
    'semver',
    ...(process.platform === 'darwin' ? ['fsevents'] : []),
  ];
  for (const packageName of packageNames) {
    const resolved = fileURLToPath(import.meta.resolve(packageName));
    const relative = path.relative(stagedExecutionRoot, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(
        `Headed measurement package ${packageName} resolved outside its private stage.`,
      );
    }
  }
}

async function assertPrivateStagedExecutionRoot() {
  const [repositoryRealPath, stagedRealPath, stagedStatus] = await Promise.all([
    realpath(repositoryRoot),
    realpath(stagedExecutionRoot),
    lstat(stagedExecutionRoot),
  ]);
  const repositoryToStage = path.relative(repositoryRealPath, stagedRealPath);
  const stageToRepository = path.relative(stagedRealPath, repositoryRealPath);
  if (
    !stagedStatus.isDirectory() ||
    stagedStatus.isSymbolicLink() ||
    repositoryToStage === '' ||
    (!repositoryToStage.startsWith('..') && !path.isAbsolute(repositoryToStage)) ||
    (!stageToRepository.startsWith('..') && !path.isAbsolute(stageToRepository))
  ) {
    throw new Error('Headed measurement must execute from a private stage outside the repository.');
  }
  if (
    process.platform !== 'win32' &&
    ((stagedStatus.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && stagedStatus.uid !== process.getuid()))
  ) {
    throw new Error('Headed measurement stage must be owner-only and owned by the current user.');
  }
}

function resolveStagedPath(relativePath) {
  const resolved = path.resolve(stagedExecutionRoot, ...relativePath.split('/'));
  const relative = path.relative(stagedExecutionRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Staged headed execution path escapes its root: ${relativePath}.`);
  }
  return resolved;
}

async function runBoundProductionBuild(targetRepositoryRoot) {
  await execFileAsync(
    process.execPath,
    [
      resolveStagedPath('scripts/build.mjs'),
      '--production',
      '--repository-root',
      targetRepositoryRoot,
    ],
    { cwd: targetRepositoryRoot },
  );
}

async function verifyProductionBuildInputs(productionBuildInputSnapshot) {
  await Promise.all([
    assertProductionBuildInputSnapshotUnchanged(
      productionBuildInputSnapshot,
      repositoryRoot,
      'Original production build inputs',
    ),
    assertProductionBuildInputSnapshotUnchanged(
      productionBuildInputSnapshot,
      materializedProductionDirectory,
      'Materialized production build inputs',
    ),
  ]);
}

async function verifyPerformanceInputs({
  diagnosticsObserverSnapshot,
  headedHarness,
  productionBuildInputSnapshot,
  productionRuntimeSnapshot,
}) {
  await Promise.all([
    assertInputSnapshotUnchanged(
      originalExecutionSnapshot,
      repositoryRoot,
      'Original headed executable inputs',
    ),
    assertInputSnapshotUnchanged(
      stagedExecutionSnapshot,
      stagedExecutionRoot,
      'Private staged headed executable inputs',
    ),
    assertInputSnapshotUnchanged(
      productionRuntimeSnapshot,
      materializedProductionDirectory,
      'Materialized production runtime',
    ),
    assertInputSnapshotUnchanged(
      productionRuntimeSnapshot,
      repositoryRoot,
      'Original production runtime',
    ),
    verifyProductionBuildInputs(productionBuildInputSnapshot),
    assertInputSnapshotUnchanged(
      diagnosticsObserverSnapshot,
      undefined,
      'Original QR-002 diagnostics observer',
    ),
    assertInputSnapshotUnchanged(
      diagnosticsObserverSnapshot,
      stagedDiagnosticsObserverDirectory,
      'Staged QR-002 diagnostics observer',
    ),
    assertInputSnapshotUnchanged(
      headedHarness.inputSnapshot,
      repositoryRoot,
      'Original QR-003 harness inputs',
    ),
    assertInputSnapshotUnchanged(
      headedHarness.inputSnapshot,
      materializedHeadedHarnessDirectory,
      'Materialized QR-003 harness inputs',
    ),
  ]);
  if (headedHarness.bundleSha256 !== sha256Bytes(Buffer.from(headedHarness.javascript, 'utf8'))) {
    throw new Error('The frozen QR-003 harness bytes changed after capture.');
  }
}

function snapshotEntry(snapshot, relativePath) {
  const entry = snapshot.entries.find((candidate) => candidate.relativePath === relativePath);
  if (entry === undefined) throw new Error(`Immutable snapshot is missing ${relativePath}.`);
  return entry;
}

async function injectNonceAuthorizedHarness(frame, bundle, webviewNonce) {
  await frame.evaluate(
    ({ source, nonce }) => {
      if (nonce === undefined || nonce.length === 0) {
        throw new Error('The graph Webview nonce was not available to the benchmark runner.');
      }
      const script = document.createElement('script');
      script.nonce = nonce;
      script.textContent = source;
      document.documentElement.append(script);
      script.remove();
    },
    { source: bundle, nonce: webviewNonce },
  );
  await frame.waitForFunction(() => globalThis.__okfHeadedHarness !== undefined, undefined, {
    timeout: 30_000,
  });
}

async function monitorProcessTree(rootPid, evaluation) {
  let pending = true;
  evaluation.then(
    () => {
      pending = false;
    },
    () => {
      pending = false;
    },
  );
  const samples = [];
  while (pending) {
    samples.push(await sampleProcessTree(rootPid));
    await delay(500);
  }
  const value = await evaluation;
  await delay(750);
  const idleSamples = [];
  for (let index = 0; index < 3; index += 1) {
    idleSamples.push(await sampleProcessTree(rootPid));
    await delay(500);
  }
  return {
    value,
    peakRssMb: round(Math.max(...samples.map((sample) => sample.rssMb)), 2),
    idleCpuPercent: round(
      idleSamples.reduce((sum, sample) => sum + sample.cpuPercent, 0) / idleSamples.length,
      2,
    ),
    sampleCount: samples.length,
  };
}

async function sampleProcessTree(rootPid) {
  const { stdout } =
    process.platform === 'win32'
      ? await execFileAsync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ForEach-Object { '{0} {1} {2} {3}' -f $_.IDProcess, $_.CreatingProcessID, $_.PercentProcessorTime, [math]::Floor($_.WorkingSet / 1024) }",
          ],
          { timeout: 15_000, windowsHide: true },
        )
      : await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,%cpu=,rss='], {
          timeout: PROCESS_TREE_SAMPLE_TIMEOUT_MS,
        });
  const processes = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .filter((fields) => fields.length === 4)
    .map(([pid, parentPid, cpu, rss]) => ({
      pid: Number(pid),
      parentPid: Number(parentPid),
      cpuPercent: Number(cpu),
      rssKb: Number(rss),
    }))
    .filter((entry) =>
      [entry.pid, entry.parentPid, entry.cpuPercent, entry.rssKb].every(Number.isFinite),
    );
  const included = new Set([rootPid]);
  let added = true;
  while (added) {
    added = false;
    for (const entry of processes) {
      if (included.has(entry.parentPid) && !included.has(entry.pid)) {
        included.add(entry.pid);
        added = true;
      }
    }
  }
  const tree = processes.filter((entry) => included.has(entry.pid));
  return {
    cpuPercent: tree.reduce((sum, entry) => sum + entry.cpuPercent, 0),
    rssMb: tree.reduce((sum, entry) => sum + entry.rssKb, 0) / 1024,
  };
}

function launchVscode(
  executablePath,
  port,
  diagnosticsTrace,
  extensionDirectory,
  observerDirectory,
) {
  const arguments_ = [
    workspaceRoot,
    `--extensionDevelopmentPath=${extensionDirectory}`,
    `--extensionDevelopmentPath=${observerDirectory}`,
    `--user-data-dir=${userDataDirectory}`,
    `--extensions-dir=${extensionsDirectory}`,
    `--remote-debugging-port=${String(port)}`,
    '--disable-workspace-trust',
    '--disable-telemetry',
    '--disable-updates',
    '--skip-release-notes',
    '--skip-welcome',
    '--new-window',
    ...BENCHMARK_EDITOR_FLAGS,
  ];
  const child = spawn(executablePath, arguments_, {
    cwd: runRoot,
    env: {
      ...process.env,
      OKF_ACCEPTANCE_DRIVER: '1',
      OKF_QR002_DIAGNOSTICS_TRACE: diagnosticsTrace,
      VSCODE_DISABLE_CRASH_REPORTER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout?.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr?.on('data', (chunk) => logs.push(String(chunk)));
  return { process: child, logs };
}

async function connectToEditor(port, child, logs) {
  const deadline = Date.now() + CDP_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`VS Code exited before CDP was ready.\n${logs.join('').slice(-8_000)}`);
    }
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${String(port)}`);
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw new Error(
    `Timed out connecting to VS Code CDP: ${String(lastError)}\n${logs.join('').slice(-8_000)}`,
  );
}

async function findWorkbenchPage(connectedBrowser) {
  const deadline = Date.now() + CDP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const pages = connectedBrowser.contexts().flatMap((context) => context.pages());
    for (const page of pages) {
      if ((await page.locator('.monaco-workbench').count()) > 0) return page;
    }
    await delay(250);
  }
  throw new Error(
    `VS Code workbench page was not found. Targets: ${describeTargets(connectedBrowser)}`,
  );
}

async function openGraphFromCommandPalette(page) {
  const shortcut = process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P';
  await page.keyboard.press(shortcut);
  const input = page.locator('.quick-input-widget input');
  await input.waitFor({ state: 'visible', timeout: 30_000 });
  await input.fill('>OKF: Open 3D Graph');
  const candidate = page.locator('.quick-input-list .monaco-list-row').filter({
    hasText: 'Open 3D Graph',
  });
  await candidate.first().waitFor({ state: 'visible', timeout: 30_000 });
  await page.keyboard.press('Enter');
}

async function findGraphFrame(connectedBrowser) {
  const deadline = Date.now() + GRAPH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    for (const page of connectedBrowser.contexts().flatMap((context) => context.pages())) {
      for (const frame of page.frames()) {
        if ((await frame.locator('[data-okf-workbench-root]').count()) > 0) return frame;
      }
    }
    await delay(250);
  }
  throw new Error(
    `OKF graph Webview frame was not found. Targets: ${describeTargets(connectedBrowser)}`,
  );
}

function describeTargets(connectedBrowser) {
  return connectedBrowser
    .contexts()
    .flatMap((context) => context.pages())
    .flatMap((page) => page.frames().map((frame) => frame.url()))
    .join(', ');
}

async function readEditorMetadata(executablePath) {
  const [cli, ...prefix] = resolveCliArgsFromVSCodeExecutablePath(executablePath);
  const { stdout } =
    process.platform === 'win32'
      ? await execFileAsync(`"${cli}"`, ['--version'], {
          shell: true,
          windowsHide: true,
        })
      : await execFileAsync(cli, [...prefix, '--version']);
  const [versionLine, commitLine] = stdout.trim().split(/\r?\n/u);
  if (
    typeof versionLine !== 'string' ||
    !/^\d+\.\d+\.\d+$/u.test(versionLine) ||
    typeof commitLine !== 'string' ||
    !/^[a-f\d]{40}$/u.test(commitLine)
  ) {
    throw new Error('The selected VS Code executable returned malformed version metadata.');
  }
  return { version: versionLine, commit: commitLine };
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : undefined;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (port === undefined) throw new Error('Could not reserve a CDP port.');
  return port;
}

async function hardwareModel() {
  if (process.platform !== 'darwin') return `${os.machine()} ${os.arch()}`;
  return execFileAsync('/usr/sbin/sysctl', ['-n', 'hw.model'])
    .then(({ stdout }) => stdout.trim())
    .catch(() => `${os.machine()} ${os.arch()}`);
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function captureWebviewEnvironment(frame) {
  return frame.evaluate(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const debug = context?.getExtension('WEBGL_debug_renderer_info');
    const userAgent = navigator.userAgent;
    return {
      vendor:
        context && debug
          ? String(context.getParameter(debug.UNMASKED_VENDOR_WEBGL))
          : 'unavailable',
      renderer:
        context && debug
          ? String(context.getParameter(debug.UNMASKED_RENDERER_WEBGL))
          : 'unavailable',
      chromiumVersion: /Chrome\/([^ ]+)/u.exec(userAgent)?.[1] ?? 'unavailable',
      electronVersion: /Electron\/([^ ]+)/u.exec(userAgent)?.[1] ?? 'unavailable',
    };
  });
}

function onceExit(child) {
  return new Promise((resolve) => child.once('exit', resolve));
}

async function stopEditorProcess(child) {
  if (child?.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([onceExit(child), delay(5_000)]);
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await Promise.race([onceExit(child), delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error('VS Code did not exit before final performance-input verification.');
  }
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
