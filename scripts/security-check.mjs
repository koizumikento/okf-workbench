import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import {
  validatePublicManifestResources,
  validateVsixManifestMarketplaceLinks,
  validateVsixManifestProjectLicense,
} from './package-check.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectLicensePath = resolve(repositoryRoot, 'LICENSE');
const noticesPath = resolve(repositoryRoot, 'THIRD_PARTY_NOTICES.md');
const argumentsList = process.argv.slice(2);
const writeNotices = argumentsList.includes('--write-notices');
const checkNotices = argumentsList.includes('--check-notices') || !writeNotices;
const vsixOptionIndex = argumentsList.indexOf('--vsix');
const vsixPath = vsixOptionIndex < 0 ? undefined : argumentsList.at(vsixOptionIndex + 1);

if (vsixOptionIndex >= 0 && vsixPath === undefined) {
  throw new Error(
    'Usage: node scripts/security-check.mjs [--write-notices] [--check-notices] [--vsix <path>]',
  );
}

const packageManifest = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'));
const packageLock = JSON.parse(
  await readFile(resolve(repositoryRoot, 'package-lock.json'), 'utf8'),
);

const exactRuntimeDependencies = new Set([
  '3d-force-graph',
  'micromark',
  'micromark-core-commonmark',
  'micromark-util-decode-string',
  'micromark-util-subtokenize',
  'remark-parse',
  'unified',
  'yaml',
]);
const allowedLicenses = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Unlicense',
  'Zlib',
]);
const forbiddenLicensePattern =
  /(?:AGPL|SSPL|BUSL|BUSL-1\.1|Commons-Clause|Elastic-License|UNLICENSED|SEE LICENSE IN)/iu;
const highRiskLicensePattern =
  /(?:^|[^A-Z])(?:GPL|LGPL|MPL|EPL|CDDL|OSL|EUPL|CPAL)(?:-|[^A-Z]|$)/iu;
const runtimeDependencyRiskPattern =
  /(?:^|[-_/])(?:openai|anthropic|langchain|llamaindex|telemetry|analytics|segment|sentry|axios|node-fetch|got|superagent|oauth|openid|passport|auth0)(?:$|[-_/])/iu;

const failures = [];

function recordFailure(message) {
  failures.push(message);
}

function normalizeText(value) {
  return value.replace(/\r\n?/gu, '\n').trim();
}

function hashText(value) {
  return createHash('sha256').update(value).digest('hex');
}

