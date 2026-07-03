import "server-only";
import { spawn, execFile, execFileSync } from "node:child_process";
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

interface Volume {
  hostPath: string;
  mode: "ro" | "rw";
}

interface RcConfig {
  enabled: boolean;
  backend: "local" | "docker";
  dockerImage: string;
  /** VFS path mounted rw as /workspace (so files + outputs show up in Files). */
  workspace: string;
  volumes: Volume[];
  network: boolean;
  idleTimeoutMs: number;
  maxTimeoutMs: number;
}

function positive(v: unknown, dflt: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function parseVolumes(v: unknown): Volume[] {
  if (typeof v !== "string") return [];
  return v
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line): Volume | null => {
      const i = line.lastIndexOf(":");
      const mode = i > 0 ? line.slice(i + 1).trim() : "";
      if (i > 0 && (mode === "ro" || mode === "rw")) {
        return { hostPath: line.slice(0, i).trim(), mode };
      }
      return { hostPath: line, mode: "ro" };
    })
    .filter((x): x is Volume => x !== null && x.hostPath.length > 0);
}

export async function loadRcConfig(): Promise<RcConfig> {
  const s = await readNamespace(NAMESPACE);
  const backend = s.backend === "local" ? "local" : "docker";
  return {
    enabled: s.enabled === true,
    backend,
    dockerImage: typeof s.dockerImage === "string" && s.dockerImage.trim() ? s.dockerImage.trim() : "browseros/run-command:latest",
    workspace: typeof s.workspace === "string" && s.workspace.trim() ? s.workspace.trim() : "/workspace",
    volumes: parseVolumes(s.volumes),
    network: s.network === true,
    idleTimeoutMs: positive(s.idleTimeoutSec, DEFAULT_IDLE_SEC) * 1000,
    maxTimeoutMs: positive(s.maxTimeoutSec, DEFAULT_MAX_SEC) * 1000,
  };
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
  const started = Date.now();
  return new Promise<RunResult>((resolve) => {
    const child = spawn(prog, args, { cwd: o.cwd, env: process.env });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let idleHit = false;
    let maxHit = false;
    let settled = false;

    const kill = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 2_000).unref();
    };

    let idleTimer: NodeJS.Timeout;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleHit = true;
        kill();
      }, o.idleMs);
    };
    const maxTimer = setTimeout(() => {
      maxHit = true;
      kill();
    }, o.maxMs);

    const onData = (d: Buffer) => {
      const remaining = MAX_COLLECT_BYTES - bytes;
      if (remaining > 0) {
        const slice = d.length <= remaining ? d : d.subarray(0, remaining);
        chunks.push(slice);
        bytes += slice.length;
        if (d.length > remaining) kill();
      }
      resetIdle();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    resetIdle();

    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(maxTimer);
      resolve(r);
    };

    child.on("error", (err) =>
      finish({ ok: false, exitCode: null, output: (err as Error).message, durationMs: Date.now() - started, backend: o.backend }),
    );
    child.on("close", (code) => {
      let output = truncateTail(Buffer.concat(chunks));
      if (idleHit) output += `\n[killed: no output for ${o.idleMs}ms]`;
      if (maxHit) output += `\n[killed: exceeded ${o.maxMs}ms]`;
      finish({
        ok: code === 0 && !idleHit && !maxHit,
        exitCode: code,
        output,
        durationMs: Date.now() - started,
        backend: o.backend,
        timedOut: maxHit || undefined,
        idleTimedOut: idleHit || undefined,
      });
    });
  });
}

// --- Docker backend: one long-lived container per (session, agent) ---

interface ContainerEntry {
  name: string;
  lastUsed: number;
}
// Persist the container registry across dev hot-reloads.
const g = globalThis as unknown as {
  __bosRcContainers?: Map<string, ContainerEntry>;
  __bosRcReaper?: NodeJS.Timeout;
  __bosRcHooks?: boolean;
};
const containers: Map<string, ContainerEntry> = (g.__bosRcContainers ??= new Map());

// Tear down sandbox containers when the server process exits. Registered once,
// lazily (only after the docker backend is first used). Signal handlers use the
// SYNC docker CLI so cleanup completes before the process terminates.
function installShutdownHooks(): void {
  if (g.__bosRcHooks) return;
  g.__bosRcHooks = true;
  const syncCleanup = () => {
    for (const c of containers.values()) {
      try {
        execFileSync("docker", ["rm", "-f", c.name], { stdio: "ignore" });
      } catch {
        /* ignore */
      }
    }
    containers.clear();
  };
  process.once("SIGTERM", () => {
    syncCleanup();
    process.exit(0);
  });
  process.once("SIGINT", () => {
    syncCleanup();
    process.exit(0);
  });
  process.once("exit", syncCleanup);
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
  const workspaceHost = hostPath(cfg.workspace);
  await fs.mkdir(workspaceHost, { recursive: true });
  await execFileP("docker", ["rm", "-f", name]).catch(() => {}); // clear any stale container
  const args = [
    "run", "-d", "--name", name,
    "--label", CONTAINER_LABEL,
    "--workdir", "/workspace",
    "-v", `${workspaceHost}:/workspace:rw`,
    "--user", "1000:1000",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "512",
    "--memory", "2g",
    "--read-only",
    "--tmpfs", "/tmp:rw,exec,size=512m",
    ...(cfg.network ? [] : ["--network", "none"]),
    ...cfg.volumes.flatMap((v) => ["-v", `${v.hostPath}:${v.hostPath}:${v.mode}`]),
    cfg.dockerImage,
    "sleep", "infinity",
  ];
  await execFileP("docker", args);
  containers.set(sessionKey, { name, lastUsed: Date.now() });
  scheduleReaper();
  installShutdownHooks();
  return name;
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

  // The workspace: a VFS-backed folder that is the CWD (local) or bind-mounted at
  // /workspace (docker). Because it's in the VFS, files the agent writes and
  // command outputs show up in the Files app, and file_write to the same path
  // targets the same bytes the sandbox sees.
  const workspaceHost = hostPath(cfg.workspace);
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

  // local backend
  return runChild(prog, args, { cwd: workspaceHost, idleMs: cfg.idleTimeoutMs, maxMs, backend: "local" });
}

/** Tear down all sandbox containers (call on shutdown). */
export async function shutdownRunCommand(): Promise<void> {
  for (const c of containers.values()) {
    await execFileP("docker", ["rm", "-f", c.name]).catch(() => {});
  }
  containers.clear();
}
