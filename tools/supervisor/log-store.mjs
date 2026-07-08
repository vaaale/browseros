// BrowserOS Supervisor log store — the SINGLE writer of the central log store.
//
// Self-contained (Node built-ins only): the Supervisor is the trusted kernel and
// is NOT self-modified, so this must never import from src/. (specs/017-central-logging)
//
// Layout under <root>/logs:
//   timeline-<YYYY-MM-DD>.jsonl   global, time-ordered (THE complete picture; day-rotated)
//   sessions/<sessionId>.jsonl    per-session view (all sources interleaved)
//   builds/<branch>-<ts>.log      build stdout/stderr blobs (referenced from records)
//
// Records are appended, in arrival order, to BOTH the day timeline and (when a
// session is known) the session file — by this one process — so a complete timeline
// is a single-file read with no merging. `stream`/`versionLabel` are record FIELDS
// used for filtering, never separate files. All writes are serialized through one
// queue so concurrent appends never interleave.

import { promises as fs, createWriteStream } from "node:fs";
import path from "node:path";

const LEVELS = ["debug", "info", "warn", "error"];
const STREAMS = ["frontend", "backend", "supervisor"];
const MAX_LINE_BYTES = 64 * 1024; // hard cap per JSONL line

function z(n) { return String(n).padStart(2, "0"); }
function dayStamp(d) { return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; }

export class LogStore {
  constructor(root, opts = {}) {
    this.dir = path.join(root, "logs");
    this.sessionsDir = path.join(this.dir, "sessions");
    this.buildsDir = path.join(this.dir, "builds");
    this.retentionDays = Number(opts.retentionDays) > 0 ? Number(opts.retentionDays) : 7;
    this.maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : 512 * 1024 * 1024;
    this._queue = Promise.resolve(); // serialize all appends (single writer => no interleave)
    this._ready = fs.mkdir(this.sessionsDir, { recursive: true })
      .then(() => fs.mkdir(this.buildsDir, { recursive: true }))
      .catch(() => {});
  }

  // Restrict a session id / branch to a safe single filename component.
  _safe(name) {
    return (String(name || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128)) || "_";
  }

  _dayFile(ts) {
    return path.join(this.dir, `timeline-${dayStamp(new Date(ts))}.jsonl`);
  }

  // Canonicalize an incoming (possibly untrusted) record. `defaults` fills fields the
  // emitter omitted (e.g. a session id from the request header).
  _normalize(rec, defaults) {
    const r = rec && typeof rec === "object" ? rec : {};
    const now = Date.now();
    const out = {
      ts: typeof r.ts === "number" && isFinite(r.ts) ? r.ts : now,
      rxts: now, // server receipt time — guards against emitter clock skew
      level: LEVELS.includes(r.level) ? r.level : "info",
      stream: STREAMS.includes(r.stream) ? r.stream : (defaults.stream || "backend"),
      component: String(r.component ?? defaults.component ?? "").slice(0, 200),
      msg: String(r.msg ?? "").slice(0, 8000),
    };
    const sessionId = r.sessionId ?? defaults.sessionId;
    if (sessionId) out.sessionId = String(sessionId).slice(0, 200);
    const versionLabel = r.versionLabel ?? defaults.versionLabel;
    if (versionLabel) out.versionLabel = String(versionLabel).slice(0, 40);
    if (r.branch) out.branch = String(r.branch).slice(0, 200);
    if (r.buildLog) out.buildLog = String(r.buildLog).slice(0, 300);
    if (r.data !== undefined) out.data = r.data;
    if (r.err) {
      out.err = {
        message: String(r.err.message ?? r.err).slice(0, 4000),
        ...(r.err.stack ? { stack: String(r.err.stack).slice(0, 8000) } : {}),
      };
    }
    return out;
  }

  _enqueue(fn) {
    this._queue = this._queue.then(fn).catch(() => {});
    return this._queue;
  }

