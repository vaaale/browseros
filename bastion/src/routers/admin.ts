import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { Config } from "../config";
import { saveConfig } from "../config";
import type { AuthProvider } from "../auth/index";
import { verifySession } from "../sessions";
import {
  getAllInstances,
  stopInstance,
  getOrProvision,
} from "../lifecycle";
import {
  reprovisionRestart,
  reprovisionResetData,
  reprovisionRebuildNm,
  reprovisionUpdateSrc,
  reprovisionFull,
  deprovisionUser,
} from "../provision";

function requireAdmin(cfg: Config) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session = verifySession(req, cfg);
    if (!session?.isAdmin) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    (req as Request & { session: typeof session }).session = session;
    next();
  };
}

export function createAdminRouter(cfg: Config, provider: AuthProvider): Router {
  const router = Router();
  const guard = requireAdmin(cfg);
  router.use(guard);

  // ── Users ──────────────────────────────────────────────────────────────────
  router.get("/users", async (_req, res) => {
    res.json(await provider.listUsers());
  });

  router.post("/users", async (req, res) => {
    const { username, password, isAdmin = false } = req.body as {
      username?: string; password?: string; isAdmin?: boolean;
    };
    if (!username || !password) {
      res.status(400).json({ error: "username and password required" });
      return;
    }
    try {
      await provider.createUser(username, password, isAdmin);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.delete("/users/:username", async (req, res) => {
    const { username } = req.params;
    const { wipeData = false } = req.body as { wipeData?: boolean };
    try {
      await provider.deleteUser(username);
      if (wipeData) {
        await deprovisionUser(username, cfg, { wipeSrc: true, wipeData: true, wipeNm: true });
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.post("/users/:username/password", async (req, res) => {
    const { username } = req.params;
    const { password } = req.body as { password?: string };
    if (!password) { res.status(400).json({ error: "password required" }); return; }
    try {
      await provider.updatePassword(username, password);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.patch("/users/:username", async (req, res) => {
    const { username } = req.params;
    const { isAdmin } = req.body as { isAdmin?: boolean };
    if (isAdmin === undefined) { res.status(400).json({ error: "isAdmin required" }); return; }
    try {
      await provider.setAdmin(username, isAdmin);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // ── Instances ──────────────────────────────────────────────────────────────
  router.get("/instances", (_req, res) => {
    res.json(getAllInstances());
  });

  router.post("/instances/:username/stop", async (req, res) => {
    try {
      await stopInstance(req.params.username);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/instances/:username/start", async (req, res) => {
    try {
      await getOrProvision(req.params.username, cfg);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/instances/:username/reprovision", async (req, res) => {
    const { username } = req.params;
    const { operation } = req.body as { operation?: string };
    try {
      await runReprovision(username, operation, cfg);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Config ─────────────────────────────────────────────────────────────────
  router.get("/config", (_req, res) => {
    try {
      const fs = require("fs") as typeof import("fs");
      const path = require("path") as typeof import("path");
      const file = path.join(cfg.dataDir, "config.json");
      const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
      res.json(data);
    } catch {
      res.json({});
    }
  });

  router.put("/config", (req, res) => {
    try {
      saveConfig(cfg.dataDir, req.body as Partial<Config>);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}

async function runReprovision(username: string, operation: string | undefined, cfg: Config): Promise<void> {
  switch (operation) {
    case "restart": return reprovisionRestart(username, cfg);
    case "reset-data": return reprovisionResetData(username, cfg);
    case "update-src": return reprovisionUpdateSrc(username, cfg);
    case "rebuild-nm": return reprovisionRebuildNm(username, cfg);
    case "full": return reprovisionFull(username, cfg);
    default: throw new Error(`Unknown operation: ${operation}`);
  }
}
