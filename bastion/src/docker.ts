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
  return images.map((img) => ({
    id: img.Id.slice(7, 19), // strip "sha256:" prefix, keep 12 chars
    tags: img.RepoTags ?? [],
    sizeMb: Math.round(img.Size / 1024 / 1024),
    created: img.Created,
  }));
}

export async function buildImage(
  repoPath: string,
  dockerfile: string,
  tag: string,
  onEvent: (event: { line?: string; error?: string; status?: string }) => void,
): Promise<void> {
  const tarFs = await import("tar-fs");
  const tarStream = tarFs.default.pack(repoPath, {
    ignore: (name: string) =>
      name.includes("node_modules") || name.includes(".next") || name.includes(".git"),
  });
  const buildStream = await docker.buildImage(tarStream, { t: tag, dockerfile });
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      buildStream,
      (err: Error | null) => { if (err) reject(err); else resolve(); },
      (event: { stream?: string; error?: string }) => {
        if (event.error) {
          onEvent({ error: event.error });
        } else if (event.stream) {
          const line = event.stream.replace(/\n$/, "");
          if (line) onEvent({ line });
        }
      },
    );
  });
}

export async function waitForHealthy(username: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const hostname = containerName(username);

  while (Date.now() < deadline) {
    const ok = await probe(hostname);
    if (ok) return;
    await sleep(2000);
  }
  throw new Error(`[bastion] Container ${hostname} did not become healthy within ${timeoutMs}ms`);
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
