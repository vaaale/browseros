import path from "path";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { test, expect, type Page, type FrameLocator } from "@playwright/test";

// 040-assistant-broker-capability — end-to-end self-test.
//
// The whole point of the feature: a MARKETPLACE-origin app runs in an iframe
// sandboxed without allow-same-origin, so its direct fetch("/api/assistant/...")
// is cross-origin against routes that set no CORS headers and just fails. These
// tests install a real marketplace-origin fixture app and drive a complete
// agentic exchange through the broker — start a run, stream text deltas, receive
// a frontend tool_call, post the result, see run_finished — with zero direct
// fetch to /api/assistant/* (the fixture also *attempts* one and reports that it
// was blocked, which is the premise the feature exists for). SC-001/SC-002/SC-005.
//
// Determinism comes from the scripted provider (src/lib/assistant/e2e-provider.ts,
// BOS_E2E_SCRIPTED=1 + an `@@e2e {…}` message) — the same mechanism
// assistant-v2.spec.ts uses — so no live model call is involved.
//
// PARALLELISM / CLEANUP: like e2e/039-service-tool-exposure.spec.ts, this runs
// against the app's real data dir, so it uses ids unique to this spec, keeps its
// own tests serial, and removes everything it wrote in afterAll regardless of
// pass/fail (including the BOS-owned capability grant under system/config/, which
// deliberately survives uninstall).

// Mirrors src/os/data-dir.ts's dataDir(); this file runs as a plain Node script,
// so it can't import that `server-only` module.
const DATA_DIR = process.env.BOS_DATA_DIR?.trim() || path.join(process.cwd(), "data");

/** Declares AND is granted `assistant`. */
const GRANTED_ID = "e2e-040-broker-app";
const GRANTED_NAME = "E2E Broker App";
/** Declares nothing — the capability must be ungrantable and every call denied. */
const UNGRANTED_ID = "e2e-040-nocap-app";
const UNGRANTED_NAME = "E2E NoCap App";
/** A fake marketplace clone: provenance is DERIVED from where the install
 *  symlink resolves (035 FR-009), so the fixture must live under
 *  data/marketplace/<id>/items/<id> to be treated as untrusted → opaque origin. */
const MARKETPLACE_ID = "e2e-040-marketplace";

/**
 * The fixture app. One HTML file, no build step, no network beyond the broker.
 *
 * It probes the capability first (the cheapest broker call) so BOTH the granted
 * and the ungranted install can share this exact document: an ungranted app
 * lands in the "denied" branch and reports the rejection message plus a WARM
 * timing (SC-002), a granted app runs the full agentic exchange.
 */
