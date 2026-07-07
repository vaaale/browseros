import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { Config } from "../config";
import type { AuthProvider } from "../auth/index";
import { verifySession } from "../sessions";
import { getInstanceState } from "../lifecycle";
import {
  reprovisionRestart,
  reprovisionResetData,
  reprovisionRebuildNm,
  reprovisionUpdateSrc,
  reprovisionFull,
} from "../provision";
import type { SessionPayload } from "../sessions";

type AuthenticatedRequest = Request & { user: SessionPayload };

function requireAuth(cfg: Config) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session = verifySession(req, cfg);
    if (!session) { res.status(401).json({ error: "Unauthorized" }); return; }
    (req as AuthenticatedRequest).user = session;
    next();
  };
}

export function createAccountRouter(cfg: Config, provider: AuthProvider): Router {
  const router = Router();
  const guard = requireAuth(cfg);
  router.use(guard);

  router.get("/me", (req, res) => {
    const { username, isAdmin } = (req as AuthenticatedRequest).user;
    res.json({ username, isAdmin });
  });

  router.get("/instance", (req, res) => {
    const { username } = (req as AuthenticatedRequest).user;
    const state = getInstanceState(username);
    res.json(state ?? { username, status: "not_provisioned" });
  });

  router.post("/reprovision", async (req, res) => {
    const { username } = (req as AuthenticatedRequest).user;
    const { operation, confirm } = req.body as { operation?: string; confirm?: boolean };

    if (operation === "full" && !confirm) {
      res.status(400).json({ error: "Full re-provision requires confirm: true" });
      return;
    }

    try {
      switch (operation) {
        case "restart": await reprovisionRestart(username, cfg); break;
        case "reset-data": await reprovisionResetData(username, cfg); break;
        case "update-src": await reprovisionUpdateSrc(username, cfg); break;
        case "rebuild-nm": await reprovisionRebuildNm(username, cfg); break;
        case "full": await reprovisionFull(username, cfg); break;
        default: res.status(400).json({ error: `Unknown operation: ${operation}` }); return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/password", async (req, res) => {
    if (cfg.authProvider === "keycloak") {
      res.status(501).json({ error: "Password management not available for Keycloak provider" });
      return;
    }
    const { username } = (req as AuthenticatedRequest).user;
    const { newPassword } = req.body as { newPassword?: string };
    if (!newPassword) { res.status(400).json({ error: "newPassword required" }); return; }
    try {
      await provider.updatePassword(username, newPassword);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
