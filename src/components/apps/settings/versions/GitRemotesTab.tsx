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
  KeyRound,
  X,
} from "lucide-react";
import { sessionHeader } from "@/lib/logging/client/session";

type Provider = "github" | "gitlab" | "generic";
type AuthType = "token" | "oauth" | "ssh";

interface GitRemote {
  name: string;
  url: string;
  provider: Provider;
  autoPush: boolean;
  defaultBranch?: string;
  lastFetched?: string;
  lastPushed?: string;
  filesystem: string;
  inGitConfig: boolean;
  status: string;
  lastError?: string;
}

interface GitFsInstance {
  id: string;
  label: string;
  vfsPath: string;
  root: string;
}

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

function StatusIndicator({ status, error }: { status: string; error?: string }) {
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
      <span className="inline-flex items-center gap-1 text-[11px] text-amber-400" title={error}>
        <AlertCircle size={10} />
        Error
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-white/40">
      <WifiOff size={10} />
      Disconnected
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

// ── OAuth credential configuration ─────────────────────────────────────────────
// GitHub/GitLab remotes need OAuth client credentials before a browser OAuth flow
// can run. Rather than a standalone settings tab, this panel is shown inline in the
// add/edit flow whenever an OAuth-capable provider is selected.
function OAuthCredentialsPanel({ provider }: { provider: Provider }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/integrations/git-providers");
      if (!res.ok) return;
      const data = await res.json();
      const p = (data.providers ?? []).find((x: { id: string }) => x.id === provider);
      setConfigured(p ? Boolean(p.hasClientCredentials) : false);
    } catch {
      setConfigured(false);
    }
  }, [provider]);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  const save = async () => {
    if (!clientId.trim() || !clientSecret.trim()) {
      setMsg("Client ID and Client Secret are required.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/integrations/git-providers", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionHeader() },
        body: JSON.stringify({ action: "set-credentials", providerId: provider, clientId: clientId.trim(), clientSecret: clientSecret.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(data.error ?? "Failed to save credentials.");
      } else {
        setMsg("OAuth credentials saved.");
        setClientId("");
        setClientSecret("");
        setOpen(false);
        await load();
      }
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const providerName = provider === "github" ? "GitHub" : "GitLab";

  return (
    <div className="rounded border border-white/10 bg-black/20 p-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[11px] text-white/70">
          <KeyRound size={12} />
          {providerName} OAuth credentials
        </div>
        {configured === null ? (
          <Loader2 size={12} className="animate-spin text-white/40" />
        ) : configured ? (
          <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Configured
          </span>
        ) : (
          <span className="text-[10px] text-amber-400">Not configured</span>
        )}
      </div>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-1.5 text-[11px] text-violet-300 hover:text-violet-200"
        >
          {configured ? "Update credentials" : "Configure credentials"}
        </button>
      )}
      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-[10px] text-white/40">
            Create an OAuth app on {providerName} with callback{" "}
            <code className="text-white/60">/api/git-remotes/oauth/callback</code>, then paste its Client ID and Secret.
          </p>
          <input
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="Client ID"
            className="w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-[11px] outline-none focus:border-white/30"
          />
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder="Client Secret"
            className="w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-[11px] outline-none focus:border-white/30"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => { setOpen(false); setMsg(null); }}
              className="rounded border border-white/15 px-2 py-1 text-[10px] text-white/70 hover:bg-white/10"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded bg-violet-500/80 px-2 py-1 text-[10px] font-medium text-white hover:bg-violet-500 disabled:opacity-50"
            >
              {busy && <Loader2 size={10} className="animate-spin" />}
              Save
            </button>
          </div>
        </div>
      )}
      {msg && <div className="mt-1.5 text-[10px] text-white/50">{msg}</div>}
    </div>
  );
}

// ── Add remote modal ────────────────────────────────────────────────────────────
interface AddRemoteModalProps {
  open: boolean;
  filesystem: GitFsInstance | null;
  onClose: () => void;
  onAdd: (data: {
    name: string;
    url: string;
    provider: Provider;
    authType: AuthType;
    token?: string;
    defaultBranch?: string;
    autoPush: boolean;
  }) => Promise<void>;
}

function AddRemoteModal({ open, filesystem, onClose, onAdd }: AddRemoteModalProps) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [provider, setProvider] = useState<Provider>("generic");
  const [authType, setAuthType] = useState<AuthType>("token");
  const [token, setToken] = useState("");
  const [branch, setBranch] = useState("");
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
      setBranch("");
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
      await onAdd({
        name: name.trim(),
        url: url.trim(),
        provider,
        authType,
        token: token || undefined,
        defaultBranch: branch.trim() || undefined,
        autoPush,
      });
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
          <h4 className="text-sm font-semibold">Add Remote{filesystem ? ` — ${filesystem.label}` : ""}</h4>
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
                onChange={(e) => setProvider(e.target.value as Provider)}
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
            <label className="mb-1 block text-[11px] text-white/50">Branch (for push/pull)</label>
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
              className="w-full rounded border border-white/10 bg-black/30 px-2.5 py-1.5 text-xs outline-none focus:border-white/30"
            />
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
          {(provider === "github" || provider === "gitlab") && authType === "oauth" && (
            <OAuthCredentialsPanel provider={provider} />
          )}
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

