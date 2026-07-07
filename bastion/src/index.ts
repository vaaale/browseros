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

  app.use(cookieParser());
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // Serve the Vite-built admin/login/account SPA under /app/*
  const uiDist = path.join(__dirname, "..", "ui", "dist");
  app.use("/app", express.static(uiDist));
  // SPA fallback for client-side routing
  app.get("/app/*", (_req, res) => {
    res.sendFile(path.join(uiDist, "index.html"));
  });

  app.use("/", createAuthRouter(cfg, provider));
  app.use("/admin", createAdminRouter(cfg, provider));
  app.use("/account", createAccountRouter(cfg, provider));

  // BOS proxy — catch-all, must be last
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
