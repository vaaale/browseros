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

  // Body parsers are scoped to bastion-owned routes ONLY.
  // Applying them globally consumes the request body stream before the proxy
  // can forward it, causing all POST/PUT/PATCH requests to BOS to arrive empty.
  const body = [express.json(), express.urlencoded({ extended: false })];

  // Serve the Vite-built admin/login/account SPA under /app/*
  const uiDist = path.join(__dirname, "..", "ui", "dist");
  app.use("/app", express.static(uiDist));
  app.get("/app/*", (_req, res) => {
    res.sendFile(path.join(uiDist, "index.html"));
  });

  app.use("/", body, createAuthRouter(cfg, provider));
  app.use("/admin", body, createAdminRouter(cfg, provider));
  app.use("/account", body, createAccountRouter(cfg, provider));

  // BOS proxy — catch-all, must be last, NO body parsers applied.
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
