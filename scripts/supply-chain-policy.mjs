import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { parse } from 'yaml';

const immutableActionReferencePattern =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s]+)?@[0-9a-f]{40}$/u;
const exactVersionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const installLifecycleScripts = Object.freeze([
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'preprepare',
  'prepare',
  'postprepare',
]);
const licenseNoticeGateCommand = 'node scripts/security-check.mjs --check-notices';
const requiredLicenseNoticeGateJobs = Object.freeze({
  '.github/workflows/ci.yml': 'quality-and-package',
  '.github/workflows/open-vsx-release.yml': 'build-candidate',
});

export const EXPECTED_INSTALL_SCRIPT_DECISIONS = Object.freeze({
  '@vscode/vsce-sign@2.0.9': true,
  'esbuild@0.28.1': true,
  'fsevents@2.3.2': false,
  'fsevents@2.3.3': false,
  'keytar@7.9.0': true,
});

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatValue(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function collectUses(value, location, output, visited) {
  if (typeof value !== 'object' || value === null || visited.has(value)) {
    return;
  }
  visited.add(value);

  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectUses(entry, `${location}[${index}]`, output, visited));
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    const entryLocation = location.length === 0 ? key : `${location}.${key}`;
    if (key === 'uses') {
      output.push({ location: entryLocation, value: entry });
    } else {
      collectUses(entry, entryLocation, output, visited);
    }
  }
}

