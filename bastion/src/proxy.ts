import { createProxyMiddleware } from "http-proxy-middleware";
import type { RequestHandler } from "express";
import type { Server } from "http";
import type { Config } from "./config";
import { verifySession, clearSession, shouldRefreshSession, sessionSetCookie, SESSION_TTL_MS } from "./sessions";
import { getOrProvision, resetIdleTimer, getInstanceState } from "./lifecycle";
import { containerName } from "./docker";

// Per-request stash for a rolling-session refresh cookie. Set in the middleware
// when the token crosses its refresh threshold; consumed either by the proxyRes
// hook (proxied responses) or set directly on bastion-generated responses.
const REFRESH_COOKIE = Symbol("bosRefreshCookie");
interface RefreshReq {
  [REFRESH_COOKIE]?: string;
}

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
  .error-stack{font-family:monospace;font-size:11px;color:#c77;white-space:pre-wrap;word-break:break-all;margin:0 0 12px}
  .error-actions{display:flex;gap:8px;flex-wrap:wrap}
  .btn{display:inline-block;padding:8px 16px;border-radius:6px;font-size:13px;font-weight:500;
       text-decoration:none;cursor:pointer;border:1px solid transparent}
  .btn-primary{background:#2563eb;color:#fff}
  .btn-primary:hover{background:#1d4ed8}
  .btn-secondary{background:#222;color:#ccc;border-color:#444}
  .btn-secondary:hover{background:#2a2a2a}
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
    <div class="error-actions">
      <a class="btn btn-primary" href="/app/account">Go to my account page</a>
      <a class="btn btn-secondary" href="/" onclick="sessionStorage.removeItem('bosProvRetries');sessionStorage.removeItem('bosProvRetryAt')">Try again</a>
    </div>
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
// Bounded automatic recovery: provisioning is idempotent and self-healing
// (it cleans up partial/stale state on retry), so on a failure we re-trigger it
// a few times before giving up. Reloading '/' hits the proxy, which re-invokes
// provisioning. A sessionStorage counter caps attempts so we never loop forever;
// once exhausted the error is shown persistently (never silently swallowed).
var MAX_AUTO_RETRIES = 3;
var RETRY_SETTLE_MS = 12000; // after a retry, ignore stale 'unknown' this long
function retryCount() { return parseInt(sessionStorage.getItem('bosProvRetries') || '0', 10); }
function retryAt() { return parseInt(sessionStorage.getItem('bosProvRetryAt') || '0', 10); }
function poll() {
  fetch('/account/instance')
    .then(r => r.json())
    .then(d => {
      msgEl.textContent = labels[d.status] || labels.unknown;
      if (d.provisionLog) logEl.textContent = d.provisionLog;

      if (d.status === 'running') {
        sessionStorage.removeItem('bosProvRetries');
        sessionStorage.removeItem('bosProvRetryAt');
        errorBox.style.display = 'none';
        setTimeout(() => { window.location.replace('/'); }, 300);
        return;
      }

      // Failed (unknown status with a captured error): auto-recover a bounded
      // number of times by re-triggering the self-healing provision.
      if (d.status === 'unknown' && d.provisionError) {
        // Right after a retry the background re-provision may not have flipped
        // status to 'provisioning' yet — ignore the stale failure for a bit so
        // we don't burn all retries instantly.
        if (Date.now() - retryAt() < RETRY_SETTLE_MS) {
          errorBox.style.display = 'none';
          setTimeout(poll, 2000);
          return;
        }
        var n = retryCount();
        if (n < MAX_AUTO_RETRIES) {
          sessionStorage.setItem('bosProvRetries', String(n + 1));
          sessionStorage.setItem('bosProvRetryAt', String(Date.now()));
          msgEl.textContent = 'Recovering and retrying (attempt ' + (n + 1) + ' of ' + MAX_AUTO_RETRIES + ')…';
          errorBox.style.display = 'none';
          setTimeout(() => { window.location.replace('/'); }, 1500);
        } else {
          // Exhausted automatic recovery — surface the error for the operator.
          errorBox.style.display = 'block';
          dotsEl.style.display = 'none';
          errorStack.textContent = d.provisionError;
        }
        return;
      }

      errorBox.style.display = 'none';
      setTimeout(poll, 2000);
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
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;
height:100vh;margin:0;background:#0f0f0f;color:#ccc}
.box{text-align:center;max-width:420px;padding:24px}.box h2{color:#e55;margin-bottom:12px;font-size:18px}
.box p{font-size:14px;color:#888}
.actions{display:flex;gap:8px;justify-content:center;margin-top:20px}
.btn{display:inline-block;padding:8px 16px;border-radius:6px;font-size:13px;font-weight:500;
text-decoration:none;border:1px solid transparent}
.btn-primary{background:#2563eb;color:#fff}.btn-primary:hover{background:#1d4ed8}
.btn-secondary{background:#222;color:#ccc;border:1px solid #444}.btn-secondary:hover{background:#2a2a2a}</style></head>
<body><div class="box">
<h2>Could not start your BOS instance</h2>
<p>${msg}</p>
<div class="actions">
<a class="btn btn-primary" href="/app/account">Go to my account page</a>
<a class="btn btn-secondary" href="/">Try again</a>
</div>
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
          proxyRes: (proxyRes, req) => {
            // Rolling session: append the refreshed cookie to the upstream
            // response so an active user's session never expires. Injecting via
            // the proxied response is reliable; an Express res.cookie() set
            // before proxying can be clobbered by the upstream headers.
            const refresh = (req as unknown as RefreshReq)[REFRESH_COOKIE];
            if (refresh) {
              const existing = proxyRes.headers["set-cookie"];
              const arr = Array.isArray(existing) ? existing : existing ? [existing] : [];
              proxyRes.headers["set-cookie"] = [...arr, refresh];
            }
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

    // Rolling session: any authenticated request past the refresh threshold
    // re-issues the cookie, so an active user is never logged out mid-work.
    // Stash it for the proxyRes hook (the reliable path for proxied responses);
    // bastion-generated responses below set it directly on res.
    const refreshCookie = shouldRefreshSession(session) ? sessionSetCookie(session, cfg) : undefined;
    if (refreshCookie) (req as unknown as RefreshReq)[REFRESH_COOKIE] = refreshCookie;

    // Keep the container alive for as long as the user is logged in: the idle
    // stop tracks the session's expiry (+ grace), so it only elapses once the
    // rolling auth session has lapsed. If we just refreshed, the effective
    // expiry is now + TTL; otherwise it's the token's own exp.
    const sessionExpMs = refreshCookie
      ? Date.now() + SESSION_TTL_MS
      : session.exp ? session.exp * 1000 : Date.now() + SESSION_TTL_MS;
    const stopAtMs = sessionExpMs + cfg.idleTimeoutMs;

    const { username } = session;
    const state = getInstanceState(username);

    // Fast path: already running — proxy immediately (proxyRes injects the
    // refresh cookie into the upstream response).
    if (state?.status === "running") {
      resetIdleTimer(username, cfg, stopAtMs);
      getProxy(username)(req, res, next);
      return;
    }

    // Non-HTML requests (assets, API calls) while not running get a simple 503.
    const acceptsHtml = (req.headers.accept ?? "").includes("text/html");
    if (!acceptsHtml) {
      if (refreshCookie) res.setHeader("Set-Cookie", refreshCookie);
      res.status(503).json({ error: "BOS instance not ready", status: state?.status ?? "unknown" });
      return;
    }

    // Kick off provisioning / start in the background — do NOT await.
    getOrProvision(username, cfg).catch((err: Error) => {
      console.error(`[bastion] provision failed for ${username}:`, err.stack ?? err.message);
    });

    // Return the status page immediately. Its JS polls /account/instance and
    // redirects to / when status flips to "running".
    if (refreshCookie) res.setHeader("Set-Cookie", refreshCookie);
    res.status(200).send(STATUS_PAGE);
  };

  return middleware;
}
