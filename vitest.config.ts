import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    benchmark: {
      include: ['test/benchmarks/**/*.bench.ts'],
    },
    passWithNoTests: false,
    restoreMocks: true,
  },
});
