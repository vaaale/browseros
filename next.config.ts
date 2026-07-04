import type { NextConfig } from "next";

// Dev-only: let `next dev` accept HMR + cross-origin dev requests from these
// hosts — needed when BrowserOS is reached through the Supervisor proxy under a
// LAN hostname (e.g. wingman.akhbar.lan) instead of localhost. Comma-separated
// via BOS_DEV_ORIGINS; empty by default (no change). Ignored by `next start`
// (production), so full-mode supervisor serving works on any host without it.
const allowedDevOrigins = (process.env.BOS_DEV_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  // The browser proxy uses path-based URLs (/api/proxy/https/host/path/). A
  // trailing-slash redirect would strip the slash and break relative URL
  // resolution inside proxied pages, so disable that redirect.
  skipTrailingSlashRedirect: true,
  // esbuild (used to build per-app projects at install time) ships a native
  // binary and must not be bundled by the server compiler — keep it external.
  serverExternalPackages: ["esbuild"],
  // Pin Turbopack's workspace root so it doesn't walk beyond this directory
  // (the `specs/` symlink points outside the checkout and would confuse it).
  turbopack: {
    root: __dirname,
    // Suppress symlink-resolution errors from the external `specs/` symlink.
    ignoreIssue: [{ path: "specs/**" }, { path: "**/specs/**" }],
  },
  // Exclude the external `specs/` symlink from file tracing (dev + build).
  outputFileTracingExcludes: {
    "*": ["specs", "specs/**", "./specs", "./specs/**"],
  },
  ...(allowedDevOrigins.length ? { allowedDevOrigins } : {}),
};

export default nextConfig;
