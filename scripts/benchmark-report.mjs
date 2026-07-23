import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { parseArgs } from 'node:util';

import { hashPerformanceBundleSet } from './performance-bundle-hash.mjs';
import {
  captureCurrentPerformanceInputs,
  CURRENT_PERFORMANCE_VSCODE_VERSION,
  PERFORMANCE_INPUT_IDENTITY_FIELDS,
} from './performance-evidence-inputs.mjs';

const QR002_SAMPLE_COUNT = 20;
const QR002_EVENT_CYCLE = ['create', 'change', 'rename', 'delete'];
const QR002_DEBOUNCE_MS = 250;
const QR002_SAMPLE_TIMEOUT_MS = 30_000;
const QR002_P95_LIMIT_MS = 1_000;
const QR003_FIRST_FRAME_LIMIT_MS = 5_000;
const QR003_INTERACTION_SAMPLE_COUNT = 20;
const QR003_INTERACTION_P95_LIMIT_MS = 100;
const QR003_MIN_CAMERA_DURATION_MS = 600;
const QR003_MEASUREMENT_FAILURE_AUTHORITY = 'headed-vscode-webview-harness';
const QR003_MEASUREMENT_FAILURE_CODE = 'graph-webgl-render-timeout';
const QR003_MEASUREMENT_FAILURE_PHASE = 'first-interactive-frame';
const MIN_LOCAL_RESOURCE_REQUESTS = 2;
const MAX_LOCAL_RESOURCE_REQUESTS = 64;
const EXPECTED_FIXTURE = { nodeCount: 1_000, edgeCount: 5_000, seed: 0x004f_4b46 };
const ENGINES = ['d3', 'ngraph'];
const INTERACTIONS = ['searchMs', 'filterMs', 'selectionMs', 'navigationMs'];
const INTERACTION_OUTCOMES = {
  searchMs: 'search',
  filterMs: 'filter',
  selectionMs: 'selection',
  navigationMs: 'navigation',
};
const QR002_DIAGNOSTICS_CORRELATION_AUTHORITY = 'okf-acceptance-runtime-publication';
const QR002_CONTROL_DIAGNOSTIC = Object.freeze({
  relativePath: 'concepts/concept-0000.md',
  code: 'okf.curation.broken-link',
});
const QR002_EXPECTED_DIAGNOSTICS = Object.freeze({
  create: Object.freeze([
    QR002_CONTROL_DIAGNOSTIC,
    Object.freeze({
      relativePath: 'concepts/qr002-probe.md',
      code: 'okf.curation.missing-description',
    }),
  ]),
  change: Object.freeze([
    QR002_CONTROL_DIAGNOSTIC,
    Object.freeze({
      relativePath: 'concepts/qr002-probe.md',
      code: 'okf.curation.broken-link',
    }),
  ]),
  rename: Object.freeze([
    Object.freeze({
      relativePath: 'concepts/qr002-probe-renamed.md',
      code: 'okf.curation.broken-link',
    }),
  ]),
  delete: Object.freeze([QR002_CONTROL_DIAGNOSTIC]),
});
const QR002_EXPECTED_GRAPH = Object.freeze({
  create: Object.freeze({ conceptCount: 1_001, edgeCount: 5_001 }),
  change: Object.freeze({ conceptCount: 1_001, edgeCount: 5_001 }),
  rename: Object.freeze({ conceptCount: 1_001, edgeCount: 5_002 }),
  delete: Object.freeze({ conceptCount: 1_000, edgeCount: 5_000 }),
});

