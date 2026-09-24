// The Chromium probe vs. Playwright's CURRENT install layout.
//
// Reproduction: with Playwright 1.61, `npx playwright install chromium` lays
// the browser down as chromium-<rev>/chrome-linux64/chrome (the chrome-for-
// testing directory scheme: linux64 / mac-x64 / mac-arm64 / win64). probe.ts
// only looked for the pre-CfT names (chrome-linux/chrome, chrome-mac/…), so on
// any current install detectPlaywright() reported "no browser" and browser
// automation silently degraded to OFF — with a freshly installed Chromium
// sitting right there. Observed live: chromium-1228/chrome-linux64/chrome
// installed, probe reason "No Chromium build found".
//   npm run test:unit -- tests/assistant/playwright-probe.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { detectPlaywright } from "../../src/lib/playwright/probe";

function layBrowser(root: string, build: string, subdir: string, binary: string): void {
  const dir = join(root, build, subdir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, binary), "#!/bin/sh\n");
}

function withBrowsersPath<T>(root: string, fn: () => T): T {
  const prev = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env.PLAYWRIGHT_BROWSERS_PATH = root;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = prev;
  }
}

test("detects a CfT-layout Chromium (chrome-linux64/, Playwright ≥1.5x)", () => {
  test.skip(process.platform !== "linux", "layout under test is the linux one");
  const root = join(tmpdir(), `bos-probe-cft-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  layBrowser(root, "chromium-1228", "chrome-linux64", "chrome");
  try {
    const caps = withBrowsersPath(root, detectPlaywright);
    expect(caps.browser, caps.reason).toBe(true);
    expect(caps.chromiumExecutable).toBe(join(root, "chromium-1228", "chrome-linux64", "chrome"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("still detects the pre-CfT layout (chrome-linux/)", () => {
  test.skip(process.platform !== "linux", "layout under test is the linux one");
  const root = join(tmpdir(), `bos-probe-legacy-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  layBrowser(root, "chromium-1100", "chrome-linux", "chrome");
  try {
    const caps = withBrowsersPath(root, detectPlaywright);
    expect(caps.browser, caps.reason).toBe(true);
    expect(caps.chromiumExecutable).toBe(join(root, "chromium-1100", "chrome-linux", "chrome"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("falls back to a system Chrome (channel install) when the browsers dir has no bundled build", () => {
  // Reproduction (production, 2026-09-22): the Docker image runs
  // `npx playwright install --force chrome`, which installs the CHROME CHANNEL
  // to the system location (/opt/google/chrome/chrome) and leaves
  // PLAYWRIGHT_BROWSERS_PATH (/opt/playwright-browsers) without any
  // chromium-<rev> build. The probe only scanned the browsers dir, so
  // browser_navigate answered "No Chromium build found in
  // /opt/playwright-browsers" on a machine with a working Chrome installed.
  const root = join(tmpdir(), `bos-probe-channel-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true }); // empty browsers dir
  const chrome = join(root, "fake-system-chrome");
  writeFileSync(chrome, "#!/bin/sh\n");
  try {
    const caps = withBrowsersPath(root, () => detectPlaywright({ systemChromeCandidates: [chrome] }));
    expect(caps.browser, caps.reason).toBe(true);
    expect(caps.chromiumExecutable).toBe(chrome);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bundled Chromium is preferred over a system Chrome", () => {
  test.skip(process.platform !== "linux", "layout under test is the linux one");
  const root = join(tmpdir(), `bos-probe-prefer-bundled-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  layBrowser(root, "chromium-1228", "chrome-linux64", "chrome");
  const systemChrome = join(root, "fake-system-chrome");
  writeFileSync(systemChrome, "#!/bin/sh\n");
  try {
    const caps = withBrowsersPath(root, () => detectPlaywright({ systemChromeCandidates: [systemChrome] }));
    expect(caps.chromiumExecutable).toBe(join(root, "chromium-1228", "chrome-linux64", "chrome"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the no-browser reason names both install options", () => {
  const root = join(tmpdir(), `bos-probe-reason-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  try {
    const caps = withBrowsersPath(root, () => detectPlaywright({ systemChromeCandidates: [join(root, "nope")] }));
    expect(caps.browser).toBe(false);
    expect(caps.reason).toContain("playwright install chromium");
    expect(caps.reason).toContain("chrome");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prefers the newest build when several are installed", () => {
  test.skip(process.platform !== "linux", "layout under test is the linux one");
  const root = join(tmpdir(), `bos-probe-newest-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  layBrowser(root, "chromium-1100", "chrome-linux", "chrome");
  layBrowser(root, "chromium-1228", "chrome-linux64", "chrome");
  try {
    const caps = withBrowsersPath(root, detectPlaywright);
    expect(caps.chromiumExecutable).toContain("chromium-1228");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
