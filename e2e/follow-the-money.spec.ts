// Regression e2e for the follow-the-money preview outage: a marketplace item
// with an app facet + a worker SERVICE facet whose entry has a top-level
// `!parentPort` guard. The service load check (validateManifestAtStart) used to
// `await import()` the entry INSIDE the server process during boot
// (instrumentation.ts → serviceManager().startAll()), so the guard's
// `process.exit(0)` killed the whole preview server — a clean, unexplained
// code-0 exit right after "Ready". This spec boots the production server the
// exact way the Supervisor does (tools/supervisor/lib/proc.mjs startProc) and
// asserts the full contract: the server becomes healthy and STAYS up, the app
// facet is served and renders, and the service facet reaches "running" and
// answers a live API call on its bound port.
//
// Run it from a preview worktree whose data clone has the item installed
// (data/user-apps is the Supervisor's symlink into the branch data clone):
//
//   npm run build            # the Supervisor's preview flow always builds first
//   npx playwright test e2e/follow-the-money.spec.ts
//
// Elsewhere it skips (item not installed) rather than failing the suite.

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const ITEM_ID = "follow-the-money";
const ROOT = process.cwd();
const HEALTH_DEADLINE_MS = 120_000;
const SERVICE_DEADLINE_MS = 90_000;

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

/** The preview's BOS_DATA_DIR. In a preview worktree, `data/user-apps` is a
 *  symlink into the branch's data clone (preview.mjs linkUserAppsIntoWorktree)
 *  — its parent IS the clone. On a plain checkout it's a real directory and
 *  the data dir is just `<root>/data`. */
async function resolveDataDir(): Promise<string> {
  if (process.env.BOS_PREVIEW_DATA_DIR) return process.env.BOS_PREVIEW_DATA_DIR;
  try {
    const link = await fs.readlink(path.join(ROOT, "data", "user-apps"));
    return path.dirname(link);
  } catch {
    return path.join(ROOT, "data");
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
    srv.on("error", reject);
  });
}

