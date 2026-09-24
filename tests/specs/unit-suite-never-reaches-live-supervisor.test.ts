// Reproduction: the unit suite created real feature branches in a real,
// running production BOS.
//
// A production box was found carrying 21 `bos/*` branches. Every name maps to
// a fixture in this suite:
//
//   bos/history            tests/specs/history.test.ts
//   bos/lifecycle-test     tests/specs/project-lifecycle.test.ts
//   bos/project-layer      tests/specs/project-layer.test.ts
//   bos/core-change        tests/specs/store-on-branch.test.ts
//   bos/follow-the-money   tests/specs/item-binding-on-branch.test.ts (+6 more)
//   bos/unspecified-item   tests/specs/branch-scope-item-id.test.ts
//   bos/from-the-picker    tests/specs/branch-scope-item-id.test.ts
//   …
//
// The channel is `BOS_SUPERVISOR_URL`. Every Supervisor-managed BOS process
// has it set (tools/supervisor/lib/base.mjs, proc.mjs), an agent running
// `npm run test:unit` on its own initiative inherits it, and
// `src/lib/devharness/supervisor.ts` gates on nothing else:
//
//     function baseUrl() { return (process.env.BOS_SUPERVISOR_URL || "")… }
//     export function supervisorEnabled() { return !!baseUrl(); }
//
// So `specfs.writeFile({ branch: "bos/history" })` in a unit test, running
// inside a real deployment, POSTs to the LIVE Supervisor's
// `/__supervisor/begin`, which creates the branch, a worktree, and a data
// clone — for real. On a developer machine no Supervisor is listening, so the
// suite looks hermetic and the leak is invisible until it lands in production.
// That is the same shape as the leak `tests/services/_test-env.ts` documents
// for BOS_SPECS_ROOT (~50 stray "Alpha" projects in a live store).
//
// These tests therefore run a CHILD process with the ambient variable set, the
// way production has it. A same-process assertion cannot see this bug: the
// guard being tested runs at worker startup, before any test file loads.
//
//   npm run test:unit -- tests/specs/unit-suite-never-reaches-live-supervisor.test.ts
import { test, expect } from "@playwright/test";
import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { createServer, type Server } from "http";

const REPO_ROOT = join(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "tests", "_no-live-deployment.cjs");

