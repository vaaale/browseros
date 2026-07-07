import express from "express";
import cookieParser from "cookie-parser";
import http from "http";
import path from "path";
import { loadConfig } from "./config";
import { loadProvider } from "./auth/index";
import { createAuthRouter } from "./routers/auth";
import { createAdminRouter } from "./routers/admin";
import { createAccountRouter } from "./routers/account";
import { createBosProxy } from "./proxy";
import { initLifecycle, reconcileOnStartup } from "./lifecycle";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const provider = await loadProvider(cfg);

  initLifecycle(cfg);

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
}

main().catch((err: Error) => {
  console.error("[bastion] Fatal startup error:", err);
  process.exit(1);
});
