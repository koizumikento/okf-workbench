import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { captureStableInputSnapshot } from './performance-input-snapshot.mjs';

export const PERFORMANCE_TOOLCHAIN_MANIFEST_PATH = 'scripts/performance-toolchain-manifest.json';

export const HEADED_EXECUTION_SOURCE_PATHS = Object.freeze([
  'package-lock.json',
  'scripts/build.mjs',
  'scripts/canonical-wasm.mjs',
  'scripts/benchmark-report.mjs',
  'scripts/performance-bundle-hash.mjs',
  'scripts/performance-evidence-inputs.mjs',
  'scripts/performance-evidence-publisher.mjs',
  'scripts/performance-input-snapshot.mjs',
  'scripts/performance-toolchain-manifest.json',
  'scripts/performance-toolchain.mjs',
  'test/benchmarks/headed-editor-evidence.mjs',
  'test/benchmarks/headed-editor-evidence-runner.mjs',
  'test/benchmarks/webview-network-recorder.mjs',
]);

const TOOLCHAIN_ROOT_PACKAGES = Object.freeze([
  'node_modules/@vscode/test-electron',
  'node_modules/esbuild',
  'node_modules/playwright',
]);
const HOST_NATIVE_ESBUILD_MIRROR = 'node_modules/esbuild/bin/esbuild';

export async function discoverPortablePerformanceToolchainDirectories(repositoryRoot) {
  const packageLock = await readPackageLock(repositoryRoot);
  return discoverPortableDirectoriesFromLock(packageLock);
}

export async function captureHeadedEvidenceExecutionSnapshot(repositoryRoot) {
  assertNoEsbuildBinaryOverride();
  const packageLock = await readPackageLock(repositoryRoot);
  const manifest = await readToolchainManifest(repositoryRoot);
  const portableDirectories = discoverPortableDirectoriesFromLock(packageLock);
  const portableEsbuildRecord = selectPortableEsbuildRecord(manifest);
  const platformRecord = selectPlatformRecord(manifest);
  assertPortableEsbuildLockEntry(packageLock, manifest, portableEsbuildRecord);
  assertPlatformLockEntry(packageLock, manifest, platformRecord);
  const directories = [
    ...portableDirectories,
    ...platformPackageDirectories(platformRecord),
  ].sort();
  const snapshot = await captureStableInputSnapshot(
    repositoryRoot,
    {
      files: [...HEADED_EXECUTION_SOURCE_PATHS],
      directories,
    },
    'Headed evidence executable inputs',
  );
  const capturedLock = parseJsonSnapshotEntry(snapshot, 'package-lock.json', 'package lock');
  const capturedManifest = parseJsonSnapshotEntry(
    snapshot,
    PERFORMANCE_TOOLCHAIN_MANIFEST_PATH,
    'performance toolchain manifest',
  );
  const capturedPlatformRecord = selectPlatformRecord(capturedManifest);
  const capturedPortableEsbuildRecord = selectPortableEsbuildRecord(capturedManifest);
  const capturedDirectories = [
    ...discoverPortableDirectoriesFromLock(capturedLock),
    ...platformPackageDirectories(capturedPlatformRecord),
  ].sort();
  if (!samePaths(directories, capturedDirectories)) {
    throw new Error(
      'Headed evidence toolchain inventory changed while its immutable snapshot was captured.',
    );
  }
  assertPortableEsbuildLockEntry(capturedLock, capturedManifest, capturedPortableEsbuildRecord);
  assertPlatformLockEntry(capturedLock, capturedManifest, capturedPlatformRecord);
  assertPortableEsbuildPackageFiles(snapshot, capturedPortableEsbuildRecord);
  assertPlatformPackageFiles(snapshot, capturedPlatformRecord);
  return snapshot;
}

