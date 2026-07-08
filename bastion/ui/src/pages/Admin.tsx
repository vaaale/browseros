import { useState, useEffect, FormEvent } from "react";
import { useNavigate } from "react-router-dom";

interface User { username: string; isAdmin: boolean; }
interface Instance { username: string; status: string; lastActive: number; containerId?: string; }

const s: Record<string, React.CSSProperties> = {
  page: { maxWidth: 900, margin: "40px auto", padding: "0 16px" },
  title: { fontSize: 20, marginBottom: 24, color: "#eee" },
  tabs: { display: "flex", gap: 4, marginBottom: 24 },
  tab: (active: boolean) => ({ padding: "8px 18px", background: active ? "#2563eb" : "#1a1a1a", border: "1px solid " + (active ? "#2563eb" : "#333"), borderRadius: 4, color: active ? "#fff" : "#aaa", cursor: "pointer", fontSize: 13 }),
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: 13 },
  th: { textAlign: "left" as const, padding: "8px 12px", borderBottom: "1px solid #333", color: "#777" },
  td: { padding: "8px 12px", borderBottom: "1px solid #222", color: "#ccc" },
  btn: { padding: "4px 12px", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 12 },
  input: { padding: "6px 10px", background: "#0f0f0f", border: "1px solid #444", borderRadius: 4, color: "#eee", fontSize: 13 },
  err: { color: "#f87171", fontSize: 13, margin: "8px 0" },
};

type Tab = "users" | "instances";

export default function Admin() {
  const [tab, setTab] = useState<Tab>("users");
  const [users, setUsers] = useState<User[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [error, setError] = useState("");
  const [newUser, setNewUser] = useState({ username: "", password: "", isAdmin: false });
  const navigate = useNavigate();

  async function load() {
    const [u, i] = await Promise.all([
      fetch("/admin/users").then(r => r.ok ? r.json() : null),
      fetch("/admin/instances").then(r => r.ok ? r.json() : null),
    ]);
    if (!u) { navigate("/login"); return; }
    setUsers((u as User[]));
    setInstances((i as Instance[]) ?? []);
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function createUser(e: FormEvent) {
    e.preventDefault(); setError("");
    const res = await fetch("/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newUser),
    });
    if (!res.ok) { const d = await res.json() as { error: string }; setError(d.error); return; }
    setNewUser({ username: "", password: "", isAdmin: false });
    load();
  }

  async function deleteUser(username: string) {
    if (!window.confirm(`Delete user ${username}?`)) return;
    await fetch(`/admin/users/${username}`, { method: "DELETE" });
    load();
  }

  async function toggleAdmin(user: User) {
    await fetch(`/admin/users/${user.username}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isAdmin: !user.isAdmin }),
    });
    load();
  }

  async function stopInstance(username: string) {
    await fetch(`/admin/instances/${username}/stop`, { method: "POST" });
    load();
  }

  async function startInstance(username: string) {
    await fetch(`/admin/instances/${username}/start`, { method: "POST" });
    load();
  }

  async function reprovision(username: string, operation: string) {
    if (operation === "full" && !window.confirm(`Full re-provision for ${username}? This wipes all data.`)) return;
    await fetch(`/admin/instances/${username}/reprovision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation }),
    });
    load();
  }

  const STATUS_COLOR: Record<string, string> = {
    running: "#4ade80", stopped: "#f87171", provisioning: "#fbbf24", unknown: "#94a3b8",
  };

  return (
    <div style={s.page}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <span style={s.title}>Admin Panel</span>
        <a href="/app/account" style={{ color: "#7af", fontSize: 13 }}>My account</a>
      </div>

      <div style={s.tabs}>
        {(["users", "instances"] as Tab[]).map(t => (
          <button key={t} style={s.tab(tab === t)} onClick={() => setTab(t)}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === "users" && (
        <>
          <table style={s.table}>
            <thead>
              <tr><th style={s.th}>Username</th><th style={s.th}>Admin</th><th style={s.th}>Actions</th></tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.username}>
                  <td style={s.td}>{u.username}</td>
                  <td style={s.td}>{u.isAdmin ? "✓" : "—"}</td>
                  <td style={s.td}>
                    <button style={{ ...s.btn, background: "#2563eb", color: "#fff", marginRight: 6 }} onClick={() => toggleAdmin(u)}>
                      {u.isAdmin ? "Remove admin" : "Make admin"}
                    </button>
                    <button style={{ ...s.btn, background: "#7f1d1d", color: "#fff" }} onClick={() => deleteUser(u.username)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ marginTop: 24, marginBottom: 12, color: "#aaa", fontSize: 14 }}>Add user</div>
          {error && <div style={s.err}>{error}</div>}
          <form onSubmit={createUser} style={{ display: "flex", gap: 8, flexWrap: "wrap" as const, alignItems: "center" }}>
            <input style={s.input} placeholder="username" value={newUser.username} onChange={e => setNewUser(p => ({ ...p, username: e.target.value }))} />
            <input style={s.input} type="password" placeholder="password" value={newUser.password} onChange={e => setNewUser(p => ({ ...p, password: e.target.value }))} />
            <label style={{ color: "#aaa", fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={newUser.isAdmin} onChange={e => setNewUser(p => ({ ...p, isAdmin: e.target.checked }))} />
              Admin
            </label>
            <button type="submit" style={{ ...s.btn, background: "#2563eb", color: "#fff", padding: "6px 16px" }}>Create</button>
          </form>
        </>
      )}

      {tab === "instances" && (
        <table style={s.table}>
          <thead>
            <tr><th style={s.th}>User</th><th style={s.th}>Status</th><th style={s.th}>Last Active</th><th style={s.th}>Actions</th></tr>
          </thead>
          <tbody>
            {instances.map(inst => (
              <tr key={inst.username}>
                <td style={s.td}>{inst.username}</td>
                <td style={s.td}>
                  <span style={{ color: STATUS_COLOR[inst.status] ?? "#ccc" }}>{inst.status}</span>
                </td>
                <td style={s.td}>{inst.lastActive > 0 ? new Date(inst.lastActive).toLocaleString() : "—"}</td>
                <td style={s.td} style2={{ display: "flex", gap: 4 }}>
                  {inst.status === "running"
                    ? <button style={{ ...s.btn, background: "#374151", color: "#ccc", marginRight: 4 }} onClick={() => stopInstance(inst.username)}>Stop</button>
                    : <button style={{ ...s.btn, background: "#2563eb", color: "#fff", marginRight: 4 }} onClick={() => startInstance(inst.username)}>Start</button>
                  }
                  <select
                    style={{ ...s.input, fontSize: 12 }}
                    defaultValue=""
                    onChange={e => { if (e.target.value) reprovision(inst.username, e.target.value); e.target.value = ""; }}
                  >
                    <option value="">Re-provision…</option>
                    <option value="restart">Restart</option>
                    <option value="update-src">Update source</option>
                    <option value="rebuild-nm">Rebuild node_modules</option>
                    <option value="reset-data">Reset data</option>
                    <option value="full">Full re-provision</option>
                  </select>
                </td>
              </tr>
            ))}
            {instances.length === 0 && (
              <tr><td colSpan={4} style={{ ...s.td, color: "#555", textAlign: "center" }}>No instances yet</td></tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
