import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getBrowserAutomationStatus, type BrowserAutomationStatus } from "./playwright-mcp";
import { connectMcpClient } from "@/lib/mcp/client";
import type { McpServerConfig } from "@/lib/mcp/types";
import { logger } from "@/lib/logging/server-logger";

// Stateful browser sessions (redesign of 004-browser-automation). One live
// @playwright/mcp process (= one browser) per session key, held open across
// tool calls so the model can DRIVE the browser: navigate → click → screenshot
// against the same page. This is the fix for the defect that killed the v1
// design: every generic-MCP-gateway call spawned a fresh stdio process and
// closed it after one tool, so no two browser tools ever saw the same page.
//
// Mirrors run-command.ts's sandbox-container registry: globalThis maps
// (hot-reload safe), in-flight connect dedup, idle reaper, shutdown hooks.

const COMPONENT = "browser-automation";

/** The subset of the MCP client the session layer needs — narrow on purpose so
 *  tests can stand in a fake without the SDK. */
export interface BrowserMcpClient {
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { timeout?: number; resetTimeoutOnProgress?: boolean },
  ): Promise<unknown>;
  close(): Promise<void>;
}

export interface BrowserSessionHooks {
  status(): Promise<BrowserAutomationStatus>;
  connect(server: McpServerConfig): Promise<BrowserMcpClient>;
}

export interface BrowserContentItem {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface BrowserToolCallResult {
  content: BrowserContentItem[];
  isError?: boolean;
  /** VFS folder screenshots land in (e.g. "/Screenshots"). */
  outputVfsDir: string;
  /** Host path of that folder, for rewriting paths the MCP server reports. */
  outputHostDir: string;
}

export const BROWSER_SESSION_TTL_MS = 15 * 60_000;
/** Per-tool-call ceiling. Individual page actions have their own Playwright
 *  timeouts well below this; the ceiling catches a wedged server process. */
const CALL_TIMEOUT_MS = 120_000;

const defaultHooks: BrowserSessionHooks = {
  status: getBrowserAutomationStatus,
  connect: (server) => connectMcpClient(server),
};
let hooks: BrowserSessionHooks = defaultHooks;

/** Test seam (§1.3 dependency inversion): swap the config/probe resolution and
 *  the MCP connect so unit tests never spawn a real browser. Pass null to restore. */
export function _setBrowserSessionHooksForTests(h: Partial<BrowserSessionHooks> | null): void {
  hooks = h ? { ...defaultHooks, ...h } : defaultHooks;
}

// ── Global session registry (survives hot-reloads via globalThis) ────────────
interface BrowserSession {
  client: BrowserMcpClient;
  lastUsed: number;
}
declare global {
  var __bosBrowserSessions: Map<string, BrowserSession> | undefined;
  var __bosBrowserCreating: Map<string, Promise<BrowserSession>> | undefined;
  var __bosBrowserReaper: ReturnType<typeof setInterval> | undefined;
  var __bosBrowserShutdown: boolean | undefined;
}
const g = globalThis as typeof globalThis & {
  __bosBrowserSessions?: Map<string, BrowserSession>;
  __bosBrowserCreating?: Map<string, Promise<BrowserSession>>;
  __bosBrowserReaper?: ReturnType<typeof setInterval>;
  __bosBrowserShutdown?: boolean;
};
if (!g.__bosBrowserSessions) g.__bosBrowserSessions = new Map();
const sessions = g.__bosBrowserSessions;
// In-flight connects, keyed by sessionKey — two overlapping first calls for
// the same session must share ONE spawning browser, not race to start two.
if (!g.__bosBrowserCreating) g.__bosBrowserCreating = new Map();
const creating = g.__bosBrowserCreating;

function installShutdownHooks(): void {
  if (g.__bosBrowserShutdown) return;
  g.__bosBrowserShutdown = true;
  const cleanup = () => {
    void shutdownBrowserSessions();
  };
  process.once("SIGTERM", cleanup);
  process.once("SIGINT", cleanup);
  process.once("exit", cleanup);
}

function scheduleReaper(): void {
  if (g.__bosBrowserReaper) return;
  g.__bosBrowserReaper = setInterval(() => _reapIdleBrowserSessions(Date.now()), 60_000);
  g.__bosBrowserReaper.unref?.();
}

/** Close every session idle past the TTL. Exported (with an injectable clock)
 *  so tests exercise the reap without waiting wall-clock minutes. */
export function _reapIdleBrowserSessions(now: number = Date.now()): void {
  for (const [key, s] of sessions) {
    if (now - s.lastUsed > BROWSER_SESSION_TTL_MS) {
      sessions.delete(key);
      s.client.close().catch((err) => {
        logger().warn(COMPONENT, "failed to close idle browser session", { key, error: (err as Error).message });
      });
      logger().debug(COMPONENT, "reaped idle browser session", { key });
    }
  }
}

async function createSession(server: McpServerConfig, outputHostDir: string, key: string): Promise<BrowserSession> {
  // The MCP server writes screenshots into --output-dir; make sure the VFS
  // folder exists before the first one lands.
  await fs.mkdir(outputHostDir, { recursive: true });
  const client = await hooks.connect(server);
  const session: BrowserSession = { client, lastUsed: Date.now() };
  sessions.set(key, session);
  scheduleReaper();
  installShutdownHooks();
  logger().info(COMPONENT, "browser session started", { key });
  return session;
}

/** Get (or start) this session's browser, at most once at a time per key. */
async function ensureSession(server: McpServerConfig, outputHostDir: string, key: string): Promise<BrowserSession> {
  const existing = sessions.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing;
  }
  const pending = creating.get(key);
  if (pending) return pending;
  const attempt = createSession(server, outputHostDir, key).finally(() => creating.delete(key));
  creating.set(key, attempt);
  return attempt;
}

