import { useState, useEffect, useRef, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/Button";
import { Badge } from "../components/Badge";
import { Dialog } from "../components/Dialog";
import { LogView } from "../components/LogView";

interface Me { username: string; isAdmin: boolean; }
interface InstanceState { username: string; status: string; lastActive: number; error?: string; }

const s = {
  page:    { minHeight: "100vh", background: "#0f0f0f", color: "#eee" },
  header:  { borderBottom: "1px solid #222", padding: "12px 24px", display: "flex", alignItems: "center", justifyContent: "space-between" },
  inner:   { maxWidth: 680, margin: "0 auto", padding: "24px 16px" },
  card:    { background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, padding: 20, marginBottom: 16 },
  section: { fontSize: 13, fontWeight: 600, color: "#ccc", marginBottom: 12 },
  label:   { display: "block", marginBottom: 4, fontSize: 12, color: "#aaa" },
  input:   { width: "100%", maxWidth: 280, padding: "7px 10px", background: "#0f0f0f", border: "1px solid #444", borderRadius: 4, color: "#eee", fontSize: 13, outline: "none", boxSizing: "border-box" as const },
  row:     { display: "flex", gap: 8, flexWrap: "wrap" as const, alignItems: "center" },
  err:     { color: "#f87171", fontSize: 12, marginTop: 8 },
  ok:      { color: "#4ade80", fontSize: 12, marginTop: 8 },
  dangerTitle: { fontSize: 13, fontWeight: 600, color: "#f87171", marginBottom: 12 },
  opDesc:  { fontSize: 12, color: "#777", marginBottom: 8 },
  sep:     { borderTop: "1px solid #2a2a2a", margin: "14px 0" },
};

export default function Account() {
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<InstanceState | null>(null);
  const [isKeycloak, setIsKeycloak] = useState(false);
  const [log, setLog] = useState("");
  const [showLog, setShowLog] = useState(false);
  const [loadingOp, setLoadingOp] = useState<string | null>(null);
  const [opError, setOpError] = useState("");
  const [wipeDialog, setWipeDialog] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwError, setPwError] = useState("");
  const [pwOk, setPwOk] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    void Promise.all([
      fetch("/account/me").then(r => r.ok ? r.json() : null).then(d => {
        if (!d) { navigate("/login"); return; }
        setMe(d as Me);
        setAvatarUrl(`/avatar/${encodeURIComponent((d as Me).username)}`);
      }),
      fetch("/account/instance").then(r => r.json()).then(d => setState(d as InstanceState)),
      fetch("/setup/state").then(r => r.ok ? r.json() : null).then(d => {
        if (d) setIsKeycloak((d as { authProvider: string }).authProvider === "keycloak");
      }),
    ]);
  }, [navigate]);

  async function doOp(op: string) {
    setLoadingOp(op); setOpError("");
    const res = await fetch("/account/reprovision", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: op, confirm: true }),
    });
    setLoadingOp(null);
    if (!res.ok) { const d = await res.json() as { error: string }; setOpError(d.error); return; }
    window.location.href = "/";
  }

  async function doWipe() {
    setWipeDialog(false); setLoadingOp("wipe"); setOpError("");
    const res = await fetch("/account/wipe-data", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    setLoadingOp(null);
    if (!res.ok) { const d = await res.json() as { error: string }; setOpError(d.error); return; }
    setState(await fetch("/account/instance").then(r => r.json()) as InstanceState);
  }

  async function logout() {
    await fetch("/logout", { method: "POST" });
    navigate("/login");
  }

  async function loadLog() {
    const res = await fetch("/account/log");
    if (res.ok) { const d = await res.json() as { log: string }; setLog(d.log); setShowLog(true); }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault(); setPwError(""); setPwOk(false);
    if (pwNew.length < 8) { setPwError("At least 8 characters."); return; }
    if (pwNew !== pwConfirm) { setPwError("Passwords do not match."); return; }
    const res = await fetch("/account/password", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword: pwNew }),
    });
    if (!res.ok) { const d = await res.json() as { error: string }; setPwError(d.error); return; }
    setPwNew(""); setPwConfirm(""); setPwOk(true);
    setTimeout(() => setPwOk(false), 4000);
  }

  async function uploadAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) { setOpError("Please select an image file."); return; }
    if (file.size > 2 * 1024 * 1024) { setOpError("Avatar must be under 2 MB."); return; }
    const form = new FormData();
    form.append("avatar", file);
    const res = await fetch("/account/avatar", { method: "POST", body: form });
    if (res.ok) setAvatarUrl(`/avatar/${encodeURIComponent(me?.username ?? "")}?t=${Date.now()}`);
    else { const d = await res.json() as { error?: string }; setOpError(d.error ?? "Upload failed"); }
    if (avatarInputRef.current) avatarInputRef.current.value = "";
  }

  const username = me?.username ?? "";

  return (
    <div style={s.page}>
      {/* Header */}
      <div style={s.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {avatarUrl && (
            <img
              src={avatarUrl}
              alt={username}
              style={{ width: 26, height: 26, borderRadius: "50%", objectFit: "cover", background: "#333" }}
              onError={() => setAvatarUrl(null)}
            />
          )}
          <span style={{ fontSize: 15, fontWeight: 600 }}>{username || "…"}</span>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {me?.isAdmin && <a href="/app/admin" style={{ color: "#7af", fontSize: 12 }}>Admin panel</a>}
          <Button variant="ghost" size="sm" onClick={logout}>Sign out</Button>
        </div>
      </div>

      <div style={s.inner}>

        {/* Instance status */}
        <div style={s.card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={s.section}>Instance</div>
            {state && <Badge status={state.status} />}
          </div>
          {state?.lastActive && state.lastActive > 0 && (
            <div style={{ fontSize: 12, color: "#666", marginBottom: 10 }}>
              Last active: {new Date(state.lastActive).toLocaleString()}
            </div>
          )}
          {state?.error && (
            <div style={{ background: "#1a0808", border: "1px solid #5a1010", borderRadius: 4, padding: "8px 12px", marginBottom: 12, color: "#f87171", fontSize: 12 }}>
              {state.error}
            </div>
          )}
          <div style={s.row}>
            <Button size="sm" onClick={() => doOp("restart")} loading={loadingOp === "restart"} disabled={loadingOp !== null}>Restart</Button>
            <Button size="sm" variant="secondary" onClick={() => doOp("update-src")} loading={loadingOp === "update-src"} disabled={loadingOp !== null}>Update source</Button>
            <Button size="sm" variant="secondary" onClick={() => doOp("rebuild-nm")} loading={loadingOp === "rebuild-nm"} disabled={loadingOp !== null}>Rebuild deps</Button>
            <a href="/" style={{ padding: "4px 10px", border: "1px solid #2563eb", borderRadius: 4, color: "#7af", fontSize: 12, textDecoration: "none" }}>
              Open BrowserOS ↗
            </a>
          </div>
          {opError && <div style={s.err}>{opError}</div>}
        </div>

        {/* Profile image */}
        <div style={s.card}>
          <div style={s.section}>Profile image</div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            {avatarUrl
              ? <img src={avatarUrl} alt={username} style={{ width: 52, height: 52, borderRadius: "50%", objectFit: "cover", background: "#333" }} onError={() => setAvatarUrl(null)} />
              : <div style={{ width: 52, height: 52, borderRadius: "50%", background: "#222", border: "1px solid #444", display: "flex", alignItems: "center", justifyContent: "center", color: "#555", fontSize: 18 }}>
                  {username[0]?.toUpperCase() ?? "?"}
                </div>
            }
            <div>
              <Button size="sm" variant="secondary" onClick={() => avatarInputRef.current?.click()}>Upload image</Button>
              <div style={{ fontSize: 11, color: "#666", marginTop: 4 }}>PNG, JPG, GIF, WebP — max 2 MB</div>
            </div>
          </div>
          <input ref={avatarInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={uploadAvatar} />
        </div>

        {/* Password */}
        {!isKeycloak && (
          <div style={s.card}>
            <div style={s.section}>Change password</div>
            {pwError && <div style={s.err}>{pwError}</div>}
            {pwOk && <div style={s.ok}>Password updated.</div>}
            <form onSubmit={changePassword} style={{ display: "flex", flexDirection: "column" as const, gap: 10 }}>
              <div><label style={s.label}>New password</label><input type="password" style={s.input} value={pwNew} onChange={e => setPwNew(e.target.value)} /></div>
              <div><label style={s.label}>Confirm</label><input type="password" style={s.input} value={pwConfirm} onChange={e => setPwConfirm(e.target.value)} /></div>
              <div><Button type="submit" size="sm">Update password</Button></div>
            </form>
          </div>
        )}

        {/* Log */}
        <div style={s.card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: showLog ? 12 : 0 }}>
            <div style={s.section}>Provisioning log</div>
            <Button size="sm" variant="secondary" onClick={loadLog}>Load log</Button>
          </div>
          {showLog && <LogView log={log} />}
        </div>

        {/* Danger zone */}
        <div style={{ ...s.card, borderColor: "#3a1a1a" }}>
          <div style={s.dangerTitle}>Danger zone</div>
          <div style={s.opDesc}>Full re-provision — wipes source, data, and dependencies.</div>
          <Button size="sm" variant="danger" loading={loadingOp === "full"} disabled={loadingOp !== null} onClick={() => doOp("full")}>
            Full re-provision
          </Button>
          <div style={s.sep} />
          <div style={s.opDesc}>Wipe my data — permanently destroys your VFS files and conversation history. Source is preserved.</div>
          <Button size="sm" variant="danger" loading={loadingOp === "wipe"} disabled={loadingOp !== null} onClick={() => setWipeDialog(true)}>
            Wipe my data
          </Button>
        </div>
      </div>

      <Dialog
        open={wipeDialog}
        title="Wipe your BOS data?"
        message={`This will permanently delete your VFS files and conversation history inside BrowserOS.\n\nYour profile image and provisioning log are preserved.\n\nThis cannot be undone.`}
        onConfirm={doWipe}
        onCancel={() => setWipeDialog(false)}
        confirmLabel="Yes, wipe my data"
        dangerous
      />
    </div>
  );
}
