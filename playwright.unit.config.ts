import { defineConfig } from "@playwright/test";

// Browser-less unit tests for framework-free core logic (tests/**). No
// webServer, no browser — the Playwright runner is used purely for its TS
// transpilation + reporting:
//   npx playwright test -c playwright.unit.config.ts   (or: npm run test:unit)
//
// Run via `npm run test:unit`, NOT this file's own default `npx playwright
// test -c ...` invocation. That script sets TWO things this suite needs, both
// via NODE_OPTIONS, because a Playwright config cannot set them itself:
//
//   --require ./tests/_no-external-network.cjs  — blocks non-loopback egress in
//     every worker. Not optional hygiene: nothing in src/ short-circuits a model
//     call when no provider is configured (src/lib/agent/llm.ts sends the
//     request with the api key "MISSING"), so any test reaching runSubAgent
//     otherwise hits a REAL provider — a developer's LAN LLM server or the live
//     Anthropic API, depending on the machine — and its verdict then depends on
//     how fast that external service rejects it. See that file's header.
//
//   --conditions=react-server,
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
  //
  // tests/benchmarks asserts ABSOLUTE wall-clock budgets (`avgMs < 0.01`,
  // `perPipelineMs < 2`, …). Those cannot hold in this suite: it runs
  // `fullyParallel` across one worker per core, so a benchmark is timed while
  // competing with ~15 other workers for CPU, and the numbers it measures are
  // contention noise rather than the code's cost. That made it fail
  // intermittently depending only on what happened to be scheduled beside it.
  // It is not a correctness gate, so it does not belong in one — run it with
  // `npm run test:bench`, which gives it the machine to itself (`--workers=1`),
  // where the measurements are both stable and meaningful.
  testIgnore: [/compaction\//, /benchmarks\//],
  fullyParallel: true,
  reporter: [["list"]],
  outputDir: "test-results/unit",
});