export async function runBenchmarkReport(arguments_ = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: arguments_,
    options: {
      measurements: { type: 'string' },
      'candidate-root': { type: 'string' },
      'require-passing': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const repositoryRoot = path.resolve(
    values['candidate-root'] ?? fileURLToPath(new URL('..', import.meta.url)),
  );
  const currentInputs = await captureCurrentPerformanceInputs(repositoryRoot).catch(
    () => undefined,
  );
  const productionRuntimeSnapshot = currentInputs?.productionRuntimeSnapshot;
  const fallbackPackageManifest =
    productionRuntimeSnapshot === undefined
      ? JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'))
      : undefined;
  const currentCandidate = createCurrentCandidate(currentInputs, fallbackPackageManifest);
  const evidence =
    typeof values.measurements === 'string'
      ? JSON.parse(await readFile(values.measurements, 'utf8'))
      : undefined;
  const report = evaluateEvidence(evidence, currentCandidate);
  process.stdout.write(renderMarkdown(report));
  if (values['require-passing'] && !isPassingReport(report)) {
    process.exitCode = 2;
  }
  return report;
}

export function createCurrentCandidate(currentInputs, fallbackPackageManifest) {
  const productionRuntimeSnapshot = currentInputs?.productionRuntimeSnapshot;
  const packageManifest =
    productionRuntimeSnapshot === undefined
      ? fallbackPackageManifest
      : JSON.parse(snapshotContent(productionRuntimeSnapshot, 'package.json').toString('utf8'));
  const extensionHostBundle = snapshotContent(productionRuntimeSnapshot, 'dist/extension.cjs');
  const webviewJavaScriptBundle = snapshotContent(
    productionRuntimeSnapshot,
    'dist/webview/main.js',
  );
  const webviewCssBundle = snapshotContent(productionRuntimeSnapshot, 'dist/webview/main.css');
  const sha256 = (value) =>
    value === undefined ? undefined : createHash('sha256').update(value).digest('hex');
  return Object.freeze({
    manifestVersion: packageManifest?.version,
    graphVersion: packageManifest?.dependencies?.['3d-force-graph'],
    extensionHostBundleSha256: sha256(extensionHostBundle),
    webviewJavaScriptBundleSha256: sha256(webviewJavaScriptBundle),
    webviewCssBundleSha256: sha256(webviewCssBundle),
    productionBundleSetSha256:
      extensionHostBundle === undefined ||
      webviewJavaScriptBundle === undefined ||
      webviewCssBundle === undefined
        ? undefined
        : hashPerformanceBundleSet({
            extensionHostJavaScript: extensionHostBundle,
            webviewJavaScript: webviewJavaScriptBundle,
            webviewCss: webviewCssBundle,
          }),
    productionRuntimeSnapshotSha256: productionRuntimeSnapshot?.sha256,
    inputIdentity: currentInputs?.inputIdentity,
  });
}

export function isPassingReport(report) {
  return (
    report.qr002.status === 'pass' &&
    report.qr003.status === 'pass' &&
    report.security.status === 'pass'
  );
}

export function evaluateEvidence(value, candidate) {
  const reasons = [];
  const root = record(value);
  if (root === undefined) {
    reasons.push('No headed-editor measurement file was supplied.');
  }

  const environment = record(root?.environment);
  const environmentReasons = evaluateEnvironment(environment, candidate);
  const inputIdentity = record(root?.inputIdentity);
  const inputIdentityReasons = evaluateInputIdentity(inputIdentity, candidate);
  const security = evaluateSecurity(root?.security);
  if (root !== undefined && root.measurementKind !== 'headed-editor') {
    reasons.push('measurementKind must be exactly `headed-editor`.');
  }
  reasons.push(...environmentReasons);
  reasons.push(...inputIdentityReasons);
  reasons.push(...security.reasons);
  const authoritative =
    root?.schemaVersion === 3 &&
    root.measurementKind === 'headed-editor' &&
    isIsoDateTime(root.capturedAt) &&
    environmentReasons.length === 0 &&
    inputIdentityReasons.length === 0 &&
    security.status === 'pass';
  if (root !== undefined && root.schemaVersion !== 3) reasons.push('schemaVersion must be 3.');
  if (root !== undefined && !isIsoDateTime(root.capturedAt)) {
    reasons.push('capturedAt must be an ISO 8601 date-time with an explicit zone.');
  }

  const qr002 = evaluateQr002(record(root?.qr002), authoritative, root?.capturedAt);
  const qr003 = evaluateQr003(record(root?.qr003), authoritative, root?.capturedAt);
  return {
    authoritative,
    capturedAt: typeof root?.capturedAt === 'string' ? root.capturedAt : undefined,
    environment,
    inputIdentity,
    qr002,
    qr003,
    security,
    reasons: [...reasons, ...qr002.reasons, ...qr003.reasons],
  };
}

function evaluateInputIdentity(value, candidate) {
  const reasons = [];
  if (value === undefined) {
    return ['Evidence field inputIdentity is missing.'];
  }
  const labels = {
    productionRuntimeSnapshotSha256: 'production runtime snapshot',
    productionBuildInputSnapshotSha256: 'production build-input snapshot',
    diagnosticsObserverSnapshotSha256: 'QR-002 diagnostics-observer snapshot',
    qr003HarnessInputSnapshotSha256: 'QR-003 harness-input snapshot',
    qr003HarnessDefinitionSha256: 'QR-003 harness definition',
    qr003HarnessBundleSha256: 'QR-003 injected harness bundle',
  };
  for (const field of PERFORMANCE_INPUT_IDENTITY_FIELDS) {
    const label = labels[field] ?? field;
    if (typeof value[field] !== 'string' || !/^[a-f\d]{64}$/u.test(value[field])) {
      reasons.push(`Input identity ${label} SHA-256 is missing or malformed.`);
      continue;
    }
    const candidateHash = candidate.inputIdentity?.[field];
    if (typeof candidateHash !== 'string') {
      reasons.push(`Current ${label} identity is unavailable; restore the candidate inputs.`);
    } else if (value[field] !== candidateHash) {
      reasons.push(`Evidence ${label} SHA-256 does not match the current candidate inputs.`);
    }
  }
  return reasons;
}

function evaluateQr002(value, authoritative, evidenceCapturedAt) {
  const reasons = [];
  if (!authoritative)
    reasons.push('QR-002 lacks authoritative headed-editor environment metadata.');
  if (value?.debounceMs !== QR002_DEBOUNCE_MS) {
    reasons.push(`QR-002 debounceMs must be ${String(QR002_DEBOUNCE_MS)}.`);
  }
  const observations = Array.isArray(value?.updateSamples) ? value.updateSamples : undefined;
  if (observations === undefined || observations.length !== QR002_SAMPLE_COUNT) {
    reasons.push(`QR-002 requires exactly ${QR002_SAMPLE_COUNT} update samples.`);
  }
  const samples = [];
  let previousGraphRevision = -1;
  let previousDiagnosticsSequence = -1;
  let previousObservationEndEpochMs = -1;
  for (const [index, rawObservation] of (observations ?? []).entries()) {
    const observation = record(rawObservation);
    const prefix = `QR-002 updateSamples[${String(index)}]`;
    if (observation === undefined) {
      reasons.push(`${prefix} must be an object.`);
      continue;
    }
    const expectedEventKind = QR002_EVENT_CYCLE[index % QR002_EVENT_CYCLE.length];
    if (observation.eventKind !== expectedEventKind) {
      reasons.push(
        `${prefix}.eventKind must preserve the five create/change/rename/delete cycles emitted by the headed runner.`,
      );
    }
    const durations = [
      observation.durationMs,
      observation.graphPublicationMs,
      observation.diagnosticsPublicationMs,
    ];
    if (!durations.every(isFinitePositive)) {
      reasons.push(`${prefix} must record all three positive publication durations.`);
    } else if (
      observation.durationMs !==
      Math.max(observation.graphPublicationMs, observation.diagnosticsPublicationMs)
    ) {
      reasons.push(`${prefix}.durationMs must end after both current publications.`);
    } else if (
      observation.graphPublicationMs < QR002_DEBOUNCE_MS ||
      observation.diagnosticsPublicationMs < QR002_DEBOUNCE_MS
    ) {
      reasons.push(`${prefix} publication durations must include the 250 ms refresh debounce.`);
    } else if (observation.durationMs > QR002_SAMPLE_TIMEOUT_MS) {
      reasons.push(`${prefix}.durationMs exceeds the headed-runner sample timeout.`);
    } else {
      samples.push(observation.durationMs);
    }
    const timestamps = [
      observation.startedAtEpochMs,
      observation.mutationCompletedAtEpochMs,
      observation.graphObservedAtEpochMs,
      observation.diagnosticsObservedAtEpochMs,
    ];
    if (!timestamps.every(isPositiveEpochMilliseconds)) {
      reasons.push(`${prefix} must record four positive integer epoch-millisecond timestamps.`);
    } else {
      if (observation.startedAtEpochMs < previousObservationEndEpochMs) {
        reasons.push(`${prefix} overlaps or predates the prior serialized update sample.`);
      }
      if (
        observation.startedAtEpochMs > observation.mutationCompletedAtEpochMs ||
        observation.mutationCompletedAtEpochMs > observation.graphObservedAtEpochMs ||
        observation.mutationCompletedAtEpochMs > observation.diagnosticsObservedAtEpochMs
      ) {
        reasons.push(`${prefix} mutation/publication timestamps are not causally ordered.`);
      }
      if (
        observation.graphObservedAtEpochMs - observation.startedAtEpochMs !==
          observation.graphPublicationMs ||
        observation.diagnosticsObservedAtEpochMs - observation.startedAtEpochMs !==
          observation.diagnosticsPublicationMs
      ) {
        reasons.push(`${prefix} publication durations do not match their observer timestamps.`);
      }
      const capturedAtEpochMs = Date.parse(evidenceCapturedAt);
      if (
        Number.isFinite(capturedAtEpochMs) &&
        (observation.graphObservedAtEpochMs > capturedAtEpochMs ||
          observation.diagnosticsObservedAtEpochMs > capturedAtEpochMs)
      ) {
        reasons.push(`${prefix} publication timestamps occur after evidence capture.`);
      }
      previousObservationEndEpochMs = Math.max(
        observation.mutationCompletedAtEpochMs,
        observation.graphObservedAtEpochMs,
        observation.diagnosticsObservedAtEpochMs,
      );
    }
    if (!Number.isSafeInteger(observation.graphRevision) || observation.graphRevision < 0) {
      reasons.push(`${prefix}.graphRevision must be a non-negative safe integer.`);
    } else {
      if (observation.graphRevision <= previousGraphRevision) {
        reasons.push(`${prefix}.graphRevision must increase strictly.`);
      }
      previousGraphRevision = observation.graphRevision;
    }
    if (
      !Number.isSafeInteger(observation.diagnosticsSequence) ||
      observation.diagnosticsSequence < 0
    ) {
      reasons.push(`${prefix}.diagnosticsSequence must be a non-negative safe integer.`);
    } else {
      if (observation.diagnosticsSequence <= previousDiagnosticsSequence) {
        reasons.push(`${prefix}.diagnosticsSequence must increase strictly.`);
      }
      previousDiagnosticsSequence = observation.diagnosticsSequence;
    }
    const correlation = record(observation.diagnosticsCorrelation);
    if (
      correlation === undefined ||
      !hasExactKeys(correlation, [
        'authority',
        'conceptCount',
        'diagnosticsPublished',
        'edgeCount',
        'findingCount',
        'revision',
      ]) ||
      correlation.authority !== QR002_DIAGNOSTICS_CORRELATION_AUTHORITY ||
      correlation.diagnosticsPublished !== true ||
      !Number.isSafeInteger(correlation.revision) ||
      correlation.revision < 0 ||
      !Number.isSafeInteger(correlation.findingCount) ||
      correlation.findingCount < 1 ||
      !Number.isSafeInteger(correlation.conceptCount) ||
      correlation.conceptCount < 1 ||
      !Number.isSafeInteger(correlation.edgeCount) ||
      correlation.edgeCount < 0
    ) {
      reasons.push(`${prefix}.diagnosticsCorrelation is missing or malformed.`);
    } else if (correlation.revision !== observation.graphRevision) {
      reasons.push(
        `${prefix} must observe diagnostics and the replacement graph at the same runtime revision.`,
      );
    }
    const expectedDiagnostics = normalizeDiagnostics(observation.expectedDiagnostics);
    const observedDiagnostics = normalizeDiagnostics(observation.observedDiagnostics);
    const eventContract = QR002_EXPECTED_DIAGNOSTICS[observation.eventKind];
    const graphContract = QR002_EXPECTED_GRAPH[observation.eventKind];
    if (
      expectedDiagnostics === undefined ||
      expectedDiagnostics.length === 0 ||
      eventContract === undefined ||
      !diagnosticsEqual(expectedDiagnostics, eventContract)
    ) {
      reasons.push(
        `${prefix}.expectedDiagnostics does not match the event-specific probe contract.`,
      );
    }
    if (
      observedDiagnostics === undefined ||
      expectedDiagnostics === undefined ||
      !diagnosticsEqual(observedDiagnostics, expectedDiagnostics)
    ) {
      reasons.push(`${prefix}.observedDiagnostics must exactly match expectedDiagnostics.`);
    }
    if (
      correlation !== undefined &&
      Number.isSafeInteger(correlation.findingCount) &&
      observedDiagnostics !== undefined &&
      correlation.findingCount !== observedDiagnostics.length
    ) {
      reasons.push(
        `${prefix} diagnostics count does not match the correlated runtime publication.`,
      );
    }
    if (
      correlation !== undefined &&
      graphContract !== undefined &&
      (correlation.conceptCount !== graphContract.conceptCount ||
        correlation.edgeCount !== graphContract.edgeCount)
    ) {
      reasons.push(`${prefix} graph dimensions do not match the correlated runtime publication.`);
    }
  }
  const summary = samples.length === 0 ? undefined : summarize(samples);
  const complete =
    authoritative &&
    value?.debounceMs === QR002_DEBOUNCE_MS &&
    observations !== undefined &&
    observations.length === QR002_SAMPLE_COUNT &&
    samples.length === observations.length &&
    reasons.length === 0;
  if (!complete) {
    return { status: 'unmeasured', summary, reasons };
  }
  return {
    status: summary.p95Ms <= QR002_P95_LIMIT_MS ? 'pass' : 'fail',
    summary,
    reasons,
  };
}

function evaluateQr003(value, authoritative, evidenceCapturedAt) {
  const reasons = [];
  if (!isIsoDateTime(value?.capturedAt)) {
    reasons.push('QR-003 capturedAt must preserve the engine measurement time.');
  } else if (
    isIsoDateTime(evidenceCapturedAt) &&
    Date.parse(value.capturedAt) > Date.parse(evidenceCapturedAt)
  ) {
    reasons.push('QR-003 capturedAt cannot occur after the containing evidence capture.');
  }
  const provenance = record(value?.provenance);
  if (provenance?.kind !== 'captured') {
    reasons.push('QR-003 provenance must be captured in the current headed run.');
  }
  const fixture = record(value?.fixture);
  const fixtureMatches =
    fixture?.nodeCount === EXPECTED_FIXTURE.nodeCount &&
    fixture.edgeCount === EXPECTED_FIXTURE.edgeCount &&
    fixture.seed === EXPECTED_FIXTURE.seed;
  if (!authoritative)
    reasons.push('QR-003 lacks authoritative headed-editor environment metadata.');
  if (!fixtureMatches) {
    reasons.push(
      'QR-003 fixture must be the deterministic 1,000-node / 5,000-edge payload and seed.',
    );
  }

  const engineValues = record(value?.engines);
  const engines = Object.fromEntries(
    ENGINES.map((engine) => [engine, evaluateEngine(record(engineValues?.[engine]))]),
  );
  for (const engine of ENGINES) {
    reasons.push(...engines[engine].reasons.map((reason) => `${engine}: ${reason}`));
  }
  const comparisonComplete = ENGINES.every((engine) => engines[engine].status !== 'unmeasured');
  let selectedEngine;
  const measurementMetadataComplete =
    isIsoDateTime(value?.capturedAt) &&
    (!isIsoDateTime(evidenceCapturedAt) ||
      Date.parse(value.capturedAt) <= Date.parse(evidenceCapturedAt)) &&
    provenance?.kind === 'captured';
  if (authoritative && measurementMetadataComplete && fixtureMatches && comparisonComplete) {
    const passing = ENGINES.filter((engine) => engines[engine].status === 'pass');
    selectedEngine = passing.sort(
      (left, right) => engines[left].selectionScore - engines[right].selectionScore,
    )[0];
  }
  if (selectedEngine === undefined) {
    reasons.push('No evidence-backed release force-engine default can be selected.');
  }
  const status =
    !authoritative || !measurementMetadataComplete || !fixtureMatches || !comparisonComplete
      ? 'unmeasured'
      : selectedEngine === undefined
        ? 'fail'
        : 'pass';
  return {
    status,
    engines,
    selectedEngine,
    capturedAt: value?.capturedAt,
    provenance,
    reasons,
  };
}

function evaluateEngine(value) {
  const capturedFailure = evaluateCapturedEngineFailure(value);
  if (capturedFailure !== undefined) return capturedFailure;

  const reasons = [];
  const firstFrames = positiveDurationArray(value?.firstInteractiveFrameMs);
  const firstFrameWebglClears = positiveIntegerArray(value?.firstInteractiveFrameWebglClears);
  const firstFrameWebglDrawCalls = positiveIntegerArray(value?.firstInteractiveFrameWebglDrawCalls);
  const cooldown = positiveDurationArray(value?.cooldownMs);
  const idleFrames = nonNegativeIntegerArray(value?.idleAnimationFramesAfterCooldown);
  const interactions = record(value?.interactions);
  const interactionOutcomes = record(value?.interactionOutcomes);
  const interactionSummaries = {};

  if (firstFrames === undefined || firstFrames.length !== 1) {
    reasons.push('exactly one first-interactive-frame sample is required.');
  }
  if (
    firstFrameWebglClears === undefined ||
    firstFrameWebglClears.length !== 1 ||
    firstFrameWebglClears.length !== firstFrames?.length
  ) {
    reasons.push(
      'each first-interactive-frame sample must observe one or more graph WebGL clears.',
    );
  }
  if (
    firstFrameWebglDrawCalls === undefined ||
    firstFrameWebglDrawCalls.length !== 1 ||
    firstFrameWebglDrawCalls.length !== firstFrames?.length
  ) {
    reasons.push(
      'each first-interactive-frame sample must observe one or more graph WebGL draw calls.',
    );
  }
  if (
    typeof value?.cooldownReached !== 'boolean' ||
    cooldown === undefined ||
    cooldown.length !== 1
  ) {
    reasons.push('cooldown result and exactly one duration sample are required.');
  }
  if (idleFrames === undefined || idleFrames.length !== 1) {
    reasons.push('exactly one post-cooldown idle-animation sample is required.');
  }
  for (const interaction of INTERACTIONS) {
    const samples = positiveDurationArray(interactions?.[interaction]);
    const outcomeName = INTERACTION_OUTCOMES[interaction];
    const outcomes = trueArray(interactionOutcomes?.[outcomeName]);
    if (samples === undefined || samples.length !== QR003_INTERACTION_SAMPLE_COUNT) {
      reasons.push(`${interaction} requires exactly ${QR003_INTERACTION_SAMPLE_COUNT} samples.`);
    } else {
      interactionSummaries[interaction] = summarize(samples);
    }
    if (
      outcomes === undefined ||
      outcomes.length !== QR003_INTERACTION_SAMPLE_COUNT ||
      outcomes.length !== samples?.length
    ) {
      reasons.push(
        `${outcomeName} outcomes must prove every measured interaction changed the expected UI state.`,
      );
    }
  }
  for (const field of ['memoryPeakMb', 'idleCpuPercent']) {
    if (!isFiniteNonNegative(value?.[field])) reasons.push(`${field} must be recorded.`);
  }
  if (!isFinitePositive(value?.cameraFps)) {
    reasons.push('cameraFps must be positive.');
  }
  if (
    !Number.isSafeInteger(value?.cameraFrameCount) ||
    value.cameraFrameCount < 1 ||
    !Number.isSafeInteger(value?.cameraDrawCallCount) ||
    value.cameraDrawCallCount < value.cameraFrameCount ||
    !isFinitePositive(value?.cameraDurationMs) ||
    value.cameraDurationMs < QR003_MIN_CAMERA_DURATION_MS
  ) {
    reasons.push(
      'camera motion must record a WebGL draw for every observed clear over a meaningful duration.',
    );
  } else if (
    !isFinitePositive(value?.cameraFps) ||
    !approximatelyEqual(value.cameraFps, value.cameraFrameCount / (value.cameraDurationMs / 1_000))
  ) {
    reasons.push('cameraFps must equal cameraFrameCount divided by cameraDurationMs.');
  }
  if (
    !Number.isSafeInteger(value?.totalWebglClearCount) ||
    value.totalWebglClearCount < 1 ||
    (firstFrameWebglClears !== undefined &&
      Number.isSafeInteger(value?.cameraFrameCount) &&
      value.totalWebglClearCount <
        firstFrameWebglClears.reduce((sum, count) => sum + count, 0) + value.cameraFrameCount)
  ) {
    reasons.push('totalWebglClearCount must cover first-frame and camera rendering.');
  }
  if (
    !Number.isSafeInteger(value?.totalWebglDrawCallCount) ||
    value.totalWebglDrawCallCount < 1 ||
    (firstFrameWebglDrawCalls !== undefined &&
      Number.isSafeInteger(value?.cameraDrawCallCount) &&
      value.totalWebglDrawCallCount <
        firstFrameWebglDrawCalls.reduce((sum, count) => sum + count, 0) + value.cameraDrawCallCount)
  ) {
    reasons.push('totalWebglDrawCallCount must cover first-frame and camera graph rendering.');
  }

  const firstFrameSummary = firstFrames?.length ? summarize(firstFrames) : undefined;
  const cooldownSummary = cooldown?.length ? summarize(cooldown) : undefined;
  const complete = reasons.length === 0;
  const maxInteractionP95 = complete
    ? Math.max(...Object.values(interactionSummaries).map((summary) => summary.p95Ms))
    : Number.POSITIVE_INFINITY;
  const pass =
    complete &&
    value.cooldownReached === true &&
    firstFrameSummary.maximumMs <= QR003_FIRST_FRAME_LIMIT_MS &&
    maxInteractionP95 <= QR003_INTERACTION_P95_LIMIT_MS &&
    idleFrames.every((sample) => sample === 0);
  const selectionScore = pass
    ? firstFrameSummary.meanMs / QR003_FIRST_FRAME_LIMIT_MS +
      maxInteractionP95 / QR003_INTERACTION_P95_LIMIT_MS
    : Number.POSITIVE_INFINITY;
  return {
    status: complete ? (pass ? 'pass' : 'fail') : 'unmeasured',
    firstFrameSummary,
    cooldownSummary,
    idleFrames,
    firstFrameWebglClears,
    firstFrameWebglDrawCalls,
    interactionSummaries,
    memoryPeakMb: value?.memoryPeakMb,
    idleCpuPercent: value?.idleCpuPercent,
    cameraDurationMs: value?.cameraDurationMs,
    cameraFrameCount: value?.cameraFrameCount,
    cameraDrawCallCount: value?.cameraDrawCallCount,
    cameraFps: value?.cameraFps,
    totalWebglClearCount: value?.totalWebglClearCount,
    totalWebglDrawCallCount: value?.totalWebglDrawCallCount,
    measurementFailure: undefined,
    selectionScore,
    reasons,
  };
}

function evaluateCapturedEngineFailure(value) {
  if (value === undefined || !Object.hasOwn(value, 'measurementFailure')) return undefined;

  const reasons = [];
  if (
    !hasExactKeys(value, [
      'idleCpuPercent',
      'measurementFailure',
      'memoryPeakMb',
      'processTreePeakRssMb',
      'processTreeSampleCount',
    ])
  ) {
    reasons.push('captured engine failure must use the exact monitored top-level shape.');
  }
  const measurementFailure = record(value.measurementFailure);
  if (
    measurementFailure === undefined ||
    !hasExactKeys(measurementFailure, [
      'authority',
      'canvasPresent',
      'code',
      'edgeCount',
      'nodeCount',
      'observedClearCount',
      'observedDrawCallCount',
      'phase',
      'timeoutMs',
    ]) ||
    measurementFailure.authority !== QR003_MEASUREMENT_FAILURE_AUTHORITY ||
    measurementFailure.phase !== QR003_MEASUREMENT_FAILURE_PHASE ||
    measurementFailure.code !== QR003_MEASUREMENT_FAILURE_CODE ||
    measurementFailure.timeoutMs !== QR003_FIRST_FRAME_LIMIT_MS ||
    !Number.isSafeInteger(measurementFailure.observedClearCount) ||
    measurementFailure.observedClearCount < 0 ||
    !Number.isSafeInteger(measurementFailure.observedDrawCallCount) ||
    measurementFailure.observedDrawCallCount < 0 ||
    typeof measurementFailure.canvasPresent !== 'boolean' ||
    measurementFailure.nodeCount !== EXPECTED_FIXTURE.nodeCount ||
    measurementFailure.edgeCount !== EXPECTED_FIXTURE.edgeCount
  ) {
    reasons.push(
      'measurementFailure must be the exact headed first-interactive-frame timeout envelope.',
    );
  }
  for (const field of ['memoryPeakMb', 'idleCpuPercent']) {
    if (!isFiniteNonNegative(value[field])) {
      reasons.push(`${field} must be recorded for a captured engine failure.`);
    }
  }
  if (!isFiniteNonNegative(value.processTreePeakRssMb)) {
    reasons.push('processTreePeakRssMb must be recorded for a captured engine failure.');
  } else if (
    isFiniteNonNegative(value.memoryPeakMb) &&
    value.processTreePeakRssMb !== value.memoryPeakMb
  ) {
    reasons.push('memoryPeakMb must equal the monitored processTreePeakRssMb.');
  }
  if (!Number.isSafeInteger(value.processTreeSampleCount) || value.processTreeSampleCount < 1) {
    reasons.push('processTreeSampleCount must be a positive safe integer.');
  }

  const complete = reasons.length === 0;
  return {
    status: complete ? 'fail' : 'unmeasured',
    firstFrameSummary: undefined,
    cooldownSummary: undefined,
    idleFrames: undefined,
    firstFrameWebglClears: undefined,
    firstFrameWebglDrawCalls: undefined,
    interactionSummaries: {},
    memoryPeakMb: value.memoryPeakMb,
    idleCpuPercent: value.idleCpuPercent,
    cameraDurationMs: undefined,
    cameraFrameCount: undefined,
    cameraDrawCallCount: undefined,
    cameraFps: undefined,
    totalWebglClearCount: undefined,
    totalWebglDrawCallCount: undefined,
    measurementFailure: complete ? measurementFailure : undefined,
    selectionScore: Number.POSITIVE_INFINITY,
    reasons,
  };
}

function evaluateEnvironment(environment, candidate) {
  if (environment === undefined) {
    return [
      'Environment metadata is missing.',
      'Current-candidate package versions and production bundle SHA-256 values are not bound to evidence.',
    ];
  }
  const requiredStrings = [
    'hardware',
    'os',
    'cpu',
    'gpu',
    'editorName',
    'editorVersion',
    'editorCommit',
    'electronVersion',
    'chromiumVersion',
  ];
  const reasons = requiredStrings
    .filter((field) => typeof environment[field] !== 'string' || environment[field].trim() === '')
    .map((field) => `Environment field environment.${field} is missing.`);
  if (environment.editorName !== 'VS Code') {
    reasons.push('Headed performance evidence must be captured in VS Code.');
  }
  if (environment.editorVersion !== CURRENT_PERFORMANCE_VSCODE_VERSION) {
    reasons.push(
      `Headed performance evidence must use current pinned VS Code ${CURRENT_PERFORMANCE_VSCODE_VERSION}.`,
    );
  }
  if (!isFiniteNonNegative(environment.memoryGb)) {
    reasons.push('Environment field environment.memoryGb is missing.');
  }
  if (environment.fixtureSeed !== EXPECTED_FIXTURE.seed) {
    reasons.push('Environment fixture seed does not match the representative fixture.');
  }

  const packageVersions = record(environment.packageVersions);
  if (!isExactVersion(candidate.graphVersion)) {
    reasons.push('Current 3d-force-graph dependency must be an exact version, not a range.');
  }
  if (packageVersions === undefined) {
    reasons.push('Environment field environment.packageVersions is missing.');
  } else {
    if (packageVersions['okf-workbench'] !== candidate.manifestVersion) {
      reasons.push(
        `Evidence package version does not match current manifest version ${String(candidate.manifestVersion)}.`,
      );
    }
    if (packageVersions['3d-force-graph'] !== candidate.graphVersion) {
      reasons.push(
        `Evidence 3d-force-graph version does not match current exact dependency ${String(candidate.graphVersion)}.`,
      );
    }
  }

  compareProductionHash({
    candidate,
    candidateField: 'extensionHostBundleSha256',
    environment,
    evidenceField: 'extensionHostBundleSha256',
    label: 'Extension Host JavaScript bundle',
    reasons,
  });
  compareProductionHash({
    candidate,
    candidateField: 'webviewJavaScriptBundleSha256',
    environment,
    evidenceField: 'webviewJavaScriptBundleSha256',
    label: 'Webview JavaScript bundle',
    reasons,
  });
  compareProductionHash({
    candidate,
    candidateField: 'webviewCssBundleSha256',
    environment,
    evidenceField: 'webviewCssBundleSha256',
    label: 'Webview CSS bundle',
    reasons,
  });
  compareProductionHash({
    candidate,
    candidateField: 'productionBundleSetSha256',
    environment,
    evidenceField: 'productionBundleSetSha256',
    label: 'domain-separated production bundle set',
    reasons,
  });
  return reasons;
}

function evaluateSecurity(value) {
  const reasons = [];
  if (value === undefined) {
    return {
      status: 'unmeasured',
      webviewNetwork: undefined,
      reasons: ['Headed-Webview security observation is missing.'],
    };
  }
  const security = record(value);
  if (security === undefined) {
    return {
      status: 'fail',
      webviewNetwork: undefined,
      reasons: ['Security evidence must be an object using the exact schemaVersion 1 envelope.'],
    };
  }
  if (
    !hasExactKeys(security, ['schemaVersion', 'webviewNetwork']) ||
    security.schemaVersion !== 1
  ) {
    reasons.push('Security evidence must use the exact schemaVersion 1 envelope.');
  }
  const network = record(security.webviewNetwork);
  if (
    network === undefined ||
    !hasExactKeys(network, [
      'authority',
      'captureScope',
      'localOrigins',
      'localResourceRequestCount',
      'otherRequestCount',
      'otherSchemes',
      'remoteOrigins',
      'remoteRequestCount',
      'webviewNavigationOrigins',
      'webviewNavigationRequestCount',
    ])
  ) {
    reasons.push('Headed-Webview network observation is missing or has an unexpected shape.');
    return { status: 'fail', webviewNetwork: network, reasons };
  }
  if (network.authority !== 'headed-vscode-webview-cdp') {
    reasons.push('Headed-Webview network authority must be `headed-vscode-webview-cdp`.');
  }
  if (
    typeof network.captureScope !== 'string' ||
    network.captureScope.length === 0 ||
    network.captureScope.length > 1_000 ||
    !network.captureScope.includes('Initial Webview resources') ||
    !network.captureScope.includes('CDP events')
  ) {
    reasons.push('Headed-Webview network captureScope is missing, unbounded, or incomplete.');
  }

  const remoteOrigins = boundedUniqueSortedStrings(network.remoteOrigins, 16, 512);
  if (!Number.isSafeInteger(network.remoteRequestCount) || network.remoteRequestCount !== 0) {
    reasons.push(
      'Headed-Webview network observation must contain zero remote HTTP(S)/WS requests.',
    );
  }
  if (remoteOrigins === undefined || remoteOrigins.length !== 0) {
    reasons.push('Headed-Webview remoteOrigins must be an empty sanitized array.');
  }

  const localOrigins = boundedUniqueSortedStrings(network.localOrigins, 16, 512);
  if (
    !Number.isSafeInteger(network.localResourceRequestCount) ||
    network.localResourceRequestCount < MIN_LOCAL_RESOURCE_REQUESTS ||
    network.localResourceRequestCount > MAX_LOCAL_RESOURCE_REQUESTS
  ) {
    reasons.push(
      `Headed-Webview local packaged-resource count must be between ${String(MIN_LOCAL_RESOURCE_REQUESTS)} and ${String(MAX_LOCAL_RESOURCE_REQUESTS)}.`,
    );
  }
  if (
    localOrigins === undefined ||
    localOrigins.length === 0 ||
    !localOrigins.every(isPackagedWebviewResourceOrigin)
  ) {
    reasons.push(
      'Headed-Webview localOrigins must contain only sanitized packaged-resource origins.',
    );
  }

  const navigationOrigins = boundedUniqueSortedStrings(network.webviewNavigationOrigins, 4, 128);
  if (
    !Number.isSafeInteger(network.webviewNavigationRequestCount) ||
    network.webviewNavigationRequestCount < 1 ||
    network.webviewNavigationRequestCount > 4
  ) {
    reasons.push('Headed-Webview internal-navigation count must be between one and four.');
  }
  if (
    navigationOrigins === undefined ||
    !navigationOrigins.every(isWebviewNavigationOrigin) ||
    navigationOrigins.length === 0 ||
    navigationOrigins.length > network.webviewNavigationRequestCount
  ) {
    reasons.push(
      'Headed-Webview navigation origins must be bounded opaque VS Code Webview authorities.',
    );
  }

  const otherSchemes = boundedUniqueSortedStrings(network.otherSchemes, 16, 64);
  if (!Number.isSafeInteger(network.otherRequestCount) || network.otherRequestCount !== 0) {
    reasons.push('Headed-Webview network observation must contain zero other-scheme requests.');
  }
  if (otherSchemes === undefined || otherSchemes.length !== 0) {
    reasons.push('Headed-Webview otherSchemes must be an empty sanitized array.');
  }

  return {
    status: reasons.length === 0 ? 'pass' : 'fail',
    webviewNetwork: network,
    reasons,
  };
}

function compareProductionHash({
  candidate,
  candidateField,
  environment,
  evidenceField,
  label,
  reasons,
}) {
  const candidateHash = candidate[candidateField];
  const evidenceHash = environment[evidenceField];
  if (candidateHash === undefined) {
    reasons.push(`Current production ${label} is unavailable; run the production build first.`);
  }
  if (typeof evidenceHash !== 'string' || !/^[a-f\d]{64}$/u.test(evidenceHash)) {
    reasons.push(`Environment ${label} SHA-256 is missing or malformed.`);
  } else if (candidateHash !== undefined && evidenceHash !== candidateHash) {
    reasons.push(`Evidence ${label} SHA-256 does not match the current production build.`);
  }
}

function normalizeDiagnostics(value) {
  if (!Array.isArray(value)) return undefined;
  const normalized = [];
  const identities = new Set();
  for (const entry of value) {
    const diagnostic = record(entry);
    if (
      diagnostic === undefined ||
      !hasExactKeys(diagnostic, ['code', 'relativePath']) ||
      typeof diagnostic.relativePath !== 'string' ||
      diagnostic.relativePath.length === 0 ||
      diagnostic.relativePath.length > 4_096 ||
      diagnostic.relativePath.startsWith('/') ||
      diagnostic.relativePath.includes('\\') ||
      diagnostic.relativePath.split('/').some((segment) => segment === '' || segment === '..') ||
      typeof diagnostic.code !== 'string' ||
      !/^okf\.(?:compatibility|conformance|curation)\.[a-z\d-]+$/u.test(diagnostic.code)
    ) {
      return undefined;
    }
    const identity = `${diagnostic.relativePath}\u0000${diagnostic.code}`;
    if (identities.has(identity)) return undefined;
    identities.add(identity);
    normalized.push({
      relativePath: diagnostic.relativePath,
      code: diagnostic.code,
    });
  }
  return normalized.sort(
    (left, right) =>
      left.relativePath.localeCompare(right.relativePath) || left.code.localeCompare(right.code),
  );
}

function diagnosticsEqual(left, right) {
  const normalizedRight = normalizeDiagnostics(right);
  return (
    normalizedRight !== undefined &&
    left.length === normalizedRight.length &&
    left.every(
      (diagnostic, index) =>
        diagnostic.relativePath === normalizedRight[index]?.relativePath &&
        diagnostic.code === normalizedRight[index]?.code,
    )
  );
}

function isExactVersion(value) {
  return (
    typeof value === 'string' &&
    /^\d+\.\d+\.\d+(?:-[\dA-Za-z.-]+)?(?:\+[\dA-Za-z.-]+)?$/u.test(value)
  );
}

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const total = sorted.reduce((sum, sample) => sum + sample, 0);
  return {
    count: sorted.length,
    minimumMs: sorted[0],
    maximumMs: sorted.at(-1),
    meanMs: total / sorted.length,
    p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)],
  };
}

