import { createProxyMiddleware } from "http-proxy-middleware";
import type { RequestHandler } from "express";
import type { Server } from "http";
import type { Config } from "./config";
import { verifySession, clearSession } from "./sessions";
import { getOrProvision, resetIdleTimer } from "./lifecycle";
import { containerName } from "./docker";

const ERROR_PAGE = (msg: string, showAccount: boolean) => `
<!DOCTYPE html><html><head><title>BrowserOS</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f0f0f;color:#ccc}
.box{text-align:center;max-width:400px}.box h2{color:#e55}.box a{color:#7af}</style>
</head><body><div class="box">
<h2>Could not reach your BOS instance</h2>
<p>${msg}</p>
${showAccount ? '<p><a href="/app/account">Go to Account page to re-provision</a></p>' : ''}
</div></body></html>
`;

export function createBosProxy(cfg: Config): RequestHandler & { upgrade?: (server: Server) => void } {
  const proxyMap = new Map<string, RequestHandler>();

  function getProxy(username: string): RequestHandler {
    if (!proxyMap.has(username)) {
      const target = `http://${containerName(username)}:8090`;
      proxyMap.set(username, createProxyMiddleware({
        target,
        changeOrigin: true,
        ws: true,
        on: {
          error: (err, _req, res) => {
            if (res && "writeHead" in res) {
              res.writeHead(502, { "Content-Type": "text/html" });
              res.end(ERROR_PAGE("The connection to your BOS instance failed.", true));
            }
          },
        },
      }));
    }
    return proxyMap.get(username)!;
  }

  const middleware: RequestHandler = async (req, res, next) => {
    const session = verifySession(req, cfg);
    if (!session) {
      clearSession(res);
      res.redirect("/app/login");
      return;
    }

    try {
      await getOrProvision(session.username, cfg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(503).send(ERROR_PAGE(msg, true));
      return;
    }

    resetIdleTimer(session.username, cfg);
    getProxy(session.username)(req, res, next);
  };

  return middleware;
}
