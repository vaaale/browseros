"use client";

import { useCallback, useEffect, useState } from "react";
import {
  GitBranch,
  Globe,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  Settings,
  Trash2,
  Wifi,
  WifiOff,
  AlertCircle,
  X,
} from "lucide-react";
import { sessionHeader } from "@/lib/logging/client/session";

interface GitRemote {
  name: string;
  url: string;
  provider: "github" | "gitlab" | "generic";
  autoPush: boolean;
  defaultBranch?: string;
  lastFetched?: string;
  lastPushed?: string;
  inGitConfig: boolean;
  status: string;
}

type AuthType = "token" | "oauth" | "ssh";

function ProviderIcon({ provider, size = 14 }: { provider: string; size?: number }) {
  if (provider === "github") {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
      </svg>
    );
  }
  if (provider === "gitlab") {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor">
        <path d="M15.545 6.423L10.374.377a.457.457 0 00-.851.178L8.258 6.423H7.742l.271-5.868a.457.457 0 00-.851-.178L.455 6.423A.55.55 0 00.5 6.9v.207a.55.55 0 00.385.524l3.717 1.177-2.046 6.14a.457.457 0 00.62.577L8 13.09l4.864 2.435a.457.457 0 00.62-.577l-2.046-6.14 3.717-1.177A.55.55 0 0015.5 7.107V.69a.55.55 0 00.045-.267z" />
      </svg>
    );
  }
  return <Globe size={size} className="text-white/50" />;
}

