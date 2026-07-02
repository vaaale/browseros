"use client";

import { useCallback } from "react";
import { AutoSaveStatus } from "../AutoSaveStatus";
import { useAutoSave, type AutoSaveStatus as AutoSaveStatusValue } from "../hooks/useAutoSave";
import { DetailsHeader } from "./DetailsHeader";
import { InstructionsSection } from "./InstructionsSection";
import type { AgentMeta } from "./types";

export interface AgentDetailsProps {
  agent: AgentMeta;
  /** Called after a successful meta save so the parent can refresh the list. */
  onSaved?: () => void;
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
export function AgentDetails({ agent, onSaved }: AgentDetailsProps) {
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

  const metaSave = useAutoSave<MetaPatch>(patchMeta);
  const promptSave = useAutoSave<string>(patchPrompt);

  // Error dominates so the user notices failures; otherwise show the most
  // active state (saving > saved) across the two hooks.
  const combinedStatus = mergeStatus(metaSave.status, promptSave.status);

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
      </div>
    </div>
  );
}

function mergeStatus(a: AutoSaveStatusValue, b: AutoSaveStatusValue): AutoSaveStatusValue {
  if (a === "error" || b === "error") return "error";
  if (a === "saving" || b === "saving") return "saving";
  if (a === "saved" || b === "saved") return "saved";
  return "idle";
}
