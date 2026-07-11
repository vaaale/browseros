import { defineConfig } from "@playwright/test";

// Browser-less unit tests for the framework-free assistant run core
// (tests/assistant/**). No webServer, no browser — the Playwright runner is
// used purely for its TS transpilation + reporting:
//   npx playwright test -c playwright.unit.config.ts
export default defineConfig({
  testDir: "./tests/assistant",
  testMatch: /.*\.test\.ts/,
  fullyParallel: true,
  reporter: [["list"]],
  outputDir: "test-results/unit",
});
