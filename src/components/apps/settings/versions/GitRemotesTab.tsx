"use client";

import { useCallback, useEffect, useState } from "react";
import {
  GitBranch,
  Globe,
  Loader2,
  Lock,
  Plus,
  Download,
  Send,
  Settings,
  Trash2,
  Wifi,
  WifiOff,
  AlertCircle,
  X,
} from "lucide-react";

const BOS_DEFAULT_REMOTE = "bos-default";
import { sessionHeader } from "@/lib/logging/client/session";
import { ConflictSessionBadge } from "@/components/gitops/ConflictSessionBadge";

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
    defaultBranch?: string;
    autoPush: boolean;
  }) => Promise<void>;
}

function AddRemoteModal({ open, filesystem, onClose, onAdd }: AddRemoteModalProps) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [provider, setProvider] = useState<Provider>("generic");
  const [branch, setBranch] = useState("");
  const [autoPush, setAutoPush] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the form when the modal closes. Adjusting state during render
  // (instead of in a useEffect) avoids an extra render pass — see
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) {
      setName("");
      setUrl("");
      setProvider("generic");
      setBranch("");
      setAutoPush(false);
      setError(null);
    }
  }

  // Auto-detect the provider from the URL; the user can still override it via the dropdown.
  const [prevUrl, setPrevUrl] = useState(url);
  if (url !== prevUrl) {
    setPrevUrl(url);
    if (/github\.com/i.test(url)) setProvider("github");
    else if (/gitlab\.com/i.test(url)) setProvider("gitlab");
  }

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
        // Credentials are configured once in Settings → Integrations. Remotes
        // only record their identity; GitHub/GitLab authenticate via the OAuth
        // connection there, generic remotes resolve token auth from stored
        // secrets. The auth type is derived from the provider, not collected here.
        authType: provider === "generic" ? "token" : "oauth",
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
          <div>
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
          <div>
            <label className="mb-1 block text-[11px] text-white/50">Branch (for push/pull)</label>
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
              className="w-full rounded border border-white/10 bg-black/30 px-2.5 py-1.5 text-xs outline-none focus:border-white/30"
            />
          </div>
          {(provider === "github" || provider === "gitlab") && (
            <p className="rounded border border-white/10 bg-black/20 px-2.5 py-2 text-[10px] text-white/40">
              Authenticate {provider === "github" ? "GitHub" : "GitLab"} in{" "}
              <span className="text-white/60">Settings → Integrations → Git Providers</span>. Credentials are
              configured once there and shared by all remotes.
            </p>
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
  onSave: (originalName: string, patch: { name: string; provider: Provider; url: string; defaultBranch?: string; autoPush: boolean }) => Promise<void>;
}

function EditRemoteModal({ open, remote, filesystem, onClose, onSave }: EditRemoteModalProps) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [provider, setProvider] = useState<Provider>("generic");
  const [branch, setBranch] = useState("");
  const [autoPush, setAutoPush] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Populate the form when a new remote is selected for editing. Adjusting
  // state during render (instead of in a useEffect) avoids an extra render
  // pass — see https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [prevRemote, setPrevRemote] = useState(remote);
  if (remote !== prevRemote) {
    setPrevRemote(remote);
    if (remote) {
      setName(remote.name);
      setUrl(remote.url);
      setProvider(remote.provider);
      setBranch(remote.defaultBranch ?? "");
      setAutoPush(remote.autoPush);
      setError(null);
    }
  }

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
        autoPush,
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
  msg: string | null;
  onAdd: () => void;
  onEdit: (remote: GitRemote) => void;
  onAction: (action: string, remote: GitRemote) => void;
  onPull: (remote: GitRemote) => void;
  onPush: (remote: GitRemote) => void;
}

