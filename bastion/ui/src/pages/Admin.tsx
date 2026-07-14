import { useState, useEffect, useRef, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/Button";
import { Badge } from "../components/Badge";
import { Dialog } from "../components/Dialog";
import { LogView } from "../components/LogView";

interface User { username: string; isAdmin: boolean; }
interface Instance { username: string; status: string; lastActive: number; error?: string; }
interface ImageInfo { id: string; tags: string[]; sizeMb: number; created: number; }

type Tab = "users" | "images" | "containers" | "logs";

const s = {
  page:    { minHeight: "100vh", background: "#0f0f0f", color: "#eee" },
  header:  { borderBottom: "1px solid #222", padding: "12px 24px", display: "flex", alignItems: "center", justifyContent: "space-between" },
  logo:    { fontSize: 16, fontWeight: 600, color: "#eee" },
  inner:   { maxWidth: 960, margin: "0 auto", padding: "24px 16px" },
  tabs:    { display: "flex", gap: 0, borderBottom: "1px solid #2a2a2a", marginBottom: 24 },
  tab:     (a: boolean) => ({ padding: "8px 16px", fontSize: 13, cursor: "pointer", border: "none", background: "none", borderBottom: a ? "2px solid #2563eb" : "2px solid transparent", color: a ? "#7af" : "#888", transition: "color .15s" }),
  card:    { background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, padding: 20, marginBottom: 16 },
  table:   { width: "100%", borderCollapse: "collapse" as const, fontSize: 13 },
  th:      { textAlign: "left" as const, padding: "8px 12px", borderBottom: "1px solid #2a2a2a", color: "#777", fontWeight: 500, fontSize: 11 },
  td:      { padding: "8px 12px", borderBottom: "1px solid #1f1f1f", color: "#ccc" },
  input:   { padding: "6px 10px", background: "#0f0f0f", border: "1px solid #444", borderRadius: 4, color: "#eee", fontSize: 12, outline: "none" },
  err:     { color: "#f87171", fontSize: 12, marginBottom: 10 },
  label:   { fontSize: 11, color: "#777", display: "block", marginBottom: 4 },
  sectionTitle: { fontSize: 13, fontWeight: 600, color: "#ccc", marginBottom: 12 },
};

export default function Admin() {
  const [tab, setTab] = useState<Tab>("users");
  const [users, setUsers] = useState<User[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [images, setImages] = useState<ImageInfo[]>([]);
  const [isKeycloak, setIsKeycloak] = useState(false);
  const [newUser, setNewUser] = useState({ username: "", password: "", isAdmin: false });
  const [userError, setUserError] = useState("");
  const [deleteDialog, setDeleteDialog] = useState<string | null>(null);
  const [killDialog, setKillDialog] = useState<string | null>(null);

  // Image build
  const [buildDockerfile, setBuildDockerfile] = useState("Dockerfile");
  const [buildTag, setBuildTag] = useState("browseros/user:latest");
  const [buildLog, setBuildLog] = useState("");
  const [buildStatus, setBuildStatus] = useState<"idle" | "building" | "success" | "error">("idle");
  const [buildError, setBuildError] = useState("");

  // Logs tab
  const [logUser, setLogUser] = useState("");
  const [logContent, setLogContent] = useState("");

  const navigate = useNavigate();
  const buildAbortRef = useRef<AbortController | null>(null);

  async function loadAll() {
    const [u, i, img, setup] = await Promise.all([
      fetch("/admin/users").then(r => r.ok ? r.json() : null),
      fetch("/admin/instances").then(r => r.ok ? r.json() : []),
      fetch("/admin/images").then(r => r.ok ? r.json() : { images: [] }),
      fetch("/setup/state").then(r => r.ok ? r.json() : null),
    ]);
    if (!u) { navigate("/login"); return; }
    setUsers(u as User[]);
    setInstances(i as Instance[]);
    setImages((img as { images: ImageInfo[] }).images ?? []);
    if (setup) setIsKeycloak((setup as { authProvider: string }).authProvider === "keycloak");
  }

  useEffect(() => { void loadAll(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function createUser(e: FormEvent) {
    e.preventDefault(); setUserError("");
    const res = await fetch("/admin/users", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newUser),
    });
    if (!res.ok) { const d = await res.json() as { error: string }; setUserError(d.error); return; }
    setNewUser({ username: "", password: "", isAdmin: false });
    void loadAll();
  }

  async function doDelete(username: string) {
    setDeleteDialog(null);
    await fetch(`/admin/users/${encodeURIComponent(username)}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wipeData: true }),
    });
    void loadAll();
  }

  async function toggleAdmin(user: User) {
    await fetch(`/admin/users/${encodeURIComponent(user.username)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isAdmin: !user.isAdmin }),
    });
    void loadAll();
  }

  async function startInstance(u: string) { await fetch(`/admin/instances/${encodeURIComponent(u)}/start`, { method: "POST" }); void loadAll(); }
  async function stopInstance(u: string) { await fetch(`/admin/instances/${encodeURIComponent(u)}/stop`, { method: "POST" }); void loadAll(); }
  async function doKill(u: string) { setKillDialog(null); await fetch(`/admin/instances/${encodeURIComponent(u)}/kill`, { method: "POST" }); void loadAll(); }

  async function runBuild() {
    if (buildStatus === "building") return;
    setBuildLog(""); setBuildError(""); setBuildStatus("building");
    const abort = new AbortController();
    buildAbortRef.current = abort;
    try {
      const res = await fetch("/admin/image/build", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dockerfile: buildDockerfile, tag: buildTag }),
        signal: abort.signal,
      });
      if (!res.body) { setBuildStatus("error"); return; }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n"); buf = parts.pop() ?? "";
        for (const part of parts) {
          if (!part.startsWith("data:")) continue;
          try {
            const ev = JSON.parse(part.slice(5)) as { line?: string; error?: string; status?: string };
            if (ev.line) setBuildLog(l => l + ev.line + "\n");
            if (ev.error) setBuildLog(l => l + "ERROR: " + ev.error + "\n");
            if (ev.status === "success") { setBuildStatus("success"); void loadAll(); }
            if (ev.status === "error") { setBuildStatus("error"); setBuildError(ev.error ?? "Build failed"); }
          } catch { /* ignore */ }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") { setBuildStatus("error"); setBuildError(String(err)); }
    }
  }

  async function setActiveImage(tag: string) {
    await fetch("/admin/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bosImage: tag }) });
    void loadAll();
  }

  async function loadLog(username: string) {
    if (!username) return;
    const res = await fetch(`/admin/instances/${encodeURIComponent(username)}/log`);
    if (res.ok) { const d = await res.json() as { log: string }; setLogContent(d.log); }
  }

  const TABS: { id: Tab; label: string }[] = [
    { id: "users", label: "Users" },
    { id: "images", label: "Images" },
    { id: "containers", label: "Containers" },
    { id: "logs", label: "Logs" },
  ];

  return (
    <div style={s.page}>
      <div style={s.header}>
        <span style={s.logo}>BrowserOS Admin</span>
        <a href="/app/account" style={{ color: "#7af", fontSize: 12 }}>My account</a>
      </div>

      <div style={s.inner}>
        {/* Tabs */}
        <div style={s.tabs}>
          {TABS.map(t => (
            <button key={t.id} style={s.tab(tab === t.id)} onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </div>

        {/* ── Users ──────────────────────────────────────────────────────── */}
        {tab === "users" && (
          isKeycloak ? (
            <div style={s.card}>
              <p style={{ fontSize: 13, color: "#aaa" }}>
                User management is handled by Keycloak — visit the Keycloak admin console to create or remove users and manage roles.
              </p>
            </div>
          ) : (
            <>
              <div style={s.card}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      <th style={s.th}>Username</th>
                      <th style={s.th}>Role</th>
                      <th style={s.th}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map(u => (
                      <tr key={u.username}>
                        <td style={s.td}>{u.username}</td>
                        <td style={s.td}><span style={{ color: u.isAdmin ? "#7af" : "#555", fontSize: 11 }}>{u.isAdmin ? "admin" : "user"}</span></td>
                        <td style={{ ...s.td, display: "flex", gap: 6 }}>
                          <Button size="sm" variant="secondary" onClick={() => toggleAdmin(u)}>{u.isAdmin ? "Remove admin" : "Make admin"}</Button>
                          <Button size="sm" variant="danger" onClick={() => setDeleteDialog(u.username)}>Delete</Button>
                        </td>
                      </tr>
                    ))}
                    {users.length === 0 && <tr><td colSpan={3} style={{ ...s.td, color: "#555", textAlign: "center" }}>No users</td></tr>}
                  </tbody>
                </table>
              </div>

              <div style={s.card}>
                <div style={s.sectionTitle}>Add user</div>
                {userError && <div style={s.err}>{userError}</div>}
                <form onSubmit={createUser} style={{ display: "flex", gap: 8, flexWrap: "wrap" as const, alignItems: "flex-end" }}>
                  <div>
                    <label style={s.label}>Username</label>
                    <input style={s.input} placeholder="username" value={newUser.username} onChange={e => setNewUser(p => ({ ...p, username: e.target.value }))} />
                  </div>
                  <div>
                    <label style={s.label}>Password</label>
                    <input style={s.input} type="password" placeholder="password" value={newUser.password} onChange={e => setNewUser(p => ({ ...p, password: e.target.value }))} />
                  </div>
                  <label style={{ color: "#aaa", fontSize: 12, display: "flex", alignItems: "center", gap: 6, paddingBottom: 2 }}>
                    <input type="checkbox" checked={newUser.isAdmin} onChange={e => setNewUser(p => ({ ...p, isAdmin: e.target.checked }))} />
                    Admin
                  </label>
                  <Button type="submit">Create</Button>
                </form>
              </div>
            </>
          )
        )}

        {/* ── Images ─────────────────────────────────────────────────────── */}
        {tab === "images" && (
          <>
            <div style={s.card}>
              <div style={s.sectionTitle}>Build image</div>
              <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" as const }}>
                <div>
                  <label style={s.label}>Dockerfile</label>
                  <input style={s.input} value={buildDockerfile} onChange={e => setBuildDockerfile(e.target.value)} />
                </div>
                <div>
                  <label style={s.label}>Tag</label>
                  <input style={{ ...s.input, width: 220 }} value={buildTag} onChange={e => setBuildTag(e.target.value)} />
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: buildLog ? 12 : 0 }}>
                <Button onClick={runBuild} loading={buildStatus === "building"} disabled={buildStatus === "building"}>
                  {buildStatus === "building" ? "Building…" : "Build"}
                </Button>
                {buildStatus === "success" && <span style={{ color: "#4ade80", fontSize: 12 }}>Build succeeded</span>}
                {buildStatus === "error" && <span style={{ color: "#f87171", fontSize: 12 }}>{buildError}</span>}
              </div>
              {buildLog && <LogView log={buildLog} />}
            </div>

            <div style={s.card}>
              <div style={s.sectionTitle}>Local images</div>
              {images.length === 0
                ? <p style={{ fontSize: 12, color: "#555" }}>No images found</p>
                : (
                  <table style={s.table}>
                    <thead><tr><th style={s.th}>Tags</th><th style={s.th}>ID</th><th style={s.th}>Size</th><th style={s.th}></th></tr></thead>
                    <tbody>
                      {images.map(img => (
                        <tr key={img.id}>
                          <td style={s.td}>{img.tags.length ? img.tags.join(", ") : <span style={{ color: "#555" }}>&lt;none&gt;</span>}</td>
                          <td style={{ ...s.td, fontFamily: "monospace", fontSize: 11, color: "#666" }}>{img.id}</td>
                          <td style={{ ...s.td, color: "#888" }}>{img.sizeMb} MB</td>
                          <td style={s.td}>{img.tags[0] && <Button size="sm" variant="secondary" onClick={() => setActiveImage(img.tags[0])}>Set active</Button>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              }
            </div>
          </>
        )}

        {/* ── Containers ─────────────────────────────────────────────────── */}
        {tab === "containers" && (
          <div style={s.card}>
            <table style={s.table}>
              <thead><tr><th style={s.th}>User</th><th style={s.th}>Status</th><th style={s.th}>Last active</th><th style={s.th}>Actions</th></tr></thead>
              <tbody>
                {instances.map(inst => (
                  <tr key={inst.username}>
                    <td style={s.td}>{inst.username}</td>
                    <td style={s.td}><Badge status={inst.status} /></td>
                    <td style={{ ...s.td, color: "#666", fontSize: 12 }}>{inst.lastActive > 0 ? new Date(inst.lastActive).toLocaleString() : "—"}</td>
                    <td style={{ ...s.td, display: "flex", gap: 6 }}>
                      {inst.status === "running"
                        ? <Button size="sm" variant="secondary" onClick={() => stopInstance(inst.username)}>Stop</Button>
                        : <Button size="sm" onClick={() => startInstance(inst.username)}>Start</Button>}
                      <Button size="sm" variant="danger" onClick={() => setKillDialog(inst.username)}>Kill</Button>
                    </td>
                  </tr>
                ))}
                {instances.length === 0 && <tr><td colSpan={4} style={{ ...s.td, color: "#555", textAlign: "center" }}>No instances</td></tr>}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Logs ───────────────────────────────────────────────────────── */}
        {tab === "logs" && (
          <div style={s.card}>
            <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
              <select
                style={{ ...s.input, fontSize: 13 }}
                value={logUser}
                onChange={e => { setLogUser(e.target.value); setLogContent(""); }}
              >
                <option value="">Select user…</option>
                {users.map(u => <option key={u.username} value={u.username}>{u.username}</option>)}
              </select>
              <Button size="sm" variant="secondary" onClick={() => loadLog(logUser)} disabled={!logUser}>Load</Button>
            </div>
            <LogView log={logContent} />
          </div>
        )}
      </div>

      <Dialog
        open={deleteDialog !== null}
        title="Delete user"
        message={`Delete ${deleteDialog ?? ""}?\n\nThis will stop their container and permanently wipe all their data (files, conversations, avatar, and log). This cannot be undone.`}
        onConfirm={() => deleteDialog && doDelete(deleteDialog)}
        onCancel={() => setDeleteDialog(null)}
        confirmLabel="Delete and wipe"
        dangerous
      />
      <Dialog
        open={killDialog !== null}
        title="Kill container"
        message={`Force-remove the container for ${killDialog ?? ""}? Their data is preserved.`}
        onConfirm={() => killDialog && doKill(killDialog)}
        onCancel={() => setKillDialog(null)}
        confirmLabel="Kill"
        dangerous
      />
    </div>
  );
}
