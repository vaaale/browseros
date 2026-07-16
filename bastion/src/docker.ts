import Dockerode from "dockerode";
import http from "http";
import type { Config } from "./config";

const docker = new Dockerode({ socketPath: "/var/run/docker.sock" });

export function containerName(username: string): string {
  return `bos-${username}`;
}

export function volumeName(username: string): string {
  return `bos-nm-${username}`;
}

export async function ensureNetwork(networkName: string): Promise<void> {
  try {
    await docker.getNetwork(networkName).inspect();
  } catch {
    await docker.createNetwork({ Name: networkName, Driver: "bridge" });
  }
}

export async function createBosContainer(username: string, cfg: Config): Promise<string> {
  const name = containerName(username);
  // Docker resolves bind mount sources against the HOST filesystem, not the
  // bastion container's filesystem. Use bosVolumeBaseHost (the host-side path)
  // for mounts, and cfg.volumeBase (the bastion-internal path) for file ops.
  const srcPath = `${cfg.bosVolumeBaseHost}/${username}/src`;
  const dataPath = `${cfg.bosVolumeBaseHost}/${username}/data`;
  const nmVol = volumeName(username);

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
      `BOS_PUBLIC_PORT=8090`,   // bastion proxies to this port
      `BOS_PORT_BASE=3000`,     // next dev internal port
      `BOS_BASE_DEV=1`,         // supervisor starts next dev automatically
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
      ],
      Mounts: [
        {
          Type: "volume",
          Source: nmVol,
          Target: "/app/node_modules",
        },
      ],
      RestartPolicy: { Name: "no" },
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
  "node_modules", ".next", ".git", "data", "user-data",
  "apps", "specs", "playwright-report", "test-results", "dist",
]);
const BUILD_IGNORE_FILES = new Set([".env", ".env.local"]);

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
      throw new Error(
        `Container ${hostname} exited during startup ` +
        `(status=${info.State.Status}, exitCode=${info.State.ExitCode}).\n` +
        `Recent container logs:\n${logs || "(no logs captured)"}`,
      );
    }

    await sleep(2000);
  }
  const logs = await getContainerLogs(username, 60);
  throw new Error(
    `Container ${hostname} did not become healthy within ${Math.round(timeoutMs / 1000)}s.\n` +
    `Recent container logs:\n${logs || "(no logs captured)"}`,
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
