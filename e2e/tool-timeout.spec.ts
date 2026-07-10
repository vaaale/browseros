import { test, expect, type Route } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Task 2.6 — hung-tool regression e2e.
//
// VARIANT SHIPPED: the strong, kernel-through-UI variant. It needs no live LLM:
// BOS's CopilotKit 1.61 client talks to /api/copilotkit via the AG-UI
// "single-route" transport (POST { method: "agent/run", body: RunAgentInput },
// response = text/event-stream of AG-UI events). We intercept that endpoint with
// Playwright and fabricate the model's turns: run 1 emits TWO tool calls
// (docs_read — a warm-up that lets the kernel's timeout-setting cache refresh —
// then docs_list); run 2 (the follow-up CopilotKit issues after executing the
// tools) returns a plain text answer. /api/docs (the docs_list backend) is
// intercepted to HANG forever, so the REAL production path executes end-to-end:
// CopilotKit processAgentResult → DocsActions handler → runToolHandler kernel →
// 10 s configured timeout → in-band `Error: docs_list: timed out after 10s`
// result → follow-up run continues. Before the kernel existed this scenario
// froze the run forever (CopilotKit awaits tool handlers sequentially and has
// no timeout of its own).
//
// A second, browser-less test is a regression TRIPWIRE: every `handler:` in
// src/components/agent/*Actions.tsx must route through runToolHandler, so a
// future handler cannot silently bypass the kernel and reintroduce hangs.
test.use({ video: "off" });

const CONV_ID = "c-tool-timeout-regression";
const CHAT_PATH = `/Documents/Chats/${CONV_ID}.json`;
const TITLE = "Tool timeout (regression)";
const WARMUP_TOKEN = "WARMUP_DOC_TOKEN_7734";
const FINAL_TOKEN = "FINAL_ANSWER_TOKEN_7734";
// The warm-up docs_read response is delayed so the kernel's background refresh
// of tools.toolCallTimeoutSec (kicked off by the handler's first
// getToolTimeoutMs() call) has certainly landed before docs_list runs.
const WARMUP_DELAY_MS = 2500;

interface AgMessage {
  id?: string;
  role?: string;
  content?: string;
  toolCallId?: string;
}
interface RunInput {
  threadId?: string;
  runId?: string;
  messages?: AgMessage[];
  forwardedProps?: Record<string, unknown>;
}

const sse = (events: Record<string, unknown>[]): string =>
  events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

