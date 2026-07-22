import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['webview-injection.spec.ts'],
  outputDir: '../../test-results/security',
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    headless: true,
  },
});
