// Browser automation v2 — the STATEFUL session layer (redesign of 004).
//
// Reproduction of the defect this layer exists to fix: the only v2 path to a
// browser was the generic MCP gateway, whose callServerTool() connects, calls
// ONE tool, and closes in `finally` — for a stdio server that spawns a fresh
// @playwright/mcp process per call and kills it after, so browser_navigate in
// one call and browser_take_screenshot in the next hit two different browsers.
// Driving a browser (navigate → click → screenshot) requires ONE living
// process per (conversation, agent) session across many tool calls.
//   npx playwright test -c playwright.unit.config.ts tests/assistant/browser-session.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { tmpdir } from "os";
import {
  callBrowserTool,
  closeBrowserSession,
  shutdownBrowserSessions,
  _reapIdleBrowserSessions,
  _setBrowserSessionHooksForTests,
  BROWSER_SESSION_TTL_MS,
  type BrowserMcpClient,
} from "../../src/lib/automation/browser-session";

/** A fake MCP client factory that counts connections and calls, and lets a
 *  test see which client answered — the observable for "same session". */
function makeFakeBackend() {
  const state = { connects: 0, closed: [] as number[] };
  const connect = async (): Promise<BrowserMcpClient> => {
    const id = ++state.connects;
    let calls = 0;
    return {
      async callTool({ name }: { name: string }) {
        calls += 1;
        return { content: [{ type: "text", text: `client#${id} call#${calls} tool=${name}` }] };
      },
      async close() {
        state.closed.push(id);
      },
    };
  };
  return { state, connect };
}

function enabledHooks(connect: (server: unknown) => Promise<BrowserMcpClient>) {
  return {
    status: async () => ({
      enabled: true,
      browser: true,
      server: { name: "browser-automation", transport: "stdio" as const, command: "true" },
      outputHostDir: join(tmpdir(), "bos-browser-test-out"),
      outputVfsDir: "/Screenshots",
    }),
    connect,
  };
}

test.afterEach(async () => {
  await shutdownBrowserSessions();
  _setBrowserSessionHooksForTests(null);
});

test("two calls on the same session reuse ONE client — the browser stays alive between tools", async () => {
  const { state, connect } = makeFakeBackend();
  _setBrowserSessionHooksForTests(enabledHooks(connect));

  const a = await callBrowserTool("conv-1:agent", "browser_navigate", { url: "https://example.com" });
  const b = await callBrowserTool("conv-1:agent", "browser_take_screenshot", {});

  expect(state.connects).toBe(1);
  expect(a.content[0].text).toContain("client#1 call#1");
  expect(b.content[0].text).toContain("client#1 call#2");
});

test("different sessions get different browsers", async () => {
  const { state, connect } = makeFakeBackend();
  _setBrowserSessionHooksForTests(enabledHooks(connect));

  await callBrowserTool("conv-A:agent", "browser_navigate", { url: "https://example.com" });
  await callBrowserTool("conv-B:agent", "browser_navigate", { url: "https://example.com" });

  expect(state.connects).toBe(2);
});

test("concurrent first calls for one session share a single in-flight connect", async () => {
  const { state, connect } = makeFakeBackend();
  // Delay the connect so both calls are in flight before either resolves.
  _setBrowserSessionHooksForTests(
    enabledHooks(async (server) => {
      await new Promise((r) => setTimeout(r, 30));
      return connect(server);
    }),
  );

  await Promise.all([
    callBrowserTool("conv-race:agent", "browser_navigate", { url: "https://a.example" }),
    callBrowserTool("conv-race:agent", "browser_snapshot", {}),
  ]);
  expect(state.connects).toBe(1);
});

test("disabled automation is an in-band, actionable error — not a silent no-op", async () => {
  const { connect } = makeFakeBackend();
  _setBrowserSessionHooksForTests({
    status: async () => ({
      enabled: false,
      browser: true,
      server: null,
      outputHostDir: join(tmpdir(), "bos-browser-test-out"),
      outputVfsDir: "/Screenshots",
    }),
    connect,
  });

  await expect(callBrowserTool("conv-off:agent", "browser_navigate", { url: "https://example.com" }))
    .rejects.toThrow(/Settings → Browser Automation/);
});

test("no installed browser surfaces the probe's reason", async () => {
  const { connect } = makeFakeBackend();
  _setBrowserSessionHooksForTests({
    status: async () => ({
      enabled: true,
      browser: false,
      reason: "No Chromium build found in /nowhere. Run `npx playwright install chromium`.",
      server: null,
      outputHostDir: join(tmpdir(), "bos-browser-test-out"),
      outputVfsDir: "/Screenshots",
    }),
    connect,
  });

  await expect(callBrowserTool("conv-nobrowser:agent", "browser_snapshot", {}))
    .rejects.toThrow(/playwright install chromium/);
});

test("an idle session is reaped (client closed) and the next call starts fresh", async () => {
  const { state, connect } = makeFakeBackend();
  _setBrowserSessionHooksForTests(enabledHooks(connect));

  await callBrowserTool("conv-idle:agent", "browser_navigate", { url: "https://example.com" });
  expect(state.connects).toBe(1);

  // Simulate the reaper firing after the TTL has elapsed — no wall-clock wait.
  _reapIdleBrowserSessions(Date.now() + BROWSER_SESSION_TTL_MS + 1);
  expect(state.closed).toEqual([1]);

  await callBrowserTool("conv-idle:agent", "browser_snapshot", {});
  expect(state.connects).toBe(2);
});

test("a transport-level failure drops the session so the next call reconnects instead of wedging", async () => {
  const { state, connect } = makeFakeBackend();
  let failNext = false;
  _setBrowserSessionHooksForTests(
    enabledHooks(async (server) => {
      const client = await connect(server);
      const realCall = client.callTool.bind(client);
      client.callTool = async (params) => {
        if (failNext) {
          failNext = false;
          throw new Error("MCP error -32000: Connection closed");
        }
        return realCall(params);
      };
      return client;
    }),
  );

  await callBrowserTool("conv-crash:agent", "browser_navigate", { url: "https://example.com" });
  failNext = true;
  await expect(callBrowserTool("conv-crash:agent", "browser_click", { target: "e1" })).rejects.toThrow(/Connection closed/);

  // The dead client was discarded — not left wedged in the registry.
  expect(state.closed).toEqual([1]);
  const after = await callBrowserTool("conv-crash:agent", "browser_snapshot", {});
  expect(after.content[0].text).toContain("client#2");
});

test("closeBrowserSession ends the session deterministically", async () => {
  const { state, connect } = makeFakeBackend();
  _setBrowserSessionHooksForTests(enabledHooks(connect));

  await callBrowserTool("conv-close:agent", "browser_navigate", { url: "https://example.com" });
  expect(await closeBrowserSession("conv-close:agent")).toBe(true);
  expect(state.closed).toEqual([1]);
  // Closing a session that does not exist is a reportable no-op, not an error.
  expect(await closeBrowserSession("conv-close:agent")).toBe(false);
});