// ── Edit remote modal ───────────────────────────────────────────────────────────
interface EditRemoteModalProps {
  open: boolean;
  remote: GitRemote | null;
  filesystem: GitFsInstance | null;
  onClose: () => void;
  onSave: (originalName: string, patch: { name: string; provider: Provider; url: string; defaultBranch?: string }) => Promise<void>;
}

function EditRemoteModal({ open, remote, filesystem, onClose, onSave }: EditRemoteModalProps) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [provider, setProvider] = useState<Provider>("generic");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (remote) {
      setName(remote.name);
      setUrl(remote.url);
      setProvider(remote.provider);
      setBranch(remote.defaultBranch ?? "");
      setError(null);
    }
  }, [remote]);

  const submit = async () => {
    if (!remote) return;
    if (!name.trim() || !url.trim()) {
      setError("Name and URL are required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(remote.name, {
        name: name.trim(),
        provider,
        url: url.trim(),
        defaultBranch: branch.trim() || undefined,
      });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open || !remote) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md rounded-lg border border-white/10 bg-neutral-900 p-4 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h4 className="text-sm font-semibold">Edit Remote — {remote.name}</h4>
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
              className="w-full rounded border border-white/10 bg-black/30 px-2.5 py-1.5 text-xs outline-none focus:border-white/30"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-white/50">URL</label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="w-full rounded border border-white/10 bg-black/30 px-2.5 py-1.5 text-xs outline-none focus:border-white/30"
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="mb-1 block text-[11px] text-white/50">Provider</label>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value as Provider)}
                className="w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-white outline-none focus:border-white/30"
              >
                <option value="github" className="bg-neutral-900">GitHub</option>
                <option value="gitlab" className="bg-neutral-900">GitLab</option>
                <option value="generic" className="bg-neutral-900">Generic</option>
              </select>
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-[11px] text-white/50">Branch (for push/pull)</label>
              <input
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="main"
                className="w-full rounded border border-white/10 bg-black/30 px-2.5 py-1.5 text-xs outline-none focus:border-white/30"
              />
            </div>
          </div>
          {(provider === "github" || provider === "gitlab") && (
            <OAuthCredentialsPanel provider={provider} />
          )}
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
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Settings size={12} />}
            Save
          </button>
        </div>
        {filesystem && (
          <p className="mt-2 text-[10px] text-white/30">Filesystem: {filesystem.vfsPath}</p>
        )}
      </div>
    </div>
  );
}

// ── Filesystem card ─────────────────────────────────────────────────────────────
interface FilesystemCardProps {
  fs: GitFsInstance;
  remotes: GitRemote[] | undefined;
  busyAction: string | null;
  onAdd: () => void;
  onEdit: (remote: GitRemote) => void;
  onAction: (action: string, remote: GitRemote) => void;
}

