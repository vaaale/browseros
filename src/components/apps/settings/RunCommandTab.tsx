"use client";

import { useCallback, useEffect, useState } from "react";

interface VfsMount {
  vfsPath: string;
  containerPath: string;
  mode: "rw" | "ro";
  enabled: boolean;
}

const DEFAULT_MOUNTS: VfsMount[] = [
  { vfsPath: "/workspace", containerPath: "/workspace", mode: "rw", enabled: true },
  { vfsPath: "/Documents", containerPath: "/Documents", mode: "rw", enabled: true },
];

interface VfsEntry {
  name: string;
  path: string;
  type: "file" | "dir";
}

interface Config {
  enabled: boolean;
  backend: "docker" | "local";
  dockerImage: string;
  network: boolean;
  idleTimeoutSec: number;
  maxTimeoutSec: number;
  vfsMounts: VfsMount[];
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-white/40">{title}</div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-40 shrink-0 text-xs text-white/60">{label}</span>
      {children}
    </div>
  );
}

const inputCls = "rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30 w-full";

export function RunCommandTab() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [mounts, setMounts] = useState<VfsMount[]>([]);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [configRes, fsRes] = await Promise.all([
      fetch("/api/config").then((r) => r.json()),
      fetch("/api/fs?op=list&path=/").then((r) => r.json()),
    ]);

    const schema = (configRes.schemas ?? []).find(
      (s: { namespace: string }) => s.namespace === "run-command"
    );
    const vals = schema?.values ?? {};

    const storedMounts: VfsMount[] = Array.isArray(vals.vfsMounts) && vals.vfsMounts.length > 0
      ? vals.vfsMounts as VfsMount[]
      : DEFAULT_MOUNTS;

    const loadedCfg: Config = {
      enabled: vals.enabled === true,
      backend: vals.backend === "local" ? "local" : "docker",
      dockerImage: typeof vals.dockerImage === "string" ? vals.dockerImage : "",
      network: vals.network === true,
      idleTimeoutSec: typeof vals.idleTimeoutSec === "number" ? vals.idleTimeoutSec : 120,
      maxTimeoutSec: typeof vals.maxTimeoutSec === "number" ? vals.maxTimeoutSec : 600,
      vfsMounts: storedMounts,
    };
    setCfg(loadedCfg);

    // Merge VFS dirs with stored mounts; /workspace always first.
    const dirs: string[] = ((fsRes.entries ?? []) as VfsEntry[])
      .filter((e) => e.type === "dir")
      .map((e) => e.path)
      .sort();

    // Build final mount list: stored mounts first (preserves order + enabled state),
    // then any VFS dirs not yet in stored mounts (appended as unchecked).
    const storedPaths = new Set(storedMounts.map((m) => m.vfsPath));
    const extra: VfsMount[] = dirs
      .filter((p) => !storedPaths.has(p))
      .map((p) => ({
        vfsPath: p,
        containerPath: p,
        mode: "rw" as const,
        enabled: false,
      }));

    // Sort: /workspace first, then rest alphabetically.
    const all = [...storedMounts, ...extra].sort((a, b) => {
      if (a.vfsPath === "/workspace") return -1;
      if (b.vfsPath === "/workspace") return 1;
      return a.vfsPath.localeCompare(b.vfsPath);
    });

    setMounts(all);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setMount = (vfsPath: string, patch: Partial<VfsMount>) => {
    setMounts((prev) =>
      prev.map((m) => (m.vfsPath === vfsPath ? { ...m, ...patch } : m))
    );
  };

  const save = async () => {
    if (!cfg) return;
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          namespace: "run-command",
          values: { ...cfg, vfsMounts: mounts },
        }),
      }).then((r) => r.json());
      setStatus(res.error ? `Error: ${res.error}` : "Saved.");
    } finally {
      setSaving(false);
    }
  };

  if (!cfg) return <p className="text-xs text-white/40">Loading…</p>;

  return (
    <div className="space-y-6 text-xs">
      {/* Enabled */}
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={cfg.enabled}
          onChange={(e) => setCfg((c) => c && { ...c, enabled: e.target.checked })}
        />
        <span className="font-medium text-white/80">Enable command execution (run_command)</span>
      </label>

      {/* Backend */}
      <Section title="Backend">
        <div className="space-y-1.5">
          {(
            [
              { value: "docker", label: "Docker — isolated container", desc: "Recommended. Each browser session gets its own sandboxed container (non-root, network off by default)." },
              { value: "local", label: "Local — host / Bastion", desc: "Runs directly on the host. Only use when BOS itself runs inside a container (Bastion mode). Symlinks are created at the configured paths." },
            ] as const
          ).map((opt) => (
            <label
              key={opt.value}
              className={`flex cursor-pointer items-start gap-2 rounded border p-2 ${
                cfg.backend === opt.value ? "border-white/30 bg-white/10" : "border-white/10"
              }`}
            >
              <input
                type="radio"
                name="rc-backend"
                checked={cfg.backend === opt.value}
                onChange={() => setCfg((c) => c && { ...c, backend: opt.value })}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium text-white/80">{opt.label}</span>
                <span className="block text-white/45">{opt.desc}</span>
              </span>
            </label>
          ))}
        </div>
      </Section>

      {/* Mounted directories */}
      <Section title="Mounted Directories">
        <p className="text-white/45">
          {cfg.backend === "docker"
            ? "Checked directories are bind-mounted into the sandbox container. Changes take effect when the container next starts."
            : "Checked directories get symlinks at their container paths pointing to your VFS. Synced before each command via sudo bos-vfs-link."}
        </p>
        <div className="mt-1 space-y-1">
          {mounts.map((m) => (
            <div
              key={m.vfsPath}
              className={`flex items-center gap-2 rounded border px-2 py-1.5 ${
                m.enabled ? "border-white/20 bg-white/5" : "border-white/10"
              }`}
            >
              <input
                type="checkbox"
                checked={m.enabled}
                onChange={(e) => setMount(m.vfsPath, { enabled: e.target.checked })}
              />
              <span className="min-w-0 flex-1 font-mono text-white/80">
                {m.vfsPath}
                <span className="mx-1.5 text-white/30">→</span>
                {m.containerPath}
              </span>
              <select
                value={m.mode}
                onChange={(e) => setMount(m.vfsPath, { mode: e.target.value as "rw" | "ro" })}
                className="rounded border border-white/10 bg-black/30 px-1.5 py-0.5 text-xs text-white/60 outline-none focus:border-white/30"
              >
                <option value="rw">rw</option>
                <option value="ro">ro</option>
              </select>
            </div>
          ))}
          {mounts.length === 0 && (
            <p className="text-white/40">No directories found in your virtual file system.</p>
          )}
        </div>
      </Section>

      {/* Docker-only settings */}
      {cfg.backend === "docker" && (
        <Section title="Docker Settings">
          <Row label="Docker image">
            <input
              type="text"
              value={cfg.dockerImage}
              onChange={(e) => setCfg((c) => c && { ...c, dockerImage: e.target.value })}
              placeholder="browseros/run-command:latest"
              className={inputCls}
            />
          </Row>
          <Row label="Network access">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={cfg.network}
                onChange={(e) => setCfg((c) => c && { ...c, network: e.target.checked })}
              />
              <span className="text-white/60">Allow container internet access</span>
            </label>
          </Row>
        </Section>
      )}

      {/* Local-only info */}
      {cfg.backend === "local" && (
        <div className="rounded border border-white/10 bg-white/[0.03] p-3 text-white/50">
          <span className="font-medium text-white/70">ℹ Local backend</span>
          <p className="mt-1">
            Commands run directly on the host. Before each command, symlinks are created at the
            container paths above (e.g. <code className="text-white/70">/Documents</code>) pointing
            to your VFS directories. This requires{" "}
            <code className="text-white/70">sudo /usr/local/bin/bos-vfs-link</code> to be available
            (configured in the BOS container image). Symlink failures are non-fatal.
          </p>
        </div>
      )}

      {/* Timeouts */}
      <Section title="Timeouts">
        <Row label="Idle timeout (sec)">
          <input
            type="number"
            value={cfg.idleTimeoutSec}
            onChange={(e) => setCfg((c) => c && { ...c, idleTimeoutSec: Number(e.target.value) })}
            className={inputCls}
          />
        </Row>
        <Row label="Max timeout (sec)">
          <input
            type="number"
            value={cfg.maxTimeoutSec}
            onChange={(e) => setCfg((c) => c && { ...c, maxTimeoutSec: Number(e.target.value) })}
            className={inputCls}
          />
        </Row>
      </Section>

      {/* Save */}
      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="rounded bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20 disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {status && <span className="text-white/60">{status}</span>}
      </div>
    </div>
  );
}
