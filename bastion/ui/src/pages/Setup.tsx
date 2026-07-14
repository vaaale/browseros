import { useState, useEffect, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

interface SetupState { needsBootstrap: boolean; authProvider: string; }

const s = {
  page:  { minHeight: "100vh", background: "#0f0f0f", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 },
  box:   { background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, padding: 32, width: 360, maxWidth: "100%" },
  title: { fontSize: 22, fontWeight: 600, color: "#eee", marginBottom: 6 },
  sub:   { fontSize: 13, color: "#888", marginBottom: 24 },
  label: { display: "block", marginBottom: 4, fontSize: 12, color: "#aaa" },
  input: { width: "100%", padding: "8px 12px", background: "#0f0f0f", border: "1px solid #444", borderRadius: 4, color: "#eee", fontSize: 13, marginBottom: 14, outline: "none", boxSizing: "border-box" as const },
  btn:   { width: "100%", padding: "10px 0", background: "#2563eb", border: "none", borderRadius: 4, color: "#fff", fontSize: 13, cursor: "pointer" },
  err:   { color: "#f87171", fontSize: 12, marginBottom: 12 },
  kc:    { fontSize: 13, color: "#aaa", lineHeight: 1.6, marginBottom: 20 },
  kcBtn: { width: "100%", padding: "10px 0", background: "#111", border: "1px solid #2563eb", borderRadius: 4, color: "#7af", fontSize: 13, cursor: "pointer", textDecoration: "none", display: "block", textAlign: "center" as const },
};

export default function Setup() {
  const [state, setState] = useState<SetupState | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    fetch("/setup/state")
      .then(r => r.json() as Promise<SetupState>)
      .then(d => {
        if (!d.needsBootstrap && d.authProvider === "simple") navigate("/login", { replace: true });
        else setState(d);
      })
      .catch(() => navigate("/login", { replace: true }));
  }, [navigate]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault(); setError("");
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (password !== confirm) { setError("Passwords do not match."); return; }
    setLoading(true);
    const res = await fetch("/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setLoading(false);
    if (res.ok) { window.location.href = "/app/admin"; return; }
    const d = await res.json() as { error?: string };
    setError(d.error ?? "Setup failed");
  }

  if (!state) return (
    <div style={s.page}><span style={{ color: "#555", fontSize: 13 }}>Loading…</span></div>
  );

  if (state.authProvider === "keycloak") return (
    <div style={s.page}>
      <div style={s.box}>
        <div style={s.title}>BrowserOS</div>
        <p style={s.kc}>
          This deployment uses Keycloak for authentication. Users and roles are managed
          in the Keycloak admin console — no password setup is required here.
        </p>
        <a href="/auth/keycloak" style={s.kcBtn}>Sign in with Keycloak</a>
      </div>
    </div>
  );

  return (
    <div style={s.page}>
      <div style={s.box}>
        <div style={s.title}>Welcome to BrowserOS</div>
        <div style={s.sub}>Set the admin password to get started. This only appears on first run.</div>
        {error && <div style={s.err}>{error}</div>}
        <form onSubmit={handleSubmit}>
          <label style={s.label}>Admin password</label>
          <input type="password" style={s.input} value={password} onChange={e => setPassword(e.target.value)} autoFocus required />
          <label style={s.label}>Confirm password</label>
          <input type="password" style={s.input} value={confirm} onChange={e => setConfirm(e.target.value)} required />
          <button type="submit" style={{ ...s.btn, opacity: loading ? 0.6 : 1 }} disabled={loading}>
            {loading ? "Setting up…" : "Set admin password"}
          </button>
        </form>
      </div>
    </div>
  );
}
