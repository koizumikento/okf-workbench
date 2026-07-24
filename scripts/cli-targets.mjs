export const BUNDLED_CLI_TARGETS = Object.freeze({
  'darwin-arm64': Object.freeze({
    binary: 'okf',
    releaseLabel: 'macos-aarch64',
    runner: 'macos-15',
  }),
  'darwin-x64': Object.freeze({
    binary: 'okf',
    releaseLabel: 'macos-x86_64',
    runner: 'macos-15-intel',
  }),
  'linux-x64': Object.freeze({
    binary: 'okf',
    releaseLabel: 'linux-x86_64',
    runner: 'ubuntu-24.04',
  }),
  'win32-x64': Object.freeze({
    binary: 'okf.exe',
    releaseLabel: 'windows-x86_64',
    runner: 'windows-2025',
  }),
});

export const BUNDLED_CLI_TARGET_NAMES = Object.freeze(Object.keys(BUNDLED_CLI_TARGETS).sort());

export function requireBundledCliTarget(target) {
  if (typeof target !== 'string' || !Object.hasOwn(BUNDLED_CLI_TARGETS, target)) {
    throw new Error(
      `Unsupported bundled CLI target ${JSON.stringify(target)}; expected one of ${BUNDLED_CLI_TARGET_NAMES.join(', ')}.`,
    );
  }
  return BUNDLED_CLI_TARGETS[target];
}
