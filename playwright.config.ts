import { defineConfig, devices } from "@playwright/test";

// E2E configuration for BrowserOS self-testing (see specs/008-self-testing/spec.md).
// Tests run against a real production-like app on BASE_URL. `reuseExistingServer`
// means a dev server already running on :3000 is reused; otherwise Playwright
// starts `npm run dev` for the run.
const BASE_URL = process.env.BOS_E2E_BASE_URL || "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["list"], ["html", { open: "never" }]],
  outputDir: "test-results",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  // Use system Google Chrome (channel) rather than Playwright's bundled
  // Chromium, which isn't downloaded in this environment.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: "chrome" } }],
  webServer: {
    command: "npm run dev",
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
