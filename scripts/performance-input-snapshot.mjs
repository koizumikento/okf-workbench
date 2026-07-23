import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PERFORMANCE_INPUT_SNAPSHOT_DOMAIN = 'okf-workbench.performance-input-snapshot.v1';

export async function captureInputSnapshot(root, options) {
  const absoluteRoot = path.resolve(root);
  const files = canonicalPaths(options?.files ?? [], false);
  const directories = canonicalPaths(options?.directories ?? [], true);
  const excludedFiles = canonicalPaths(options?.excludedFiles ?? [], false);
  assertValidExclusions(files, directories, excludedFiles);
  const excludedFileSet = new Set(excludedFiles);
  const relativePaths = new Set(files);

  for (const directory of directories) {
    for (const relativePath of await listDirectoryFiles(absoluteRoot, directory, excludedFileSet)) {
      if (relativePaths.has(relativePath)) {
        throw new Error(`Performance input snapshot contains duplicate path ${relativePath}.`);
      }
      relativePaths.add(relativePath);
    }
  }

  const entries = [];
  for (const relativePath of [...relativePaths].sort()) {
    const absolutePath = resolveSnapshotPath(absoluteRoot, relativePath);
    const status = await lstat(absolutePath);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error(`Performance input ${relativePath} must be a regular, non-symbolic file.`);
    }
    const content = await readFile(absolutePath);
    entries.push(
      Object.freeze({
        relativePath,
        content,
        sha256: createHash('sha256').update(content).digest('hex'),
      }),
    );
  }

  const snapshot = {
    root: absoluteRoot,
    files: Object.freeze(files),
    directories: Object.freeze(directories),
    excludedFiles: Object.freeze(excludedFiles),
    entries: Object.freeze(entries),
  };
  return Object.freeze({ ...snapshot, sha256: hashSnapshot(snapshot) });
}

export async function captureStableInputSnapshot(root, options, label = 'Performance inputs') {
  const first = await captureInputSnapshot(root, options);
  const second = await captureInputSnapshot(root, options);
  if (first.sha256 !== second.sha256) {
    throw new Error(`${label} changed while its immutable snapshot was being captured.`);
  }
  return second;
}

export async function assertInputSnapshotUnchanged(
  snapshot,
  root = snapshot.root,
  label = 'Performance inputs',
) {
  let current;
  try {
    current = await captureInputSnapshot(root, {
      files: snapshot.files,
      directories: snapshot.directories,
      excludedFiles: snapshot.excludedFiles,
    });
  } catch (error) {
    throw new Error(`${label} changed after capture: ${errorMessage(error)}`);
  }
  if (current.sha256 === snapshot.sha256) return;

  const expected = new Map(snapshot.entries.map((entry) => [entry.relativePath, entry.sha256]));
  const actual = new Map(current.entries.map((entry) => [entry.relativePath, entry.sha256]));
  const removed = [...expected.keys()].filter((relativePath) => !actual.has(relativePath));
  const added = [...actual.keys()].filter((relativePath) => !expected.has(relativePath));
  const modified = [...expected.keys()].filter(
    (relativePath) =>
      actual.has(relativePath) && actual.get(relativePath) !== expected.get(relativePath),
  );
  const details = [
    ...removed.map((relativePath) => `removed ${relativePath}`),
    ...added.map((relativePath) => `added ${relativePath}`),
    ...modified.map((relativePath) => `modified ${relativePath}`),
  ];
  throw new Error(`${label} changed after capture: ${details.join(', ') || 'identity mismatch'}.`);
}

export async function materializeInputSnapshot(snapshot, destinationRoot) {
  const absoluteDestination = path.resolve(destinationRoot);
  await mkdir(absoluteDestination, { recursive: true });
  for (const entry of snapshot.entries) {
    const destination = resolveSnapshotPath(absoluteDestination, entry.relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, entry.content, { flag: 'wx' });
  }
}

function canonicalPaths(values, allowRoot) {
  if (!Array.isArray(values)) throw new TypeError('Snapshot paths must be arrays.');
  const paths = values.map((value) => canonicalPath(value, allowRoot));
  const unique = [...new Set(paths)].sort();
  if (unique.length !== paths.length) {
    throw new Error('Performance input snapshot paths must be unique.');
  }
  return unique;
}

function canonicalPath(value, allowRoot) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('Snapshot paths must be non-empty strings.');
  }
  const portable = value.replaceAll('\\', '/');
  if (allowRoot && portable === '.') return portable;
  if (
    portable.startsWith('/') ||
    /^[A-Za-z]:\//u.test(portable) ||
    portable.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`Snapshot path must be a contained repository-relative path: ${value}.`);
  }
  return portable;
}

function assertValidExclusions(files, directories, excludedFiles) {
  for (const excludedFile of excludedFiles) {
    if (files.includes(excludedFile)) {
      throw new Error(`Excluded performance input ${excludedFile} is also an explicit file.`);
    }
    if (
      !directories.some(
        (directory) => directory === '.' || excludedFile.startsWith(`${directory}/`),
      )
    ) {
      throw new Error(
        `Excluded performance input ${excludedFile} is not contained by a captured directory.`,
      );
    }
  }
}

async function listDirectoryFiles(root, relativeDirectory, excludedFiles) {
  const files = [];
  const visit = async (relativePath) => {
    const absolutePath = relativePath === '.' ? root : resolveSnapshotPath(root, relativePath);
    const status = await lstat(absolutePath);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new Error(
        `Performance input directory ${relativePath} must be a non-symbolic directory.`,
      );
    }
    const children = await readdir(absolutePath, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const childRelativePath = relativePath === '.' ? child.name : `${relativePath}/${child.name}`;
      if (excludedFiles.has(childRelativePath)) {
        if (!child.isFile() || child.isSymbolicLink()) {
          throw new Error(
            `Excluded performance input ${childRelativePath} must be a regular, non-symbolic file when present.`,
          );
        }
        continue;
      }
      if (child.isSymbolicLink()) {
        throw new Error(`Performance input ${childRelativePath} must not be symbolic.`);
      }
      if (child.isDirectory()) {
        await visit(childRelativePath);
      } else if (child.isFile()) {
        files.push(childRelativePath);
      } else {
        throw new Error(`Performance input ${childRelativePath} must be a regular file.`);
      }
    }
  };
  await visit(relativeDirectory);
  return files;
}

function resolveSnapshotPath(root, relativePath) {
  const resolved = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Snapshot path escapes its root: ${relativePath}.`);
  }
  return resolved;
}

function hashSnapshot(snapshot) {
  const hash = createHash('sha256');
  hash.update(`${PERFORMANCE_INPUT_SNAPSHOT_DOMAIN}\0`, 'utf8');
  for (const file of snapshot.files) updateFramed(hash, `file:${file}`, Buffer.alloc(0));
  for (const directory of snapshot.directories) {
    updateFramed(hash, `directory:${directory}`, Buffer.alloc(0));
  }
  for (const excludedFile of snapshot.excludedFiles) {
    updateFramed(hash, `excluded-file:${excludedFile}`, Buffer.alloc(0));
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
