"use client";

import { useCallback, useEffect, useState } from "react";
import { UserCircle } from "lucide-react";
import {
  DEFAULT_GROUP,
  setConversationAgent,
  useActiveConversation,
} from "@/lib/agent/conversations";

interface AgentMeta {
  id: string;
  name: string;
}

// The selector reflects (and edits) the ACTIVE conversation's agent. Picking a
// new agent reassigns the conversation in-place (which moves it under that
// agent's section in the conversation panel) and also updates the global
// "active agent" so future new conversations default to the same pick.
export function AgentSelector({ group = DEFAULT_GROUP }: { group?: string }) {
  const [agents, setAgents] = useState<AgentMeta[]>([]);
  const [globalActive, setGlobalActive] = useState("");
  const conv = useActiveConversation(group);

  const load = useCallback(async () => {
    const res = await fetch("/api/assistant/agent").then((r) => r.json());
    setAgents(res.agents ?? []);
    setGlobalActive(res.active ?? "");
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // What the dropdown should show: the active conversation's agent if set,
  // otherwise the global default (back-compat with conversations that predate
  // per-conversation agents).
  const shown = conv?.agentId ?? globalActive;

  const onChange = async (id: string) => {
    setGlobalActive(id);
    // Reassign the active conversation first so the UI (conversation groups +
    // chat instructions) reflects the change immediately.
    if (conv) await setConversationAgent(conv.id, id);
    await fetch("/api/assistant/agent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: id }),
    });
  };

  return (
    <label className="flex items-center gap-1.5 text-xs text-white/60" title="Agent assigned to this conversation">
      <UserCircle size={14} className="text-white/50" />
      <select
        value={shown}
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
