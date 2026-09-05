import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { CANONICAL_WASM_PATH, CANONICAL_WASM_METADATA_PATH } from './canonical-wasm.mjs';

import {
  assertInputSnapshotUnchanged,
  captureStableInputSnapshot,
  materializeInputSnapshot,
} from './performance-input-snapshot.mjs';
import {
  assertAuthorizedPortableEsbuildSnapshot,
  captureAuthorizedEsbuildPlatformSnapshot,
  discoverPortablePerformanceToolchainDirectories,
  HEADED_EXECUTION_SOURCE_PATHS,
  PERFORMANCE_TOOLCHAIN_MANIFEST_PATH,
} from './performance-toolchain.mjs';

export const PERFORMANCE_INPUT_IDENTITY_FIELDS = Object.freeze([
  'productionRuntimeSnapshotSha256',
  'productionBuildInputSnapshotSha256',
  'diagnosticsObserverSnapshotSha256',
  'qr003HarnessInputSnapshotSha256',
  'qr003HarnessDefinitionSha256',
  'qr003HarnessBundleSha256',
]);
export const CURRENT_PERFORMANCE_VSCODE_VERSION = '1.129.1';

export const HEADED_HARNESS_BUILD_CONFIGURATION_PATH = 'test/benchmarks/headed-harness-build.json';
export const DIAGNOSTICS_OBSERVER_PATH = 'test/benchmarks/diagnostics-observer';
const PRODUCTION_SOURCE_DIRECTORY = 'src';
const PRODUCTION_RUST_SOURCE_DIRECTORY = 'crates';
const PLATFORM_NATIVE_ESBUILD_SHIM_PATH = 'node_modules/esbuild/bin/esbuild';
const PRODUCTION_RUNTIME_STATIC_PATHS = Object.freeze([
  'package.json',
  'assets/icon.png',
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain.toml',
]);
const HEADED_HARNESS_STATIC_PATHS = Object.freeze([
  HEADED_HARNESS_BUILD_CONFIGURATION_PATH,
  'test/benchmarks/headed-animation-frame-deadline.mjs',
  'test/benchmarks/graph-fixtures.ts',
  'test/benchmarks/headed-harness-entry.mjs',
]);
const performanceExecutionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let authorizedEsbuildModule;

export async function captureProductionRuntimeSnapshot(repositoryRoot) {
  return captureStableInputSnapshot(
    repositoryRoot,
    { files: ['package.json', 'assets/icon.png'], directories: ['dist'] },
    'Production extension runtime',
  );
}

export async function captureProductionBuildInputSnapshot(repositoryRoot) {
  const metadataRelativePath = 'artifacts/build-metadata.json';
  const metadata = JSON.parse(
    await readFile(resolveRepositoryPath(repositoryRoot, metadataRelativePath), 'utf8'),
  );
  const discoveredInputs = productionBuildInputPaths(repositoryRoot, metadata);
  const toolchainDirectories =
    await discoverPortablePerformanceToolchainDirectories(repositoryRoot);
  const directories = pruneDirectoryRoots([
    PRODUCTION_SOURCE_DIRECTORY,
    PRODUCTION_RUST_SOURCE_DIRECTORY,
    ...toolchainDirectories,
  ]);
  const files = filesOutsideDirectories(
    withResolverManifests([
      ...discoveredInputs,
      ...PRODUCTION_RUNTIME_STATIC_PATHS,
      ...(metadata.core?.source === 'canonical-ci-artifact'
        ? [CANONICAL_WASM_PATH, CANONICAL_WASM_METADATA_PATH]
        : []),
      metadataRelativePath,
      ...HEADED_EXECUTION_SOURCE_PATHS,
      ...HEADED_HARNESS_STATIC_PATHS,
    ]),
    directories,
  );
  const snapshot = await captureStableInputSnapshot(
    repositoryRoot,
    {
      files,
      directories,
      excludedFiles: [PLATFORM_NATIVE_ESBUILD_SHIM_PATH],
    },
    'Production build inputs',
  );
  const capturedMetadata = JSON.parse(
    snapshotEntry(snapshot, metadataRelativePath).content.toString(),
  );
  if (!samePaths(discoveredInputs, productionBuildInputPaths(repositoryRoot, capturedMetadata))) {
    throw new Error('Production build metadata changed while its input inventory was captured.');
  }
  assertDiscoveredInputsCaptured(discoveredInputs, snapshot, 'Production build');
  assertAuthorizedPortableEsbuildSnapshot(snapshot);
  return snapshot;
}

