"use client";

import { useCallback, useEffect, useState } from "react";

interface Caps {
  dir: string;
  fsType: string | null;
  hardlink: boolean;
  reflink: boolean;
  renameAtomic: boolean;
  zfs: boolean;
  btrfs: boolean;
  methods: string[];
  recommended: string;
}

const ALL_METHODS: { id: string; label: string; desc: string }[] = [
  { id: "auto", label: "Auto", desc: "Use the best method available on this filesystem." },
  { id: "snapshot", label: "Native snapshot (ZFS / btrfs)", desc: "Instant CoW; needs the data dir to be a dedicated dataset/subvolume (not yet provisioned)." },
  { id: "reflink", label: "Reflink (copy-on-write)", desc: "Instant block clone on btrfs / XFS-reflink / ZFS-with-cloning." },
  { id: "hardlink", label: "Hardlink farm", desc: "Cheap inode-sharing clone; relies on atomic writes to keep base intact." },
  { id: "copy", label: "Full copy", desc: "Universal floor — always works; uses more time and space." },
];

export function DataFsTab() {
  const [caps, setCaps] = useState<Caps | null>(null);
  const [method, setMethod] = useState("auto");
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async (reprobe = false) => {
    const [c, cfg] = await Promise.all([
      fetch(`/api/datafs${reprobe ? "?reprobe=1" : ""}`).then((r) => r.json()),
      fetch("/api/config").then((r) => r.json()),
    ]);
    setCaps(c);
    const ns = (cfg.schemas ?? []).find((s: { namespace: string }) => s.namespace === "datafs");
    setMethod((ns?.values?.method as string) || "auto");
  }, []);

  useEffect(() => {
    // Async load (fetch then setState) — the repo's standard data-loading pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const choose = async (m: string) => {
    setMethod(m);
    setStatus(null);
    await fetch("/api/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namespace: "datafs", values: { method: m } }),
    });
    setStatus("Saved.");
  };

  if (!caps) return <p className="text-xs text-white/40">Probing filesystem…</p>;

  const available = (id: string) => id === "auto" || caps.methods.includes(id);

  return (
    <div className="space-y-4 text-xs">
      <p className="text-white/50">
        During live version control, a previewed version gets an isolated copy-on-write clone of your data so testing
        never touches your real data. Choose how that clone is made — only methods this filesystem supports are selectable.
      </p>

      <div className="rounded border border-white/10 bg-black/20 p-3">
        <div className="mb-1.5 font-semibold text-white/70">Detected filesystem</div>
        <div className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-0.5 text-white/60">
          <span>Data dir</span><span className="truncate">{caps.dir}</span>
          <span>Filesystem</span><span>{caps.fsType ?? "unknown"}</span>
          <span>Hardlinks</span><span>{caps.hardlink ? "yes" : "no"}</span>
          <span>Reflink (CoW)</span><span>{caps.reflink ? "yes" : "no"}</span>
          <span>Atomic rename</span><span>{caps.renameAtomic ? "yes" : "no"}</span>
          <span>ZFS / btrfs</span><span>{caps.zfs ? "ZFS" : caps.btrfs ? "btrfs" : "no"}</span>
        </div>
        <button onClick={() => load(true)} className="mt-2 rounded bg-white/10 px-2 py-1 hover:bg-white/20">Re-probe</button>
      </div>

      <div className="space-y-1.5">
        {ALL_METHODS.map((m) => {
          const ok = available(m.id);
          const isBest = m.id === caps.recommended;
          return (
            <label
              key={m.id}
              className={`flex items-start gap-2 rounded border p-2 ${
                method === m.id ? "border-white/30 bg-white/10" : "border-white/10"
              } ${ok ? "cursor-pointer" : "opacity-40"}`}
            >
              <input
                type="radio"
                name="datafs-method"
                disabled={!ok}
                checked={method === m.id}
                onChange={() => choose(m.id)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium text-white/80">
                  {m.label}
                  {isBest ? " · best here" : ""}
                </span>
                <span className="block text-white/45">
                  {m.desc}
                  {!ok ? ` (not available on ${caps.fsType ?? "this filesystem"})` : ""}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      {status && <span className="text-white/60">{status}</span>}
    </div>
  );
}
