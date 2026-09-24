import Dockerode from "dockerode";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type { Config } from "./config";
import * as logStore from "./log-store";

const execAsync = promisify(execFile);

const docker = new Dockerode({ socketPath: "/var/run/docker.sock" });

export function containerName(username: string): string {
  return `bos-${username}`;
}

export function volumeName(username: string): string {
  return `bos-nm-${username}`;
}

/**
 * Discover the HOST-absolute path bind-mounted at `containerPath` inside our
 * OWN container, by inspecting our own container via the Docker SDK — Docker
 * sets a container's hostname to its own (short) ID by default, and the API
 * accepts ID prefixes, so `os.hostname()` reliably resolves to "this
 * container" without any operator configuration. Returns null when not
 * running in a container at all (e.g. local dev via `npm run dev` outside
 * Docker) or when `containerPath` isn't mounted, so callers can fall back
 * sensibly. This avoids trusting a second, independently-configurable env
 * var for a value Docker itself already knows authoritatively (024 FR-020) —
 * the operator-invocation-dependent equivalent of this variable was the
 * direct cause of a prior incident (a spawned container's bind mount source
 * silently pointed at the wrong host directory).
 */
export async function resolveOwnMountSource(containerPath: string): Promise<string | null> {
  try {
    const info = await docker.getContainer(os.hostname()).inspect();
    const mount = info.Mounts?.find((m) => m.Destination === containerPath);
    return mount?.Source ?? null;
  } catch {
    return null;
  }
}

export async function ensureNetwork(networkName: string): Promise<void> {
  try {
    await docker.getNetwork(networkName).inspect();
  } catch {
    await docker.createNetwork({ Name: networkName, Driver: "bridge" });
  }
}

/**
 * Compare a container's stored network endpoint ID for `networkName` against
 * the network's current ID and reconnect if they differ. Self-heals
 * containers whose network reference went stale after `bos-net` was
 * recreated with a new ID (e.g. by a `docker compose down`/`up` cycle) —
 * Docker refuses to start a container whose stored reference no longer
 * exists ("network <id> not found"), even though a network with the same
 * NAME is present. No-ops if already in sync or not attached to this network
 * at all. Cheap on the common case (just two inspects). (024 FR-019.)
 */
export async function reconcileNetworkAttachment(containerId: string, networkName: string): Promise<void> {
  const network = docker.getNetwork(networkName);
  const netInfo = await network.inspect();
  const containerInfo = await docker.getContainer(containerId).inspect();
  const attached = containerInfo.NetworkSettings.Networks?.[networkName];
  if (!attached || attached.NetworkID === netInfo.Id) return;
  await network.connect({ Container: containerId });
}