const APP_HTML = String.raw`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>E2E Broker App</title></head>
<body style="font:13px/1.5 system-ui;background:#111;color:#eee;padding:12px">
  <div>status: <b data-testid="status">idle</b></div>
  <div>denied: <b data-testid="denied"></b></div>
  <div>deniedMs: <b data-testid="denied-ms"></b></div>
  <div>directFetch: <b data-testid="direct-fetch"></b></div>
  <div>conversation: <b data-testid="conv"></b></div>
  <div>run: <b data-testid="run"></b></div>
  <div>text: <b data-testid="text"></b></div>
  <div>tool: <b data-testid="tool"></b></div>
  <div>claimed: <b data-testid="claimed"></b></div>
  <div>finished: <b data-testid="finished"></b></div>
<script>
(function () {
  var set = function (id, v) {
    var el = document.querySelector('[data-testid="' + id + '"]');
    if (el) el.textContent = String(v);
  };

  var conversationId = "e2e-040-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  set("conv", conversationId);

  // Two scripted turns: the first emits a FRONTEND tool call (the surface tool
  // declared on the run start), the second is the acknowledgement after the app
  // posts the tool result. The run cannot reach turn 2 unless the round-trip
  // through the broker actually closed the loop.
  var SCRIPT = { turns: [
    { text: "Adding a paragraph to the document.", deltas: 8, delayMs: 20,
      tools: [{ name: "e2e_040_edit", args: { text: "a new paragraph" } }] },
    { text: "Done - paragraph added." }
  ] };

  // Proof of the premise (and of SC-001's "zero direct fetch"): a direct call to
  // the assistant API from this opaque origin is blocked by the browser. Read-only.
  fetch("/api/assistant/runs?conversationId=" + encodeURIComponent(conversationId))
    .then(function (r) { set("direct-fetch", "ok:" + r.status); })
    .catch(function () { set("direct-fetch", "blocked"); });

  function main() {
    // Capability probe. An ungranted app must be REJECTED here (not left
    // hanging) — the parent's gate is synchronous and pre-dispatch.
    window.__bos.assistant.listAgents().then(onGranted, onDenied);
  }

  function onDenied(err) {
    // Time a SECOND call, so the number reflects a warm main thread rather than
    // whatever else the page was doing during first paint (SC-002).
    var t0 = Date.now();
    window.__bos.assistant.startRun({ conversationId: conversationId, agentId: "assistant", message: "hi" })
      .then(function () { set("status", "unexpectedly-granted"); }, function (e2) {
        set("denied-ms", String(Date.now() - t0));
        set("denied", (e2 && e2.message) || String(e2));
        set("status", "denied");
      });
    void err;
  }

  function onGranted(agents) {
    if (!agents || !Array.isArray(agents.agents)) {
      set("status", "bad-list-agents:" + JSON.stringify(agents));
      return;
    }
    window.__bos.assistant.startRun({
      conversationId: conversationId,
      agentId: "assistant",
      message: "@@e2e " + JSON.stringify(SCRIPT),
      surfaceTools: [{
        name: "e2e_040_edit",
        description: "Append a paragraph to this app's document.",
        parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
      }]
    }).then(function (started) {
      if (!started || !started.runId) {
        set("status", "start-failed:" + JSON.stringify(started));
        return;
      }
      var runId = started.runId;
      set("run", runId);
      set("status", "running");

      var acc = "";
      var stop = window.__bos.assistant.onRunEvent(runId, function (e) {
        if (e.type === "text_delta") {
          acc += e.delta;
          set("text", acc);
        } else if (e.type === "tool_call" && e.execution === "frontend") {
          set("tool", e.name);
          window.__bos.assistant.postToolResult(runId, e.callId, "applied " + e.name)
            .then(function (r) { set("claimed", r && r.claimed ? "claimed" : "not-claimed:" + JSON.stringify(r)); })
            .catch(function (err) { set("claimed", "error:" + ((err && err.message) || err)); });
        } else if (e.type === "run_finished") {
          set("finished", "finished:" + e.reason);
          set("status", "done");
          stop();
        }
      });
    }, function (err) {
      set("status", "start-rejected:" + ((err && err.message) || err));
    });
  }

  main();
})();
</script>
</body>
</html>
`;

/** Mirrors e2e/global-setup.ts's first-run-wizard bypass, scoped to DATA_DIR. */
function markSetupComplete(): void {
  const dir = path.join(DATA_DIR, "config");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "system.json");
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    /* no existing file */
  }
  if (current.setupComplete !== true) {
    writeFileSync(file, JSON.stringify({ ...current, setupComplete: true }, null, 2), "utf8");
  }
}

/**
 * Write a marketplace-origin app item and install it the way BOS does — ONE
 * symlink at data/system/<id> pointing at the item (035-install-by-symlink).
 * Because the target resolves under data/marketplace/, the shared scanner
 * derives origin: "marketplace", which is what puts the iframe in an
 * opaque-origin sandbox — the whole reason the broker is needed.
 */
function installFixtureApp(id: string, name: string, capabilities: string[]): void {
  const itemDir = path.join(DATA_DIR, "marketplace", MARKETPLACE_ID, "items", id);
  const appDir = path.join(itemDir, "app");
  mkdirSync(appDir, { recursive: true });
  writeFileSync(path.join(appDir, "index.html"), APP_HTML, "utf8");
  writeFileSync(
    path.join(appDir, "app.json"),
    JSON.stringify({ id, name, icon: "MessageSquare", createdAt: 0, capabilities }, null, 2),
    "utf8",
  );
  const link = path.join(DATA_DIR, "system", id);
  mkdirSync(path.dirname(link), { recursive: true });
  rmSync(link, { force: true, recursive: true });
  symlinkSync(itemDir, link, "dir");
}

