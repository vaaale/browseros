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
  refreshAllHealth,
} from "../lifecycle";
import {
  killContainer,
  listBosImages,
  buildImageCoalesced,
  isBuildInProgress,
  getContainerRuntime,
  getContainerUsage,
  getCgroupMemoryEvents,
  getHostInfo,
} from "../docker";
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
      const admin = (req as Request & { session?: { username?: string } }).session?.username ?? "admin";
      await stopInstance(req.params.username, `admin action by ${admin}`);
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

  // ── System Monitor ─────────────────────────────────────────────────────────
  //
  // One call that answers "is BOS actually working, and if not, why". Every
  // field here exists because it was needed to diagnose a real incident:
  //  - `health.serving` vs `container.running` — a container reported "Up" for
  //    10 h while BOS inside it was dead.
  //  - `container.oomKilled` / `cgroup.oomKill` + `cgroup.oom` — proves a kill
  //    happened AND whether it was the host or the container's own limit.
  //  - `cgroup.maxBytes` — "max" means no limit, i.e. one tenant can take the
  //    host down.
  //  - `usage.memUsageBytes` vs `host.memTotalBytes` — headroom at a glance.
  //  - `supervision.restarts` / `lastExit.signal` — makes a crash-restart loop
  //    visible instead of letting supervision quietly hide it.
  //  - `base.dev` — dev mode in production is what caused the OOM; flag it.
  router.get("/monitor", guard, async (_req, res) => {
    try {
      // Refresh health synchronously so the page never shows a stale verdict.
      await refreshAllHealth(cfg);
      const mem = process.memoryUsage();
      const instances = getAllInstances();
      const detailed = await Promise.all(
        instances.map(async (inst) => {
          const container = await getContainerRuntime(inst.username);
          const running = container?.running ?? false;
          const [usage, cgroup] = await Promise.all([
            running ? getContainerUsage(inst.username) : Promise.resolve({ memUsageBytes: null, memLimitBytes: null, cpuPercent: null }),
            running ? getCgroupMemoryEvents(inst.username) : Promise.resolve({ oomKill: null, oom: null, peakBytes: null, maxBytes: null }),
          ]);
          return {
            username: inst.username,
            status: inst.status,
            lastActive: inst.lastActive,
            healthCheckedAt: inst.healthCheckedAt ?? null,
            error: inst.error ?? null,
            container,
            usage,
            cgroup,
            health: inst.health ?? null,
          };
        }),
      );
      res.json({
        now: Date.now(),
        host: await getHostInfo(),
        bastion: {
          pid: process.pid,
          uptimeSeconds: Math.round(process.uptime()),
          rssBytes: mem.rss,
          heapUsedBytes: mem.heapUsed,
          bosImage: cfg.bosImage,
          maxConcurrentInstances: cfg.maxConcurrentInstances,
        },
        instances: detailed,
      });
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

  router.post("/image/build", guard, async (req, res) => {
    // Shared with the automatic build a first login triggers when the image is
    // missing (docker.ts's ensureBosImage) — a router-local flag would only
    // have seen admin-initiated builds, and two builds of one tag at once
    // race on the result.
    if (isBuildInProgress()) {
      res.status(409).json({ error: "A build is already in progress" });
      return;
    }
    const { dockerfile = "Dockerfile", tag = "browseros:latest" } = req.body as { dockerfile?: string; tag?: string };
    const repoPath = cfg.bosRepoPath;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (data: object): void => { res.write(`data: ${JSON.stringify(data)}\n\n`); };

    try {
      await buildImageCoalesced(repoPath, dockerfile, tag, (event) => send(event));
      send({ status: "success", tag });
    } catch (err) {
      send({ status: "error", error: String(err) });
    } finally {
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
    case "update-src": return reprovisionUpdateSrc(username, cfg, "reset");
    // Same operation, non-destructive integration: keeps local commits.
    case "pull-and-update-src": return reprovisionUpdateSrc(username, cfg, "pull");
    case "rebuild-nm": return reprovisionRebuildNm(username, cfg);
    case "full": return reprovisionFull(username, cfg);
    default: throw new Error(`Unknown operation: ${operation}`);
  }
}
