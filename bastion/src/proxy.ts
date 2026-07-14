import { createProxyMiddleware } from "http-proxy-middleware";
import type { RequestHandler } from "express";
import type { Server } from "http";
import type { Config } from "./config";
import { verifySession, clearSession } from "./sessions";
import { getOrProvision, resetIdleTimer, getInstanceState } from "./lifecycle";
import { containerName } from "./docker";

// ── Status page ───────────────────────────────────────────────────────────────
// Shown while the container is provisioning or starting. Polls /account/instance
// and auto-redirects to / when status becomes "running".
const STATUS_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>BrowserOS — Starting</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f0f0f;color:#ccc;font-family:system-ui,sans-serif;
       display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  .box{text-align:center;max-width:560px;width:100%;padding:32px}
  .logo{font-size:26px;font-weight:600;color:#eee;margin-bottom:12px}
  .msg{font-size:14px;color:#888;margin-bottom:24px;min-height:20px}
  .dots{display:inline-flex;gap:8px;margin-bottom:24px}
  .dot{width:9px;height:9px;border-radius:50%;background:#2563eb;
       animation:pulse 1.4s ease-in-out infinite}
  .dot:nth-child(2){animation-delay:.2s}
  .dot:nth-child(3){animation-delay:.4s}
  @keyframes pulse{0%,80%,100%{opacity:.2;transform:scale(.8)}
                   40%{opacity:1;transform:scale(1)}}
  .log{text-align:left;font-size:12px;font-family:monospace;color:#aaa;
       background:#161616;border:1px solid #222;border-radius:6px;
       padding:12px 14px;margin-bottom:16px;min-height:28px;word-break:break-all}
  .error-box{display:none;text-align:left;background:#1a0a0a;border:1px solid #5a2020;
             border-radius:6px;padding:14px;margin-bottom:16px}
  .error-title{color:#e55;font-weight:600;font-size:13px;margin-bottom:8px}
  .error-stack{font-family:monospace;font-size:11px;color:#c77;white-space:pre-wrap;word-break:break-all;margin:0}
  .account{margin-top:8px;font-size:12px}
  .account a{color:#555;text-decoration:none}
  .account a:hover{color:#888}
</style>
</head>
<body>
<div class="box">
  <div class="logo">BrowserOS</div>
  <div class="msg" id="msg">Preparing your instance…</div>
  <div class="dots" id="dots">
    <div class="dot"></div><div class="dot"></div><div class="dot"></div>
  </div>
  <div class="log" id="log">Connecting…</div>
  <div class="error-box" id="error-box">
    <div class="error-title">Provisioning failed</div>
    <pre class="error-stack" id="error-stack"></pre>
  </div>
  <div class="account"><a href="/app/account">Account settings</a></div>
</div>
<script>
const msgEl = document.getElementById('msg');
const logEl = document.getElementById('log');
const dotsEl = document.getElementById('dots');
const errorBox = document.getElementById('error-box');
const errorStack = document.getElementById('error-stack');
const labels = {
  provisioning: 'Provisioning your instance…',
  stopped:      'Starting your instance…',
  unknown:      'Something went wrong — check the error below.',
  running:      'Ready — loading BrowserOS…'
};
function poll() {
  fetch('/account/instance')
    .then(r => r.json())
    .then(d => {
      msgEl.textContent = labels[d.status] || labels.unknown;
      if (d.provisionLog) logEl.textContent = d.provisionLog;
      if (d.provisionError) {
        errorBox.style.display = 'block';
        dotsEl.style.display = 'none';
        errorStack.textContent = d.provisionError;
      } else {
        errorBox.style.display = 'none';
      }
      if (d.status === 'running') {
        setTimeout(() => { window.location.replace('/'); }, 300);
      } else {
        setTimeout(poll, 2000);
      }
    })
    .catch(() => setTimeout(poll, 2000));
}
poll();
</script>
</body>
</html>`;

// ── Error page ────────────────────────────────────────────────────────────────
const ERROR_PAGE = (msg: string) => `<!DOCTYPE html>
<html><head><title>BrowserOS</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;
height:100vh;margin:0;background:#0f0f0f;color:#ccc}
.box{text-align:center;max-width:400px}.box h2{color:#e55;margin-bottom:12px}
.box a{color:#7af}</style></head>
<body><div class="box">
<h2>Could not start your BOS instance</h2>
<p>${msg}</p>
<p style="margin-top:16px"><a href="/app/account">Go to Account page</a></p>
</div></body></html>`;

// ── Proxy factory ─────────────────────────────────────────────────────────────
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
          proxyReq: (proxyReq) => {
            // Inject the authenticated username so BOS can surface it in the
            // session endpoint (used by the toolbar "My profile" link).
            proxyReq.setHeader("x-bos-username", username);
          },
          error: (_err, _req, res) => {
            if (res && "writeHead" in res) {
              res.writeHead(502, { "Content-Type": "text/html" });
              res.end(ERROR_PAGE("The connection to your BOS instance failed."));
            }
          },
        },
      }));
    }
    return proxyMap.get(username)!;
  }

  const middleware: RequestHandler = (req, res, next) => {
    const session = verifySession(req, cfg);
    if (!session) {
      clearSession(res);
      // Route through the auth /login endpoint so it can check bootstrap state
      // and redirect to /app/setup (first run) or /app/login as appropriate.
      res.redirect("/login");
      return;
    }

    const { username } = session;
    const state = getInstanceState(username);

    // Fast path: already running — proxy immediately.
    if (state?.status === "running") {
      resetIdleTimer(username, cfg);
      getProxy(username)(req, res, next);
      return;
    }

    // Non-HTML requests (assets, API calls) while not running get a simple 503.
    const acceptsHtml = (req.headers.accept ?? "").includes("text/html");
    if (!acceptsHtml) {
      res.status(503).json({ error: "BOS instance not ready", status: state?.status ?? "unknown" });
      return;
    }

    // Kick off provisioning / start in the background — do NOT await.
    getOrProvision(username, cfg).catch((err: Error) => {
      console.error(`[bastion] provision failed for ${username}:`, err.stack ?? err.message);
    });

    // Return the status page immediately. Its JS polls /account/instance and
    // redirects to / when status flips to "running".
    res.status(200).send(STATUS_PAGE);
  };

  return middleware;
}
