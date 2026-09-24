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
//
// Playwright changed the layout inside a build around 1.5x to the
// chrome-for-testing directory scheme (chrome-linux64/, chrome-mac-x64/,
// chrome-mac-arm64/, chrome-win64/); older builds used chrome-linux/,
// chrome-mac/, chrome-win/. Both are probed — only checking the old names made
// detectPlaywright() report "no browser" against a freshly installed Chromium,
// which silently disabled browser automation on every current install.
function candidateBinaries(root: string): string[] {
  switch (process.platform) {
    case "darwin":
      return [
        path.join(root, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
        path.join(root, `chrome-mac-${process.arch === "arm64" ? "arm64" : "x64"}`, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
      ];
    case "win32":
      return [path.join(root, "chrome-win", "chrome.exe"), path.join(root, "chrome-win64", "chrome.exe")];
    default:
      return [path.join(root, "chrome-linux", "chrome"), path.join(root, "chrome-linux64", "chrome")];
  }
}

function chromiumExecutablePath(dir: string): string | undefined {
  try {
    // Numeric sort, newest first — lexicographic ordering would rank a future
    // "chromium-999"-style name above "chromium-1228".
    const builds = fs
      .readdirSync(dir)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.slice("chromium-".length)) - Number(a.slice("chromium-".length)));
    for (const build of builds) {
      for (const c of candidateBinaries(path.join(dir, build))) {
        if (fs.existsSync(c)) return c;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// Chrome CHANNEL installs (`npx playwright install chrome`) land at the OS
// location, NOT under PLAYWRIGHT_BROWSERS_PATH — the BOS Docker image installs
// exactly this way, so its browsers dir is empty while a working Chrome sits at
// /opt/google/chrome/chrome. The probe accepts these as a fallback; the bundled
// Chromium stays preferred (version-matched to the Playwright in the repo).
function defaultSystemChromeCandidates(): string[] {
  switch (process.platform) {
    case "darwin":
      return [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ];
    case "win32":
      return [
        path.join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      ];
    default:
      return [
        "/opt/google/chrome/chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
      ];
  }
}

export interface ProbeOptions {
  /** Test seam: overrides the OS-specific system Chrome locations. */
  systemChromeCandidates?: string[];
}

export function detectPlaywright(opts?: ProbeOptions): PlaywrightCapabilities {
  const dir = browsersDir();
  let chromiumExecutable = chromiumExecutablePath(dir);
  if (!chromiumExecutable) {
    const candidates = opts?.systemChromeCandidates ?? defaultSystemChromeCandidates();
    chromiumExecutable = candidates.find((c) => fs.existsSync(c));
  }
  const browser = !!chromiumExecutable;
  const testRunner = hasPackage("@playwright/test");
  const mcp = hasPackage("@playwright/mcp");
  const reason = browser
    ? undefined
    : `No Chromium build found in ${dir} and no system Chrome at the known locations. ` +
      "Run `npx playwright install chromium` (or `npx playwright install chrome` for the system-wide channel).";
  return { testRunner, mcp, browser, chromiumExecutable, browsersDir: dir, reason };
}
