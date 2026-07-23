import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';

const PERFORMANCE_OUTPUT_DIRECTORY = 'artifacts/performance';

export async function withPerformanceDeadline(operation, timeoutMs, label) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Performance deadline must be a positive finite duration.');
  }
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} exceeded its ${String(timeoutMs)} ms deadline.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve(operation), expired]);
  } finally {
    clearTimeout(timer);
  }
}

export async function publishPerformanceEvidence({
  repositoryRoot,
  outputPath,
  evidenceBytes,
  reportBytes,
  verify,
}) {
  const targets = await preparePublicationTargets(repositoryRoot, outputPath);
  const token = randomUUID();
  const stagedOutputPath = `${targets.outputPath}.${token}.tmp`;
  const stagedReportPath = `${targets.reportPath}.${token}.tmp`;
  const backupOutputPath = `${targets.outputPath}.${token}.bak`;
  const backupReportPath = `${targets.reportPath}.${token}.bak`;
  const expectedEvidence = Buffer.from(evidenceBytes);
  const expectedReport = Buffer.from(reportBytes);
  let outputBackedUp = false;
  let reportBackedUp = false;
  let outputPublished = false;
  let reportPublished = false;
  let committed = false;

  try {
    await Promise.all([
      writeFile(stagedOutputPath, expectedEvidence, { flag: 'wx', mode: 0o600 }),
      writeFile(stagedReportPath, expectedReport, { flag: 'wx', mode: 0o600 }),
    ]);
    await Promise.all([
      assertFileBytes(stagedOutputPath, expectedEvidence, 'Staged performance evidence'),
      assertFileBytes(stagedReportPath, expectedReport, 'Staged performance report'),
    ]);
    await assertPublicationDirectoryUnchanged(targets);
    outputBackedUp = await backUpExistingRegularFile(targets.outputPath, backupOutputPath);
    reportBackedUp = await backUpExistingRegularFile(targets.reportPath, backupReportPath);
    await rename(stagedOutputPath, targets.outputPath);
    outputPublished = true;
    await rename(stagedReportPath, targets.reportPath);
    reportPublished = true;
    await Promise.all([
      assertFileBytes(targets.outputPath, expectedEvidence, 'Published performance evidence'),
      assertFileBytes(targets.reportPath, expectedReport, 'Published performance report'),
    ]);
    await verify?.();
    await assertPublicationDirectoryUnchanged(targets);
    await Promise.all([
      assertFileBytes(targets.outputPath, expectedEvidence, 'Published performance evidence'),
      assertFileBytes(targets.reportPath, expectedReport, 'Published performance report'),
    ]);
    committed = true;
    return Object.freeze({ outputPath: targets.outputPath, reportPath: targets.reportPath });
  } catch (error) {
    const rollbackFailures = [];
    await rollbackPublishedFile({
      backupPath: backupOutputPath,
      backedUp: outputBackedUp,
      published: outputPublished,
      rollbackFailures,
      targetPath: targets.outputPath,
    });
    await rollbackPublishedFile({
      backupPath: backupReportPath,
      backedUp: reportBackedUp,
      published: reportPublished,
      rollbackFailures,
      targetPath: targets.reportPath,
    });
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [error, ...rollbackFailures],
        'Performance evidence publication failed and could not be fully rolled back.',
      );
    }
    throw error;
  } finally {
    await Promise.allSettled([
      rm(stagedOutputPath, { force: true }),
      rm(stagedReportPath, { force: true }),
      committed && outputBackedUp ? rm(backupOutputPath, { force: true }) : undefined,
      committed && reportBackedUp ? rm(backupReportPath, { force: true }) : undefined,
    ]);
  }
}

async function preparePublicationTargets(repositoryRoot, requestedOutputPath) {
  const absoluteRepositoryRoot = path.resolve(repositoryRoot);
  await assertDirectory(absoluteRepositoryRoot);
  const outputDirectory = path.join(
    absoluteRepositoryRoot,
    ...PERFORMANCE_OUTPUT_DIRECTORY.split('/'),
  );
  const outputPath = path.resolve(requestedOutputPath);
  const relativeOutput = path.relative(outputDirectory, outputPath);
  if (
    relativeOutput === '' ||
    relativeOutput.startsWith('..') ||
    path.isAbsolute(relativeOutput) ||
    path.extname(outputPath) !== '.json'
  ) {
    throw new Error(
      `Performance evidence output must be a .json file inside ${PERFORMANCE_OUTPUT_DIRECTORY}.`,
    );
  }
  const reportPath = outputPath.slice(0, -'.json'.length) + '.md';
  await ensureNonSymbolicDirectory(absoluteRepositoryRoot, path.dirname(outputPath));
  const targets = Object.freeze({
    outputPath,
    parentRealPath: await realpath(path.dirname(outputPath)),
    reportPath,
  });
  await assertPublicationDirectoryUnchanged(targets);
  await Promise.all([
    assertMissingOrRegularFile(outputPath),
    assertMissingOrRegularFile(reportPath),
  ]);
  return targets;
}

async function ensureNonSymbolicDirectory(repositoryRoot, destination) {
  const relative = path.relative(repositoryRoot, destination);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Performance evidence output directory escapes the repository.');
  }
  let current = repositoryRoot;
  await assertDirectory(current);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    await assertDirectory(current);
  }
}

async function assertPublicationDirectoryUnchanged(targets) {
  const current = await realpath(path.dirname(targets.outputPath));
  if (current !== targets.parentRealPath) {
    throw new Error('Performance evidence output directory changed during publication.');
  }
  await assertDirectory(path.dirname(targets.outputPath));
}

async function assertDirectory(candidate) {
  const status = await lstat(candidate);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(
      `Performance evidence output ancestor must be a non-symbolic directory: ${candidate}.`,
    );
  }
}

async function assertMissingOrRegularFile(candidate) {
  try {
    const status = await lstat(candidate);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error(
        `Performance evidence output target must be a regular, non-symbolic file when it exists: ${candidate}.`,
      );
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function backUpExistingRegularFile(targetPath, backupPath) {
  try {
    await assertMissingOrRegularFile(targetPath);
    await rename(targetPath, backupPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function assertFileBytes(candidate, expected, label) {
  const [status, actual] = await Promise.all([lstat(candidate), readFile(candidate)]);
  if (!status.isFile() || status.isSymbolicLink() || !actual.equals(expected)) {
    throw new Error(`${label} bytes do not match the authorized publication.`);
  }
}

async function rollbackPublishedFile({
  backupPath,
  backedUp,
  published,
  rollbackFailures,
  targetPath,
}) {
  try {
    if (published) await rm(targetPath, { force: true });
    if (backedUp) await rename(backupPath, targetPath);
  } catch (error) {
    rollbackFailures.push(error);
  }
}
