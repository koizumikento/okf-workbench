import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  root: repositoryRoot,
  test: {
    environment: 'node',
    include: ['test/acceptance/**/*.test.ts'],
    passWithNoTests: false,
    restoreMocks: true,
    unstubGlobals: true,
  },
});
