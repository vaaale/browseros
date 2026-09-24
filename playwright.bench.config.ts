import { defineConfig } from "@playwright/test";

// Performance benchmarks — run with `npm run test:bench`, NOT part of
// `npm run test:unit`.
//
// These assert ABSOLUTE wall-clock budgets (`avgMs < 0.01`, `perPipelineMs < 2`,
// …), which is only meaningful with the machine to itself. The unit config runs
// `fullyParallel` with one worker per core, so a benchmark there is timed while
// competing with ~15 other workers for CPU: it measures scheduler contention,
// not the code, and fails or passes depending on nothing but what happened to
// run beside it. Hence `workers: 1` here, and no parallelism.
//
// Kept as a separate config rather than a CLI flag on the unit one because
// Playwright has no `--testIgnore` override on the command line — the unit
// config's `testIgnore` cannot be undone per-invocation.
export default defineConfig({
  testDir: "./tests/benchmarks",
  testMatch: /.*\.test\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results/bench",
});
