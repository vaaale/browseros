"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { Skill } from "@/lib/agent/skills/store";

export function SkillsTab() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [draft, setDraft] = useState({ name: "", description: "", whenToUse: "", content: "" });
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/skills").then((r) => r.json());
    setSkills(res.skills ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    if (!draft.name.trim() || !draft.content.trim()) return;
    const res = await fetch("/api/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    }).then((r) => r.json());
    setStatus(res.error ? `Error: ${res.error}` : `Saved "${res.skill?.name}".`);
    if (!res.error) {
      setDraft({ name: "", description: "", whenToUse: "", content: "" });
      load();
    }
  };

  const remove = async (id: string) => {
    await fetch(`/api/skills?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    load();
  };

  return (
    <div className="space-y-4 text-sm">
      <div className="space-y-1">
        {skills.map((s) => (
          <div key={s.id} className="group rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
            <div className="flex items-start gap-2">
              <div className="flex-1">
                <div className="font-medium text-white/85">{s.name}{typeof s.score === "number" && <span className="ml-2 text-[10px] text-emerald-300/80">score {s.score.toFixed(1)}</span>}</div>
                <div className="text-xs text-white/50">{s.description}</div>
              </div>
              <button onClick={() => remove(s.id)} className="rounded p-1 text-white/40 opacity-0 hover:bg-white/10 hover:text-white group-hover:opacity-100">
                <Trash2 size={13} />
              </button>
            </div>
            {s.whenToUse && <div className="mt-1 text-[11px] text-white/40">When: {s.whenToUse}</div>}
            <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap text-[11px] text-white/55">{s.content}</pre>
          </div>
        ))}
        {skills.length === 0 && <p className="text-xs text-white/40">No skills yet. The assistant creates these as it learns, or add one below.</p>}
      </div>

      <div className="space-y-2 rounded-lg border border-white/10 p-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-white/50">New skill</h4>
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Name"
          className="w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30" />
        <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="One-line description"
          className="w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30" />
        <input value={draft.whenToUse} onChange={(e) => setDraft({ ...draft, whenToUse: e.target.value })} placeholder="When to use (optional)"
          className="w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30" />
        <textarea value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} placeholder="Step-by-step instructions" rows={4}
          className="w-full resize-none rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30" />
        <div className="flex items-center gap-2">
          <button onClick={create} className="flex items-center gap-1 rounded bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20"><Plus size={13} /> Add skill</button>
          {status && <span className="text-xs text-white/60">{status}</span>}
        </div>
      </div>
    </div>
  );
}
