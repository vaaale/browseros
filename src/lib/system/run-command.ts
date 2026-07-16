import "server-only";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { hostPath } from "@/os/vfs";
import { readNamespace } from "@/lib/config/store";
import { stageSkillFiles } from "@/lib/agent/skills/store";

const CONTAINER_LABEL = "bos.run-command=1";

// Sandboxed command execution for the assistant and sub-agents. Two backends:
//  - "docker": each (browser-session, agent) gets its own long-lived container
//    (kept alive across the session); commands run via `docker exec`. Real
//    isolation (namespaces + cgroups + image fs), non-root, workspace-only rw.
//  - "local": runs directly on the host — intended for when BOS itself already
//    runs inside a container. Gated behind the same `enabled` switch.
// A `bwrap` backend can slot in later behind the same interface.
//
// Safety: off by default; per-call GLOBAL max timeout AND an inter-output IDLE
// watchdog (kills a process that stops producing output); output buffer caps.

export const NAMESPACE = "run-command";

const DEFAULT_IDLE_SEC = 120;
const DEFAULT_MAX_SEC = 600;
const MAX_COLLECT_BYTES = 8 * 1024 * 1024;
const TRUNCATE_TO_BYTES = 16 * 1024;
const CONTAINER_TTL_MS = 15 * 60_000; // reap idle containers after 15 min

const execFileP = promisify(execFile);

export type RunLanguage = "bash" | "python" | "node";

export interface RunResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
  durationMs: number;
  backend: string;
  timedOut?: boolean;
  idleTimedOut?: boolean;
}

export interface VfsMount {
  /** VFS path, e.g. "/workspace" or "/Documents" */
  vfsPath: string;
  /** Path inside the sandbox, e.g. "/workspace" or "/Documents" */
  containerPath: string;
  mode: "rw" | "ro";
  enabled: boolean;
}

export const DEFAULT_MOUNTS: VfsMount[] = [
  { vfsPath: "/workspace", containerPath: "/workspace", mode: "rw", enabled: true },
  { vfsPath: "/Documents", containerPath: "/Documents", mode: "rw", enabled: true },
];

interface RcConfig {
  enabled: boolean;
  backend: "local" | "docker";
  dockerImage: string;
  vfsMounts: VfsMount[];
  network: boolean;
  idleTimeoutMs: number;
  maxTimeoutMs: number;
}

function positive(v: unknown, dflt: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function parseVfsMounts(raw: unknown): VfsMount[] {
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_MOUNTS;
  const mounts: VfsMount[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      typeof item.vfsPath === "string" &&
      typeof item.containerPath === "string" &&
      (item.mode === "rw" || item.mode === "ro") &&
      typeof item.enabled === "boolean"
    ) {
      mounts.push(item as VfsMount);
    }
  }
  return mounts.length > 0 ? mounts : DEFAULT_MOUNTS;
}

export async function loadRcConfig(): Promise<RcConfig> {
  const s = await readNamespace(NAMESPACE);
  // In Bastion mode (BOS_PUBLIC_PORT set by the bastion when spawning this
  // container), force the local backend — the user container IS the sandbox.
  const bastionMode = !!process.env.BOS_PUBLIC_PORT;
  const backend = bastionMode ? "local" : (s.backend === "local" ? "local" : "docker");
  return {
    enabled: s.enabled === true,
    backend,
    dockerImage: typeof s.dockerImage === "string" && s.dockerImage.trim() ? s.dockerImage.trim() : "browseros/run-command:latest",
    vfsMounts: parseVfsMounts(s.vfsMounts),
    network: s.network === true,
    idleTimeoutMs: positive(s.idleTimeoutSec, DEFAULT_IDLE_SEC) * 1000,
    maxTimeoutMs: positive(s.maxTimeoutSec, DEFAULT_MAX_SEC) * 1000,
  };
}

/**
 * The uid:gid the run_command sandbox container runs as, matching THIS
 * process's own live uid/gid — which, inside the browseros container, is the
 * "user" account docker-entrypoint.sh creates from CONTAINER_UID/CONTAINER_GID
 * (the host user's ids). Passed as a numeric --user, so no matching account
 * needs to exist inside the sandbox image itself.
 */
function sandboxUser(): string {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  return `${uid}:${gid}`;
}

function argvFor(language: RunLanguage, command: string): string[] {
  switch (language) {
    // Python one-liners via IPython (rich errors); the image must provide it.
    case "python":
      return ["ipython", "--no-banner", "-c", command];
    // Node eval; the image must provide node.
    case "node":
      return ["node", "-e", command];
    default:
      return ["bash", "-lc", command];
  }
}