function FilesystemCard({ fs, remotes, busyAction, msg, onAdd, onEdit, onAction, onPull, onPush }: FilesystemCardProps) {
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
                      {remote.name === BOS_DEFAULT_REMOTE && (
                        <span className="inline-flex items-center gap-0.5 rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/40" title="Factory-reset anchor — cannot be edited or deleted">
                          <Lock size={9} />
                          default
                        </span>
                      )}
                      <ProviderBadge provider={remote.provider} />
                      <StatusIndicator status={remote.status} error={remote.lastError} />
                    </div>
                    <div className="mt-1 truncate text-[11px] text-white/40" title={remote.url}>{remote.url}</div>
                    <div className="mt-1 text-[10px] text-white/30">
                      Last pulled: {formatTime(remote.lastFetched)}
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
                    {busyAction === `test-${fs.id}-${remote.name}` ? <Loader2 size={10} className="animate-spin" /> : <Wifi size={10} />}
                    Test
                  </button>
                  <button
                    disabled={busyAction !== null}
                    onClick={() => onPull(remote)}
                    className={`${btn} inline-flex items-center gap-1 bg-white/10 hover:bg-white/20`}
                  >
                    {busyAction === `fetch-${fs.id}-${remote.name}` ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />}
                    Pull
                  </button>
                  <button
                    disabled={busyAction !== null}
                    onClick={() => onPush(remote)}
                    className={`${btn} inline-flex items-center gap-1 bg-sky-500/20 hover:bg-sky-500/30`}
                  >
                    {busyAction === `push-${fs.id}-${remote.name}` ? <Loader2 size={10} className="animate-spin" /> : <Send size={10} />}
                    Push
                  </button>
                  {remote.name !== BOS_DEFAULT_REMOTE && (
                    <>
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
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {msg && (
          msg.startsWith("Error:") ? (
            <div className="mt-3 flex items-start gap-2 rounded border border-red-400/30 bg-red-500/10 p-2.5 text-[11px] text-red-200">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              <span>{msg}</span>
            </div>
          ) : (
            <div className="mt-3 text-[11px] text-white/50">{msg}</div>
          )
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
  // Keyed by filesystem id, not flat — so a Pull/Push/Test/etc. result shows
  // inside the panel for the repo it actually ran against, instead of one
  // shared line at the bottom of the whole tab regardless of which repo was
  // operated on.
  const [msgByFs, setMsgByFs] = useState<Record<string, string | null>>({});
  const setFsMsg = useCallback((fsId: string, m: string | null) => {
    setMsgByFs((prev) => ({ ...prev, [fsId]: m }));
  }, []);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [addFor, setAddFor] = useState<GitFsInstance | null>(null);
  const [editState, setEditState] = useState<{ fs: GitFsInstance; remote: GitRemote } | null>(null);
  const [unrelatedState, setUnrelatedState] = useState<{ fs: GitFsInstance; remote: GitRemote; ahead: number; behind: number } | null>(null);
  // A true divergence (local has unique commits AND the remote gained unique
  // commits since we last fetched) can never be resolved by push or pull alone
  // — only a merge (not offered here) or an explicit, confirmed force-push.
  const [divergedState, setDivergedState] = useState<{ fs: GitFsInstance; remote: GitRemote; ahead: number; behind: number; sessionId?: string; devopsConversationId?: string; message?: string } | null>(null);

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
    // Key the busy indicator by filesystem AND remote name — remote names collide
    // across filesystems (each may have an "origin"), so a name-only key would
    // spin the matching button in every card at once.
    setBusyAction(`${action}-${fsId}-${body.name ?? ""}`);
    setFsMsg(fsId, null);
    try {
      const res = await fetch("/api/git-remotes", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionHeader() },
        body: JSON.stringify({ action, filesystem: fsId, ...body }),
      });
      const data = await res.json();
      if (data.error) {
        setFsMsg(fsId, `Error: ${data.error.message ?? data.error}`);
        throw new Error(data.error.message ?? data.error);
      }
      setFsMsg(fsId, data.message ?? "Done.");
      await loadRemotes(fsId);
    } finally {
      setBusyAction(null);
    }
  }, [loadRemotes, setFsMsg]);

  const onRemoteAction = useCallback(async (fsId: string, action: string, remote: GitRemote) => {
    if (action === "remove") {
      if (!confirm(`Delete remote '${remote.name}'? This also removes stored credentials.`)) return;
    }
    await api(action, fsId, { name: remote.name }).catch(() => {});
  }, [api]);

  // Pull is a dedicated flow (not the generic api() helper) because a
  // successful response can carry `unrelatedHistory: true` — a case that
  // needs a confirmation dialog (Adopt), not a plain success/error toast.
  const onPull = useCallback(async (fs: GitFsInstance, remote: GitRemote) => {
    setBusyAction(`fetch-${fs.id}-${remote.name}`);
    setFsMsg(fs.id, null);
    try {
      const res = await fetch("/api/git-remotes", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionHeader() },
        body: JSON.stringify({ action: "fetch", filesystem: fs.id, name: remote.name }),
      });
      const data = await res.json();
      if (data.error) {
        setFsMsg(fs.id, `Error: ${data.error.message ?? data.error}`);
        return;
      }
      if (data.unrelatedHistory) {
        setUnrelatedState({ fs, remote, ahead: data.ahead ?? 0, behind: data.behind ?? 0 });
        return;
      }
      // `merged: false` with `behind > 0` means fetch succeeded but the branches
      // truly diverged (local has commits the remote doesn't, AND vice versa) —
      // functionally identical to a failure for the user (push still can't
      // succeed), so it must be just as visible, not a bland "Done."-style line.
      if (data.merged === false && ((data.behind ?? 0) > 0 || data.escalated)) {
        // 035 (FR-019): `escalated` means the conflicted rebase went to the
        // conflict-resolution agent, so the dialog below shows the LIVE
        // session (and a button into the pane) instead of the old
        // "resolve manually on the command line, or force-push" dead end.
        setDivergedState({
          fs,
          remote,
          ahead: data.ahead ?? 0,
          behind: data.behind ?? 0,
          sessionId: data.sessionId,
          devopsConversationId: data.devopsConversationId,
          message: data.message,
        });
        return;
      }
      setFsMsg(fs.id, data.message ?? "Done.");
      await loadRemotes(fs.id);
    } finally {
      setBusyAction(null);
    }
  }, [loadRemotes, setFsMsg]);

  // Push is a dedicated flow (not the generic api() helper) for the same
  // reason Pull is: the route now auto-recovers a plain rejection (unshallow
  // + fetch + rebase, mirroring what "Pull" does), and a response can still
  // carry `unrelatedHistory` or `rebaseConflict` when that recovery can't
  // resolve things automatically — those need the existing confirmation
  // dialogs (Adopt / Force push), not a plain success/error toast.
  const onPush = useCallback(async (fs: GitFsInstance, remote: GitRemote) => {
    setBusyAction(`push-${fs.id}-${remote.name}`);
    setFsMsg(fs.id, null);
    try {
      const res = await fetch("/api/git-remotes", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionHeader() },
        body: JSON.stringify({ action: "push", filesystem: fs.id, name: remote.name }),
      });
      const data = await res.json();
      if (data.error) {
        setFsMsg(fs.id, `Error: ${data.error.message ?? data.error}`);
        return;
      }
      if (data.unrelatedHistory) {
        setUnrelatedState({ fs, remote, ahead: data.ahead ?? 0, behind: data.behind ?? 0 });
        return;
      }
      if (data.merged === false && (data.escalated || data.rebaseConflict)) {
        setDivergedState({
          fs,
          remote,
          ahead: data.ahead ?? 0,
          behind: data.behind ?? 0,
          sessionId: data.sessionId,
          devopsConversationId: data.devopsConversationId,
          message: data.message,
        });
        return;
      }
      setFsMsg(fs.id, data.message ?? "Done.");
      await loadRemotes(fs.id);
    } finally {
      setBusyAction(null);
    }
  }, [loadRemotes, setFsMsg]);

  const onForcePush = useCallback(async () => {
    if (!divergedState) return;
    const { fs, remote } = divergedState;
    await api("push", fs.id, { name: remote.name, force: true }).catch(() => {});
    setDivergedState(null);
  }, [api, divergedState]);

  const onAdopt = useCallback(async () => {
    if (!unrelatedState) return;
    const { fs, remote } = unrelatedState;
    await api("adopt", fs.id, { name: remote.name }).catch(() => {});
    setUnrelatedState(null);
  }, [api, unrelatedState]);

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
          Configure external repositories for each GitFS filesystem. Remotes are used for push/pull operations.
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
              msg={msgByFs[fs.id] ?? null}
              onAdd={() => setAddFor(fs)}
              onEdit={(remote) => setEditState({ fs, remote })}
              onAction={(action, remote) => void onRemoteAction(fs.id, action, remote)}
              onPull={(remote) => void onPull(fs, remote)}
              onPush={(remote) => void onPush(fs, remote)}
            />
          ))}
        </div>
      )}

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

      {unrelatedState && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md rounded-lg border border-amber-400/30 bg-neutral-900 p-4 shadow-xl">
            <div className="mb-3 flex items-center gap-2">
              <AlertCircle size={16} className="text-amber-400" />
              <h4 className="text-sm font-semibold">Unrelated history</h4>
            </div>
            <p className="text-[12px] text-white/70">
              <span className="font-medium">{unrelatedState.remote.name}</span> has no shared history with{" "}
              <span className="font-medium">{unrelatedState.fs.label}</span> — this usually means the remote
              already contains its own content (e.g. a pre-existing repo). A normal pull/merge isn&apos;t possible.
            </p>
            <p className="mt-2 text-[12px] text-white/70">
              <span className="font-medium">Adopt remote content</span> will replace your local content with the
              remote&apos;s. Nothing is lost — your current content is saved to a backup branch first.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setUnrelatedState(null)}
                className="rounded border border-white/15 px-3 py-1.5 text-[11px] font-medium text-white/70 hover:bg-white/10"
              >
                Cancel
              </button>
              <button
                onClick={() => void onAdopt()}
                disabled={busyAction !== null}
                className="inline-flex items-center gap-1.5 rounded bg-amber-500/80 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-amber-500 disabled:opacity-50"
              >
                {busyAction === `adopt-${unrelatedState.fs.id}-${unrelatedState.remote.name}` ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Download size={12} />
                )}
                Adopt remote content
              </button>
            </div>
          </div>
        </div>
      )}

      {divergedState && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md rounded-lg border border-red-400/30 bg-neutral-900 p-4 shadow-xl">
            <div className="mb-3 flex items-center gap-2">
              <AlertCircle size={16} className="text-red-400" />
              <h4 className="text-sm font-semibold">Branches have diverged — automatic rebase failed</h4>
            </div>
            <p className="text-[12px] text-white/70">
              Local and <span className="font-medium">{divergedState.remote.name}</span> have diverged:{" "}
              <span className="font-medium">{divergedState.ahead}</span> commit(s) only local,{" "}
              <span className="font-medium">{divergedState.behind}</span> commit(s) only on the remote. An automatic
              rebase of local commits onto the remote was attempted, but that hit conflicts.
              {divergedState.sessionId
                ? " It has been handed to the conflict-resolution agent — open the resolution to watch it, answer its questions, or roll back."
                : " It has been handed to the conflict-resolution agent."}{" "}
              Force-pushing instead makes local win outright (the remote-only commits above are discarded from the
              branch).
            </p>
            {(divergedState.sessionId || divergedState.devopsConversationId) && (
              <div className="mt-3">
                <ConflictSessionBadge
                  variant="block"
                  sessionId={divergedState.sessionId}
                  conversationId={divergedState.devopsConversationId}
                />
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setDivergedState(null)}
                className="rounded border border-white/15 px-3 py-1.5 text-[11px] font-medium text-white/70 hover:bg-white/10"
              >
                Cancel
              </button>
              <button
                onClick={() => void onForcePush()}
                disabled={busyAction !== null}
                className="inline-flex items-center gap-1.5 rounded bg-red-500/80 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-red-500 disabled:opacity-50"
              >
                {busyAction === `push-${divergedState.fs.id}-${divergedState.remote.name}` ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Send size={12} />
                )}
                Force push (overwrite remote)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
