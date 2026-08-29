const { defineConfig, devices } = require('@playwright/test');

/**
 * The form is a static site, so tests run against a plain file server. The
 * Supabase client is stubbed inside each test, so no network access and no
 * database credentials are required.
 */
module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry'
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Use the browser already present in the image rather than downloading
        // one. Override with PLAYWRIGHT_CHROMIUM_PATH if it lives elsewhere.
        launchOptions: {
          executablePath:
            process.env.PLAYWRIGHT_CHROMIUM_PATH || '/opt/pw-browsers/chromium'
        }
      }
    }
  ],
  webServer: {
    command: 'python3 -m http.server 4173 --directory public',
    url: 'http://127.0.0.1:4173/index.html',
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore'
  }
});
