import { defineConfig } from '@vscode/test-cli';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const profileRoot = process.platform === 'darwin' ? '/tmp' : tmpdir();
const isolatedUserDataDirectory = join(profileRoot, `okf-vscode-${process.pid}`);

export default defineConfig({
  env: {
    OKF_ACCEPTANCE_DRIVER: '1',
  },
  files: 'test/extension/**/*.test.mjs',
  launchArgs: ['--disable-workspace-trust', `--user-data-dir=${isolatedUserDataDirectory}`],
  mocha: {
    timeout: 45_000,
  },
  version: process.env.VSCODE_TEST_VERSION ?? 'stable',
  workspaceFolder: './test/fixtures/extension-host.code-workspace',
});
