"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { MarketplaceRow } from "./wizard-types";

interface Props {
  marketplaces: MarketplaceRow[];
  onChange: (rows: MarketplaceRow[]) => void;
}

export function Step5Marketplace({ marketplaces, onChange }: Props) {
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");

  const toggle = (i: number) =>
    onChange(marketplaces.map((r, idx) => idx === i ? { ...r, checked: !r.checked } : r));

  const remove = (i: number) =>
    onChange(marketplaces.filter((_, idx) => idx !== i));

  const add = () => {
    if (!newUrl.trim()) return;
    onChange([...marketplaces, { name: newName.trim() || newUrl.trim(), url: newUrl.trim(), checked: true }]);
    setNewName("");
    setNewUrl("");
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-white/50">
        Marketplaces are git repositories containing installable apps, skills, and other artifacts.
        Checked entries will be cloned during setup. You can add more later in the Marketplace app.
      </p>

      <div className="space-y-2">
        {marketplaces.map((row, i) => (
          <div
            key={row.url}
            className={`flex items-center gap-3 rounded border p-3 transition-colors
              ${row.checked ? "border-white/20 bg-white/5" : "border-white/10 bg-transparent opacity-60"}`}
          >
            <input
              type="checkbox"
              checked={row.checked}
              onChange={() => toggle(i)}
              className="h-3.5 w-3.5 accent-violet-400"
            />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-white/80 truncate">{row.name}</div>
              <div className="text-[10px] text-white/40 truncate">{row.url}</div>
            </div>
            <button
              onClick={() => remove(i)}
              className="shrink-0 rounded p-1 text-white/30 hover:bg-white/10 hover:text-white/60"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>

      {/* Add custom row */}
      <div className="rounded border border-dashed border-white/10 p-3 space-y-2">
        <p className="text-[10px] text-white/40">Add a custom marketplace</p>
        <div className="flex gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name (optional)"
            className="w-36 rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none placeholder:text-white/20"
          />
          <input
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            placeholder="https://github.com/…"
            onKeyDown={(e) => e.key === "Enter" && add()}
            className="flex-1 rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none placeholder:text-white/20"
          />
          <button
            onClick={add}
            disabled={!newUrl.trim()}
            className="flex items-center gap-1 rounded bg-white/10 px-3 py-1.5 text-xs hover:bg-white/15 disabled:opacity-30"
          >
            <Plus size={12} /> Add
          </button>
        </div>
      </div>
    </div>
  );
}
