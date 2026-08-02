import { useEffect, useRef, useState } from "react";
import { Button } from "../components/Button";

// ── Types (mirror GET /admin/monitor) ────────────────────────────────────────

interface LastExit {
  code: number | null; signal: string | null; at: number;
  expected: boolean; oomSuspected: boolean;
}

interface SupervisorHealth {
  ok: boolean;
  serving: boolean;
  base: {
    state: string; port: number; branch: string | null; commit: string | null;
    dev: boolean; reused: boolean; owned: boolean;
    pid: number | null; procAlive: boolean; buildError: string | null;
  } | null;
  supervision: {
    restarts: number; consecutiveFailures: number; givenUp: boolean;
    lastRestartAt: number | null; lastExit: LastExit | null;
  };
  previews: Array<{ branch: string; port: number; state: string; procAlive: boolean }>;
  supervisor: { pid: number; uptimeSeconds: number; rssBytes: number; heapUsedBytes: number };
  baseBranch: string;
}

interface MonitorInstance {
  username: string;
  status: string;
  lastActive: number;
  healthCheckedAt: number | null;
  error: string | null;
  container: {
    id: string; status: string; running: boolean; health: string;
    startedAt: string | null; finishedAt: string | null;
    exitCode: number | null; oomKilled: boolean; restartCount: number;
    memoryLimitBytes: number | null;
  } | null;
  usage: { memUsageBytes: number | null; memLimitBytes: number | null; cpuPercent: number | null };
  cgroup: { oomKill: number | null; oom: number | null; peakBytes: number | null; maxBytes: string | null };
  health: SupervisorHealth | null;
}

interface MonitorData {
  now: number;
  host: {
    memTotalBytes: number | null; ncpu: number | null; dockerVersion: string | null;
    containersRunning: number | null; containersStopped: number | null;
  };
  bastion: {
    pid: number; uptimeSeconds: number; rssBytes: number; heapUsedBytes: number;
    bosImage: string; maxConcurrentInstances: number;
  };
  instances: MonitorInstance[];
}

// ── Formatting ───────────────────────────────────────────────────────────────

