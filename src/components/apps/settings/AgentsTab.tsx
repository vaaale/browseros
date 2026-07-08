"use client";

import { useState } from "react";
import { AssistantTab } from "./AssistantTab";
import { DefaultAgentTab } from "./DefaultAgentTab";

type Tab = "agents" | "default";

// Settings → Agents shell: two top-level tabs. "Agents" hosts the master-detail
// agent list (existing AssistantTab). "Default Agent" edits the shared prompt
// (seed/default_agent/AGENT.md) that opt-in agents inherit.
export function AgentsTab() {
  const [tab, setTab] = useState<Tab>("agents");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-white/10 px-2">
        <TabButton active={tab === "agents"} onClick={() => setTab("agents")}>Agents</TabButton>
        <TabButton active={tab === "default"} onClick={() => setTab("default")}>Default Agent</TabButton>
      </div>
      <div className="min-h-0 flex-1">
        {tab === "agents" ? <AssistantTab /> : <DefaultAgentTab />}
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