export async function createBosContainer(
  username: string,
  cfg: Config,
  onProgress?: (msg: string) => void,
): Promise<string> {
  const name = containerName(username);
  // The image is the one prerequisite a container cannot be created without,
  // and this is the only place cfg.bosImage is ever used — so establishing it
  // here covers every caller by construction rather than relying on each of
  // them to remember. Long-running on a cold deployment; `onProgress` is how
  // the caller surfaces that to the user (see ensureBosImage).
  await ensureBosImage(username, cfg, onProgress);
  // Docker resolves bind mount sources against the HOST filesystem, not the
  // bastion container's filesystem. Use bosVolumeBaseHost (the host-side path,
  // self-discovered — see resolveOwnMountSource) for mounts, and cfg.volumeBase
  // (the bastion-internal path) for file ops. Every user is provisioned via
  // their own isolated clone — no direct/shared mount of the operator's own
  // checkout (024 FR-020).
  const userPath      = `${cfg.bosVolumeBaseHost}/${username}`;
  const srcPath       = `${userPath}/src`;
  const dataPath      = `${userPath}/data`;
  const worktreesPath = `${userPath}/worktrees`;
  const nmVol = volumeName(username);

  // Worktrees and data-clones must live outside /app (the src bind-mount) so
  // that chown -R /app never traverses them (worktrees contain a full source
  // tree + node_modules; clones contain a full copy of /app/data). Create and
  // chown the host-side directories now — idempotent on re-runs, and cheap
  // because they're always empty at container-create time.
  const uid = cfg.containerUid ?? 1000;
  const gid = cfg.containerGid ?? 1000;
  for (const subdir of ["worktrees", "data-clones"]) {
    const dir = path.join(cfg.volumeBase, username, subdir);
    fs.mkdirSync(dir, { recursive: true });
    await execAsync("chown", [`${uid}:${gid}`, dir]).catch(() => {});
  }

  // Derive allowed dev origins from PUBLIC_URL so Next.js dev accepts
  // cross-origin HMR/dev requests when BOS is reached via a LAN hostname.
  const publicHostname = (() => {
    try { return new URL(cfg.publicUrl).hostname; } catch { return ""; }
  })();

  // Ensure the network exists before touching any containers.
  await ensureNetwork(cfg.bosNet);

  // Evict any existing container with this name (leftover from a failed
  // provision or partial reprovision) before creating a fresh one.
  const existing = docker.getContainer(name);
  await existing.stop({ t: 5 }).catch(() => {});
  await existing.remove({ force: true }).catch(() => {});

  const container = await docker.createContainer({
    name,
    Image: cfg.bosImage,
    Env: [
      `BOS_DATA_DIR=/app/data`,
      `BOS_WORKTREES=/worktrees`,     // outside /app — not traversed by chownSrc
      `BOS_DATA_CLONES=/bos/data-clones`,
      // The SAME directory /app/data names, reached through the /bos bind so
      // it shares a mount with the clone root. link(2) refuses to cross a
      // mount even on one filesystem, so with `…/data -> /app/data` and
      // `…/data-clones -> /data-clones` as two separate binds, `cp -al` failed
      // with EXDEV on every file and every preview clone was a full copy of
      // the user's data dir — which is how a production host filled 155 GB.
      // Only the Supervisor's clone layer reads this; BOS still uses
      // /app/data, so no stored absolute path (installItemLink's
      // `data/system/<id>` symlinks in particular) has to change.
      `BOS_CLONE_SOURCE=/bos/data`,
      `BOS_PUBLIC_PORT=8090`,   // bastion proxies to this port
      `BOS_PORT_BASE=3000`,     // base server internal port
      // 0 → the Supervisor builds base and serves it with `next start`.
      // NEVER set this to 1 here: `next dev` keeps Turbopack's compiler resident
      // and leaks ~0.8 MB per request with no plateau (measured: 2.2 GB at boot,
      // 7.1 GB after 4 min of light load, vs 130 MB / 249 MB steady-state for
      // `next start`). On a shared host that ends in the kernel OOM killer
      // reaping the base server and taking the whole box down with it.
      `BOS_BASE_DEV=0`,
      ...(publicHostname && publicHostname !== "localhost" ? [`BOS_DEV_ORIGINS=${publicHostname}`] : []),
      ...(cfg.containerUid != null ? [`BOS_UID=${cfg.containerUid}`] : []),
      ...(cfg.containerGid != null ? [`BOS_GID=${cfg.containerGid}`] : []),
    ],
    HostConfig: {
      NetworkMode: cfg.bosNet,
      Binds: [
        // Mount the full clone at /app so the Supervisor runs inside a real
        // git repo. /app/data and /app/node_modules shadow the subdirectories
        // inside that clone with their own per-user volumes.
        `${srcPath}:/app`,
        `${dataPath}:/app/data`,
        // Supervisor ephemeral dirs — separate from /app so chownSrc is fast.
        `${worktreesPath}:/worktrees`,
        // The user's own directory, covering `data/` and `data-clones/` in ONE
        // mount. This is what makes the DataFS hardlink farm possible at all
        // (see BOS_CLONE_SOURCE above). /app/data stays exactly where it is,
        // so nothing else has to be re-addressed; the clone root is now only
        // reached as /bos/data-clones, the same host directory as before.
        `${userPath}:/bos`,
      ],
      Mounts: [
        {
          Type: "volume",
          Source: nmVol,
          Target: "/app/node_modules",
        },
      ],
      RestartPolicy: { Name: "no" },
      // The Supervisor runs as PID 1 inside this container (by design — it
      // must survive the base Next.js server dying). A plain Node process as
      // PID 1 never reaps orphaned grandchildren (e.g. a browser-automation
      // Chromium process left behind when its immediate parent is killed) —
      // they pile up as permanent <defunct> zombies. Init:true attaches
      // Docker's built-in tini ahead of PID 1 to reap them.
      Init: true,
      // Default 64MB /dev/shm starves headless Chromium in this container
      // (no host privileges to raise it via --shm-size after the fact),
      // causing browser-automation sessions to crash or hang.
      ShmSize: 1024 * 1024 * 1024,
    },
  });
  return container.id;
}

