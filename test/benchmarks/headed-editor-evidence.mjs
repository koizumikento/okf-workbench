import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const STAGED_EXECUTION_ENVIRONMENT_VARIABLE = 'OKF_HEADED_STAGED_EXECUTION';
const SNAPSHOT_DOMAIN = 'okf-workbench.performance-input-snapshot.v1';
const TOOLCHAIN_MANIFEST_PATH = 'scripts/performance-toolchain-manifest.json';
const EXECUTION_SOURCE_PATHS = [
  'package-lock.json',
  'scripts/build.mjs',
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
];
const TOOLCHAIN_ROOT_PACKAGES = [
  'node_modules/@vscode/test-electron',
  'node_modules/esbuild',
  'node_modules/playwright',
];
const HOST_NATIVE_ESBUILD_MIRROR = 'node_modules/esbuild/bin/esbuild';
const SCRUBBED_ENVIRONMENT_VARIABLES = new Set([
  'DYLD_INSERT_LIBRARIES',
  'ESBUILD_BINARY_PATH',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'NODE_PATH',
  STAGED_EXECUTION_ENVIRONMENT_VARIABLE,
]);

export function scrubHeadedEvidenceEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) =>
        value !== undefined && !SCRUBBED_ENVIRONMENT_VARIABLES.has(name.toUpperCase()),
    ),
  );
}