function removeFixtureApp(id: string): void {
  rmSync(path.join(DATA_DIR, "system", id), { force: true, recursive: true });
  // Grants are BOS-owned state that deliberately survives uninstall — remove it
  // too, or a re-run inherits a stale grant and the denial test passes for the
  // wrong reason.
  rmSync(path.join(DATA_DIR, "system", "config", id), { force: true, recursive: true });
  rmSync(path.join(DATA_DIR, "marketplace", MARKETPLACE_ID, "items", id), { force: true, recursive: true });
}

/** Reload the desktop (apps are SSR-seeded from the install symlinks) and open
 *  the fixture app; returns a locator scope inside its sandboxed iframe. */
async function launchFixtureApp(page: Page, id: string): Promise<FrameLocator> {
  await page.goto("/");
  const skip = page.getByRole("button", { name: "Skip" });
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});
  const dockButton = page.getByTestId(`dock-${id}`);
  await expect(dockButton).toBeVisible({ timeout: 20000 });
  await dockButton.click();
  await expect(page.getByTestId(`window-${id}`)).toBeVisible({ timeout: 20000 });
  return page.frameLocator(`iframe[title="App: ${id}"]`);
}

test.describe.configure({ mode: "serial" });

test.describe("Assistant broker capability (040)", () => {
  test.beforeAll(() => {
    markSetupComplete();
    // Declaring `assistant` in app.json is what makes it grantable (ADR-6); the
    // grant itself is then migrated into BOS-owned state on first read.
    installFixtureApp(GRANTED_ID, GRANTED_NAME, ["assistant"]);
    installFixtureApp(UNGRANTED_ID, UNGRANTED_NAME, []);
  });

  test.afterAll(() => {
    removeFixtureApp(GRANTED_ID);
    removeFixtureApp(UNGRANTED_ID);
    rmSync(path.join(DATA_DIR, "marketplace", MARKETPLACE_ID), { force: true, recursive: true });
  });

  test("US1+US2/SC-001: a marketplace app runs a full agentic exchange through the broker", async ({ page }) => {
    test.setTimeout(120_000);

    // Sanity: the grant migrated from the manifest declaration, and the app is
    // marketplace-origin (so its iframe really is opaque-origin sandboxed).
    const caps = await page.request
      .get(`/api/apps/${GRANTED_ID}/capabilities`)
      .then((r) => r.json() as Promise<{ capabilities: string[]; declared: string[] }>);
    expect(caps.declared).toContain("assistant");
    expect(caps.capabilities).toContain("assistant");
    const apps = await page.request.get("/api/apps").then((r) => r.json() as Promise<{ apps: { id: string; origin?: string }[] }>);
    expect(apps.apps.find((a) => a.id === GRANTED_ID)?.origin).toBe("marketplace");

    const app = await launchFixtureApp(page, GRANTED_ID);

    // US1: the run started and text deltas streamed in over __bos_event.
    await expect(app.getByTestId("run")).not.toBeEmpty({ timeout: 30000 });
    await expect(app.getByTestId("text")).toContainText("Adding a paragraph", { timeout: 30000 });

    // US2: the frontend tool call arrived, was executed locally, and the result
    // was claimed by the server (first-claim-wins, unchanged).
    await expect(app.getByTestId("tool")).toHaveText("e2e_040_edit", { timeout: 30000 });
    await expect(app.getByTestId("claimed")).toHaveText("claimed", { timeout: 30000 });

    // Posting the result unblocked the loop, so the SECOND scripted turn ran and
    // the run finished cleanly — the full round-trip closed.
    await expect(app.getByTestId("text")).toContainText("Done - paragraph added", { timeout: 60000 });
    await expect(app.getByTestId("finished")).toHaveText("finished:completed", { timeout: 60000 });

    // SC-001's "without any direct fetch to /api/assistant/*": the app's own
    // attempt at one was blocked by the browser, exactly as designed.
    await expect(app.getByTestId("direct-fetch")).not.toContainText("ok:", { timeout: 30000 });

    // The run really was server-owned: the transcript has a tool message.
    const conv = await app.getByTestId("conv").textContent();
    const { messages } = await page.request
      .get(`/api/assistant/conversations/${encodeURIComponent(conv ?? "")}/messages`)
      .then((r) => r.json());
    expect((messages as { role: string }[]).some((m) => m.role === "tool")).toBe(true);
  });

  test("US3/SC-002: an app without the capability is rejected fast, not left hanging", async ({ page }) => {
    const app = await launchFixtureApp(page, UNGRANTED_ID);

    await expect(app.getByTestId("status")).toHaveText("denied", { timeout: 30000 });
    await expect(app.getByTestId("denied")).toContainText('Capability "assistant" not granted');
    // The gate is synchronous and pre-dispatch, so this is one postMessage
    // round-trip with no server hop. Measured on a warm main thread (the fixture
    // times its SECOND call) so first-paint work can't skew it.
    const ms = Number((await app.getByTestId("denied-ms").textContent()) ?? "99999");
    expect(ms).toBeLessThan(100);
  });

  test("US3: declaration-gating — the grant API refuses `assistant` for a non-declaring app", async ({ request }) => {
    const res = await request.put(`/api/apps/${UNGRANTED_ID}/capabilities`, {
      data: { capabilities: ["assistant", "notify"] },
    });
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { app: { capabilities?: string[] }; rejected?: string[]; warning?: string };
    expect(body.rejected).toEqual(["assistant"]);
    expect(body.warning).toContain("does not declare");
    // The sibling (flat) capability in the same request still went through.
    expect(body.app.capabilities).toContain("notify");
    expect(body.app.capabilities).not.toContain("assistant");

    const after = await request
      .get(`/api/apps/${UNGRANTED_ID}/capabilities`)
      .then((r) => r.json() as Promise<{ capabilities: string[]; declared: string[] }>);
    expect(after.capabilities).not.toContain("assistant");
    expect(after.declared).not.toContain("assistant");
  });

  test("SC-005: revoking the grant blocks subsequent broker calls", async ({ page }) => {
    const revoke = await page.request.put(`/api/apps/${GRANTED_ID}/capabilities`, {
      data: { capabilities: [] },
    });
    expect(revoke.ok()).toBe(true);
    try {
      const app = await launchFixtureApp(page, GRANTED_ID);
      await expect(app.getByTestId("status")).toHaveText("denied", { timeout: 30000 });
      await expect(app.getByTestId("denied")).toContainText('Capability "assistant" not granted');
    } finally {
      // Re-grant: the declaration is still there, so this must succeed.
      const res = await page.request.put(`/api/apps/${GRANTED_ID}/capabilities`, {
        data: { capabilities: ["assistant"] },
      });
      const body = (await res.json()) as { app: { capabilities?: string[] }; rejected?: string[] };
      expect(body.rejected ?? []).toEqual([]);
      expect(body.app.capabilities).toContain("assistant");
    }
  });

  test("US4/NFR-004: direct-HTTP consumers are unaffected", async ({ request }) => {
    // A same-origin consumer (BOS's own chat, a local app) still drives the run
    // API by direct fetch — the broker is a parallel path, not a replacement.
    const conversationId = `e2e-040-direct-${Date.now()}`;
    const start = await request.post("/api/assistant/runs", {
      data: { conversationId, agentId: "assistant", message: `@@e2e ${JSON.stringify({ turns: [{ text: "direct ok" }] })}` },
    });
    expect(start.status()).toBe(201);
    const { runId } = (await start.json()) as { runId: string };
    expect(runId).toBeTruthy();

    const events = await request.get(`/api/assistant/runs/${encodeURIComponent(runId)}/events?since=0`);
    expect(events.status()).toBe(200);
    const parsed = (await events.text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string });
    expect(parsed.some((e) => e.type === "run_finished")).toBe(true);
  });
});
