import { useState, useEffect, useRef, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/Button";
import { Badge } from "../components/Badge";
import { Card } from "../components/Card";
import { Dialog } from "../components/Dialog";
import { LogView } from "../components/LogView";

interface Me { username: string; isAdmin: boolean; }
interface InstanceState { username: string; status: string; lastActive: number; error?: string; }
interface SetupState { authProvider: string; }

export default function Account() {
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<InstanceState | null>(null);
  const [setupState, setSetupState] = useState<SetupState | null>(null);
  const [log, setLog] = useState("");
  const [showLog, setShowLog] = useState(false);
  const [loadingOp, setLoadingOp] = useState<string | null>(null);
  const [opError, setOpError] = useState("");
  const [wipeDialog, setWipeDialog] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  // Password change
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwError, setPwError] = useState("");
  const [pwSuccess, setPwSuccess] = useState(false);

  const navigate = useNavigate();
  const isKeycloak = setupState?.authProvider === "keycloak";

  useEffect(() => {
    void Promise.all([
      fetch("/account/me").then((r) => (r.ok ? r.json() : null)).then((d) => {
        if (!d) { navigate("/login"); return; }
        setMe(d as Me);
        // Build avatar URL using the username.
        setAvatarUrl(`/avatar/${encodeURIComponent((d as Me).username)}`);
      }),
      fetch("/account/instance").then((r) => r.json()).then((d) => setState(d as InstanceState)),
      fetch("/setup/state").then((r) => (r.ok ? r.json() : null)).then((d) => setSetupState(d as SetupState)),
    ]);
  }, [navigate]);

  async function doOp(op: string) {
    setLoadingOp(op);
    setOpError("");
    const res = await fetch("/account/reprovision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: op, confirm: true }),
    });
    setLoadingOp(null);
    if (!res.ok) {
      const d = await res.json() as { error: string };
      setOpError(d.error);
      return;
    }
    window.location.href = "/";
  }

  async function doWipe() {
    setWipeDialog(false);
    setLoadingOp("wipe");
    setOpError("");
    const res = await fetch("/account/wipe-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    setLoadingOp(null);
    if (!res.ok) {
      const d = await res.json() as { error: string };
      setOpError(d.error);
      return;
    }
    // Refresh instance state
    const inst = await fetch("/account/instance").then((r) => r.json());
    setState(inst as InstanceState);
  }

  async function logout() {
    await fetch("/logout", { method: "POST" });
    navigate("/login");
  }

  async function loadLog() {
    const res = await fetch("/account/log");
    if (res.ok) {
      const d = await res.json() as { log: string };
      setLog(d.log);
      setShowLog(true);
    }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    setPwError("");
    setPwSuccess(false);
    if (pwNew.length < 8) { setPwError("New password must be at least 8 characters."); return; }
    if (pwNew !== pwConfirm) { setPwError("Passwords do not match."); return; }
    const res = await fetch("/account/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword: pwNew }),
    });
    if (!res.ok) {
      const d = await res.json() as { error: string };
      setPwError(d.error);
      return;
    }
    setPwCurrent(""); setPwNew(""); setPwConfirm("");
    setPwSuccess(true);
    setTimeout(() => setPwSuccess(false), 4000);
  }

  async function uploadAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) { setOpError("Please select an image file."); return; }
    if (file.size > 2 * 1024 * 1024) { setOpError("Avatar must be under 2 MB."); return; }
    const form = new FormData();
    form.append("avatar", file);
    const res = await fetch("/account/avatar", { method: "POST", body: form });
    if (res.ok) {
      // Cache-bust the avatar URL after upload.
      setAvatarUrl(`/avatar/${encodeURIComponent(me?.username ?? "")}?t=${Date.now()}`);
    } else {
      const d = await res.json() as { error?: string };
      setOpError(d.error ?? "Upload failed");
    }
    // Reset file input so the same file can be selected again.
    if (avatarInputRef.current) avatarInputRef.current.value = "";
  }

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      {/* Header */}
      <div className="border-b border-gray-700 bg-gray-800/50">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {avatarUrl && (
              <img
                src={avatarUrl}
                alt="avatar"
                className="w-7 h-7 rounded-full object-cover bg-gray-700"
                onError={() => setAvatarUrl(null)}
              />
            )}
            <span className="font-semibold text-white">{me?.username ?? "…"}</span>
          </div>
          <div className="flex items-center gap-3">
            {me?.isAdmin && <a href="/app/admin" className="text-sm text-blue-400 hover:text-blue-300">Admin panel</a>}
            <Button variant="ghost" size="sm" onClick={logout}>Sign out</Button>
          </div>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">

        {/* Instance status */}
        <Card>
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-gray-300">Instance</span>
            {state && <Badge status={state.status} />}
          </div>
          {state?.lastActive && state.lastActive > 0 && (
            <div className="text-xs text-gray-500 mb-3">
              Last active: {new Date(state.lastActive).toLocaleString()}
            </div>
          )}
          {state?.error && (
            <div className="mb-3 px-3 py-2 bg-red-900/30 border border-red-700 rounded text-red-300 text-xs">
              Error: {state.error}
            </div>
          )}
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" onClick={() => doOp("restart")} loading={loadingOp === "restart"} disabled={loadingOp !== null}>
              Restart
            </Button>
            <Button size="sm" variant="secondary" onClick={() => doOp("update-src")} loading={loadingOp === "update-src"} disabled={loadingOp !== null}>
              Update source
            </Button>
            <Button size="sm" variant="secondary" onClick={() => doOp("rebuild-nm")} loading={loadingOp === "rebuild-nm"} disabled={loadingOp !== null}>
              Rebuild deps
            </Button>
            <a href="/" className="inline-flex items-center px-3 py-1.5 text-sm border border-blue-600 text-blue-400 hover:bg-blue-900/30 rounded font-medium transition-colors">
              Open BrowserOS
            </a>
          </div>
          {opError && <div className="mt-2 text-red-400 text-xs">{opError}</div>}
        </Card>

        {/* Profile image */}
        <Card>
          <div className="text-sm font-medium text-gray-300 mb-3">Profile image</div>
          <div className="flex items-center gap-4">
            {avatarUrl
              ? <img src={avatarUrl} alt="avatar" className="w-14 h-14 rounded-full object-cover bg-gray-700" onError={() => setAvatarUrl(null)} />
              : <div className="w-14 h-14 rounded-full bg-gray-700 flex items-center justify-center text-gray-500 text-xl">{me?.username?.[0]?.toUpperCase() ?? "?"}</div>
            }
            <div>
              <Button size="sm" variant="secondary" onClick={() => avatarInputRef.current?.click()}>
                Upload image
              </Button>
              <p className="text-xs text-gray-500 mt-1">PNG, JPG, GIF, WebP — max 2 MB</p>
            </div>
          </div>
          <input ref={avatarInputRef} type="file" accept="image/*" className="hidden" onChange={uploadAvatar} />
        </Card>

        {/* Password change (simple auth only) */}
        {!isKeycloak && (
          <Card>
            <div className="text-sm font-medium text-gray-300 mb-3">Change password</div>
            {pwError && <div className="mb-3 text-red-400 text-xs">{pwError}</div>}
            {pwSuccess && <div className="mb-3 text-green-400 text-xs">Password updated.</div>}
            <form onSubmit={changePassword} className="space-y-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">New password</label>
                <input
                  type="password"
                  value={pwNew}
                  onChange={(e) => setPwNew(e.target.value)}
                  className="w-full max-w-xs px-2.5 py-1.5 bg-gray-900 border border-gray-600 rounded text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Confirm new password</label>
                <input
                  type="password"
                  value={pwConfirm}
                  onChange={(e) => setPwConfirm(e.target.value)}
                  className="w-full max-w-xs px-2.5 py-1.5 bg-gray-900 border border-gray-600 rounded text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                />
              </div>
              <Button type="submit" size="sm">Update password</Button>
            </form>
          </Card>
        )}

        {/* Provisioning log */}
        <Card>
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-gray-300">Provisioning log</span>
            <Button size="sm" variant="secondary" onClick={loadLog}>Load log</Button>
          </div>
          {showLog && <LogView log={log} />}
        </Card>

        {/* Danger zone */}
        <Card>
          <div className="text-sm font-medium text-red-400 mb-3">Danger zone</div>
          <div className="space-y-3">
            <div>
              <div className="text-xs text-gray-400 mb-1.5">
                Full re-provision — wipes source, data, and dependencies. A clean slate.
              </div>
              <Button size="sm" variant="danger" loading={loadingOp === "full"} disabled={loadingOp !== null} onClick={() => doOp("full")}>
                Full re-provision
              </Button>
            </div>
            <div className="border-t border-gray-700 pt-3">
              <div className="text-xs text-gray-400 mb-1.5">
                Wipe my data — permanently destroys your VFS files and conversation history. Source code is preserved.
              </div>
              <Button size="sm" variant="danger" loading={loadingOp === "wipe"} disabled={loadingOp !== null} onClick={() => setWipeDialog(true)}>
                Wipe my data
              </Button>
            </div>
          </div>
        </Card>
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