function truncateTail(buf: Buffer): string {
  if (buf.length <= TRUNCATE_TO_BYTES) return buf.toString("utf8");
  return "\n[truncated]\n" + buf.subarray(buf.length - TRUNCATE_TO_BYTES).toString("utf8");
}

function safeKey(sessionKey: string): string {
  return createHash("sha1").update(sessionKey).digest("hex").slice(0, 16);
}

// Spawn a child, merging stdout+stderr, enforcing an idle (inter-output) watchdog
// AND a global max timeout, with output buffer caps. Never throws.
function runChild(
  prog: string,
  args: string[],
  o: { cwd?: string; idleMs: number; maxMs: number; backend: string },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(prog, args, {
      cwd: o.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let buf = Buffer.alloc(0);
    let timedOut = false;
    let idleTimedOut = false;

    const finish = (exitCode: number | null) => {
      clearTimeout(maxTimer);
      clearTimeout(idleTimer);
      resolve({
        ok: exitCode === 0 && !timedOut && !idleTimedOut,
        exitCode,
        output: truncateTail(buf),
        durationMs: Date.now() - start,
        backend: o.backend,
        timedOut,
        idleTimedOut,
      });
    };

    let idleTimer = setTimeout(() => {
      idleTimedOut = true;
      child.kill("SIGKILL");
    }, o.idleMs);

    const maxTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, o.maxMs);

    const onData = (chunk: Buffer) => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        child.kill("SIGKILL");
      }, o.idleMs);
      if (buf.length < MAX_COLLECT_BYTES) {
        buf = Buffer.concat([buf, chunk]);
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", finish);
    child.on("error", () => finish(null));
  });
}

// ── Global container registry (survives hot-reloads via globalThis) ──────────
declare global {
  // eslint-disable-next-line no-var
  var __bosRcContainers: Map<string, { name: string; lastUsed: number }> | undefined;
  // eslint-disable-next-line no-var
  var __bosRcReaper: ReturnType<typeof setInterval> | undefined;
  // eslint-disable-next-line no-var
  var __bosRcShutdown: boolean | undefined;
}
const g = globalThis as typeof globalThis & {
  __bosRcContainers?: Map<string, { name: string; lastUsed: number }>;
  __bosRcReaper?: ReturnType<typeof setInterval>;
  __bosRcShutdown?: boolean;
};
if (!g.__bosRcContainers) g.__bosRcContainers = new Map();
const containers = g.__bosRcContainers;

function installShutdownHooks() {
  if (g.__bosRcShutdown) return;
  g.__bosRcShutdown = true;
  const cleanup = () => { void shutdownRunCommand(); };
  process.once("SIGTERM", cleanup);
  process.once("SIGINT", cleanup);
  process.once("exit", cleanup);
}

function containerName(sessionKey: string): string {
  return "bos-rc-" + safeKey(sessionKey);
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileP("docker", ["version", "--format", "{{.Server.Version}}"]);
    return true;
  } catch {
    return false;
  }
}

