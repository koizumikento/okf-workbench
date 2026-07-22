import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/security/**/*.test.ts'],
    restoreMocks: true,
  },
});