export async function assertProductionBuildInputSnapshotUnchanged(
  snapshot,
  repositoryRoot = snapshot.root,
  label = 'Production build inputs',
) {
  await assertInputSnapshotUnchanged(snapshot, repositoryRoot, label);
  const capturedMetadata = JSON.parse(
    snapshotEntry(snapshot, 'artifacts/build-metadata.json').content.toString(),
  );
  const currentMetadata = JSON.parse(
    await readFile(resolveRepositoryPath(repositoryRoot, 'artifacts/build-metadata.json'), 'utf8'),
  );
  const expectedInputs = productionBuildInputPaths(snapshot.root, capturedMetadata);
  const currentInputs = productionBuildInputPaths(repositoryRoot, currentMetadata);
  if (!samePaths(expectedInputs, currentInputs)) {
    throw new Error(`${label} changed after capture: production input inventory mismatch.`);
  }
  assertDiscoveredInputsCaptured(currentInputs, snapshot, label);
}

export async function captureDiagnosticsObserverSnapshot(repositoryRoot) {
  return captureStableInputSnapshot(
    resolveRepositoryPath(repositoryRoot, DIAGNOSTICS_OBSERVER_PATH),
    { directories: ['.'] },
    'QR-002 diagnostics observer',
  );
}

export async function captureHeadedHarness(repositoryRoot, materializationRoot) {
  const configuration = await readHeadedHarnessConfiguration(repositoryRoot);
  const esbuildPlatformSnapshot = await captureAuthorizedEsbuildPlatformSnapshot(repositoryRoot);
  const discovery = await buildHeadedHarness(repositoryRoot, configuration);
  const directories = pruneDirectoryRoots([PRODUCTION_SOURCE_DIRECTORY, 'node_modules/esbuild']);
  const files = filesOutsideDirectories(
    withResolverManifests([
      ...discovery.inputPaths,
      'package.json',
      'package-lock.json',
      ...HEADED_HARNESS_STATIC_PATHS,
      'scripts/performance-evidence-inputs.mjs',
      'scripts/performance-input-snapshot.mjs',
      'scripts/performance-toolchain.mjs',
      PERFORMANCE_TOOLCHAIN_MANIFEST_PATH,
    ]),
    directories,
  );
  const inputSnapshot = await captureStableInputSnapshot(
    repositoryRoot,
    {
      files,
      directories,
      excludedFiles: [PLATFORM_NATIVE_ESBUILD_SHIM_PATH],
    },
    'QR-003 harness inputs',
  );
  assertDiscoveredInputsCaptured(discovery.inputPaths, inputSnapshot, 'QR-003 harness');
  assertAuthorizedPortableEsbuildSnapshot(inputSnapshot);
  const ownsMaterialization = materializationRoot === undefined;
  const privateRoot =
    materializationRoot ?? (await mkdtemp(path.join(os.tmpdir(), 'okf-headed-harness-inputs-')));
  try {
    const measured = await buildHeadedHarnessFromCapturedInputs(
      {
        discoveredInputPaths: discovery.inputPaths,
        inputSnapshot,
      },
      privateRoot,
    );
    await Promise.all([
      assertInputSnapshotUnchanged(
        esbuildPlatformSnapshot,
        undefined,
        'Authorized esbuild platform package',
      ),
      assertInputSnapshotUnchanged(inputSnapshot, repositoryRoot, 'Original QR-003 harness inputs'),
      assertInputSnapshotUnchanged(
        inputSnapshot,
        privateRoot,
        'Materialized QR-003 harness inputs',
      ),
    ]);
    return measured;
  } finally {
    if (ownsMaterialization) {
      await rm(privateRoot, { recursive: true, force: true });
    }
  }
}