export async function startContainer(containerId: string): Promise<void> {
  const c = docker.getContainer(containerId);
  await c.start();
}

export async function stopContainer(containerId: string): Promise<void> {
  const c = docker.getContainer(containerId);
  await c.stop({ t: 10 }).catch(() => { /* already stopped */ });
}

export async function removeContainer(containerId: string): Promise<void> {
  const c = docker.getContainer(containerId);
  await c.remove({ force: true }).catch(() => { /* already gone */ });
}

export async function inspectContainer(
  nameOrId: string,
): Promise<Dockerode.ContainerInspectInfo | null> {
  try {
    return await docker.getContainer(nameOrId).inspect();
  } catch {
    return null;
  }
}

export async function createNmVolume(username: string): Promise<void> {
  const name = volumeName(username);
  try {
    await docker.getVolume(name).inspect();
  } catch {
    await docker.createVolume({ Name: name });
  }
}

export async function removeNmVolume(username: string): Promise<void> {
  try {
    const vol = docker.getVolume(volumeName(username));
    await vol.remove();
  } catch { /* already gone */ }
}

export async function listBosContainers(): Promise<Array<{ name: string; id: string; status: string }>> {
  const containers = await docker.listContainers({ all: true });
  return containers
    .filter((c) => c.Names.some((n) => n.startsWith("/bos-")))
    .map((c) => ({
      name: c.Names[0].replace(/^\//, ""),
      id: c.Id,
      status: c.State,
    }));
}

export async function killContainer(username: string): Promise<void> {
  const name = containerName(username);
  try {
    const c = docker.getContainer(name);
    await c.remove({ force: true });
  } catch (e: unknown) {
    const code = (e as { statusCode?: number }).statusCode;
    if (code !== 404) throw e;
  }
}

export async function listBosImages(): Promise<Array<{ id: string; tags: string[]; sizeMb: number; created: number }>> {
  const images = await docker.listImages({ all: false });
  return images
    // Drop untagged / dangling images (RepoTags null or "<none>:<none>").
    .filter((img) => (img.RepoTags ?? []).some((t) => t && t !== "<none>:<none>"))
    .map((img) => ({
      id: img.Id.slice(7, 19), // strip "sha256:" prefix, keep 12 chars
      tags: (img.RepoTags ?? []).filter((t) => t && t !== "<none>:<none>"),
      sizeMb: Math.round(img.Size / 1024 / 1024),
      created: img.Created,
    }));
}

// Directories/files that must never enter the build context. Mirrors
// .dockerignore — packing data/ or user-data/ (live container state, sockets,
// concurrently-written files) is what causes "Error in input stream".
const BUILD_IGNORE_DIRS = new Set([
  "node_modules", ".next", ".git", "data", "bos-worktrees", "bos-data-clones", "user-data",
  "apps", "specs", "playwright-report", "test-results", "dist",
]);
const BUILD_IGNORE_FILES = new Set([".env", ".env.local"]);

/** Does this image tag exist in the local daemon? */
export async function imageExists(tag: string): Promise<boolean> {
  try {
    await docker.getImage(tag).inspect();
    return true;
  } catch {
    return false;
  }
}

// One in-flight build per tag, shared by EVERY caller — the admin portal's
// explicit "Build image" action and the automatic build a container creation
// triggers when the image is missing. Building the same tag twice at once
// duplicates a job that takes minutes and races on the resulting tag, so
// same-tag callers join the running build instead of starting a second one.
const inFlightBuilds = new Map<string, Promise<void>>();

/** True while ANY image build is running, whichever caller started it. */
export function isBuildInProgress(): boolean {
  return inFlightBuilds.size > 0;
}

/**
 * buildImage, with concurrent same-tag callers coalesced onto one build.
 * A joining caller does NOT receive `onEvent` progress (only the caller that
 * actually started the build does) — it just awaits the same outcome.
 */
export function buildImageCoalesced(
  repoPath: string,
  dockerfile: string,
  tag: string,
  onEvent: (event: { line?: string; error?: string; status?: string }) => void,
): Promise<void> {
  const running = inFlightBuilds.get(tag);
  if (running) return running;
  const work = buildImage(repoPath, dockerfile, tag, onEvent).finally(() => {
    inFlightBuilds.delete(tag);
  });
  inFlightBuilds.set(tag, work);
  return work;
}

/**
 * Guarantee `cfg.bosImage` exists before anything tries to create a container
 * from it, building it from the deployment's source checkout if it doesn't.
 *
 * Without this, a freshly created user's first login died at
 * `docker.createContainer` with the daemon's "No such image: <tag>" — the
 * image is a deployment-wide prerequisite that nothing established
 * automatically, so an operator had to notice the failure and press "Build
 * image" in the admin portal by hand before ANY user could log in. Creating a
 * user in the admin portal and logging in as them is a complete, self-
 * contained flow; it must not depend on that out-of-band step.
 *
 * Called from createBosContainer, the single place `cfg.bosImage` is ever
 * used, so every path that makes a container is covered by construction:
 * first provision, re-provision, and stale-container self-heal alike.
 */
export async function ensureBosImage(
  username: string,
  cfg: Config,
  onProgress?: (msg: string) => void,
): Promise<void> {
  if (await imageExists(cfg.bosImage)) return;

  const report = (msg: string): void => {
    logStore.append(username, `[image] ${msg}`);
    onProgress?.(msg);
  };

  // A build already running for this tag (e.g. two users logging in for the
  // first time at once, or an admin build racing a login) is joined rather
  // than duplicated — but only the starter streams progress, so say which
  // case this is instead of looking stalled.
  const joining = isBuildInProgress();
  report(
    joining
      ? `Image ${cfg.bosImage} is missing and a build is already running — waiting for it to finish…`
      : `Image ${cfg.bosImage} not found — building it from ${cfg.bosRepoPath} now (this takes several minutes)…`,
  );

  // Only build lines worth reading are surfaced: Docker emits a torrent of
  // layer chatter, and every line here also becomes a provisionLog update.
  let lastStep = "";
  try {
    await buildImageCoalesced(cfg.bosRepoPath, "Dockerfile", cfg.bosImage, (event) => {
      if (event.error) {
        report(`build error: ${event.error}`);
        return;
      }
      const line = event.line?.trim();
      if (!line) return;
      const step = /^(Step\s+\d+\/\d+)/.exec(line)?.[1];
      if (step && step !== lastStep) {
        lastStep = step;
        report(`building ${cfg.bosImage} — ${line}`);
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    report(`build of ${cfg.bosImage} FAILED: ${msg}`);
    throw new Error(
      `Image "${cfg.bosImage}" is missing and could not be built automatically from ${cfg.bosRepoPath}: ${msg}`,
      { cause: err },
    );
  }

  // Trust the daemon, not the build's exit status: a build can report success
  // while tagging something other than what we asked for (e.g. a changed
  // bosImage that the Dockerfile does not produce), and failing here with a
  // clear message beats failing at createContainer with "No such image".
  if (!(await imageExists(cfg.bosImage))) {
    const msg = `Build of "${cfg.bosImage}" reported success but the tag still does not exist`;
    report(msg);
    throw new Error(msg);
  }
  report(`Image ${cfg.bosImage} is ready.`);
}

export async function buildImage(
  repoPath: string,
  dockerfile: string,
  tag: string,
  onEvent: (event: { line?: string; error?: string; status?: string }) => void,
): Promise<void> {
  const path = await import("path");
  const os = await import("os");
  const fs = await import("fs");
  const tarFs = await import("tar-fs");
  const { pipeline } = await import("stream/promises");

  // Pack the build context to a temp FILE first, rather than streaming tar-fs
  // straight to the daemon. This is the key robustness fix: if packing errors
  // (e.g. a special file), pipeline() rejects here — before any daemon
  // interaction — so we never send a truncated stream that the daemon reports
  // as the cryptic "Error in input stream". The daemon then always receives a
  // complete, valid tar.
  const tmpTar = path.join(os.tmpdir(), `bos-build-${Date.now()}-${Math.random().toString(36).slice(2)}.tar`);

  try {
    const tarStream = tarFs.default.pack(repoPath, {
      strict: false, // skip unsupported file types instead of aborting
      ignore: (fullPath: string) => {
        const rel = path.relative(repoPath, fullPath);
        const segments = rel.split(path.sep);
        if (segments.some((seg) => BUILD_IGNORE_DIRS.has(seg))) return true;
        if (BUILD_IGNORE_FILES.has(path.basename(fullPath))) return true;
        return false;
      },
    });

    try {
      await pipeline(tarStream, fs.createWriteStream(tmpTar));
    } catch (err) {
      console.error("[bastion] build context packing failed:", err);
      onEvent({ error: `Failed to pack build context: ${String(err)}` });
      throw err;
    }

    await new Promise<void>((resolve, reject) => {
      let daemonError: string | null = null;

      docker.buildImage(fs.createReadStream(tmpTar), { t: tag, dockerfile })
        .then((buildStream) => {
          docker.modem.followProgress(
            buildStream,
            (err: Error | null) => {
              if (err) { console.error("[bastion] build stream error:", err); reject(err); }
              else if (daemonError) { reject(new Error(daemonError)); }
              else resolve();
            },
            (event: { stream?: string; error?: string; errorDetail?: { message?: string } }) => {
              if (event.error || event.errorDetail?.message) {
                const msg = event.errorDetail?.message ?? event.error ?? "build error";
                daemonError = msg;
                console.error("[bastion] build error event:", msg);
                onEvent({ error: msg });
              } else if (event.stream) {
                const line = event.stream.replace(/\n$/, "");
                if (line) onEvent({ line });
              }
            },
          );
        })
        .catch((err: Error) => { console.error("[bastion] buildImage failed:", err); reject(err); });
    });
  } finally {
    fs.promises.unlink(tmpTar).catch(() => { /* temp file may not exist */ });
  }
}

/** Fetch the recent stdout/stderr from a user's container (for diagnostics). */
export async function getContainerLogs(username: string, tailLines = 60): Promise<string> {
  try {
    const c = docker.getContainer(containerName(username));
    const buf = await c.logs({ stdout: true, stderr: true, tail: tailLines, timestamps: false });
    // Strip Docker's 8-byte multiplexing headers and non-printable bytes.
    return buf.toString("utf8").replace(/[^\x09\x0a\x0d\x20-\x7e]/g, "").trim();
  } catch {
    return "";
  }
}

// ── Real-state probes (System Monitor / health tracking) ──────────────────────
//
// "Container is running" is NOT the same as "BOS is serving": the Supervisor is
// PID 1 inside the container, so it survives the death of the base Next.js
// server. Everything below exists to tell those two states apart, and to expose
// the metrics that actually diagnose failures (memory headroom, OOM kills,
// restart counts) rather than just liveness.

export interface SupervisorHealth {
  ok: boolean;
  serving: boolean;
  base: {
    state: string; port: number; branch: string | null; commit: string | null;
    dev: boolean; reused: boolean; owned: boolean;
    pid: number | null; procAlive: boolean; buildError: string | null;
  } | null;
  supervision: {
    restarts: number; consecutiveFailures: number; givenUp: boolean;
    lastRestartAt: number | null;
    lastExit: { code: number | null; signal: string | null; at: number; expected: boolean; oomSuspected: boolean } | null;
  };
  previews: Array<{ branch: string; port: number; state: string; procAlive: boolean }>;
  supervisor: { pid: number; uptimeSeconds: number; rssBytes: number; heapUsedBytes: number };
  baseBranch: string;
}

/** Ask the container's Supervisor for the truth about what it is serving. */
export function fetchSupervisorHealth(username: string, timeoutMs = 5000): Promise<SupervisorHealth | null> {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: containerName(username), port: 8090, path: "/__supervisor/health", timeout: timeoutMs },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode !== 200) { resolve(null); return; }
          try { resolve(JSON.parse(body) as SupervisorHealth); } catch { resolve(null); }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

export interface ContainerRuntime {
  id: string;
  status: string;
  running: boolean;
  /** Docker HEALTHCHECK verdict: starting | healthy | unhealthy | none. */
  health: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  oomKilled: boolean;
  restartCount: number;
  /** 0 / null means "no limit" — the container may consume the whole host. */
  memoryLimitBytes: number | null;
}

export async function getContainerRuntime(username: string): Promise<ContainerRuntime | null> {
  const info = await inspectContainer(containerName(username));
  if (!info) return null;
  return {
    id: info.Id.slice(0, 12),
    status: info.State.Status,
    running: info.State.Running,
    health: info.State.Health?.Status ?? "none",
    startedAt: info.State.StartedAt ?? null,
    finishedAt: info.State.FinishedAt ?? null,
    exitCode: typeof info.State.ExitCode === "number" ? info.State.ExitCode : null,
    oomKilled: !!info.State.OOMKilled,
    restartCount: info.RestartCount ?? 0,
    memoryLimitBytes: info.HostConfig?.Memory ? info.HostConfig.Memory : null,
  };
}

export interface ContainerUsage {
  memUsageBytes: number | null;
  memLimitBytes: number | null;
  cpuPercent: number | null;
}

/** One-shot resource sample (the same numbers `docker stats` shows). */
export async function getContainerUsage(username: string): Promise<ContainerUsage> {
  const empty: ContainerUsage = { memUsageBytes: null, memLimitBytes: null, cpuPercent: null };
  try {
    const c = docker.getContainer(containerName(username));
    const raw = (await c.stats({ stream: false })) as unknown as {
      memory_stats?: { usage?: number; limit?: number; stats?: { inactive_file?: number } };
      cpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number; online_cpus?: number };
      precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
    };
    // Docker's own `docker stats` subtracts inactive_file from usage; match it so
    // the number the admin sees here equals the number on the CLI.
    const usage = raw.memory_stats?.usage ?? null;
    const inactive = raw.memory_stats?.stats?.inactive_file ?? 0;
    const memUsageBytes = usage != null ? Math.max(0, usage - inactive) : null;

    const cpuDelta = (raw.cpu_stats?.cpu_usage?.total_usage ?? 0) - (raw.precpu_stats?.cpu_usage?.total_usage ?? 0);
    const sysDelta = (raw.cpu_stats?.system_cpu_usage ?? 0) - (raw.precpu_stats?.system_cpu_usage ?? 0);
    const cpus = raw.cpu_stats?.online_cpus ?? 1;
    const cpuPercent = sysDelta > 0 && cpuDelta >= 0 ? (cpuDelta / sysDelta) * cpus * 100 : null;

    return { memUsageBytes, memLimitBytes: raw.memory_stats?.limit ?? null, cpuPercent };
  } catch {
    return empty;
  }
}

/**
 * Read the container's cgroup memory counters. `oom_kill` is the counter that
 * proves the kernel reaped a process inside the container, and `oom`/`max`
 * staying at 0 while `oom_kill` is non-zero proves it was the HOST running out
 * rather than the container hitting its own limit — the exact distinction that
 * diagnosed the 2026-07-29 outage. Best-effort: returns nulls if unreadable.
 */
export async function getCgroupMemoryEvents(username: string): Promise<{ oomKill: number | null; oom: number | null; peakBytes: number | null; maxBytes: string | null }> {
  const empty = { oomKill: null, oom: null, peakBytes: null, maxBytes: null };
  try {
    const c = docker.getContainer(containerName(username));
    const exec = await c.exec({
      Cmd: ["sh", "-c", "cat /sys/fs/cgroup/memory.events 2>/dev/null; echo ---; cat /sys/fs/cgroup/memory.peak 2>/dev/null; echo ---; cat /sys/fs/cgroup/memory.max 2>/dev/null"],
      AttachStdout: true, AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const out = await new Promise<string>((resolve) => {
      let buf = "";
      stream.on("data", (chunk: Buffer) => { buf += chunk.toString("utf8"); });
      stream.on("end", () => resolve(buf));
      stream.on("error", () => resolve(buf));
      setTimeout(() => resolve(buf), 4000);
    });
    // Strip Docker's 8-byte stream-multiplexing frame headers.
    const text = out.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, "");
    const [eventsPart = "", peakPart = "", maxPart = ""] = text.split("---");
    const num = (re: RegExp): number | null => {
      const m = re.exec(eventsPart);
      return m ? Number(m[1]) : null;
    };
    const peak = /(\d{3,})/.exec(peakPart);
    const max = /(max|\d{3,})/.exec(maxPart);
    return {
      oomKill: num(/oom_kill\s+(\d+)/),
      oom: num(/oom\s+(\d+)/),
      peakBytes: peak ? Number(peak[1]) : null,
      maxBytes: max ? max[1] : null,
    };
  } catch {
    return empty;
  }
}

export interface HostInfo {
  memTotalBytes: number | null;
  ncpu: number | null;
  dockerVersion: string | null;
  containersRunning: number | null;
  containersStopped: number | null;
}

export async function getHostInfo(): Promise<HostInfo> {
  try {
    const info = (await docker.info()) as {
      MemTotal?: number; NCPU?: number; ServerVersion?: string;
      ContainersRunning?: number; ContainersStopped?: number;
    };
    return {
      memTotalBytes: info.MemTotal ?? null,
      ncpu: info.NCPU ?? null,
      dockerVersion: info.ServerVersion ?? null,
      containersRunning: info.ContainersRunning ?? null,
      containersStopped: info.ContainersStopped ?? null,
    };
  } catch {
    return { memTotalBytes: null, ncpu: null, dockerVersion: null, containersRunning: null, containersStopped: null };
  }
}

export async function waitForHealthy(username: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const hostname = containerName(username);

  while (Date.now() < deadline) {
    const ok = await probe(hostname);
    if (ok) return;

    // Fail fast if the container has died instead of polling a dead container
    // for the full timeout (the "provisioning… with no feedback" symptom).
    const info = await inspectContainer(hostname).catch(() => null);
    if (info && !info.State.Running && !info.State.Restarting &&
        info.State.Status !== "created") {
      const logs = await getContainerLogs(username, 60);
      // Full logs go to server console only — the thrown message stays short.
      console.error(
        `[bastion] [${username}] Container exited during startup ` +
        `(status=${info.State.Status}, exitCode=${info.State.ExitCode}).\n` +
        `Recent container logs:\n${logs || "(no logs captured)"}`,
      );
      throw new Error(
        `Container exited during startup (status=${info.State.Status}, exitCode=${info.State.ExitCode}). ` +
        `See server logs for container output.`,
      );
    }

    await sleep(2000);
  }
  const logs = await getContainerLogs(username, 60);
  // Full logs go to server console only — the thrown message stays short.
  console.error(
    `[bastion] [${username}] Container did not become healthy within ${Math.round(timeoutMs / 1000)}s.\n` +
    `Recent container logs:\n${logs || "(no logs captured)"}`,
  );
  throw new Error(
    `Container did not become healthy within ${Math.round(timeoutMs / 1000)}s. ` +
    `See server logs for container output.`,
  );
}

function probe(hostname: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname, port: 8090, path: "/api/health", timeout: 3000 },
      (res) => { resolve(res.statusCode === 200); },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
