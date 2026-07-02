"use client";

import { useCallback } from "react";
import { AutoSaveStatus } from "../AutoSaveStatus";
import { useAutoSave, type AutoSaveStatus as AutoSaveStatusValue } from "../hooks/useAutoSave";
import { CapabilitiesSection } from "./CapabilitiesSection";
import { DangerZone } from "./DangerZone";
import { DetailsHeader } from "./DetailsHeader";
import { InstructionsSection } from "./InstructionsSection";
import { PROTECTED_AGENT_ID, type AgentMeta, type CapabilitiesPatch, type Catalog } from "./types";

export interface AgentDetailsProps {
  agent: AgentMeta;
  /** Catalog of every skill, MCP server, and capability the picker can offer. */
  catalog: Catalog;
  /** Called after a successful meta save so the parent can refresh the list. */
  onSaved?: () => void;
  /** Called after a successful DELETE so the parent can reset selection. */
  onDeleted?: () => void;
}

interface MetaPatch {
  name?: string;
  description?: string;
}

/**
 * Right pane of the Assistant tab: name/description + system prompt for the
 * selected agent, each field auto-saving on blur. The parent re-keys this
 * component on `agent.id` so switching agents resets input state without a
 * bespoke effect.
 */
export function AgentDetails({ agent, catalog, onSaved, onDeleted }: AgentDetailsProps) {
  const patchMeta = useCallback(
    async (patch: MetaPatch) => {
      const res = await fetch(`/api/subagents/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `Failed to update agent (${res.status})`);
      }
      onSaved?.();
    },
    [agent.id, onSaved],
  );

  const patchPrompt = useCallback(
    async (systemPrompt: string) => {
      const res = await fetch("/api/assistant/agent", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: agent.id, body: systemPrompt }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `Failed to update instructions (${res.status})`);
      }
    },
    [agent.id],
  );

  const patchCapabilities = useCallback(
    async (patch: CapabilitiesPatch) => {
      const res = await fetch("/api/assistant/agent", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: agent.id, ...patch }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `Failed to update capabilities (${res.status})`);
      }
      onSaved?.();
    },
    [agent.id, onSaved],
  );

  const metaSave = useAutoSave<MetaPatch>(patchMeta);
  const promptSave = useAutoSave<string>(patchPrompt);
  const capsSave = useAutoSave<CapabilitiesPatch>(patchCapabilities);

  // Error dominates so the user notices failures; otherwise show the most
  // active state (saving > saved) across the hooks.
  const combinedStatus = mergeStatus(metaSave.status, promptSave.status, capsSave.status);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-end border-b border-white/10 px-4 py-2">
        <AutoSaveStatus status={combinedStatus} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <DetailsHeader
          name={agent.name}
          description={agent.description}
          onSaveName={(value) => metaSave.save({ name: value })}
          onSaveDescription={(value) => metaSave.save({ description: value })}
        />
        <InstructionsSection
          systemPrompt={agent.systemPrompt}
          onSave={(value) => promptSave.save(value)}
        />
        <CapabilitiesSection
          agent={agent}
          catalog={catalog}
          onSaveCapabilities={(patch) => capsSave.save(patch)}
        />
        {agent.id !== PROTECTED_AGENT_ID && onDeleted && (
          <DangerZone
            agentId={agent.id}
            agentName={agent.name}
            onDeleted={onDeleted}
          />
        )}
      </div>
    </div>
  );
}

function mergeStatus(...values: AutoSaveStatusValue[]): AutoSaveStatusValue {
  if (values.some((v) => v === "error")) return "error";
  if (values.some((v) => v === "saving")) return "saving";
  if (values.some((v) => v === "saved")) return "saved";
  return "idle";
}