export async function buildHeadedHarnessFromCapturedInputs(
  { discoveredInputPaths, inputSnapshot },
  materializationRoot,
) {
  const expectedInputPaths = canonicalDiscoveredInputPaths(discoveredInputPaths, inputSnapshot);
  await preparePrivatePerformanceMaterializationRoot(inputSnapshot.root, materializationRoot);
  await materializeInputSnapshot(inputSnapshot, materializationRoot);
  await assertInputSnapshotUnchanged(
    inputSnapshot,
    materializationRoot,
    'Materialized QR-003 harness inputs',
  );
  const configuration = await readHeadedHarnessConfiguration(materializationRoot);
  const first = await buildHeadedHarness(materializationRoot, configuration);
  assertHeadedHarnessInventory(expectedInputPaths, first.inputPaths);
  await assertInputSnapshotUnchanged(
    inputSnapshot,
    materializationRoot,
    'Materialized QR-003 harness inputs after the first binding build',
  );
  const measured = await buildHeadedHarness(materializationRoot, configuration);
  assertHeadedHarnessInventory(expectedInputPaths, measured.inputPaths);
  if (first.javascript !== measured.javascript) {
    throw new Error('QR-003 harness output changed between private binding builds.');
  }
  if (first.esbuildVersion !== measured.esbuildVersion) {
    throw new Error('QR-003 harness esbuild version changed between private binding builds.');
  }
  await assertInputSnapshotUnchanged(
    inputSnapshot,
    materializationRoot,
    'Materialized QR-003 harness inputs after the second binding build',
  );
  return Object.freeze({
    javascript: measured.javascript,
    bundleSha256: sha256(Buffer.from(measured.javascript, 'utf8')),
    definitionSha256: hashHeadedHarnessDefinition(configuration, measured.esbuildVersion),
    inputSnapshot,
  });
}

export async function preparePrivatePerformanceMaterializationRoot(
  sourceRoot,
  materializationRoot,
) {
  const absoluteSourceRoot = path.resolve(sourceRoot);
  const absoluteMaterializationRoot = path.resolve(materializationRoot);
  const [sourceRealPath, parentRealPath] = await Promise.all([
    realpath(absoluteSourceRoot),
    realpath(path.dirname(absoluteMaterializationRoot)),
  ]);
  const prospectiveRealPath = path.join(parentRealPath, path.basename(absoluteMaterializationRoot));
  assertDisjointRoots(sourceRealPath, prospectiveRealPath);
  await mkdir(absoluteMaterializationRoot, { mode: 0o700, recursive: true });
  const [materializationRealPath, status, entries] = await Promise.all([
    realpath(absoluteMaterializationRoot),
    lstat(absoluteMaterializationRoot),
    readdir(absoluteMaterializationRoot),
  ]);
  assertDisjointRoots(sourceRealPath, materializationRealPath);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error('Performance input materialization root must be a non-symbolic directory.');
  }
  if (
    process.platform !== 'win32' &&
    ((status.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && status.uid !== process.getuid()))
  ) {
    throw new Error(
      'Performance input materialization root must be owner-only and owned by the current user.',
    );
  }
  if (entries.length > 0) {
    throw new Error('Performance input materialization root must be empty before capture.');
  }
}

export async function captureCurrentPerformanceInputs(repositoryRoot) {
  const productionRuntimeSnapshot = await captureProductionRuntimeSnapshot(repositoryRoot);
  const productionBuildInputSnapshot = await captureProductionBuildInputSnapshot(repositoryRoot);
  const diagnosticsObserverSnapshot = await captureDiagnosticsObserverSnapshot(repositoryRoot);
  const headedHarness = await captureHeadedHarness(repositoryRoot);
  await Promise.all([
    assertInputSnapshotUnchanged(
      productionRuntimeSnapshot,
      undefined,
      'Production extension runtime',
    ),
    assertInputSnapshotUnchanged(
      productionBuildInputSnapshot,
      undefined,
      'Production build inputs',
    ),
    assertInputSnapshotUnchanged(
      diagnosticsObserverSnapshot,
      undefined,
      'QR-002 diagnostics observer',
    ),
    assertInputSnapshotUnchanged(headedHarness.inputSnapshot, undefined, 'QR-003 harness inputs'),
  ]);
  return Object.freeze({
    diagnosticsObserverSnapshot,
    headedHarness,
    inputIdentity: createPerformanceInputIdentity({
      diagnosticsObserverSnapshot,
      headedHarness,
      productionBuildInputSnapshot,
      productionRuntimeSnapshot,
    }),
    productionBuildInputSnapshot,
    productionRuntimeSnapshot,
  });
}

