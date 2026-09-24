// Browser automation v2 — the browser_* SERVER TOOLS (redesign of 004).
//
// Reproduction: the old feature exposed browser tools only through
// buildRuntimeOptions(), whose sole consumer is the retired CopilotKit route —
// so the v2 assistant NEVER saw a browser tool, and Settings → Browser
// Automation toggled dead wiring. The tools must be first-class registry
// server tools (reaching chat, sub-agents and headless runs), screenshots must
// reach the model as vision attachments AND land in the VFS (the old MCP-
// gateway path dropped `type:"image"` content and wrote files to a temp dir
// outside the VFS).
//   npx playwright test -c playwright.unit.config.ts tests/assistant/browser-tools.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join, relative } from "path";
import { tmpdir } from "os";
import type { ToolContext, ToolExecuteResult } from "../../src/lib/assistant/tools";
import { browserTools } from "../../src/lib/assistant/tools/server/browser";
import {
  shutdownBrowserSessions,
  _setBrowserSessionHooksForTests,
  type BrowserMcpClient,
} from "../../src/lib/automation/browser-session";

const OUT_DIR = join(tmpdir(), "bos-browser-tools-out");

function ctx(conversationId = "conv-t", agentId = "agent-t"): ToolContext {
  return {
    signal: new AbortController().signal,
    conversationId,
    agentId,
    onEvent: () => {},
    elicit: async () => "",
    delegationDepth: 0,
    runId: "run-t",
  };
}

type FakeResult = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };

