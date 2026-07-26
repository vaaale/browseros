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
