import { Router } from "express";
import express from "express";
import type { Config } from "../config";
import type { AuthProvider } from "../auth/index";
import { issueSession, clearSession, verifySession } from "../sessions";
import { KeycloakProvider } from "../auth/keycloak";

export function createAuthRouter(cfg: Config, provider: AuthProvider): Router {
  const router = Router();
  // Body parsing only for the routes that need it; keeps the proxy path clean.
  router.use(express.json());
  router.use(express.urlencoded({ extended: false }));

  // ── Login page redirect ────────────────────────────────────────────────────
  // Authenticated users hitting /login go to / (proxy handles BOS or status).
  // Unauthenticated users get the SPA login page.
  router.get("/login", (req, res) => {
    const session = verifySession(req, cfg);
    if (session) { res.redirect("/"); return; }
    res.redirect("/app/login");
  });
  // NOTE: no GET / handler here — the proxy catch-all owns the root path.

  // ── Simple login ───────────────────────────────────────────────────────────
  router.post("/login", async (req, res) => {
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) {
      res.status(400).json({ error: "username and password required" });
      return;
    }
    const record = await provider.authenticate(username, password).catch(() => null);
    if (!record) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    issueSession(res, record, cfg);
    res.json({ ok: true, username: record.username, isAdmin: record.isAdmin });
  });

  // ── Keycloak OIDC ──────────────────────────────────────────────────────────
  router.get("/auth/keycloak", async (req, res) => {
    if (!(provider instanceof KeycloakProvider)) {
      res.status(501).json({ error: "Keycloak not configured" });
      return;
    }
    const state = Math.random().toString(36).slice(2);
    // Store state in a short-lived cookie for CSRF protection
    res.cookie("oidc_state", state, { httpOnly: true, maxAge: 300_000, sameSite: "lax" });
    const redirectUri = `${cfg.publicUrl}/auth/callback`;
    const url = await provider.getAuthorizationUrl(state, redirectUri);
    res.redirect(url);
  });

  router.get("/auth/callback", async (req, res) => {
    if (!(provider instanceof KeycloakProvider)) {
      res.status(501).json({ error: "Keycloak not configured" });
      return;
    }
    const storedState = (req.cookies as Record<string, string | undefined>)["oidc_state"] ?? "";
    res.clearCookie("oidc_state");
    const params = req.query as Record<string, string>;
    const redirectUri = `${cfg.publicUrl}/auth/callback`;
    const record = await provider.handleCallback(params, redirectUri, storedState).catch(() => null);
    if (!record) {
      res.status(401).redirect("/app/login?error=auth_failed");
      return;
    }
    issueSession(res, record, cfg);
    res.redirect("/");
  });

  // ── Logout ─────────────────────────────────────────────────────────────────
  router.post("/logout", (_req, res) => {
    clearSession(res);
    res.json({ ok: true });
  });

  return router;
}
