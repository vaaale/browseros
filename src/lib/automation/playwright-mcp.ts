import "server-only";
import type { McpServerConfig } from "@/lib/mcp/types";
import { getRegistration } from "@/lib/config/registry";
import { detectPlaywright } from "@/lib/playwright/probe";
import { hostPath } from "@/os/vfs";

// Builds a *managed* Playwright MCP server from the `browser-automation` config
// (specs/004-browser-automation/spec.md). It is not persisted to
// data/mcp-servers.json — it is derived per call, so policy changes apply with
// no restart. Consumed by the stateful session layer (browser-session.ts),
// which the browser_* registry tools drive.

export interface BrowserAutomationConfig {
  enabled: boolean;
  command: string;
  headless: boolean;
  isolated: boolean;
  downloads: boolean;
  allowedOrigins: string;
  blockedOrigins: string;
  consentPolicy: string;
}

/** VFS folder where the browser writes screenshots and other output files —
 *  chosen so everything the browser produces is visible in the Files app and
 *  addressable by the file_* tools, instead of dying in a temp dir. */
export const SCREENSHOTS_VFS_DIR = "/Screenshots";

export interface BrowserAutomationStatus {
  /** Master switch (Settings → Browser Automation). */
  enabled: boolean;
  /** A Chromium build is installed (probe). */
  browser: boolean;
  /** Human-readable explanation when `server` is null despite `enabled`. */
  reason?: string;
  /** Ready-to-connect server config, or null when disabled/unavailable. */
  server: McpServerConfig | null;
  /** Host path of SCREENSHOTS_VFS_DIR (passed as --output-dir). */
  outputHostDir: string;
  outputVfsDir: string;
}

function toOriginList(raw: string): string {
  // Playwright MCP expects a semicolon-separated origin list (no spaces).
  return (raw || "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(";");
}

/**
 * Resolve the browser-automation state: the master switch, the browser probe,
 * and (when both pass) the ready-to-connect Playwright MCP server config.
 * Callers that only need go/no-go read `server`; the session layer also uses
 * the output dirs and the reason for actionable error messages.
 */
export async function getBrowserAutomationStatus(): Promise<BrowserAutomationStatus> {
  const outputVfsDir = SCREENSHOTS_VFS_DIR;
  const outputHostDir = hostPath(outputVfsDir);
  const base = { outputHostDir, outputVfsDir };

  const reg = getRegistration("browser-automation");
  if (!reg) {
    return { ...base, enabled: false, browser: false, server: null, reason: "browser-automation config namespace is not registered" };
  }
  const cfg = (await reg.load()) as unknown as BrowserAutomationConfig;
  const caps = detectPlaywright();
  if (!cfg.enabled) return { ...base, enabled: false, browser: caps.browser, server: null };
  // Probe-and-degrade: no browser → no automation tools, with the probe's
  // install hint carried through so the agent can tell the user what to do.
  if (!caps.browser) return { ...base, enabled: true, browser: false, server: null, reason: caps.reason };

  // The user-configured launcher is a command LINE (whitespace-split, as
  // documented in Settings); everything BOS appends goes into args as discrete
  // values, so paths with spaces (--output-dir, --executable-path) are safe.
  const [command, ...args] = (cfg.command || "npx @playwright/mcp").trim().split(/\s+/);
  if (cfg.headless) args.push("--headless");
  if (cfg.isolated) args.push("--isolated");
  // The user container has no CAP_SYS_ADMIN and no seccomp override for
  // Chromium's own setuid sandbox, so it fails to initialize without this —
  // observed as browser processes crashing/wedging on launch (never a clean
  // error), which piled up as zombies and made agent browser-tool calls hang
  // for minutes waiting on a wedged process instead of failing fast.
  args.push("--no-sandbox");
  // Reuse the installed Playwright Chromium (the MCP server otherwise wants a
  // separate chrome-for-testing build). The probe resolves the bundled binary.
  if (caps.chromiumExecutable) args.push("--executable-path", caps.chromiumExecutable);
  // Screenshots/output land in the VFS, not a temp dir (see SCREENSHOTS_VFS_DIR).
  // Setting --output-dir alone flips the server into file-output mode, where
  // even page SNAPSHOTS are written to .yml files instead of returned inline —
  // useless to the model. Pin stdout mode: snapshots stay in the tool result,
  // screenshots are still saved to the output dir.
  args.push("--output-dir", outputHostDir, "--output-mode", "stdout");

  const allowed = toOriginList(cfg.allowedOrigins);
  if (allowed) args.push("--allowed-origins", allowed);
  const blocked = toOriginList(cfg.blockedOrigins);
  if (blocked) args.push("--blocked-origins", blocked);

  return {
    ...base,
    enabled: true,
    browser: true,
    server: { name: "browser-automation", transport: "stdio", command, args },
  };
}

/**
 * The Playwright MCP server config, or null when automation is disabled or no
 * browser is available (graceful degrade). Kept for the legacy CopilotKit
 * runtime path (agent/runtime.ts); new code should use the session layer.
 */
export async function getBrowserAutomationServer(): Promise<McpServerConfig | null> {
  return (await getBrowserAutomationStatus()).server;
}
