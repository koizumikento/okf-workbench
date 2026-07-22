import { spawn } from 'node:child_process';
import { access, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';

import {
  downloadAndUnzipVSCode,
  resolveCliPathFromVSCodeExecutablePath,
} from '@vscode/test-electron';

import { COMPATIBILITY_PINS } from './pins.mjs';
import {
  errorMessage,
  optionalArgument,
  parseArguments,
  requiredArgument,
  runnerEvidence,
  writeJson,
} from './shared.mjs';

export async function runProcess(
  command,
  args,
  { env = process.env, timeoutMs = 120_000, stdio = 'pipe' } = {},
) {
  const useShell = process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(command);
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env,
      shell: useShell,
      stdio,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    if (child.stdout !== null) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
    }
    if (child.stderr !== null) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
    }

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Process timed out after ${timeoutMs} ms: ${command}.`));
    }, timeoutMs);
    timer.unref();

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `${command} exited with ${code ?? signal}: ${(stderr || stdout).trim().slice(-2_000)}`,
          ),
        );
        return;
      }
      resolvePromise({ code: code ?? 0, stdout, stderr });
    });
  });
}

export function spawnEditor(editor, launchArgs, options = {}) {
  return spawn(editor.executablePath, launchArgs, {
    env: options.env ?? process.env,
    stdio: options.stdio ?? 'inherit',
    windowsHide: true,
  });
}

export async function readEditorVersion(editor) {
  const result = await runProcess(editor.cliPath, ['--version']);
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const reportedVersion = lines.find((line) =>
    /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(line),
  );
  if (reportedVersion === undefined) {
    throw new Error(`Could not read an editor version from ${editor.cliPath}.`);
  }
  return {
    reportedVersion,
    commit: lines.find((line) => /^[0-9a-f]{7,64}$/iu.test(line)) ?? null,
    architecture: lines.find((line) => /^(?:x64|arm64|ia32)$/iu.test(line)) ?? null,
  };
}

export async function resolveEditor(options) {
  const { editor, version } = options;
  if (editor === 'vscode') {
    if (!COMPATIBILITY_PINS.vscodeVersions.includes(version)) {
      throw new Error(`VS Code ${version} is not a pinned compatibility version.`);
    }
    const executablePath = await downloadAndUnzipVSCode({
      version,
      ...(options.editorCachePath === undefined
        ? {}
        : { cachePath: resolve(options.editorCachePath) }),
    });
    const cliPath = resolveCliPathFromVSCodeExecutablePath(executablePath);
    return {
      editor,
      requestedVersion: version,
      expectedReportedVersion: version,
      expectedExtensionHostVersion: version,
      executablePath,
      cliPath,
      acquisition: 'vscode-test-electron',
    };
  }

  if (editor !== 'vscodium' || version !== COMPATIBILITY_PINS.vscodium.releaseVersion) {
    throw new Error(`Unsupported editor pin: ${editor} ${version}.`);
  }
  if (options.editorExecutable === undefined || options.editorCli === undefined) {
    throw new Error(
      'VSCodium requires --editor-executable and --editor-cli from prepare-vscodium.',
    );
  }
  const executablePath = resolve(options.editorExecutable);
  const cliPath = resolve(options.editorCli);
  await Promise.all([access(executablePath), access(cliPath)]);
  return {
    editor,
    requestedVersion: version,
    expectedReportedVersion: COMPATIBILITY_PINS.vscodium.expectedReportedVersion,
    expectedExtensionHostVersion: COMPATIBILITY_PINS.vscodium.expectedExtensionHostVersion,
    executablePath,
    cliPath,
    acquisition: 'verified-vscodium-release',
  };
}

export function assertExtensionHostVersion(editor, reportedVersion) {
  if (typeof reportedVersion !== 'string' || reportedVersion.length === 0) {
    throw new Error('The packaged driver did not report an Extension Host API version.');
  }
  if (reportedVersion !== editor.expectedExtensionHostVersion) {
    throw new Error(
      `${editor.editor} ${editor.requestedVersion} Extension Host reported ${reportedVersion}; expected ${editor.expectedExtensionHostVersion}.`,
    );
  }
  return {
    requestedEditorVersion: editor.requestedVersion,
    expectedExtensionHostVersion: editor.expectedExtensionHostVersion,
    reportedExtensionHostVersion: reportedVersion,
  };
}

export async function resolveAndVerifyEditor(options) {
  const editor = await resolveEditor(options);
  const reported = await readEditorVersion(editor);
  if (reported.reportedVersion !== editor.expectedReportedVersion) {
    throw new Error(
      `${editor.editor} ${editor.requestedVersion} reported ${reported.reportedVersion}; expected ${editor.expectedReportedVersion}.`,
    );
  }
  return { ...editor, reported };
}

async function appendOutputs(path, editor) {
  const lines = [
    `editor-executable=${editor.executablePath}`,
    `editor-cli=${editor.cliPath}`,
    `editor-reported-version=${editor.reported.reportedVersion}`,
  ];
  await appendFile(path, `${lines.join('\n')}\n`, 'utf8');
}

export async function runEditorResolverCli(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const editorName = requiredArgument(args, 'editor');
  const version = requiredArgument(args, 'version');
  const evidencePath = optionalArgument(args, 'evidence');
  const githubOutput = optionalArgument(args, 'github-output');
  const evidence = {
    schemaVersion: 1,
    kind: 'editor-resolution',
    status: 'running',
    recordedAt: new Date().toISOString(),
    editor: editorName,
    requestedVersion: version,
    runner: runnerEvidence(),
  };

  try {
    const editor = await resolveAndVerifyEditor({
      editor: editorName,
      version,
      editorExecutable: optionalArgument(args, 'editor-executable'),
      editorCli: optionalArgument(args, 'editor-cli'),
      editorCachePath: optionalArgument(args, 'editor-cache'),
    });
    Object.assign(evidence, {
      status: 'passed',
      expectedReportedVersion: editor.expectedReportedVersion,
      expectedExtensionHostVersion: editor.expectedExtensionHostVersion,
      reported: editor.reported,
      acquisition: editor.acquisition,
    });
    if (githubOutput !== undefined) await appendOutputs(resolve(githubOutput), editor);
    process.stdout.write(
      `${JSON.stringify({ ...evidence, executablePath: editor.executablePath, cliPath: editor.cliPath })}\n`,
    );
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = errorMessage(error);
    if (evidencePath !== undefined) await writeJson(resolve(evidencePath), evidence);
    throw error;
  }

  if (evidencePath !== undefined) await writeJson(resolve(evidencePath), evidence);
}

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  await runEditorResolverCli();
}