function ProviderBadge({ provider }: { provider: string }) {
  const label = provider === "github" ? "GitHub" : provider === "gitlab" ? "GitLab" : "Generic";
  const color = provider === "github" ? "text-white" : provider === "gitlab" ? "text-orange-400" : "text-white/50";
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] ${color}`}>
      <ProviderIcon provider={provider} size={12} />
      {label}
    </span>
  );
}

function StatusIndicator({ status }: { status: string }) {
  if (status === "connected") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
        Connected
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-amber-400">
        <AlertCircle size={10} />
        Error
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-white/40">
      <WifiOff size={10} />
      Not connected
    </span>
  );
}

function formatTime(iso?: string): string {
  if (!iso) return "Never";
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60_000) return "Just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

interface AddRemoteModalProps {
  open: boolean;
  onClose: () => void;
  onAdd: (data: {
    name: string;
    url: string;
    provider: "github" | "gitlab" | "generic";
    authType: AuthType;
    token?: string;
    autoPush: boolean;
  }) => Promise<void>;
}

function AddRemoteModal({ open, onClose, onAdd }: AddRemoteModalProps) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [provider, setProvider] = useState<"github" | "gitlab" | "generic">("generic");
  const [authType, setAuthType] = useState<AuthType>("token");
  const [token, setToken] = useState("");
  const [autoPush, setAutoPush] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setName("");
      setUrl("");
      setProvider("generic");
      setAuthType("token");
      setToken("");
      setAutoPush(false);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (/github\.com/i.test(url)) setProvider("github");
    else if (/gitlab\.com/i.test(url)) setProvider("gitlab");
  }, [url]);

  const submit = async () => {
    if (!name.trim() || !url.trim()) {
      setError("Name and URL are required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onAdd({ name: name.trim(), url: url.trim(), provider, authType, token: token || undefined, autoPush });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md rounded-lg border border-white/10 bg-neutral-900 p-4 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h4 className="text-sm font-semibold">Add Remote</h4>
          <button onClick={onClose} className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white">
            <X size={14} />
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-[11px] text-white/50">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="origin"
              className="w-full rounded border border-white/10 bg-black/30 px-2.5 py-1.5 text-xs outline-none focus:border-white/30"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-white/50">URL</label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/user/repo.git"
              className="w-full rounded border border-white/10 bg-black/30 px-2.5 py-1.5 text-xs outline-none focus:border-white/30"
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="mb-1 block text-[11px] text-white/50">Provider</label>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value as "github" | "gitlab" | "generic")}
                className="w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-white outline-none focus:border-white/30"
              >
                <option value="github" className="bg-neutral-900">GitHub</option>
                <option value="gitlab" className="bg-neutral-900">GitLab</option>
                <option value="generic" className="bg-neutral-900">Generic</option>
              </select>
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-[11px] text-white/50">Auth Type</label>
              <select
                value={authType}
                onChange={(e) => setAuthType(e.target.value as AuthType)}
                className="w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-white outline-none focus:border-white/30"
              >
                <option value="token" className="bg-neutral-900">Token (PAT)</option>
                <option value="oauth" className="bg-neutral-900">OAuth</option>
                <option value="ssh" className="bg-neutral-900">SSH Key</option>
              </select>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-white/50">Token / Key (optional)</label>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="ghp_..."
              className="w-full rounded border border-white/10 bg-black/30 px-2.5 py-1.5 text-xs outline-none focus:border-white/30"
            />
          </div>
          <label className="flex items-center gap-2 text-[12px] text-white/70">
            <input
              type="checkbox"
              checked={autoPush}
              onChange={(e) => setAutoPush(e.target.checked)}
              className="h-3.5 w-3.5 accent-violet-500"
            />
            Auto-push on version promote
          </label>
          {error && (
            <div className="flex items-start gap-2 rounded border border-red-400/30 bg-red-500/10 p-2 text-[11px] text-red-200">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded border border-white/15 px-3 py-1.5 text-[11px] font-medium text-white/70 hover:bg-white/10"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || !name.trim() || !url.trim()}
            className="inline-flex items-center gap-1.5 rounded bg-violet-500/80 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-violet-500 disabled:opacity-50"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            {busy ? "Adding…" : "Add Remote"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface EditRemoteModalProps {
  open: boolean;
  remote: GitRemote | null;
  onClose: () => void;
  onSave: (name: string, patch: Partial<GitRemote>) => Promise<void>;
}

function EditRemoteModal({ open, remote, onClose, onSave }: EditRemoteModalProps) {
  const [provider, setProvider] = useState<"github" | "gitlab" | "generic">("generic");
  const [autoPush, setAutoPush] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (remote) {
      setProvider(remote.provider);
      setAutoPush(remote.autoPush);
    }
  }, [remote]);

  const submit = async () => {
    if (!remote) return;
    setBusy(true);
    try {
      await onSave(remote.name, { provider, autoPush });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  if (!open || !remote) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-sm rounded-lg border border-white/10 bg-neutral-900 p-4 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h4 className="text-sm font-semibold">Edit Remote — {remote.name}</h4>
          <button onClick={onClose} className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white">
            <X size={14} />
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-[11px] text-white/50">Provider</label>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as "github" | "gitlab" | "generic")}
              className="w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-white outline-none focus:border-white/30"
            >
              <option value="github" className="bg-neutral-900">GitHub</option>
              <option value="gitlab" className="bg-neutral-900">GitLab</option>
              <option value="generic" className="bg-neutral-900">Generic</option>
            </select>
          </div>
          <label className="flex items-center gap-2 text-[12px] text-white/70">
            <input
              type="checkbox"
              checked={autoPush}
              onChange={(e) => setAutoPush(e.target.checked)}
              className="h-3.5 w-3.5 accent-violet-500"
            />
            Auto-push on version promote
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded border border-white/15 px-3 py-1.5 text-[11px] font-medium text-white/70 hover:bg-white/10"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded bg-violet-500/80 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-violet-500 disabled:opacity-50"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Settings size={12} />}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

export function GitRemotesTab() {
  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editRemote, setEditRemote] = useState<GitRemote | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch("/api/git-remotes");
      if (!res.ok) throw new Error("Failed to load remotes");
      const data = await res.json();
      setRemotes(data.remotes ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  const api = async (action: string, body: Record<string, unknown> = {}) => {
    setBusyAction(action);
    setMsg(null);
    try {
      const res = await fetch("/api/git-remotes", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionHeader() },
        body: JSON.stringify({ action, ...body }),
      });
      const data = await res.json();
      if (data.error) {
        setMsg(`Error: ${data.error.message ?? data.error}`);
      } else {
        setMsg(data.message ?? "Done.");
      }
      await load();
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
    } finally {
      setBusyAction(null);
    }
  };

  const addRemote = async (data: {
    name: string;
    url: string;
    provider: "github" | "gitlab" | "generic";
    authType: AuthType;
    token?: string;
    autoPush: boolean;
  }) => {
    await api("add", data);
  };

  const removeRemote = async (name: string) => {
    if (!confirm(`Remove remote '${name}'? This will also delete stored credentials.`)) return;
    await api("remove", { name });
  };

  const toggleAutoPush = async (remote: GitRemote) => {
    await api("update", { name: remote.name, patch: { autoPush: !remote.autoPush } });
  };

  const saveRemote = async (name: string, patch: Partial<GitRemote>) => {
    await api("update", { name, patch });
  };

  const btn = "rounded px-2 py-1 text-[11px] font-medium disabled:opacity-40";

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-white/40">
        <Loader2 size={14} className="animate-spin" />
        Loading remotes…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-white/50">Git Remotes</h4>
          <p className="mt-1 text-[11px] text-white/40">
            Manage remote repositories for push/fetch operations.
          </p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="inline-flex items-center gap-1.5 rounded bg-violet-500/80 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-violet-500"
        >
          <Plus size={12} />
          Add Remote
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded border border-red-400/30 bg-red-500/10 p-2.5 text-[11px] text-red-200">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {remotes.length === 0 ? (
        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-6 text-center">
          <GitBranch size={24} className="mx-auto mb-2 text-white/20" />
          <p className="text-[12px] text-white/40">No git remotes configured.</p>
          <p className="mt-1 text-[11px] text-white/30">
            Add a remote to push and fetch from external repositories.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {remotes.map((remote) => (
            <div
              key={remote.name}
              className="rounded-lg border border-white/10 bg-white/[0.03] p-3"
            >
              <div className="flex items-start justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium">{remote.name}</span>
                    <ProviderBadge provider={remote.provider} />
                    <StatusIndicator status={remote.status} />
                  </div>
                  <div className="mt-1 truncate text-[11px] text-white/40">{remote.url}</div>
                  <div className="mt-1.5 flex items-center gap-4 text-[10px] text-white/30">
                    <span>Last push: {formatTime(remote.lastPushed)}</span>
                    <span>Last fetch: {formatTime(remote.lastFetched)}</span>
                  </div>
                </div>
                <label className="flex items-center gap-1.5 text-[11px] text-white/60" title="Auto-push on version promote">
                  <input
                    type="checkbox"
                    checked={remote.autoPush}
                    onChange={() => toggleAutoPush(remote)}
                    disabled={busyAction !== null}
                    className="h-3.5 w-3.5 accent-violet-500"
                  />
                  Auto-push
                </label>
              </div>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                <button
                  disabled={busyAction !== null}
                  onClick={() => void api("push", { name: remote.name })}
                  className={`${btn} inline-flex items-center gap-1 bg-sky-500/20 hover:bg-sky-500/30`}
                >
                  {busyAction === `push-${remote.name}` ? <Loader2 size={10} className="animate-spin" /> : <Send size={10} />}
                  Push
                </button>
                <button
                  disabled={busyAction !== null}
                  onClick={() => void api("fetch", { name: remote.name })}
                  className={`${btn} inline-flex items-center gap-1 bg-white/10 hover:bg-white/20`}
                >
                  {busyAction === `fetch-${remote.name}` ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                  Fetch
                </button>
                <button
                  disabled={busyAction !== null}
                  onClick={() => void api("test", { name: remote.name })}
                  className={`${btn} inline-flex items-center gap-1 bg-white/10 hover:bg-white/20`}
                >
                  {busyAction === `test-${remote.name}` ? <Loader2 size={10} className="animate-spin" /> : <Wifi size={10} />}
                  Test
                </button>
                <button
                  disabled={busyAction !== null}
                  onClick={() => setEditRemote(remote)}
                  className={`${btn} inline-flex items-center gap-1 bg-white/10 hover:bg-white/20`}
                >
                  <Settings size={10} />
                  Edit
                </button>
                <button
                  disabled={busyAction !== null}
                  onClick={() => void removeRemote(remote.name)}
                  className={`${btn} inline-flex items-center gap-1 bg-red-500/15 text-red-300/80 hover:bg-red-500/25`}
                >
                  <Trash2 size={10} />
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {msg && (
        <div className="text-[11px] text-white/50">{msg}</div>
      )}

      <AddRemoteModal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        onAdd={addRemote}
      />
      <EditRemoteModal
        open={editRemote !== null}
        remote={editRemote}
        onClose={() => setEditRemote(null)}
        onSave={saveRemote}
      />
    </div>
  );
}
