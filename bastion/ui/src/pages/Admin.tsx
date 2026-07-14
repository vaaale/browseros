import { useState, useEffect, useRef, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/Button";
import { Badge } from "../components/Badge";
import { Card } from "../components/Card";
import { Dialog } from "../components/Dialog";
import { LogView } from "../components/LogView";

interface User { username: string; isAdmin: boolean; }
interface Instance { username: string; status: string; lastActive: number; containerId?: string; error?: string; }
interface ImageInfo { id: string; tags: string[]; sizeMb: number; created: number; }
interface SetupState { authProvider: string; needsBootstrap: boolean; }

type Tab = "users" | "images" | "containers" | "logs";

function TabButton({ active, onClick, children }: { active: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium rounded-t border-b-2 transition-colors ${
        active
          ? "border-blue-500 text-blue-400 bg-gray-800"
          : "border-transparent text-gray-400 hover:text-gray-200 hover:bg-gray-800/60"
      }`}
    >
      {children}
    </button>
  );
}

export default function Admin() {
  const [tab, setTab] = useState<Tab>("users");
  const [users, setUsers] = useState<User[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [images, setImages] = useState<ImageInfo[]>([]);
  const [setupState, setSetupState] = useState<SetupState | null>(null);
  const [newUser, setNewUser] = useState({ username: "", password: "", isAdmin: false });
  const [userError, setUserError] = useState("");
  const [deleteDialog, setDeleteDialog] = useState<string | null>(null);
  const [killDialog, setKillDialog] = useState<string | null>(null);

  // Image build state
  const [buildDockerfile, setBuildDockerfile] = useState("Dockerfile");
  const [buildTag, setBuildTag] = useState("browseros/user:latest");
  const [buildLog, setBuildLog] = useState("");
  const [buildStatus, setBuildStatus] = useState<"idle" | "building" | "success" | "error">("idle");
  const [buildError, setBuildError] = useState("");

  // Logs tab state
  const [logUser, setLogUser] = useState("");
  const [logContent, setLogContent] = useState("");

  const navigate = useNavigate();
  const buildAbortRef = useRef<AbortController | null>(null);

  async function loadAll() {
    const [u, i, img, s] = await Promise.all([
      fetch("/admin/users").then((r) => (r.ok ? r.json() : null)),
      fetch("/admin/instances").then((r) => (r.ok ? r.json() : [])),
      fetch("/admin/images").then((r) => (r.ok ? r.json() : { images: [] })),
      fetch("/setup/state").then((r) => (r.ok ? r.json() : null)),
    ]);
    if (!u) { navigate("/login"); return; }
    setUsers(u as User[]);
    setInstances(i as Instance[]);
    setImages((img as { images: ImageInfo[] }).images ?? []);
    if (s) setSetupState(s as SetupState);
  }

  useEffect(() => { void loadAll(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function createUser(e: FormEvent) {
    e.preventDefault();
    setUserError("");
    const res = await fetch("/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newUser),
    });
    if (!res.ok) {
      const d = await res.json() as { error: string };
      setUserError(d.error);
      return;
    }
    setNewUser({ username: "", password: "", isAdmin: false });
    void loadAll();
  }

  async function doDelete(username: string) {
    setDeleteDialog(null);
    await fetch(`/admin/users/${encodeURIComponent(username)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wipeData: true }),
    });
    void loadAll();
  }

  async function toggleAdmin(user: User) {
    await fetch(`/admin/users/${encodeURIComponent(user.username)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isAdmin: !user.isAdmin }),
    });
    void loadAll();
  }

  async function startInstance(username: string) {
    await fetch(`/admin/instances/${encodeURIComponent(username)}/start`, { method: "POST" });
    void loadAll();
  }

  async function stopInstance(username: string) {
    await fetch(`/admin/instances/${encodeURIComponent(username)}/stop`, { method: "POST" });
    void loadAll();
  }

  async function doKill(username: string) {
    setKillDialog(null);
    await fetch(`/admin/instances/${encodeURIComponent(username)}/kill`, { method: "POST" });
    void loadAll();
  }

  async function buildImage() {
    if (buildStatus === "building") return;
    setBuildLog("");
    setBuildError("");
    setBuildStatus("building");
    const abort = new AbortController();
    buildAbortRef.current = abort;
    try {
      const res = await fetch("/admin/image/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dockerfile: buildDockerfile, tag: buildTag }),
        signal: abort.signal,
      });
      if (!res.body) { setBuildStatus("error"); setBuildError("No response body"); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          if (!part.startsWith("data:")) continue;
          const json = part.slice(5).trim();
          try {
            const ev = JSON.parse(json) as { line?: string; error?: string; status?: string };
            if (ev.line) setBuildLog((l) => l + ev.line + "\n");
            if (ev.error) setBuildLog((l) => l + "ERROR: " + ev.error + "\n");
            if (ev.status === "success") { setBuildStatus("success"); void loadAll(); }
            if (ev.status === "error") { setBuildStatus("error"); setBuildError(ev.error ?? "Build failed"); }
          } catch { /* ignore malformed events */ }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setBuildStatus("error");
        setBuildError(String(err));
      }
    }
  }

  async function setActiveImage(tag: string) {
    await fetch("/admin/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bosImage: tag }),
    });
    void loadAll();
  }

  async function loadLog(username: string) {
    if (!username) return;
    const res = await fetch(`/admin/instances/${encodeURIComponent(username)}/log`);
    if (res.ok) {
      const d = await res.json() as { log: string };
      setLogContent(d.log);
    }
  }

  const isKeycloak = setupState?.authProvider === "keycloak";

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      {/* Header */}
      <div className="border-b border-gray-700 bg-gray-800/50">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <span className="font-semibold text-white">BrowserOS Admin</span>
          <a href="/app/account" className="text-sm text-blue-400 hover:text-blue-300">My account</a>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-6">
        {/* Tabs */}
        <div className="flex gap-1 mb-6 border-b border-gray-700">
          {(["users", "images", "containers", "logs"] as Tab[]).map((t) => (
            <TabButton key={t} active={tab === t} onClick={() => setTab(t)}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </TabButton>
          ))}
        </div>

        {/* ── Users ─────────────────────────────────────────────────────────── */}
        {tab === "users" && (
          <div className="space-y-6">
            {isKeycloak ? (
              <Card>
                <p className="text-sm text-gray-400">
                  User management is handled by Keycloak — visit the{" "}
                  <a href={`${window.location.origin}/auth/keycloak`} className="text-blue-400 hover:underline">
                    Keycloak admin console
                  </a>{" "}
                  to create or remove users and manage roles.
                </p>
              </Card>
            ) : (
              <>
                <Card>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-gray-500 border-b border-gray-700">
                        <th className="pb-2 font-medium">Username</th>
                        <th className="pb-2 font-medium">Admin</th>
                        <th className="pb-2 font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-700/50">
                      {users.map((u) => (
                        <tr key={u.username}>
                          <td className="py-2.5 text-gray-200">{u.username}</td>
                          <td className="py-2.5">
                            <span className={`text-xs font-medium ${u.isAdmin ? "text-blue-400" : "text-gray-500"}`}>
                              {u.isAdmin ? "admin" : "user"}
                            </span>
                          </td>
                          <td className="py-2.5 flex gap-2">
                            <Button size="sm" variant="secondary" onClick={() => toggleAdmin(u)}>
                              {u.isAdmin ? "Remove admin" : "Make admin"}
                            </Button>
                            <Button size="sm" variant="danger" onClick={() => setDeleteDialog(u.username)}>
                              Delete
                            </Button>
                          </td>
                        </tr>
                      ))}
                      {users.length === 0 && (
                        <tr><td colSpan={3} className="py-4 text-center text-gray-500 text-xs">No users</td></tr>
                      )}
                    </tbody>
                  </table>
                </Card>

                <Card>
                  <div className="text-sm font-medium text-gray-300 mb-3">Create user</div>
                  {userError && (
                    <div className="mb-3 px-3 py-2 bg-red-900/40 border border-red-700 rounded text-red-300 text-xs">{userError}</div>
                  )}
                  <form onSubmit={createUser} className="flex flex-wrap gap-2 items-center">
                    <input
                      className="px-2.5 py-1.5 bg-gray-900 border border-gray-600 rounded text-sm text-gray-100 focus:outline-none focus:border-blue-500 w-36"
                      placeholder="username"
                      value={newUser.username}
                      onChange={(e) => setNewUser((p) => ({ ...p, username: e.target.value }))}
                    />
                    <input
                      type="password"
                      className="px-2.5 py-1.5 bg-gray-900 border border-gray-600 rounded text-sm text-gray-100 focus:outline-none focus:border-blue-500 w-36"
                      placeholder="password"
                      value={newUser.password}
                      onChange={(e) => setNewUser((p) => ({ ...p, password: e.target.value }))}
                    />
                    <label className="flex items-center gap-1.5 text-sm text-gray-400 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={newUser.isAdmin}
                        onChange={(e) => setNewUser((p) => ({ ...p, isAdmin: e.target.checked }))}
                        className="accent-blue-500"
                      />
                      Admin
                    </label>
                    <Button type="submit">Create</Button>
                  </form>
                </Card>
              </>
            )}
          </div>
        )}

        {/* ── Images ────────────────────────────────────────────────────────── */}
        {tab === "images" && (
          <div className="space-y-6">
            <Card>
              <div className="text-sm font-medium text-gray-300 mb-3">Build user-container image</div>
              <div className="flex flex-wrap gap-3 mb-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Dockerfile path</label>
                  <input
                    className="px-2.5 py-1.5 bg-gray-900 border border-gray-600 rounded text-sm text-gray-100 focus:outline-none focus:border-blue-500 w-44"
                    value={buildDockerfile}
                    onChange={(e) => setBuildDockerfile(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Image tag</label>
                  <input
                    className="px-2.5 py-1.5 bg-gray-900 border border-gray-600 rounded text-sm text-gray-100 focus:outline-none focus:border-blue-500 w-52"
                    value={buildTag}
                    onChange={(e) => setBuildTag(e.target.value)}
                  />
                </div>
              </div>
              <div className="flex items-center gap-3 mb-3">
                <Button onClick={buildImage} loading={buildStatus === "building"} disabled={buildStatus === "building"}>
                  {buildStatus === "building" ? "Building…" : "Build"}
                </Button>
                {buildStatus === "success" && (
                  <span className="text-green-400 text-sm font-medium">Build succeeded</span>
                )}
                {buildStatus === "error" && (
                  <span className="text-red-400 text-sm">{buildError}</span>
                )}
              </div>
              {buildLog && <LogView log={buildLog} />}
            </Card>

            <Card>
              <div className="text-sm font-medium text-gray-300 mb-3">Local images</div>
              {images.length === 0 ? (
                <p className="text-xs text-gray-500">No images found</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b border-gray-700">
                      <th className="pb-2 font-medium">Tags</th>
                      <th className="pb-2 font-medium">ID</th>
                      <th className="pb-2 font-medium">Size</th>
                      <th className="pb-2 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-700/50">
                    {images.map((img) => (
                      <tr key={img.id}>
                        <td className="py-2 text-gray-200 text-xs">
                          {img.tags.length ? img.tags.join(", ") : <span className="text-gray-600">&lt;none&gt;</span>}
                        </td>
                        <td className="py-2 font-mono text-xs text-gray-500">{img.id}</td>
                        <td className="py-2 text-xs text-gray-400">{img.sizeMb} MB</td>
                        <td className="py-2">
                          {img.tags[0] && (
                            <Button size="sm" variant="secondary" onClick={() => setActiveImage(img.tags[0])}>
                              Set active
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>
        )}

        {/* ── Containers ────────────────────────────────────────────────────── */}
        {tab === "containers" && (
          <Card>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-700">
                  <th className="pb-2 font-medium">User</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium">Last active</th>
                  <th className="pb-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700/50">
                {instances.map((inst) => (
                  <tr key={inst.username}>
                    <td className="py-2.5 text-gray-200">{inst.username}</td>
                    <td className="py-2.5"><Badge status={inst.status} /></td>
                    <td className="py-2.5 text-xs text-gray-500">
                      {inst.lastActive > 0 ? new Date(inst.lastActive).toLocaleString() : "—"}
                    </td>
                    <td className="py-2.5 flex gap-2 flex-wrap">
                      {inst.status === "running"
                        ? <Button size="sm" variant="secondary" onClick={() => stopInstance(inst.username)}>Stop</Button>
                        : <Button size="sm" onClick={() => startInstance(inst.username)}>Start</Button>
                      }
                      <Button size="sm" variant="danger" onClick={() => setKillDialog(inst.username)}>Kill</Button>
                    </td>
                  </tr>
                ))}
                {instances.length === 0 && (
                  <tr><td colSpan={4} className="py-4 text-center text-gray-500 text-xs">No instances</td></tr>
                )}
              </tbody>
            </table>
          </Card>
        )}

        {/* ── Logs ──────────────────────────────────────────────────────────── */}
        {tab === "logs" && (
          <Card className="space-y-3">
            <div className="flex gap-2 items-center">
              <select
                className="px-2.5 py-1.5 bg-gray-900 border border-gray-600 rounded text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                value={logUser}
                onChange={(e) => { setLogUser(e.target.value); setLogContent(""); }}
              >
                <option value="">Select user…</option>
                {users.map((u) => <option key={u.username} value={u.username}>{u.username}</option>)}
              </select>
              <Button size="sm" variant="secondary" onClick={() => loadLog(logUser)} disabled={!logUser}>
                Load log
              </Button>
            </div>
            <LogView log={logContent} />
          </Card>
        )}
      </div>

      {/* Dialogs */}
      <Dialog
        open={deleteDialog !== null}
        title="Delete user"
        message={`Delete ${deleteDialog ?? ""}? This will stop their container and permanently wipe all their data (source, files, conversations, avatar, and log). This cannot be undone.`}
        onConfirm={() => deleteDialog && doDelete(deleteDialog)}
        onCancel={() => setDeleteDialog(null)}
        confirmLabel="Delete and wipe"
        dangerous
      />
      <Dialog
        open={killDialog !== null}
        title="Kill container"
        message={`Force-remove the container for ${killDialog ?? ""}? This immediately terminates the container. Their data is preserved.`}
        onConfirm={() => killDialog && doKill(killDialog)}
        onCancel={() => setKillDialog(null)}
        confirmLabel="Kill"
        dangerous
      />
    </div>
  );
}
