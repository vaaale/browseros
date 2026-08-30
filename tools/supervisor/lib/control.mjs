import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PIN_COOKIE } from "./config.mjs";
import { requireFeatureBranch } from "./gitutil.mjs";
import { state, previews, baseSupervision } from "./state.mjs";
import { getLogStore, getLogHealth, log, slog } from "./log.mjs";
import { probeOnce } from "./proc.mjs";
import {
  liveBranch,
  listBranches,
  previewChanges,
  beginPreview,
  buildPreview,
  activate,
  discardPreview,
  stopPreview,
  resumePreview,
  provisionPreview,
} from "./preview.mjs";
import { promote } from "./promote.mjs";
import { pushNow } from "./push.mjs";

async function publicState() {
  const pick = async (v) =>
    v ? { role: v.role, branch: await liveBranch(v), port: v.port, state: v.state, commit: v.commit, reused: !!v.reused, ...(v.buildError ? { buildError: v.buildError } : {}), ...(v.buildLog ? { buildLog: v.buildLog } : {}), ...(v.devopsConversationId ? { devopsConversationId: v.devopsConversationId } : {}), ...(v.conflictSessionId ? { conflictSessionId: v.conflictSessionId } : {}) } : null;
  const b = await pick(state.base);
  const ps = await Promise.all([...previews.values()].map(pick));
  return { base: b, previews: ps, pushMode: process.env.BOS_PUSH_MODE || "manual", baseBranch: state.baseBranch };
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Resolve which running version serves this request. The pin cookie holds a
// branch name; it is only honored while that preview is "ready" (a
// still-building or stopped preview falls back to base, never a 502).
export function pinnedVersion(req) {
  const pin = parseCookies(req)[PIN_COOKIE];
  if (!pin || pin === "base") return state.base;
  const p = previews.get(pin);
  if (p && p.state === "ready") return p;
  return state.base;
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

// Like readBody but caps the payload (log ingestion is the only large body we accept).
function readBodyCapped(req, maxBytes) {
  return new Promise((resolve) => {
    let b = "";
    let over = false;
    req.on("data", (c) => { if (over) return; b += c; if (b.length > maxBytes) { over = true; b = ""; } });
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

function sendJson(res, obj, status = 200, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(body);
}

export function proxyTo(port, req, res, overridePath) {
  const up = http.request(
    { hostname: "127.0.0.1", port, path: overridePath ?? req.url, method: req.method, headers: req.headers },
    (upRes) => { res.writeHead(upRes.statusCode || 502, upRes.headers); upRes.pipe(res); },
  );
  up.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/html" });
    res.end(
      `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;background:#0f1117;color:#e8eaf0;padding:40px;line-height:1.6">` +
        `<h2>This BrowserOS version isn't responding</h2>` +
        `<p>The Supervisor could not reach the upstream on port ${port}: <code>${e.message}</code>.</p>` +
        `<p>In <b>reuse</b> mode base proxies to an existing server — make sure <code>npm run dev</code> is running on that port. ` +
        `Or use <b>full</b> mode (omit <code>BOS_ACTIVE_REUSE_PORT</code>) so the Supervisor builds and serves it.</p>` +
        `<p>Control surface: <a href="/__supervisor" style="color:#a9c4ff">/__supervisor</a></p></body>`,
    );
  });
  req.pipe(up);
}

// Shared upgrade-forwarding: relay a WebSocket handshake + the two-way pipe
// to an upstream on 127.0.0.1:<port>. Used both for the pinned version's own
// socket (HMR) and for a service's own socket (proxyServiceUpgrade below).
export function forwardUpgrade(port, req, clientSocket, head) {
  const up = http.request({ hostname: "127.0.0.1", port, path: req.url, method: req.method, headers: req.headers });
  up.on("upgrade", (upRes, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || "Switching Protocols"}`];
    for (const [k, v] of Object.entries(upRes.headers)) {
      for (const vv of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${vv}`);
    }
    clientSocket.write(lines.join("\r\n") + "\r\n\r\n");
    if (upHead?.length) clientSocket.write(upHead);
    if (head?.length) upSocket.write(head);
    upSocket.pipe(clientSocket);
    clientSocket.pipe(upSocket);
    const close = () => { upSocket.destroy(); clientSocket.destroy(); };
    upSocket.on("error", close);
    clientSocket.on("error", close);
    upSocket.on("close", () => clientSocket.destroy());
    clientSocket.on("close", () => upSocket.destroy());
  });
  up.on("error", (e) => {
    log(`ws upgrade to 127.0.0.1:${port}${req.url} failed: ${e.code || e.message}`);
    clientSocket.destroy();
  });
  up.end();
}

