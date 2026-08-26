import { defineConfig, devices } from '@playwright/test';

/**
 * Browser matrix.
 *
 * `chromium` here is Playwright's bundled headless Chromium, which on most CI
 * machines has **no platform HEVC decoder** — so the WebCodecs path does not
 * exercise there and its tests skip themselves rather than silently passing.
 * A green CI badge must not be read as "the primary path is tested".
 *
 * The `chrome-hevc` project points at a real installed Chromium-family browser
 * (set HEIC_CHROME to its executable) where platform HEVC is available. That is
 * the project that actually covers strategy 2.
 */
const chromeExecutable = process.env.HEIC_CHROME;

export default defineConfig({
  testDir: 'test/browser',
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 120_000,
  webServer: {
    command: 'node tools/serve.mjs',
    url: 'http://127.0.0.1:8931/test/browser/harness.html',
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
  },
  use: {
    baseURL: 'http://127.0.0.1:8931',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: undefined } },
    ...(chromeExecutable
      ? [
          {
            name: 'chrome-hevc',
            use: {
              ...devices['Desktop Chrome'],
              launchOptions: { executablePath: chromeExecutable },
            },
          },
        ]
      : []),
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
