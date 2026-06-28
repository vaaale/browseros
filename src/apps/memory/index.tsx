"use client";

import { useCallback, useEffect, useState } from "react";
import { Brain, Trash2, Plus, UserCircle } from "lucide-react";
import type { AppProps } from "@/components/apps/types";

type Target = "user" | "memory";

export default function MemoryApp(_props: AppProps) {
  const [user, setUser] = useState<string[]>([]);
  const [memory, setMemory] = useState<string[]>([]);

  const load = useCallback(async () => {
    const res = await fetch("/api/memory").then((r) => r.json());
    setUser(res.user ?? []);
    setMemory(res.memory ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const add = async (target: Target, content: string) => {
    if (!content.trim()) return;
    await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target, action: "add", content: content.trim() }),
    });
    load();
  };

  const remove = async (target: Target, text: string) => {
    await fetch(`/api/memory?target=${target}&text=${encodeURIComponent(text)}`, { method: "DELETE" });
    load();
  };

  return (
    <div className="flex h-full flex-col text-sm">
      <div className="flex items-center gap-2 border-b border-white/10 bg-white/5 px-3 py-2">
        <Brain size={16} className="text-violet-300" />
        <span className="font-medium">Memory</span>
        <span className="ml-auto text-[11px] text-white/40">Persistent across sessions · injected into the assistant</span>
      </div>

      <div className="flex-1 overflow-auto p-3">
        <Section
          title="User profile"
          hint="Who the user is — identity, role, durable preferences, style."
          icon={<UserCircle size={14} className="text-sky-300" />}
          entries={user}
          onAdd={(c) => add("user", c)}
          onRemove={(t) => remove("user", t)}
        />
        <div className="h-4" />
        <Section
          title="Agent memory"
          hint="The assistant's notes — environment facts, conventions, lessons."
          icon={<Brain size={14} className="text-violet-300" />}
          entries={memory}
          onAdd={(c) => add("memory", c)}
          onRemove={(t) => remove("memory", t)}
        />
      </div>
    </div>
  );
}

function Section({
  title,
  hint,
  icon,
  entries,
  onAdd,
  onRemove,
}: {
  title: string;
  hint: string;
  icon: React.ReactNode;
  entries: string[];
  onAdd: (content: string) => void;
  onRemove: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const submit = () => {
    onAdd(draft);
    setDraft("");
  };
  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <div className="mb-1 flex items-center gap-2">
        {icon}
        <h3 className="text-xs font-semibold uppercase tracking-wide text-white/60">{title}</h3>
        <span className="text-[11px] text-white/35">({entries.length})</span>
      </div>
      <p className="mb-2 text-[11px] text-white/40">{hint}</p>

      <div className="mb-2 flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Add an entry…"
          className="flex-1 rounded border border-white/10 bg-black/30 px-2 py-1 text-xs outline-none focus:border-white/30"
        />
        <button onClick={submit} className="flex items-center gap-1 rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20">
          <Plus size={13} /> Add
        </button>
      </div>

      <div className="space-y-1">
        {entries.map((e, i) => (
          <div key={i} className="group flex items-start gap-2 rounded border border-white/10 bg-white/[0.03] px-2.5 py-1.5">
            <p className="flex-1 whitespace-pre-wrap text-white/85">{e}</p>
            <button
              onClick={() => onRemove(e.slice(0, 60))}
              className="rounded p-1 text-white/40 opacity-0 hover:bg-white/10 hover:text-white group-hover:opacity-100"
              title="Remove"
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        {entries.length === 0 && <p className="text-[11px] text-white/35">Nothing yet.</p>}
      </div>
    </section>
  );
}