function gb(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function duration(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function ago(ts: number | null | undefined, now: number): string {
  if (!ts) return "—";
  return `${duration(Math.round((now - ts) / 1000))} ago`;
}

function sinceIso(iso: string | null, now: number): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return duration(Math.round((now - t) / 1000));
}

const s = {
  card:   { background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, padding: 20, marginBottom: 16 },
  title:  { fontSize: 13, fontWeight: 600, color: "#ccc", marginBottom: 12 },
  grid:   { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 },
  metric: { background: "#141414", border: "1px solid #262626", borderRadius: 6, padding: "10px 12px" },
  mLabel: { fontSize: 10, color: "#777", textTransform: "uppercase" as const, letterSpacing: 0.4 },
  mValue: { fontSize: 16, color: "#eee", marginTop: 2, fontVariantNumeric: "tabular-nums" as const },
  row:    { display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: 12, borderBottom: "1px solid #1f1f1f" },
  key:    { color: "#777" },
  val:    { color: "#ccc", fontVariantNumeric: "tabular-nums" as const },
  warn:   { background: "#3a2a12", border: "1px solid #7c5310", color: "#f6c667", borderRadius: 6, padding: "8px 12px", fontSize: 12, marginBottom: 10 },
  bad:    { background: "#3a1618", border: "1px solid #7f1d1d", color: "#fca5a5", borderRadius: 6, padding: "8px 12px", fontSize: 12, marginBottom: 10 },
};

function verdict(inst: MonitorInstance): { label: string; color: string } {
  if (!inst.container) return { label: "no container", color: "#777" };
  if (!inst.container.running) return { label: `stopped (exit ${inst.container.exitCode ?? "?"})`, color: "#888" };
  if (inst.health?.serving) return { label: "serving", color: "#4ade80" };
  return { label: "UP BUT NOT SERVING", color: "#f87171" };
}

export default function Monitor() {
  const [data, setData] = useState<MonitorData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [auto, setAuto] = useState(true);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/admin/monitor");
      if (!res.ok) { setError(`Failed to load monitor (${res.status})`); return; }
      setData(await res.json() as MonitorData);
      setError("");
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  // Fetch once on mount. The set-state-in-effect rule fires on any helper that
  // transitively calls setState; a mount-time fetch of external state is exactly
  // the case the rule's own docs allow.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, []);

  useEffect(() => {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
    if (auto) timer.current = setInterval(() => { void load(); }, 15_000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [auto]);

  if (error) return <div style={s.card}><div style={s.bad}>{error}</div><Button size="sm" onClick={() => void load()}>Retry</Button></div>;
  if (!data) return <div style={s.card}><span style={{ color: "#777", fontSize: 13 }}>Loading…</span></div>;

  const { host, bastion, instances, now } = data;
  const totalUsed = instances.reduce((sum, i) => sum + (i.usage.memUsageBytes ?? 0), 0);
  const hostPct = host.memTotalBytes ? Math.round((totalUsed / host.memTotalBytes) * 100) : null;

  return (
    <>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 12, alignItems: "center" }}>
        <label style={{ fontSize: 12, color: "#777", display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          Auto-refresh (15s)
        </label>
        <Button size="sm" variant="secondary" onClick={() => void load()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {/* ── Host ──────────────────────────────────────────────────────────── */}
      <div style={s.card}>
        <div style={s.title}>Host</div>
        <div style={s.grid}>
          <div style={s.metric}><div style={s.mLabel}>Total memory</div><div style={s.mValue}>{gb(host.memTotalBytes)}</div></div>
          <div style={s.metric}>
            <div style={s.mLabel}>Used by BOS containers</div>
            <div style={{ ...s.mValue, color: hostPct != null && hostPct > 80 ? "#f87171" : "#eee" }}>
              {gb(totalUsed)}{hostPct != null ? ` (${hostPct}%)` : ""}
            </div>
          </div>
          <div style={s.metric}><div style={s.mLabel}>CPUs</div><div style={s.mValue}>{host.ncpu ?? "—"}</div></div>
          <div style={s.metric}><div style={s.mLabel}>Containers</div><div style={s.mValue}>{host.containersRunning ?? "—"} up / {host.containersStopped ?? "—"} down</div></div>
          <div style={s.metric}><div style={s.mLabel}>Docker</div><div style={s.mValue}>{host.dockerVersion ?? "—"}</div></div>
        </div>
      </div>

      {/* ── Bastion ───────────────────────────────────────────────────────── */}
      <div style={s.card}>
        <div style={s.title}>Bastion</div>
        <div style={s.grid}>
          <div style={s.metric}><div style={s.mLabel}>Uptime</div><div style={s.mValue}>{duration(bastion.uptimeSeconds)}</div></div>
          <div style={s.metric}><div style={s.mLabel}>RSS</div><div style={s.mValue}>{gb(bastion.rssBytes)}</div></div>
          <div style={s.metric}><div style={s.mLabel}>Instances</div><div style={s.mValue}>{instances.length} / {bastion.maxConcurrentInstances}</div></div>
          <div style={s.metric}><div style={s.mLabel}>Image</div><div style={{ ...s.mValue, fontSize: 12 }}>{bastion.bosImage}</div></div>
        </div>
      </div>

      {/* ── Instances ─────────────────────────────────────────────────────── */}
      {instances.length === 0 && (
        <div style={s.card}><span style={{ color: "#555", fontSize: 13 }}>No instances yet.</span></div>
      )}

      {instances.map((inst) => {
        const v = verdict(inst);
        const h = inst.health;
        const noLimit = inst.cgroup.maxBytes === "max" || inst.container?.memoryLimitBytes == null;
        const oomKills = inst.cgroup.oomKill ?? 0;
        return (
          <div key={inst.username} style={s.card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#eee" }}>{inst.username}</div>
              <div style={{ fontSize: 12, color: v.color, fontWeight: 600 }}>{v.label}</div>
            </div>

            {/* Incident banners — the things that actually explain an outage. */}
            {inst.container?.running && !h?.serving && (
              <div style={s.bad}>
                Container is running but BOS is not serving.
                {h?.base ? ` Base state="${h.base.state}", process ${h.base.procAlive ? "alive" : "DEAD"}.` : " Supervisor unreachable."}
                {h?.base?.buildError ? ` Build error: ${h.base.buildError}` : ""}
              </div>
            )}
            {oomKills > 0 && (
              <div style={s.bad}>
                {oomKills} OOM kill{oomKills > 1 ? "s" : ""} inside this container.
                {inst.cgroup.oom === 0 ? " Container limit was never hit → the HOST ran out of memory." : ""}
                {inst.cgroup.peakBytes ? ` Peak: ${gb(inst.cgroup.peakBytes)}.` : ""}
              </div>
            )}
            {inst.container?.oomKilled && <div style={s.bad}>Docker reports the container&apos;s main process was OOM-killed.</div>}
            {h?.base?.dev && (
              <div style={s.warn}>
                Base is running in <b>dev mode</b> (<code>BOS_BASE_DEV=1</code>). Turbopack stays resident and grows
                without bound (~0.8 MB/request, no plateau) — this is what exhausts host memory. Production mode
                should be used here.
              </div>
            )}
            {h?.supervision.givenUp && <div style={s.bad}>Supervisor gave up restarting base after {h.supervision.consecutiveFailures} consecutive failures.</div>}
            {h && h.supervision.restarts > 0 && !h.supervision.givenUp && (
              <div style={s.warn}>Base server has been restarted {h.supervision.restarts} time(s) — it is crashing, not just idle.</div>
            )}
            {noLimit && (
              <div style={s.warn}>No container memory limit — this instance can consume the entire host.</div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 20 }}>
              <div>
                <div style={{ ...s.mLabel, marginBottom: 6 }}>Container</div>
                <div style={s.row}><span style={s.key}>Docker status</span><span style={s.val}>{inst.container?.status ?? "—"}</span></div>
                <div style={s.row}><span style={s.key}>Healthcheck</span><span style={{ ...s.val, color: inst.container?.health === "healthy" ? "#4ade80" : inst.container?.health === "unhealthy" ? "#f87171" : "#ccc" }}>{inst.container?.health ?? "—"}</span></div>
                <div style={s.row}><span style={s.key}>Uptime</span><span style={s.val}>{sinceIso(inst.container?.startedAt ?? null, now)}</span></div>
                <div style={s.row}><span style={s.key}>Docker restarts</span><span style={s.val}>{inst.container?.restartCount ?? "—"}</span></div>
                <div style={s.row}><span style={s.key}>Memory</span><span style={s.val}>{gb(inst.usage.memUsageBytes)}</span></div>
                <div style={s.row}><span style={s.key}>Memory limit</span><span style={{ ...s.val, color: noLimit ? "#f6c667" : "#ccc" }}>{noLimit ? "none" : gb(inst.container?.memoryLimitBytes)}</span></div>
                <div style={s.row}><span style={s.key}>Memory peak</span><span style={s.val}>{gb(inst.cgroup.peakBytes)}</span></div>
                <div style={s.row}><span style={s.key}>CPU</span><span style={s.val}>{inst.usage.cpuPercent != null ? `${inst.usage.cpuPercent.toFixed(1)}%` : "—"}</span></div>
                <div style={s.row}><span style={s.key}>OOM kills</span><span style={{ ...s.val, color: oomKills > 0 ? "#f87171" : "#ccc" }}>{inst.cgroup.oomKill ?? "—"}</span></div>
              </div>

              <div>
                <div style={{ ...s.mLabel, marginBottom: 6 }}>BOS (inside the container)</div>
                <div style={s.row}><span style={s.key}>Serving</span><span style={{ ...s.val, color: h?.serving ? "#4ade80" : "#f87171" }}>{h ? (h.serving ? "yes" : "no") : "unreachable"}</span></div>
                <div style={s.row}><span style={s.key}>Base state</span><span style={s.val}>{h?.base?.state ?? "—"}</span></div>
                <div style={s.row}><span style={s.key}>Mode</span><span style={{ ...s.val, color: h?.base?.dev ? "#f6c667" : "#ccc" }}>{h?.base ? (h.base.reused ? "reused (external)" : h.base.dev ? "dev" : "production") : "—"}</span></div>
                <div style={s.row}><span style={s.key}>Branch</span><span style={s.val}>{h?.base?.branch ?? h?.baseBranch ?? "—"}</span></div>
                <div style={s.row}><span style={s.key}>Commit</span><span style={s.val}>{h?.base?.commit ? h.base.commit.slice(0, 8) : "—"}</span></div>
                <div style={s.row}><span style={s.key}>Base process</span><span style={s.val}>{h?.base ? (h.base.procAlive ? `alive (pid ${h.base.pid ?? "?"})` : "dead") : "—"}</span></div>
                <div style={s.row}><span style={s.key}>Base restarts</span><span style={{ ...s.val, color: (h?.supervision.restarts ?? 0) > 0 ? "#f6c667" : "#ccc" }}>{h?.supervision.restarts ?? "—"}</span></div>
                <div style={s.row}><span style={s.key}>Supervisor uptime</span><span style={s.val}>{duration(h?.supervisor.uptimeSeconds)}</span></div>
                <div style={s.row}><span style={s.key}>Supervisor RSS</span><span style={s.val}>{gb(h?.supervisor.rssBytes)}</span></div>
                <div style={s.row}><span style={s.key}>Last checked</span><span style={s.val}>{ago(inst.healthCheckedAt, now)}</span></div>
              </div>
            </div>

            {/* Last exit — with the SIGNAL, which is what reveals an OOM kill. */}
            {h?.supervision.lastExit && (
              <div style={{ marginTop: 14 }}>
                <div style={{ ...s.mLabel, marginBottom: 6 }}>Last base-server exit</div>
                <div style={s.row}>
                  <span style={s.key}>When</span>
                  <span style={s.val}>{new Date(h.supervision.lastExit.at).toLocaleString()} ({ago(h.supervision.lastExit.at, now)})</span>
                </div>
                <div style={s.row}>
                  <span style={s.key}>Cause</span>
                  <span style={{ ...s.val, color: h.supervision.lastExit.expected ? "#ccc" : "#f87171" }}>
                    {h.supervision.lastExit.signal
                      ? `signal ${h.supervision.lastExit.signal}`
                      : `code ${h.supervision.lastExit.code ?? "null"}`}
                    {h.supervision.lastExit.expected ? " (requested)" : " (unexpected)"}
                    {h.supervision.lastExit.oomSuspected ? " — OOM suspected" : ""}
                  </span>
                </div>
              </div>
            )}

            {h && h.previews.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ ...s.mLabel, marginBottom: 6 }}>Previews</div>
                {h.previews.map((p) => (
                  <div key={p.branch} style={s.row}>
                    <span style={s.key}>{p.branch} :{p.port}</span>
                    <span style={s.val}>{p.state}{p.procAlive ? "" : " (process dead)"}</span>
                  </div>
                ))}
              </div>
            )}

            {inst.error && <div style={{ ...s.warn, marginTop: 12 }}>{inst.error}</div>}
          </div>
        );
      })}
    </>
  );
}
