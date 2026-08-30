import path from "path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { test, expect, type Page } from "./fixtures";
import { installToolFixtureService, ECHO_TOOL_NAME } from "../tests/services/_tool-service-fixtures";

// 039-service-tool-exposure — end-to-end self-test: a marketplace item's
// background service opts into `deploymentMode: "tools"`, declares a tool at
// startup (tool_declare over worker IPC), and the assistant calls it by name
// with no MCP server in the loop. Proves US1's full path (declare → register
// → assistant invokes → result) the way a real user would experience it:
// install the item, start its service, ask the assistant to use the tool.
// See design.md §3 (container design), plan.md § Test Strategy 6, spec.md US1.
//
// Determinism comes from the scripted e2e provider (src/lib/assistant/
// e2e-provider.ts, BOS_E2E_SCRIPTED=1 + an `@@e2e {…}` message) — same
// mechanism as assistant-v2.spec.ts — so the "assistant calls the tool" step
// needs no live model call.
//
// PARALLELISM (plan.md's Test Strategy 6 note): the service registry, the
// ServiceToolBridge, and worker threads are process-wide singletons, and (per
// e2e/global-setup.ts) this harness runs against the app's real data dir, not
// an isolated one. A service id unique to this spec (never reused by any
// other e2e spec or fixture) avoids colliding with concurrently-running
// specs, and test.describe.serial keeps this file's own tests from
// overlapping if more are added later. Cleanup (afterAll) removes the
// installed item and its symlink regardless of pass/fail, so re-runs and
// other specs never see leftover state.

const script = (turns: unknown[]) => `@@e2e ${JSON.stringify({ turns })}`;

// Mirrors src/os/data-dir.ts's dataDir() resolution — this spec can't import
// that module directly (it's `import "server-only"`-guarded and this file
// runs as a plain Node/Playwright script, not through the Next.js server
// build), so the same two-line fallback is inlined here.
const DATA_DIR = process.env.BOS_DATA_DIR?.trim() || path.join(process.cwd(), "data");

const SERVICE_ID = "e2e-039-tool-svc";

async function openAssistantOnFreshConversation(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByText("Assistant", { exact: true }).first().dblclick({ timeout: 20000 });
  await expect(page.getByTestId("assistant-v2")).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("chat-textarea")).toBeVisible({ timeout: 15000 });
  await page.getByTitle(/New .*conversation/i).first().click();
  await page.waitForTimeout(400);
}

function removeFixture(): void {
  rmSync(path.join(DATA_DIR, "system", SERVICE_ID), { force: true });
  rmSync(path.join(DATA_DIR, "user-apps", "items", SERVICE_ID), { recursive: true, force: true });
}

// Mirrors e2e/global-setup.ts's own bypass of the first-run wizard, but
// scoped to DATA_DIR rather than the hardcoded `process.cwd()/data` — the
// shared global-setup.ts only covers the case where the server under test
// happens to resolve dataDir() to the SAME directory Playwright was invoked
// from. Writing it here too keeps this spec self-sufficient regardless of
// where the server-under-test's data dir actually lives, and is otherwise a
// harmless no-op re-write of the same flag in the common case.
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

test.describe.serial("Service tool exposure — assistant calls a real service tool (039)", () => {
  test.beforeAll(() => markSetupComplete());

  test.afterAll(async ({ request }) => {
    // Best-effort teardown regardless of pass/fail: stop + uninstall via the
    // real API (mirrors FR-006's own cleanup path), then remove whatever the
    // fixture wrote so a re-run — or another spec — never sees stale state.
    await request.post(`/api/services/${SERVICE_ID}`, { data: { action: "stop" } }).catch(() => {});
    await request.delete("/api/services", { data: { serviceId: SERVICE_ID } }).catch(() => {});
    removeFixture();
  });

  test("install → start → the assistant calls the declared tool by name → result comes back", async ({ page }) => {
    installToolFixtureService(DATA_DIR, SERVICE_ID);

    // GET /api/services runs discoverServices() (a live filesystem scan), so
    // the freshly-written item must show up before it can be started.
    await expect
      .poll(
        async () => {
          const { services } = await page.request.get("/api/services").then((r) => r.json());
          return (services as { id: string }[]).some((s) => s.id === SERVICE_ID);
        },
        { timeout: 10000 },
      )
      .toBe(true);

    const startRes = await page.request.post(`/api/services/${SERVICE_ID}`, {
      data: { action: "start", startupTimeout: 10000 },
    });
    expect(startRes.ok()).toBe(true);

    // tool_declare (Worker→Main) is posted immediately after "initialized",
    // but arrives on a later tick than start()'s own response — this is the
    // one gap the in-process integration test closes with an in-memory
    // waitFor() on the bridge; an out-of-process e2e has no such hook, so a
    // short, generous wait stands in for it (worker IPC delivery here is
    // same-process and normally sub-millisecond).
    await page.waitForTimeout(1000);

    await openAssistantOnFreshConversation(page);

    await page.getByTestId("chat-textarea").fill(
      script([
        { text: "calling the service tool", tools: [{ name: ECHO_TOOL_NAME, args: { text: "hello from e2e" } }] },
        { text: "Done." },
      ]),
    );
    await page.getByTestId("chat-send-button").click();

    await expect(page.getByTestId("tool-card").first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("assistant-message").last()).toContainText("Done.", { timeout: 30000 });

    // The tool actually ran on the service (not a stub/frontend echo): the
    // persisted tool result is the exact string the worker sent back over
    // `tool_result`.
    const convId = await page.evaluate(() => localStorage.getItem("bos.activeConversation.assistant") ?? "");
    const { messages } = await page.request
      .get(`/api/assistant/conversations/${convId}/messages`)
      .then((r) => r.json());
    const toolMessage = (messages as { role: string; content: string }[]).find((m) => m.role === "tool");
    expect(toolMessage?.content).toBe("hello from e2e");
  });
});