export async function captureAuthorizedEsbuildPlatformSnapshot(repositoryRoot) {
  assertNoEsbuildBinaryOverride();
  const packageLock = await readPackageLock(repositoryRoot);
  const manifest = await readToolchainManifest(repositoryRoot);
  const portableEsbuildRecord = selectPortableEsbuildRecord(manifest);
  const platformRecord = selectPlatformRecord(manifest);
  assertPortableEsbuildLockEntry(packageLock, manifest, portableEsbuildRecord);
  assertPlatformLockEntry(packageLock, manifest, platformRecord);
  const snapshot = await captureStableInputSnapshot(
    repositoryRoot,
    {
      files: ['package-lock.json', PERFORMANCE_TOOLCHAIN_MANIFEST_PATH],
      directories: [
        portableEsbuildRecord.packagePath,
        ...platformPackageDirectories(platformRecord),
      ],
      excludedFiles: portableEsbuildRecord.excludedHostFiles.map(
        (relativePath) => `${portableEsbuildRecord.packagePath}/${relativePath}`,
      ),
    },
    'Authorized esbuild platform package',
  );
  const capturedLock = parseJsonSnapshotEntry(snapshot, 'package-lock.json', 'package lock');
  const capturedManifest = parseJsonSnapshotEntry(
    snapshot,
    PERFORMANCE_TOOLCHAIN_MANIFEST_PATH,
    'performance toolchain manifest',
  );
  const capturedPlatformRecord = selectPlatformRecord(capturedManifest);
  const capturedPortableEsbuildRecord = selectPortableEsbuildRecord(capturedManifest);
  if (capturedPlatformRecord.packagePath !== platformRecord.packagePath) {
    throw new Error('The esbuild platform package changed while it was captured.');
  }
  assertPortableEsbuildLockEntry(capturedLock, capturedManifest, capturedPortableEsbuildRecord);
  assertPlatformLockEntry(capturedLock, capturedManifest, capturedPlatformRecord);
  assertPortableEsbuildPackageFiles(snapshot, capturedPortableEsbuildRecord);
  assertPlatformPackageFiles(snapshot, capturedPlatformRecord);
  return snapshot;
}

export async function readCurrentEsbuildPlatformPackage(repositoryRoot) {
  const packageLock = await readPackageLock(repositoryRoot);
  const manifest = await readToolchainManifest(repositoryRoot);
  const platformRecord = selectPlatformRecord(manifest);
  assertPlatformLockEntry(packageLock, manifest, platformRecord);
  return Object.freeze({
    key: `${process.platform}-${process.arch}`,
    packagePath: platformRecord.packagePath,
    executableFiles: Object.freeze([...platformRecord.executableFiles]),
    files: Object.freeze({ ...platformRecord.files }),
    optionalPackages: Object.freeze(
      platformRecord.optionalPackages.map((candidate) =>
        Object.freeze({
          packagePath: candidate.packagePath,
          files: Object.freeze({ ...candidate.files }),
        }),
      ),
    ),
  });
}

export function assertAuthorizedPortableEsbuildSnapshot(snapshot) {
  const packageLock = parseJsonSnapshotEntry(snapshot, 'package-lock.json', 'package lock');
  const manifest = parseJsonSnapshotEntry(
    snapshot,
    PERFORMANCE_TOOLCHAIN_MANIFEST_PATH,
    'performance toolchain manifest',
  );
  const portableRecord = selectPortableEsbuildRecord(manifest);
  assertPortableEsbuildLockEntry(packageLock, manifest, portableRecord);
  assertPortableEsbuildPackageFiles(snapshot, portableRecord);
}