// Proxy a service's own traffic — WebSocket upgrade or plain HTTP — through
// the Supervisor's already-exposed, already-TLS-terminated PUBLIC_PORT.
// user-specs/002-service-daemons services bind their own internal port,
// which isn't reachable directly once BOS is deployed behind a reverse
// proxy (only PUBLIC_PORT is exposed/TLS-terminated there). Resolves the
// actual bound port from the pinned version's own
// dataDir()/system/config/<id>/runtime.json (written by ServiceManager.ts
// after the service's `bound` IPC message) — same per-version routing as
// the HMR case, so a preview's own services are reached, not always base's.
//
// The "system" segment is load-bearing: a service's live config is
// BOS-owned state under <dataDir>/system/config/<id>/, NOT
// <dataDir>/config/<id>/ (which holds unrelated top-level JSON:
// plugins.json, marketplaces.json, …).
async function resolveServicePort(req, serviceId, kind) {
  const v = pinnedVersion(req);
  if (!v) {
    log(`service ${kind} ${serviceId}: no version resolved for this request`);
    return null;
  }
  const runtimePath = path.join(v.dataDir, "system", "config", serviceId, "runtime.json");
  let port;
  try {
    const raw = await fs.readFile(runtimePath, "utf8");
    port = JSON.parse(raw).port;
  } catch (e) {
    log(`service ${kind} ${serviceId}: cannot read ${runtimePath} (${e.code || e.message}); is the service running?`);
    return null;
  }
  if (typeof port !== "number") {
    log(`service ${kind} ${serviceId}: ${runtimePath} has no numeric port (got ${JSON.stringify(port)})`);
    return null;
  }
  return port;
}

// WS case: only reachable mid-upgrade, where there is no response object to
// carry an error code — a silent destroy() here is indistinguishable from a
// hung network, so resolveServicePort's log is the only diagnostic.
export async function proxyServiceUpgrade(serviceId, req, clientSocket, head) {
  const port = await resolveServicePort(req, serviceId, "ws");
  if (port == null) return clientSocket.destroy();
  forwardUpgrade(port, req, clientSocket, head);
}

// Plain-HTTP case: the non-upgrade counterpart, and what makes a service's
// own protocol reachable through the Supervisor even when that protocol
// isn't a WebSocket and isn't expressible as a Next.js route handler at all
// (e.g. WebDAV's PROPFIND/MKCOL/COPY/MOVE). `subPath` is the request path
// with the `/__supervisor/services/<id>` prefix already stripped (plus the
// original query string).
export async function proxyServiceHttp(serviceId, subPath, req, res) {
  const port = await resolveServicePort(req, serviceId, "http");
  if (port == null) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end(`Service "${serviceId}" is not running or not installed.`);
    return;
  }
  proxyTo(port, req, res, subPath);
}