test.describe("hung tool call cannot freeze a run", () => {
  test("docs_list hangs → in-band timeout error at the configured 10s, and the run continues", async ({
    page,
    context,
    request,
  }) => {
    test.setTimeout(150_000);

    // 1. Set tools.toolCallTimeoutSec = 10, remembering the prior value.
    const readTimeout = async (): Promise<unknown> => {
      const j = (await (await request.get("/api/config")).json()) as {
        schemas?: { namespace: string; values?: Record<string, unknown> }[];
      };
      return j.schemas?.find((s) => s.namespace === "tools")?.values?.toolCallTimeoutSec;
    };
    const prior = await readTimeout();
    const patched = await request.patch("/api/config", {
      data: { namespace: "tools", values: { toolCallTimeoutSec: 10 } },
    });
    expect(patched.ok()).toBe(true);

    const hungRoutes: Route[] = [];
    try {
      // 2. Seed a completed conversation and make it active (house recipe; the
      // active-conversation localStorage key is per-agent: prefix + agentId).
      await request.post("/api/fs", {
        data: {
          op: "write",
          path: CHAT_PATH,
          content: JSON.stringify({
            id: CONV_ID,
            title: TITLE,
            createdAt: Date.now(),
            agentId: "assistant",
            messages: [
              { id: "u1", role: "user", content: "Hello" },
              { id: "a1", role: "assistant", content: "Hi — ready when you are." },
            ],
          }),
        },
      });
      await context.addInitScript(
        (id) => localStorage.setItem("bos.activeConversation.assistant", id),
        CONV_ID,
      );

      // 3. /api/docs: docs_read (has ?section=) resolves after a delay with a
      // stub doc; docs_list (bare /api/docs) HANGS — the route is never
      // fulfilled, simulating a dead backend.
      await page.route(
        (url) => url.pathname === "/api/docs",
        async (route) => {
          const u = new URL(route.request().url());
          if (u.searchParams.has("section")) {
            await new Promise((r) => setTimeout(r, WARMUP_DELAY_MS));
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ doc: { content: WARMUP_TOKEN } }),
            });
            return;
          }
          hungRoutes.push(route); // never fulfilled → the handler's fetch hangs
        },
      );

      // 4. Fabricate the agent runs. Only single-route `agent/run` POSTs are
      // hijacked; info/connect requests fall through to the real server (they
      // never touch an LLM).
      let followUp: RunInput | null = null;
      await page.route(
        (url) => url.pathname === "/api/copilotkit",
        async (route) => {
          const req = route.request();
          if (req.method() !== "POST") return route.fallback();
          let envelope: { method?: string; body?: RunInput } | null = null;
          try {
            envelope = JSON.parse(req.postData() ?? "") as { method?: string; body?: RunInput };
          } catch {
            /* not JSON — not a single-route envelope */
          }
          if (!envelope || envelope.method !== "agent/run") return route.fallback();

          const input = envelope.body ?? {};
          const bookends = { threadId: input.threadId ?? "t", runId: input.runId ?? "r" };
          const fulfillSse = (events: Record<string, unknown>[]) =>
            route.fulfill({
              status: 200,
              headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
              body: sse(events),
            });
          // Ignore auxiliary runs (e.g. suggestion generation pins toolChoice).
          const hasToolChoice = !!input.forwardedProps?.toolChoice;
          const msgs = input.messages ?? [];
          const last = msgs[msgs.length - 1];

          if (!hasToolChoice && last?.role === "user") {
            // Turn 1: the "model" calls docs_read (warm-up) then docs_list (hangs).
            return fulfillSse([
              { type: "RUN_STARTED", ...bookends },
              { type: "TOOL_CALL_START", toolCallId: "tc-warm", toolCallName: "docs_read" },
              { type: "TOOL_CALL_ARGS", toolCallId: "tc-warm", delta: JSON.stringify({ ref: "usage/index.md" }) },
              { type: "TOOL_CALL_END", toolCallId: "tc-warm" },
              { type: "TOOL_CALL_START", toolCallId: "tc-hang", toolCallName: "docs_list" },
              { type: "TOOL_CALL_ARGS", toolCallId: "tc-hang", delta: "{}" },
              { type: "TOOL_CALL_END", toolCallId: "tc-hang" },
              { type: "RUN_FINISHED", ...bookends },
            ]);
          }
          if (!hasToolChoice && last?.role === "tool") {
            // Turn 2 (follow-up after tool execution): capture what the model
            // would see, then answer with plain text so the run settles.
            followUp = input;
            return fulfillSse([
              { type: "RUN_STARTED", ...bookends },
              { type: "TEXT_MESSAGE_START", messageId: "m-final", role: "assistant" },
              { type: "TEXT_MESSAGE_CONTENT", messageId: "m-final", delta: FINAL_TOKEN },
              { type: "TEXT_MESSAGE_END", messageId: "m-final" },
              { type: "RUN_FINISHED", ...bookends },
            ]);
          }
          return fulfillSse([{ type: "RUN_STARTED", ...bookends }, { type: "RUN_FINISHED", ...bookends }]);
        },
      );

      // 5. Open the Assistant on the seeded conversation and send the trigger.
      await page.goto("/");
      // The chat ignores Enter until the runtime connection is up; the client
      // announces it by POSTing {"method":"info"} to the single-route endpoint.
      const infoReady = page.waitForResponse(
        (r) =>
          r.url().includes("/api/copilotkit") &&
          r.request().method() === "POST" &&
          (r.request().postData() ?? "").includes('"method":"info"'),
        { timeout: 30_000 },
      );
      await page.getByTestId("dock-chat").click();
      const win = page.getByTestId("window-chat");
      await expect(win).toBeVisible();
      await page.getByRole("button", { name: TITLE, exact: true }).click();
      await infoReady;

      const input = win.getByRole("textbox").first();
      await input.fill("List the docs (this tool call will hang).");
      // Belt and braces: re-press Enter until the chat accepts the message
      // (value clears on send) — readiness has UI-internal async steps beyond
      // the info response.
      await expect(async () => {
        await input.press("Enter");
        await expect(input).toHaveValue("", { timeout: 1_000 });
      }).toPass({ timeout: 20_000 });

      // 6. The run must COMPLETE despite the hung tool: the follow-up answer
      // renders well within a minute (default 600 s timeout would blow this).
      await expect(page.getByText(FINAL_TOKEN)).toBeVisible({ timeout: 60_000 });

      // The follow-up request carries both tool results in-band: the warm-up
      // succeeded and the hung call settled as the kernel's timeout error.
      expect(followUp).not.toBeNull();
      const toolResults = (followUp!.messages ?? []).filter((m) => m.role === "tool");
      const warm = toolResults.find((m) => m.toolCallId === "tc-warm");
      const hung = toolResults.find((m) => m.toolCallId === "tc-hang");
      expect(warm?.content).toBe(WARMUP_TOKEN);
      expect(String(hung?.content ?? "")).toMatch(/^Error: docs_list: timed out after 10s/);

      // The run lifecycle settled: no stuck activity pill, input usable again.
      await expect(page.getByText(/^Working/)).toHaveCount(0, { timeout: 15_000 });
      await expect(input).toBeEditable();
    } finally {
      // Cleanup: release the hung route, restore the timeout setting, delete
      // the seeded conversation.
      for (const r of hungRoutes) await r.abort().catch(() => {});
      const restore = typeof prior === "number" && Number.isFinite(prior) ? prior : 600;
      await request
        .patch("/api/config", { data: { namespace: "tools", values: { toolCallTimeoutSec: restore } } })
        .catch(() => {});
      await request.post("/api/fs", { data: { op: "delete", path: CHAT_PATH } }).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// Tripwire: no tool handler may bypass the kernel. Every `handler:` in the
// action files must be an arrow whose body IS a runToolHandler(...) call, or a
// reference to a local declaration that (possibly via one factory hop, e.g.
// DiscoveryActions' makeDiscoveryHandler) wraps runToolHandler.
// ---------------------------------------------------------------------------

function resolvesToKernel(src: string, name: string, depth: number): boolean {
  const decl = new RegExp(`(?:const|let|var|function)\\s+${name}\\b`).exec(src);
  if (!decl) return false;
  const snippet = src.slice(decl.index, decl.index + 1200);
  if (snippet.includes("runToolHandler(")) return true;
  if (depth <= 0) return false;
  const called = new Set(
    [...snippet.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map((c) => c[1]).filter((c) => c !== name),
  );
  for (const c of called) if (resolvesToKernel(src, c, depth - 1)) return true;
  return false;
}

function isKernelWrapped(after: string, src: string): boolean {
  const collapsed = after.replace(/\s+/g, " ");
  // Direct: `handler: (args) => runToolHandler(...)` (params may destructure).
  if (/^(async )?\((?:[^()]|\([^()]*\))*\) ?=> ?runToolHandler\(/.test(collapsed)) return true;
  // Reference: `handler: someLocalHandler,` — resolve the local declaration.
  const ref = /^([A-Za-z_$][\w$]*)\s*[,}]/.exec(collapsed);
  if (ref) return resolvesToKernel(src, ref[1], 2);
  return false;
}

test.describe("tool-kernel tripwire", () => {
  test("every *Actions.tsx handler routes through runToolHandler", () => {
    const dir = path.join(process.cwd(), "src", "components", "agent");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith("Actions.tsx"));
    expect(files.length).toBeGreaterThan(10);

    let handlers = 0;
    const failures: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(path.join(dir, file), "utf8");
      const re = /\bhandler:\s*/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        handlers += 1;
        const after = src.slice(m.index + m[0].length, m.index + m[0].length + 400);
        if (!isKernelWrapped(after, src)) {
          const line = src.slice(0, m.index).split("\n").length;
          failures.push(`${file}:${line} handler not wrapped in runToolHandler → ${after.slice(0, 70).replace(/\s+/g, " ")}…`);
        }
      }
    }
    expect(handlers).toBeGreaterThan(50); // sanity: the scan actually saw the tool surface
    expect(failures, failures.join("\n")).toEqual([]);
  });
});