export function createPerformanceInputIdentity({
  diagnosticsObserverSnapshot,
  headedHarness,
  productionBuildInputSnapshot,
  productionRuntimeSnapshot,
}) {
  return Object.freeze({
    productionRuntimeSnapshotSha256: productionRuntimeSnapshot.sha256,
    productionBuildInputSnapshotSha256: productionBuildInputSnapshot.sha256,
    diagnosticsObserverSnapshotSha256: diagnosticsObserverSnapshot.sha256,
    qr003HarnessInputSnapshotSha256: headedHarness.inputSnapshot.sha256,
    qr003HarnessDefinitionSha256: headedHarness.definitionSha256,
    qr003HarnessBundleSha256: headedHarness.bundleSha256,
  });
}

async function readHeadedHarnessConfiguration(repositoryRoot) {
  const raw = await readFile(
    resolveRepositoryPath(repositoryRoot, HEADED_HARNESS_BUILD_CONFIGURATION_PATH),
    'utf8',
  );
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Could not parse QR-003 harness build configuration: ${String(error)}`);
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    value.schemaVersion !== 1 ||
    typeof value.entryPoint !== 'string' ||
    value.entryPoint.length === 0 ||
    value.bundle !== true ||
    value.format !== 'iife' ||
    value.platform !== 'browser' ||
    value.target !== 'es2022' ||
    value.write !== false ||
    typeof value.tsconfigRaw !== 'object' ||
    value.tsconfigRaw === null ||
    Array.isArray(value.tsconfigRaw)
  ) {
    throw new Error('QR-003 harness build configuration is invalid.');
  }
  return Object.freeze({
    bundle: value.bundle,
    entryPoint: repositoryRelativeInput(repositoryRoot, value.entryPoint),
    format: value.format,
    platform: value.platform,
    target: value.target,
    tsconfigRaw: value.tsconfigRaw,
    write: value.write,
  });
}

async function buildHeadedHarness(repositoryRoot, configuration) {
  const { build, version: esbuildVersion } = await loadAuthorizedEsbuild();
  const result = await build({
    absWorkingDir: repositoryRoot,
    bundle: configuration.bundle,
    entryPoints: [configuration.entryPoint],
    format: configuration.format,
    platform: configuration.platform,
    target: configuration.target,
    tsconfigRaw: configuration.tsconfigRaw,
    write: configuration.write,
    metafile: true,
  });
  const javascript =
    result.outputFiles.find((file) => file.path.endsWith('.js')) ?? result.outputFiles[0];
  if (javascript === undefined) {
    throw new Error('The headed benchmark harness did not emit JavaScript.');
  }
  const inputPaths = Object.keys(result.metafile.inputs)
    .filter((input) => !input.startsWith('<'))
    .map((input) => repositoryRelativeInput(repositoryRoot, input))
    .sort();
  return { javascript: javascript.text, inputPaths, esbuildVersion };
}

function hashHeadedHarnessDefinition(configuration, esbuildVersion) {
  return sha256(
    Buffer.from(
      `okf-workbench.qr003-harness-definition.v2\0${JSON.stringify({
        build: configuration,
        esbuildVersion,
      })}`,
      'utf8',
    ),
  );
}

async function loadAuthorizedEsbuild() {
  if (authorizedEsbuildModule === undefined) {
    authorizedEsbuildModule = (async () => {
      await captureAuthorizedEsbuildPlatformSnapshot(performanceExecutionRoot);
      return import('esbuild');
    })();
  }
  return authorizedEsbuildModule;
}

function productionBuildInputPaths(repositoryRoot, metadata) {
  const paths = [];
  for (const bundleName of ['extension', 'webview']) {
    const inputs = metadata?.bundles?.[bundleName]?.inputs;
    if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) {
      throw new Error(`Production build metadata is missing ${bundleName} input inventory.`);
    }
    paths.push(
      ...Object.keys(inputs).map((input) => repositoryRelativeInput(repositoryRoot, input)),
    );
  }
  return [...new Set(paths)].sort();
}

function repositoryRelativeInput(repositoryRoot, input) {
  const absolute = path.isAbsolute(input) ? input : path.resolve(repositoryRoot, input);
  const relative = path.relative(repositoryRoot, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Build input escapes the repository: ${input}.`);
  }
  return relative.split(path.sep).join('/');
}

