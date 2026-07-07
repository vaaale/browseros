import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";

interface InstanceState {
  username: string;
  status: string;
  lastActive: number;
}

interface Me { username: string; isAdmin: boolean; }

const STATUS_COLOR: Record<string, string> = {
  running: "#4ade80", stopped: "#f87171", provisioning: "#fbbf24", unknown: "#94a3b8",
};

const OPERATIONS = [
  { op: "restart", label: "Restart", desc: "Stop and restart your BOS container." },
  { op: "update-src", label: "Update Source", desc: "Pull latest changes in your BOS source tree, then restart." },
  { op: "rebuild-nm", label: "Rebuild Dependencies", desc: "Wipe node_modules and reinstall. Use if npm install broke." },
  { op: "reset-data", label: "Reset Data", desc: "⚠️ Wipe your BOS data directory (VFS, conversations). Source is kept.", warn: true },
  { op: "full", label: "Full Re-provision", desc: "⚠️ Wipe everything — source, data, and dependencies. A clean slate.", warn: true, confirm: true },
];

const s: Record<string, React.CSSProperties> = {
  page: { maxWidth: 640, margin: "40px auto", padding: "0 16px" },
  title: { fontSize: 20, marginBottom: 24, color: "#eee" },
  card: { background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, padding: 20, marginBottom: 16 },
  badge: { display: "inline-block", padding: "2px 10px", borderRadius: 12, fontSize: 12, fontWeight: 600 },
  opCard: { background: "#111", border: "1px solid #333", borderRadius: 6, padding: 16, marginBottom: 10 },
  opTitle: { fontSize: 14, fontWeight: 600, color: "#eee", marginBottom: 4 },
  opDesc: { fontSize: 13, color: "#888", marginBottom: 10 },
  btn: (warn: boolean) => ({ padding: "6px 16px", background: warn ? "#7f1d1d" : "#1d4ed8", border: "none", borderRadius: 4, color: "#fff", cursor: "pointer", fontSize: 13 }),
  err: { color: "#f87171", fontSize: 13, marginTop: 8 },
  adminLink: { color: "#7af", fontSize: 13 },
};

export default function Account() {
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<InstanceState | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    fetch("/account/me").then(r => r.ok ? r.json() : null).then(data => {
      if (!data) { navigate("/login"); return; }
      setMe(data as Me);
    });
    fetch("/account/instance").then(r => r.json()).then(data => setState(data as InstanceState));
  }, [navigate]);

  async function reprovision(op: string) {
    setLoading(op); setError("");
    const res = await fetch("/account/reprovision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: op, confirm: true }),
    });
    setLoading(null);
    if (!res.ok) { const d = await res.json() as { error: string }; setError(d.error); return; }
    const updated = await fetch("/account/instance").then(r => r.json());
    setState(updated as InstanceState);
  }

  async function logout() {
    await fetch("/logout", { method: "POST" });
    navigate("/login");
  }

  return (
    <div style={s.page}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <span style={s.title}>My BOS Instance</span>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {me?.isAdmin && <a href="/app/admin" style={s.adminLink}>Admin panel</a>}
          <button onClick={logout} style={{ background: "none", border: "1px solid #555", color: "#aaa", padding: "4px 12px", borderRadius: 4, cursor: "pointer", fontSize: 13 }}>Sign out</button>
        </div>
      </div>

      <div style={s.card}>
        <div style={{ marginBottom: 8, color: "#aaa", fontSize: 13 }}>User: <strong style={{ color: "#eee" }}>{me?.username}</strong></div>
        {state && (
          <>
            <div style={{ marginBottom: 8 }}>
              Status: <span style={{ ...s.badge, background: STATUS_COLOR[state.status] + "22", color: STATUS_COLOR[state.status] }}>{state.status}</span>
            </div>
            {state.lastActive > 0 && (
              <div style={{ color: "#666", fontSize: 12 }}>Last active: {new Date(state.lastActive).toLocaleString()}</div>
            )}
          </>
        )}
      </div>

      <div style={{ marginBottom: 16, color: "#aaa", fontSize: 14 }}>Re-provision options</div>
      {OPERATIONS.map(({ op, label, desc, warn, confirm: needsConfirm }) => (
        <div key={op} style={s.opCard}>
          <div style={s.opTitle}>{label}</div>
          <div style={s.opDesc}>{desc}</div>
          <button
            style={s.btn(!!warn)}
            disabled={loading !== null}
            onClick={() => {
              if (needsConfirm && !window.confirm(`This will destroy all your data. Type OK to confirm.`)) return;
              reprovision(op);
            }}
          >
            {loading === op ? "Working…" : label}
          </button>
        </div>
      ))}

      {error && <div style={s.err}>{error}</div>}
    </div>
  );
}