function FilesystemCard({ fs, remotes, busyAction, onAdd, onEdit, onAction }: FilesystemCardProps) {
  const btn = "rounded px-2 py-1 text-[11px] font-medium disabled:opacity-40";
  const loading = remotes === undefined;
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03]">
      <div className="flex items-start justify-between border-b border-white/10 px-3.5 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <GitBranch size={14} className="text-white/40" />
            <h4 className="text-[13px] font-semibold">{fs.label}</h4>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-white/40" title={fs.root}>{fs.vfsPath}</p>
        </div>
        <button
          onClick={onAdd}
          className="inline-flex shrink-0 items-center gap-1.5 rounded bg-violet-500/80 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-violet-500"
        >
          <Plus size={12} />
          Add Remote
        </button>
      </div>

      <div className="p-3">
        {loading ? (
          <div className="flex items-center gap-2 text-[11px] text-white/40">
            <Loader2 size={12} className="animate-spin" />
            Loading remotes…
          </div>
        ) : remotes.length === 0 ? (
          <p className="py-2 text-center text-[11px] text-white/35">No remotes configured for this filesystem.</p>
        ) : (
          <div className="space-y-2">
            {remotes.map((remote) => (
              <div key={remote.name} className="rounded border border-white/10 bg-black/20 p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[12px] font-medium">{remote.name}</span>
                      <ProviderBadge provider={remote.provider} />
                      <StatusIndicator status={remote.status} error={remote.lastError} />
                    </div>
                    <div className="mt-1 truncate text-[11px] text-white/40" title={remote.url}>{remote.url}</div>
                    <div className="mt-1 text-[10px] text-white/30">
                      Last fetched: {formatTime(remote.lastFetched)}
                      {remote.defaultBranch ? ` · branch: ${remote.defaultBranch}` : ""}
                    </div>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <button
                    disabled={busyAction !== null}
                    onClick={() => onAction("test", remote)}
                    className={`${btn} inline-flex items-center gap-1 bg-white/10 hover:bg-white/20`}
                  >
                    {busyAction === `test-${remote.name}` ? <Loader2 size={10} className="animate-spin" /> : <Wifi size={10} />}
                    Test
                  </button>
                  <button
                    disabled={busyAction !== null}
                    onClick={() => onAction("fetch", remote)}
                    className={`${btn} inline-flex items-center gap-1 bg-white/10 hover:bg-white/20`}
                  >
                    {busyAction === `fetch-${remote.name}` ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                    Fetch
                  </button>
                  <button
                    disabled={busyAction !== null}
                    onClick={() => onAction("push", remote)}
                    className={`${btn} inline-flex items-center gap-1 bg-sky-500/20 hover:bg-sky-500/30`}
                  >
                    {busyAction === `push-${remote.name}` ? <Loader2 size={10} className="animate-spin" /> : <Send size={10} />}
                    Push
                  </button>
                  <button
                    disabled={busyAction !== null}
                    onClick={() => onEdit(remote)}
                    className={`${btn} inline-flex items-center gap-1 bg-white/10 hover:bg-white/20`}
                  >
                    <Settings size={10} />
                    Edit
                  </button>
                  <button
                    disabled={busyAction !== null}
                    onClick={() => onAction("remove", remote)}
                    className={`${btn} inline-flex items-center gap-1 bg-red-500/15 text-red-300/80 hover:bg-red-500/25`}
                  >
                    <Trash2 size={10} />
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main tab ────────────────────────────────────────────────────────────────────
export function GitRemotesTab() {
  const [filesystems, setFilesystems] = useState<GitFsInstance[]>([]);
  const [remotesByFs, setRemotesByFs] = useState<Record<string, GitRemote[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [addFor, setAddFor] = useState<GitFsInstance | null>(null);
  const [editState, setEditState] = useState<{ fs: GitFsInstance; remote: GitRemote } | null>(null);

  const loadRemotes = useCallback(async (fsId: string) => {
    const res = await fetch(`/api/git-remotes?filesystem=${encodeURIComponent(fsId)}`);
    if (!res.ok) throw new Error("Failed to load remotes");
    const data = await res.json();
    setRemotesByFs((prev) => ({ ...prev, [fsId]: data.remotes ?? [] }));
  }, []);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch("/api/git-remotes/filesystems");
      if (!res.ok) throw new Error("Failed to load filesystems");
      const data = await res.json();
      const fsList: GitFsInstance[] = data.filesystems ?? [];
      setFilesystems(fsList);
      await Promise.all(fsList.map((fs) => loadRemotes(fs.id).catch(() => {})));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [loadRemotes]);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  const api = useCallback(async (action: string, fsId: string, body: Record<string, unknown> = {}) => {
    setBusyAction(`${action}-${body.name ?? ""}`);
    setMsg(null);
    try {
      const res = await fetch("/api/git-remotes", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionHeader() },
        body: JSON.stringify({ action, filesystem: fsId, ...body }),
      });
      const data = await res.json();
      if (data.error) {
        setMsg(`Error: ${data.error.message ?? data.error}`);
        throw new Error(data.error.message ?? data.error);
      }
      setMsg(data.message ?? "Done.");
      await loadRemotes(fsId);
    } finally {
      setBusyAction(null);
    }
  }, [loadRemotes]);

  const onRemoteAction = useCallback(async (fsId: string, action: string, remote: GitRemote) => {
    if (action === "remove") {
      if (!confirm(`Delete remote '${remote.name}'? This also removes stored credentials.`)) return;
    }
    await api(action, fsId, { name: remote.name }).catch(() => {});
  }, [api]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-white/40">
        <Loader2 size={14} className="animate-spin" />
        Loading GitFS instances…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-white/50">GitFS Remotes</h4>
        <p className="mt-1 text-[11px] text-white/40">
          Configure external repositories for each GitFS filesystem. Remotes are used for push/fetch operations.
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded border border-red-400/30 bg-red-500/10 p-2.5 text-[11px] text-red-200">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {filesystems.length === 0 ? (
        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-6 text-center">
          <GitBranch size={24} className="mx-auto mb-2 text-white/20" />
          <p className="text-[12px] text-white/40">No GitFS instances found.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filesystems.map((fs) => (
            <FilesystemCard
              key={fs.id}
              fs={fs}
              remotes={remotesByFs[fs.id]}
              busyAction={busyAction}
              onAdd={() => setAddFor(fs)}
              onEdit={(remote) => setEditState({ fs, remote })}
              onAction={(action, remote) => void onRemoteAction(fs.id, action, remote)}
            />
          ))}
        </div>
      )}

      {msg && <div className="text-[11px] text-white/50">{msg}</div>}

      <AddRemoteModal
        open={addFor !== null}
        filesystem={addFor}
        onClose={() => setAddFor(null)}
        onAdd={async (data) => {
          if (!addFor) return;
          await api("add", addFor.id, data);
        }}
      />
      <EditRemoteModal
        open={editState !== null}
        remote={editState?.remote ?? null}
        filesystem={editState?.fs ?? null}
        onClose={() => setEditState(null)}
        onSave={async (originalName, patch) => {
          if (!editState) return;
          await api("update", editState.fs.id, { name: originalName, patch });
        }}
      />
    </div>
  );
}
