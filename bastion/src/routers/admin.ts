import { Router } from "express";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import fs from "fs";
import path from "path";
import type { Config } from "../config";
import { saveConfig } from "../config";
import type { AuthProvider } from "../auth/index";
import { verifySession } from "../sessions";
import {
  getAllInstances,
  stopInstance,
  getOrProvision,
  clearInstanceState,
} from "../lifecycle";
import { killContainer, listBosImages, buildImage } from "../docker";
import {
  reprovisionRestart,
  reprovisionResetData,
  reprovisionRebuildNm,
  reprovisionUpdateSrc,
  reprovisionFull,
  deprovisionUser,
} from "../provision";
import * as logStore from "../log-store";

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
  router.use(express.json());
  router.use(express.urlencoded({ extended: false }));
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

  router.delete("/users/:username", guard, async (req, res) => {
    const { username } = req.params;
    const { wipeData = false } = req.body as { wipeData?: boolean };
    try {
      await provider.deleteUser(username);
      if (wipeData) {
        await deprovisionUser(username, cfg, { wipeSrc: true, wipeData: true, wipeNm: true });
        // Also wipe bastion-managed PII: provisioning log and avatar.
        logStore.deleteLog(username);
        const avatarDir = path.join(cfg.dataDir, "avatars");
        for (const ext of ["png", "jpg", "jpeg", "gif", "webp", ""]) {
          const f = path.join(avatarDir, ext ? `${username}.${ext}` : username);
          if (fs.existsSync(f)) fs.unlinkSync(f);
        }
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

  router.post("/instances/:username/kill", guard, async (req, res) => {
    const { username } = req.params;
    try {
      await killContainer(username);
      clearInstanceState(username);
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
      clearInstanceState(username);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Images ─────────────────────────────────────────────────────────────────
  router.get("/images", guard, async (_req, res) => {
    try {
      res.json({ images: await listBosImages() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  let buildInProgress = false;
  router.post("/image/build", guard, async (req, res) => {
    if (buildInProgress) {
      res.status(409).json({ error: "A build is already in progress" });
      return;
    }
    const { dockerfile = "Dockerfile", tag = "browseros/user:latest" } = req.body as { dockerfile?: string; tag?: string };
    const repoPath = process.env.BOS_REPO_PATH ?? "/bos-src";

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (data: object): void => { res.write(`data: ${JSON.stringify(data)}\n\n`); };

    buildInProgress = true;
    try {
      await buildImage(repoPath, dockerfile, tag, (event) => send(event));
      send({ status: "success", tag });
    } catch (err) {
      send({ status: "error", error: String(err) });
    } finally {
      buildInProgress = false;
      res.end();
    }
  });

  // ── Instance log ───────────────────────────────────────────────────────────
  router.get("/instances/:username/log", guard, (req, res) => {
    const { username } = req.params;
    res.json({ log: logStore.read(username, { tail: 500 }) });
  });

  // ── Config ─────────────────────────────────────────────────────────────────
  router.get("/config", (_req, res) => {
    try {
      const file = path.join(cfg.dataDir, "config.json");
      const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown> : {};
      // Fall back to the effective (env-derived) bosImage so the UI shows the
      // active image even when it was never persisted to config.json.
      if (!data.bosImage) data.bosImage = cfg.bosImage;
      res.json(data);
    } catch {
      res.json({ bosImage: cfg.bosImage });
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
