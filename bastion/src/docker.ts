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

export async function createBosContainer(username: string, cfg: Config): Promise<string> {
  const name = containerName(username);
  const srcPath = `${cfg.volumeBase}/${username}/src`;
  const dataPath = `${cfg.volumeBase}/${username}/data`;
  const nmVol = volumeName(username);

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
    ],
    HostConfig: {
      NetworkMode: cfg.bosNet,
      Binds: [
        `${srcPath}:/app/src`,
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
