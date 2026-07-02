"use client";

import { useCallback, useEffect, useState } from "react";
import { AgentList, NewAgentDialog, type AgentMeta } from "./assistant";

/**
 * Master-detail shell for Settings → Assistant. The list on the left drives
 * selection; the right pane will show the selected agent's details in a later
 * phase. Fetches the agent inventory from /api/assistant/agent, which also
 * returns the currently-active agent id (used to render the "Active" pill).
 */
export function AssistantTab() {
  const [agents, setAgents] = useState<AgentMeta[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string>("");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/assistant/agent").then((r) => r.json());
      const list: AgentMeta[] = res.agents ?? [];
      const active: string = res.active ?? "";
      setAgents(list);
      setActiveAgentId(active);
      // Default selection to the active agent, but preserve an explicit choice.
      setSelectedAgentId((prev) => prev ?? (active || list[0]?.id) ?? null);
    } catch {
      /* leave state as-is on transient fetch errors */
    }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? null;

  return (
    <div className="flex h-full">
      <AgentList
        agents={agents}
        activeAgentId={activeAgentId}
        selectedAgentId={selectedAgentId}
        onSelect={setSelectedAgentId}
        onNew={() => setDialogOpen(true)}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {selectedAgent ? (
          <div className="p-4 text-xs text-white/50">
            Details for &ldquo;{selectedAgent.name}&rdquo; will appear here.
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-xs text-white/40">
            Select an agent to view its details.
          </div>
        )}
      </div>
      <NewAgentDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={(id) => {
          setSelectedAgentId(id);
          void load();
        }}
      />
    </div>
  );
}