function discoverPortableDirectoriesFromLock(packageLock) {
  if (
    packageLock === null ||
    typeof packageLock !== 'object' ||
    Array.isArray(packageLock) ||
    packageLock.lockfileVersion !== 3 ||
    packageLock.packages === null ||
    typeof packageLock.packages !== 'object' ||
    Array.isArray(packageLock.packages)
  ) {
    throw new Error('Performance toolchain requires an npm lockfileVersion 3 package lock.');
  }
  const packages = packageLock.packages;
  const pending = [...TOOLCHAIN_ROOT_PACKAGES];
  const discovered = new Set();
  while (pending.length > 0) {
    const packagePath = pending.shift();
    if (discovered.has(packagePath)) continue;
    const entry = packages[packagePath];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Performance toolchain lock entry is missing ${packagePath}.`);
    }
    discovered.add(packagePath);
    const dependencies = entry.dependencies;
    if (
      dependencies !== undefined &&
      (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies))
    ) {
      throw new Error(`Performance toolchain dependencies are malformed for ${packagePath}.`);
    }
    for (const dependencyName of Object.keys(dependencies ?? {}).sort()) {
      pending.push(resolveLockedDependency(packages, packagePath, dependencyName));
    }
    const peerDependencies = entry.peerDependencies;
    if (
      peerDependencies !== undefined &&
      (peerDependencies === null ||
        typeof peerDependencies !== 'object' ||
        Array.isArray(peerDependencies))
    ) {
      throw new Error(`Performance toolchain peer dependencies are malformed for ${packagePath}.`);
    }
    const peerMetadata = entry.peerDependenciesMeta;
    if (
      peerMetadata !== undefined &&
      (peerMetadata === null || typeof peerMetadata !== 'object' || Array.isArray(peerMetadata))
    ) {
      throw new Error(
        `Performance toolchain peer dependency metadata is malformed for ${packagePath}.`,
      );
    }
    for (const peerName of Object.keys(peerDependencies ?? {}).sort()) {
      if (peerMetadata?.[peerName]?.optional === true) continue;
      pending.push(resolveLockedDependency(packages, packagePath, peerName));
    }
  }

  const allDirectories = [...discovered].sort();
  return Object.freeze(
    allDirectories.filter(
      (candidate) =>
        !allDirectories.some(
          (possibleParent) =>
            possibleParent !== candidate && candidate.startsWith(`${possibleParent}/`),
        ),
    ),
  );
}

function resolveLockedDependency(packages, parentPackagePath, dependencyName) {
  let ancestor = parentPackagePath;
  for (;;) {
    const candidate = `${ancestor}/node_modules/${dependencyName}`;
    if (packages[candidate] !== undefined) return candidate;
    const boundary = ancestor.lastIndexOf('/node_modules/');
    if (boundary < 0) break;
    ancestor = ancestor.slice(0, boundary);
  }
  const rootCandidate = `node_modules/${dependencyName}`;
  if (packages[rootCandidate] !== undefined) return rootCandidate;
  throw new Error(
    `Performance toolchain cannot resolve ${dependencyName} from ${parentPackagePath}.`,
  );
}

async function readPackageLock(repositoryRoot) {
  return parseJson(
    await readFile(path.join(repositoryRoot, 'package-lock.json'), 'utf8'),
    'package lock',
  );
}

async function readToolchainManifest(repositoryRoot) {
  return parseJson(
    await readFile(
      path.join(repositoryRoot, ...PERFORMANCE_TOOLCHAIN_MANIFEST_PATH.split('/')),
      'utf8',
    ),
    'performance toolchain manifest',
  );
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Could not parse ${label}: ${String(error)}`);
  }
}

