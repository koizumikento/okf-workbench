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
const nodeSecurityGateCommand = 'npm run test:security';
const webviewSecurityGateCommand = 'npm run test:security:webview';
const aggregateSecurityGateCommand = 'npm run test:security:all';
const openVsxReleaseWorkflowPath = '.github/workflows/open-vsx-release.yml';
const openVsxPublishCommand =
  './node_modules/.bin/ovsx publish "release-candidate/${VSIX_NAME}" --skip-duplicate';
const openVsxPublishInvocationPattern = /(?:^|[/\s])ovsx(?:\.cmd)?\b[^\r\n]*\bpublish\b/u;
const openVsxVerifyPatCommand = './node_modules/.bin/ovsx verify-pat straydog';
const requiredSecurityWorkflowGates = Object.freeze({
  '.github/workflows/ci.yml': Object.freeze([
    Object.freeze({ command: nodeSecurityGateCommand, job: 'quality-and-package' }),
    Object.freeze({ command: webviewSecurityGateCommand, job: 'webview-browser' }),
  ]),
  '.github/workflows/compatibility.yml': Object.freeze([
    Object.freeze({ command: nodeSecurityGateCommand, job: 'candidate' }),
    Object.freeze({ command: webviewSecurityGateCommand, job: 'acceptance' }),
  ]),
  '.github/workflows/open-vsx-release.yml': Object.freeze([
    Object.freeze({ command: nodeSecurityGateCommand, job: 'build-candidate' }),
  ]),
  '.github/workflows/package-smoke.yml': Object.freeze([
    Object.freeze({ command: nodeSecurityGateCommand, job: 'package-smoke' }),
    Object.freeze({ command: webviewSecurityGateCommand, job: 'security-boundaries' }),
  ]),
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

function jobCommandLocations(workflow) {
  const locations = [];
  if (!isRecord(workflow?.jobs)) {
    return locations;
  }
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    if (!Array.isArray(job?.steps)) {
      continue;
    }
    job.steps.forEach((step, stepIndex) => {
      for (const command of commandLines(step?.run)) {
        locations.push({ command, job: jobName, step, stepIndex });
      }
    });
  }
  return locations;
}

function hasJobDependency(job, dependency) {
  if (typeof job?.needs === 'string') {
    return job.needs === dependency;
  }
  return Array.isArray(job?.needs) && job.needs.includes(dependency);
}

function canContinueOnError(value) {
  return value !== undefined && value !== false;
}

export function securityWorkflowGateFailures(workflowPath, workflowSource) {
  const requiredGates = requiredSecurityWorkflowGates[workflowPath];
  if (requiredGates === undefined) {
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

  const failures = [];
  const commandLocations = jobCommandLocations(workflow);
  for (const requiredGate of requiredGates) {
    const matches = commandLocations.filter(
      (location) => location.command === requiredGate.command,
    );
    if (matches.length !== 1) {
      failures.push(
        `${workflowPath} must run exactly one ${requiredGate.command} gate; found ${matches.length}.`,
      );
    } else if (matches[0].job !== requiredGate.job) {
      failures.push(
        `${workflowPath} must run ${requiredGate.command} in jobs.${requiredGate.job}; found jobs.${matches[0].job}.`,
      );
    } else {
      const owningJob = workflow?.jobs?.[requiredGate.job];
      const owningStep = matches[0].step;
      if (
        owningJob?.if !== undefined ||
        canContinueOnError(owningJob?.['continue-on-error']) ||
        owningStep?.if !== undefined ||
        canContinueOnError(owningStep?.['continue-on-error'])
      ) {
        failures.push(
          `${workflowPath}:jobs.${requiredGate.job} must run ${requiredGate.command} unconditionally and fail closed.`,
        );
      }
    }
  }

  if (
    workflowPath === '.github/workflows/package-smoke.yml' &&
    !hasJobDependency(workflow?.jobs?.['package-smoke'], 'security-boundaries')
  ) {
    failures.push(
      `${workflowPath}:jobs.package-smoke must need security-boundaries before building cross-platform candidates.`,
    );
  }

  return failures;
}

function collectStringValues(value, output, visited) {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (typeof value !== 'object' || value === null || visited.has(value)) {
    return;
  }
  visited.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry) => collectStringValues(entry, output, visited));
    return;
  }
  Object.values(value).forEach((entry) => collectStringValues(entry, output, visited));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function secretReferenceCount(value, secretName) {
  const escapedName = escapeRegExp(secretName);
  const pattern = new RegExp(
    `secrets(?:\\s*\\.\\s*${escapedName}|\\s*\\[\\s*(['"])${escapedName}\\1\\s*\\])`,
    'gu',
  );
  const strings = [];
  collectStringValues(value, strings, new WeakSet());
  return strings.reduce((count, entry) => count + (entry.match(pattern)?.length ?? 0), 0);
}

