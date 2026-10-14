import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: 'e2e/**/*.spec.ts',
  timeout: 30000,
  retries: 1,
  workers: 1,
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:3011',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'auth',
      testMatch: /auth\.spec\.ts/,
      dependencies: ['setup'],
      use: { storageState: undefined },
    },
    {
      name: 'e2e',
      testMatch: /e2e\/(?!auth).*\.spec\.ts/,
      dependencies: ['setup'],
      use: { storageState: './playwright/.auth/user.json' },
    },
  ],
  webServer: {
    command: 'npm run dev:test',
    url: 'http://localhost:3011',
    reuseExistingServer: false,
    timeout: 120000,
    cwd: '.',
  },
});