function positiveDurationArray(value) {
  return Array.isArray(value) && value.every(isFinitePositive) ? value : undefined;
}

function nonNegativeIntegerArray(value) {
  return Array.isArray(value) && value.every((entry) => Number.isSafeInteger(entry) && entry >= 0)
    ? value
    : undefined;
}

function positiveIntegerArray(value) {
  return Array.isArray(value) && value.every((entry) => Number.isSafeInteger(entry) && entry > 0)
    ? value
    : undefined;
}

function trueArray(value) {
  return Array.isArray(value) && value.every((entry) => entry === true) ? value : undefined;
}

function isFiniteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFinitePositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isPositiveEpochMilliseconds(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function boundedUniqueSortedStrings(value, maximumLength, maximumStringLength) {
  if (
    !Array.isArray(value) ||
    value.length > maximumLength ||
    !value.every(
      (entry) =>
        typeof entry === 'string' && entry.length > 0 && entry.length <= maximumStringLength,
    )
  ) {
    return undefined;
  }
  const uniqueSorted = [...new Set(value)].sort();
  return uniqueSorted.length === value.length &&
    uniqueSorted.every((entry, index) => entry === value[index])
    ? value
    : undefined;
}

function isPackagedWebviewResourceOrigin(value) {
  return value === 'https://file+.vscode-resource.vscode-cdn.net';
}

function isWebviewNavigationOrigin(value) {
  return /^vscode-webview:\/\/[a-z\d]{32,64}$/u.test(value);
}

function approximatelyEqual(left, right) {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= Number.EPSILON * scale * 16;
}

function snapshotContent(snapshot, relativePath) {
  return snapshot?.entries.find((entry) => entry.relativePath === relativePath)?.content;
}

function stringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined;
}

