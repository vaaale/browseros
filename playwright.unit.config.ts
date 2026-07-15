import { defineConfig } from "@playwright/test";

// Browser-less unit tests for framework-free core logic (tests/**). No
// webServer, no browser — the Playwright runner is used purely for its TS
// transpilation + reporting:
//   npx playwright test -c playwright.unit.config.ts   (or: npm run test:unit)
export default defineConfig({
  testDir: "./tests",
  testMatch: /.*\.test\.ts/,
  // tests/compaction uses node:test (run via `node --test`), not the Playwright
  // runner — exclude it here so it isn't loaded with the wrong harness.
  testIgnore: /compaction\//,
  fullyParallel: true,
  reporter: [["list"]],
  outputDir: "test-results/unit",
});
