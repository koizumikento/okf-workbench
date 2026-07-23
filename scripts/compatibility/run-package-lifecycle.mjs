import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runTests } from '@vscode/test-electron';

import {
  assertExtensionHostVersion,
  electronTestGraphicsArguments,
  electronTestSandboxArguments,
  resolveAndVerifyEditor,
  runProcess,
} from './editor-resolver.mjs';
import { COMPATIBILITY_PINS } from './pins.mjs';
import {
  assertSha256,
  errorMessage,
  optionalArgument,
  parseArguments,
  requiredArgument,
  runnerEvidence,
  sha256File,
  writeJson,
} from './shared.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const driverDirectory = resolve(repositoryRoot, 'scripts/compatibility/driver');
const driverRunner = resolve(driverDirectory, 'run.cjs');
const compatibilityRequire = createRequire(import.meta.url);
const { EXPECTED_COMMAND_CATALOG, EXPECTED_COMMAND_IDS, EXPECTED_WRITE_COMMAND_IDS } =
  compatibilityRequire('./driver/command-catalog.cjs');
const {
  NETWORK_GUARD_LIFETIME,
  NETWORK_GUARD_LIMITATIONS,
  NETWORK_GUARD_SCOPE,
  OPTIONAL_GLOBAL_INTERCEPTED_METHODS,
  STATIC_INTERCEPTED_METHODS,
  assertActiveNetworkEvidence,
  assertPostUninstallNetworkEvidence,
} = compatibilityRequire('./driver/network-guard.cjs');
const upgradeSentinelKey = 'okfWorkbench.compatibilityUpgradeSentinel';
const guardedQuiescenceMs = 500;

async function readManifest() {
  return JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'));
}

function profileArguments(profile) {
  return [
    `--extensions-dir=${profile.extensionsDirectory}`,
    `--user-data-dir=${profile.userDataDirectory}`,
    '--disable-updates',
  ];
}

async function runCli(editor, profile, args) {
  return await runProcess(editor.cliPath, [...profileArguments(profile), ...args], {
    timeoutMs: 3 * 60 * 1_000,
  });
}