function selectPlatformRecord(manifest) {
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    manifest.schemaVersion !== 1 ||
    typeof manifest.esbuildVersion !== 'string' ||
    manifest.platformPackages === null ||
    typeof manifest.platformPackages !== 'object' ||
    Array.isArray(manifest.platformPackages)
  ) {
    throw new Error('Performance toolchain manifest is malformed.');
  }
  const platformKey = `${process.platform}-${process.arch}`;
  const record = manifest.platformPackages[platformKey];
  if (
    record === null ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    typeof record.packagePath !== 'string' ||
    !record.packagePath.startsWith('node_modules/@esbuild/') ||
    typeof record.integrity !== 'string' ||
    !Array.isArray(record.executableFiles) ||
    record.files === null ||
    typeof record.files !== 'object' ||
    Array.isArray(record.files) ||
    Object.keys(record.files).length === 0 ||
    !Array.isArray(record.optionalPackages)
  ) {
    throw new Error(`Performance toolchain does not authorize esbuild on ${platformKey}.`);
  }
  for (const [relativePath, digest] of Object.entries(record.files)) {
    if (
      relativePath.startsWith('/') ||
      relativePath
        .split('/')
        .some((segment) => segment === '' || segment === '.' || segment === '..') ||
      typeof digest !== 'string' ||
      !/^[a-f\d]{64}$/u.test(digest)
    ) {
      throw new Error(`Performance toolchain manifest has an invalid ${platformKey} file entry.`);
    }
  }
  if (
    record.executableFiles.some(
      (relativePath) =>
        typeof relativePath !== 'string' ||
        !Object.prototype.hasOwnProperty.call(record.files, relativePath),
    )
  ) {
    throw new Error(`Performance toolchain manifest has invalid ${platformKey} executables.`);
  }
  for (const optionalPackage of record.optionalPackages) {
    if (
      optionalPackage === null ||
      typeof optionalPackage !== 'object' ||
      Array.isArray(optionalPackage) ||
      typeof optionalPackage.packagePath !== 'string' ||
      !optionalPackage.packagePath.startsWith('node_modules/') ||
      typeof optionalPackage.version !== 'string' ||
      typeof optionalPackage.integrity !== 'string' ||
      optionalPackage.files === null ||
      typeof optionalPackage.files !== 'object' ||
      Array.isArray(optionalPackage.files) ||
      Object.keys(optionalPackage.files).length === 0
    ) {
      throw new Error(
        `Performance toolchain manifest has an invalid ${platformKey} optional package.`,
      );
    }
    for (const [relativePath, digest] of Object.entries(optionalPackage.files)) {
      if (
        relativePath.startsWith('/') ||
        relativePath
          .split('/')
          .some((segment) => segment === '' || segment === '.' || segment === '..') ||
        typeof digest !== 'string' ||
        !/^[a-f\d]{64}$/u.test(digest)
      ) {
        throw new Error(
          `Performance toolchain manifest has an invalid ${platformKey} optional package file.`,
        );
      }
    }
  }
  return record;
}

function selectPortableEsbuildRecord(manifest) {
  const record = manifest?.portableEsbuildPackage;
  if (
    record === null ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    record.packagePath !== 'node_modules/esbuild' ||
    typeof record.integrity !== 'string' ||
    !Array.isArray(record.excludedHostFiles) ||
    record.excludedHostFiles.length !== 1 ||
    record.excludedHostFiles[0] !== 'bin/esbuild' ||
    record.files === null ||
    typeof record.files !== 'object' ||
    Array.isArray(record.files) ||
    Object.keys(record.files).length === 0
  ) {
    throw new Error('Performance toolchain manifest has an invalid portable esbuild package.');
  }
  assertExactFileManifest(record.files, 'portable esbuild');
  if (
    Object.prototype.hasOwnProperty.call(record.files, record.excludedHostFiles[0]) ||
    `${record.packagePath}/${record.excludedHostFiles[0]}` !== HOST_NATIVE_ESBUILD_MIRROR
  ) {
    throw new Error('Performance toolchain manifest has invalid portable esbuild exclusions.');
  }
  return record;
}

