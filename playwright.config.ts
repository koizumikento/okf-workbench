import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/webview',
  outputDir: './test-results',
  reporter: [['html', { open: 'never', outputFolder: 'playwright-report' }], ['list']],
  use: {
    browserName: 'chromium',
    headless: true,
  },
});
