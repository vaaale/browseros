import { createProxyMiddleware } from "http-proxy-middleware";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { Server } from "http";
import type { Config } from "./config";
import { verifySession, clearSession, shouldRefreshSession, sessionSetCookie } from "./sessions";
import { getOrProvision, touchInstance, getInstanceState } from "./lifecycle";
import { containerName } from "./docker";
import { resolveCredential } from "./credential-routing";

// Per-request stash for a rolling-session refresh cookie. Set in the middleware
// when the token crosses its refresh threshold; consumed either by the proxyRes
// hook (proxied responses) or set directly on bastion-generated responses.
const REFRESH_COOKIE = Symbol("bosRefreshCookie");
interface RefreshReq {
  [REFRESH_COOKIE]?: string;
}

// ── Trusted claim propagation ──────────────────────────────────────────────
// Bastion is the ONLY place that ever verifies a raw credential (the session
// JWT's signature, or a presented secret's hash against credentials-index.json)
// — everything downstream, inside a user's own container, must NEVER
// re-verify a raw credential itself, only trust an already-verified claim
// Bastion asserts. This is the same "gateway verifies, origin trusts an
// injected header" pattern any JWT-terminating reverse proxy uses (e.g. an
// Envoy/Istio JWT filter injecting `X-User-*` downstream) — it's what lets
// this generalize to future per-role requirements (Bastion already carries a
// real `isAdmin` claim in SessionPayload, see sessions.ts, currently checked
// only inside Bastion's own admin router; propagating it further is the same
// mechanism, just one more header) without changing the shape of the design.
//
// `x-bos-auth-scope` is exactly one of:
//   "session"        — a verified browser session (SessionPayload.username)
//   "secret:<service>" — a headless request routed by a per-service secret
//                        that was never validated as a session at all
// `x-bos-auth-role` is currently only ever "admin" (from SessionPayload's
// isAdmin), set alongside "session" — never set for the secret path, since
// per-service secrets carry no role claim today (see service-secrets.ts).
//
// Both are STRIPPED from every inbound request before this middleware makes
// its own routing decision, then set authoritatively below — a client can
// never forge either by sending them directly, since whatever it sends is
// discarded first.
const AUTH_SCOPE_HEADER = "x-bos-auth-scope";
const AUTH_ROLE_HEADER = "x-bos-auth-role";

function stripClaimHeaders(req: Request): void {
  delete req.headers[AUTH_SCOPE_HEADER];
  delete req.headers[AUTH_ROLE_HEADER];
}

