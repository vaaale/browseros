import { Router } from "express";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import fs from "fs";
import path from "path";
import busboy from "busboy";
import type { Config } from "../config";
import type { AuthProvider } from "../auth/index";
import { verifySession } from "../sessions";
import { getInstanceState, clearInstanceState, stopInstance } from "../lifecycle";
import {
  reprovisionRestart,
  reprovisionResetData,
  reprovisionRebuildNm,
  reprovisionUpdateSrc,
  reprovisionFull,
} from "../provision";
import type { SessionPayload } from "../sessions";
import * as logStore from "../log-store";

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
  router.use(express.json());
  router.use(express.urlencoded({ extended: false }));
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
      // Clear stale lifecycle state so the proxy re-checks Docker by name
      // on the next request rather than using a potentially stale containerId.
      clearInstanceState(username);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/log", (req, res) => {
    const { username } = (req as AuthenticatedRequest).user;
    res.json({ log: logStore.read(username, { tail: 200 }) });
  });

  // Avatar upload — hand-rolled multipart parse using busboy (no extra dep needed
  // beyond busboy itself, which is now a direct dep).
  router.post("/avatar", (req, res) => {
    const { username } = (req as AuthenticatedRequest).user;
    const avatarDir = path.join(cfg.dataDir, "avatars");
    fs.mkdirSync(avatarDir, { recursive: true });

    const bb = busboy({
      headers: req.headers,
      limits: { fileSize: 2 * 1024 * 1024, files: 1 },
    });

    let saved = false;
    let limitHit = false;

    bb.on("file", (_name, stream, info) => {
      const { mimeType } = info;
      if (!mimeType.startsWith("image/")) {
        stream.resume();
        res.status(400).json({ error: "Only image files are accepted" });
        return;
      }
      // Derive extension from mime type.
      const ext = mimeType === "image/jpeg" ? "jpg"
        : mimeType === "image/png" ? "png"
        : mimeType === "image/gif" ? "gif"
        : mimeType === "image/webp" ? "webp"
        : "bin";

      // Remove any existing avatar files for this user before saving new one.
      for (const e of ["png", "jpg", "gif", "webp", "bin"]) {
        const f = path.join(avatarDir, `${username}.${e}`);
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }

      const dest = path.join(avatarDir, `${username}.${ext}`);
      const out = fs.createWriteStream(dest, { mode: 0o600 });
      stream.on("limit", () => { limitHit = true; stream.resume(); });
      stream.pipe(out);
      out.on("close", () => { saved = true; });
    });

    bb.on("finish", () => {
      if (limitHit) { res.status(400).json({ error: "File exceeds 2 MB limit" }); return; }
      if (!saved) { res.status(400).json({ error: "No file received" }); return; }
      if (!res.headersSent) res.json({ ok: true });
    });

    bb.on("error", (err) => {
      if (!res.headersSent) res.status(500).json({ error: String(err) });
    });

    req.pipe(bb);
  });

  // Wipe BOS data/ only (not avatar/log — those are bastion-managed and persist
  // for admin diagnosis until the user is fully deleted via FR-007).
  router.post("/wipe-data", async (req, res) => {
    const { username } = (req as AuthenticatedRequest).user;
    const { confirm } = req.body as { confirm?: boolean };
    if (!confirm) {
      res.status(400).json({ error: "confirm: true required" });
      return;
    }
    try {
      await stopInstance(username).catch(() => {});
      const dataPath = path.join(cfg.volumeBase, username, "data");
      if (fs.existsSync(dataPath)) fs.rmSync(dataPath, { recursive: true, force: true });
      fs.mkdirSync(dataPath, { recursive: true });
      clearInstanceState(username);
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
