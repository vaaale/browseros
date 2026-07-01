"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Save } from "lucide-react";

// Logs viewer (specs/017-central-logging). Reads the central timeline via /api/logs
// (which, under the Supervisor, proxies to the single sink). The complete picture is
// one time-ordered stream; pick a session to narrow to its timeline, and filter by
// stream/level — all over ONE model (no file merging).

interface LogRec {
  ts: number;
  level: string;
  stream: string;
  component?: string;
  conversation?: string;
  msg: string;
  sessionId?: string;
  versionLabel?: string;
  branch?: string;
  data?: unknown;
  err?: { message: string; stack?: string };
  buildLog?: string;
}
interface SessionSummary {
  id: string;
  mtime: number;
}
interface Settings {
  level: string;
  retentionDays: number;
  maxSizeMb: number;
  frontendCapture: boolean;
  logPayload: boolean;
}

const LEVELS = ["debug", "info", "warn", "error"];
const LEVEL_COLOR: Record<string, string> = {
  debug: "text-white/40",
  info: "text-sky-300/80",
  warn: "text-amber-300/90",
  error: "text-red-300/90",
};
const STREAM_COLOR: Record<string, string> = {
  frontend: "bg-violet-500/20 text-violet-100",
  backend: "bg-emerald-500/20 text-emerald-100",
  supervisor: "bg-amber-500/20 text-amber-100",
};

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const z = (n: number) => String(n).padStart(2, "0");
  return `${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

export function LogsTab() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [session, setSession] = useState<string>(""); // "" = whole-system timeline
  const [stream, setStream] = useState<string>("");
  const [level, setLevel] = useState<string>("");
  const [component, setComponent] = useState<string>("");
  const [conversation, setConversation] = useState<string>("");
  const [records, setRecords] = useState<LogRec[]>([]);
  const [loading, setLoading] = useState(false);
  const [auto, setAuto] = useState(true);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [savedAt, setSavedAt] = useState(false);

  const loadSessions = useCallback(async () => {
    try {
      const r = await fetch("/api/logs?sessions=1").then((res) => res.json());
      setSessions(Array.isArray(r.sessions) ? r.sessions : []);
    } catch {
      /* ignore */
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (session) qs.set("session", session);
      if (stream) qs.set("stream", stream);
      if (level) qs.set("level", level);
      if (component.trim()) qs.set("component", component.trim());
      if (conversation.trim()) qs.set("conversation", conversation.trim());
      qs.set("limit", "500");
      const r = await fetch(`/api/logs?${qs.toString()}`).then((res) => res.json());
      setRecords(Array.isArray(r.records) ? r.records : []);
    } catch {
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }, [session, stream, level, component, conversation]);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d) => {
        const s = (d.schemas ?? []).find((x: { namespace: string }) => x.namespace === "logging");
        const v = (s?.values ?? {}) as Partial<Settings>;
        setSettings({
          level: v.level || "info",
          retentionDays: typeof v.retentionDays === "number" ? v.retentionDays : 7,
          maxSizeMb: typeof v.maxSizeMb === "number" ? v.maxSizeMb : 512,
          frontendCapture: v.frontendCapture !== false,
          logPayload: v.logPayload === true,
        });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadSessions();
  }, [loadSessions]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => {
      void load();
      void loadSessions();
    }, 4000);
    return () => clearInterval(id);
  }, [auto, load, loadSessions]);

  const saveSettings = async () => {
    if (!settings) return;
    await fetch("/api/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namespace: "logging", values: settings }),
    });
    setSavedAt(true);
    setTimeout(() => setSavedAt(false), 1500);
  };

  const selectClass = "rounded border border-white/10 bg-black/30 px-2 py-1 text-xs outline-none focus:border-white/30";

  return (
    <div className="flex h-full flex-col gap-3 text-xs">
      <p className="text-white/50">
        One time-ordered <b>timeline</b> of everything BrowserOS did, collected by the Supervisor. View the whole system or a single
        browser session; <code>frontend</code>/<code>backend</code>/<code>supervisor</code> are filters, not separate logs.
      </p>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <select value={session} onChange={(e) => setSession(e.target.value)} className={`${selectClass} max-w-[260px]`} title="Session">
          <option value="">Whole system (timeline)</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id} · {new Date(s.mtime).toLocaleTimeString()}
            </option>
          ))}
        </select>
        <select value={stream} onChange={(e) => setStream(e.target.value)} className={selectClass} title="Stream">
          <option value="">all streams</option>
          <option value="frontend">frontend</option>
          <option value="backend">backend</option>
          <option value="supervisor">supervisor</option>
        </select>
        <select value={level} onChange={(e) => setLevel(e.target.value)} className={selectClass} title="Minimum level">
          <option value="">all levels</option>
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}+
            </option>
          ))}
        </select>
        <input
          value={component}
          onChange={(e) => setComponent(e.target.value)}
          placeholder="component contains…"
          className={`${selectClass} w-36`}
          title="Component filter"
        />
        <input
          value={conversation}
          onChange={(e) => setConversation(e.target.value)}
          placeholder="conversation contains…"
          className={`${selectClass} w-40`}
          title="Conversation filter"
        />
        <button onClick={() => void load()} className="flex items-center gap-1 rounded bg-white/10 px-2 py-1 hover:bg-white/20">
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Refresh
        </button>
        <label className="flex items-center gap-1 text-white/60">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> auto
        </label>
        <span className="text-white/30">{records.length} record(s)</span>
      </div>

      {/* Timeline */}
      <div className="min-h-0 flex-1 overflow-auto rounded border border-white/10 bg-black/30 font-mono">
        {records.length === 0 ? (
          <p className="p-3 text-white/40">No records.</p>
        ) : (
          records.map((r, i) => (
            <details key={i} className="border-b border-white/5 px-2 py-1 open:bg-white/[0.03]">
              <summary className="flex cursor-pointer items-center gap-2 whitespace-nowrap">
                <span className="text-white/35">{fmtTime(r.ts)}</span>
                <span className={`w-10 shrink-0 uppercase ${LEVEL_COLOR[r.level] ?? "text-white/60"}`}>{r.level}</span>
                <span className={`shrink-0 rounded px-1 ${STREAM_COLOR[r.stream] ?? "bg-white/10 text-white/70"}`}>{r.stream}</span>
                {r.versionLabel && <span className="shrink-0 text-white/35">{r.versionLabel}</span>}
                <span className="shrink-0 text-white/45">{r.component}</span>
                {r.conversation && <span className="shrink-0 text-white/35">{r.conversation}</span>}
                <span className="truncate text-white/85">{r.msg}</span>
              </summary>
              <div className="mt-1 space-y-1 whitespace-pre-wrap break-words pl-4 text-white/60">
                {r.sessionId && <div className="text-white/35">session: {r.sessionId}</div>}
                {r.conversation && <div className="text-white/35">conversation: {r.conversation}</div>}
                {r.branch && <div className="text-white/35">branch: {r.branch}</div>}
                {r.err && <div className="text-red-300/80">{r.err.message}{r.err.stack ? `\n${r.err.stack}` : ""}</div>}
                {r.data !== undefined && <div>{safeJson(r.data)}</div>}
                {r.buildLog && <div className="text-amber-200/70">build log: {r.buildLog}</div>}
              </div>
            </details>
          ))
        )}
      </div>

      {/* Settings */}
      {settings && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-white/10 bg-white/[0.02] p-2">
          <span className="text-white/40">Settings:</span>
          <label className="flex items-center gap-1 text-white/60">
            level
            <select value={settings.level} onChange={(e) => setSettings({ ...settings, level: e.target.value })} className={selectClass}>
              {LEVELS.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1 text-white/60">
            retention (days)
            <input type="number" value={settings.retentionDays} onChange={(e) => setSettings({ ...settings, retentionDays: Number(e.target.value) })} className={`${selectClass} w-16`} />
          </label>
          <label className="flex items-center gap-1 text-white/60">
            max MB
            <input type="number" value={settings.maxSizeMb} onChange={(e) => setSettings({ ...settings, maxSizeMb: Number(e.target.value) })} className={`${selectClass} w-20`} />
          </label>
          <label className="flex items-center gap-1 text-white/60">
            <input type="checkbox" checked={settings.frontendCapture} onChange={(e) => setSettings({ ...settings, frontendCapture: e.target.checked })} /> capture frontend
          </label>
          <label className="flex items-center gap-1 text-white/60" title="Include full chat/tool payloads in conversation logs.">
            <input type="checkbox" checked={settings.logPayload} onChange={(e) => setSettings({ ...settings, logPayload: e.target.checked })} /> log payload
          </label>
          <button onClick={saveSettings} className="flex items-center gap-1 rounded bg-white/10 px-2 py-1 hover:bg-white/20">
            <Save size={12} /> {savedAt ? "Saved" : "Save"}
          </button>
        </div>
      )}
    </div>
  );
}

function safeJson(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
