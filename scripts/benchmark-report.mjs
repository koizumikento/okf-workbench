import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import process from 'node:process';
import { URL } from 'node:url';
import { parseArgs } from 'node:util';

const QR002_SAMPLE_COUNT = 20;
const QR002_P95_LIMIT_MS = 1_000;
const QR003_FIRST_FRAME_LIMIT_MS = 5_000;
const QR003_INTERACTION_SAMPLE_COUNT = 20;
const QR003_INTERACTION_P95_LIMIT_MS = 100;
const EXPECTED_FIXTURE = { nodeCount: 1_000, edgeCount: 5_000, seed: 0x004f_4b46 };
const ENGINES = ['d3', 'ngraph'];
const INTERACTIONS = ['searchMs', 'filterMs', 'selectionMs', 'navigationMs'];

const { values } = parseArgs({
  options: {
    measurements: { type: 'string' },
    'require-passing': { type: 'boolean', default: false },
  },
  strict: true,
});

const packageManifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
const extensionBundle = await readFile(new URL('../dist/extension.cjs', import.meta.url)).catch(
  () => undefined,
);
const webviewBundle = await readFile(new URL('../dist/webview/main.js', import.meta.url)).catch(
  () => undefined,
);
const currentCandidate = {
  manifestVersion: packageManifest.version,
  graphVersion: packageManifest.dependencies?.['3d-force-graph'],
  extensionBundleSha256:
    extensionBundle === undefined || webviewBundle === undefined
      ? undefined
      : createHash('sha256').update(extensionBundle).update(webviewBundle).digest('hex'),
  webviewBundleSha256:
    webviewBundle === undefined
      ? undefined
      : createHash('sha256').update(webviewBundle).digest('hex'),
};
const evidence =
  typeof values.measurements === 'string'
    ? JSON.parse(await readFile(values.measurements, 'utf8'))
    : undefined;
const report = evaluateEvidence(evidence, currentCandidate);
process.stdout.write(renderMarkdown(report, packageManifest));

if (
  values['require-passing'] &&
  (report.qr002.status !== 'pass' || report.qr003.status !== 'pass')
) {
  process.exitCode = 2;
}

function evaluateEvidence(value, candidate) {
  const reasons = [];
  const root = record(value);
  if (root === undefined) {
    reasons.push('No headed-editor measurement file was supplied.');
  }

  const environment = record(root?.environment);
  const environmentReasons = evaluateEnvironment(environment, candidate);
  if (root !== undefined && root.measurementKind !== 'headed-editor') {
    reasons.push('measurementKind must be exactly `headed-editor`.');
  }
  reasons.push(...environmentReasons);
  const authoritative =
    root?.schemaVersion === 2 &&
    root.measurementKind === 'headed-editor' &&
    isIsoDateTime(root.capturedAt) &&
    environmentReasons.length === 0;
  if (root !== undefined && root.schemaVersion !== 2) reasons.push('schemaVersion must be 2.');
  if (root !== undefined && !isIsoDateTime(root.capturedAt)) {
    reasons.push('capturedAt must be an ISO 8601 date-time with an explicit zone.');
  }

  const qr002 = evaluateQr002(record(root?.qr002), authoritative);
  const qr003 = evaluateQr003(record(root?.qr003), authoritative);
  return {
    authoritative,
    capturedAt: typeof root?.capturedAt === 'string' ? root.capturedAt : undefined,
    environment,
    qr002,
    qr003,
    security: record(root?.security),
    reasons: [...reasons, ...qr002.reasons, ...qr003.reasons],
  };
}

