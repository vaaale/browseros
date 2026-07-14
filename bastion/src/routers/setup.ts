import { Router } from "express";
import express from "express";
import type { Config } from "../config";
import type { AuthProvider } from "../auth/index";
import { issueSession } from "../sessions";

const parseBody = [express.json(), express.urlencoded({ extended: false })];

// In-process lock to prevent concurrent bootstrap submissions creating
// duplicate admin accounts.
let bootstrapLock = false;

export function createSetupRouter(cfg: Config, provider: AuthProvider): Router {
  const router = Router();

  // GET /setup/state — returns whether first-run bootstrap is needed.
  // Used by the SPA on startup to decide whether to redirect to /setup.
  router.get("/state", async (_req, res) => {
    const needsBootstrap = cfg.authProvider === "simple"
      ? !(await provider.adminExists())
      : false; // Keycloak: IdP owns users; no password bootstrap needed
    res.json({ needsBootstrap, authProvider: cfg.authProvider });
  });

  // POST /setup — creates the initial admin account (simple auth only).
  // Race-safe: in-process lock + re-check before writing.
  router.post("/", ...parseBody, async (req, res) => {
    if (cfg.authProvider !== "simple") {
      res.status(400).json({ error: "Bootstrap not applicable for Keycloak provider" });
      return;
    }
    const { password } = req.body as { password?: string };
    if (!password || password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }
    if (bootstrapLock) {
      res.status(409).json({ error: "Bootstrap already in progress — try again shortly" });
      return;
    }
    bootstrapLock = true;
    try {
      // Re-check inside the lock to avoid a race between two simultaneous
      // first-submission requests.
      if (await provider.adminExists()) {
        res.status(409).json({ error: "Admin already exists — use the login page" });
        return;
      }
      const adminUser = process.env.ADMIN_USER ?? "admin";
      await provider.createUser(adminUser, password, true);
      issueSession(res, { username: adminUser, isAdmin: true }, cfg);
      res.json({ ok: true, redirect: "/app/admin" });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    } finally {
      bootstrapLock = false;
    }
  });

  return router;
}
