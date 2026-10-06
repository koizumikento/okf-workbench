import { defineConfig } from '@vscode/test-cli';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { electronTestGraphicsArguments } from './scripts/compatibility/editor-resolver.mjs';

const profileRoot = process.platform === 'darwin' ? '/tmp' : tmpdir();
const isolatedUserDataDirectory = join(profileRoot, `okf-vscode-${process.pid}`);

export default defineConfig({
  env: {
    OKF_ACCEPTANCE_DRIVER: '1',
    OKF_EXPECTED_VSCODE_VERSION: process.env.VSCODE_TEST_VERSION ?? '1.140.0',
  },
  files: 'test/extension/**/*.test.mjs',
  launchArgs: [
    ...electronTestGraphicsArguments(),
    '--disable-workspace-trust',
    `--user-data-dir=${isolatedUserDataDirectory}`,
  ],
  mocha: {
    timeout: 45_000,
  },
  version: process.env.VSCODE_TEST_VERSION ?? '1.140.0',
  workspaceFolder: './test/fixtures/extension-host.code-workspace',
});
