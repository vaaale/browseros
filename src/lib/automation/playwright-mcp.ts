import "server-only";
import type { McpServerConfig } from "@/lib/mcp/types";
import { getRegistration } from "@/lib/config/registry";
import { detectPlaywright } from "@/lib/playwright/probe";

// Builds a *managed* Playwright MCP server from the `browser-automation` config
// (specs/004-browser-automation/spec.md). It is not persisted to
// data/mcp-servers.json — it is derived per request and appended to the agent's
// MCP servers in runtime.ts, so policy changes apply with no restart.

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

function toOriginList(raw: string): string {
  // Playwright MCP expects a semicolon-separated origin list (no spaces).
  return (raw || "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(";");
}

/**
 * Resolve the Playwright MCP server config, or null when automation is disabled
 * or no browser is available (graceful degrade — the agent simply gets no
 * browser tools rather than failing).
 */
export async function getBrowserAutomationServer(): Promise<McpServerConfig | null> {
  const reg = getRegistration("browser-automation");
  if (!reg) return null;
  const cfg = (await reg.load()) as unknown as BrowserAutomationConfig;
  if (!cfg.enabled) return null;

  // Probe-and-degrade: no browser → no automation tools.
  const caps = detectPlaywright();
  if (!caps.browser) return null;

  const base = (cfg.command || "npx @playwright/mcp").trim();
  const args: string[] = [];
  if (cfg.headless) args.push("--headless");
  if (cfg.isolated) args.push("--isolated");
  // Reuse the installed Playwright Chromium (the MCP server otherwise wants a
  // separate chrome-for-testing build). The probe resolves the bundled binary.
  if (caps.chromiumExecutable) args.push("--executable-path", caps.chromiumExecutable);

  const allowed = toOriginList(cfg.allowedOrigins);
  if (allowed) args.push("--allowed-origins", allowed);
  const blocked = toOriginList(cfg.blockedOrigins);
  if (blocked) args.push("--blocked-origins", blocked);

  // The endpoint is split on whitespace into command+argv by the stdio
  // transport, so no argument value may contain spaces (origin lists use ";").
  const endpoint = [base, ...args].join(" ");
  return { name: "browser-automation", endpoint, transport: "stdio" };
}
