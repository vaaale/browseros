"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Plus } from "lucide-react";

interface ProfileMeta {
  id: string;
  name: string;
  description: string;
}

export function AssistantTab() {
  const [profiles, setProfiles] = useState<ProfileMeta[]>([]);
  const [active, setActive] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/assistant/profile").then((r) => r.json());
    setProfiles(res.profiles ?? []);
    setActive(res.active ?? "");
    setBody(res.composed ?? "");
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const switchTo = async (id: string) => {
    await fetch("/api/assistant/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: id }),
    });
    setStatus(`Switched to ${id}.`);
    load();
  };

  const saveBody = async () => {
    await fetch("/api/assistant/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    setStatus("Saved profile instructions.");
  };

  const createProfile = async () => {
    if (!newName.trim()) return;
    await fetch("/api/assistant/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), body: "You are a helpful BrowserOS assistant." }),
    });
    setNewName("");
    load();
  };

  return (
    <div className="space-y-4 text-sm">
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">Profiles</h4>
        <div className="space-y-1">
          {profiles.map((p) => (
            <button
              key={p.id}
              onClick={() => switchTo(p.id)}
              className={`flex w-full items-center gap-2 rounded border px-2.5 py-1.5 text-left text-xs ${
                active === p.id ? "border-white/30 bg-white/10" : "border-white/10 hover:bg-white/5"
              }`}
            >
              {active === p.id ? <Check size={13} className="text-emerald-300" /> : <span className="w-[13px]" />}
              <span className="font-medium">{p.name}</span>
              <span className="truncate text-white/40">{p.description}</span>
            </button>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New profile name"
            className="flex-1 rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30"
          />
          <button onClick={createProfile} className="flex items-center gap-1 rounded bg-white/10 px-2 py-1.5 text-xs hover:bg-white/20">
            <Plus size={13} /> New
          </button>
        </div>
      </div>

      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">Active profile instructions</h4>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={12}
          spellCheck={false}
          className="w-full resize-none rounded border border-white/10 bg-black/30 p-2 font-mono text-[11px] leading-relaxed outline-none focus:border-white/30"
        />
        <div className="mt-2 flex items-center gap-2">
          <button onClick={saveBody} className="rounded bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20">Save</button>
          {status && <span className="text-xs text-white/60">{status}</span>}
        </div>
      </div>
    </div>
  );
}
