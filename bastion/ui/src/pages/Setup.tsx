import { useState, useEffect, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

interface SetupState {
  needsBootstrap: boolean;
  authProvider: string;
}

export default function Setup() {
  const [state, setState] = useState<SetupState | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    fetch("/setup/state")
      .then((r) => r.json() as Promise<SetupState>)
      .then((d) => {
        if (!d.needsBootstrap && d.authProvider === "simple") {
          navigate("/login", { replace: true });
        } else {
          setState(d);
        }
      })
      .catch(() => navigate("/login", { replace: true }));
  }, [navigate]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
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
    <div className="min-h-screen bg-gray-900 flex items-center justify-center">
      <span className="text-gray-500 text-sm">Loading…</span>
    </div>
  );

  if (state.authProvider === "keycloak") {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-8 max-w-md w-full">
          <div className="text-xl font-semibold text-white mb-2">BrowserOS</div>
          <div className="text-sm text-gray-400 mb-6">
            This deployment uses Keycloak for authentication. Users and roles are managed
            in the Keycloak admin console — no password setup is required here.
          </div>
          <a
            href="/auth/keycloak"
            className="block w-full text-center px-4 py-2.5 bg-blue-700 hover:bg-blue-600 text-white rounded-lg text-sm font-medium transition-colors"
          >
            Sign in with Keycloak
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
      <div className="bg-gray-800 border border-gray-700 rounded-xl p-8 max-w-md w-full">
        <div className="text-xl font-semibold text-white mb-1">Welcome to BrowserOS</div>
        <p className="text-sm text-gray-400 mb-6">
          Set the admin password to get started. This only appears on first run.
        </p>

        {error && (
          <div className="mb-4 px-3 py-2 bg-red-900/40 border border-red-700 rounded text-red-300 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Admin password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-sm text-gray-100 focus:outline-none focus:border-blue-500"
              autoFocus
              required
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Confirm password</label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-sm text-gray-100 focus:outline-none focus:border-blue-500"
              required
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
          >
            {loading ? "Setting up…" : "Set admin password"}
          </button>
        </form>
      </div>
    </div>
  );
}