/** Drop a session from the registry and close its client. */
async function dropSession(key: string): Promise<boolean> {
  const s = sessions.get(key);
  if (!s) return false;
  sessions.delete(key);
  try {
    await s.client.close();
  } catch (err) {
    // The process may already be gone (that is often WHY we are dropping it) —
    // log rather than fail the caller, but never silently.
    logger().warn(COMPONENT, "error closing browser session", { key, error: (err as Error).message });
  }
  return true;
}

/**
 * Call one tool in the session's live browser, starting the browser on first
 * use. Throws with an actionable message when automation is disabled or no
 * browser is installed; a transport-level failure drops the session so the
 * next call starts fresh instead of hitting a dead process forever.
 */
export async function callBrowserTool(
  sessionKey: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<BrowserToolCallResult> {
  const status = await hooks.status();
  if (!status.enabled) {
    throw new Error(
      "Browser automation is off. Ask the user to enable it in Settings → Browser Automation (it drives a real browser, so it is opt-in).",
    );
  }
  if (!status.server) {
    throw new Error(status.reason ?? "Browser automation is enabled but no browser is available.");
  }

  // @playwright/mcp resolves a relative screenshot `filename` against its own
  // process cwd — NOT --output-dir — which would drop files outside the VFS
  // (observed: repo root). Pin every filename inside the output dir, and refuse
  // anything that could escape it.
  if (tool === "browser_take_screenshot" && typeof args.filename === "string" && args.filename.trim()) {
    const norm = args.filename.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (norm.startsWith("/") || norm.split("/").some((seg) => seg === "..")) {
      throw new Error(`filename must be a relative path (it is saved under ${status.outputVfsDir}) — got "${args.filename}"`);
    }
    const abs = path.join(status.outputHostDir, norm);
    // The server does not create parent directories — a subfolder filename
    // (e.g. "docs/shot.png") would fail with a screenshot error otherwise.
    await fs.mkdir(path.dirname(abs), { recursive: true });
    args = { ...args, filename: abs };
  }

  const session = await ensureSession(status.server, status.outputHostDir, sessionKey);
  let res: { content?: BrowserContentItem[]; isError?: boolean };
  try {
    res = (await session.client.callTool({ name: tool, arguments: args }, undefined, {
      timeout: CALL_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
    })) as { content?: BrowserContentItem[]; isError?: boolean };
  } catch (err) {
    // A throw here is transport-level (the stdio process died, timed out or the
    // pipe broke) — tool-level failures come back as `isError` results instead.
    // Keeping the dead client registered would wedge every later call, so drop
    // it; the next call reconnects with a fresh browser.
    await dropSession(sessionKey);
    throw new Error(`${(err as Error).message} (the browser session was reset — the next browser call starts a fresh browser)`);
  }
  session.lastUsed = Date.now();
  return {
    content: res.content ?? [],
    isError: res.isError,
    outputVfsDir: status.outputVfsDir,
    outputHostDir: status.outputHostDir,
  };
}

/** End a session deliberately (the browser_close tool). Returns whether one existed. */
export async function closeBrowserSession(sessionKey: string): Promise<boolean> {
  const dropped = await dropSession(sessionKey);
  if (dropped) logger().info(COMPONENT, "browser session closed", { key: sessionKey });
  return dropped;
}

/** Close every session (server shutdown). */
export async function shutdownBrowserSessions(): Promise<void> {
  const keys = [...sessions.keys()];
  await Promise.all(keys.map((key) => dropSession(key)));
}