  // Append one record. Never throws (the kernel must not crash on a logging error).
  write(rec, defaults = {}) {
    const out = this._normalize(rec, defaults || {});
    let line;
    try { line = JSON.stringify(out); }
    catch { line = JSON.stringify({ ts: out.ts, rxts: out.rxts, level: "warn", stream: out.stream, component: out.component, msg: "[unserializable log record]" }); }
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) line = line.slice(0, MAX_LINE_BYTES);
    line += "\n";
    return this._enqueue(async () => {
      await this._ready;
      await fs.appendFile(this._dayFile(out.ts), line);
      if (out.sessionId) await fs.appendFile(path.join(this.sessionsDir, this._safe(out.sessionId) + ".jsonl"), line);
    });
  }

  writeBatch(records, defaults = {}) {
    if (!Array.isArray(records)) return Promise.resolve();
    let last = Promise.resolve();
    for (const r of records.slice(0, 2000)) last = this.write(r, defaults);
    return last;
  }

  // Open a build-log blob + an append stream to receive its stdout/stderr.
  // `relPath` is what callers store in a record's `buildLog` field.
  openBuildLog(branch) {
    const name = `${this._safe(branch)}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
    const file = path.join(this.buildsDir, name);
    return { file, relPath: path.posix.join("builds", name), stream: createWriteStream(file, { flags: "a" }) };
  }

  // Read a time-ordered slice. With `session`, reads that session's file; otherwise
  // the recent day timelines. Filters: stream, level (minimum), since (ms), limit.
  async query({ session, stream, level, since, limit } = {}) {
    await this._ready;
    const cap = Number(limit) > 0 ? Number(limit) : 1000;
    const minLevel = LEVELS.indexOf(level);
    let files;
    if (session) {
      files = [path.join(this.sessionsDir, this._safe(session) + ".jsonl")];
    } else {
      const entries = await fs.readdir(this.dir).catch(() => []);
      files = entries.filter((f) => f.startsWith("timeline-") && f.endsWith(".jsonl")).sort().slice(-7).map((f) => path.join(this.dir, f));
    }
    const out = [];
    for (const f of files) {
      let content;
      try { content = await fs.readFile(f, "utf8"); } catch { continue; }
      for (const ln of content.split("\n")) {
        if (!ln) continue;
        let rec;
        try { rec = JSON.parse(ln); } catch { continue; }
        if (stream && rec.stream !== stream) continue;
        if (minLevel > 0 && LEVELS.indexOf(rec.level) < minLevel) continue;
        if (since && rec.ts < since) continue;
        out.push(rec);
      }
    }
    out.sort((a, b) => (a.ts - b.ts) || (a.rxts - b.rxts));
    return out.slice(-cap);
  }

  async listSessions(limit = 200) {
    await this._ready;
    const entries = await fs.readdir(this.sessionsDir, { withFileTypes: true }).catch(() => []);
    const sessions = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
      const st = await fs.stat(path.join(this.sessionsDir, e.name)).catch(() => null);
      if (st) sessions.push({ id: e.name.replace(/\.jsonl$/, ""), size: st.size, mtime: st.mtimeMs });
    }
    sessions.sort((a, b) => b.mtime - a.mtime);
    return sessions.slice(0, limit);
  }

  // Prune by age then total size. Never removes a file that is currently being
  // written (today's timeline, or anything touched in the last 10 minutes).
  async prune() {
    await this._ready;
    const now = Date.now();
    const ageCutoff = now - this.retentionDays * 86_400_000;
    const activeCutoff = now - 10 * 60_000;
    const todayTimeline = `timeline-${dayStamp(new Date(now))}.jsonl`;
    const dirs = [this.dir, this.sessionsDir, this.buildsDir];
    const all = [];
    for (const d of dirs) {
      const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (!e.isFile()) continue;
        if (d === this.dir && e.name === todayTimeline) continue;
        const full = path.join(d, e.name);
        const st = await fs.stat(full).catch(() => null);
        if (!st) continue;
        if (st.mtimeMs >= activeCutoff) continue; // skip likely-active files
        all.push({ full, mtimeMs: st.mtimeMs, size: st.size });
      }
    }
    // Age prune.
    let survivors = [];
    for (const f of all) {
      if (f.mtimeMs < ageCutoff) await fs.rm(f.full, { force: true }).catch(() => {});
      else survivors.push(f);
    }
    // Size prune (oldest first) until under the cap.
    let total = survivors.reduce((s, f) => s + f.size, 0);
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of survivors) {
      if (total <= this.maxBytes) break;
      await fs.rm(f.full, { force: true }).catch(() => {});
      total -= f.size;
    }
  }
}
