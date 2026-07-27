import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const RELEASE_TAG_PATTERN =
  /^v(?<version>(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/u;
const REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function requireReleaseTag(tag) {
  const match = RELEASE_TAG_PATTERN.exec(tag);
  if (match?.groups?.version === undefined) {
    throw new Error(`Release tag must be v-prefixed SemVer: ${JSON.stringify(tag)}.`);
  }
  return match.groups.version;
}

function requireRepository(repository) {
  if (
    !REPOSITORY_PATTERN.test(repository) ||
    repository.includes('..') ||
    repository.endsWith('.')
  ) {
    throw new Error(
      `Repository must be a safe GitHub owner/name identifier: ${JSON.stringify(repository)}.`,
    );
  }
  return repository;
}

function requireSha256(value, label) {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be 64 lowercase hexadecimal characters.`);
  }
  return value;
}

export function renderPackageManifests(options) {
  const version = requireReleaseTag(options.tag);
  const repository = requireRepository(options.repository);
  const macosArm64Sha256 = requireSha256(options.macosArm64Sha256, 'macOS arm64 SHA-256');
  const macosX64Sha256 = requireSha256(options.macosX64Sha256, 'macOS x64 SHA-256');
  const windowsX64Sha256 = requireSha256(options.windowsX64Sha256, 'Windows x64 SHA-256');
  const releaseBase = `https://github.com/${repository}/releases/download/${options.tag}`;

  const homebrew = `class Okf < Formula
  desc "Offline command-line workbench for Open Knowledge Format bundles"
  homepage "https://github.com/${repository}"
  version "${version}"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "${releaseBase}/okf-cli-macos-aarch64.tar.gz"
      sha256 "${macosArm64Sha256}"
    else
      url "${releaseBase}/okf-cli-macos-x86_64.tar.gz"
      sha256 "${macosX64Sha256}"
    end
  end

  def install
    bin.install "okf"
    prefix.install "LICENSE.txt"
    pkgshare.install "RUST_THIRD_PARTY_NOTICES.md"
  end

  test do
    output = shell_output("#{bin}/okf version")
    assert_match "${version}", output
  end
end
`;

  const scoop = `${JSON.stringify(
    {
      version,
      description: 'Offline command-line workbench for Open Knowledge Format bundles',
      homepage: `https://github.com/${repository}`,
      license: 'MIT',
      architecture: {
        '64bit': {
          url: `${releaseBase}/okf-cli-windows-x86_64.tar.gz`,
          hash: windowsX64Sha256,
          extract_dir: 'okf-cli-windows-x86_64',
        },
      },
      bin: 'okf.exe',
      checkver: {
        github: `https://github.com/${repository}`,
      },
      autoupdate: {
        architecture: {
          '64bit': {
            url: `https://github.com/${repository}/releases/download/v$version/okf-cli-windows-x86_64.tar.gz`,
          },
        },
      },
    },
    null,
    2,
  )}\n`;

  return { homebrew, scoop };
}

export async function writePackageManifests(options) {
  const outputDirectory = resolve(options.outputDirectory);
  const manifests = renderPackageManifests(options);
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(resolve(outputDirectory, 'okf.rb'), manifests.homebrew, 'utf8'),
    writeFile(resolve(outputDirectory, 'okf.json'), manifests.scoop, 'utf8'),
  ]);
  return {
    homebrewPath: resolve(outputDirectory, 'okf.rb'),
    scoopPath: resolve(outputDirectory, 'okf.json'),
  };
}

function parseArguments(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (name === undefined || value === undefined || !name.startsWith('--')) {
      throw new Error(
        'Usage: node scripts/generate-package-manifests.mjs --tag <vSemVer> --repo <owner/name> --macos-arm64-sha <sha256> --macos-x64-sha <sha256> --windows-x64-sha <sha256> --output-dir <path>',
      );
    }
    if (values.has(name)) {
      throw new Error(`Duplicate argument: ${name}.`);
    }
    values.set(name, value);
  }
  const allowed = new Set([
    '--tag',
    '--repo',
    '--macos-arm64-sha',
    '--macos-x64-sha',
    '--windows-x64-sha',
    '--output-dir',
  ]);
  for (const name of values.keys()) {
    if (!allowed.has(name)) {
      throw new Error(`Unknown argument: ${name}.`);
    }
  }
  for (const name of allowed) {
    if (!values.has(name)) {
      throw new Error(`Missing required argument: ${name}.`);
    }
  }
  return {
    tag: values.get('--tag'),
    repository: values.get('--repo'),
    macosArm64Sha256: values.get('--macos-arm64-sha'),
    macosX64Sha256: values.get('--macos-x64-sha'),
    windowsX64Sha256: values.get('--windows-x64-sha'),
    outputDirectory: values.get('--output-dir'),
  };
}

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const paths = await writePackageManifests(parseArguments(process.argv.slice(2)));
  console.log(`Generated ${paths.homebrewPath} and ${paths.scoopPath}.`);
}
