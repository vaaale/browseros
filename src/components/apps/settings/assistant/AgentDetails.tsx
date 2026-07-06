"use client";

import { useCallback, useEffect, useState } from "react";
import { AutoSaveStatus } from "../AutoSaveStatus";
import { useAutoSave, type AutoSaveStatus as AutoSaveStatusValue } from "../hooks/useAutoSave";
import { DangerZone } from "./DangerZone";
import { DetailsHeader } from "./DetailsHeader";
import { InstructionsSection } from "./InstructionsSection";
import { McpGrid } from "./McpGrid";
import { SkillsGrid } from "./SkillsGrid";
import { ToolAccordions } from "./ToolAccordions";
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

type Tab = "instructions" | "skills" | "tools" | "mcp";

/**
 * Right pane of the Agents tab: per-agent editor split into four sub-tabs
 * (Instructions / Skills / Tools / MCP). Every field auto-saves; a single
 * indicator top-right shows the combined save state.
 */
export function AgentDetails({ agent, catalog, onSaved, onDeleted }: AgentDetailsProps) {
  const [tab, setTab] = useState<Tab>("instructions");

  const notifyAgentUpdated = useCallback(() => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("bos:agent-updated"));
    }
  }, []);

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
      notifyAgentUpdated();
      onSaved?.();
    },
    [agent.id, onSaved, notifyAgentUpdated],
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
      notifyAgentUpdated();
    },
    [agent.id, notifyAgentUpdated],
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
      notifyAgentUpdated();
      onSaved?.();
    },
    [agent.id, onSaved, notifyAgentUpdated],
  );

  const patchUseDefault = useCallback(
    async (value: boolean) => {
      const res = await fetch("/api/assistant/agent", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: agent.id, useDefaultPrompt: value }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `Failed to toggle default prompt (${res.status})`);
      }
      notifyAgentUpdated();
      onSaved?.();
    },
    [agent.id, onSaved, notifyAgentUpdated],
  );

  const metaSave = useAutoSave<MetaPatch>(patchMeta);
  const promptSave = useAutoSave<string>(patchPrompt);
  const capsSave = useAutoSave<CapabilitiesPatch>(patchCapabilities);
  const defaultToggleSave = useAutoSave<boolean>(patchUseDefault);

  const combinedStatus = mergeStatus(
    metaSave.status,
    promptSave.status,
    capsSave.status,
    defaultToggleSave.status,
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-white/10 px-2">
        <TabButton active={tab === "instructions"} onClick={() => setTab("instructions")}>Instructions</TabButton>
        <TabButton active={tab === "skills"} onClick={() => setTab("skills")}>Skills</TabButton>
        <TabButton active={tab === "tools"} onClick={() => setTab("tools")}>Tools</TabButton>
        <TabButton active={tab === "mcp"} onClick={() => setTab("mcp")}>MCP</TabButton>
        <div className="ml-auto pr-2">
          <AutoSaveStatus status={combinedStatus} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === "instructions" && (
          <>
            <DetailsHeader
              name={agent.name}
              description={agent.description}
              onSaveName={(value) => metaSave.save({ name: value })}
              onSaveDescription={(value) => metaSave.save({ description: value })}
            />
            <UseDefaultPromptToggle
              agentId={agent.id}
              value={agent.useDefaultPrompt}
              onChange={(next) => defaultToggleSave.save(next)}
            />
            <InstructionsSection
              systemPrompt={agent.systemPrompt}
              onSave={(value) => promptSave.save(value)}
            />
            {agent.id !== PROTECTED_AGENT_ID && onDeleted && (
              <DangerZone agentId={agent.id} agentName={agent.name} onDeleted={onDeleted} />
            )}
          </>
        )}
        {tab === "skills" && (
          <SkillsGrid
            all={catalog.skills}
            allowed={agent.skills}
            onChange={(skills) => capsSave.save({ skills })}
          />
        )}
        {tab === "tools" && (
          <ToolAccordions
            all={catalog.tools}
            allowed={agent.tools}
            onChange={(tools) => capsSave.save({ tools })}
          />
        )}
        {tab === "mcp" && (
          <McpGrid
            all={catalog.mcp}
            allowed={agent.mcp}
            onChange={(mcp) => capsSave.save({ mcp })}
          />
        )}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`relative px-3 py-2 text-xs font-medium transition-colors ${
        active ? "text-white" : "text-white/60 hover:text-white/90"
      }`}
    >
      {children}
      <span
        className={`absolute inset-x-2 -bottom-px h-px transition-colors ${
          active ? "bg-white" : "bg-transparent"
        }`}
      />
    </button>
  );
}

function UseDefaultPromptToggle({
  agentId,
  value,
  onChange,
}: {
  agentId: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!value) return;
    let alive = true;
    const timer = setTimeout(() => {
      fetch("/api/assistant/default-agent")
        .then((r) => r.json())
        .then((d: { agent?: { systemPrompt?: string } }) => { if (alive) setPreview(d.agent?.systemPrompt ?? ""); })
        .catch(() => { if (alive) setPreview(""); });
    }, 0);
    return () => { alive = false; clearTimeout(timer); };
  }, [value, agentId]);

  return (
    <div className="mb-5">
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          checked={value}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-violet-500"
        />
        <span>
          <span className="text-xs font-semibold text-white">Include default prompt</span>
          <span className="mt-0.5 block text-[11px] text-white/50">
            When on, the shared default prompt (Settings → Agents → Default Agent) is prepended to this agent&apos;s system prompt.
          </span>
        </span>
      </label>
      {value && (
        <div className="mt-2 rounded border border-white/10 bg-black/20 p-2">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-white/40">
            Default prompt (read-only)
          </div>
          <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-white/70">
            {preview ?? "Loading…"}
          </pre>
        </div>
      )}
    </div>
  );
}

function mergeStatus(...values: AutoSaveStatusValue[]): AutoSaveStatusValue {
  if (values.some((v) => v === "error")) return "error";
  if (values.some((v) => v === "saving")) return "saving";
  if (values.some((v) => v === "saved")) return "saved";
  return "idle";
}