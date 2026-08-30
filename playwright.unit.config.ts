import { defineConfig } from "@playwright/test";

// Browser-less unit tests for framework-free core logic (tests/**). No
// webServer, no browser — the Playwright runner is used purely for its TS
// transpilation + reporting:
//   npx playwright test -c playwright.unit.config.ts   (or: npm run test:unit)
//
// Run via `npm run test:unit`, NOT this file's own default `npx playwright
// test -c ...` invocation: that script sets `NODE_OPTIONS=--conditions=react-server`,
// which is required for any test that transitively imports a module starting
// with `import "server-only"` (most of src/lib/gitops/**). The `server-only`
// package's package.json only resolves to a harmless empty stub under the
// "react-server" export condition (the one Next.js's own bundler sets when
// building the server bundle) — Playwright's TS transform has no idea that
// condition exists, so without it every such import throws
// "This module cannot be imported from a Client Component module" the
// instant the test file loads, before a single test runs. Running this file
// directly via `npx playwright test -c playwright.unit.config.ts` (skipping
// the npm script) will reproduce that failure for any test importing such a
// module.
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