function classifyLicense(expression) {
  if (typeof expression !== 'string' || expression.trim() === '') {
    return 'missing';
  }
  if (forbiddenLicensePattern.test(expression)) {
    return 'forbidden';
  }
  if (highRiskLicensePattern.test(expression)) {
    return 'high-risk';
  }

  const identifiers = expression
    .replaceAll('(', ' ')
    .replaceAll(')', ' ')
    .split(/\s+(?:AND|OR|WITH)\s+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return identifiers.length > 0 && identifiers.every((entry) => allowedLicenses.has(entry))
    ? 'allowed'
    : 'manual-review';
}

function dependencyNames(metadata) {
  const required = new Set([
    ...Object.keys(metadata.dependencies ?? {}),
    ...Object.keys(metadata.optionalDependencies ?? {}),
  ]);
  for (const name of Object.keys(metadata.peerDependencies ?? {})) {
    if (metadata.peerDependenciesMeta?.[name]?.optional !== true) {
      required.add(name);
    }
  }
  return [...required].sort();
}

function parentPackagePath(packagePath) {
  const marker = packagePath.lastIndexOf('/node_modules/');
  return marker >= 0 ? packagePath.slice(0, marker) : '';
}

function resolveLockedDependency(packages, fromPackagePath, dependencyName) {
  let current = fromPackagePath;
  while (true) {
    const candidate =
      current.length === 0
        ? `node_modules/${dependencyName}`
        : `${current}/node_modules/${dependencyName}`;
    if (Object.hasOwn(packages, candidate)) {
      return candidate;
    }
    if (current.length === 0) {
      return undefined;
    }
    current = parentPackagePath(current);
  }
}

function productionPackagePaths(lock) {
  const packages = lock.packages ?? {};
  const root = packages[''];
  if (root === undefined) {
    throw new Error('package-lock.json does not contain a root package entry.');
  }

  const queue = Object.keys(root.dependencies ?? {})
    .sort()
    .map((name) => {
      const path = resolveLockedDependency(packages, '', name);
      if (path === undefined) {
        throw new Error(`Production dependency ${name} is absent from package-lock.json.`);
      }
      return path;
    });
  const visited = new Set();

  while (queue.length > 0) {
    const packagePath = queue.shift();
    if (packagePath === undefined || visited.has(packagePath)) {
      continue;
    }
    const metadata = packages[packagePath];
    if (metadata === undefined) {
      throw new Error(`Locked package metadata is missing for ${packagePath}.`);
    }
    visited.add(packagePath);
    for (const name of dependencyNames(metadata)) {
      const resolved = resolveLockedDependency(packages, packagePath, name);
      if (resolved === undefined) {
        if (Object.hasOwn(metadata.optionalDependencies ?? {}, name)) {
          continue;
        }
        throw new Error(`${packagePath} requires ${name}, which is absent from package-lock.json.`);
      }
      queue.push(resolved);
    }
  }

  return [...visited].sort();
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function licenseFiles(packageDirectory) {
  const entries = await readdir(packageDirectory, { withFileTypes: true });
  return entries
    .filter(
      (entry) => entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:\.|$)/iu.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function buildInventory() {
  const packages = packageLock.packages ?? {};
  const reachable = productionPackagePaths(packageLock);
  const lockProduction = Object.entries(packages)
    .filter(([path, metadata]) => path.startsWith('node_modules/') && metadata.dev !== true)
    .map(([path]) => path)
    .sort();
  const unreachable = lockProduction.filter((path) => !reachable.includes(path));
  const unmarked = reachable.filter((path) => !lockProduction.includes(path));
  if (unreachable.length > 0 || unmarked.length > 0) {
    recordFailure(
      `Production lock graph mismatch. Unreachable production entries: ${unreachable.join(', ') || 'none'}; reachable entries marked dev-only: ${unmarked.join(', ') || 'none'}.`,
    );
  }

  const inventory = [];
  const textBlocks = new Map();
  for (const packagePath of reachable) {
    const lockMetadata = packages[packagePath];
    const packageDirectory = resolve(repositoryRoot, packagePath);
    const installedManifestPath = resolve(packageDirectory, 'package.json');
    if (!(await isFile(installedManifestPath))) {
      recordFailure(`Installed production manifest is missing: ${packagePath}/package.json.`);
      continue;
    }
    const installedManifest = JSON.parse(await readFile(installedManifestPath, 'utf8'));
    const license = installedManifest.license ?? lockMetadata.license;
    const classification = classifyLicense(license);
    if (classification !== 'allowed') {
      recordFailure(
        `${installedManifest.name ?? packagePath}@${installedManifest.version ?? lockMetadata.version ?? 'unknown'} has ${classification} license metadata: ${String(license ?? '(missing)')}.`,
      );
    }
    if (
      typeof lockMetadata.integrity !== 'string' ||
      !lockMetadata.integrity.startsWith('sha512-')
    ) {
      recordFailure(`${packagePath} lacks a SHA-512 lockfile integrity value.`);
    }
    if (
      typeof lockMetadata.resolved !== 'string' ||
      !lockMetadata.resolved.startsWith('https://registry.npmjs.org/')
    ) {
      recordFailure(`${packagePath} does not resolve from the approved HTTPS npm registry.`);
    }
    if (lockMetadata.hasInstallScript === true) {
      recordFailure(`${packagePath} has an install script in the production graph.`);
    }

    const files = await licenseFiles(packageDirectory);
    if (files.length === 0) {
      recordFailure(`${packagePath} has no top-level LICENSE, COPYING, or NOTICE file.`);
    }
    const textReferences = [];
    for (const file of files) {
      const content = normalizeText(await readFile(resolve(packageDirectory, file), 'utf8'));
      if (content.length === 0) {
        recordFailure(`${packagePath}/${file} is empty.`);
        continue;
      }
      const hash = hashText(content);
      textReferences.push(hash);
      const existing = textBlocks.get(hash);
      if (existing === undefined) {
        textBlocks.set(hash, {
          content,
          packages: [`${installedManifest.name}@${installedManifest.version}`],
          sourceFiles: [`${packagePath}/${file}`],
        });
      } else {
        existing.packages.push(`${installedManifest.name}@${installedManifest.version}`);
        existing.sourceFiles.push(`${packagePath}/${file}`);
      }
    }

    inventory.push({
      classification,
      license: typeof license === 'string' ? license : '(missing)',
      name: installedManifest.name ?? packagePath.replace(/^node_modules\//u, ''),
      packagePath,
      textReferences: [...new Set(textReferences)].sort(),
      version: installedManifest.version ?? lockMetadata.version ?? 'unknown',
    });
  }
  inventory.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.version.localeCompare(right.version) ||
      left.packagePath.localeCompare(right.packagePath),
  );
  for (const block of textBlocks.values()) {
    block.packages.sort();
    block.sourceFiles.sort();
  }
  return { inventory, textBlocks };
}

function escapeTable(value) {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function renderNotices(inventory, textBlocks) {
  const lines = [
    '<!-- Generated by scripts/security-check.mjs --write-notices; do not edit manually. -->',
    '',
    '# Third-Party Notices',
    '',
    'OKF Workbench bundles the production packages listed below. The inventory is derived deterministically from the committed `package-lock.json` production dependency graph and the installed package manifests. Development-only dependencies are excluded.',
    '',
    'License classification is a release-engineering gate, not legal advice. `allowed` means the SPDX expression is on the repository permissive-license allowlist; any other classification requires resolution before packaging.',
    '',
    `Production package count: **${inventory.length}**`,
    '',
    '<!-- prettier-ignore-start -->',
    '',
    '| Package | Version | License | Classification | Notice text |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const entry of inventory) {
    const packageName = escapeTable(entry.name);
    const npmName = encodeURIComponent(entry.name).replaceAll('%2F', '/');
    const references = entry.textReferences
      .map((hash) => `[${hash.slice(0, 12)}](#notice-${hash})`)
      .join(', ');
    lines.push(
      `| [${packageName}](https://www.npmjs.com/package/${npmName}/v/${entry.version}) | ${escapeTable(entry.version)} | ${escapeTable(entry.license)} | ${entry.classification} | ${references || '(missing)'} |`,
    );
  }

  lines.push('', '<!-- prettier-ignore-end -->', '', '## License and notice texts', '');
  const blocks = [...textBlocks.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (const [hash, block] of blocks) {
    lines.push(
      `<a id="notice-${hash}"></a>`,
      '',
      `### ${hash.slice(0, 12)}`,
      '',
      `Packages: ${block.packages.map((value) => `\`${value}\``).join(', ')}`,
      '',
      `Source files: ${block.sourceFiles.map((value) => `\`${value}\``).join(', ')}`,
      '',
      '<pre>',
      escapeHtml(block.content),
      '</pre>',
      '',
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

async function walkFiles(root, extensions) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) continue;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) {
        files.push(path);
      }
    }
  }
  return files.sort();
}

async function reviewFirstPartySources() {
  const sourceFiles = await walkFiles(resolve(repositoryRoot, 'src'), ['.ts', '.css']);
  const networkPatterns = [
    { label: 'fetch', pattern: /\bfetch\s*\(/u },
    { label: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/u },
    { label: 'WebSocket', pattern: /\bWebSocket\b/u },
    { label: 'EventSource', pattern: /\bEventSource\b/u },
    { label: 'sendBeacon', pattern: /\bsendBeacon\b/u },
    { label: 'Node HTTP import', pattern: /(?:from\s+|import\s*\()['"](?:node:)?https?['"]/u },
  ];
  const privilegedApiPatterns = [
    {
      label: 'VS Code authentication API',
      pattern: /\bauthentication\.(?:getSession|onDidChangeSessions)\b/u,
    },
    {
      label: 'VS Code telemetry API',
      pattern: /\b(?:createTelemetryLogger|isTelemetryEnabled|onDidChangeTelemetryEnabled)\b/u,
    },
    { label: 'stable editor identifier', pattern: /\benv\.(?:machineId|sessionId)\b/u },
    { label: 'external URI opener', pattern: /\b(?:openExternal|asExternalUri)\s*\(/u },
  ];
  const unsafeDomPatterns = [
    { label: 'innerHTML', pattern: /\.innerHTML\b/u },
    { label: 'outerHTML', pattern: /\.outerHTML\b/u },
    { label: 'insertAdjacentHTML', pattern: /\.insertAdjacentHTML\s*\(/u },
    { label: 'document.write', pattern: /\bdocument\.write\s*\(/u },
    { label: 'eval', pattern: /\beval\s*\(/u },
    { label: 'Function constructor', pattern: /\bnew\s+Function\s*\(/u },
  ];
  const sensitiveLoggingPattern =
    /(?:console|output|logger)\.(?:trace|debug|info|warn|error|log|appendLine)\s*\([\s\S]{0,600}?(?:proposedText|frontmatter|rawTarget|\.body\b|\.content\b|getText\s*\(|apiKey|password|secret|token)[\s\S]{0,600}?\)/u;

  for (const file of sourceFiles) {
    const relative = file.slice(repositoryRoot.length + 1);
    const content = await readFile(file, 'utf8');
    for (const candidate of [...networkPatterns, ...privilegedApiPatterns]) {
      if (candidate.pattern.test(content)) {
        recordFailure(`${relative} contains first-party ${candidate.label} usage.`);
      }
    }
    if (/\bhttps?:\/\//u.test(content)) {
      recordFailure(`${relative} contains a remote URL in first-party runtime source.`);
    }
    if (/\bconsole\.(?:trace|debug|info|warn|error|log)\s*\(/u.test(content)) {
      recordFailure(`${relative} writes directly to the console.`);
    }
    if (sensitiveLoggingPattern.test(content)) {
      recordFailure(`${relative} may log workspace content or secret-bearing values.`);
    }
    if (relative.startsWith('src/webview/')) {
      for (const candidate of unsafeDomPatterns) {
        if (candidate.pattern.test(content)) {
          recordFailure(`${relative} contains unsafe DOM sink ${candidate.label}.`);
        }
      }
    }
  }
}

function reviewManifest() {
  if (packageManifest.license !== 'MIT') {
    recordFailure(
      `The project manifest license must be exactly MIT; found ${String(packageManifest.license ?? '(missing)')}.`,
    );
  }
  if (packageLock.packages?.['']?.license !== 'MIT') {
    recordFailure(
      `The root lockfile license must be exactly MIT; found ${String(packageLock.packages?.['']?.license ?? '(missing)')}.`,
    );
  }
  try {
    validatePublicManifestResources(packageManifest);
  } catch (error) {
    recordFailure(error instanceof Error ? error.message : String(error));
  }
  const runtimeDependencies = Object.keys(packageManifest.dependencies ?? {}).sort();
  const unexpected = runtimeDependencies.filter((name) => !exactRuntimeDependencies.has(name));
  const missing = [...exactRuntimeDependencies].filter(
    (name) => !runtimeDependencies.includes(name),
  );
  if (unexpected.length > 0 || missing.length > 0) {
    recordFailure(
      `Runtime dependency boundary changed. Unexpected: ${unexpected.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'}.`,
    );
  }
  for (const [name, version] of Object.entries(packageManifest.dependencies ?? {})) {
    if (runtimeDependencyRiskPattern.test(name)) {
      recordFailure(
        `Runtime dependency ${name} introduces an AI, account, telemetry, or HTTP-client boundary.`,
      );
    }
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
      recordFailure(
        `Runtime dependency ${name} is not pinned to an exact version: ${String(version)}.`,
      );
    }
  }
  if (packageManifest.contributes?.authentication !== undefined) {
    recordFailure('The extension manifest contributes an authentication provider.');
  }
}

function parseZip(archive) {
  const endSignature = 0x06054b50;
  const centralSignature = 0x02014b50;
  const localSignature = 0x04034b50;
  const minimumEndOffset = Math.max(0, archive.length - 65_557);
  let endOffset = -1;
  for (let offset = archive.length - 22; offset >= minimumEndOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) === endSignature) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) {
    throw new Error('The VSIX does not contain a valid ZIP end record.');
  }

  const entries = new Map();
  const entryCount = archive.readUInt16LE(endOffset + 10);
  let centralOffset = archive.readUInt32LE(endOffset + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(centralOffset) !== centralSignature) {
      throw new Error(`Invalid central-directory entry at offset ${centralOffset}.`);
    }
    const compression = archive.readUInt16LE(centralOffset + 10);
    const compressedSize = archive.readUInt32LE(centralOffset + 20);
    const uncompressedSize = archive.readUInt32LE(centralOffset + 24);
    const fileNameLength = archive.readUInt16LE(centralOffset + 28);
    const extraLength = archive.readUInt16LE(centralOffset + 30);
    const commentLength = archive.readUInt16LE(centralOffset + 32);
    const localOffset = archive.readUInt32LE(centralOffset + 42);
    const name = archive
      .subarray(centralOffset + 46, centralOffset + 46 + fileNameLength)
      .toString('utf8');
    if (entries.has(name)) {
      throw new Error(`Duplicate VSIX entry is not allowed: ${name}`);
    }
    entries.set(name, { compression, compressedSize, localOffset, uncompressedSize });
    centralOffset += 46 + fileNameLength + extraLength + commentLength;
  }

  const readEntry = (name) => {
    const entry = entries.get(name);
    if (entry === undefined) return undefined;
    if (archive.readUInt32LE(entry.localOffset) !== localSignature) {
      throw new Error(`Invalid local ZIP entry for ${name}.`);
    }
    const fileNameLength = archive.readUInt16LE(entry.localOffset + 26);
    const extraLength = archive.readUInt16LE(entry.localOffset + 28);
    const dataOffset = entry.localOffset + 30 + fileNameLength + extraLength;
    const compressed = archive.subarray(dataOffset, dataOffset + entry.compressedSize);
    const content =
      entry.compression === 0
        ? compressed
        : entry.compression === 8
          ? inflateRawSync(compressed)
          : undefined;
    if (content === undefined) {
      throw new Error(`Unsupported ZIP compression method ${entry.compression} for ${name}.`);
    }
    if (content.length !== entry.uncompressedSize) {
      throw new Error(`Uncompressed size mismatch for ${name}.`);
    }
    return content;
  };
  return { entries, readEntry };
}