function pruneDirectoryRoots(directories) {
  const sorted = [...new Set(directories)].sort();
  return sorted.filter(
    (candidate) =>
      !sorted.some(
        (possibleParent) =>
          possibleParent !== candidate && candidate.startsWith(`${possibleParent}/`),
      ),
  );
}

function filesOutsideDirectories(files, directories) {
  return files.filter(
    (relativePath) =>
      !directories.some(
        (directory) => relativePath === directory || relativePath.startsWith(`${directory}/`),
      ),
  );
}

function withResolverManifests(inputs) {
  const files = new Set(inputs);
  for (const input of inputs) {
    const segments = input.split('/');
    for (let index = 0; index < segments.length; index += 1) {
      if (segments[index] !== 'node_modules' || segments[index + 1] === undefined) continue;
      const packageLength = segments[index + 1].startsWith('@') ? 2 : 1;
      const packageSegments = segments.slice(index, index + 1 + packageLength);
      if (packageSegments.length === 1 + packageLength) {
        files.add([...segments.slice(0, index), ...packageSegments, 'package.json'].join('/'));
      }
    }
  }
  return [...files].sort();
}

function assertDiscoveredInputsCaptured(inputPaths, snapshot, label) {
  const capturedPaths = new Set(snapshot.entries.map((entry) => entry.relativePath));
  const missing = inputPaths.filter((relativePath) => !capturedPaths.has(relativePath));
  if (missing.length > 0) {
    throw new Error(
      `${label} discovered inputs outside its static closed snapshot: ${missing.join(', ')}.`,
    );
  }
}

function resolveRepositoryPath(repositoryRoot, relativePath) {
  return path.resolve(repositoryRoot, ...relativePath.split('/'));
}

function samePaths(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalDiscoveredInputPaths(inputPaths, inputSnapshot) {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
    throw new Error('QR-003 harness discovery must report at least one build input.');
  }
  const canonical = [...new Set(inputPaths)].sort();
  if (
    canonical.length !== inputPaths.length ||
    !samePaths(inputPaths, canonical) ||
    canonical.some(
      (relativePath) =>
        typeof relativePath !== 'string' ||
        relativePath.length === 0 ||
        relativePath.startsWith('/') ||
        /^[A-Za-z]:\//u.test(relativePath) ||
        relativePath
          .replaceAll('\\', '/')
          .split('/')
          .some((segment) => segment === '' || segment === '.' || segment === '..'),
    )
  ) {
    throw new Error('QR-003 harness discovery returned a non-canonical input inventory.');
  }
  const capturedPaths = new Set(inputSnapshot.entries.map((entry) => entry.relativePath));
  const missing = canonical.filter((relativePath) => !capturedPaths.has(relativePath));
  if (missing.length > 0) {
    throw new Error(
      `QR-003 harness input snapshot is missing discovered inputs: ${missing.join(', ')}.`,
    );
  }
  return canonical;
}

function assertHeadedHarnessInventory(expected, measured) {
  if (!samePaths(expected, measured)) {
    throw new Error(
      'QR-003 harness input inventory changed between live discovery and a private binding build.',
    );
  }
}

function assertDisjointRoots(leftRoot, rightRoot) {
  const leftToRight = path.relative(leftRoot, rightRoot);
  const rightToLeft = path.relative(rightRoot, leftRoot);
  if (
    leftToRight === '' ||
    (!leftToRight.startsWith('..') && !path.isAbsolute(leftToRight)) ||
    (!rightToLeft.startsWith('..') && !path.isAbsolute(rightToLeft))
  ) {
    throw new Error(
      'Performance input materialization root must be disjoint from its source repository.',
    );
  }
}

function snapshotEntry(snapshot, relativePath) {
  const entry = snapshot.entries.find((candidate) => candidate.relativePath === relativePath);
  if (entry === undefined) throw new Error(`Immutable snapshot is missing ${relativePath}.`);
  return entry;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