async function getJson(url: string, timeoutMs = 5_000): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.describe("follow-the-money preview boot (app + worker service facets)", () => {
  let child: ChildProcess | null = null;
  let childPid = 0;

  test.afterAll(async () => {
    if (child && childPid && child.exitCode === null && !child.signalCode) {
      // Negative PID = whole process group (npx + next-server), like stopProc.
      try { process.kill(-childPid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* gone */ } }
      await Promise.race([new Promise((r) => child?.once("exit", r)), sleep(5_000)]);
      if (child.exitCode === null && !child.signalCode) {
        try { process.kill(-childPid, "SIGKILL"); } catch { /* gone */ }
      }
    }
  });

  test("preview server stays up, serves the app, and the service reaches running with a live API", async ({ page }) => {
    test.setTimeout(300_000);

    const dataDir = await resolveDataDir();
    const installed = await exists(path.join(dataDir, "system", ITEM_ID));
    test.skip(!installed, `item "${ITEM_ID}" is not installed under ${dataDir} — run from the bos/testfixture-follow-the-money preview worktree`);

    expect(
      await exists(path.join(ROOT, ".next", "BUILD_ID")),
      "no production build in this worktree — run `npm run build` first (the Supervisor's preview flow always builds before start)",
    ).toBe(true);

    // Isolated canonical data (never the deployment's /app/data) and no
    // store seeding — mirrors what matters from proc.mjs's env without
    // touching real cross-version state.
    const canonical = await fs.mkdtemp(path.join(os.tmpdir(), "ftm-canonical-"));
    const specsDir = (await exists(path.join(ROOT, "specs"))) ? path.join(ROOT, "specs") : await fs.mkdtemp(path.join(os.tmpdir(), "ftm-specs-"));
    const port = await freePort();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(port),
      BOS_DATA_DIR: dataDir,
      BOS_CANONICAL_DATA: canonical,
      BOS_VERSION_LABEL: "preview",
      BOS_BASE_BRANCH: process.env.BOS_BASE_BRANCH || "main",
      BOS_SPECS_ROOT: specsDir,
      BOS_SPECS_SEED: "0",
      NODE_PATH: process.env.NODE_PATH
        ? `${process.env.NODE_PATH}${path.delimiter}${path.join(ROOT, "node_modules")}`
        : path.join(ROOT, "node_modules"),
    };
    delete env.BOS_SUPERVISOR_URL; // hermetic: don't depend on a running Supervisor

    let exited: { code: number | null; signal: string | null } | null = null;
    let tail = "";
    child = spawn("npx", ["next", "start", "-p", String(port)], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    childPid = child.pid ?? 0;
    const onChunk = (c: Buffer) => { tail = (tail + c.toString()).slice(-8_192); };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("exit", (code, signal) => { exited = { code, signal }; });

    // 1) Health-gate, failing FAST if the process dies first. On the unfixed
    //    code the server exits cleanly (code 0) during instrumentation's
    //    serviceManager().startAll(), right after Next prints "Ready".
    const deadline = Date.now() + HEALTH_DEADLINE_MS;
    let healthy = false;
    while (Date.now() < deadline && !healthy && !exited) {
      const health = (await getJson(`http://127.0.0.1:${port}/api/health`)) as { ok?: boolean } | null;
      healthy = health?.ok === true;
      if (!healthy) await sleep(1_000);
    }
    expect(
      exited,
      `preview server exited (${JSON.stringify(exited)}) before becoming healthy — the follow-the-money regression. Output tail:\n${tail}`,
    ).toBeNull();
    expect(healthy, `no healthy /api/health on :${port} within ${HEALTH_DEADLINE_MS}ms. Output tail:\n${tail}`).toBe(true);

    // 2) …and STAYS up (a post-ready side effect could still kill it).
    await sleep(5_000);
    expect(exited, `preview server exited (${JSON.stringify(exited)}) after becoming healthy. Output tail:\n${tail}`).toBeNull();

    // 3) The app facet is served through the item symlink.
    const appRes = await fetch(`http://127.0.0.1:${port}/apps/${ITEM_ID}/`);
    expect(appRes.status).toBe(200);
    expect(await appRes.text()).toContain("root");

    // 4) The service facet reaches "running" and binds a port.
    const svcDeadline = Date.now() + SERVICE_DEADLINE_MS;
    let svc: { state?: string; boundPort?: number; boundHost?: string; lastError?: string } | undefined;
    while (Date.now() < svcDeadline) {
      const body = (await getJson(`http://127.0.0.1:${port}/api/services`)) as
        | { services?: Array<{ id: string; state?: string; boundPort?: number; boundHost?: string; lastError?: string }> }
        | null;
      svc = body?.services?.find((s) => s.id === ITEM_ID);
      if (svc?.state === "running" && svc.boundPort) break;
      await sleep(1_500);
    }
    expect(svc?.state, `service never reached running (${JSON.stringify(svc)})`).toBe("running");
    expect(svc?.boundPort, `service running but never bound a port (${JSON.stringify(svc)})`).toBeTruthy();

    // 5) Live API call against the service's own bound HTTP endpoint.
    const svcHealth = (await getJson(`http://${svc?.boundHost || "127.0.0.1"}:${svc?.boundPort}/api/health`, 10_000)) as
      | { providers?: unknown[] }
      | null;
    expect(svcHealth, "service /api/health did not answer on its bound port").not.toBeNull();
    expect(Array.isArray(svcHealth?.providers)).toBe(true);

    // 6) The app actually renders in a browser (iframe content URL directly;
    //    nfa-pill and the dashboard table render even before any market data).
    await page.goto(`http://127.0.0.1:${port}/apps/${ITEM_ID}/`);
    await expect(page.getByTestId("nfa-pill")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("dash-table")).toBeAttached({ timeout: 30_000 });
  });
});
