"use client";

import { useCallback, useEffect, useState } from "react";
import { Brain, Trash2, Search, Plus } from "lucide-react";
import type { Memory, MemoryType } from "@/lib/agent/memory/types";
import type { AppProps } from "./types";

const TYPE_COLORS: Record<MemoryType, string> = {
  lesson: "text-amber-300 bg-amber-300/10",
  fact: "text-sky-300 bg-sky-300/10",
  preference: "text-violet-300 bg-violet-300/10",
  procedure: "text-emerald-300 bg-emerald-300/10",
};

export function MemoryApp(_props: AppProps) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [type, setType] = useState<MemoryType>("lesson");

  const load = useCallback(async (q?: string) => {
    const url = q ? `/api/memory?q=${encodeURIComponent(q)}` : "/api/memory";
    const res = await fetch(url).then((r) => r.json());
    setMemories(res.memories ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const add = async () => {
    if (!draft.trim()) return;
    await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: draft.trim(), type }),
    });
    setDraft("");
    load();
  };

  const remove = async (id: string) => {
    await fetch(`/api/memory?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    load();
  };

  return (
    <div className="flex h-full flex-col text-sm">
      <div className="flex items-center gap-2 border-b border-white/10 bg-white/5 px-3 py-2">
        <Brain size={16} className="text-violet-300" />
        <span className="font-medium">Agent Memory</span>
        <div className="ml-auto flex items-center gap-1 rounded-full border border-white/10 bg-black/30 px-2">
          <Search size={13} className="text-white/40" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load(query)}
            placeholder="Recall…"
            className="w-40 bg-transparent py-1 text-xs outline-none"
          />
        </div>
      </div>

      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <select
          value={type}
          onChange={(e) => setType(e.target.value as MemoryType)}
          className="rounded border border-white/10 bg-black/30 px-1.5 py-1 text-xs"
        >
          <option value="lesson">lesson</option>
          <option value="fact">fact</option>
          <option value="preference">preference</option>
          <option value="procedure">procedure</option>
        </select>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="Teach the agent something to remember…"
          className="flex-1 rounded border border-white/10 bg-black/30 px-2 py-1 text-xs outline-none focus:border-white/30"
        />
        <button onClick={add} className="flex items-center gap-1 rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20">
          <Plus size={13} /> Add
        </button>
      </div>

      <div className="flex-1 space-y-2 overflow-auto p-3">
        {memories.map((m) => (
          <div key={m.id} className="group rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
            <div className="flex items-start gap-2">
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${TYPE_COLORS[m.type]}`}>{m.type}</span>
              <p className="flex-1 text-white/85">{m.content}</p>
              <button onClick={() => remove(m.id)} className="rounded p-1 text-white/40 opacity-0 hover:bg-white/10 hover:text-white group-hover:opacity-100">
                <Trash2 size={13} />
              </button>
            </div>
            {m.tags.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1 pl-1">
                {m.tags.map((t) => (
                  <span key={t} className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-white/40">#{t}</span>
                ))}
              </div>
            )}
          </div>
        ))}
        {memories.length === 0 && (
          <div className="py-10 text-center text-xs text-white/40">
            No memories yet. The agent records lessons as it works, or add one above.
          </div>
        )}
      </div>
    </div>
  );
}
