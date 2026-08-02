import "server-only";
import net from "node:net";

/**
 * Check whether a TCP port is currently available to bind on the given host.
 * Binds a throwaway server and immediately closes it — a positive result is
 * only a point-in-time hint (TOCTOU), which is fine here since the actual
 * bind happens moments later inside the worker thread.
 */
export function checkPortAvailable(port: number, host: string = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    try {
      server.listen(port, host);
    } catch {
      resolve(false);
    }
  });
}

/**
 * BOS's own reserved ports — read from the SAME env vars the Supervisor
 * itself uses (`tools/supervisor/supervisor.mjs`'s `PUBLIC_PORT`/`BASE_PORT`/
 * `POOL_SIZE`), so this always agrees with whatever the actual Supervisor
 * instance is configured for rather than a second, driftable copy of the
 * numbers. Reserved = the Supervisor's public port, PLUS the base branch's
 * own port, PLUS every port in its preview-worktree pool (base+1..base+N) —
 * a fixed, non-zero service port landing in any of these is a real incident
 * waiting to happen (Terminal's shipped default of 3001 IS the first slot of
 * the default preview pool), not a hypothetical.
 */
export function bosReservedPorts(): { ports: Set<number>; describe: () => string } {
  const publicPort = Number(process.env.BOS_PUBLIC_PORT || 8080);
  const portBase = Number(process.env.BOS_PORT_BASE || 3000);
  const poolSize = Number(process.env.BOS_PORT_POOL_SIZE || 20);
  const ports = new Set<number>([publicPort, portBase]);
  for (let p = portBase + 1; p <= portBase + poolSize; p++) ports.add(p);
  return {
    ports,
    describe: () =>
      `BOS's own public port (${publicPort}) and its base+preview-pool range (${portBase}-${portBase + poolSize})`,
  };
}

/**
 * Returns a human-readable reason if `port` collides with one of BOS's own
 * reserved ports, or `null` if it's clear. Call this BEFORE `checkPortAvailable`
 * for any fixed, non-zero configured port — it catches a collision even when
 * nothing is bound yet (e.g. a preview build that hasn't started this cycle),
 * which a live socket-bind probe alone cannot.
 */
export function checkPortReservedByBos(port: number): string | null {
  const { ports, describe } = bosReservedPorts();
  if (!ports.has(port)) return null;
  return `Port ${port} is reserved by BOS itself — ${describe()}. Choose a different port outside that range, or set "port": 0 in this service's config to let the OS assign one automatically (recommended — see docs/dev/apps/services.md §3).`;
}