export function workflowActionReferenceFailures(workflowPath, workflowSource) {
  let workflow;
  try {
    workflow = parse(workflowSource);
  } catch (error) {
    return [
      `${workflowPath} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }

  const references = [];
  collectUses(workflow, '', references, new WeakSet());
  return references
    .filter(
      (reference) =>
        typeof reference.value !== 'string' ||
        !immutableActionReferencePattern.test(reference.value),
    )
    .map(
      (reference) =>
        `${workflowPath}:${reference.location} must pin an external action or reusable workflow to a full lowercase 40-character commit SHA; found ${formatValue(reference.value)}.`,
    );
}

function commandLines(run) {
  return typeof run === 'string'
    ? run
        .replace(/\r\n?/gu, '\n')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

export function licenseNoticeWorkflowFailures(workflowPath, workflowSource) {
  const requiredJob = requiredLicenseNoticeGateJobs[workflowPath];
  if (requiredJob === undefined) {
    return [];
  }

  let workflow;
  try {
    workflow = parse(workflowSource);
  } catch (error) {
    return [
      `${workflowPath} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }

  const steps = workflow?.jobs?.[requiredJob]?.steps;
  if (!Array.isArray(steps)) {
    return [`${workflowPath} must define jobs.${requiredJob}.steps.`];
  }

  const installStep = steps.findIndex((step) => commandLines(step?.run).includes('npm ci'));
  const gateSteps = steps
    .map((step, index) => ({ index, lines: commandLines(step?.run) }))
    .filter(({ lines }) => lines.includes(licenseNoticeGateCommand));
  const failures = [];
  if (gateSteps.length !== 1) {
    failures.push(
      `${workflowPath}:jobs.${requiredJob} must run exactly one canonical production license and notice gate (${licenseNoticeGateCommand}); found ${gateSteps.length}.`,
    );
  }
  if (installStep < 0) {
    failures.push(`${workflowPath}:jobs.${requiredJob} must install with npm ci.`);
  } else if (gateSteps.some(({ index }) => index <= installStep)) {
    failures.push(
      `${workflowPath}:jobs.${requiredJob} must run the production license and notice gate after npm ci.`,
    );
  }
  return failures;
}

function npmrcSettingValues(source, setting) {
  const values = [];
  for (const rawLine of source.replace(/\r\n?/gu, '\n').split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator < 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (key === setting) {
      values.push(line.slice(separator + 1).trim());
    }
  }
  return values;
}

function packageNameFromLockPath(packagePath, metadata) {
  if (typeof metadata.name === 'string' && metadata.name.length > 0) {
    return metadata.name;
  }
  const normalized = packagePath.replace(/^node_modules\//u, '');
  return normalized.split('/node_modules/').at(-1);
}

export function installScriptPolicyFailures({ npmrc, packageManifest, packageLock }) {
  const failures = [];
  const strictValues = npmrcSettingValues(npmrc, 'strict-allow-scripts');
  if (strictValues.length !== 1 || strictValues[0] !== 'true') {
    failures.push(
      `.npmrc must contain exactly one active strict-allow-scripts=true setting; found ${strictValues.length === 0 ? 'none' : strictValues.join(', ')}.`,
    );
  }

  const configured = packageManifest.allowScripts;
  if (!isRecord(configured)) {
    failures.push('package.json allowScripts must be an object containing the reviewed decisions.');
  } else {
    for (const [identity, expectedDecision] of Object.entries(EXPECTED_INSTALL_SCRIPT_DECISIONS)) {
      if (!Object.hasOwn(configured, identity)) {
        failures.push(`package.json allowScripts is missing reviewed decision ${identity}.`);
      } else if (configured[identity] !== expectedDecision) {
        failures.push(
          `package.json allowScripts decision for ${identity} must remain ${String(expectedDecision)}; found ${formatValue(configured[identity])}.`,
        );
      }
    }
    for (const [identity, decision] of Object.entries(configured)) {
      if (!Object.hasOwn(EXPECTED_INSTALL_SCRIPT_DECISIONS, identity)) {
        failures.push(`package.json allowScripts contains unreviewed entry ${identity}.`);
      }
      const separator = identity.lastIndexOf('@');
      const version = separator < 0 ? '' : identity.slice(separator + 1);
      if (!exactVersionPattern.test(version)) {
        failures.push(
          `package.json allowScripts entry is not pinned to an exact version: ${identity}.`,
        );
      }
      if (typeof decision !== 'boolean') {
        failures.push(`package.json allowScripts decision must be boolean for ${identity}.`);
      }
    }
  }

  if (!isRecord(packageLock.packages)) {
    failures.push('package-lock.json must contain a packages object.');
  } else {
    const lockedInstallScripts = new Set();
    for (const [packagePath, metadata] of Object.entries(packageLock.packages)) {
      if (!isRecord(metadata) || metadata.hasInstallScript !== true) {
        continue;
      }
      if (packagePath.length === 0) {
        failures.push('The root package must not define an install lifecycle script.');
        continue;
      }
      const name = packageNameFromLockPath(packagePath, metadata);
      const version = metadata.version;
      if (typeof name !== 'string' || name.length === 0 || typeof version !== 'string') {
        failures.push(`Cannot resolve the install-script package identity at ${packagePath}.`);
        continue;
      }
      lockedInstallScripts.add(`${name}@${version}`);
    }

    for (const identity of lockedInstallScripts) {
      if (!Object.hasOwn(EXPECTED_INSTALL_SCRIPT_DECISIONS, identity)) {
        failures.push(`package-lock.json contains unreviewed install script ${identity}.`);
      }
    }
    for (const identity of Object.keys(EXPECTED_INSTALL_SCRIPT_DECISIONS)) {
      if (!lockedInstallScripts.has(identity)) {
        failures.push(
          `Reviewed install-script decision is stale because ${identity} is absent from package-lock.json.`,
        );
      }
    }
  }

  const rootScripts = packageManifest.scripts;
  if (rootScripts !== undefined && !isRecord(rootScripts)) {
    failures.push('package.json scripts must be an object.');
  } else if (isRecord(rootScripts)) {
    for (const lifecycle of installLifecycleScripts) {
      if (Object.hasOwn(rootScripts, lifecycle)) {
        failures.push(`The root package contains forbidden install lifecycle script ${lifecycle}.`);
      }
    }
  }

  return failures;
}

function throwPolicyFailures(failures) {
  if (failures.length > 0) {
    throw new Error(`Supply-chain policy failed:\n- ${failures.join('\n- ')}`);
  }
}

export async function validateRepositorySupplyChainPolicy(repositoryRoot) {
  const workflowDirectory = resolve(repositoryRoot, '.github', 'workflows');
  const workflowEntries = (await readdir(workflowDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.ya?ml$/iu.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (workflowEntries.length === 0) {
    throw new Error('Supply-chain policy failed: no GitHub Actions workflow files were found.');
  }

  const workflowFailures = [];
  for (const entry of workflowEntries) {
    const relativePath = `.github/workflows/${entry.name}`;
    const workflowSource = await readFile(resolve(workflowDirectory, entry.name), 'utf8');
    workflowFailures.push(
      ...workflowActionReferenceFailures(relativePath, workflowSource),
      ...licenseNoticeWorkflowFailures(relativePath, workflowSource),
    );
  }

  const [npmrc, packageManifestSource, packageLockSource] = await Promise.all([
    readFile(resolve(repositoryRoot, '.npmrc'), 'utf8'),
    readFile(resolve(repositoryRoot, 'package.json'), 'utf8'),
    readFile(resolve(repositoryRoot, 'package-lock.json'), 'utf8'),
  ]);
  const installFailures = installScriptPolicyFailures({
    npmrc,
    packageManifest: JSON.parse(packageManifestSource),
    packageLock: JSON.parse(packageLockSource),
  });
  throwPolicyFailures([...workflowFailures, ...installFailures]);

  return {
    installScriptDecisionCount: Object.keys(EXPECTED_INSTALL_SCRIPT_DECISIONS).length,
    workflowCount: workflowEntries.length,
  };
}