async function isRunning(name: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP("docker", ["inspect", "-f", "{{.State.Running}}", name]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

function scheduleReaper(): void {
  if (g.__bosRcReaper) return;
  g.__bosRcReaper = setInterval(() => {
    const now = Date.now();
    for (const [key, c] of containers) {
      if (now - c.lastUsed > CONTAINER_TTL_MS) {
        containers.delete(key);
        void execFileP("docker", ["rm", "-f", c.name]).catch(() => {});
      }
    }
  }, 60_000);
  g.__bosRcReaper.unref?.();
}

async function ensureContainer(cfg: RcConfig, sessionKey: string): Promise<string> {
  const name = containerName(sessionKey);
  const existing = containers.get(sessionKey);
  if (existing && (await isRunning(name))) {
    existing.lastUsed = Date.now();
    return name;
  }
  containers.delete(sessionKey);
  await execFileP("docker", ["rm", "-f", name]).catch(() => {}); // clear any stale container

  // Build volume flags from enabled mounts; ensure each VFS dir exists on the host.
  const volumeArgs: string[] = [];
  for (const mount of cfg.vfsMounts.filter((m) => m.enabled)) {
    const hp = hostPath(mount.vfsPath);
    await fs.mkdir(hp, { recursive: true }).catch(() => {});
    volumeArgs.push("-v", `${hp}:${mount.containerPath}:${mount.mode}`);
  }

  const args = [
    "run", "-d", "--name", name,
    "--label", CONTAINER_LABEL,
    "--workdir", "/workspace",
    "--user", sandboxUser(),
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "512",
    "--memory", "2g",
    "--tmpfs", "/tmp:rw,exec,size=512m",
    ...(cfg.network ? [] : ["--network", "none"]),
    ...volumeArgs,
    cfg.dockerImage,
    "sleep", "infinity",
  ];
  await execFileP("docker", args);
  containers.set(sessionKey, { name, lastUsed: Date.now() });
  scheduleReaper();
  installShutdownHooks();
  return name;
}

/**
 * Sync VFS mount symlinks for the local backend.
 * Uses `sudo /usr/local/bin/bos-vfs-link` (narrow sudoers entry) so the
 * non-root bos process can create/remove symlinks at absolute paths.
 * All errors are non-fatal — commands still run even if a symlink fails.
 */
async function syncLocalSymlinks(mounts: VfsMount[]): Promise<void> {
  for (const mount of mounts) {
    const target = hostPath(mount.vfsPath);
    const link = mount.containerPath;
    if (mount.enabled) {
      await fs.mkdir(target, { recursive: true }).catch(() => {});
      // Only call sudo if the symlink doesn't already point to the right place.
      const existing = await fs.readlink(link).catch(() => null);
      if (existing !== target) {
        await execFileP("sudo", ["/usr/local/bin/bos-vfs-link", "add", link, target]).catch(() => {});
      }
    } else {
      const st = await fs.lstat(link).catch(() => null);
      if (st?.isSymbolicLink()) {
        await execFileP("sudo", ["/usr/local/bin/bos-vfs-link", "remove", link]).catch(() => {});
      }
    }
  }
}

/** Run one command in the (session, agent) sandbox. Never throws.
 *
 *  If `skill` is given, that skill's bundled files are staged into the workspace
 *  (CWD) first, so a SKILL.md command like `python scripts/office/unpack.py`
 *  resolves against the workspace root exactly as the skill's docs assume. */
export async function runCommand(opts: {
  command: string;
  sessionKey: string;
  language?: RunLanguage;
  timeoutMs?: number;
  skill?: string;
}): Promise<RunResult> {
  const cfg = await loadRcConfig();
  if (!cfg.enabled) {
    return { ok: false, exitCode: null, output: "run_command is disabled. Enable it in Settings → Command Execution.", durationMs: 0, backend: "none" };
  }
  const language = opts.language ?? "bash";
  const maxMs = Math.min(positive(opts.timeoutMs, cfg.maxTimeoutMs), cfg.maxTimeoutMs);
  const [prog, ...args] = argvFor(language, opts.command);

  // Resolve workspace: the mount whose containerPath is "/workspace".
  // Files the agent writes and command outputs show up in the Files app because
  // the workspace vfsPath is VFS-backed.
  const workspaceMount = cfg.vfsMounts.find((m) => m.containerPath === "/workspace" && m.enabled);
  const workspaceVfsPath = workspaceMount?.vfsPath ?? "/workspace";
  const workspaceHost = hostPath(workspaceVfsPath);
  await fs.mkdir(workspaceHost, { recursive: true }).catch(() => {});

  if (opts.skill) {
    const staged = await stageSkillFiles(opts.skill, workspaceHost).catch(() => false);
    if (!staged) {
      return { ok: false, exitCode: null, output: `No skill "${opts.skill}" to stage into the workspace.`, durationMs: 0, backend: cfg.backend };
    }
  }

  if (cfg.backend === "docker") {
    if (!(await dockerAvailable())) {
      return { ok: false, exitCode: null, output: "Docker backend selected but the docker CLI/daemon is not available on the host.", durationMs: 0, backend: "docker" };
    }
    let name: string;
    try {
      name = await ensureContainer(cfg, opts.sessionKey);
    } catch (err) {
      return { ok: false, exitCode: null, output: `Failed to start sandbox container: ${(err as Error).message}`, durationMs: 0, backend: "docker" };
    }
    return runChild("docker", ["exec", "-i", name, prog, ...args], { idleMs: cfg.idleTimeoutMs, maxMs, backend: "docker" });
  }

  // Local backend: sync VFS symlinks so absolute paths like /Documents resolve.
  await syncLocalSymlinks(cfg.vfsMounts);
  return runChild(prog, args, { cwd: workspaceHost, idleMs: cfg.idleTimeoutMs, maxMs, backend: "local" });
}

/** Tear down all sandbox containers (call on shutdown). */
export async function shutdownRunCommand(): Promise<void> {
  for (const c of containers.values()) {
    await execFileP("docker", ["rm", "-f", c.name]).catch(() => {});
  }
  containers.clear();
}