async function installedExtensions(editor, profile) {
  const result = await runCli(editor, profile, ['--list-extensions', '--show-versions']);
  return `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*@[^\s]+$/iu.test(line));
}

function installedVersion(lines, extensionId) {
  const prefix = `${extensionId.toLowerCase()}@`;
  const match = lines.find((line) => line.toLowerCase().startsWith(prefix));
  return match === undefined ? undefined : match.slice(match.lastIndexOf('@') + 1);
}

async function assertInstalled(editor, profile, extensionId, expectedVersion) {
  const lines = await installedExtensions(editor, profile);
  const version = installedVersion(lines, extensionId);
  if (version !== expectedVersion) {
    throw new Error(
      `Expected ${extensionId}@${expectedVersion}, found ${version ?? 'no matching extension'}.`,
    );
  }
  return version;
}

async function assertUninstalled(editor, profile, extensionId, reportPath) {
  const lines = await installedExtensions(editor, profile);
  if (installedVersion(lines, extensionId) !== undefined) {
    throw new Error(`${extensionId} remained installed after uninstall.`);
  }
  const initialResidues = await extensionInstallationResidues(
    profile.extensionsDirectory,
    extensionId,
  );
  const cleanup = await runPostUninstallCleanup({
    editor,
    profile,
    extensionId,
    reportPath,
  });
  const editorResiduesAfterRestart = await extensionInstallationResidues(
    profile.extensionsDirectory,
    extensionId,
  );
  const harnessRemovedVerifiedInstallations = await removeVerifiedExtensionInstallations(
    profile.extensionsDirectory,
    extensionId,
    editorResiduesAfterRestart,
  );
  const finalResidues = await extensionInstallationResidues(
    profile.extensionsDirectory,
    extensionId,
  );
  if (finalResidues.length > 0) {
    throw new Error(
      `${extensionId} left ${finalResidues.length} installation path(s) after verified harness cleanup.`,
    );
  }
  const finalLines = await installedExtensions(editor, profile);
  if (installedVersion(finalLines, extensionId) !== undefined) {
    throw new Error(`${extensionId} reappeared in the extension list after cleanup.`);
  }
  return {
    extensionListAbsent: true,
    extensionApiAbsent: cleanup.extensionApiAbsent,
    cleanupRestartRequired: true,
    editorResidueBeforeRestart: {
      present: initialResidues.length > 0,
      count: initialResidues.length,
      paths: initialResidues,
    },
    editorResidueAfterRestart: {
      present: editorResiduesAfterRestart.length > 0,
      count: editorResiduesAfterRestart.length,
      paths: editorResiduesAfterRestart,
    },
    harnessCleanup: {
      required: harnessRemovedVerifiedInstallations.length > 0,
      removedCount: harnessRemovedVerifiedInstallations.length,
      removedVerifiedInstallationPaths: harnessRemovedVerifiedInstallations,
      policy:
        'remove only a direct, non-symlink extension directory whose package identity and versioned directory name match the uninstalled extension',
    },
    installationResidueAbsent: true,
    residueCountBeforeCleanupRestart: initialResidues.length,
    residueCountAfterCleanupRestart: editorResiduesAfterRestart.length,
    residueCount: finalResidues.length,
    cleanupReport: basename(reportPath),
  };
}

async function removeVerifiedExtensionInstallations(
  extensionsDirectory,
  extensionId,
  residuePaths,
) {
  if (residuePaths.length === 0) return [];

  const extensionRoot = await realpath(extensionsDirectory);
  const removed = [];
  for (const residuePath of residuePaths) {
    if (residuePath.includes('/')) {
      throw new Error(
        `Refusing to remove nested extension residue ${residuePath}; an installation directory must be a direct child.`,
      );
    }
    const installationPath = resolve(extensionsDirectory, residuePath);
    const installationStat = await lstat(installationPath);
    if (!installationStat.isDirectory() || installationStat.isSymbolicLink()) {
      throw new Error(
        `Refusing to remove ${residuePath}; the residue is not a non-symlink directory.`,
      );
    }
    const installationRealPath = await realpath(installationPath);
    if (dirname(installationRealPath) !== extensionRoot) {
      throw new Error(
        `Refusing to remove ${residuePath}; its real path is outside the extension directory.`,
      );
    }

    const manifestPath = resolve(installationRealPath, 'package.json');
    const manifestStat = await lstat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      throw new Error(
        `Refusing to remove ${residuePath}; package.json is not a regular non-symlink file.`,
      );
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const manifestId = `${manifest.publisher}.${manifest.name}`;
    if (manifestId.toLowerCase() !== extensionId.toLowerCase()) {
      throw new Error(
        `Refusing to remove ${residuePath}; package identity ${manifestId} does not match ${extensionId}.`,
      );
    }
    if (typeof manifest.version !== 'string') {
      throw new Error(`Refusing to remove ${residuePath}; package version is missing.`);
    }
    const expectedDirectoryName = `${extensionId}-${manifest.version}`;
    if (residuePath.toLowerCase() !== expectedDirectoryName.toLowerCase()) {
      throw new Error(
        `Refusing to remove ${residuePath}; expected versioned directory ${expectedDirectoryName}.`,
      );
    }

    await rm(installationRealPath, { recursive: true });
    removed.push(residuePath);
  }
  return removed.sort();
}

async function extensionInstallationResidues(extensionsDirectory, extensionId) {
  const id = extensionId.toLowerCase();
  const residues = [];
  const pending = [extensionsDirectory];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const normalizedName = entry.name.toLowerCase();
      const belongsToExtension = normalizedName === id || normalizedName.startsWith(`${id}-`);
      if (belongsToExtension) {
        residues.push(relative(extensionsDirectory, path).split(sep).join('/'));
        continue;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(path);
    }
  }
  return residues.sort();
}

async function readUserSettings(profile) {
  const settingsPath = resolve(profile.userDataDirectory, 'User/settings.json');
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new Error('The clean-profile user settings file is not a JSON object.');
  }
  return settings;
}

async function writeUserSettings(profile, settings) {
  await writeFile(
    resolve(profile.userDataDirectory, 'User/settings.json'),
    `${JSON.stringify(settings, null, 2)}\n`,
    'utf8',
  );
}

async function seedUpgradeSentinel(profile, predecessorVersion, candidateVersion) {
  const settings = await readUserSettings(profile);
  const sentinel = {
    schemaVersion: 1,
    predecessorVersion,
    candidateVersion,
    value: 'preserve-across-okf-workbench-upgrade',
  };
  settings[upgradeSentinelKey] = sentinel;
  await writeUserSettings(profile, settings);
  return sentinel;
}

async function assertUpgradeSentinel(profile, expected) {
  const settings = await readUserSettings(profile);
  if (JSON.stringify(settings[upgradeSentinelKey]) !== JSON.stringify(expected)) {
    throw new Error(
      'The versioned OKF compatibility user-setting sentinel changed during upgrade.',
    );
  }
  return {
    key: upgradeSentinelKey,
    schemaVersion: expected.schemaVersion,
    predecessorVersion: expected.predecessorVersion,
    candidateVersion: expected.candidateVersion,
    preserved: true,
  };
}

async function walkFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files.sort();
}

async function workspaceSnapshot(workspacePath) {
  const entries = [];
  for (const path of await walkFiles(workspacePath)) {
    entries.push({
      path: relative(workspacePath, path).split(sep).join('/'),
      sha256: await sha256File(path),
    });
  }
  return entries;
}

async function createProfile(root, name, workspaceSource) {
  const profileRoot = resolve(root, name);
  const workspacePath = resolve(profileRoot, 'workspace');
  const extensionsDirectory = resolve(profileRoot, 'extensions');
  const userDataDirectory = resolve(profileRoot, 'user-data');
  await Promise.all([
    cp(workspaceSource, workspacePath, { recursive: true }),
    mkdir(extensionsDirectory, { recursive: true }),
    mkdir(resolve(userDataDirectory, 'User'), { recursive: true }),
  ]);
  await writeFile(
    resolve(userDataDirectory, 'User/settings.json'),
    `${JSON.stringify(
      {
        'extensions.autoCheckUpdates': false,
        'extensions.autoUpdate': false,
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  await mkdir(resolve(workspacePath, '.agents/skills/maintain-okf-knowledge'), {
    recursive: true,
  });
  await writeFile(
    resolve(workspacePath, 'AGENTS.md'),
    '# Uninstall preservation sentinel\n\nThis file belongs to the workspace.\n',
    'utf8',
  );
  await writeFile(
    resolve(workspacePath, '.agents/skills/maintain-okf-knowledge/SKILL.md'),
    '---\nname: maintain-okf-knowledge\ndescription: Uninstall preservation sentinel.\n---\n',
    'utf8',
  );

  return { profileRoot, workspacePath, extensionsDirectory, userDataDirectory };
}

async function activateInstalledExtension({
  editor,
  profile,
  extensionId,
  extensionVersion,
  reportPath,
  workspaceTrust = 'disabled',
}) {
  if (workspaceTrust !== 'disabled' && workspaceTrust !== 'untrusted') {
    throw new Error(`Unsupported packaged workspace-trust mode: ${workspaceTrust}.`);
  }
  const extensionTestsEnv = {
    OKF_ACCEPTANCE_DRIVER: '1',
    OKF_ACCEPTANCE_MODE: workspaceTrust === 'untrusted' ? 'untrusted' : 'read-only',
    OKF_ACCEPTANCE_EXTENSION_ID: extensionId,
    OKF_ACCEPTANCE_EXTENSION_VERSION: extensionVersion,
    OKF_ACCEPTANCE_EDITOR_API_VERSION: editor.expectedExtensionHostVersion,
    OKF_ACCEPTANCE_REPORT_PATH: reportPath,
    OKF_ACCEPTANCE_RUN_READ_ONLY_COMMANDS: '1',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '',
  };
  const launchArgs = [
    profile.workspacePath,
    ...profileArguments(profile),
    ...electronTestGraphicsArguments(),
    '--skip-welcome',
    '--skip-release-notes',
    '--new-window',
  ];

  if (workspaceTrust === 'untrusted') {
    const env = { ...process.env, ...extensionTestsEnv };
    delete env.ELECTRON_RUN_AS_NODE;
    await runProcess(
      editor.executablePath,
      [
        ...electronTestSandboxArguments(),
        ...launchArgs,
        `--extensionDevelopmentPath=${driverDirectory}`,
        `--extensionTestsPath=${driverRunner}`,
      ],
      { env, timeoutMs: 3 * 60 * 1_000 },
    );
  } else {
    await runTests({
      vscodeExecutablePath: editor.executablePath,
      extensionDevelopmentPath: driverDirectory,
      extensionTestsPath: driverRunner,
      reuseMachineInstall: true,
      launchArgs,
      extensionTestsEnv,
    });
  }
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  if (report.status !== 'passed') {
    throw new Error(
      `Packaged activation report did not pass: ${report.error ?? 'unknown failure'}.`,
    );
  }
  if (JSON.stringify(report.commands) !== JSON.stringify(EXPECTED_COMMAND_IDS)) {
    throw new Error('Packaged activation report did not contain all stable commands.');
  }
  if (JSON.stringify(report.commandCatalog) !== JSON.stringify(EXPECTED_COMMAND_CATALOG)) {
    throw new Error('Packaged activation report command metadata is incomplete or drifted.');
  }
  assertActiveNetworkEvidence(report, guardedQuiescenceMs);
  report.editor.versionVerification = assertExtensionHostVersion(editor, report.editor?.version);
  if (workspaceTrust === 'untrusted') {
    const untrustedWrites = report.untrustedWrites;
    const refusedIds = Array.isArray(untrustedWrites)
      ? untrustedWrites.map(({ command }) => command)
      : [];
    const completeRefusals =
      Array.isArray(untrustedWrites) &&
      untrustedWrites.every(
        ({ outcome, problemCodes, completedWithoutInputAutomation }) =>
          outcome === 'refused' &&
          Array.isArray(problemCodes) &&
          problemCodes.includes('workspace-untrusted') &&
          completedWithoutInputAutomation === true,
      );
    if (
      report.workspaceTrust?.actual !== false ||
      JSON.stringify(refusedIds) !== JSON.stringify(EXPECTED_WRITE_COMMAND_IDS) ||
      !completeRefusals
    ) {
      throw new Error('The fresh-profile untrusted-workspace acceptance report was incomplete.');
    }
  }
  await writeJson(reportPath, report);
  return report;
}

async function runPostUninstallCleanup({ editor, profile, extensionId, reportPath }) {
  await runTests({
    vscodeExecutablePath: editor.executablePath,
    extensionDevelopmentPath: driverDirectory,
    extensionTestsPath: driverRunner,
    reuseMachineInstall: true,
    launchArgs: [
      profile.workspacePath,
      ...profileArguments(profile),
      '--skip-welcome',
      '--skip-release-notes',
      '--new-window',
    ],
    extensionTestsEnv: {
      OKF_ACCEPTANCE_MODE: 'post-uninstall',
      OKF_ACCEPTANCE_EXTENSION_ID: extensionId,
      OKF_ACCEPTANCE_EDITOR_API_VERSION: editor.expectedExtensionHostVersion,
      OKF_ACCEPTANCE_REPORT_PATH: reportPath,
      OKF_ACCEPTANCE_RUN_READ_ONLY_COMMANDS: '0',
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      ALL_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: '',
    },
  });
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  if (report.status !== 'passed' || report.uninstall?.extensionApiAbsent !== true) {
    throw new Error('The post-uninstall Extension Host verification did not pass.');
  }
  assertPostUninstallNetworkEvidence(report);
  report.editor.versionVerification = assertExtensionHostVersion(editor, report.editor?.version);
  await writeJson(reportPath, report);
  return {
    ...report.uninstall,
    networkAttempts: report.networkAttempts,
    networkObservation: report.networkObservation,
    guardedQuiescenceMs: report.completion?.guardedQuiescenceMs,
  };
}

async function cleanInstallLifecycle(options) {
  const profile = await createProfile(options.temporaryRoot, 'install', options.workspaceSource);
  const before = await workspaceSnapshot(profile.workspacePath);
  const initiallyInstalled = await installedExtensions(options.editor, profile);
  if (installedVersion(initiallyInstalled, options.extensionId) !== undefined) {
    throw new Error('The clean profile already contained the candidate extension.');
  }

  await runCli(options.editor, profile, ['--install-extension', options.candidateVsix, '--force']);
  await assertInstalled(options.editor, profile, options.extensionId, options.candidateVersion);
  const activation = await activateInstalledExtension({
    editor: options.editor,
    profile,
    extensionId: options.extensionId,
    extensionVersion: options.candidateVersion,
    reportPath: options.activationReportPath,
  });

  await runCli(options.editor, profile, ['--install-extension', options.candidateVsix, '--force']);
  await assertInstalled(options.editor, profile, options.extensionId, options.candidateVersion);
  await runCli(options.editor, profile, ['--uninstall-extension', options.extensionId]);
  const uninstallVerification = await assertUninstalled(
    options.editor,
    profile,
    options.extensionId,
    options.uninstallReportPath,
  );
  const after = await workspaceSnapshot(profile.workspacePath);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error('Workspace files changed during install, activation, reinstall, or uninstall.');
  }

  return {
    status: 'passed',
    cleanProfile: true,
    installedVersion: options.candidateVersion,
    activationReport: basename(options.activationReportPath),
    activation,
    sameVersionReinstall: 'passed-not-counted-as-upgrade',
    uninstall: 'passed',
    uninstallVerification,
    workspacePreserved: true,
    workspaceFileCount: before.length,
  };
}

async function untrustedWorkspaceLifecycle(options) {
  const profile = await createProfile(options.temporaryRoot, 'untrusted', options.workspaceSource);
  const before = await workspaceSnapshot(profile.workspacePath);
  await runCli(options.editor, profile, ['--install-extension', options.candidateVsix, '--force']);
  await assertInstalled(options.editor, profile, options.extensionId, options.candidateVersion);
  const activation = await activateInstalledExtension({
    editor: options.editor,
    profile,
    extensionId: options.extensionId,
    extensionVersion: options.candidateVersion,
    reportPath: options.activationReportPath,
    workspaceTrust: 'untrusted',
  });
  await runCli(options.editor, profile, ['--uninstall-extension', options.extensionId]);
  const uninstallVerification = await assertUninstalled(
    options.editor,
    profile,
    options.extensionId,
    options.uninstallReportPath,
  );
  const after = await workspaceSnapshot(profile.workspacePath);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error('Workspace files changed during the untrusted packaged lifecycle.');
  }

  return {
    status: 'passed',
    cleanProfile: true,
    workspaceTrustEnabled: true,
    workspaceTrusted: false,
    readOnlyAvailable: activation.workspaceTrust?.readOnlyAvailable === true,
    refusedWriteCommands: activation.untrustedWrites,
    activationReport: basename(options.activationReportPath),
    activation,
    uninstall: 'passed',
    uninstallVerification,
    workspacePreserved: true,
    workspaceFileCount: before.length,
  };
}

function compareSemver(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(value);
    if (match === null) throw new Error(`Cannot compare non-semver extension version ${value}.`);
    return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? null];
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = a[index] - b[index];
    if (difference !== 0) return difference;
  }
  if (a[3] === b[3]) return 0;
  if (a[3] === null) return 1;
  if (b[3] === null) return -1;
  return a[3] < b[3] ? -1 : 1;
}