export async function handleControl(req, res, sub) {
  const sessionId = typeof req.headers["x-bos-session"] === "string" ? req.headers["x-bos-session"] : undefined;

  // --- central log store: ingestion (frontend + backend ship here) + reads (viewer) ---
  if (sub === "logs" && req.method === "POST") {
    const payload = await readBodyCapped(req, 2 * 1024 * 1024);
    const records = payload && Array.isArray(payload.records) ? payload.records : (Array.isArray(payload) ? payload : []);
    await getLogStore().writeBatch(records, { stream: "frontend", ...(sessionId ? { sessionId } : {}) });
    return sendJson(res, { ok: true, n: Array.isArray(records) ? records.length : 0 });
  }
  if (sub === "logs" && req.method === "GET") {
    const q = new URL(req.url, "http://localhost").searchParams;
    if (q.get("sessions") === "1") return sendJson(res, { ok: true, sessions: await getLogStore().listSessions() });
    const records = await getLogStore().query({
      session: q.get("session") || undefined,
      stream: q.get("stream") || undefined,
      level: q.get("level") || undefined,
      since: q.get("since") ? Number(q.get("since")) : undefined,
      limit: q.get("limit") ? Number(q.get("limit")) : undefined,
    });
    return sendJson(res, { ok: true, records });
  }
  // --- real health, for the bastion's System Monitor -------------------------
  // "Container is running" says nothing about whether BOS is serving: the
  // Supervisor is PID 1, so it stays up when the base server dies. This
  // reports the truth — a live PROBE of base plus the supervision counters
  // (and this refactor's own log-health counters) — so the bastion can
  // distinguish "up" from "actually working".
  if (req.method === "GET" && sub === "health") {
    const proc = state.base?.proc ?? null;
    const procAlive = !!proc && proc.exitCode === null && !proc.signalCode;
    const serving = state.base ? await probeOnce(state.base.port) : false;
    const mem = process.memoryUsage();
    return sendJson(res, {
      ok: serving,
      serving,
      base: state.base
        ? {
            state: state.base.state,
            port: state.base.port,
            branch: state.base.branch ?? null,
            commit: state.base.commit ?? null,
            dev: !!state.base.dev,
            reused: !!state.base.reused,
            owned: !state.base.reused,
            pid: proc?.pid ?? null,
            procAlive,
            buildError: state.base.buildError || null,
          }
        : null,
      supervision: { ...baseSupervision },
      logHealth: getLogHealth(),
      previews: [...previews.values()].map((p) => ({ branch: p.branch, port: p.port, state: p.state, procAlive: !!p.proc && p.proc.exitCode === null })),
      supervisor: {
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
      },
      baseBranch: state.baseBranch,
    });
  }
  if (req.method === "GET" && (sub === "" || sub === "state" || sub === "branches" || sub === "preview-changes" || sub === "next-changes")) {
    if (sub === "") { res.writeHead(200, { "Content-Type": "text/html" }); res.end(controlPage()); return; }
    if (sub === "branches") return sendJson(res, { ok: true, branches: await listBranches(), base: state.baseBranch });
    if (sub === "preview-changes" || sub === "next-changes") {
      const branch = new URL(req.url, "http://localhost").searchParams.get("branch") || undefined;
      return sendJson(res, await previewChanges(branch));
    }
    // state — include which version THIS session is being served (the pin
    // cookie), so the toolbar can tell "you're viewing the preview" from "a
    // preview exists but you're still on base".
    const st = await publicState();
    const sv = pinnedVersion(req);
    return sendJson(res, { ...st, serving: sv ? { role: sv.role, branch: await liveBranch(sv) } : null });
  }
  const body = await readBody(req);
  slog("info", `control:${sub}`, `${sub} requested`, { ...(sessionId ? { sessionId } : {}), ...(body && Object.keys(body).length ? { data: body } : {}) });
  const clearPin = { "Set-Cookie": `${PIN_COOKIE}=; Path=/; Max-Age=0` };
  try {
    if (sub === "pin" && req.method === "POST") {
      const v = String(body.version || "base");
      const branch = String(body.branch || "");
      if (v === "base") return sendJson(res, { ok: true, pinned: "base" }, 200, clearPin);
      if (branch) {
        requireFeatureBranch(branch, state.baseBranch);
        const p = previews.get(branch);
        if (p && p.state === "ready") {
          return sendJson(res, { ok: true, pinned: branch }, 200, { "Set-Cookie": `${PIN_COOKIE}=${encodeURIComponent(branch)}; Path=/; HttpOnly` });
        }
        // If the preview is stopped, resume its server (no rebuild) then pin.
        if (p && p.state === "stopped") {
          await resumePreview(branch);
          if (p.state === "ready") {
            return sendJson(res, { ok: true, pinned: branch }, 200, { "Set-Cookie": `${PIN_COOKIE}=${encodeURIComponent(branch)}; Path=/; HttpOnly` });
          }
          return sendJson(res, { ok: false, error: `preview resume failed (state: ${p.state})` }, 400);
        }
        return sendJson(res, { ok: false, error: `preview for "${branch}" is not ready (state: ${p?.state || "absent"})` }, 400);
      }
      return sendJson(res, { ok: false, error: `branch required to pin` }, 400);
    }
    if (sub === "begin" && req.method === "POST") {
      const branch = String(body.branch || "");
      if (!branch) return sendJson(res, { ok: false, error: "branch required" }, 400);
      const v = await beginPreview(branch);
      // `dataDir` (the preview's data clone) is where the branch-coupled
      // user-apps worktree is mounted (coupled-repos.mjs's coupledReposFor).
      // BOS needs it to resolve an ITEM-owned spec store on this branch —
      // `<dataDir>/user-apps/items/<id>/spec` — which lives in a different
      // repo from the `<worktree>/specs/<store>` mounts and so can't be
      // derived from `worktree`.
      return sendJson(res, { ok: true, branch: v.branch, worktree: v.worktree, dataDir: v.dataDir, ...(v.mountErrors ? { mountErrors: v.mountErrors } : {}) });
    }
    if (sub === "build" && req.method === "POST") {
      const branch = String(body.branch || "");
      if (!branch) return sendJson(res, { ok: false, error: "branch required" }, 400);
      const p = previews.get(branch) || (await provisionPreview(branch));
      const st = await buildPreview(branch, { sessionId });
      return sendJson(res, { ok: st === "ready", state: st, ...(p.buildError ? { error: p.buildError } : {}), ...(p.buildLog ? { buildLog: p.buildLog } : {}) });
    }
    if (sub === "activate" && req.method === "POST") {
      const branch = String(body.branch || "");
      const result = await activate(branch, { sessionId });
      const cookie = !branch || branch === state.baseBranch ? clearPin : {};
      return sendJson(res, { ok: true, ...result }, 200, cookie);
    }
    if (sub === "promote" && req.method === "POST") {
      const branch = String(body.branch || "");
      if (!branch) return sendJson(res, { ok: false, error: "branch required" }, 400);
      return sendJson(res, { ok: true, ...(await promote(branch)) }, 200, clearPin);
    }
    // stop = stop the preview server but KEEP worktree + branch (can resume
    // via /pin). Order matters: clear the pin (→ switch to base) BEFORE
    // killing the preview process, so the user is never routed to a dead
    // port. The response (with clearPin) is sent immediately; stopPreview
    // runs in the background.
    if (sub === "stop" && req.method === "POST") {
      const branch = String(body.branch || "");
      if (!branch) return sendJson(res, { ok: false, error: "branch required" }, 400);
      sendJson(res, { ok: true }, 200, clearPin);
      void stopPreview(branch).catch((e) => slog("error", "control:stop", `background stop failed: ${String(e?.message || e)}`, { ...(sessionId ? { sessionId } : {}) }));
      return;
    }
    // discard = destroy everything including the feature branch.
    if (sub === "discard" && req.method === "POST") {
      const branch = String(body.branch || "");
      if (!branch) return sendJson(res, { ok: false, error: "branch required" }, 400);
      const { warnings } = await discardPreview(branch);
      return sendJson(res, { ok: true, ...(warnings.length ? { warnings } : {}) }, 200, clearPin);
    }
    if (sub === "push" && req.method === "POST") return sendJson(res, { ok: true, ...(await pushNow()) });
  } catch (e) {
    const msg = String(e.message || e);
    slog("error", `control:${sub}`, `${sub} failed: ${msg}`, { ...(sessionId ? { sessionId } : {}), err: { message: msg } });
    return sendJson(res, { ok: false, error: msg }, 500);
  }
  return sendJson(res, { ok: false, error: "unknown control endpoint" }, 404);
}

function controlPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>BrowserOS Supervisor</title>
<style>body{font:14px system-ui;background:#0f1117;color:#e8eaf0;margin:0;padding:24px}h1{font-size:16px}
button{font:13px system-ui;margin:2px;padding:6px 10px;border:1px solid #2a2d36;background:#1b1e27;color:#e8eaf0;border-radius:6px;cursor:pointer}
button:hover{background:#262a35}pre{background:#0b0d12;border:1px solid #2a2d36;border-radius:8px;padding:12px;overflow:auto}
.row{margin:8px 0}</style></head><body>
<h1>BrowserOS Supervisor</h1>
<p>Version-independent control surface. Always reachable even if a BOS version's UI is broken.</p>
<div class="row">
  <button onclick="branchAct('pin',{version:'preview'})">Preview branch</button>
  <button onclick="act('pin',{version:'base'})">Back to base</button>
</div>
<div class="row">
  <button onclick="branchAct('activate')">Build/start branch</button>
  <button onclick="branchAct('build')">Retry build</button>
  <button onclick="branchAct('promote')">Promote</button>
  <button onclick="branchAct('stop')">Stop (keep branch)</button>
  <button onclick="branchAct('discard')">Discard (delete branch)</button>
  <button onclick="act('push')">Push to remote</button>
  <button onclick="refresh()">Refresh</button>
</div>
<pre id="state">loading…</pre>
<script>
async function refresh(){const r=await fetch('/__supervisor/state');document.getElementById('state').textContent=JSON.stringify(await r.json(),null,2);}
async function act(p,b){const r=await fetch('/__supervisor/'+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})});const j=await r.json();if(j.pinned!==undefined){location.href='/';return;}alert(JSON.stringify(j));refresh();}
function branchAct(p,b){const branch=prompt('Feature branch (bos/<kebab-name>)');if(!branch)return;act(p,Object.assign({},b||{},{branch}));}
refresh();
</script></body></html>`;
}
