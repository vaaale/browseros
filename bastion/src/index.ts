import express from "express";
import cookieParser from "cookie-parser";
import http from "http";
import path from "path";
import fs from "fs";
import { loadConfig } from "./config";
import { loadProvider } from "./auth/index";
import { createAuthRouter } from "./routers/auth";
import { createAdminRouter } from "./routers/admin";
import { createAccountRouter } from "./routers/account";
import { createSetupRouter } from "./routers/setup";
import { createBosProxy } from "./proxy";
import { initLifecycle, reconcileOnStartup, getAllInstances, stopInstance } from "./lifecycle";
import { initLogStore } from "./log-store";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const provider = await loadProvider(cfg);

  initLifecycle(cfg);
  initLogStore(cfg.dataDir);

  const app = express();

  // cookieParser must be global — the proxy middleware reads the session cookie.
  app.use(cookieParser());
  // No global body parsers. app.use("/", ...) matches EVERY path, so putting
  // body parsers there would consume the request body stream before the proxy
  // could forward it. Body parsers are applied inside each router instead.

  // Serve the Vite-built admin/login/account SPA under /app/*
  const uiDist = path.join(__dirname, "..", "ui", "dist");
  app.use("/app", express.static(uiDist));
  app.get("/app/*", (_req, res) => {
    res.sendFile(path.join(uiDist, "index.html"));
  });

  // Avatar serving — no auth required; validates username charset to prevent
  // path traversal before constructing the file path.
  const DEFAULT_AVATAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="#374151"/><circle cx="20" cy="16" r="7" fill="#6b7280"/><ellipse cx="20" cy="34" rx="12" ry="8" fill="#6b7280"/></svg>`;
  app.get("/avatar/:username", (req, res) => {
    const { username } = req.params;
    if (!/^[a-z0-9_-]+$/.test(username)) { res.status(400).send("Invalid username"); return; }
    const avatarDir = path.join(cfg.dataDir, "avatars");
    for (const ext of ["png", "jpg", "gif", "webp"]) {
      const f = path.join(avatarDir, `${username}.${ext}`);
      if (fs.existsSync(f)) { res.sendFile(f); return; }
    }
    // Serve bundled SVG default avatar.
    res.setHeader("Content-Type", "image/svg+xml");
    res.send(DEFAULT_AVATAR_SVG);
  });

  // Setup router — no auth required; must be mounted before the auth router.
  app.use("/setup", createSetupRouter(cfg, provider));

  app.use("/", createAuthRouter(cfg, provider));
  app.use("/admin", createAdminRouter(cfg, provider));
  app.use("/account", createAccountRouter(cfg, provider));

  // BOS proxy — catch-all, must be last, no body parsers applied above this.
  const bosProxy = createBosProxy(cfg);
  app.use(bosProxy);

  const server = http.createServer(app);

  server.listen(cfg.port, () => {
    console.log(`[bastion] Listening on :${cfg.port}  auth=${cfg.authProvider}`);
  });

  // Reconcile running containers with our state map
  reconcileOnStartup(cfg).catch((err: Error) =>
    console.error("[bastion] Reconciliation failed:", err),
  );

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[bastion] ${signal} received — stopping all user containers…`);
    server.close();
    const running = getAllInstances().filter((s) => s.status === "running");
    await Promise.allSettled(running.map((s) => {
      console.log(`[bastion] stopping container for ${s.username}`);
      return stopInstance(s.username);
    }));
    console.log("[bastion] all containers stopped, exiting.");
    process.exit(0);
  }

  process.on("SIGINT",  () => { void shutdown("SIGINT");  });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
}

main().catch((err: Error) => {
  console.error("[bastion] Fatal startup error:", err);
  process.exit(1);
});