function stepUsesSecret(step, secretName) {
  return secretReferenceCount(step, secretName) > 0;
}

function jobNeeds(job, dependency) {
  return job?.needs === dependency || (Array.isArray(job?.needs) && job.needs.includes(dependency));
}

export function releaseWorkflowSafetyFailures(workflowPath, workflowSource) {
  if (workflowPath !== openVsxReleaseWorkflowPath) {
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

  const buildJob = workflow?.jobs?.['build-candidate'];
  const releaseJob = workflow?.jobs?.['github-release'];
  const publishJob = workflow?.jobs?.['publish-openvsx'];
  const steps = publishJob?.steps;
  if (!Array.isArray(steps)) {
    return [`${workflowPath} must define jobs.publish-openvsx.steps.`];
  }

  const failures = [];
  const triggers = workflow?.on;
  if (
    !isRecord(triggers) ||
    !isRecord(triggers.push) ||
    !Array.isArray(triggers.push.tags) ||
    triggers.push.tags.length !== 1 ||
    triggers.push.tags[0] !== 'v*' ||
    Object.keys(triggers).some((trigger) => trigger !== 'push')
  ) {
    failures.push(
      `${workflowPath} must be triggered only by pushed v* tags so a tag is the release authorization.`,
    );
  }
  if (workflow?.permissions?.contents !== 'read') {
    failures.push(`${workflowPath} must default to contents: read.`);
  }
  if (!isRecord(buildJob) || !Array.isArray(buildJob.steps)) {
    failures.push(`${workflowPath} must define jobs.build-candidate.steps.`);
  } else {
    const buildSource = buildJob.steps
      .map((step) => (typeof step?.run === 'string' ? step.run : ''))
      .join('\n');
    if (
      !buildSource.includes('git merge-base --is-ancestor "${GITHUB_SHA}" origin/main') ||
      !buildSource.includes('EXPECTED_TAG="v${VERSION}"') ||
      !buildSource.includes('## ${VERSION} - Unreleased')
    ) {
      failures.push(
        `${workflowPath}:jobs.build-candidate must bind the tag to main, package version, and a dated changelog.`,
      );
    }
    if (secretReferenceCount(buildJob, 'OPEN_VSX_TOKEN') !== 0) {
      failures.push(
        `${workflowPath}:jobs.build-candidate must not receive the Open VSX credential.`,
      );
    }
  }
  if (
    !isRecord(releaseJob) ||
    !Array.isArray(releaseJob.steps) ||
    !jobNeeds(releaseJob, 'build-candidate') ||
    releaseJob?.permissions?.contents !== 'write'
  ) {
    failures.push(
      `${workflowPath}:jobs.github-release must depend on build-candidate and scope contents: write to that job only.`,
    );
  }
  if (
    !jobNeeds(publishJob, 'build-candidate') ||
    !jobNeeds(publishJob, 'github-release') ||
    publishJob?.permissions?.contents === 'write'
  ) {
    failures.push(
      `${workflowPath}:jobs.publish-openvsx must publish only after the candidate and GitHub release, without contents: write.`,
    );
  }
  if (publishJob?.if !== undefined || canContinueOnError(publishJob?.['continue-on-error'])) {
    failures.push(`${workflowPath}:jobs.publish-openvsx must be an unconditional fail-closed job.`);
  }
  const publishInvocations = steps.flatMap((step, index) =>
    commandLines(step?.run)
      .filter((command) => openVsxPublishInvocationPattern.test(command))
      .map((command) => ({ command, index })),
  );
  if (publishInvocations.length !== 1 || publishInvocations[0].command !== openVsxPublishCommand) {
    failures.push(
      `${workflowPath}:jobs.publish-openvsx must run exactly one Open VSX publish invocation and it must use the retained VSIX with duplicate-safe retry semantics; found ${publishInvocations.length}.`,
    );
    return failures;
  }
  const publishIndex = publishInvocations[0].index;
  const publishStep = steps[publishIndex];
  if (canContinueOnError(publishStep?.['continue-on-error'])) {
    failures.push(`${workflowPath}: the irreversible publish command must fail the job on error.`);
  }

  const verifyPatIndices = steps
    .map((step, index) => ({ index, lines: commandLines(step?.run) }))
    .filter(({ lines }) => lines.includes(openVsxVerifyPatCommand))
    .map(({ index }) => index);
  if (verifyPatIndices.length !== 1 || verifyPatIndices[0] >= publishIndex) {
    failures.push(
      `${workflowPath}:jobs.publish-openvsx must verify the straydog PAT exactly once before publication.`,
    );
  } else {
    const verifyPatStep = steps[verifyPatIndices[0]];
    if (
      verifyPatStep?.if !== undefined ||
      canContinueOnError(verifyPatStep?.['continue-on-error'])
    ) {
      failures.push(
        `${workflowPath}: the PAT verification step must run unconditionally and fail closed.`,
      );
    }
  }

  const checksumIndices = steps
    .map((step, index) => ({ index, lines: commandLines(step?.run) }))
    .filter(({ lines }) => lines.includes('sha256sum --check "${VSIX_NAME}.sha256"'))
    .map(({ index }) => index);
  if (
    checksumIndices.length !== 1 ||
    checksumIndices[0] >= (verifyPatIndices[0] ?? Number.NEGATIVE_INFINITY)
  ) {
    failures.push(
      `${workflowPath}:jobs.publish-openvsx must verify the retained checksum before PAT authorization.`,
    );
  }

  const secretStepIndices = steps
    .map((step, index) => ({ index, usesSecret: stepUsesSecret(step, 'OPEN_VSX_TOKEN') }))
    .filter(({ usesSecret }) => usesSecret)
    .map(({ index }) => index);
  const expectedSecretIndices = [verifyPatIndices[0], publishIndex].filter(
    (index) => index !== undefined,
  );
  if (
    secretStepIndices.length !== 2 ||
    secretStepIndices.some((index, position) => index !== expectedSecretIndices[position]) ||
    secretReferenceCount(workflow, 'OPEN_VSX_TOKEN') !== 2
  ) {
    failures.push(
      `${workflowPath}:OPEN_VSX_TOKEN must be exposed only to the PAT verification and publish command steps.`,
    );
  }

  return failures;
}

function pipelineCommands(script) {
  return typeof script === 'string'
    ? script
        .split(/\s*&&\s*/u)
        .map((command) => command.trim())
        .filter(Boolean)
    : [];
}

export function securityPackageScriptFailures(packageManifest) {
  const scripts = packageManifest?.scripts;
  if (!isRecord(scripts)) {
    return ['package.json scripts must define the security test gates.'];
  }

  const failures = [];
  const expectedScripts = Object.freeze({
    'test:security': 'vitest run --config test/security/vitest.config.ts',
    'test:security:webview': 'playwright test --config test/security/playwright.config.ts',
  });
  for (const [name, expected] of Object.entries(expectedScripts)) {
    if (scripts[name] !== expected) {
      failures.push(`package.json scripts.${name} must be exactly ${expected}.`);
    }
  }

  const aggregateCommands = pipelineCommands(scripts['test:security:all']);
  const expectedAggregateCommands = [
    nodeSecurityGateCommand,
    'npm run build',
    webviewSecurityGateCommand,
  ];
  if (
    aggregateCommands.length !== expectedAggregateCommands.length ||
    aggregateCommands.some((command, index) => command !== expectedAggregateCommands[index])
  ) {
    failures.push(
      `package.json scripts.test:security:all must run ${expectedAggregateCommands.join(' then ')} exactly once and in that order.`,
    );
  }

  const checkCommands = pipelineCommands(scripts.check);
  const aggregateCount = checkCommands.filter(
    (command) => command === aggregateSecurityGateCommand,
  ).length;
  if (aggregateCount !== 1) {
    failures.push(
      `package.json scripts.check must run exactly one ${aggregateSecurityGateCommand} gate; found ${aggregateCount}.`,
    );
  }
  if (
    checkCommands.includes(nodeSecurityGateCommand) ||
    checkCommands.includes(webviewSecurityGateCommand)
  ) {
    failures.push(
      'package.json scripts.check must use test:security:all instead of duplicating its component gates.',
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
      ...securityWorkflowGateFailures(relativePath, workflowSource),
      ...releaseWorkflowSafetyFailures(relativePath, workflowSource),
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
  const securityScriptFailures = securityPackageScriptFailures(JSON.parse(packageManifestSource));
  throwPolicyFailures([...workflowFailures, ...installFailures, ...securityScriptFailures]);

  return {
    installScriptDecisionCount: Object.keys(EXPECTED_INSTALL_SCRIPT_DECISIONS).length,
    workflowCount: workflowEntries.length,
  };
}