async function main() {
  if (process.env[STAGED_EXECUTION_ENVIRONMENT_VARIABLE] !== undefined) {
    throw new Error('The headed evidence bootstrap refuses a nested staged execution.');
  }

  const repositoryRoot = process.cwd();
  const executionSnapshot = await captureStableExecutionSnapshot(repositoryRoot);
  const stageRoot = await mkdtemp(path.join(os.tmpdir(), 'okf-headed-execution-'));

  try {
    await assertDisjointRoots(repositoryRoot, stageRoot);
    await materializeExecutionSnapshot(executionSnapshot, stageRoot);
    const runnerPath = resolveContainedPath(
      stageRoot,
      'test/benchmarks/headed-editor-evidence-runner.mjs',
    );
    const childEnvironment = scrubHeadedEvidenceEnvironment(process.env);
    childEnvironment[STAGED_EXECUTION_ENVIRONMENT_VARIABLE] = JSON.stringify({
      schemaVersion: 1,
      snapshotSha256: executionSnapshot.sha256,
    });
    const child = spawn(process.execPath, [runnerPath, ...process.argv.slice(2)], {
      cwd: repositoryRoot,
      env: childEnvironment,
      stdio: 'inherit',
    });
    const outcome = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    if (outcome.signal !== null) {
      throw new Error(`The headed evidence runner exited from signal ${outcome.signal}.`);
    }
    process.exitCode = outcome.code ?? 1;
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
}

if (await isMainModule()) {
  await main();
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

async function captureStableExecutionSnapshot(root) {
  const first = await captureExecutionSnapshot(root);
  const second = await captureExecutionSnapshot(root);
  if (first.sha256 !== second.sha256) {
    throw new Error('Headed evidence executable inputs changed while they were captured.');
  }
  return second;
}

async function captureExecutionSnapshot(root) {
  const packageLock = await readJsonFile(root, 'package-lock.json', 'package lock');
  const manifest = await readJsonFile(root, TOOLCHAIN_MANIFEST_PATH, 'toolchain manifest');
  const portableDirectories = discoverPortableDirectoriesFromLock(packageLock);
  const portableEsbuildRecord = selectPortableEsbuildRecord(manifest);
  const platformRecord = selectPlatformRecord(manifest);
  assertPortableEsbuildLockEntry(packageLock, manifest, portableEsbuildRecord);
  assertPlatformLockEntry(packageLock, manifest, platformRecord);
  const directories = [
    ...portableDirectories,
    ...platformPackageDirectories(platformRecord),
  ].sort();
  const snapshot = await captureSnapshot(root, EXECUTION_SOURCE_PATHS, directories);
  const capturedLock = parseJsonEntry(snapshot, 'package-lock.json', 'package lock');
  const capturedManifest = parseJsonEntry(snapshot, TOOLCHAIN_MANIFEST_PATH, 'toolchain manifest');
  const capturedPortableEsbuildRecord = selectPortableEsbuildRecord(capturedManifest);
  const capturedPlatformRecord = selectPlatformRecord(capturedManifest);
  const capturedDirectories = [
    ...discoverPortableDirectoriesFromLock(capturedLock),
    ...platformPackageDirectories(capturedPlatformRecord),
  ].sort();
  if (!samePaths(directories, capturedDirectories)) {
    throw new Error('Headed evidence executable inventory changed while it was captured.');
  }
  assertPortableEsbuildLockEntry(capturedLock, capturedManifest, capturedPortableEsbuildRecord);
  assertPlatformLockEntry(capturedLock, capturedManifest, capturedPlatformRecord);
  assertPortableEsbuildPackageFiles(snapshot, capturedPortableEsbuildRecord);
  assertPlatformPackageFiles(snapshot, capturedPlatformRecord);
  return { ...snapshot, platformRecord: capturedPlatformRecord };
}

async function captureSnapshot(root, inputFiles, inputDirectories) {
  const files = [...inputFiles].sort();
  const directories = [...inputDirectories].sort();
  const relativePaths = new Set(files);
  for (const directory of directories) {
    for (const relativePath of await listDirectoryFiles(root, directory)) {
      if (relativePaths.has(relativePath)) {
        throw new Error(`Headed execution snapshot contains duplicate path ${relativePath}.`);
      }
      relativePaths.add(relativePath);
    }
  }
  const entries = [];
  for (const relativePath of [...relativePaths].sort()) {
    const absolutePath = resolveContainedPath(root, relativePath);
    const status = await lstat(absolutePath);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error(`Headed execution input ${relativePath} must be a regular file.`);
    }
    const content = await readFile(absolutePath);
    entries.push({
      relativePath,
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  const snapshot = { files, directories, entries };
  return { ...snapshot, sha256: hashSnapshot(snapshot) };
}

async function materializeExecutionSnapshot(snapshot, destinationRoot) {
  for (const entry of snapshot.entries) {
    const destination = resolveContainedPath(destinationRoot, entry.relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, entry.content, { flag: 'wx' });
  }
  for (const relativePath of snapshot.platformRecord.executableFiles) {
    await chmod(
      resolveContainedPath(
        destinationRoot,
        `${snapshot.platformRecord.packagePath}/${relativePath}`,
      ),
      0o755,
    );
  }
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
    throw new Error('Headed evidence requires an npm lockfileVersion 3 package lock.');
  }
  const packages = packageLock.packages;
  const pending = [...TOOLCHAIN_ROOT_PACKAGES];
  const discovered = new Set();
  while (pending.length > 0) {
    const packagePath = pending.shift();
    if (discovered.has(packagePath)) continue;
    const entry = packages[packagePath];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Headed evidence lock entry is missing ${packagePath}.`);
    }
    discovered.add(packagePath);
    const dependencies = entry.dependencies;
    if (
      dependencies !== undefined &&
      (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies))
    ) {
      throw new Error(`Headed evidence dependencies are malformed for ${packagePath}.`);
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
      throw new Error(`Headed evidence peer dependencies are malformed for ${packagePath}.`);
    }
    const peerMetadata = entry.peerDependenciesMeta;
    if (
      peerMetadata !== undefined &&
      (peerMetadata === null || typeof peerMetadata !== 'object' || Array.isArray(peerMetadata))
    ) {
      throw new Error(`Headed evidence peer dependency metadata is malformed for ${packagePath}.`);
    }
    for (const peerName of Object.keys(peerDependencies ?? {}).sort()) {
      if (peerMetadata?.[peerName]?.optional === true) continue;
      pending.push(resolveLockedDependency(packages, packagePath, peerName));
    }
  }
  const allDirectories = [...discovered].sort();
  return allDirectories.filter(
    (candidate) =>
      !allDirectories.some(
        (possibleParent) =>
          possibleParent !== candidate && candidate.startsWith(`${possibleParent}/`),
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
  throw new Error(`Cannot resolve ${dependencyName} from ${parentPackagePath}.`);
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
    throw new Error('Headed evidence toolchain manifest is malformed.');
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
    throw new Error(`Headed evidence does not authorize esbuild on ${platformKey}.`);
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
      throw new Error(`Headed evidence manifest has an invalid ${platformKey} file entry.`);
    }
  }
  if (
    record.executableFiles.some(
      (relativePath) =>
        typeof relativePath !== 'string' ||
        !Object.prototype.hasOwnProperty.call(record.files, relativePath),
    )
  ) {
    throw new Error(`Headed evidence manifest has invalid ${platformKey} executables.`);
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
      throw new Error(`Headed evidence manifest has an invalid ${platformKey} optional package.`);
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
          `Headed evidence manifest has an invalid ${platformKey} optional package file.`,
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
    throw new Error('Headed evidence manifest has an invalid portable esbuild package.');
  }
  assertExactFileManifest(record.files, 'portable esbuild');
  if (
    Object.prototype.hasOwnProperty.call(record.files, record.excludedHostFiles[0]) ||
    `${record.packagePath}/${record.excludedHostFiles[0]}` !== HOST_NATIVE_ESBUILD_MIRROR
  ) {
    throw new Error('Headed evidence manifest has invalid portable esbuild exclusions.');
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
      `The installed esbuild package ${platformRecord.packagePath} is not authorized.`,
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
        `The installed optional package ${optionalPackage.packagePath} is not authorized.`,
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
    throw new Error('The installed portable esbuild package is not authorized.');
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
    throw new Error(`The installed toolchain package ${packagePath} has unexpected bytes.`);
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
      throw new Error(`Headed evidence manifest has an invalid ${label} file entry.`);
    }
  }
}

function platformPackageDirectories(platformRecord) {
  return [
    platformRecord.packagePath,
    ...platformRecord.optionalPackages.map((candidate) => candidate.packagePath),
  ].sort();
}

async function assertDisjointRoots(leftRoot, rightRoot) {
  const [left, right] = await Promise.all([realpath(leftRoot), realpath(rightRoot)]);
  const leftToRight = path.relative(left, right);
  const rightToLeft = path.relative(right, left);
  if (
    leftToRight === '' ||
    (!leftToRight.startsWith('..') && !path.isAbsolute(leftToRight)) ||
    (!rightToLeft.startsWith('..') && !path.isAbsolute(rightToLeft))
  ) {
    throw new Error('The private headed execution stage must be outside the repository tree.');
  }
}

async function listDirectoryFiles(root, relativeDirectory) {
  const files = [];
  const visit = async (relativePath) => {
    const absolutePath = resolveContainedPath(root, relativePath);
    const status = await lstat(absolutePath);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new Error(`Headed execution directory ${relativePath} must be non-symbolic.`);
    }
    const children = await readdir(absolutePath, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const childRelativePath = `${relativePath}/${child.name}`;
      if (child.isSymbolicLink()) {
        throw new Error(`Headed execution input ${childRelativePath} must not be symbolic.`);
      }
      if (child.isDirectory()) {
        await visit(childRelativePath);
      } else if (child.isFile()) {
        files.push(childRelativePath);
      } else {
        throw new Error(`Headed execution input ${childRelativePath} must be a regular file.`);
      }
    }
  };
  await visit(relativeDirectory);
  return files;
}

async function readJsonFile(root, relativePath, label) {
  return parseJson(await readFile(resolveContainedPath(root, relativePath), 'utf8'), label);
}

function parseJsonEntry(snapshot, relativePath, label) {
  const entry = snapshot.entries.find((candidate) => candidate.relativePath === relativePath);
  if (entry === undefined) throw new Error(`Headed execution snapshot is missing ${relativePath}.`);
  return parseJson(entry.content.toString('utf8'), label);
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Could not parse headed evidence ${label}: ${String(error)}`);
  }
}

function resolveContainedPath(root, relativePath) {
  const resolved = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Headed execution path escapes its root: ${relativePath}.`);
  }
  return resolved;
}

function hashSnapshot(snapshot) {
  const hash = createHash('sha256');
  hash.update(`${SNAPSHOT_DOMAIN}\0`, 'utf8');
  for (const file of snapshot.files) updateFramed(hash, `file:${file}`, Buffer.alloc(0));
  for (const directory of snapshot.directories) {
    updateFramed(hash, `directory:${directory}`, Buffer.alloc(0));
  }
  for (const entry of snapshot.entries) updateFramed(hash, entry.relativePath, entry.content);
  return hash.digest('hex');
}

function updateFramed(hash, label, content) {
  const labelBytes = Buffer.from(label, 'utf8');
  const header = Buffer.allocUnsafe(12);
  header.writeUInt32BE(labelBytes.length, 0);
  header.writeBigUInt64BE(BigInt(content.length), 4);
  hash.update(header);
  hash.update(labelBytes);
  hash.update(content);
}

function samePaths(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
