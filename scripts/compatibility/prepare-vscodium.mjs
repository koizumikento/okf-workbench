import { access, appendFile, mkdir, readdir } from 'node:fs/promises';
import { basename, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { downloadVerified } from './download-verified.mjs';
import { resolveAndVerifyEditor, runProcess } from './editor-resolver.mjs';
import {
  COMPATIBILITY_PINS,
  getVscodiumAsset,
  normalizeArchitecture,
  normalizePlatform,
} from './pins.mjs';
import {
  errorMessage,
  optionalArgument,
  parseArguments,
  requiredArgument,
  runnerEvidence,
  writeJson,
} from './shared.mjs';

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function extractArchive(archivePath, extractionPath, platform) {
  await mkdir(extractionPath, { recursive: false });
  if (platform === 'linux') {
    await runProcess('tar', ['-xzf', archivePath, '--directory', extractionPath], {
      timeoutMs: 5 * 60 * 1_000,
    });
    return;
  }
  if (platform === 'darwin') {
    await runProcess('ditto', ['-x', '-k', archivePath, extractionPath], {
      timeoutMs: 5 * 60 * 1_000,
    });
    return;
  }
  if (platform === 'win32') {
    await runProcess(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Expand-Archive -LiteralPath $env:OKF_ARCHIVE_PATH -DestinationPath $env:OKF_EXTRACTION_PATH',
      ],
      {
        env: {
          ...process.env,
          OKF_ARCHIVE_PATH: archivePath,
          OKF_EXTRACTION_PATH: extractionPath,
        },
        timeoutMs: 5 * 60 * 1_000,
      },
    );
    return;
  }
  throw new Error(`Unsupported extraction platform: ${platform}.`);
}

async function walk(root) {
  const found = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() || entry.isSymbolicLink()) found.push(path);
    }
  }
  return found;
}

function pathSegments(path) {
  return path.split(/[\\/]/u).map((segment) => segment.toLowerCase());
}

function selectEditorPaths(paths, platform) {
  if (platform === 'linux') {
    const executablePath = paths.find((path) => {
      const segments = pathSegments(path);
      return basename(path) === 'codium' && segments.at(-2) !== 'bin';
    });
    const cliPath = paths.find((path) => {
      const segments = pathSegments(path);
      return basename(path) === 'codium' && segments.at(-2) === 'bin';
    });
    if (executablePath !== undefined && cliPath !== undefined) return { executablePath, cliPath };
  }

  if (platform === 'darwin') {
    const executablePath = paths.find((path) =>
      path.replaceAll('\\', '/').endsWith('/VSCodium.app/Contents/MacOS/VSCodium'),
    );
    const cliPath = paths.find((path) =>
      path.replaceAll('\\', '/').endsWith('/VSCodium.app/Contents/Resources/app/bin/codium'),
    );
    if (executablePath !== undefined && cliPath !== undefined) return { executablePath, cliPath };
  }

  if (platform === 'win32') {
    const executablePath = paths.find((path) => basename(path).toLowerCase() === 'vscodium.exe');
    const cliPath = paths.find((path) => {
      const segments = pathSegments(path);
      return basename(path).toLowerCase() === 'codium.cmd' && segments.at(-2) === 'bin';
    });
    if (executablePath !== undefined && cliPath !== undefined) return { executablePath, cliPath };
  }

  throw new Error(`Could not locate the VSCodium executable and CLI after extracting ${platform}.`);
}

async function appendGithubOutputs(path, editorPaths) {
  await appendFile(
    path,
    `editor-executable=${editorPaths.executablePath}\neditor-cli=${editorPaths.cliPath}\n`,
    'utf8',
  );
}

export async function prepareVscodium(options) {
  const platform = normalizePlatform(options.platform ?? process.platform);
  const architecture = normalizeArchitecture(options.architecture ?? process.arch);
  if (platform !== normalizePlatform(process.platform)) {
    throw new Error(`Cannot prepare a runnable ${platform} editor on ${process.platform}.`);
  }
  const asset = getVscodiumAsset(platform, architecture);
  const destination = resolve(options.destination);
  const extractionPath = resolve(destination, 'editor');
  if (await exists(extractionPath)) {
    throw new Error(`Extraction destination already exists: ${extractionPath}.`);
  }
  await mkdir(destination, { recursive: true });
  const archivePath = resolve(destination, asset.name);
  const download = await downloadVerified({
    url: asset.url,
    expectedSha256: asset.sha256,
    expectedSize: asset.size,
    destination: archivePath,
  });
  await extractArchive(archivePath, extractionPath, platform);
  const editorPaths = selectEditorPaths(await walk(extractionPath), platform);
  const editor = await resolveAndVerifyEditor({
    editor: 'vscodium',
    version: COMPATIBILITY_PINS.vscodium.releaseVersion,
    editorExecutable: editorPaths.executablePath,
    editorCli: editorPaths.cliPath,
  });
  return { asset, download, destination, extractionPath, editor };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const destination = resolve(requiredArgument(args, 'destination'));
  const evidencePath = resolve(requiredArgument(args, 'evidence'));
  const githubOutput = optionalArgument(args, 'github-output');
  const requestedVersion =
    optionalArgument(args, 'version') ?? COMPATIBILITY_PINS.vscodium.releaseVersion;
  const evidence = {
    schemaVersion: 1,
    kind: 'vscodium-preparation',
    status: 'running',
    recordedAt: new Date().toISOString(),
    releaseVersion: requestedVersion,
    runner: runnerEvidence(),
  };

  try {
    if (requestedVersion !== COMPATIBILITY_PINS.vscodium.releaseVersion) {
      throw new Error(`VSCodium ${requestedVersion} is not the pinned release.`);
    }
    const prepared = await prepareVscodium({
      destination,
      platform: optionalArgument(args, 'platform'),
      architecture: optionalArgument(args, 'arch'),
    });
    Object.assign(evidence, {
      status: 'passed',
      asset: {
        name: prepared.asset.name,
        url: prepared.asset.url,
        sha256: prepared.asset.sha256,
        size: prepared.asset.size,
        platform: prepared.asset.platform,
        architecture: prepared.asset.architecture,
      },
      download: {
        actualSha256: prepared.download.sha256,
        size: prepared.download.size,
        reused: prepared.download.reused,
      },
      editor: {
        reported: prepared.editor.reported,
        expectedReportedVersion: prepared.editor.expectedReportedVersion,
        expectedExtensionHostVersion: prepared.editor.expectedExtensionHostVersion,
        executableRelativePath: relative(destination, prepared.editor.executablePath)
          .split(sep)
          .join('/'),
        cliRelativePath: relative(destination, prepared.editor.cliPath).split(sep).join('/'),
      },
    });
    if (githubOutput !== undefined) {
      await appendGithubOutputs(resolve(githubOutput), prepared.editor);
    }
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = errorMessage(error);
    await writeJson(evidencePath, evidence);
    throw error;
  }

  await writeJson(evidencePath, evidence);
}

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  await main();
}