async function reviewVsix(path, expectedNotices) {
  const [archive, expectedProjectLicense] = await Promise.all([
    readFile(resolve(repositoryRoot, path)),
    readFile(projectLicensePath),
  ]);
  const { entries, readEntry } = parseZip(archive);
  const packagedManifestContent = readEntry('extension/package.json');
  if (packagedManifestContent === undefined) {
    recordFailure('The VSIX does not contain extension/package.json.');
  } else {
    const packagedManifest = JSON.parse(packagedManifestContent.toString('utf8'));
    if (packagedManifest.license !== 'MIT') {
      recordFailure(
        `The packaged project license must be exactly MIT; found ${String(packagedManifest.license ?? '(missing)')}.`,
      );
    }
    try {
      validatePublicManifestResources(packagedManifest);
    } catch (error) {
      recordFailure(error instanceof Error ? error.message : String(error));
    }
  }

  const vsixManifestContent = readEntry('extension.vsixmanifest')?.toString('utf8');
  if (vsixManifestContent === undefined) {
    recordFailure('The VSIX does not contain extension.vsixmanifest.');
  } else {
    try {
      validateVsixManifestProjectLicense(vsixManifestContent);
      validateVsixManifestMarketplaceLinks(vsixManifestContent);
    } catch (error) {
      recordFailure(error instanceof Error ? error.message : String(error));
    }
    const contentLicenseAssets = [
      ...vsixManifestContent.matchAll(
        /<Asset\b[^>]*\bType="Microsoft\.VisualStudio\.Services\.Content\.License"[^>]*\/>/gu,
      ),
    ];
    if (
      contentLicenseAssets.length !== 1 ||
      !/\bPath="extension\/LICENSE\.txt"/u.test(contentLicenseAssets[0][0]) ||
      !/\bAddressable="true"/u.test(contentLicenseAssets[0][0])
    ) {
      recordFailure(
        'extension.vsixmanifest must contain exactly one canonical addressable project-license asset.',
      );
    }
  }

  const noticesEntry = [...entries.keys()].find(
    (name) => name.toLowerCase() === 'extension/third_party_notices.md',
  );
  if (noticesEntry === undefined) {
    recordFailure('The VSIX does not contain extension/THIRD_PARTY_NOTICES.md.');
  } else if (readEntry(noticesEntry).toString('utf8') !== expectedNotices) {
    recordFailure('The packaged THIRD_PARTY_NOTICES.md does not match the production graph.');
  }

  for (const packagedDocument of ['extension/readme.md', 'extension/changelog.md']) {
    const content = readEntry(packagedDocument)?.toString('utf8');
    if (content === undefined) {
      recordFailure(`The packaged reader-facing document is missing: ${packagedDocument}.`);
    } else if (
      /\]\((?:\.\/)?docs\//iu.test(content) ||
      /github\.com\/koizumikento\/okf-workbench\/releases\/tag\/v0\.1\.0/iu.test(content)
    ) {
      recordFailure(
        `${packagedDocument} contains an excluded documentation or unpublished release link.`,
      );
    }
  }

  const projectLicenseEntries = [...entries.keys()].filter((name) =>
    /^extension\/licen[cs]e(?:\.[^/]+)?$/iu.test(name),
  );
  if (projectLicenseEntries.length !== 1 || projectLicenseEntries[0] !== 'extension/LICENSE.txt') {
    recordFailure(
      `The VSIX must contain only the VSCE-canonical project license extension/LICENSE.txt; found ${projectLicenseEntries.join(', ') || 'none'}.`,
    );
  } else {
    const packagedProjectLicense = readEntry('extension/LICENSE.txt');
    if (!packagedProjectLicense.equals(expectedProjectLicense)) {
      recordFailure(
        'The packaged project license extension/LICENSE.txt does not exactly match the repository LICENSE.',
      );
    }
  }

  for (const asset of ['extension/dist/webview/main.css', 'extension/dist/webview/main.js']) {
    const content = readEntry(asset)?.toString('utf8');
    if (content === undefined) {
      recordFailure(`The packaged Webview asset is missing: ${asset}.`);
      continue;
    }
    const remoteAssetPattern = asset.endsWith('.css')
      ? /(?:@import\s+|url\(\s*)['"]?https?:\/\//u
      : /(?:import\s*\(|\bfrom\s+|\bsrc\s*=\s*|\bhref\s*=\s*)['"]https?:\/\//u;
    if (remoteAssetPattern.test(content)) {
      recordFailure(`${asset} contains a remote runtime asset reference.`);
    }
  }

  const webviewScript = readEntry('extension/dist/webview/main.js')?.toString('utf8') ?? '';
  for (const privilegedField of ['bundleRootUri', 'proposedText', 'sourceUri', 'workspace.fs']) {
    if (webviewScript.includes(privilegedField)) {
      recordFailure(`The Webview bundle contains privileged host field ${privilegedField}.`);
    }
  }
}

reviewManifest();
await reviewFirstPartySources();
const { inventory, textBlocks } = await buildInventory();
const expectedNotices = renderNotices(inventory, textBlocks);

if (writeNotices) {
  await writeFile(noticesPath, expectedNotices, 'utf8');
}
if (checkNotices) {
  if (!(await isFile(noticesPath))) {
    recordFailure('THIRD_PARTY_NOTICES.md is missing; run with --write-notices.');
  } else if ((await readFile(noticesPath, 'utf8')) !== expectedNotices) {
    recordFailure('THIRD_PARTY_NOTICES.md is stale; run with --write-notices.');
  }
}
if (vsixPath !== undefined) {
  await reviewVsix(vsixPath, expectedNotices);
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`SECURITY CHECK FAILED: ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Security gate passed for ${inventory.length} exact production packages${vsixPath === undefined ? '' : ' and the packaged VSIX'}.`,
  );
}
