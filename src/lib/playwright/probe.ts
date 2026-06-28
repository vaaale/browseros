import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Shared Playwright capability probe used by both self-testing
// (specs/008-self-testing/spec.md) and browser automation
// (specs/004-browser-automation/spec.md). Lightweight and dependency-free:
// it checks the filesystem rather than importing Playwright, so it is safe to
// call from any server context. Both features degrade gracefully when a
// browser is unavailable instead of failing hard.

export interface PlaywrightCapabilities {
  /** @playwright/test is installed (the e2e test runner). */
  testRunner: boolean;
  /** @playwright/mcp is installed (the browser-automation MCP server). */
  mcp: boolean;
  /** A Chromium build is present in the Playwright browser cache. */
  browser: boolean;
  /** Absolute path to the installed Chromium binary, if found (reused by automation). */
  chromiumExecutable?: string;
  /** Where browser builds are expected. */
  browsersDir: string;
  /** Human-readable explanation when something is missing. */
  reason?: string;
}

function hasPackage(name: string): boolean {
  try {
    return fs.existsSync(path.join(process.cwd(), "node_modules", name, "package.json"));
  } catch {
    return false;
  }
}

function browsersDir(): string {
  const override = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (override && override !== "0") return override;
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Caches", "ms-playwright");
    case "win32":
      return path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ms-playwright");
    default:
      return path.join(home, ".cache", "ms-playwright");
  }
}

// Resolve the bundled Chromium binary (the `chromium-<rev>` build, not the
// headless_shell). The browser-automation feature passes this to the Playwright
// MCP server via --executable-path so it reuses the same browser the e2e suite
// installed, instead of downloading a separate chrome-for-testing build.
function chromiumExecutablePath(dir: string): string | undefined {
  try {
    const builds = fs
      .readdirSync(dir)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort();
    const build = builds[builds.length - 1];
    if (!build) return undefined;
    const root = path.join(dir, build);
    const candidates =
      process.platform === "darwin"
        ? [path.join(root, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium")]
        : process.platform === "win32"
          ? [path.join(root, "chrome-win", "chrome.exe")]
          : [path.join(root, "chrome-linux", "chrome")];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return undefined;
  } catch {
    return undefined;
  }
}

export function detectPlaywright(): PlaywrightCapabilities {
  const dir = browsersDir();
  const chromiumExecutable = chromiumExecutablePath(dir);
  const browser = !!chromiumExecutable;
  const testRunner = hasPackage("@playwright/test");
  const mcp = hasPackage("@playwright/mcp");
  const reason = browser
    ? undefined
    : `No Chromium build found in ${dir}. Run \`npx playwright install chromium\`.`;
  return { testRunner, mcp, browser, chromiumExecutable, browsersDir: dir, reason };
}