// ── Headless Basic-auth credential routing (034-secrets-authentication) ───────
// Extracts the password half of a parseable `Authorization: Basic <b64>`
// header — the presented secret. The username half is never used for
// anything; only the secret determines routing (see credential-routing.ts).
function parseBasicAuthSecret(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Basic ")) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep === -1) return null;
  return decoded.slice(sep + 1);
}

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

  // Shared tail of the routing decision, once a target username is known —
  // reached either via an authenticated session or via a resolved headless
  // credential (034-secrets-authentication). `refreshCookie` only applies to
  // the session path.
  function routeToUser(username: string, req: Request, res: Response, next: NextFunction, refreshCookie?: string): void {
    if (refreshCookie) (req as unknown as RefreshReq)[REFRESH_COOKIE] = refreshCookie;

    const state = getInstanceState(username);

    // Fast path: the container is up — proxy immediately (proxyRes injects the
    // refresh cookie into the upstream response). A container's lifetime does
    // NOT depend on request activity; it runs until explicitly stopped, so this
    // only records the timestamp for the admin UI.
    //
    // "unhealthy" proxies too, deliberately. The health verdict exists for
    // OBSERVABILITY (admin → System Monitor), not as a traffic gate: gating on
    // it turns one failed probe — or a legitimate cold-start `next build` window
    // — into a total outage where every API call returns 503 "BOS instance not
    // ready" and the whole desktop appears broken. When base really is down the
    // Supervisor answers with its own diagnostic page and is already restarting
    // it, which is strictly more useful than a bastion-level 503.
    if (state?.status === "running" || state?.status === "unhealthy") {
      touchInstance(username);
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
  }

  // Headless, cookie-less requests carrying a parseable Basic-auth header are
  // routed by resolving the presented secret against every provisioned user's
  // credentials-index companion file — never by asking the identity provider
  // to resolve a username (FR-005/FR-006/FR-007). The Basic-auth *username*
  // is never used for anything, only the secret. On no match: 401 with
  // WWW-Authenticate, never a redirect to /login (spec.md User Story 3 AS2).
  function routeHeadlessCredential(secret: string, req: Request, res: Response, next: NextFunction): void {
    resolveCredential(secret, cfg.volumeBase)
      .then((resolved) => {
        if (!resolved) {
          res.setHeader("WWW-Authenticate", 'Basic realm="BrowserOS"');
          res.status(401).end();
          return;
        }
        // Rewrite so the target container's own authoritative service-secrets
        // check (unchanged — FR-007) sees a Bearer credential; Bastion itself
        // never authenticates the request, only routes it.
        req.headers.authorization = `Bearer ${secret}`;
        // Assert the verified scope claim — never "session": a per-service
        // secret is not a login, regardless of which service minted it. This
        // is what lets a container-side admin surface (mint/list/revoke a
        // secret) refuse ANY secret-scoped request outright, rather than
        // trusting "some valid credential got routed here" as equivalent to
        // "the container's owner is logged in."
        req.headers[AUTH_SCOPE_HEADER] = `secret:${resolved.service}`;
        routeToUser(resolved.username, req, res, next);
      })
      .catch((err: Error) => {
        console.error("[bastion] credential routing failed:", err.stack ?? err.message);
        res.setHeader("WWW-Authenticate", 'Basic realm="BrowserOS"');
        res.status(401).end();
      });
  }

  const middleware: RequestHandler = (req, res, next) => {
    stripClaimHeaders(req);
    const session = verifySession(req, cfg);
    if (!session) {
      const basicSecret = parseBasicAuthSecret(req);
      if (basicSecret) {
        routeHeadlessCredential(basicSecret, req, res, next);
        return;
      }

      // A genuinely credential-less request (no session, no Authorization
      // header at all) is not necessarily "a browser that isn't logged in
      // yet" — it's also exactly what RFC 7617's non-preemptive Basic auth
      // looks like on the wire: a compliant headless client (davfs2, curl,
      // any WebDAV/API consumer) deliberately withholds credentials on its
      // first request and only attaches them after being challenged with a
      // 401. Redirecting that first probe to /login is a 302 no such client
      // can follow, so it fails outright and never gets the chance to retry
      // with Basic auth attached — reproducing identically whether or not
      // the caller actually has valid credentials configured. Distinguish
      // the two cases the same way routeToUser already does for its own
      // "is this a browser" check: only a request that Accepts HTML is
      // treated as browser navigation and sent to /login; anything else gets
      // the same 401 + WWW-Authenticate challenge routeHeadlessCredential's
      // own "no match" branch already issues, so a compliant client retries
      // and reaches that branch above instead of dying here.
      const acceptsHtml = (req.headers.accept ?? "").includes("text/html");
      if (!acceptsHtml) {
        res.setHeader("WWW-Authenticate", 'Basic realm="BrowserOS"');
        res.status(401).end();
        return;
      }

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

    // A verified session — assert the "session" scope claim, plus "admin" if
    // SessionPayload.isAdmin is set (already a real, working claim inside
    // Bastion's own admin router, sessions.ts/routers/admin.ts — this is the
    // same claim, propagated one hop further for any container-side surface
    // that needs it later).
    req.headers[AUTH_SCOPE_HEADER] = "session";
    if (session.isAdmin) req.headers[AUTH_ROLE_HEADER] = "admin";

    routeToUser(session.username, req, res, next, refreshCookie);
  };

  return middleware;
}
