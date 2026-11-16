import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Resource-boundary fixtures must not compete with other suites for runner CPU.
    fileParallelism: false,
    include: ['test/unit/**/*.test.ts'],
    benchmark: {
      include: ['test/benchmarks/**/*.bench.ts'],
    },
    passWithNoTests: false,
    restoreMocks: true,
  },
});
