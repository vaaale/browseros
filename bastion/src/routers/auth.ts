import { Router } from "express";
import express from "express";
import type { Config } from "../config";
import type { AuthProvider } from "../auth/index";
import { issueSession, clearSession, verifySession } from "../sessions";
import { KeycloakProvider } from "../auth/keycloak";

const parseBody = [express.json(), express.urlencoded({ extended: false })];

export function createAuthRouter(cfg: Config, provider: AuthProvider): Router {
  const router = Router();
  // NOTE: NO router-level body parsers here. This router is mounted at "/" which
  // matches every path. A router.use(express.json()) would consume the body of
  // every request — including PATCH /api/* proxied to BOS — before the proxy
  // catch-all sees it. Body parsers are applied per-route only (POST /login).

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
  router.post("/login", ...parseBody, async (req, res) => {
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