/** A stand-in for the live Supervisor control plane, recording every hit. */
async function fakeSupervisor(): Promise<{ url: string; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, branch: "bos/testfixture-leaked", worktree: "/worktrees/bos/testfixture-leaked" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const exec = promisify(execFile);

/** Run `script` in a child node process with the unit-suite guard preloaded
 *  and a production-shaped environment.
 *
 *  Async, NOT execFileSync: the fake Supervisor lives in THIS process, so a
 *  synchronous child would block the event loop that has to answer it — the
 *  child waits for a response nobody can send, forever. */
async function runGuarded(script: string, env: Record<string, string>): Promise<string> {
  // NODE_OPTIONS from the parent already carries the guard; passing it again
  // via --require is harmless and keeps the child independent of how the
  // suite happened to be invoked.
  const { stdout } = await exec(process.execPath, ["--require", GUARD, "-e", script], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
  return stdout.trim();
}

test("the ambient Supervisor URL is neutralized in every worker", async () => {
  const sup = await fakeSupervisor();
  try {
    const out = await runGuarded(
      `process.stdout.write(JSON.stringify({ url: process.env.BOS_SUPERVISOR_URL ?? null }))`,
      { BOS_SUPERVISOR_URL: sup.url },
    );
    expect(
      JSON.parse(out).url,
      "inheriting a live control-plane URL is what let a unit test create 18 branches in production",
    ).toBeNull();
  } finally {
    await sup.close();
  }
});

test("a request to a Supervisor control endpoint is refused, even if something re-sets the URL", async () => {
  const sup = await fakeSupervisor();
  try {
    // Belt and braces: a test (or a module that captured the value at import
    // time) could put the URL back. The control plane itself must be
    // unreachable, not merely unconfigured.
    const out = await runGuarded(
      `process.env.BOS_SUPERVISOR_URL = ${JSON.stringify(sup.url)};
       fetch(${JSON.stringify(sup.url)} + "/__supervisor/begin", { method: "POST" })
         .then(() => process.stdout.write("REACHED"))
         .catch((e) => process.stdout.write("REFUSED:" + e.message));`,
      { BOS_SUPERVISOR_URL: sup.url },
    );
    expect(out.startsWith("REFUSED"), `expected the control plane to be unreachable, got: ${out}`).toBe(true);
    expect(sup.hits, "the live Supervisor must not have been touched at all").toEqual([]);
  } finally {
    await sup.close();
  }
});

test("ordinary loopback HTTP still works — the guard must not break tests that spawn local servers", async () => {
  const sup = await fakeSupervisor();
  try {
    const out = await runGuarded(
      `fetch(${JSON.stringify(sup.url)} + "/api/anything")
         .then((r) => r.json())
         .then((j) => process.stdout.write("OK:" + JSON.stringify(j.ok)))
         .catch((e) => process.stdout.write("BROKE:" + e.message));`,
      {},
    );
    expect(out, "only the /__supervisor/ control plane is off limits; the suite legitimately runs local servers").toBe("OK:true");
    expect(sup.hits).toEqual(["GET /api/anything"]);
  } finally {
    await sup.close();
  }
});

test("the Supervisor path variables are neutralized too — a test must never resolve the live repo", async () => {
  const out = await runGuarded(
    `process.stdout.write(JSON.stringify({
       repo: process.env.BOS_REPO ?? null,
       worktrees: process.env.BOS_WORKTREES ?? null,
       clones: process.env.BOS_DATA_CLONES ?? null,
     }))`,
    { BOS_REPO: "/app", BOS_WORKTREES: "/worktrees", BOS_DATA_CLONES: "/data-clones" },
  );
  // These name the live checkout, its worktrees, and its data clones. A test
  // that picks them up out of the ambient environment writes into the running
  // deployment rather than its own fixture.
  expect(JSON.parse(out)).toEqual({ repo: null, worktrees: null, clones: null });
});

test("a test's OWN fake Supervisor is reachable on its control endpoints — only the INHERITED origin is blocked", async () => {
  const live = await fakeSupervisor(); // stands in for the running deployment
  const own = await fakeSupervisor(); // the fixture a test stood up itself
  try {
    // This is the distinction the guard has to get right. Blocking every
    // `/__supervisor/` URL outright breaks tests/self-heal/*, which point
    // BOS_SUPERVISOR_URL at their own local fake on purpose; blocking none of
    // them leaves the live control plane one re-assignment away.
    const out = await runGuarded(
      `process.env.BOS_SUPERVISOR_URL = ${JSON.stringify(own.url)};
       fetch(${JSON.stringify(own.url)} + "/__supervisor/state")
         .then((r) => r.json())
         .then((j) => process.stdout.write("OK:" + JSON.stringify(j.ok)))
         .catch((e) => process.stdout.write("BLOCKED:" + e.message));`,
      { BOS_SUPERVISOR_URL: live.url },
    );
    expect(out, "a fixture on its own port is not a production deployment").toBe("OK:true");
    expect(own.hits).toEqual(["GET /__supervisor/state"]);
    expect(live.hits, "and the inherited origin must still be untouched").toEqual([]);
  } finally {
    await own.close();
    await live.close();
  }
});

test("a test that deliberately stands up its OWN fake Supervisor still works", async () => {
  const sup = await fakeSupervisor();
  try {
    // tests/self-heal/integration-partial-build.test.ts and edge-branches.test.ts
    // set BOS_SUPERVISOR_URL to a local fake on purpose and restore it after.
    // Neutralizing the AMBIENT value must not take that away — the difference
    // is that an explicit fake is a fixture, an inherited one is production.
    const out = await runGuarded(
      `process.env.BOS_SUPERVISOR_URL = ${JSON.stringify(sup.url)};
       process.stdout.write(process.env.BOS_SUPERVISOR_URL);`,
      { BOS_SUPERVISOR_URL: sup.url },
    );
    expect(out).toBe(sup.url);
  } finally {
    await sup.close();
  }
});
