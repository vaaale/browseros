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
  // `npm run dev` is a single-process Next.js dev server that compiles routes
  // on demand — Playwright's CPU-based default worker count (e.g. 40 on this
  // 80-core box) overwhelms it and causes mass spurious timeouts. Cap workers
  // regardless of core count so the dev server can actually keep up.
  workers: process.env.CI ? 1 : 2,
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
    // Required for every spec using the `@@e2e {...}` scripted-turn format
    // (src/lib/assistant/e2e-provider.ts) — without it, the directive is sent
    // to a REAL model instead of being intercepted, which silently produces
    // nondeterministic (and often much slower) runs rather than a clean
    // failure. Only takes effect when Playwright starts the server itself;
    // reusing an already-running `npm run dev` (reuseExistingServer above)
    // needs this exported in that process's own environment instead.
    env: { BOS_E2E_SCRIPTED: "1" },
  },
});
