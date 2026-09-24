import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import * as specfs from "@/lib/dev/spec-fs";
import { listStores } from "@/lib/specs/stores";

export const dynamic = "force-dynamic";

// POST /api/specs/run-tests { featurePath, branch? } -> { summary, ok, ... } | { error }
// Runs the Playwright e2e suite for one feature (buildstudio_run_tests tool) and
// writes test-results.md into the feature's spec
// folder. `featurePath` is store-prefixed (e.g. "user-specs/<project>/<id>");
// the test file is located by convention at e2e/<feature-id>.spec.ts, where
// <feature-id> is the LAST path segment of featurePath. `branch` is the same
// `bos/*` feature branch as spec-fs writes elsewhere (required to write into
// user-specs; see spec-fs.ts's prepareWrite).

const TEST_TIMEOUT_MS = 600_000;
const MAX_DIAGNOSTIC = 8 * 1024;

function clip(s: string): string {
  const t = s.trim();
  return t.length > MAX_DIAGNOSTIC ? t.slice(0, MAX_DIAGNOSTIC) + "\n…[truncated]" : t;
}

interface PlaywrightJsonReport {
  stats?: { expected?: number; unexpected?: number; flaky?: number; skipped?: number };
  errors?: Array<{ message?: string }>;
}

function runPlaywright(specFileRel: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(
      "npx",
      ["playwright", "test", specFileRel, "--reporter=json"],
      { cwd: process.cwd(), timeout: TEST_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, env: process.env },
      (err, stdout, stderr) => {
        const exitCode = err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
        resolve({ stdout, stderr, exitCode });
      },
    );
  });
}

export async function POST(req: NextRequest) {
  let body: { featurePath?: unknown; branch?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const featurePath = String(body.featurePath ?? "").trim();
  if (!featurePath) return NextResponse.json({ error: "featurePath is required" }, { status: 400 });
  const branch = typeof body.branch === "string" && body.branch.trim() ? body.branch.trim() : undefined;

  let storeId: string;
  let rel: string;
  try {
    const resolved = await specfs.resolveStoreRoot(featurePath);
    storeId = resolved.store.id;
    rel = resolved.rel;
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
  const featureId = rel.split("/").filter(Boolean).pop();
  if (!featureId) {
    return NextResponse.json({ error: `"${featurePath}" does not point to a feature folder.` }, { status: 400 });
  }

  // 046 FR-014 / T015 — THE one behavioural change in this feature, which 045's
  // parity harness cannot catch. Before this, every store's tests were probed
  // and executed inside process.cwd() regardless of store kind: asking an ITEM
  // store to run tests ran BOS's own suite and reported the result as the
  // item's. Refuse, and say why.
  const store = (await listStores()).find((s) => s.id === storeId);
  if (!store?.testRoot) {
    return NextResponse.json({
      error:
        `Store "${storeId}" has no test root. Its content lives inside the item, not in BOS's checkout, ` +
        `so BOS cannot run its tests — running them from here would execute BOS's own suite and report that as the item's result.`,
    }, { status: 400 });
  }

  // The test file's NAME comes from the active method descriptor (045's
  // `testFile`); its LOCATION comes from the store kind above.
  // THE entry point, not a hand-assembled chain: this previously passed
  // `{ store: store.method }` alone, so a store bound by workflow — or relying
  // on the configured default — ran its tests under a different descriptor than
  // every other surface resolved for the same unit.
  const { methodForStore } = await import("@/lib/specs/pipeline");
  const descriptor = await methodForStore(storeId);
  const specFileRel = (descriptor.testFile ?? "e2e/<unit-id>.spec.ts").replace("<unit-id>", featureId);
  try {
    await fs.access(path.join(process.cwd(), specFileRel));
  } catch {
    return NextResponse.json({
      error: `No test file found at ${specFileRel}. Write the Playwright e2e tests there first, then call buildstudio_run_tests again.`,
    });
  }

  const { stdout, stderr, exitCode } = await runPlaywright(specFileRel);

  // The JSON reporter writes a single JSON document to stdout. A non-zero exit
  // before it wrote anything, a timeout, or unrelated output on stdout all
  // leave `stdout` empty or non-JSON — guard the parse instead of letting it
  // throw, and surface what Playwright actually said rather than pretending
  // either success or a generic crash.
  let report: PlaywrightJsonReport | undefined;
  const trimmed = stdout.trim();
  if (trimmed) {
    try {
      report = JSON.parse(trimmed);
    } catch {
      report = undefined;
    }
  }

  if (!report) {
    const diagnostic = clip(stderr || stdout) || "(no output)";
    return NextResponse.json({
      error: `Playwright produced no JSON report for ${specFileRel} (exit code ${exitCode}). Check that the test file exists and that the tests actually ran:\n${diagnostic}`,
    });
  }

  const stats = report.stats ?? {};
  const passed = stats.expected ?? 0;
  const failed = stats.unexpected ?? 0;
  const flaky = stats.flaky ?? 0;
  const skipped = stats.skipped ?? 0;
  const errors = report.errors ?? [];
  const ok = exitCode === 0 && failed === 0 && errors.length === 0;

  const lines = [
    `# Test Results — ${featureId}`,
    "",
    `**Status**: ${ok ? "PASSED" : "FAILED"}`,
    "",
    `- Passed: ${passed}`,
    `- Failed: ${failed}`,
    `- Flaky: ${flaky}`,
    `- Skipped: ${skipped}`,
    "",
    `Test file: \`${specFileRel}\``,
  ];
  if (!ok && errors.length) {
    lines.push("", "## Errors", "", ...errors.map((e) => `- ${(e.message ?? "(no message)").split("\n")[0]}`));
  }

  // 046 FR-013: the results artifact is whatever the active method calls it.
  // `test-results.md` is spec-kit's name and is the artifact 045 added
  // `testFile?`/`artifacts[]` for — hardcoding it here would write a file a
  // different method's `test` phase never looks at.
  const resultsArtifact = descriptor.artifacts.find((a) => a.generates === "test")?.id ?? "test-results.md";
  const resultsPath = `${storeId}/${path.posix.join(rel, resultsArtifact)}`;
  try {
    await specfs.writeFile(resultsPath, lines.join("\n") + "\n", branch ? { branch } : undefined);
  } catch (err) {
    return NextResponse.json({
      error: `Tests ${ok ? "passed" : "failed"} (${passed} passed, ${failed} failed) but writing test-results.md failed: ${(err as Error).message}`,
    });
  }

  const summary = `${ok ? "All tests passed" : "Tests failed"} — ${passed} passed, ${failed} failed, ${skipped} skipped${flaky ? `, ${flaky} flaky` : ""}. Wrote ${resultsPath}.`;
  return NextResponse.json({ summary, ok, passed, failed, skipped, flaky });
}