async function upgradeLifecycle(options) {
  if (options.previousVsix === undefined) {
    throw new Error('A verified, semver-lower predecessor VSIX is required.');
  }

  const profile = await createProfile(options.temporaryRoot, 'upgrade', options.workspaceSource);
  const before = await workspaceSnapshot(profile.workspacePath);
  await runCli(options.editor, profile, ['--install-extension', options.previousVsix, '--force']);
  const previousLines = await installedExtensions(options.editor, profile);
  const previousVersion = installedVersion(previousLines, options.extensionId);
  if (previousVersion === undefined) {
    throw new Error(`The predecessor VSIX did not install as ${options.extensionId}.`);
  }
  if (compareSemver(previousVersion, options.candidateVersion) >= 0) {
    throw new Error(
      `Predecessor ${previousVersion} must be semver-lower than candidate ${options.candidateVersion}.`,
    );
  }
  const upgradeSentinel = await seedUpgradeSentinel(
    profile,
    previousVersion,
    options.candidateVersion,
  );

  await runCli(options.editor, profile, ['--install-extension', options.candidateVsix, '--force']);
  await assertInstalled(options.editor, profile, options.extensionId, options.candidateVersion);
  const activation = await activateInstalledExtension({
    editor: options.editor,
    profile,
    extensionId: options.extensionId,
    extensionVersion: options.candidateVersion,
    reportPath: options.upgradeActivationReportPath,
  });
  const userSettingVerification = await assertUpgradeSentinel(profile, upgradeSentinel);
  await runCli(options.editor, profile, ['--uninstall-extension', options.extensionId]);
  const uninstallVerification = await assertUninstalled(
    options.editor,
    profile,
    options.extensionId,
    options.uninstallReportPath,
  );
  const after = await workspaceSnapshot(profile.workspacePath);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error('Workspace files changed during upgrade or uninstall.');
  }

  return {
    status: 'passed',
    predecessorVersion: previousVersion,
    candidateVersion: options.candidateVersion,
    activationReport: basename(options.upgradeActivationReportPath),
    activation,
    userSettingVerification,
    uninstall: 'passed',
    uninstallVerification,
    workspacePreserved: true,
  };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const editorName = requiredArgument(args, 'editor');
  const editorVersion = requiredArgument(args, 'version');
  const candidateVsix = resolve(requiredArgument(args, 'vsix'));
  const workspaceSource = resolve(requiredArgument(args, 'workspace'));
  const evidencePath = resolve(requiredArgument(args, 'evidence'));
  const extensionId = optionalArgument(args, 'extension-id') ?? COMPATIBILITY_PINS.extensionId;
  const previousVsixArgument = optionalArgument(args, 'previous-vsix');
  const previousShaArgument = optionalArgument(args, 'previous-vsix-sha256');
  const evidenceDirectory = dirname(evidencePath);
  const evidencePrefix = basename(evidencePath, '.json');
  const reportPath = (suffix) => resolve(evidenceDirectory, `${evidencePrefix}.${suffix}.json`);
  const activationReportPath = reportPath('activation-clean');
  const uninstallCleanReportPath = reportPath('uninstall-clean');
  const untrustedActivationReportPath = reportPath('activation-untrusted');
  const uninstallUntrustedReportPath = reportPath('uninstall-untrusted');
  const upgradeActivationReportPath = reportPath('activation-upgrade');
  const uninstallUpgradeReportPath = reportPath('uninstall-upgrade');
  const evidence = {
    schemaVersion: 1,
    kind: 'packaged-extension-lifecycle',
    status: 'running',
    recordedAt: new Date().toISOString(),
    repositoryRevision: process.env.GITHUB_SHA ?? null,
    requestedEditor: editorName,
    requestedEditorVersion: editorVersion,
    extensionId,
    runner: runnerEvidence(),
    offlineBoundary: {
      extensionHost: {
        scope: NETWORK_GUARD_SCOPE,
        requiredInterceptedMethods: STATIC_INTERCEPTED_METHODS,
        optionalAvailableGlobals: OPTIONAL_GLOBAL_INTERCEPTED_METHODS,
        lifetime: NETWORK_GUARD_LIFETIME,
        limitations: NETWORK_GUARD_LIMITATIONS,
      },
      processEnvironment: 'HTTP(S)/ALL proxy points at a closed loopback port; NO_PROXY is empty',
      webview: "packaged CSP is separately required to contain connect-src 'none'",
      postUninstall:
        'No network observer is installed; that phase verifies extension API absence only.',
    },
  };
  let temporaryRoot;

  try {
    if (extensionId !== COMPATIBILITY_PINS.extensionId) {
      throw new Error(`Expected extension ID must be ${COMPATIBILITY_PINS.extensionId}.`);
    }
    if (previousVsixArgument === undefined || previousShaArgument === undefined) {
      throw new Error(
        '--previous-vsix and --previous-vsix-sha256 are both required for the upgrade gate.',
      );
    }
    const manifest = await readManifest();
    const manifestExtensionId = `${manifest.publisher}.${manifest.name}`;
    if (manifestExtensionId !== extensionId) {
      throw new Error(
        `Manifest extension ID ${manifestExtensionId} does not match ${extensionId}.`,
      );
    }
    const candidateVersion = manifest.version;
    if (typeof candidateVersion !== 'string') throw new Error('Manifest version is missing.');
    const candidateSha256 = await sha256File(candidateVsix);
    let previousVsix;
    let previousSha256;
    if (previousVsixArgument !== undefined && previousShaArgument !== undefined) {
      previousVsix = resolve(previousVsixArgument);
      previousSha256 = assertSha256(previousShaArgument, 'Predecessor SHA-256');
      const actualPreviousSha = await sha256File(previousVsix);
      if (actualPreviousSha !== previousSha256) {
        throw new Error('The predecessor VSIX SHA-256 changed after verified download.');
      }
    }

    const editor = await resolveAndVerifyEditor({
      editor: editorName,
      version: editorVersion,
      editorExecutable: optionalArgument(args, 'editor-executable'),
      editorCli: optionalArgument(args, 'editor-cli'),
      editorCachePath: optionalArgument(args, 'editor-cache'),
    });
    Object.assign(evidence, {
      editor: {
        acquisition: editor.acquisition,
        expectedReportedVersion: editor.expectedReportedVersion,
        reported: editor.reported,
        expectedExtensionHostVersion: editor.expectedExtensionHostVersion,
        cli: {
          expectedReportedVersion: editor.expectedReportedVersion,
          reported: editor.reported,
        },
        extensionHost: {
          expectedReportedVersion: editor.expectedExtensionHostVersion,
          reportedVersion: null,
        },
      },
      candidate: {
        id: extensionId,
        version: candidateVersion,
        sha256: candidateSha256,
        file: basename(candidateVsix),
      },
      predecessor:
        previousVsix === undefined
          ? { supplied: false }
          : { supplied: true, sha256: previousSha256, file: basename(previousVsix) },
    });

    await mkdir(evidenceDirectory, { recursive: true });
    temporaryRoot = await mkdtemp(join(tmpdir(), 'okf-wb-'));
    evidence.cleanInstall = await cleanInstallLifecycle({
      editor,
      temporaryRoot,
      workspaceSource,
      extensionId,
      candidateVsix,
      candidateVersion,
      activationReportPath,
      uninstallReportPath: uninstallCleanReportPath,
    });
    evidence.editor.extensionHost.reportedVersion =
      evidence.cleanInstall.activation.editor.versionVerification.reportedExtensionHostVersion;
    evidence.untrustedWorkspace = await untrustedWorkspaceLifecycle({
      editor,
      temporaryRoot,
      workspaceSource,
      extensionId,
      candidateVsix,
      candidateVersion,
      activationReportPath: untrustedActivationReportPath,
      uninstallReportPath: uninstallUntrustedReportPath,
    });
    evidence.upgrade = await upgradeLifecycle({
      editor,
      temporaryRoot,
      workspaceSource,
      extensionId,
      candidateVsix,
      candidateVersion,
      previousVsix,
      upgradeActivationReportPath,
      uninstallReportPath: uninstallUpgradeReportPath,
    });
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = errorMessage(error);
    await writeJson(evidencePath, evidence);
    throw error;
  } finally {
    if (temporaryRoot !== undefined) {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  }

  await writeJson(evidencePath, evidence);
}

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  await main();
}