function installFake(respond: (tool: string, args: Record<string, unknown>) => FakeResult) {
  const state = { closed: 0, calls: [] as string[], args: [] as Record<string, unknown>[] };
  _setBrowserSessionHooksForTests({
    status: async () => ({
      enabled: true,
      browser: true,
      server: { name: "browser-automation", transport: "stdio" as const, command: "true" },
      outputHostDir: OUT_DIR,
      outputVfsDir: "/Screenshots",
    }),
    connect: async (): Promise<BrowserMcpClient> => ({
      async callTool({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) {
        state.calls.push(name);
        state.args.push(args ?? {});
        return respond(name, args ?? {});
      },
      async close() {
        state.closed += 1;
      },
    }),
  });
  return state;
}

test.afterEach(async () => {
  await shutdownBrowserSessions();
  _setBrowserSessionHooksForTests(null);
});

test("the registry exposes the browser driving tools as server tools", async () => {
  const { assistantTools } = await import("../../src/lib/assistant/registry");
  const tools = assistantTools();
  for (const name of [
    "browser_navigate",
    "browser_snapshot",
    "browser_click",
    "browser_type",
    "browser_take_screenshot",
    "browser_close",
  ]) {
    expect(tools[name], `${name} should be a registry tool`).toBeDefined();
    expect(tools[name].execution, `${name} must be a server tool (headless-capable)`).toBe("server");
  }
});

test("navigate returns the server's text (snapshot) unchanged", async () => {
  installFake(() => ({ content: [{ type: "text", text: "### Page state\n- Page URL: https://example.com" }] }));
  const out = await browserTools().browser_navigate.execute!({ url: "https://example.com" }, ctx("c-nav"));
  expect(typeof out === "string" ? out : (out as ToolExecuteResult).text).toContain("Page URL: https://example.com");
});

test("page-changing tools compose an INLINE snapshot — the model must never chase a .yml file link", async () => {
  // @playwright/mcp 0.0.76 answers navigate/click/… with only a LINK to a
  // snapshot file it saved (even in --output-mode stdout); the element refs the
  // model needs are in browser_snapshot's inline yaml. The proxy composes the
  // two so every action ends with the current page's refs in the result.
  const state = installFake((tool) =>
    tool === "browser_snapshot"
      ? { content: [{ type: "text", text: '```yaml\n- link "Next page" [ref=e2]\n```' }] }
      : { content: [{ type: "text", text: "### Page\n- [Snapshot](Screenshots/page-x.yml)" }] },
  );
  const out = await browserTools().browser_navigate.execute!({ url: "https://example.com" }, ctx("c-compose"));
  const text = typeof out === "string" ? out : (out as ToolExecuteResult).text;
  expect(text).toContain('[ref=e2]');
  expect(state.calls).toEqual(["browser_navigate", "browser_snapshot"]);
});

test("read-only tools do NOT trigger the snapshot follow-up", async () => {
  const state = installFake(() => ({ content: [{ type: "text", text: "log line" }] }));
  await browserTools().browser_console_messages.execute!({}, ctx("c-nofollow"));
  expect(state.calls).toEqual(["browser_console_messages"]);
});

test("a screenshot reaches the model as a vision attachment AND reports its VFS path", async () => {
  const b64 = Buffer.from("fake-png-bytes").toString("base64");
  installFake((tool) =>
    tool === "browser_take_screenshot"
      ? {
          content: [
            { type: "text", text: `Took the viewport screenshot and saved it as ${OUT_DIR}/page-2026-09-22.png` },
            { type: "image", data: b64, mimeType: "image/png" },
          ],
        }
      : { content: [{ type: "text", text: "ok" }] },
  );

  const out = (await browserTools().browser_take_screenshot.execute!({}, ctx("c-shot"))) as ToolExecuteResult;
  expect(typeof out).toBe("object");
  // The host path is meaningless to the user and to file tools — the VFS path
  // (visible in the Files app) is the contract.
  expect(out.text).toContain("/Screenshots/page-2026-09-22.png");
  expect(out.text).not.toContain(OUT_DIR);
  expect(out.attachments?.[0]?.mimeType).toBe("image/png");
  expect(out.attachments?.[0]?.data).toBe(b64);
});

test("a user-chosen screenshot filename is pinned INSIDE /Screenshots — never the server's cwd", async () => {
  // @playwright/mcp 0.0.76 resolves a relative `filename` against the PROCESS
  // cwd (observed: probe.png written into the repo root), silently escaping
  // both --output-dir and the VFS. The session layer must absolutize it into
  // the output dir before the server sees it.
  const state = installFake(() => ({ content: [{ type: "text", text: "ok" }] }));
  await browserTools().browser_take_screenshot.execute!({ filename: "docs/shot.png" }, ctx("c-fname"));
  expect(state.args[0].filename).toBe(join(OUT_DIR, "docs/shot.png"));
});

test("a traversal screenshot filename is refused, not resolved", async () => {
  const state = installFake(() => ({ content: [{ type: "text", text: "ok" }] }));
  const out = await browserTools().browser_take_screenshot.execute!({ filename: "../../evil.png" }, ctx("c-evil"));
  expect(out).toMatch(/^Error: browser_take_screenshot: /);
  expect(state.calls, "nothing may reach the browser with an escaping path").toEqual([]);
});

test("cwd-relative output paths in the server's text are rewritten to VFS paths too", async () => {
  // The server links saved files RELATIVE TO ITS CWD (e.g. ../../tmp/…/x.png),
  // not by the absolute --output-dir string — both spellings must map to the
  // VFS path the user can actually open.
  const relOut = relative(process.cwd(), OUT_DIR);
  installFake(() => ({
    content: [{ type: "text", text: `### Result\n- [Screenshot of viewport](${relOut}/page-1.png)` }],
  }));
  const out = await browserTools().browser_take_screenshot.execute!({}, ctx("c-relpath"));
  const text = typeof out === "string" ? out : (out as ToolExecuteResult).text;
  expect(text).toContain("(/Screenshots/page-1.png)");
  expect(text, "no cwd-relative residue may survive the rewrite").not.toContain("..");
});

test("an MCP-level tool failure comes back as an in-band Error string", async () => {
  installFake(() => ({ content: [{ type: "text", text: 'No element with ref "e99" in the current snapshot' }], isError: true }));
  const out = await browserTools().browser_click.execute!({ target: "e99" }, ctx("c-err"));
  expect(out).toMatch(/^Error: browser_click: /);
  expect(out).toContain("e99");
});

test("browser_close ends the whole session (kills the browser), not just the page", async () => {
  const state = installFake(() => ({ content: [{ type: "text", text: "ok" }] }));
  const tools = browserTools();
  await tools.browser_navigate.execute!({ url: "https://example.com" }, ctx("c-close"));
  const out = await tools.browser_close.execute!({}, ctx("c-close"));
  expect(state.closed).toBe(1);
  expect(typeof out === "string" ? out : (out as ToolExecuteResult).text).toMatch(/closed/i);
});

test("disabled automation surfaces as an in-band error naming the setting", async () => {
  _setBrowserSessionHooksForTests({
    status: async () => ({
      enabled: false,
      browser: true,
      server: null,
      outputHostDir: OUT_DIR,
      outputVfsDir: "/Screenshots",
    }),
    connect: async () => {
      throw new Error("connect must not be reached when disabled");
    },
  });
  const out = await browserTools().browser_navigate.execute!({ url: "https://example.com" }, ctx("c-off"));
  expect(out).toMatch(/^Error: browser_navigate: /);
  expect(out).toContain("Settings → Browser Automation");
});
