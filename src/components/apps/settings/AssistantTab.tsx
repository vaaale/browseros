"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AgentDetails,
  AgentList,
  NewAgentDialog,
  type AgentMeta,
  type Catalog,
} from "./assistant";

const EMPTY_CATALOG: Catalog = { tools: [], skills: [], mcp: [] };

/**
 * Master-detail shell for Settings → Assistant. The list on the left drives
 * selection; the right pane shows the selected agent's details (name,
 * description, system prompt, capabilities). Fetches the agent inventory —
 * and the catalog of every skill/MCP/tool the picker can offer — from
 * /api/assistant/agent, which also returns the currently-active agent id
 * (used to render the "Active" pill).
 */
export function AssistantTab() {
  const [agents, setAgents] = useState<AgentMeta[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string>("");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Catalog>(EMPTY_CATALOG);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/assistant/agent").then((r) => r.json());
      const list: AgentMeta[] = res.agents ?? [];
      const active: string = res.active ?? "";
      setAgents(list);
      setActiveAgentId(active);
      setCatalog((res.catalog as Catalog | undefined) ?? EMPTY_CATALOG);
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
      <div className="flex min-h-0 flex-1 flex-col">
        {selectedAgent ? (
          // Re-key on the agent id so switching agents resets input drafts
          // without a bespoke effect inside the details components.
          <AgentDetails
            key={selectedAgent.id}
            agent={selectedAgent}
            catalog={catalog}
            onSaved={load}
            onDeleted={() => {
              // Clearing the selection lets `load` re-seed it from the active
              // (protected) agent, matching the pre-selection behavior.
              setSelectedAgentId(null);
              void load();
            }}
          />
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