function evaluateQr002(value, authoritative) {
  const reasons = [];
  if (!authoritative)
    reasons.push('QR-002 lacks authoritative headed-editor environment metadata.');
  if (value?.debounceMs !== 250) reasons.push('QR-002 debounceMs must be 250.');
  const observations = Array.isArray(value?.updateSamples) ? value.updateSamples : undefined;
  if (observations === undefined || observations.length < QR002_SAMPLE_COUNT) {
    reasons.push(`QR-002 requires at least ${QR002_SAMPLE_COUNT} update samples.`);
  }
  const samples = [];
  const eventKinds = new Set();
  let previousGraphRevision = -1;
  let previousDiagnosticsSequence = -1;
  for (const [index, rawObservation] of (observations ?? []).entries()) {
    const observation = record(rawObservation);
    const prefix = `QR-002 updateSamples[${String(index)}]`;
    if (observation === undefined) {
      reasons.push(`${prefix} must be an object.`);
      continue;
    }
    if (!['create', 'change', 'rename', 'delete'].includes(observation.eventKind)) {
      reasons.push(`${prefix}.eventKind must be create, change, rename, or delete.`);
    } else {
      eventKinds.add(observation.eventKind);
    }
    const durations = [
      observation.durationMs,
      observation.graphPublicationMs,
      observation.diagnosticsPublicationMs,
    ];
    if (!durations.every(isFiniteNonNegative)) {
      reasons.push(`${prefix} must record all three non-negative publication durations.`);
    } else if (
      observation.durationMs !==
      Math.max(observation.graphPublicationMs, observation.diagnosticsPublicationMs)
    ) {
      reasons.push(`${prefix}.durationMs must end after both current publications.`);
    } else {
      samples.push(observation.durationMs);
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
    if (observation.diagnosticsCorrelatedRevision !== observation.graphRevision) {
      reasons.push(
        `${prefix} must correlate current diagnostics to its replacement graph revision.`,
      );
    }
    if (!validExpectedDiagnostics(observation.expectedDiagnostics)) {
      reasons.push(`${prefix}.expectedDiagnostics must contain bundle-relative path/code pairs.`);
    }
  }
  for (const eventKind of ['create', 'change', 'rename', 'delete']) {
    if (!eventKinds.has(eventKind)) reasons.push(`QR-002 has no ${eventKind} event sample.`);
  }
  const summary = samples.length === 0 ? undefined : summarize(samples);
  const complete =
    authoritative &&
    value?.debounceMs === 250 &&
    observations !== undefined &&
    observations.length >= QR002_SAMPLE_COUNT &&
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

function evaluateQr003(value, authoritative) {
  const reasons = [];
  if (!isIsoDateTime(value?.capturedAt)) {
    reasons.push('QR-003 capturedAt must preserve the engine measurement time.');
  }
  const provenance = record(value?.provenance);
  if (
    provenance?.kind !== 'captured' &&
    !(
      provenance?.kind === 'reused' &&
      typeof provenance.sourceMeasurementSha256 === 'string' &&
      /^[a-f\d]{64}$/u.test(provenance.sourceMeasurementSha256)
    )
  ) {
    reasons.push(
      'QR-003 provenance must be captured, or reused with a source measurement SHA-256.',
    );
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
    (provenance?.kind === 'captured' ||
      (provenance?.kind === 'reused' &&
        typeof provenance.sourceMeasurementSha256 === 'string' &&
        /^[a-f\d]{64}$/u.test(provenance.sourceMeasurementSha256)));
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
  const reasons = [];
  const firstFrames = durationArray(value?.firstInteractiveFrameMs);
  const cooldown = durationArray(value?.cooldownMs);
  const idleFrames = nonNegativeIntegerArray(value?.idleAnimationFramesAfterCooldown);
  const interactions = record(value?.interactions);
  const interactionSummaries = {};

  if (firstFrames === undefined || firstFrames.length === 0) {
    reasons.push('at least one first-interactive-frame sample is required.');
  }
  if (
    typeof value?.cooldownReached !== 'boolean' ||
    cooldown === undefined ||
    cooldown.length === 0
  ) {
    reasons.push('cooldown result and at least one duration sample are required.');
  }
  if (idleFrames === undefined || idleFrames.length === 0) {
    reasons.push('post-cooldown idle-animation samples are required.');
  }
  for (const interaction of INTERACTIONS) {
    const samples = durationArray(interactions?.[interaction]);
    if (samples === undefined || samples.length < QR003_INTERACTION_SAMPLE_COUNT) {
      reasons.push(`${interaction} requires at least ${QR003_INTERACTION_SAMPLE_COUNT} samples.`);
    } else {
      interactionSummaries[interaction] = summarize(samples);
    }
  }
  for (const field of ['memoryPeakMb', 'idleCpuPercent', 'cameraFps']) {
    if (!isFiniteNonNegative(value?.[field])) reasons.push(`${field} must be recorded.`);
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
    interactionSummaries,
    memoryPeakMb: value?.memoryPeakMb,
    idleCpuPercent: value?.idleCpuPercent,
    cameraFps: value?.cameraFps,
    selectionScore,
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

  if (candidate.webviewBundleSha256 === undefined) {
    reasons.push(
      'Current production Webview bundle is unavailable; run the production build first.',
    );
  }
  if (
    typeof environment.webviewBundleSha256 !== 'string' ||
    !/^[a-f\d]{64}$/u.test(environment.webviewBundleSha256)
  ) {
    reasons.push('Environment Webview bundle SHA-256 is missing or malformed.');
  } else if (
    candidate.webviewBundleSha256 !== undefined &&
    environment.webviewBundleSha256 !== candidate.webviewBundleSha256
  ) {
    reasons.push('Evidence Webview bundle SHA-256 does not match the current production bundle.');
  }
  if (candidate.extensionBundleSha256 === undefined) {
    reasons.push(
      'Current production extension bundle is unavailable; run the production build first.',
    );
  }
  if (
    typeof environment.extensionBundleSha256 !== 'string' ||
    !/^[a-f\d]{64}$/u.test(environment.extensionBundleSha256)
  ) {
    reasons.push('Environment extension bundle SHA-256 is missing or malformed.');
  } else if (
    candidate.extensionBundleSha256 !== undefined &&
    environment.extensionBundleSha256 !== candidate.extensionBundleSha256
  ) {
    reasons.push('Evidence extension bundle SHA-256 does not match the current production build.');
  }
  return reasons;
}

function validExpectedDiagnostics(value) {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      const diagnostic = record(entry);
      return (
        diagnostic !== undefined &&
        typeof diagnostic.relativePath === 'string' &&
        diagnostic.relativePath.length > 0 &&
        !diagnostic.relativePath.startsWith('/') &&
        !diagnostic.relativePath.includes('\\') &&
        !diagnostic.relativePath.split('/').includes('..') &&
        typeof diagnostic.code === 'string' &&
        diagnostic.code.length > 0
      );
    })
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

function durationArray(value) {
  return Array.isArray(value) && value.every(isFiniteNonNegative) ? value : undefined;
}

function nonNegativeIntegerArray(value) {
  return Array.isArray(value) && value.every((entry) => Number.isSafeInteger(entry) && entry >= 0)
    ? value
    : undefined;
}

function isFiniteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
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

function renderMarkdown(report, manifest) {
  const localCpu = os.cpus()[0]?.model ?? 'unavailable';
  const lines = [
    '# OKF Workbench performance evidence report',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '> This report treats only a complete `headed-editor` measurement as QR-002/QR-003 evidence. Node and Playwright harness results are non-authoritative.',
    '',
    '## Result',
    '',
    '| Target | Status | Evidence |',
    '| --- | --- | --- |',
    `| QR-002 | ${report.qr002.status} | ${summaryCell(report.qr002.summary, 'p95')} |`,
    `| QR-003 | ${report.qr003.status} | Release engine: ${cell(report.qr003.selectedEngine ?? 'not selected')} |`,
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
    '',
    '## Report-generator host (not performance evidence)',
    '',
    `- OS: ${cell(`${os.platform()} ${os.release()} ${os.arch()}`)}`,
    `- CPU: ${cell(`${localCpu}; ${String(os.cpus().length)} logical processors`)}`,
    `- Memory: ${cell(`${(os.totalmem() / 1024 ** 3).toFixed(1)} GiB`)}`,
    `- Node: ${cell(process.version)}`,
    `- Package: ${cell(`${manifest.name}@${manifest.version}`)}`,
    `- 3d-force-graph: ${cell(manifest.dependencies?.['3d-force-graph'] ?? 'unavailable')}`,
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function networkObservationRows(security) {
  const network = record(record(security)?.webviewNetwork);
  if (network === undefined) {
    return ['No headed-Webview CDP network observation was supplied.'];
  }
  return [
    '| Class | Count | Sanitized origins/schemes |',
    '| --- | ---: | --- |',
    `| Remote HTTP(S)/WS | ${cell(network.remoteRequestCount ?? 'unmeasured')} | ${cell(stringArray(network.remoteOrigins)?.join(', ') || 'none')} |`,
    `| Local packaged resources | ${cell(network.localResourceRequestCount ?? 'unmeasured')} | ${cell(stringArray(network.localOrigins)?.join(', ') || 'none')} |`,
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
    ['Production Webview bundle SHA-256', environment.webviewBundleSha256],
    ['Production extension + Webview SHA-256', environment.extensionBundleSha256],
  ].map(([field, value]) => `| ${cell(field)} | ${cell(value ?? 'unmeasured')} |`);
}

function provenanceCell(value) {
  const provenance = record(value);
  if (provenance?.kind === 'captured') return 'captured in this run';
  if (provenance?.kind === 'reused') {
    return `reused from ${String(provenance.sourceMeasurementSha256 ?? 'unknown source')}`;
  }
  return 'unmeasured';
}

function engineRow(engine, result) {
  const interactions = result.interactionSummaries;
  return `| ${engine} | ${result.status} | ${summaryCell(result.firstFrameSummary, 'max')} | ${summaryCell(result.cooldownSummary, 'mean')} | ${durationCell(interactions.searchMs?.p95Ms)} | ${durationCell(interactions.filterMs?.p95Ms)} | ${durationCell(interactions.selectionMs?.p95Ms)} | ${durationCell(interactions.navigationMs?.p95Ms)} | ${cell(result.idleFrames?.join(', ') ?? 'unmeasured')} |`;
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