function assertPlatformLockEntry(packageLock, manifest, platformRecord) {
  const lockEntry = packageLock.packages?.[platformRecord.packagePath];
  if (
    lockEntry === null ||
    typeof lockEntry !== 'object' ||
    Array.isArray(lockEntry) ||
    lockEntry.version !== manifest.esbuildVersion ||
    lockEntry.integrity !== platformRecord.integrity ||
    lockEntry.optional !== true
  ) {
    throw new Error(
      `Installed esbuild platform package ${platformRecord.packagePath} is not authorized by the lockfile and toolchain manifest.`,
    );
  }
  for (const optionalPackage of platformRecord.optionalPackages) {
    const optionalLockEntry = packageLock.packages?.[optionalPackage.packagePath];
    if (
      optionalLockEntry === null ||
      typeof optionalLockEntry !== 'object' ||
      Array.isArray(optionalLockEntry) ||
      optionalLockEntry.version !== optionalPackage.version ||
      optionalLockEntry.integrity !== optionalPackage.integrity ||
      optionalLockEntry.optional !== true
    ) {
      throw new Error(
        `Installed optional toolchain package ${optionalPackage.packagePath} is not authorized.`,
      );
    }
  }
}

function assertPortableEsbuildLockEntry(packageLock, manifest, portableRecord) {
  const lockEntry = packageLock.packages?.[portableRecord.packagePath];
  if (
    lockEntry === null ||
    typeof lockEntry !== 'object' ||
    Array.isArray(lockEntry) ||
    lockEntry.version !== manifest.esbuildVersion ||
    lockEntry.integrity !== portableRecord.integrity
  ) {
    throw new Error(
      'Installed portable esbuild package is not authorized by the lockfile and toolchain manifest.',
    );
  }
}

function assertPortableEsbuildPackageFiles(snapshot, portableRecord) {
  assertExactPackageFiles(
    snapshot,
    portableRecord.packagePath,
    portableRecord.files,
    new Set(portableRecord.excludedHostFiles),
  );
}

function assertPlatformPackageFiles(snapshot, platformRecord) {
  assertExactPackageFiles(snapshot, platformRecord.packagePath, platformRecord.files);
  for (const optionalPackage of platformRecord.optionalPackages) {
    assertExactPackageFiles(snapshot, optionalPackage.packagePath, optionalPackage.files);
  }
}

function assertExactPackageFiles(snapshot, packagePath, expectedFiles, excludedFiles = new Set()) {
  const prefix = `${packagePath}/`;
  const actual = new Map(
    snapshot.entries
      .filter((entry) => entry.relativePath.startsWith(prefix))
      .map((entry) => [entry.relativePath.slice(prefix.length), entry.sha256])
      .filter(([relativePath]) => !excludedFiles.has(relativePath)),
  );
  const expected = new Map(Object.entries(expectedFiles));
  if (
    actual.size !== expected.size ||
    [...actual].some(
      ([relativePath, digest]) =>
        !expected.has(relativePath) || digest !== expected.get(relativePath),
    )
  ) {
    throw new Error(
      `Installed toolchain package ${packagePath} does not match its authorized exact file inventory.`,
    );
  }
}

function assertExactFileManifest(files, label) {
  for (const [relativePath, digest] of Object.entries(files)) {
    if (
      relativePath.startsWith('/') ||
      relativePath
        .split('/')
        .some((segment) => segment === '' || segment === '.' || segment === '..') ||
      typeof digest !== 'string' ||
      !/^[a-f\d]{64}$/u.test(digest)
    ) {
      throw new Error(`Performance toolchain manifest has an invalid ${label} file entry.`);
    }
  }
}

function platformPackageDirectories(platformRecord) {
  return [
    platformRecord.packagePath,
    ...platformRecord.optionalPackages.map((candidate) => candidate.packagePath),
  ].sort();
}

function parseJsonSnapshotEntry(snapshot, relativePath, label) {
  const entry = snapshot.entries.find((candidate) => candidate.relativePath === relativePath);
  if (entry === undefined) throw new Error(`Headed execution snapshot is missing ${relativePath}.`);
  return parseJson(entry.content.toString('utf8'), label);
}

function samePaths(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertNoEsbuildBinaryOverride() {
  if (process.env.ESBUILD_BINARY_PATH !== undefined) {
    throw new Error(
      'Performance evidence refuses ESBUILD_BINARY_PATH; use the lockfile-authorized native esbuild package.',
    );
  }
}
