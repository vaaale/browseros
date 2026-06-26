"use client";

import { useCallback, useEffect, useState } from "react";
import { UserCircle } from "lucide-react";

interface AgentMeta {
  id: string;
  name: string;
}

export function AgentSelector() {
  const [agents, setAgents] = useState<AgentMeta[]>([]);
  const [active, setActive] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/assistant/agent").then((r) => r.json());
    setAgents(res.agents ?? []);
    setActive(res.active ?? "");
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onChange = async (id: string) => {
    setActive(id);
    await fetch("/api/assistant/agent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: id }),
    });
  };

  return (
    <label className="flex items-center gap-1.5 text-xs text-white/60" title="Active assistant agent (personality)">
      <UserCircle size={14} className="text-white/50" />
      <select
        value={active}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-white/10 bg-black/30 px-1.5 py-1 text-xs text-white/85 outline-none focus:border-white/30"
      >
        {agents.map((a) => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
      </select>
    </label>
  );
}
