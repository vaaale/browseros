import { useState, type FormEvent } from "react";

const s = {
  page:   { minHeight: "100vh", background: "#0f0f0f", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 },
  box:    { background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, padding: 32, width: 320 },
  title:  { fontSize: 22, fontWeight: 600, color: "#eee", textAlign: "center" as const, marginBottom: 24 },
  label:  { display: "block", marginBottom: 4, fontSize: 12, color: "#aaa" },
  input:  { width: "100%", padding: "8px 12px", background: "#0f0f0f", border: "1px solid #444", borderRadius: 4, color: "#eee", fontSize: 13, marginBottom: 14, outline: "none", boxSizing: "border-box" as const },
  btn:    { width: "100%", padding: "10px 0", background: "#2563eb", border: "none", borderRadius: 4, color: "#fff", fontSize: 13, cursor: "pointer", marginBottom: 8 },
  err:    { color: "#f87171", fontSize: 12, marginBottom: 12 },
  sep:    { textAlign: "center" as const, color: "#555", margin: "12px 0", fontSize: 12 },
  kcBtn:  { width: "100%", padding: "10px 0", background: "#111", border: "1px solid #2563eb", borderRadius: 4, color: "#7af", fontSize: 13, cursor: "pointer", textDecoration: "none", display: "block", textAlign: "center" as const },
};

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true); setError("");
    const res = await fetch("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    setLoading(false);
    if (res.ok) { window.location.href = "/"; return; }
    setError("Invalid username or password");
  }

  return (
    <div style={s.page}>
      <div style={s.box}>
        <div style={s.title}>BrowserOS</div>
        {error && <div style={s.err}>{error}</div>}
        <form onSubmit={handleSubmit}>
          <label style={s.label}>Username</label>
          <input style={s.input} value={username} onChange={e => setUsername(e.target.value)} autoFocus />
          <label style={s.label}>Password</label>
          <input style={s.input} type="password" value={password} onChange={e => setPassword(e.target.value)} />
          <button style={{ ...s.btn, opacity: loading ? 0.6 : 1 }} disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <div style={s.sep}>or</div>
        <a href="/auth/keycloak" style={s.kcBtn}>Sign in with Keycloak</a>
      </div>
    </div>
  );
}