function isIsoDateTime(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function renderMarkdown(report) {
  const lines = [
    '# OKF Workbench performance evidence report',
    '',
    `Generated: ${report.capturedAt ?? 'unmeasured'}`,
    '',
    '> This report treats only a complete `headed-editor` measurement as QR-002/QR-003 evidence. Node and Playwright harness results are non-authoritative.',
    '',
    '## Result',
    '',
    '| Target | Status | Evidence |',
    '| --- | --- | --- |',
    `| QR-002 | ${report.qr002.status} | ${summaryCell(report.qr002.summary, 'p95')} |`,
    `| QR-003 | ${report.qr003.status} | Release engine: ${cell(report.qr003.selectedEngine ?? 'not selected')} |`,
    `| Headed Webview network | ${report.security.status} | CDP observation of packaged resources and outbound schemes |`,
    '',
    report.qr003.selectedEngine === undefined
      ? 'The runtime adapter fallback is `d3` while release selection remains unmeasured. A passing report selects the measured candidate; it does not silently rewrite source.'
      : `The evidence-backed release force-engine selection is \`${report.qr003.selectedEngine}\`. The report records this result but does not silently rewrite source.`,
    '',
    `QR-003 measurement: ${cell(report.qr003.capturedAt ?? 'unmeasured')}; provenance: ${cell(provenanceCell(report.qr003.provenance))}.`,
    '',
    '## Headed-editor environment',
    '',
    '| Field | Value |',
    '| --- | --- |',
    ...environmentRows(report),
    '',
    '## Force-engine comparison',
    '',
    '| Engine | Status | First frame | Cooldown | Search p95 | Filter p95 | Selection p95 | Navigation p95 | Idle frames |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...ENGINES.map((engine) => engineRow(engine, report.qr003.engines[engine])),
    '',
    '## Webview network observation',
    '',
    ...networkObservationRows(report.security),
    '',
    '## Missing or blocking evidence',
    '',
    ...(report.reasons.length === 0
      ? ['- None.']
      : [...new Set(report.reasons)].map((reason) => `- ${reason}`)),
  ];
  return `${lines.join('\n')}\n`;
}

function networkObservationRows(security) {
  const network = record(security?.webviewNetwork);
  if (network === undefined) {
    return ['No headed-Webview CDP network observation was supplied.'];
  }
  return [
    '| Class | Count | Sanitized origins/schemes |',
    '| --- | ---: | --- |',
    `| Remote HTTP(S)/WS | ${cell(network.remoteRequestCount ?? 'unmeasured')} | ${cell(stringArray(network.remoteOrigins)?.join(', ') || 'none')} |`,
    `| Local packaged resources | ${cell(network.localResourceRequestCount ?? 'unmeasured')} | ${cell(stringArray(network.localOrigins)?.join(', ') || 'none')} |`,
    `| Internal Webview navigation | ${cell(network.webviewNavigationRequestCount ?? 'unmeasured')} | ${cell(stringArray(network.webviewNavigationOrigins)?.join(', ') || 'none')} |`,
    `| Other schemes | ${cell(network.otherRequestCount ?? 'unmeasured')} | ${cell(stringArray(network.otherSchemes)?.join(', ') || 'none')} |`,
    '',
    cell(network.captureScope ?? 'Capture scope was not recorded.'),
  ];
}

function environmentRows(report) {
  const environment = report.environment ?? {};
  return [
    ['Captured at', report.capturedAt],
    ['Hardware', environment.hardware],
    ['OS', environment.os],
    ['CPU', environment.cpu],
    ['Memory (GiB)', environment.memoryGb],
    ['GPU', environment.gpu],
    ['Editor', joinValues(environment.editorName, environment.editorVersion)],
    ['Editor commit', environment.editorCommit],
    ['Electron', environment.electronVersion],
    ['Chromium', environment.chromiumVersion],
    ['Fixture seed', environment.fixtureSeed],
    [
      'Package versions',
      record(environment.packageVersions) === undefined
        ? undefined
        : JSON.stringify(environment.packageVersions),
    ],
    ['Extension Host JavaScript SHA-256', environment.extensionHostBundleSha256],
    ['Webview JavaScript SHA-256', environment.webviewJavaScriptBundleSha256],
    ['Webview CSS SHA-256', environment.webviewCssBundleSha256],
    ['Domain-separated production bundle-set SHA-256', environment.productionBundleSetSha256],
    [
      'Full production runtime snapshot SHA-256',
      report.inputIdentity?.productionRuntimeSnapshotSha256,
    ],
    [
      'Production build-input snapshot SHA-256',
      report.inputIdentity?.productionBuildInputSnapshotSha256,
    ],
    [
      'QR-002 diagnostics-observer snapshot SHA-256',
      report.inputIdentity?.diagnosticsObserverSnapshotSha256,
    ],
    [
      'QR-003 harness-input snapshot SHA-256',
      report.inputIdentity?.qr003HarnessInputSnapshotSha256,
    ],
    ['QR-003 harness definition SHA-256', report.inputIdentity?.qr003HarnessDefinitionSha256],
    ['QR-003 injected harness bundle SHA-256', report.inputIdentity?.qr003HarnessBundleSha256],
  ].map(([field, value]) => `| ${cell(field)} | ${cell(value ?? 'unmeasured')} |`);
}

function provenanceCell(value) {
  const provenance = record(value);
  if (provenance?.kind === 'captured') return 'captured in this run';
  return 'unmeasured';
}

function engineRow(engine, result) {
  const interactions = result.interactionSummaries;
  const firstFrame =
    result.measurementFailure === undefined
      ? summaryCell(result.firstFrameSummary, 'max')
      : measurementFailureCell(result.measurementFailure);
  return `| ${engine} | ${result.status} | ${firstFrame} | ${summaryCell(result.cooldownSummary, 'mean')} | ${durationCell(interactions.searchMs?.p95Ms)} | ${durationCell(interactions.filterMs?.p95Ms)} | ${durationCell(interactions.selectionMs?.p95Ms)} | ${durationCell(interactions.navigationMs?.p95Ms)} | ${cell(result.idleFrames?.join(', ') ?? 'unmeasured')} |`;
}

function measurementFailureCell(value) {
  return cell(
    `captured ${String(value.code)} after ${String(value.timeoutMs)} ms; ${String(value.observedClearCount)} clears, ${String(value.observedDrawCallCount)} draws, canvas ${value.canvasPresent ? 'present' : 'absent'}`,
  );
}

function summaryCell(summary, statistic) {
  if (summary === undefined) return 'unmeasured';
  return statistic === 'p95'
    ? `${durationCell(summary.p95Ms)} (${String(summary.count)} samples)`
    : statistic === 'max'
      ? `${durationCell(summary.maximumMs)} max`
      : `${durationCell(summary.meanMs)} mean`;
}

function durationCell(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value.toFixed(2)} ms`
    : 'unmeasured';
}

function joinValues(...values) {
  const present = values.filter((value) => typeof value === 'string' && value.trim() !== '');
  return present.length === 0 ? undefined : present.join(' ');
}

function cell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll(/\r?\n/gu, ' ');
}

if (await isMainModule()) {
  await runBenchmarkReport();
}

async function isMainModule() {
  if (process.argv[1] === undefined) return false;
  const [invokedPath, modulePath] = await Promise.all([
    realpath(path.resolve(process.argv[1])),
    realpath(fileURLToPath(import.meta.url)),
  ]);
  return comparablePath(invokedPath) === comparablePath(modulePath);
}

function comparablePath(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}
